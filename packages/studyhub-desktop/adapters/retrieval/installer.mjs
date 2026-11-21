import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { hostFetch } from '../../../../lib/http.js';
import { releaseDownloadPrefix } from '../../../../lib/update-check.js';
import { downloadReleaseBytes } from '../../../../lib/update-install.js';
import { formatRetrievalError, parseSha256SumsLine, retrievalReleaseUrls } from '../../domain/retrieval-policy.js';
import { resolveDesktopRetrievalDir, resolveDshHome, validateRetrievalDir } from './discovery.mjs';
import { extractZipArchive } from './zip-extract.mjs';

export const MAX_RETRIEVAL_ZIP_BYTES = 450 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [200, 600, 1500];
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const SWAP_RETRIES = 6;
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

function installerError(code, detail = '') {
  return Object.assign(new Error(formatRetrievalError(code, 'zh', detail)), { code });
}

const exists = (targetPath) => access(targetPath).then(() => true, () => false);

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
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code) || attempt + 1 >= SWAP_RETRIES) throw error;
      await defaultSleep(100 * (attempt + 1));
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

function isTimeoutError(error) {
  if (!error) return false;
  const cause = error.cause;
  const names = [error.name, cause?.name];
  if (names.includes('TimeoutError') || names.includes('AbortError')) return true;
  const msg = String(error.message || '') + ' ' + String(cause?.message || '');
  return /timeout|timed out|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i.test(msg);
}

async function fetchLocalBytes(url, limit) {
  try {
    const bytes = await readFile(fileURLToPath(url));
    if (bytes.length > limit) throw installerError('extension-download', 'download exceeds limit');
    return bytes;
  } catch (error) {
    if (error?.code === 'extension-download') throw error;
    throw installerError('extension-download', error?.message || 'local asset read failed');
  }
}

async function fetchSmallBytes({ url, limit, httpFetch, attempts, sleep, timeoutMs }) {
  if (url.startsWith('file://')) return fetchLocalBytes(url, limit);
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

async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function copyLocalZipToFile(url, destPath, limit) {
  try {
    const srcPath = fileURLToPath(url);
    const info = await stat(srcPath);
    if (info.size > limit) throw installerError('extension-download', 'file too large');
    await pipeline(createReadStream(srcPath), createWriteStream(destPath));
    return info.size;
  } catch (error) {
    if (error?.code === 'extension-download') throw error;
    throw installerError('extension-download', error?.message || 'local asset read failed');
  }
}

async function writeStreamToHandle(response, handle, state, limit) {
  const bodyStream = response.body?.[Symbol.asyncIterator] ? response.body : null;
  if (!bodyStream) {
    if (typeof response.arrayBuffer !== 'function') throw installerError('extension-download', 'network');
    const chunk = Buffer.from(await response.arrayBuffer());
    if (state.size + chunk.length > limit) throw installerError('extension-download', 'file too large');
    await handle.write(chunk, 0, chunk.length, state.size);
    state.size += chunk.length;
    return;
  }
  for await (const part of bodyStream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if (state.size + chunk.length > limit) {
      await response.body?.cancel?.().catch(() => {});
      throw installerError('extension-download', 'file too large');
    }
    await handle.write(chunk, 0, chunk.length, state.size);
    state.size += chunk.length;
  }
}

function headerOf(response, name) {
  return typeof response?.headers?.get === 'function' ? response.headers.get(name) : null;
}

function strongEtagOf(response) {
  const tag = headerOf(response, 'etag');
  return tag && !tag.startsWith('W/') ? tag : null;
}

function cancelBody(response) {
  const body = response?.body;
  return typeof body?.cancel === 'function' ? body.cancel().catch(() => {}) : Promise.resolve();
}

async function prepareResponseStream(response, state, limit) {
  const resumed = response.status === 206 && state.size > 0;
  if (resumed) {
    const range = headerOf(response, 'content-range');
    if (range && !range.startsWith(`bytes ${state.size}-`)) {
      state.size = 0;
      state.etag = null;
      await cancelBody(response);
      return { retry: true, resumed: false };
    }
  } else {
    state.size = 0;
    state.etag = strongEtagOf(response);
  }
  const declared = Number(headerOf(response, 'content-length')) || 0;
  if (state.size + declared > limit) {
    await cancelBody(response);
    throw installerError('extension-download', 'file too large');
  }
  return { retry: false, resumed };
}

async function streamAttemptToFile({ url, destPath, limit, httpFetch, timeoutMs, state }) {
  const headers = { 'User-Agent': 'StudyHub-desktop-retrieval' };
  if (state.size > 0) {
    headers.Range = `bytes=${state.size}-`;
    if (state.etag) headers['If-Range'] = state.etag;
  }
  const response = await httpFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  if (response.status === 416 && state.size > 0) return { done: true };
  if (!response.ok) return { done: false, retryable: RETRYABLE_HTTP.has(response.status), detail: `HTTP ${response.status}` };
  const prep = await prepareResponseStream(response, state, limit);
  if (prep.retry) return { done: false, retryable: true, detail: 'network' };

  const handle = await open(destPath, prep.resumed ? 'r+' : 'w');
  try {
    await writeStreamToHandle(response, handle, state, limit);
  } finally {
    await handle.close().catch(() => {});
  }
  return { done: true };
}

async function runSingleDownloadAttempt(ctx) {
  try {
    const outcome = await streamAttemptToFile(ctx);
    if (outcome.done || outcome.retryable) return outcome;
    throw installerError('extension-download', outcome.detail);
  } catch (error) {
    if (error?.code === 'extension-download') throw error;
    return { done: false, retryable: true, detail: isTimeoutError(error) ? 'timeout' : 'network' };
  }
}

async function downloadAssetToFile({ url, destPath, limit, httpFetch, attempts, sleep, timeoutMs }) {
  if (url.startsWith('file://')) return copyLocalZipToFile(url, destPath, limit);
  const totalAttempts = Math.max(1, attempts || DOWNLOAD_ATTEMPTS);
  const pause = sleep || defaultSleep;
  const state = { size: 0, etag: null };
  let lastDetail = 'network';

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    if (attempt > 0) await pause(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1));
    const outcome = await runSingleDownloadAttempt({ url, destPath, limit, httpFetch, timeoutMs, state });
    if (outcome.done) return state.size;
    lastDetail = outcome.detail;
  }
  throw installerError('extension-download', lastDetail);
}

