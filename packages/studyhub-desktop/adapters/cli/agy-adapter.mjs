import { GENERATION_TIMEOUT_MS } from '../../../../lib/generation-limits.js';
import { usageFromTokenUsage } from '../../../../lib/token-usage.js';
import { reportUsage } from '../../../../lib/usage-scope.js';
import {
  buildAgyStreamArgs,
  buildAgyUserMessageLine,
  buildAgyWrappedPrompt,
  parseAgyModelsOutput,
  parseAgyStreamLine,
  parseAgyStreamOutput,
} from '../../domain/agy-protocol.js';
import { agyWarmSpec } from '../../domain/agy-warm-policy.js';
import { clipDetail } from '../../domain/redact.js';
import { parseCliVersion } from '../../domain/shim-parser.js';
import { createAgyWorkDir } from './agy-spare.mjs';

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;
const AUTH_FAILURE_RE = /\b(unauth|unauthorized|not logged in|login required|sign in|authenticate|credentials?|token expired)\b/i;

function reportTokens(usage, execution) {
  if (!usage) return;
  try {
    const buckets = usageFromTokenUsage(usage);
    if (buckets) {
      reportUsage(buckets, { calls: 1, task: execution?.task || 'assist' });
    }
  } catch {
    // Token reporting must never break a completion.
  }
}

/**
 * Probe `--version` for any CLI executable via the safe `processRunner`.
 */
export async function probeCliVersion(runner, executablePath, { timeoutMs = VERSION_PROBE_TIMEOUT_MS } = {}) {
  const result = await runner.run({
    command: executablePath,
    args: ['--version'],
    timeoutMs,
  });
  if (result.errorCode === 'BROKEN_SHIM') {
    return { ok: false, version: null, reasonCode: 'broken-shim', reason: result.errorMessage || '启动脚本损坏' };
  }
  if (result.timedOut) {
    return { ok: false, version: null, reasonCode: 'probe-timeout', reason: '版本检测超时' };
  }
  if (result.errorCode) {
    return { ok: false, version: null, reasonCode: 'spawn-error', reasonParams: { code: result.errorCode }, reason: `无法启动程序 (${result.errorCode})` };
  }
  if (result.code !== 0) {
    const detail = clipDetail(result.stderr || result.stdout, 120);
    return {
      ok: false,
      version: null,
      reasonCode: 'exit-error',
      reasonParams: { code: String(result.code) },
      reason: detail ? `退出码 ${result.code}：${detail}` : `退出码 ${result.code}`,
    };
  }
  const version = parseCliVersion(result.stdout || result.stderr);
  if (!version) {
    return { ok: false, version: null, reasonCode: 'version-unparsed', reason: '未能解析 CLI 版本号' };
  }
  return { ok: true, version, reasonCode: 'ok', reason: '' };
}

/**
 * Run `agy models` to verify authentication and list available models.
 */
export async function probeAgyModels(runner, executablePath, { timeoutMs = MODELS_PROBE_TIMEOUT_MS } = {}) {
  const result = await runner.run({
    command: executablePath,
    args: ['models'],
    timeoutMs,
  });
  const combined = `${result.stderr}\n${result.stdout}`;
  if (result.code !== 0) {
    const unauthenticated = AUTH_FAILURE_RE.test(combined);
    return {
      ok: false,
      unauthenticated,
      models: [],
      reason: clipDetail(result.stderr || result.stdout || result.errorMessage || `agy models 退出码 ${result.code}`, 160),
    };
  }
  return {
    ok: true,
    unauthenticated: false,
    models: parseAgyModelsOutput(result.stdout),
    reason: '',
  };
}

function buildFailureError(result, timeoutMs) {
  if (result.timedOut) {
    return Object.assign(new Error(`Antigravity CLI 在 ${Math.round(timeoutMs / 1000)} 秒内没有回复`), { name: 'TimeoutError', modelFailure: true });
  }
  if (result.errorCode) {
    return Object.assign(new Error(`无法启动 Antigravity CLI：${result.errorMessage || result.errorCode}`), { modelFailure: true });
  }
  const detail = clipDetail(result.stderr || result.stdout, 260);
  return Object.assign(
    new Error(`Antigravity CLI 执行失败（退出码 ${result.code ?? '未知'}）：${detail || '无错误详情'}`),
    { modelFailure: true },
  );
}

function buildLineDeltaHandler(execution) {
  const emitChunk = execution?.onOutput || execution?.onChunk;
  const emitReasoning = execution?.onReasoning;
  if (!emitChunk && !emitReasoning) return undefined;
  return (line) => {
    const item = parseAgyStreamLine(line);
    if (item?.textDelta && emitChunk) emitChunk(item.textDelta);
    if (item?.reasoningDelta && emitReasoning) emitReasoning(item.reasoningDelta.length);
  };
}

