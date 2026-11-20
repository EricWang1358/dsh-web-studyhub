// @ts-check

/** @typedef {'desktop' | 'dsh' | 'none'} RetrievalSource */

/**
 * @typedef {object} SemverParts
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {(number | string)[]} prerelease
 * @property {string} text
 */

/**
 * @typedef {object} RetrievalCandidateSummary
 * @property {boolean} valid
 * @property {'desktop' | 'dsh'} source
 * @property {string} [profile]
 * @property {string} [version]
 * @property {string} [dir]
 */

/**
 * @typedef {object} DesktopExtensionState
 * @property {boolean} canInstall
 * @property {boolean} installed
 * @property {boolean} enabled
 * @property {string} [version]
 * @property {true} desktop
 * @property {true} desktopHost
 * @property {RetrievalSource} source
 * @property {boolean} canUninstall
 * @property {boolean} canInstallStandalone
 * @property {boolean} [outdated]
 * @property {string} [expected]
 * @property {false} restartRequired
 * @property {string} [error]
 * @property {string} [errorDetail]
 */

export const RETRIEVAL_SERVER_NAME = 'studyhub';
export const RETRIEVAL_TOOL_PREFIX = `mcp__${RETRIEVAL_SERVER_NAME}__`;
export const RETRIEVAL_COMPANION_TOOL = `${RETRIEVAL_TOOL_PREFIX}query_documents`;
export const RETRIEVAL_COMPANION_PROVIDER_ID = `mcp:${RETRIEVAL_COMPANION_TOOL}`;
export const RETRIEVAL_WRITE_TOOLS = Object.freeze(['ingest_data', 'ingest_data_batch', 'delete_file']);

const SEMVER_NUMBER = '(0|[1-9]\\d*)';
const SEMVER_IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_RE = new RegExp(
  `^v?${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-(${SEMVER_IDENT}(?:\\.${SEMVER_IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);
const SHA256_LINE_RE = /^([0-9a-f]{64})\s+\*?(.+)$/i;

/** @type {Readonly<Record<string, { zh: string, en: string }>>} */
export const RETRIEVAL_ERROR_MESSAGES = Object.freeze({
  'extension-download': {
    zh: '无法下载检索扩展，请检查网络或稍后再试。',
    en: 'Could not download the search extension. Check your network and try again.',
  },
  'extension-checksum': {
    zh: '下载的检索扩展未通过 SHA-256 校验，已停止安装。',
    en: 'The downloaded search extension failed SHA-256 verification and was not installed.',
  },
  'extension-extract': {
    zh: '解压检索扩展失败，安装包可能已损坏。',
    en: 'Failed to extract the search extension archive; the package may be damaged.',
  },
  'extension-zip-unsafe': {
    zh: '检索扩展压缩包包含不安全的路径，已拒绝安装。',
    en: 'The search extension archive contains an unsafe path and was rejected.',
  },
  'extension-install': {
    zh: '安装检索扩展失败，请关闭占用后重试。',
    en: 'Failed to install the search extension. Close any conflicting process and try again.',
  },
  'extension-uninstall-refused': {
    zh: '只能卸载由 StudyHub 桌面版独立安装的检索扩展，不会改动本机 DSH 的目录。',
    en: 'Only the standalone StudyHub Desktop search extension can be uninstalled; local DSH files are never modified.',
  },
  'extension-unsupported-platform': {
    zh: '当前系统暂不支持桌面版一键下载检索扩展。',
    en: 'One-click download of the standalone search extension is not supported on this platform yet.',
  },
  'retrieval-index-locked': {
    zh: '检索索引正被另一个进程占用（例如 DSH 正在建立索引），请稍后再试。',
    en: 'The search index is currently locked by another process (for example DSH indexing). Please try again shortly.',
  },
  'retrieval-start-failed': {
    zh: '检索服务未能启动，可以尝试修复索引后重试。',
    en: 'The search service failed to start. Try repairing the index and retry.',
  },
  'retrieval-call-timeout': {
    zh: '检索服务响应超时，请稍后再试。',
    en: 'The search service timed out. Please try again.',
  },
  'retrieval-not-installed': {
    zh: '尚未安装检索扩展。',
    en: 'The search extension is not installed yet.',
  },
  'extension-busy': {
    zh: '另一个检索扩展安装或卸载操作正在进行中，请等待完成后重试。',
    en: 'Another search extension install or uninstall is already in progress. Please wait for it to finish and try again.',
  },
});

/**
 * Parse a semantic version string (with optional leading `v`).
 * @param {unknown} value
 * @returns {SemverParts | null}
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  const text = `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}`;
  return { major, minor, patch, prerelease, text };
}

/**
 * @param {number | string} x
 * @param {number | string} y
 * @returns {-1 | 0 | 1}
 */
function comparePrereleaseItem(x, y) {
  if (x === y) return 0;
  const xNum = typeof x === 'number';
  const yNum = typeof y === 'number';
  if (xNum && yNum) return x > y ? 1 : -1;
  if (xNum) return -1;
  if (yNum) return 1;
  return x > y ? 1 : -1;
}

/**
 * @param {(number | string)[]} a
 * @param {(number | string)[]} b
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = comparePrereleaseItem(a[i], b[i]);
    if (diff !== 0) return diff;
  }
  return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
}

/**
 * Compare two semantic version strings. Returns -1, 0, or 1.
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Not a semantic version: ${!a ? left : right}`);
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Check whether an installed retrieval version is older than the required `since` floor.
 * @param {string | undefined | null} installedVersion
 * @param {string | undefined | null} currentVersion
 * @param {string | undefined | null} sinceVersion
 * @returns {boolean}
 */
