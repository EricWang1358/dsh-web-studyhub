import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseDownloadPrefix } from './update-check.js';
import { updateDownloadDir } from './update-install.js';
import { compareVersions, parseVersion } from './semver.js';
import { EXTENSION } from './large-documents.js';

/* One-click install of the search extension (WP28b), the same way StudyHub updates itself (WP15):
   the companion bundle is a release asset of this StudyHub version (lib/update-install.js style).
   StudyHub downloads it from its exact GitHub release address, checks it against the release's
   SHA256SUMS file, keeps the verified file under <DSH home>/study/updates and hands that file to DSH's
   plugin manager (`ctx.pluginManager.installBundle`). pnpm then fetches the bundle's dependency (the
   search server) from the package registry. Build scripts pnpm holds back are listed to the learner,
   who must say yes before they are allowed. The manager is passed in, so this module stays
   host-independent; lib/host.js supplies it. */

export const EXTENSION_PACKAGE = EXTENSION.package;
export const extensionAssetName = version => `ericwang1358-studyhub-retrieval-${version}.tgz`;
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** The release addresses of this StudyHub version's extension. */
export function extensionRelease(version) {
  const parsed = parseVersion(version)?.text;
  if (!parsed) throw new Error('A valid StudyHub version is required');
  const base = `${releaseDownloadPrefix()}v${parsed}/`;
  return { name: extensionAssetName(parsed), assetUrl: `${base}${extensionAssetName(parsed)}`, sha256Url: `${base}SHA256SUMS-${parsed}.txt` };
}

/** Whether this DSH can install bundles while it runs, and what is installed: { canInstall, installed, enabled, version?, error?, desktop, outdated?, expected? }.
 *  `current` is this StudyHub's version: an extension older than it is `outdated` (it is installed once and StudyHub's own update never touches it). */
export async function extensionState(ctx, current) {
  const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
  const desktop = profile?.name === 'desktop';
  if (typeof manager?.installBundle !== 'function') return { canInstall: false, installed: false, enabled: false, desktop };
  let bundle;
  try { bundle = (await manager.listBundles?.())?.find(item => item.name === EXTENSION_PACKAGE); } catch { /* not knowing is not refusing */ }
  const behind = (() => { try { return !!bundle?.installed && !!bundle.version && !!current && compareVersions(bundle.version, current) < 0; } catch { return false; } })();
  return { canInstall: true, installed: !!bundle?.installed, enabled: !!bundle?.enabled, ...(bundle?.version ? { version: bundle.version } : {}),
    ...(bundle?.error?.code ? { error: bundle.error.code } : {}), desktop, ...(behind ? { outdated: true, expected: parseVersion(current).text } : {}) };
}

async function download(fetch, url, limit, what) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'StudyHub-extension' } }); }
  catch { throw failure('EXTENSION_DOWNLOAD', `无法从 GitHub 下载${what}（网络不可用）。检查网络后再试。`); }
  if (!response.ok) throw failure('EXTENSION_DOWNLOAD', `GitHub 下载${what}失败（HTTP ${response.status}）。这个版本可能还没有发布检索扩展，稍后再试。`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw failure('EXTENSION_DOWNLOAD', `下载的${what}文件过大，已停止。`);
  return bytes;
}