function tryStructuredAgyError(stdout) {
  if (!String(stdout || '').trim()) return null;
  try {
    parseAgyStreamOutput(stdout);
    return null;
  } catch (error) {
    return String(error?.message || '').startsWith('Antigravity CLI 执行失败：') ? error : null;
  }
}

function assertAgyRunOk(result, execution, timeoutMs) {
  if (execution?.signal?.aborted || result.aborted) {
    throw execution?.signal?.reason || new Error('模型调用已取消');
  }
  if (result.timedOut || result.errorCode) {
    throw buildFailureError(result, timeoutMs);
  }
  if (result.code !== 0) {
    const structured = tryStructuredAgyError(result.stdout);
    if (structured) throw structured;
    throw buildFailureError(result, timeoutMs);
  }
}

function resolveTimeoutMs(execution, defaultTimeoutMs) {
  const requested = execution?.timeoutMs;
  if (requested === undefined || requested === null) return defaultTimeoutMs;
  return Number.isFinite(requested) && requested >= 0 ? requested : defaultTimeoutMs;
}

function resolveEffort(agyConfig, execution) {
  const raw = execution?.reasoningEffort ?? execution?.route?.reasoningEffort ?? agyConfig.effort;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** What one call to agy needs: its flags, the line on stdin, and the limits the runner keeps. */
function planAgyCall(agyConfig, { system, prompt, execution, timeoutMs }) {
  const spec = agyWarmSpec({ ...agyConfig, effort: resolveEffort(agyConfig, execution) }, resolveTimeoutMs(execution, timeoutMs));
  return {
    spec,
    turn: {
      stdinText: buildAgyUserMessageLine(buildAgyWrappedPrompt(system, prompt)),
      timeoutMs: spec.timeoutMs,
      signal: execution?.signal,
      onStdoutLine: buildLineDeltaHandler(execution),
    },
  };
}

async function runFresh(runner, { spec, turn }) {
  const work = await createAgyWorkDir();
  try {
    const args = buildAgyStreamArgs({ timeoutMs: spec.timeoutMs, model: spec.model, effort: spec.effort });
    return await runner.run({ command: spec.executablePath, args, cwd: work.dir, ...turn });
  } finally {
    await work.remove();
  }
}

/**
 * Ask the spare that was already waiting. null means it never got the question: there is no such process, or it had ended and not
 * one byte came after the question. The call then starts fresh. After any output at all, an error included, agy may already have
 * asked the model, and sending again could be paid twice; neither is a call sent again once it was stopped or ran out of time.
 */
async function runOnSpare(spare, { turn }) {
  const result = await spare.run(turn);
  if (!result) return null;
  const unheard = result.silentTurn && !result.aborted && !result.timedOut && !turn.signal?.aborted;
  return unheard ? null : result;
}

/** The result of the call from a waiting spare when there is one that fits, else from a process started now. `warm.claim` also starts the next spare. */
async function runAgyCall(call, { runner, warm }) {
  const spare = warm?.claim(call.spec) ?? null;
  if (!spare) return runFresh(runner, call);
  try {
    return await runOnSpare(spare, call) ?? await runFresh(runner, call);
  } finally {
    await spare.close?.();
  }
}

function parseAgyRun(result) {
  try {
    return parseAgyStreamOutput(result.stdout);
  } catch (error) {
    if (result.truncated) {
      throw Object.assign(new Error('Antigravity CLI 输出超出上限被截断，未能读取最终结果'), { modelFailure: true });
    }
    throw error;
  }
}

/**
 * Create a StudyHub `complete(system, prompt, execution)` backed by `agy` CLI `stream-json`.
 * Every call gets its own agy process in its own empty temp `cwd`, removed afterwards. With `warm` (see `agy-spare.mjs`) that
 * process may already be waiting, started by an earlier call or by the settings; without it every call starts one.
 */
export function createAgyCompleteAdapter(agyConfig, {
  runner,
  report = reportTokens,
  timeoutMs = GENERATION_TIMEOUT_MS,
  warm = null,
} = {}) {
  const executablePath = String(agyConfig?.executablePath || '').trim();
  if (!executablePath) return undefined;

  return async function agyComplete(system, prompt, execution = {}) {
    const call = planAgyCall({ ...agyConfig, executablePath }, { system, prompt, execution, timeoutMs });
    let result = null;
    try {
      result = await runAgyCall(call, { runner, warm });
      assertAgyRunOk(result, execution, call.spec.timeoutMs);
      const parsed = parseAgyRun(result);
      report?.(parsed.usage, execution);
      return parsed.text;
    } catch (error) {
      // A stopped call says nothing about the CLI; any other failure may also hit the spare that is waiting.
      if (!execution?.signal?.aborted && !result?.aborted) warm?.fault();
      throw error;
    }
  };
}
