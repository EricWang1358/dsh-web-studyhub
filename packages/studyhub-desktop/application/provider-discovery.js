import { ALL_CLI_PROVIDERS, PROVIDER_DISPLAY_NAMES, SUPPORTED_CLI_PROVIDERS } from '../domain/contracts.js';

const DEFAULT_CACHE_TTL_MS = 30_000;
const AUTH_ERROR_RE = /\b(unauth|unauthorized|not logged in|login required|sign in|authenticate|credentials?|token expired|auth)\b/i;

const REASON_MESSAGES = Object.freeze({
  ready: {
    zh: (p) => (p.version ? `已就绪 (v${p.version})` : '已就绪'),
    en: (p) => (p.version ? `Ready (v${p.version})` : 'Ready'),
  },
  unauthenticated: {
    zh: () => '检测到 agy CLI，但尚未登录账号',
    en: () => 'Detected agy CLI, but it is not signed in yet',
  },
  'not-installed': {
    zh: () => '未检测到本机安装',
    en: () => 'Not installed locally',
  },
  'coming-soon-not-installed': {
    zh: () => '尚未安装（即将支持）',
    en: () => 'Not installed (coming soon)',
  },
  'coming-soon-detected': {
    zh: (p) => (p.version ? `已检测到 v${p.version}，即将支持` : '已检测到本机 CLI，即将支持'),
    en: (p) => (p.version ? `Detected v${p.version} (coming soon)` : 'Detected locally (coming soon)'),
  },
  'broken-shim': {
    zh: () => '启动脚本损坏或目标文件缺失',
    en: () => 'Broken launch shim or missing target',
  },
  'probe-timeout': {
    zh: () => '版本检测超时',
    en: () => 'Version probe timed out',
  },
  'spawn-error': {
    zh: (p) => `无法启动程序 (${p.code || 'unknown'})`,
    en: (p) => `Failed to launch (${p.code || 'unknown'})`,
  },
  'exit-error': {
    zh: (p) => `版本检测失败（退出码 ${p.code || 'unknown'}）`,
    en: (p) => `Version probe failed (exit code ${p.code || 'unknown'})`,
  },
  'version-unparsed': {
    zh: () => '未能解析 CLI 版本号',
    en: () => 'Could not parse CLI version',
  },
});

function isAuthErrorText(text) {
  return AUTH_ERROR_RE.test(String(text ?? ''));
}

/**
 * Format a structured `ProbeResult` reason into `'zh'` or `'en'`.
 */
export function localizeProbeResult(provider, language = 'zh') {
  const lang = language === 'en' ? 'en' : 'zh';
  const entry = REASON_MESSAGES[provider.reasonCode];
  if (!entry) return { ...provider };
  const params = provider.reasonParams || {};
  let text = entry[lang](params);
  if (!provider.supported && !provider.reasonCode.startsWith('coming-soon-')) {
    text = lang === 'en' ? `${text} (coming soon)` : `${text}（即将支持）`;
  }
  return { ...provider, reason: text };
}

/**
 * Localize an array of `ProbeResult` objects for the requested UI language.
 */
export function localizeProviders(providers, language = 'zh') {
  return (Array.isArray(providers) ? providers : []).map((item) => localizeProbeResult(item, language));
}

function makeProbeResult({ id, supported, status, executablePath, version, reasonCode, reasonParams = {}, models }) {
  const base = {
    id,
    name: PROVIDER_DISPLAY_NAMES[id],
    supported,
    status,
    executablePath,
    version,
    reasonCode,
    reasonParams,
    reason: '',
    ...(models !== undefined ? { models } : {}),
  };
  return localizeProbeResult(base, 'zh');
}

function buildNotInstalled(id, supported) {
  return makeProbeResult({
    id,
    supported,
    status: supported ? 'not-installed' : 'coming-soon',
    executablePath: null,
    version: null,
    reasonCode: supported ? 'not-installed' : 'coming-soon-not-installed',
  });
}

