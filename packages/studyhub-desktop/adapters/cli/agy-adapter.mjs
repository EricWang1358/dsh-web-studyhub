import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { clipDetail } from '../../domain/redact.js';
import { parseCliVersion } from '../../domain/shim-parser.js';

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
    return Object.assign(new Error(`Antigravity CLI 在 ${Math.round(timeoutMs / 1000)} 秒内没有回复`), { modelFailure: true });
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
  if (!emitChunk) return undefined;
  return (line) => {
    const item = parseAgyStreamLine(line);
    if (item?.textDelta) emitChunk(item.textDelta);
  };
}

function assertAgyRunOk(result, execution, timeoutMs) {
  if (execution?.signal?.aborted || result.aborted) {
    throw execution?.signal?.reason || new Error('模型调用已取消');
  }
  if (result.timedOut || result.errorCode) {
    throw buildFailureError(result, timeoutMs);
  }
}

/**
 * Create a StudyHub `complete(system, prompt, execution)` backed by `agy` CLI `stream-json`.
 * Always executes inside a fresh empty temp `cwd` cleaned up in `finally`.
 */
export function createAgyCompleteAdapter(agyConfig, {
  runner,
  report = reportTokens,
  timeoutMs = GENERATION_TIMEOUT_MS,
} = {}) {
  const executablePath = String(agyConfig?.executablePath || '').trim();
  if (!executablePath) return undefined;

  return async function agyComplete(system, prompt, execution = {}) {
    const tempDir = await mkdtemp(join(tmpdir(), 'studyhub-agy-'));
    try {
      const args = buildAgyStreamArgs({ timeoutMs, model: agyConfig.model, effort: agyConfig.effort });
      const stdinText = buildAgyUserMessageLine(buildAgyWrappedPrompt(system, prompt));
      const result = await runner.run({
        command: executablePath,
        args,
        cwd: tempDir,
        stdinText,
        timeoutMs,
        signal: execution?.signal,
        onStdoutLine: buildLineDeltaHandler(execution),
      });
      assertAgyRunOk(result, execution, timeoutMs);
      const parsed = parseAgyStreamOutput(result.stdout);
      report?.(parsed.usage, execution);
      return parsed.text;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