export function isVersionOutdated(installedVersion, currentVersion, sinceVersion) {
  const installed = parseSemver(installedVersion);
  const current = parseSemver(currentVersion);
  if (!installed || !current) return false;
  const since = parseSemver(sinceVersion);
  const floor = since && compareSemver(since.text, current.text) <= 0 ? since.text : current.text;
  return compareSemver(installed.text, floor) < 0;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function retrievalAssetName(version) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error('A valid StudyHub version is required');
  return `StudyHub-Desktop-Retrieval-${parsed.text}-win-x64.zip`;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function retrievalChecksumsName(version) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error('A valid StudyHub version is required');
  return `SHA256SUMS-Desktop-Retrieval-${parsed.text}.txt`;
}

/**
 * Build the release asset and SHA-256 checksum URLs for StudyHub Desktop Retrieval.
 * @param {string} version
 * @param {string} prefix
 * @returns {{ version: string, name: string, checksumsName: string, assetUrl: string, sha256Url: string }}
 */
export function retrievalReleaseUrls(version, prefix) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error('A valid StudyHub version is required');
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  if (!trimmed) throw new Error('A release download prefix is required');
  const normalizedPrefix = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  const name = retrievalAssetName(parsed.text);
  const checksumsName = retrievalChecksumsName(parsed.text);
  const base = `${normalizedPrefix}v${parsed.text}/`;
  return {
    version: parsed.text,
    name,
    checksumsName,
    assetUrl: `${base}${name}`,
    sha256Url: `${base}${checksumsName}`,
  };
}

/**
 * Extract the expected lowercase SHA-256 digest for `expectedName` from a SHA256SUMS file.
 * @param {string} text
 * @param {string} expectedName
 * @returns {string | null}
 */
export function parseSha256SumsLine(text, expectedName) {
  if (typeof text !== 'string' || !expectedName) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const match = SHA256_LINE_RE.exec(rawLine.trim());
    if (match && match[2] === expectedName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Validate a ZIP entry path against Zip-Slip traversal, drive letters, and absolute paths.
 * @param {unknown} rawName
 * @returns {{ ok: true, normalized: string, isDir: boolean } | { ok: false, reason: string }}
 */
export function validateZipEntryPath(rawName) {
  if (typeof rawName !== 'string' || !rawName) return { ok: false, reason: 'empty-entry' };
  if (rawName.includes('\0')) return { ok: false, reason: 'nul-byte' };
  if (rawName.includes(':')) return { ok: false, reason: 'drive-or-ads' };
  const unified = rawName.replaceAll('\\', '/');
  if (unified.startsWith('/')) return { ok: false, reason: 'absolute-path' };
  const isDir = unified.endsWith('/');
  const trimmed = isDir ? unified.slice(0, -1) : unified;
  if (!trimmed) return { ok: false, reason: 'empty-path' };
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return { ok: false, reason: 'traversal-segment' };
    }
  }
  return { ok: true, normalized: segments.join('/'), isDir };
}

/**
 * Select the preferred retrieval installation candidate: desktop (B) > dsh (D) > null.
 * @template {RetrievalCandidateSummary} T
 * @param {readonly T[]} candidates
 * @returns {T | null}
 */
export function selectRetrievalCandidate(candidates) {
  if (!Array.isArray(candidates)) return null;
  const valid = candidates.filter((item) => item && item.valid === true);
  const desktop = valid.find((item) => item.source === 'desktop');
  if (desktop) return desktop;
  const dsh = valid.find((item) => item.source === 'dsh');
  return dsh || null;
}

/**
 * @param {RetrievalCandidateSummary | null | undefined} candidate
 * @returns {RetrievalSource}
 */
function sourceOfCandidate(candidate) {
  if (!candidate || candidate.valid !== true) return 'none';
  if (candidate.source === 'desktop' || candidate.source === 'dsh') return candidate.source;
  return 'none';
}

/**
 * @param {boolean} installed
 * @param {RetrievalCandidateSummary | null | undefined} candidate
 * @returns {string | undefined}
 */