/** Download the extension and its checksum list; keep the file only when SHA-256 matches. */
async function prepareVerified({ version, fetch, dir }) {
  const release = extensionRelease(version);
  const sums = (await download(fetch, release.sha256Url, 1024 * 1024, '校验清单')).toString('utf8');
  const expected = sums.split(/\r?\n/).map(line => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())).find(match => match?.[2] === release.name)?.[1]?.toLowerCase();
  if (!expected) throw failure('EXTENSION_CHECKSUM', '发布页的校验清单里没有检索扩展，已停止安装。');
  const bytes = await download(fetch, release.assetUrl, MAX_BYTES, '检索扩展');
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw failure('EXTENSION_CHECKSUM', '下载的检索扩展没有通过 SHA-256 校验，已停止安装。');
  await mkdir(dir, { recursive: true });
  const path = join(dir, release.name), temporary = `${path}.${randomUUID()}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return path;
}

const REASONS = {
  network: '安装检索扩展需要联网下载组件，但网络不可用。检查网络后再试。',
  'no-matching-version': '找不到检索扩展需要的组件版本。稍后再试。',
  'disk-full': '磁盘空间不足，无法安装检索扩展。',
  permission: '没有权限写入 DSH 的插件目录，无法安装检索扩展。',
  'pnpm-missing': '找不到 DSH 用来安装插件的程序，无法一键安装。',
  'build-blocked': 'DSH 仍然拒绝运行组件的安装脚本，检索扩展没有装上。',
  timeout: '安装检索扩展超时了。检查网络后再试。',
  integrity: '下载的组件没有通过校验，检索扩展没有装上。请稍后再试。',
};

export const LOCKED_MESSAGE = 'DSH 的插件目录正被另一个操作占用：可能有别的插件正在安装或更新，或者上次安装中途被打断。等一两分钟再点「安装检索扩展」；还是不行的话，完全退出 DSH 再打开，然后重试。';

function installFailure(result) {
  const kind = result?.packageResult?.kind || result?.error?.code || result?.application || 'unknown';
  const message = result?.error?.code === 'incompatible-version' || result?.packageResult?.incompatible
    ? '这个检索扩展与当前 DSH 的版本不兼容，没有安装。' : REASONS[kind] ?? `DSH 没能安装检索扩展（${kind}）。`;
  return failure('EXTENSION_INSTALL', message, { kind });
}

/**
 * Install the extension of this StudyHub `version`.
 * Resolves { status: 'installed', restartRequired, application, version }, or
 * { status: 'needs-approval', pending: [package names] } when pnpm holds back build scripts and the
 * learner has not yet approved them (call again with approvedBuilds). Rejects with EXTENSION_NO_INSTALLER,
 * EXTENSION_DOWNLOAD, EXTENSION_CHECKSUM or EXTENSION_INSTALL, each in plain words.
 */
export async function installExtension({ manager, version, fetch = globalThis.fetch, dir = updateDownloadDir(), approvedBuilds }) {
  if (typeof manager?.installBundle !== 'function')
    throw failure('EXTENSION_NO_INSTALLER', '当前 DSH 不支持在应用内安装插件，所以不能一键安装检索扩展。可以在「设置 › 扩展」的「高级：手动配置」里手动连接检索工具。');
  const path = await prepareVerified({ version, fetch, dir });
  const approved = Array.isArray(approvedBuilds) ? approvedBuilds.filter(name => typeof name === 'string' && name) : [];
  let result;
  try { result = await manager.installBundle(path, { enabled: true, ...(approved.length ? { approvedBuilds: approved } : {}) }); }
  catch (error) {
    const detail = String(error?.message || error);
    // DSH serializes writes to its plugin list with a lock file; another install or update, or one that was interrupted, holds it.
    if (/writer lock|\.lock\b/i.test(detail))
      throw failure('EXTENSION_INSTALL', LOCKED_MESSAGE, { kind: 'locked' });
    throw failure('EXTENSION_INSTALL', `DSH 没能安装检索扩展（${detail.slice(0, 160)}）。`);
  }
  if (result?.pendingBuilds?.length && !approved.length) return { status: 'needs-approval', pending: [...result.pendingBuilds] };
  if (!['applied', 'restart-required'].includes(result?.application)) throw installFailure(result);
  return { status: 'installed', restartRequired: result.application === 'restart-required', application: result.application, version };
}

/** Remove the bundle through DSH's plugin manager. Its index and model stay in the DSH home. */
export async function uninstallExtension({ manager }) {
  if (typeof manager?.removeBundle !== 'function')
    throw failure('EXTENSION_NO_INSTALLER', '当前 DSH 不支持在应用内卸载插件。请在 DSH 的插件管理里移除「StudyHub 检索扩展」。');
  const result = await manager.removeBundle(EXTENSION_PACKAGE);
  if (result?.application === 'failed') throw failure('EXTENSION_INSTALL', 'DSH 没能卸载检索扩展。请在 DSH 的插件管理里移除它。');
  return { status: 'removed', application: result?.application };
}
