import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFetch } from '../../../../lib/http.js';
import { releaseDownloadPrefix } from '../../../../lib/update-check.js';
import { downloadReleaseBytes } from '../../../../lib/update-install.js';
import {
  formatRetrievalError,
  parseSha256SumsLine,
  retrievalReleaseUrls,
} from '../../domain/retrieval-policy.js';
import {
  resolveDesktopRetrievalDir,
  resolveDshHome,
  validateRetrievalDir,
} from './discovery.mjs';
import { extractZipArchive } from './zip-extract.mjs';

export const MAX_RETRIEVAL_ZIP_BYTES = 450 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const SWAP_RETRIES = 6;

function installerError(code, detail = '') {
  return Object.assign(new Error(formatRetrievalError(code, 'zh', detail)), { code });
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeForCompare(pathValue, platform) {
  const abs = resolve(pathValue);
  return platform === 'win32' ? abs.toLowerCase() : abs;
}

function isInsideDir(childPath, parentPath, platform) {
  const rel = relative(normalizeForCompare(parentPath, platform), normalizeForCompare(childPath, platform));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function renameWithRetry(fromPath, toPath) {
  let lastError = null;
  for (let attempt = 0; attempt < SWAP_RETRIES; attempt += 1) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code) || attempt + 1 >= SWAP_RETRIES) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

function downloadDetailOf(error) {
  if (error?.detail === 'http') return `HTTP ${error.status}`;
  if (error?.detail === 'timeout') return 'timeout';
  if (error?.detail === 'too-large') return 'file too large';
  return 'network';
}

async function fetchLocalFile(url, limit) {
  try {
    const bytes = await readFile(fileURLToPath(url));
    if (bytes.length > limit) {
      throw installerError('extension-download', 'download exceeds limit');
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'extension-download') throw error;
    throw installerError('extension-download', error?.message || 'local asset read failed');
  }
}

async function fetchBytes({ url, limit, httpFetch, attempts, sleep, timeoutMs }) {
  if (url.startsWith('file://')) return fetchLocalFile(url, limit);
  try {
    return await downloadReleaseBytes(httpFetch, url, limit, {
      userAgent: 'StudyHub-desktop-retrieval',
      timeoutMs,
      ...(attempts ? { attempts } : {}),
      ...(sleep ? { sleep } : {}),
    });
  } catch (error) {
    throw installerError('extension-download', downloadDetailOf(error));
  }
}

async function swapDirectoryAtomic(stageDir, targetDir) {
  const parentDir = dirname(targetDir);
  const backupDir = join(parentDir, `.retrieval-backup-${randomUUID()}`);
  const hadExisting = await exists(targetDir);

  if (hadExisting) {
    await renameWithRetry(targetDir, backupDir);
  }
  try {
    await renameWithRetry(stageDir, targetDir);
  } catch (error) {
    if (hadExisting) {
      await renameWithRetry(backupDir, targetDir).catch(() => {});
    }
    throw installerError('extension-install', error?.message || 'atomic swap failed');
  }
  if (hadExisting) {
    await rm(backupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

function resolvePrefix(env, explicitPrefix) {
  if (typeof explicitPrefix === 'string' && explicitPrefix.trim()) return explicitPrefix.trim();
  const envPrefix = typeof env.STUDYHUB_DESKTOP_RETRIEVAL_DOWNLOAD_PREFIX === 'string'
    ? env.STUDYHUB_DESKTOP_RETRIEVAL_DOWNLOAD_PREFIX.trim()
    : '';
  return envPrefix || releaseDownloadPrefix();
}

async function downloadVerifiedBundle({ release, netOptions, maxZipBytes }) {
  const sumsBytes = await fetchBytes({ url: release.sha256Url, limit: MAX_CHECKSUMS_BYTES, ...netOptions });
  const expectedSha = parseSha256SumsLine(sumsBytes.toString('utf8'), release.name);
  if (!expectedSha) {
    throw installerError('extension-checksum', `missing ${release.name}`);
  }
  const zipBytes = await fetchBytes({ url: release.assetUrl, limit: maxZipBytes, ...netOptions });
  const actualSha = createHash('sha256').update(zipBytes).digest('hex');
  if (actualSha !== expectedSha) {
    throw installerError('extension-checksum', 'sha256 mismatch');
  }
  return { zipBytes, sha256: actualSha };
}

async function stageValidateAndSwap({ zipBytes, targetDir, validateDir, beforeSwap }) {
  const parentDir = dirname(targetDir);
  await mkdir(parentDir, { recursive: true });
  const stageDir = join(parentDir, `.retrieval-stage-${randomUUID()}`);
  try {
    await extractZipArchive(zipBytes, stageDir);
    const checked = await validateDir(stageDir, { source: 'desktop', profile: 'desktop' });
    if (!checked.valid) {
      throw installerError('extension-install', checked.reason || 'invalid bundle');
    }
    if (typeof beforeSwap === 'function') {
      await beforeSwap();
    }
    await swapDirectoryAtomic(stageDir, targetDir);
    return checked;
  } finally {
    await rm(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

/**
 * Create the standalone Desktop Retrieval (B) installer & uninstaller.
 */
export function createRetrievalInstaller({
  env = process.env,
  platform = process.platform,
  home,
  desktopDir = resolveDesktopRetrievalDir({ env, platform, home }),
  dshHome = resolveDshHome({ env, home }),
  httpFetch = hostFetch,
  downloadPrefix = '',
  attempts,
  sleep,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  maxZipBytes = MAX_RETRIEVAL_ZIP_BYTES,
  validateDir = validateRetrievalDir,
} = {}) {
  const targetDir = resolve(desktopDir);
  const dshProfilesDir = resolve(dshHome, 'profiles');

  function assertSafeManagedTarget(candidatePath = targetDir) {
    const requested = normalizeForCompare(candidatePath, platform);
    const managed = normalizeForCompare(targetDir, platform);
    if (requested !== managed || isInsideDir(targetDir, dshProfilesDir, platform)) {
      throw installerError('extension-uninstall-refused');
    }
  }

  async function install({ version, beforeSwap } = {}) {
    assertSafeManagedTarget(targetDir);
    const release = retrievalReleaseUrls(version, resolvePrefix(env, downloadPrefix));
    const { zipBytes, sha256 } = await downloadVerifiedBundle({
      release,
      netOptions: { httpFetch, attempts, sleep, timeoutMs },
      maxZipBytes,
    });
    const checked = await stageValidateAndSwap({ zipBytes, targetDir, validateDir, beforeSwap });
    return { version: checked.version, dir: targetDir, sha256, bytes: zipBytes.length };
  }

  async function uninstall({ targetPath = targetDir } = {}) {
    assertSafeManagedTarget(targetPath);
    await rm(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { removed: true, dir: targetDir };
  }

  return Object.freeze({ targetDir, install, uninstall });
}