function buildBrokenShim(id, supported, failure) {
  return makeProbeResult({
    id,
    supported,
    status: supported ? 'broken-shim' : 'coming-soon',
    executablePath: failure.candidate,
    version: null,
    reasonCode: failure.reasonCode || 'broken-shim',
    reasonParams: failure.reasonParams || {},
  });
}

async function probeSupportedAgy({ candidates, probeVersion, listAgyModels }) {
  let firstBroken = null;
  for (const candidate of candidates) {
    const ver = await probeVersion('agy', candidate);
    if (!ver.ok) {
      firstBroken ||= { candidate, reasonCode: ver.reasonCode || 'broken-shim', reasonParams: ver.reasonParams || {} };
      continue;
    }
    const modelsResult = await listAgyModels(candidate);
    if (modelsResult.unauthenticated || (!modelsResult.ok && isAuthErrorText(modelsResult.reason))) {
      return makeProbeResult({
        id: 'agy',
        supported: true,
        status: 'unauthenticated',
        executablePath: candidate,
        version: ver.version,
        reasonCode: 'unauthenticated',
        models: [],
      });
    }
    return makeProbeResult({
      id: 'agy',
      supported: true,
      status: 'ready',
      executablePath: candidate,
      version: ver.version,
      reasonCode: 'ready',
      reasonParams: ver.version ? { version: ver.version } : {},
      models: Array.isArray(modelsResult.models) ? modelsResult.models : [],
    });
  }
  return firstBroken ? buildBrokenShim('agy', true, firstBroken) : buildNotInstalled('agy', true);
}

async function probeComingSoonProvider({ id, candidates, probeVersion }) {
  let firstBroken = null;
  for (const candidate of candidates) {
    const ver = await probeVersion(id, candidate);
    if (ver.ok) {
      return makeProbeResult({
        id,
        supported: false,
        status: 'coming-soon',
        executablePath: candidate,
        version: ver.version,
        reasonCode: 'coming-soon-detected',
        reasonParams: ver.version ? { version: ver.version } : {},
      });
    }
    firstBroken ||= { candidate, reasonCode: ver.reasonCode || 'broken-shim', reasonParams: ver.reasonParams || {} };
  }
  return firstBroken ? buildBrokenShim(id, false, firstBroken) : buildNotInstalled(id, false);
}

/**
 * Orchestrate local CLI provider discovery with TTL caching.
 * Depends only on injected ports (no direct fs or child_process imports).
 */
export function createProviderDiscovery({
  listCandidates,
  probeVersion,
  listAgyModels,
  getCustomPath = () => '',
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = () => Date.now(),
}) {
  let cached = null;
  let cachedAt = 0;
  let cachedCustomPath = '';

  async function scanOne(id, customPath) {
    const supported = SUPPORTED_CLI_PROVIDERS.includes(id);
    const candidates = await listCandidates(id, { customPath: id === 'agy' ? customPath : '' });
    if (!candidates.length) return buildNotInstalled(id, supported);
    if (id === 'agy') return probeSupportedAgy({ candidates, probeVersion, listAgyModels });
    return probeComingSoonProvider({ id, candidates, probeVersion });
  }

  async function scan({ force = false } = {}) {
    const customPath = getCustomPath() || '';
    const cacheValid = !force
      && cached !== null
      && customPath === cachedCustomPath
      && now() - cachedAt < ttlMs;
    if (cacheValid) return cached;
    const providers = await Promise.all(ALL_CLI_PROVIDERS.map((id) => scanOne(id, customPath)));
    cached = providers;
    cachedAt = now();
    cachedCustomPath = customPath;
    return providers;
  }

  return Object.freeze({
    scan,
    getCached: () => cached || [],
    findReadyAgyPath: () => (cached || []).find((item) => item.id === 'agy' && item.status === 'ready')?.executablePath || '',
  });
}
