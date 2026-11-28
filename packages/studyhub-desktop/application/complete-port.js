import { isRateLimitError, withModelRetry } from '../../../lib/model-retry.js';
import { stageRequest } from '../../../lib/prompt-order.js';
import { normalizeBaseUrl } from '../domain/config-policy.js';

const OPENAI_TEST_TIMEOUT_MS = 30_000;
// A healthy agy answers a one-word test in about 40 s when one of the CLI's own plugins is slow to connect (measured 39.9-43.4 s), so 45 s called a working CLI broken.
const AGY_TEST_TIMEOUT_MS = 90_000;
const CODEX_TEST_TIMEOUT_MS = 60_000;
const REASONING_MODEL_RE = /^(?:o[134](?:$|[-.])|gpt-5(?:$|[-.]))/i;

function pickStr(overrideVal, fallback) {
  return overrideVal !== undefined ? String(overrideVal).trim() : fallback;
}

function resolveDraftOpenAi(savedOpenAi, rawOpenAi) {
  if (!rawOpenAi || typeof rawOpenAi !== 'object') return savedOpenAi;
  const baseUrl = rawOpenAi.baseUrl !== undefined ? normalizeBaseUrl(rawOpenAi.baseUrl) : savedOpenAi.baseUrl;
  const sameEndpoint = baseUrl === normalizeBaseUrl(savedOpenAi.baseUrl);
  const apiKey = rawOpenAi.apiKey !== undefined
    ? String(rawOpenAi.apiKey).trim()
    : (sameEndpoint ? savedOpenAi.apiKey : '');
  return {
    providerId: pickStr(rawOpenAi.providerId, savedOpenAi.providerId),
    baseUrl,
    model: pickStr(rawOpenAi.model, savedOpenAi.model),
    apiKey,
  };
}

function resolveDraftCli(savedCli, rawCli) {
  if (!rawCli || typeof rawCli !== 'object') return savedCli;
  return {
    executablePath: pickStr(rawCli.executablePath, savedCli.executablePath),
    model: pickStr(rawCli.model, savedCli.model),
    effort: pickStr(rawCli.effort, savedCli.effort),
  };
}

function resolveDraftConfig(saved, override) {
  if (!override || typeof override !== 'object') return saved;
  const isKnownMode = override.mode === 'agy' || override.mode === 'codex' || override.mode === 'openai';
  const mode = isKnownMode ? override.mode : saved.mode;
  return {
    ...saved,
    mode,
    openai: resolveDraftOpenAi(saved.openai, override.openai),
    agy: resolveDraftCli(saved.agy, override.agy),
    codex: resolveDraftCli(saved.codex, override.codex),
  };
}

function formatMissingRunnerMessage(mode, language) {
  if (language === 'en') {
    if (mode === 'codex') return 'No usable Codex CLI executable was found';
    if (mode === 'agy') return 'No usable Antigravity CLI (agy) executable was found';
    return 'Please enter the base URL, model name, and API key first';
  }
  if (mode === 'codex') return '未找到可用的 Codex CLI 可执行文件';
  if (mode === 'agy') return '未找到可用的 Antigravity CLI (agy) 可执行文件';
  return '请先填写完整的接口地址、模型名和 API Key';
}

function formatTestSuccessMessage(reply, language) {
  const preview = String(reply ?? '').trim().slice(0, 40);
  if (language === 'en') {
    return preview ? `Connected (replied: ${preview})` : 'Connected';
  }
  return preview ? `连接成功（模型回复：${preview}）` : '连接成功';
}

function testTimeoutForMode(mode) {
  if (mode === 'codex') return CODEX_TEST_TIMEOUT_MS;
  if (mode === 'agy') return AGY_TEST_TIMEOUT_MS;
  return OPENAI_TEST_TIMEOUT_MS;
}

function effectiveEffortFor(config, execution, light) {
  const explicit = execution?.reasoningEffort ?? execution?.route?.reasoningEffort;
  if (explicit) return explicit;
  const saved = config?.reasoningEffort || '';
  if (!saved) return undefined;
  return light ? 'low' : saved;
}

function labelForExecution(execution) {
  if (execution?.jobId) {
    const stage = execution.stage || execution.task || 'step';
    return `Study ${String(execution.jobId).slice(0, 8)} · ${stage}`;
  }
  return execution?.stage || execution?.task || 'direct';
}

