/* One-click upgrade (DSH 0.2). DSH's plugin manager service
   (`ctx.pluginManager`, @deepseek-ai/dsh-plugin-manager) installs a package spec
   into the running profile with the same pnpm path as its "Add plugin" dialog;
   re-installing an already installed package replaces its dependency and
   answers `application: "restart-required"`: the loaded plugin code changes only
   after DSH restarts, and DSH exposes no restart API to plugins.
   The plugin manager does not hand back the downloaded bytes, so StudyHub
   downloads the release package itself from its exact GitHub release address,
   checks it against the release's SHA256SUMS file, keeps the verified file under
   <DSH home>/study/updates and installs that file. The manager is passed in, so
   this module stays host-independent; lib/host.js supplies it. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { releaseDownloadPrefix, markUpdateInstalled } from './update-check.js';
import { parseVersion } from './semver.js';

export const MAX_PACKAGE_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [200, 600, 1500];
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const GUIDED = '请改用手动升级：复制安装地址，在 DSH 插件管理中卸载旧版后重新添加，再重启 DSH。';
export const updateDownloadDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'updates');

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isTimeoutError(error) {
  const name = String(error?.name || error?.cause?.name || '');
  const text = String(error?.message || error?.cause?.message || '');
  return name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i.test(text);
}

/** Whether this host can install plugin packages while it runs, and whether it is the desktop app. */
export function pluginInstallSupport(ctx) {
  const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
  return { available: typeof manager?.installBundle === 'function', desktop: profile?.name === 'desktop' };
}

function checkedRelease(view) {
  const name = view?.assetName, latest = parseVersion(view?.latest)?.text;
  const valid = view?.newer === true && view.upgradeAvailable !== false && latest && name === `ericwang1358-dsh-daily-flashcard-${latest}.tgz`
    && typeof view.assetUrl === 'string' && view.assetUrl.startsWith(releaseDownloadPrefix()) && view.assetUrl.endsWith(`/${name}`)
    && typeof view.sha256Url === 'string' && view.sha256Url.startsWith(releaseDownloadPrefix()) && view.sha256Url.endsWith(`/SHA256SUMS-${latest}.txt`)
    && !`${view.assetUrl}${view.sha256Url}`.includes('..');
  if (!valid) throw failure('UPDATE_UNAVAILABLE', `没有可一键安装的新版本。${GUIDED}`);
  return { name, latest };
}

/**
 * Download binary release bytes with bounded retries and HTTP Range continuation when a connection drops mid-stream.
 * Rejects with { detail: 'network' | 'timeout' | 'http' | 'corrupt-transport' | 'too-large', status?, partialBytes? }.
 */
