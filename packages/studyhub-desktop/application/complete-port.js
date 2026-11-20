import { normalizeBaseUrl } from '../domain/config-policy.js';

const OPENAI_TEST_TIMEOUT_MS = 30_000;
const AGY_TEST_TIMEOUT_MS = 45_000;
const CODEX_TEST_TIMEOUT_MS = 60_000;

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

/**
 * Thin completion dispatcher producing StudyHub's `complete(system, prompt, execution)`.
 * Does not duplicate ModelGateway, queues, or usage ledgers.
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
    return openaiComplete(config.openai, options);
  }

  function makeComplete() {
    const config = getConfig();
    return buildForConfig(config);
  }

  async function testConnection(override = null, language = 'zh') {
    const started = Date.now();
    const draft = resolveDraftConfig(getConfig(), override);
    const timeoutMs = testTimeoutForMode(draft.mode);
    const runner = buildForConfig(draft, { timeoutMs, language });
    if (!runner) {
      return { ok: false, message: formatMissingRunnerMessage(draft.mode, language), latencyMs: Date.now() - started };
    }
    try {
      const reply = await runner('Reply with the single word OK.', 'OK?', { maxTokens: 16, task: 'test' });
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
