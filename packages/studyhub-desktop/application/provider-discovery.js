import { ALL_CLI_PROVIDERS, PROVIDER_DISPLAY_NAMES, SUPPORTED_CLI_PROVIDERS } from '../domain/contracts.js';

const DEFAULT_CACHE_TTL_MS = 30_000;
const AUTH_ERROR_RE = /\b(unauth|unauthorized|not logged in|login required|sign in|authenticate|credentials?|token expired|auth)\b/i;

const REASON_MESSAGES = Object.freeze({
  ready: {
    zh: (p) => (p.version ? `已就绪 (v${p.version})` : '已就绪'),
    en: (p) => (p.version ? `Ready (v${p.version})` : 'Ready'),
  },
  unauthenticated: {
    zh: (p) => `检测到 ${p.cli || 'CLI'}，但尚未登录账号`,
    en: (p) => `Detected ${p.cli || 'CLI'}, but it is not signed in yet`,
  },
  'not-installed': {
    zh: () => '未检测到本机安装',
    en: () => 'Not installed locally',
  },
  'coming-soon-not-installed': {
    zh: () => '尚未安装（按服务条款暂不支持复用消费者订阅登录）',
    en: () => 'Not installed (consumer subscription OAuth is not supported per ToS)',
  },
  'coming-soon-detected': {
    zh: (p) => (p.version
      ? `已检测到 v${p.version}（按服务条款暂不支持复用消费者订阅登录）`
      : '已检测到本机 CLI（按服务条款暂不支持复用消费者订阅登录）'),
    en: (p) => (p.version
      ? `Detected v${p.version} (consumer subscription OAuth is not supported per ToS)`
      : 'Detected locally (consumer subscription OAuth is not supported per ToS)'),
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
        reasonParams: { cli: 'agy CLI' },
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

async function probeSupportedCodex({ candidates, probeVersion, checkCodexAuth }) {
  let firstBroken = null;
  for (const candidate of candidates) {
    const ver = await probeVersion('codex', candidate);
    if (!ver.ok) {
      firstBroken ||= { candidate, reasonCode: ver.reasonCode || 'broken-shim', reasonParams: ver.reasonParams || {} };
      continue;
    }
    const auth = await checkCodexAuth(candidate);
    if (!auth?.authenticated) {
      return makeProbeResult({
        id: 'codex',
        supported: true,
        status: 'unauthenticated',
        executablePath: candidate,
        version: ver.version,
        reasonCode: 'unauthenticated',
        reasonParams: { cli: 'Codex CLI' },
      });
    }
    return makeProbeResult({
      id: 'codex',
      supported: true,
      status: 'ready',
      executablePath: candidate,
      version: ver.version,
      reasonCode: 'ready',
      reasonParams: ver.version ? { version: ver.version } : {},
    });
  }
  return firstBroken ? buildBrokenShim('codex', true, firstBroken) : buildNotInstalled('codex', true);
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

function readCustomPathFor(getCustomPath, id) {
  if (typeof getCustomPath !== 'function') return '';
  if (getCustomPath.length === 0) return id === 'agy' ? (getCustomPath() || '') : '';
  return getCustomPath(id) || '';
}

/**
 * Orchestrate local CLI provider discovery with TTL caching.
 * Depends only on injected ports (no direct fs or child_process imports).
 */
export function createProviderDiscovery({
  listCandidates,
  probeVersion,
  listAgyModels,
  checkCodexAuth = async () => ({ ok: false, authenticated: false, detail: '' }),
  getCustomPath = () => '',
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = () => Date.now(),
}) {
  let cached = null;
  let cachedAt = 0;
  let cachedCustomKey = '';

  async function scanOne(id, customPath) {
    const supported = SUPPORTED_CLI_PROVIDERS.includes(id);
    const candidates = await listCandidates(id, { customPath });
    if (!candidates.length) return buildNotInstalled(id, supported);
    if (id === 'agy') return probeSupportedAgy({ candidates, probeVersion, listAgyModels });
    if (id === 'codex') return probeSupportedCodex({ candidates, probeVersion, checkCodexAuth });
    return probeComingSoonProvider({ id, candidates, probeVersion });
  }

  async function scan({ force = false } = {}) {
    const paths = {
      agy: readCustomPathFor(getCustomPath, 'agy'),
      codex: readCustomPathFor(getCustomPath, 'codex'),
    };
    const customKey = `${paths.agy}\0${paths.codex}`;
    const cacheValid = !force
      && cached !== null
      && customKey === cachedCustomKey
      && now() - cachedAt < ttlMs;
    if (cacheValid) return cached;
    const providers = await Promise.all(ALL_CLI_PROVIDERS.map((id) => scanOne(id, paths[id] || '')));
    cached = providers;
    cachedAt = now();
    cachedCustomKey = customKey;
    return providers;
  }

  const findReadyPath = (id) => (cached || []).find((item) => item.id === id && item.status === 'ready')?.executablePath || '';

  return Object.freeze({
    scan,
    getCached: () => cached || [],
    findReadyPath,
    findReadyAgyPath: () => findReadyPath('agy'),
    findReadyCodexPath: () => findReadyPath('codex'),
  });
}
