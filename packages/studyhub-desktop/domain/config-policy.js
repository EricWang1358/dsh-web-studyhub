// @ts-check
import { keyLast4 } from './redact.js';

/** @typedef {import('./contracts.js').AgyConfig} AgyConfig */
/** @typedef {import('./contracts.js').AgyEffort} AgyEffort */
/** @typedef {import('./contracts.js').CodexConfig} CodexConfig */
/** @typedef {import('./contracts.js').CodexEffort} CodexEffort */
/** @typedef {import('./contracts.js').DesktopConfig} DesktopConfig */
/** @typedef {import('./contracts.js').DesktopMode} DesktopMode */
/** @typedef {import('./contracts.js').EffectiveModelState} EffectiveModelState */
/** @typedef {import('./contracts.js').OpenAiConfig} OpenAiConfig */
/** @typedef {import('./contracts.js').OpenAiConfigView} OpenAiConfigView */
/** @typedef {import('./contracts.js').OpenAiPreset} OpenAiPreset */
/** @typedef {import('./contracts.js').ModelVia} ModelVia */
/** @typedef {import('./contracts.js').ProbeResult} ProbeResult */

/** @type {readonly OpenAiPreset[]} */
export const OPENAI_PRESETS = Object.freeze([
  Object.freeze({
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
  }),
  Object.freeze({
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
  }),
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  }),
  Object.freeze({
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    defaultModel: '',
  }),
]);

export const CLI_CONCURRENCY_CAP = Object.freeze({
  defaultConcurrency: 1,
  maxConcurrency: 2,
});

const VALID_MODES = new Set(['openai', 'agy', 'codex']);
const VALID_AGY_EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
const VALID_CODEX_EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh']);
const VALID_API_KEY_RE = /^[\x21-\x7e]{1,512}$/;

/**
 * @param {DesktopMode} mode
 * @returns {boolean}
 */
function isCliMode(mode) {
  return mode === 'agy' || mode === 'codex';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize a base URL by trimming whitespace and trailing slashes.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBaseUrl(value) {
  return trimText(value).replace(/\/+$/, '');
}

/**
 * Validate an OpenAI-compatible HTTP(S) base URL without embedded credentials.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidBaseUrl(value) {
  const url = normalizeBaseUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const validProtocol = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    return validProtocol && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Extract origin of a URL, or empty string if invalid.
 * @param {string} value
 * @returns {string}
 */
export function originOfUrl(value) {
  try {
    return new URL(normalizeBaseUrl(value)).origin;
  } catch {
    return '';
  }
}

/**
 * Validate printable ASCII API key without whitespace.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidApiKey(value) {
  return VALID_API_KEY_RE.test(value);
}

/**
 * Create a clean default DesktopConfig.
 * @returns {DesktopConfig}
 */
export function defaultDesktopConfig() {
  return {
    mode: 'openai',
    openai: {
      providerId: 'deepseek',
      baseUrl: '',
      model: '',
      apiKey: '',
    },
    agy: {
      executablePath: '',
      model: '',
      effort: '',
    },
    codex: {
      executablePath: '',
      model: '',
      effort: '',
    },
    libraryRoot: '',
    libraryPlaceConfirmed: false,
    reasoningEffort: '',
  };
}

/**
 * Return concurrency policy for the given mode.
 * Local CLI modes (`agy`, `codex`) are capped at default 1 / max 2; OpenAI is uncapped (null).
 * @param {DesktopMode} mode
 * @returns {{ defaultConcurrency: number | null, maxConcurrency: number | null }}
 */
export function concurrencyPolicyForMode(mode) {
  if (isCliMode(mode)) {
    return {
      defaultConcurrency: CLI_CONCURRENCY_CAP.defaultConcurrency,
      maxConcurrency: CLI_CONCURRENCY_CAP.maxConcurrency,
    };
  }
  return { defaultConcurrency: null, maxConcurrency: null };
}

/**
 * Convert mode concurrency policy into `registerHostConcurrencyCap` hook input.
 * @param {DesktopMode} mode
 * @returns {{ max: number, default: number } | null}
 */
export function concurrencyHookForMode(mode) {
  if (isCliMode(mode)) {
    return {
      max: CLI_CONCURRENCY_CAP.maxConcurrency,
      default: CLI_CONCURRENCY_CAP.defaultConcurrency,
    };
  }
  return null;
}

/**
 * @param {unknown} raw
 * @param {Set<string>} validEfforts
 * @returns {{ executablePath: string, model: string, effort: string }}
 */
function normalizeCliSection(raw, validEfforts) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const effortStr = trimText(src.effort);
  return {
    executablePath: trimText(src.executablePath),
    model: trimText(src.model),
    effort: validEfforts.has(effortStr) ? effortStr : '',
  };
}

/**
 * Forgivingly normalize persisted desktop config JSON.
 * @param {unknown} raw
 * @returns {DesktopConfig}
 */