export async function downloadReleaseBytes(fetch, url, limit, {
  userAgent = 'StudyHub-updater',
  attempts = DOWNLOAD_ATTEMPTS,
  timeoutMs = DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = defaultSleep,
  initialBytes = null,
} = {}) {
  let received = initialBytes?.length && initialBytes.length <= limit ? Buffer.from(initialBytes) : Buffer.alloc(0);
  let etag = null, last = { detail: 'network' };
  const totalAttempts = Math.max(1, attempts);
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0);
    const headers = {
      'User-Agent': userAgent,
      ...(received.length > 0 ? { Range: `bytes=${received.length}-`, ...(etag ? { 'If-Range': etag } : {}) } : {}),
    };
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    } catch (error) {
      last = { detail: isTimeoutError(error) ? 'timeout' : 'network' };
      continue;
    }
    if (response.status === 416 && received.length > 0) return received;
    if (!response.ok) {
      last = { detail: 'http', status: response.status };
      if (RETRYABLE_HTTP.has(response.status) && attempt + 1 < totalAttempts) continue;
      throw Object.assign(new Error(`HTTP ${response.status}`), { ...last, partialBytes: received });
    }
    // A package is binary: a helper that only decodes text would corrupt it.
    const stream = response.body && typeof response.body[Symbol.asyncIterator] === 'function' ? response.body : null;
    if (!stream && typeof response.arrayBuffer !== 'function') {
      throw Object.assign(new Error('response has no binary body'), { detail: 'corrupt-transport' });
    }
    let base = Buffer.alloc(0);
    if (response.status === 206 && received.length > 0) {
      const range = response.headers?.get?.('content-range');
      if (range && !range.startsWith(`bytes ${received.length}-`)) {
        received = Buffer.alloc(0);
        etag = null;
        await response.body?.cancel?.().catch(() => {});
        last = { detail: 'network' };
        if (attempt + 1 < totalAttempts) continue;
        throw Object.assign(new Error('unexpected Content-Range'), last);
      }
      base = received;
    } else {
      received = Buffer.alloc(0);
      const tag = response.headers?.get?.('etag');
      if (tag && !tag.startsWith('W/')) etag = tag;
    }
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    if (base.length + declared > limit) {
      await response.body?.cancel?.().catch(() => {});
      throw Object.assign(new Error('download exceeds limit'), { detail: 'too-large' });
    }
    const chunks = base.length > 0 ? [base] : [];
    let size = base.length;
    try {
      if (stream) {
        for await (const part of stream) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += chunk.length;
          if (size > limit) {
            await response.body?.cancel?.().catch(() => {});
            throw Object.assign(new Error('download exceeds limit'), { detail: 'too-large' });
          }
          chunks.push(chunk);
        }
      } else {
        const chunk = Buffer.from(await response.arrayBuffer());
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('download exceeds limit'), { detail: 'too-large' });
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (error?.detail === 'too-large') throw error;
      received = chunks.length > 0 ? Buffer.concat(chunks, size) : base;
      last = { detail: isTimeoutError(error) ? 'timeout' : 'network' };
    }
  }
  throw Object.assign(new Error('download failed'), { ...last, partialBytes: received });
}

async function download(fetch, url, limit, options = {}) {
  try {
    return await downloadReleaseBytes(fetch, url, limit, options);
  } catch (error) {
    if (error?.detail === 'http') {
      throw failure('UPDATE_DOWNLOAD', `GitHub 下载失败（HTTP ${error.status}）。${GUIDED}`,
        { detail: 'http', status: error.status, partialBytes: error.partialBytes });
    }
    if (error?.detail === 'corrupt-transport') throw failure('UPDATE_DOWNLOAD', `无法读取下载内容。${GUIDED}`);
    if (error?.detail === 'too-large') throw failure('UPDATE_DOWNLOAD', `下载的文件过大。${GUIDED}`);
    const detail = error?.detail === 'timeout' ? 'timeout' : 'network';
    const reason = detail === 'timeout' ? '下载超时' : '网络不可用';
    throw failure('UPDATE_DOWNLOAD', `无法从 GitHub 下载新版本（${reason}）。稍后再试，或${GUIDED.slice(1)}`,
      { detail, partialBytes: error?.partialBytes });
  }
}

