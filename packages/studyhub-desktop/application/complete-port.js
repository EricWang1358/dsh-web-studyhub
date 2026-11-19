import { normalizeBaseUrl } from '../domain/config-policy.js';

const OPENAI_TEST_TIMEOUT_MS = 30_000;
const AGY_TEST_TIMEOUT_MS = 45_000;

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

function resolveDraftAgy(savedAgy, rawAgy) {
  if (!rawAgy || typeof rawAgy !== 'object') return savedAgy;
  return {
    executablePath: pickStr(rawAgy.executablePath, savedAgy.executablePath),
    model: pickStr(rawAgy.model, savedAgy.model),
    effort: pickStr(rawAgy.effort, savedAgy.effort),
  };
}

function resolveDraftConfig(saved, override) {
  if (!override || typeof override !== 'object') return saved;
  const mode = override.mode === 'agy' || override.mode === 'openai' ? override.mode : saved.mode;
  return {
    ...saved,
    mode,
    openai: resolveDraftOpenAi(saved.openai, override.openai),
    agy: resolveDraftAgy(saved.agy, override.agy),
  };
}

function formatMissingRunnerMessage(mode, language) {
  if (language === 'en') {
    return mode === 'agy'
      ? 'No usable Antigravity CLI (agy) executable was found'
      : 'Please enter the base URL, model name, and API key first';
  }
  return mode === 'agy'
    ? '未找到可用的 Antigravity CLI (agy) 可执行文件'
    : '请先填写完整的接口地址、模型名和 API Key';
}

function formatTestSuccessMessage(reply, language) {
  const preview = String(reply ?? '').trim().slice(0, 40);
  if (language === 'en') {
    return preview ? `Connected (replied: ${preview})` : 'Connected';
  }
  return preview ? `连接成功（模型回复：${preview}）` : '连接成功';
}

/**
 * Thin completion dispatcher producing StudyHub's `complete(system, prompt, execution)`.
 * Does not duplicate ModelGateway, queues, or usage ledgers.
 */
export function createDesktopCompletePort({
  getConfig,
  getAgyExecutablePath,
  openaiComplete,
  agyComplete,
  injectedComplete = null,
}) {
  function resolveAgyPath(config) {
    return config.agy.executablePath || getAgyExecutablePath() || '';
  }

  function buildForConfig(config, options = {}) {
    if (injectedComplete && !options.ignoreInjected) {
      return injectedComplete;
    }
    if (config.mode === 'agy') {
      const executablePath = resolveAgyPath(config);
      if (!executablePath) return undefined;
      return agyComplete({ ...config.agy, executablePath }, options);
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
    const timeoutMs = draft.mode === 'agy' ? AGY_TEST_TIMEOUT_MS : OPENAI_TEST_TIMEOUT_MS;
    const runner = buildForConfig(draft, { timeoutMs });
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
