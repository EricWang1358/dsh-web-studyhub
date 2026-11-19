import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERATION_TIMEOUT_MS } from '../../../../lib/generation-limits.js';
import { usageFromTokenUsage } from '../../../../lib/token-usage.js';
import { reportUsage } from '../../../../lib/usage-scope.js';
import {
  buildCodexExecArgs,
  buildCodexWrappedPrompt,
  extractCodexJsonlError,
  parseCodexJsonlOutput,
  parseCodexLoginMethod,
  parseCodexModelsOutput,
  parseCodexStreamLine,
} from '../../domain/codex-protocol.js';
import { clipDetail } from '../../domain/redact.js';
import { probeCliVersion } from './agy-adapter.mjs';

const AUTH_PROBE_TIMEOUT_MS = 10_000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;

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
 * Run `codex login status` checking BOTH `stderr` and `stdout` (`codex` v0.170.0 writes login status to stderr).
 * Exit 0 -> authenticated; non-zero / error -> unauthenticated.
 */
export async function probeCodexAuth(runner, executablePath, { timeoutMs = AUTH_PROBE_TIMEOUT_MS } = {}) {
  const result = await runner.run({
    command: executablePath,
    args: ['login', 'status'],
    timeoutMs,
  });
  const combined = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  if (result.code === 0 && !result.timedOut && !result.errorCode) {
    return {
      ok: true,
      authenticated: true,
      authMethod: parseCodexLoginMethod(combined),
      detail: clipDetail(combined, 160),
    };
  }
  const fallback = result.timedOut
    ? 'codex login status timed out'
    : result.errorMessage || `codex login status exited with code ${result.code}`;
  return {
    ok: false,
    authenticated: false,
    detail: clipDetail(combined || fallback, 160),
  };
}

/**
 * The models this codex offers, from `codex debug models` (codex-cli 0.170.0; no model is called). It refreshes the catalog for the signed-in
 * account first; when that fails (offline), the catalog shipped with the CLI (`--bundled`) is the next best list. A codex with no such command,
 * or an answer with nothing to list, gives `ok: false` and no models.
 */
export async function probeCodexModels(runner, executablePath, { timeoutMs = MODELS_PROBE_TIMEOUT_MS } = {}) {
  let reason = '';
  for (const args of [['debug', 'models'], ['debug', 'models', '--bundled']]) {
    const result = await runner.run({ command: executablePath, args, timeoutMs });
    const models = result.code === 0 && !result.timedOut && !result.errorCode ? parseCodexModelsOutput(result.stdout) : [];
    if (models.length) return { ok: true, models, reason: '' };
    reason ||= clipDetail(result.stderr || result.errorMessage || `codex debug models exited with code ${result.code}`, 160);
  }
  return { ok: false, models: [], reason };
}

/**
 * Probe `--version` and `codex login status` for a Codex CLI candidate executable.
 */
export async function probeCodex(runner, executablePath, {
  versionTimeoutMs,
  authTimeoutMs = AUTH_PROBE_TIMEOUT_MS,
} = {}) {
  const ver = await probeCliVersion(runner, executablePath, versionTimeoutMs ? { timeoutMs: versionTimeoutMs } : {});
  if (!ver.ok) {
    return {
      ok: false,
      status: 'broken-shim',
      version: null,
      reasonCode: ver.reasonCode || 'broken-shim',
      reasonParams: ver.reasonParams || {},
      detail: ver.reason || '',
    };
  }
  const auth = await probeCodexAuth(runner, executablePath, { timeoutMs: authTimeoutMs });
  if (!auth.authenticated) {
    return {
      ok: false,
      status: 'unauthenticated',
      version: ver.version,
      reasonCode: 'unauthenticated',
      reasonParams: { cli: 'Codex CLI' },
      detail: auth.detail,
    };
  }
  return {
    ok: true,
    status: 'ready',
    version: ver.version,
    reasonCode: 'ready',
    reasonParams: ver.version ? { version: ver.version } : {},
    detail: auth.detail,
  };
}

function formatFailureMessage(zh, en, language) {
  return Object.assign(new Error(language === 'en' ? en : zh), { modelFailure: true });
}

function buildFailureError(result, timeoutMs, language) {
  if (result.timedOut) {
    const secs = Math.round(timeoutMs / 1000);
    return formatFailureMessage(`Codex CLI 在 ${secs} 秒内没有回复`, `Codex CLI did not reply within ${secs}s`, language);
  }
  if (result.errorCode) {
    const detail = result.errorMessage || result.errorCode;
    return formatFailureMessage(`无法启动 Codex CLI：${detail}`, `Failed to start Codex CLI: ${detail}`, language);
  }
  const jsonlErr = extractCodexJsonlError(result.stdout);
  const detail = clipDetail(jsonlErr || result.stderr || result.stdout, 260);
  const codeEn = result.code ?? 'unknown';
  const codeZh = result.code ?? '未知';
  return formatFailureMessage(
    `Codex CLI 执行失败（退出码 ${codeZh}）：${detail || '无错误详情'}`,
    `Codex CLI failed (exit code ${codeEn}): ${detail || 'no details'}`,
    language,
  );
}

function buildLineTextHandler(execution) {
  const emitChunk = execution?.onOutput || execution?.onChunk;
  if (!emitChunk) return undefined;
  return (line) => {
    const item = parseCodexStreamLine(line);
    if (item?.text) emitChunk(item.text);
  };
}

function assertCodexRunOk(result, execution, { timeoutMs, language }) {
  if (execution?.signal?.aborted || result.aborted) {
    const fallback = language === 'en' ? 'Model request cancelled' : '模型调用已取消';
    throw execution?.signal?.reason || new Error(fallback);
  }
  if (result.timedOut || result.errorCode || result.code !== 0) {
    throw buildFailureError(result, timeoutMs, language);
  }
}

/**
 * Create a StudyHub `complete(system, prompt, execution)` backed by `codex exec --json`.
 * Always executes inside a fresh empty temp `cwd` cleaned up in `finally`.
 */
export function createCodexCompleteAdapter(codexConfig, {
  runner,
  report = reportTokens,
  timeoutMs = GENERATION_TIMEOUT_MS,
  language = 'zh',
} = {}) {
  const executablePath = String(codexConfig?.executablePath || '').trim();
  if (!executablePath) return undefined;

  return async function codexComplete(system, prompt, execution = {}) {
    const tempDir = await mkdtemp(join(tmpdir(), 'studyhub-codex-'));
    try {
      const args = buildCodexExecArgs({ model: codexConfig.model, effort: codexConfig.effort });
      const stdinText = buildCodexWrappedPrompt(system, prompt);
      const result = await runner.run({
        command: executablePath,
        args,
        cwd: tempDir,
        stdinText,
        timeoutMs,
        signal: execution?.signal,
        onStdoutLine: buildLineTextHandler(execution),
      });
      assertCodexRunOk(result, execution, { timeoutMs, language });
      const parsed = parseCodexJsonlOutput(result.stdout, { language });
      report?.(parsed.usage, execution);
      return parsed.text;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