async function writeAtomic(target, bytes) {
  await mkdir(join(target, '..'), { recursive: true });
  const temporary = `${target}.${randomUUID()}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

/** Download the package and its checksum list from the release; keep the file only when SHA-256 matches. */
export async function prepareVerifiedPackage({ view, fetch = globalThis.fetch, dir = updateDownloadDir(), sleep, attempts } = {}) {
  const { name } = checkedRelease(view);
  const netOptions = { ...(sleep ? { sleep } : {}), ...(attempts ? { attempts } : {}) };
  const sums = (await download(fetch, view.sha256Url, 1024 * 1024, netOptions)).toString('utf8');
  const expected = sums.split(/\r?\n/).map(line => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())).find(match => match?.[2] === name)?.[1]?.toLowerCase();
  if (!expected) throw failure('UPDATE_CHECKSUM', `发布页的校验清单里没有这个安装包，已停止升级。${GUIDED}`);
  const resumePath = join(dir, `${name}.${expected.slice(0, 12)}.part`);
  const saved = await readFile(resumePath).catch(() => null);
  const initialBytes = saved?.length > 0 && saved.length < MAX_PACKAGE_BYTES ? saved : null;
  let bytes;
  try {
    bytes = await download(fetch, view.assetUrl, MAX_PACKAGE_BYTES, { ...netOptions, initialBytes });
  } catch (error) {
    const partial = error?.partialBytes;
    delete error?.partialBytes;
    if (error?.code === 'UPDATE_DOWNLOAD' && partial?.length > 0) {
      await writeAtomic(resumePath, partial).catch(() => {});
      error.savedBytes = partial.length;
    }
    throw error;
  }
  let sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected && initialBytes) {
    await rm(resumePath, { force: true }).catch(() => {});
    bytes = await download(fetch, view.assetUrl, MAX_PACKAGE_BYTES, netOptions);
    sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  if (sha256 !== expected) {
    await rm(resumePath, { force: true }).catch(() => {});
    throw failure('UPDATE_CHECKSUM', `下载的安装包未通过 SHA-256 校验，已停止升级。${GUIDED}`);
  }
  const path = join(dir, name);
  await writeAtomic(path, bytes);
  if (initialBytes) await rm(resumePath, { force: true }).catch(() => {});
  return { path, sha256, bytes: bytes.length };
}

/** Older StudyHub packages (and the temporary files of interrupted downloads) are no longer referenced once a newer one is installed.
 *  Only those are removed: this folder also holds the search extension's installer, which DSH's profile still points at by path,
 *  and deleting it made every later plugin install fail with ENOENT. */
const STUDYHUB_PACKAGE = /^ericwang1358-dsh-daily-flashcard-.+\.tgz(?:\..+\.part)?$/;
async function pruneDownloads(dir, keep) {
  for (const name of await readdir(dir).catch(() => []))
    if (name !== keep && STUDYHUB_PACKAGE.test(name)) await rm(join(dir, name), { force: true }).catch(() => {});
}

/**
 * Install the release `view` describes through DSH's plugin manager.
 * With background jobs running, answers { status: 'jobs-running', jobs } and
 * touches nothing until called again with confirmJobs (then cancelJobs runs first).
 */
export async function installUpdate({ view, manager, fetch = globalThis.fetch, activeJobs = 0, confirmJobs = false, cancelJobs, desktop = false, dir = updateDownloadDir(), sleep, attempts }) {
  if (typeof manager?.installBundle !== 'function') throw failure('UPDATE_NO_INSTALLER', `当前 DSH 不支持在应用内安装插件。${GUIDED}`);
  const { name, latest } = checkedRelease(view);
  if (activeJobs > 0 && !confirmJobs) return { status: 'jobs-running', jobs: activeJobs };
  if (activeJobs > 0) await cancelJobs?.();
  const verified = await prepareVerifiedPackage({ view, fetch, dir, sleep, attempts });
  let result;
  try { result = await manager.installBundle(verified.path, { enabled: true }); }
  catch (error) { throw failure('UPDATE_INSTALL', `DSH 没能安装新版本（${String(error?.message || error).slice(0, 160)}）。${GUIDED}`); }
  if (!['applied', 'restart-required'].includes(result?.application)) {
    const kind = result?.packageResult?.kind || result?.error?.code || result?.application || 'unknown';
    throw failure('UPDATE_INSTALL', `DSH 没能安装新版本（${kind}）。${GUIDED}`, { kind, application: result?.application });
  }
  await markUpdateInstalled(latest);
  await pruneDownloads(dir, name);
  return { status: 'installed', version: latest, restartRequired: result.application === 'restart-required', application: result.application, desktop, sha256: verified.sha256 };
}