export function normalizeDesktopConfig(raw) {
  const base = defaultDesktopConfig();
  if (!raw || typeof raw !== 'object') return base;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const mode = VALID_MODES.has(String(source.mode)) ? /** @type {DesktopMode} */ (source.mode) : base.mode;
  const rawOpenAi = source.openai && typeof source.openai === 'object'
    ? /** @type {Record<string, unknown>} */ (source.openai)
    : {};
  const agy = /** @type {AgyConfig} */ (normalizeCliSection(source.agy, VALID_AGY_EFFORTS));
  const codex = /** @type {CodexConfig} */ (normalizeCliSection(source.codex, VALID_CODEX_EFFORTS));

  return {
    mode,
    openai: {
      providerId: trimText(rawOpenAi.providerId) || base.openai.providerId,
      baseUrl: normalizeBaseUrl(rawOpenAi.baseUrl),
      model: trimText(rawOpenAi.model),
      apiKey: trimText(rawOpenAi.apiKey),
    },
    agy,
    codex,
    libraryRoot: trimText(source.libraryRoot),
    libraryPlaceConfirmed: source.libraryPlaceConfirmed === true,
    reasoningEffort: trimText(source.reasoningEffort),
  };
}

/**
 * Build an error carrying a stable lowercase code for StudyHub responses.
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function configError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Validate and normalize an incoming OpenAI base URL.
 * @param {unknown} rawUrl
 * @returns {string}
 */
function parsePatchBaseUrl(rawUrl) {
  const nextUrl = normalizeBaseUrl(rawUrl);
  if (nextUrl && !isValidBaseUrl(nextUrl)) {
    throw configError('model-url-invalid', '接口地址格式不正确，请填写完整的 http:// 或 https:// 地址');
  }
  return nextUrl;
}

/**
 * Validate and normalize an incoming OpenAI API key.
 * @param {unknown} rawKey
 * @returns {string}
 */
function parsePatchApiKey(rawKey) {
  const nextKey = trimText(rawKey);
  if (nextKey && !isValidApiKey(nextKey)) {
    throw configError('model-key-invalid', 'API Key 格式不正确，不能包含空格或控制字符');
  }
  return nextKey;
}

/**
 * Apply an OpenAI patch enforcing credential isolation when `baseUrl` changes.
 * @param {OpenAiConfig} current
 * @param {Record<string, unknown>} patch
 * @returns {{ openai: OpenAiConfig, keyDropped: boolean }}
 */
function mergeOpenAiPatch(current, patch) {
  const next = { ...current };
  let keyDropped = false;
  const hasNewKey = patch.apiKey !== undefined;

  if (patch.providerId !== undefined) next.providerId = trimText(patch.providerId) || 'custom';
  if (patch.baseUrl !== undefined) {
    const nextUrl = parsePatchBaseUrl(patch.baseUrl);
    if (current.apiKey && !hasNewKey && nextUrl !== normalizeBaseUrl(current.baseUrl)) {
      next.apiKey = '';
      keyDropped = true;
    }
    next.baseUrl = nextUrl;
  }
  if (patch.model !== undefined) next.model = trimText(patch.model);
  if (hasNewKey) next.apiKey = parsePatchApiKey(patch.apiKey);
  return { openai: next, keyDropped };
}

/**
 * Apply a CLI provider (`agy` / `codex`) config patch with strict effort validation.
 * @template {{ executablePath: string, model: string, effort: string }} T
 * @param {T} current
 * @param {Record<string, unknown>} patch
 * @param {Set<string>} validEfforts
 * @returns {T}
 */
function mergeCliPatch(current, patch, validEfforts) {
  const next = { ...current };
  if (patch.executablePath !== undefined) {
    next.executablePath = trimText(patch.executablePath);
  }
  if (patch.model !== undefined) {
    next.model = trimText(patch.model);
  }
  if (patch.effort !== undefined) {
    const effort = trimText(patch.effort);
    if (!validEfforts.has(effort)) {
      throw configError('invalid-effort', '思考强度设置无效');
    }
    next.effort = effort;
  }
  return next;
}

/**
 * Pure state transition for `desktop.config.save`.
 * @param {DesktopConfig} current
 * @param {Record<string, unknown>} patch
 * @returns {{ config: DesktopConfig, keyDropped: boolean }}
 */
export function applyConfigPatch(current, patch) {
  if (!patch || typeof patch !== 'object') {
    throw configError('invalid-config', '配置参数必须是对象');
  }
  const base = normalizeDesktopConfig(current);
  let mode = base.mode;
  if (patch.mode !== undefined) {
    const candidate = trimText(patch.mode);
    if (!VALID_MODES.has(candidate)) {
      throw configError('invalid-mode', '不支持的模型接入方式');
    }
    mode = /** @type {DesktopMode} */ (candidate);
  }

  let openai = base.openai;
  let keyDropped = false;
  if (patch.openai && typeof patch.openai === 'object') {
    const merged = mergeOpenAiPatch(base.openai, /** @type {Record<string, unknown>} */ (patch.openai));
    openai = merged.openai;
    keyDropped = merged.keyDropped;
  }

  const agy = patch.agy && typeof patch.agy === 'object'
    ? mergeCliPatch(base.agy, /** @type {Record<string, unknown>} */ (patch.agy), VALID_AGY_EFFORTS)
    : base.agy;
  const codex = patch.codex && typeof patch.codex === 'object'
    ? mergeCliPatch(base.codex, /** @type {Record<string, unknown>} */ (patch.codex), VALID_CODEX_EFFORTS)
    : base.codex;
  const reasoningEffort = typeof patch.reasoningEffort === 'string' ? trimText(patch.reasoningEffort) : base.reasoningEffort;

  return { config: { ...base, mode, openai, agy, codex, reasoningEffort }, keyDropped };
}