function prepareDesktopExecution(rawSystem, rawPrompt, execution, { config, light }) {
  const { system, prompt } = execution?.jobId ? stageRequest(rawSystem, rawPrompt) : { system: rawSystem, prompt: rawPrompt };
  const effort = effectiveEffortFor(config, execution, light);
  const enriched = effort && !execution?.reasoningEffort ? { ...execution, reasoningEffort: effort } : execution;
  return { system, prompt, enriched, label: labelForExecution(enriched) };
}

function invokeWithOptionalRetry(runOnce, enriched) {
  if (!enriched?.retryTransient && !enriched?.jobId) return runOnce();
  return withModelRetry(runOnce, {
    ...(enriched?.retryDelays ? { delays: enriched.retryDelays } : {}),
    signal: enriched?.signal,
    skip: (error) => Boolean(enriched?.signal?.aborted) || isRateLimitError(error),
  });
}

function wrapDesktopComplete(baseRunner, options) {
  return async function desktopComplete(rawSystem, rawPrompt, execution = {}) {
    execution?.signal?.throwIfAborted?.();
    const { system, prompt, enriched, label } = prepareDesktopExecution(rawSystem, rawPrompt, execution, options);
    const emitEvent = typeof enriched?.onEvent === 'function' ? enriched.onEvent : null;
    emitEvent?.({ status: 'running', runtime: 'direct', label });
    try {
      const text = await invokeWithOptionalRetry(() => baseRunner(system, prompt, enriched), enriched);
      emitEvent?.({ status: 'complete', runtime: 'direct', label });
      return text;
    } catch (error) {
      emitEvent?.({ status: 'failed', runtime: 'direct', label });
      throw error;
    }
  };
}

/**
 * Thin completion dispatcher producing StudyHub's `complete(system, prompt, execution)`.
 * Preserves prompt-cache stage reordering, lifecycle events, reasoning effort, and transient retry parity with DSH.
 */
export function createDesktopCompletePort({
  getConfig,
  getAgyExecutablePath,
  getCodexExecutablePath = () => '',
  openaiComplete,
  agyComplete,
  codexComplete = null,
  injectedComplete = null,
}) {
  function resolveCliRunner(mode, config, options) {
    if (mode === 'agy') {
      const executablePath = config.agy.executablePath || getAgyExecutablePath() || '';
      return executablePath ? agyComplete({ ...config.agy, executablePath }, options) : undefined;
    }
    const executablePath = config.codex?.executablePath || getCodexExecutablePath() || '';
    return executablePath && codexComplete ? codexComplete({ ...config.codex, executablePath }, options) : undefined;
  }

  function buildForConfig(config, options = {}) {
    if (injectedComplete && !options.ignoreInjected) {
      return injectedComplete;
    }
    if (config.mode === 'agy' || config.mode === 'codex') {
      return resolveCliRunner(config.mode, config, options);
    }
    if (!config.openai.baseUrl || !config.openai.model || !config.openai.apiKey) {
      return undefined;
    }
    return openaiComplete({ ...config.openai, reasoningEffort: config.reasoningEffort || '' }, options);
  }

  function makeComplete(_route = null, _sessionId = '', options = {}) {
    const config = getConfig();
    const runner = buildForConfig(config);
    if (!runner) return undefined;
    if (injectedComplete && runner === injectedComplete) return runner;
    return wrapDesktopComplete(runner, { config, light: options?.light === true });
  }

  async function testConnection(override = null, language = 'zh') {
    const started = Date.now();
    const draft = resolveDraftConfig(getConfig(), override);
    const timeoutMs = testTimeoutForMode(draft.mode);
    // `fresh`: the test must start the CLI now; a process started ahead of time would not show that it can still start and sign in.
    const runner = buildForConfig(draft, { timeoutMs, language, fresh: true });
    if (!runner) {
      return { ok: false, message: formatMissingRunnerMessage(draft.mode, language), latencyMs: Date.now() - started };
    }
    const isOpenAiReasoning = draft.mode === 'openai' && REASONING_MODEL_RE.test(draft.openai.model || '');
    const testExec = { task: 'test', ...(isOpenAiReasoning ? {} : { maxTokens: 16 }) };
    try {
      const reply = await runner('Reply with the single word OK.', 'OK?', testExec);
      return { ok: true, message: formatTestSuccessMessage(reply, language), latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, message: error?.message || String(error), latencyMs: Date.now() - started };
    }
  }

  return Object.freeze({
    makeComplete,
    testConnection,
  });
}
