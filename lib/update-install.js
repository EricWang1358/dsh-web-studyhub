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
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_DOWNLOAD_PREFIX, markUpdateInstalled } from './update-check.js';
import { parseVersion } from './semver.js';

export const MAX_PACKAGE_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const GUIDED = '请改用手动升级：复制安装地址，在 DSH 插件管理中卸载旧版后重新添加，再重启 DSH。';
export const updateDownloadDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'updates');

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Whether this host can install plugin packages while it runs, and whether it is the desktop app. */
export function pluginInstallSupport(ctx) {
  const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
  return { available: typeof manager?.installBundle === 'function', desktop: profile?.name === 'desktop' };
}

function checkedRelease(view) {
  const name = view?.assetName, latest = parseVersion(view?.latest)?.text;
  const valid = view?.newer === true && latest && name === `ericwang1358-dsh-daily-flashcard-${latest}.tgz`
    && typeof view.assetUrl === 'string' && view.assetUrl.startsWith(RELEASE_DOWNLOAD_PREFIX) && view.assetUrl.endsWith(`/${name}`)
    && typeof view.sha256Url === 'string' && view.sha256Url.startsWith(RELEASE_DOWNLOAD_PREFIX) && view.sha256Url.endsWith(`/SHA256SUMS-${latest}.txt`)
    && !`${view.assetUrl}${view.sha256Url}`.includes('..');
  if (!valid) throw failure('UPDATE_UNAVAILABLE', `没有可一键安装的新版本。${GUIDED}`);
  return { name, latest };
}

async function download(fetch, url, limit) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'User-Agent': 'StudyHub-updater' } }); }
  catch { throw failure('UPDATE_DOWNLOAD', `无法从 GitHub 下载新版本（网络不可用）。稍后再试，或${GUIDED.slice(1)}`); }
  if (!response.ok) throw failure('UPDATE_DOWNLOAD', `GitHub 下载失败（HTTP ${response.status}）。${GUIDED}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw failure('UPDATE_DOWNLOAD', `下载的文件过大。${GUIDED}`);
  return bytes;
}

/** Download the package and its checksum list from the release; keep the file only when SHA-256 matches. */
export async function prepareVerifiedPackage({ view, fetch = globalThis.fetch, dir = updateDownloadDir() }) {
  const { name } = checkedRelease(view);
  const sums = (await download(fetch, view.sha256Url, 1024 * 1024)).toString('utf8');
  const expected = sums.split(/\r?\n/).map(line => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())).find(match => match?.[2] === name)?.[1]?.toLowerCase();
  if (!expected) throw failure('UPDATE_CHECKSUM', `发布页的校验清单里没有这个安装包，已停止升级。${GUIDED}`);
  const bytes = await download(fetch, view.assetUrl, MAX_PACKAGE_BYTES);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) throw failure('UPDATE_CHECKSUM', `下载的安装包未通过 SHA-256 校验，已停止升级。${GUIDED}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name), temporary = `${path}.${randomUUID()}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return { path, sha256, bytes: bytes.length };
}

/** Older verified packages are no longer referenced once a newer one is installed. */
async function pruneDownloads(dir, keep) {
  for (const name of await readdir(dir).catch(() => []))
    if (name !== keep) await rm(join(dir, name), { force: true }).catch(() => {});
}

/**
 * Install the release `view` describes through DSH's plugin manager.
 * With background jobs running, answers { status: 'jobs-running', jobs } and
 * touches nothing until called again with confirmJobs (then cancelJobs runs first).
 */
export async function installUpdate({ view, manager, fetch = globalThis.fetch, activeJobs = 0, confirmJobs = false, cancelJobs, desktop = false, dir = updateDownloadDir() }) {
  if (typeof manager?.installBundle !== 'function') throw failure('UPDATE_NO_INSTALLER', `当前 DSH 不支持在应用内安装插件。${GUIDED}`);
  const { name, latest } = checkedRelease(view);
  if (activeJobs > 0 && !confirmJobs) return { status: 'jobs-running', jobs: activeJobs };
  if (activeJobs > 0) await cancelJobs?.();
  const verified = await prepareVerifiedPackage({ view, fetch, dir });
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