function versionOfCandidate(installed, candidate) {
  if (!installed) return undefined;
  return typeof candidate?.version === 'string' ? candidate.version : undefined;
}

/**
 * @param {boolean} outdated
 * @param {string} currentVersion
 * @returns {string | undefined}
 */
function expectedVersionOf(outdated, currentVersion) {
  if (!outdated) return undefined;
  return parseSemver(currentVersion)?.text || currentVersion;
}

/**
 * Build the `extension` field for `retrieval.status` on StudyHub Desktop.
 * @param {object} input
 * @param {RetrievalCandidateSummary | null | undefined} input.candidate
 * @param {string} input.currentVersion
 * @param {string} [input.sinceVersion]
 * @param {boolean} [input.canInstall]
 * @param {string | null} [input.error]
 * @param {string | null} [input.errorDetail]
 * @returns {DesktopExtensionState}
 */
export function buildDesktopExtensionState({
  candidate,
  currentVersion,
  sinceVersion,
  canInstall = true,
  error = null,
  errorDetail = null,
}) {
  const source = sourceOfCandidate(candidate);
  const installed = source !== 'none';
  const version = versionOfCandidate(installed, candidate);
  const outdated = installed && isVersionOutdated(version, currentVersion, sinceVersion);
  const expected = expectedVersionOf(outdated, currentVersion);
  const allowInstall = Boolean(canInstall);
  const cleanDetail = typeof errorDetail === 'string' ? errorDetail.trim().slice(0, 300) : '';

  /** @type {DesktopExtensionState} */
  const result = {
    canInstall: allowInstall,
    installed,
    enabled: installed,
    desktop: true,
    desktopHost: true,
    source,
    canUninstall: source === 'desktop',
    canInstallStandalone: allowInstall && (source !== 'desktop' || outdated),
    restartRequired: false,
  };
  if (version) result.version = version;
  if (outdated) {
    result.outdated = true;
    result.expected = expected;
  }
  if (error) result.error = error;
  if (cleanDetail) result.errorDetail = cleanDetail;
  return result;
}

/**
 * @param {Record<string, any> | null | undefined} value
 * @returns {Record<string, any>}
 */
function cloneRecord(value) {
  return value && typeof value === 'object' ? { ...value } : {};
}

/**
 * @param {Record<string, any>} companion
 * @returns {string}
 */
function companionIdOf(companion) {
  return typeof companion.id === 'string' && companion.id
    ? companion.id
    : RETRIEVAL_COMPANION_PROVIDER_ID;
}

/**
 * @param {Record<string, any>} base
 * @param {string} companionId
 */
function clearMissingCompanion(base, companionId) {
  if (base.missing !== companionId) return;
  delete base.missing;
  if (base.selected === companionId) base.selected = 'builtin';
  if (base.effective === companionId) base.effective = 'builtin';
}

/**
 * On Desktop, `retrieval.index.repair` already restarted the retrieval child synchronously,
 * so a still-stopped service with `pendingRestart` means repair + restart already failed.
 * @param {Record<string, any>} companion
 */
function normalizeDesktopReset(companion) {
  if (!companion.reset || typeof companion.reset !== 'object') return;
  if (!companion.reset.pendingRestart) return;
  const reset = { ...companion.reset, restartedAfterRepair: true };
  delete reset.pendingRestart;
  companion.reset = reset;
}

/**
 * Attach desktop extension metadata and suppress DSH-leftover `missing` warnings without mutating settings.
 * @param {Record<string, any> | null | undefined} status
 * @param {DesktopExtensionState} extension
 * @param {{ notStarted?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function sanitizeDesktopRetrievalStatus(status, extension, { notStarted = false } = {}) {
  const base = cloneRecord(status);
  const companion = cloneRecord(base.companion);
  const companionId = companionIdOf(companion);
  const running = companion.running === true;

  delete companion.notStarted;
  if (!extension.installed) {
    clearMissingCompanion(base, companionId);
  } else if (!running) {
    if (base.missing === companionId) delete base.missing;
    if (notStarted) companion.notStarted = true;
    normalizeDesktopReset(companion);
  }

  return {
    ...base,
    companion: { ...companion, id: companionId, running },
    extension,
  };
}

/**
 * Format a retrieval error message in Chinese or English.
 * @param {string} code
 * @param {'zh' | 'en'} [language]
 * @param {string} [detail]
 * @returns {string}
 */
export function formatRetrievalError(code, language = 'zh', detail = '') {
  const lang = language === 'en' ? 'en' : 'zh';
  const entry = Object.hasOwn(RETRIEVAL_ERROR_MESSAGES, code)
    ? RETRIEVAL_ERROR_MESSAGES[code]
    : RETRIEVAL_ERROR_MESSAGES['extension-install'];
  const suffix = typeof detail === 'string' && detail.trim() ? ` (${detail.trim().slice(0, 160)})` : '';
  return `${entry[lang]}${suffix}`;
}