/**
 * Return the safe UI-visible view of desktop config (never includes raw `apiKey`).
 * @param {DesktopConfig} config
 * @returns {{ mode: DesktopMode, openai: OpenAiConfigView, agy: AgyConfig, codex: CodexConfig }}
 */
export function redactDesktopConfig(config) {
  return {
    mode: config.mode,
    openai: {
      providerId: config.openai.providerId,
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      hasKey: Boolean(config.openai.apiKey),
      keyLast4: keyLast4(config.openai.apiKey),
    },
    agy: {
      executablePath: config.agy.executablePath,
      model: config.agy.model,
      effort: config.agy.effort,
    },
    codex: {
      executablePath: config.codex.executablePath,
      model: config.codex.model,
      effort: config.codex.effort,
    },
  };
}

/**
 * Display name of an OpenAI-compatible provider from preset or URL host.
 * @param {OpenAiConfig} openai
 * @returns {string}
 */
export function openAiProviderLabel(openai) {
  const preset = OPENAI_PRESETS.find((item) => item.id === openai.providerId && item.id !== 'custom');
  if (preset && (!openai.baseUrl || originOfUrl(preset.baseUrl) === originOfUrl(openai.baseUrl))) {
    return preset.name;
  }
  try {
    return new URL(openai.baseUrl).hostname || 'OpenAI 兼容接口';
  } catch {
    return 'OpenAI 兼容接口';
  }
}

const CLI_TITLES = Object.freeze({ agy: 'Antigravity CLI', codex: 'Codex CLI' });

/** What a ready codex costs, from how its login status says it is signed in: an account has a quota, an API key is billed per use. Anything else is not guessed. */
const CODEX_BILLING = Object.freeze({ account: 'account', 'api-key': 'per-use' });

/**
 * How the model in use is reached and what it costs: the learner's API Key (billed per use), or a CLI on this computer (the quota of the account it
 * is signed in to; a codex signed in with an API key is billed per use, and one whose login is not known promises neither).
 * @param {DesktopConfig} config
 * @param {readonly ProbeResult[]} [providers] what discovery found, for how codex is signed in
 * @returns {ModelVia}
 */
export function modelViaOf(config, providers = []) {
  if (config.mode === 'agy') return { kind: 'cli', name: CLI_TITLES.agy, billing: 'account' };
  if (config.mode === 'codex') {
    const probe = providers.find((item) => item.id === 'codex' && item.status === 'ready');
    return { kind: 'cli', name: CLI_TITLES.codex, billing: CODEX_BILLING[probe?.authMethod] ?? 'unknown' };
  }
  return { kind: 'api', name: openAiProviderLabel(config.openai), billing: 'per-use' };
}

/**
 * @param {'agy' | 'codex'} id
 * @param {AgyConfig | CodexConfig} cliConfig
 * @param {readonly ProbeResult[]} providers
 * @returns {EffectiveModelState}
 */
function resolveEffectiveCli(id, cliConfig, providers) {
  const probe = providers.find((item) => item.id === id) || null;
  const ready = probe && probe.status !== 'ready' ? false : Boolean(cliConfig.executablePath) || probe?.status === 'ready';
  const reason = ready ? 'ok' : probe?.status === 'unauthenticated' ? 'no-credential' : 'no-route';
  return {
    ready,
    label: `${CLI_TITLES[id]} · ${cliConfig.model || '默认模型'}`,
    reason,
    provider: id,
    model: cliConfig.model || 'default',
    ...concurrencyPolicyForMode(id),
  };
}

/**
 * Resolve effective model readiness and concurrency policy (never returns 'unknown').
 * @param {DesktopConfig} config
 * @param {readonly ProbeResult[]} [providers]
 * @returns {EffectiveModelState}
 */
export function resolveEffectiveModel(config, providers = []) {
  if (config.mode === 'agy') return resolveEffectiveCli('agy', config.agy, providers);
  if (config.mode === 'codex') return resolveEffectiveCli('codex', config.codex, providers);

  const concurrency = concurrencyPolicyForMode('openai');
  const hasEndpoint = Boolean(config.openai.baseUrl && config.openai.model);
  if (!hasEndpoint) {
    return { ready: false, label: '', reason: 'no-route', provider: '', model: '', ...concurrency };
  }
  const provider = openAiProviderLabel(config.openai);
  const model = config.openai.model;
  const ready = Boolean(config.openai.apiKey);
  return {
    ready,
    label: `${provider} · ${model}`,
    reason: ready ? 'ok' : 'no-credential',
    provider,
    model,
    ...concurrency,
  };
}