async function swapDirectoryAtomic(stageDir, targetDir) {
  const parentDir = dirname(targetDir);
  const backupDir = join(parentDir, `.retrieval-backup-${randomUUID()}`);
  const hadExisting = await exists(targetDir);

  if (hadExisting) await renameWithRetry(targetDir, backupDir);
  try {
    await renameWithRetry(stageDir, targetDir);
  } catch (error) {
    if (hadExisting) await renameWithRetry(backupDir, targetDir).catch(() => {});
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

async function downloadVerifiedBundleToFile({ release, netOptions, maxZipBytes, tempDir }) {
  const sumsBytes = await fetchSmallBytes({ url: release.sha256Url, limit: MAX_CHECKSUMS_BYTES, ...netOptions });
  const expectedSha = parseSha256SumsLine(sumsBytes.toString('utf8'), release.name);
  if (!expectedSha) throw installerError('extension-checksum', `missing ${release.name}`);

  await mkdir(tempDir, { recursive: true });
  const zipPath = join(tempDir, `studyhub-retrieval-${randomUUID()}.zip`);
  try {
    const bytes = await downloadAssetToFile({ url: release.assetUrl, destPath: zipPath, limit: maxZipBytes, ...netOptions });
    const actualSha = await hashFileSha256(zipPath);
    if (actualSha !== expectedSha) throw installerError('extension-checksum', 'sha256 mismatch');
    return { zipPath, sha256: actualSha, bytes };
  } catch (error) {
    await rm(zipPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function stageValidateAndSwap({ zipPath, targetDir, validateDir, beforeSwap, platform }) {
  const parentDir = dirname(targetDir);
  await mkdir(parentDir, { recursive: true });
  const stageDir = join(parentDir, `.retrieval-stage-${randomUUID()}`);
  try {
    await extractZipArchive(zipPath, stageDir, { platform });
    const checked = await validateDir(stageDir, { source: 'desktop', profile: 'desktop' });
    if (!checked.valid) throw installerError('extension-install', checked.reason || 'invalid bundle');
    if (typeof beforeSwap === 'function') await beforeSwap();
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
  tempDir = tmpdir(),
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
    const { zipPath, sha256, bytes } = await downloadVerifiedBundleToFile({
      release,
      netOptions: { httpFetch, attempts, sleep, timeoutMs },
      maxZipBytes,
      tempDir,
    });
    try {
      const checked = await stageValidateAndSwap({ zipPath, targetDir, validateDir, beforeSwap, platform });
      return { version: checked.version, dir: targetDir, sha256, bytes };
    } finally {
      await rm(zipPath, { force: true }).catch(() => {});
    }
  }

  async function uninstall({ targetPath = targetDir } = {}) {
    assertSafeManagedTarget(targetPath);
    await rm(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { removed: true, dir: targetDir };
  }

  return Object.freeze({ targetDir, install, uninstall });
}
