/* The pure side of the one-click MinerU card (ui/MineruInstallCard.jsx): which of six states the card shows, the one wording of each state, the one fix
   button of each failure, and the six steps of an install. No React, so it runs in tests. The stage names are the backend's own
   (lib/mineru-install-text.js), translated through the catalogue like every other sentence. */

import { ui, uiFormat, uiMessage } from './i18n.js';
import { MINERU_STAGE_NAMES } from '../lib/mineru-install-text.js';
import { sizeLabel } from './mineru-flow.js';

export const STAGES = Object.freeze(['tools', 'python', 'package', 'models', 'enable', 'check']);
export const stageName = id => (MINERU_STAGE_NAMES[id] ? ui(MINERU_STAGE_NAMES[id]) : '');

const INSTALL_ENDED = ['failed', 'cancelled', 'interrupted'];
/** An install the learner stopped (取消) or that StudyHub's restart stopped: a pause, not a failure. */
const INSTALL_PAUSED = ['cancelled', 'interrupted'];
const ourInstall = local => local?.origin === 'installed';

/**
 * The card's state from mineru.local.status (null while it is read): checking, not-installed, installing, paused (with `code` cancelled or
 * interrupted), stopped, ready or error (with the failure's `code`). Checked in this order, so a failed read never looks like loading forever and an unreadable service is never "running".
 */
export function cardState(local) {
  if (local == null) return { state: 'checking' };
  if (local.state === 'unavailable') return { state: 'error', code: 'unreadable' };
  const install = local.install || {};
  if (install.status === 'running' || local.state === 'installing') return { state: 'installing' };
  if (INSTALL_PAUSED.includes(install.status) && local.state !== 'ready') return { state: 'paused', code: install.status, origin: 'install' };
  if (install.status === 'failed' && local.state !== 'ready') return { state: 'error', code: install.error?.code || install.status, origin: 'install' };
  if (local.state === 'ready') return { state: 'ready' };
  // A start that failed leaves the service stopped: the failure is what the learner needs to see, with its fix.
  if (local.state === 'server-stopped') return local.lastError ? { state: 'error', code: local.lastError.code, origin: 'service' } : { state: 'stopped' };
  if (local.lastError) return { state: 'error', code: local.lastError.code, origin: 'service' };
  if (local.state === 'unknown') return { state: 'error', code: 'unreadable', origin: 'check' };
  if (local.state === 'needs-models') return ourInstall(local) ? { state: 'error', code: 'needs-models', origin: 'check' } : { state: 'not-installed' };
  return { state: 'not-installed' };
}

/** Is MinerU usable for a conversion now (ready, or stopped after it worked: the run starts the service)? */
export function mineruUsable(local) {
  if (local?.state === 'ready') return true;
  if (local?.state !== 'server-stopped') return false;
  return (ourInstall(local) && !!(local.install?.installedTier || local.install?.tier)) || local.origin === 'env' || local.origin === 'search';
}

const TIER_TIP = {
  basic: () => ui('basic 档：只用 CPU，适合以文字、公式、表格为主的书。在「更多」里可以换档。'),
  standard: () => ui('standard 档：版面理解更好，更慢，建议 16 GB 内存。在「更多」里可以换档。'),
};

/** Why the local service did not start, by the code of the failure (never what the program printed: that is in 更多 › 详细信息). */
const SERVICE_REASON = {
  'port-in-use': local => (local?.external ? ui('本机服务没能启动：另一份 MinerU 占用了它要用的端口。') : ui('本机服务没能启动：它要用的端口被别的程序占用了。')),
  'vc-runtime': () => ui('本机服务没能启动：这台电脑缺少微软 VC++ 运行库。'),
  'service-timeout': () => ui('本机服务没能启动：等了很久它还没有准备好。'),
  'models-missing': () => ui('本机服务没能启动：模型文件不完整。'),
  'service-failed': () => ui('本机服务没能启动：它一启动就退出了。'),
};

/**
 * What is wrong, in one short sentence in the learner's language: the status line of the error state (the title of that state; the body adds at most one
 * hint and the one fix). A service failure is worded by its code only; an install's failure is the install's own plain message.
 */
export function errorReason(local, code, origin = '') {
  if (code === 'unreadable') return ui('读不出本机 MinerU 的状态。');
  if (code === 'needs-models') return ui('本机 MinerU 的模型还没有下载完整。');
  if (origin === 'service' || (!origin && local?.lastError?.code === code)) return (SERVICE_REASON[code] || SERVICE_REASON['service-failed'])(local);
  if (code === 'port-in-use') return local?.external ? ui('另一份 MinerU 占用了本机服务要用的端口。') : ui('本机服务要用的端口被别的程序占用了。');
  const install = local?.install || {};
  const message = INSTALL_ENDED.includes(install.status) && install.error?.code === code ? install.error.message : '';
  return message ? uiMessage(message) : ui('安装没有完成。');
}

/** One wording per state: the badge, its tone, the sentence and (where the state hides logic) the Tooltip of the badge. */
export const STATUS_TEXT = Object.freeze({
  checking: { badge: () => ui('检测中'), tone: 'neutral', sentence: () => ui('正在检测本机 MinerU…') },
  'not-installed': { badge: () => ui('未安装'), tone: 'neutral', sentence: () => ui('这台电脑上还没有可用的 MinerU。') },
  // The spinner and the bar already say it is busy: the badge stays neutral (no second accent colour on the card).
  installing: { badge: () => ui('安装中'), tone: 'neutral',
    sentence: local => { const install = local?.install || {}; return uiFormat('第 {0}/6 步：{1}', [Math.max(1, install.step || 1), stageName(install.stage) || stageName('tools')]); },
    tip: () => ui('每一步完成后才进入下一步。暂停后已下载的部分会保留，下次点「继续安装」从停下的那一步接着装。') },
  paused: { badge: () => ui('已暂停'), tone: 'neutral',
    sentence: local => { const install = local?.install || {}; return uiFormat('已暂停在第 {0}/6 步「{1}」；已下载的部分会保留。', [Math.max(1, install.step || 1), stageName(install.stage) || stageName('tools')]); } },
  stopped: { badge: () => ui('已安装 · 服务未启动'), tone: 'warning', sentence: () => ui('MinerU 已装好，本机服务没在运行。'),
    tip: () => ui('MinerU 要靠一个在后台运行的本机服务来解析。电脑重启或关闭 StudyHub 后它可能会停；开始解析时 StudyHub 会先自动启动它，你也可以现在点「启动服务」。') },
  // The at-a-glance line says where it is and that it works; the version and the tier are in the badge's Tooltip (and in 更多).
  ready: { badge: () => ui('可以用了'), tone: 'success',
    sentence: local => (ourInstall(local)
      ? uiFormat('装在 {0}，可以开始解析 PDF 了。', [local.folder || local.install?.installedFolder || ''])
      : ui('用的是你自己安装的 MinerU，可以开始解析 PDF 了。')),
    tip: local => {
      const version = uiFormat('MinerU {0} · {1} 档。', [local?.version || local?.install?.mineruVersion || '', local?.tier || local?.install?.tier || '']);
      return ourInstall(local) ? [version, TIER_TIP[local.tier || local.install?.tier]?.() || ''].filter(Boolean).join('\n')
        : `${version}\n${uiFormat('这是你自己装的 MinerU（{0}）。StudyHub 只调用它，不改它的设置。', [local?.exe || ''])}`;
    } },
  error: { badge: () => ui('出错'), tone: 'error', sentence: (local, code, origin) => errorReason(local, code, origin) },
});

/* The one hint under an error, by code, only where it adds something the status line (what is wrong) and the fix button do not already say; never a
   pointer to the page the learner is on. Each that names a button names the one the card offers. */
const HINT = {
  network: ({ attempts = 1, source = 'mainland' } = {}) => (attempts >= 2 ? uiFormat('换成{0}再试常常就好了。', [sourceName(otherSourceId(source))]) : ui('网络恢复后点「重试」，已下载的部分不会重下。')),
  checksum: () => ui('重试会重新下载这个文件。'),
  interrupted: () => ui('StudyHub 关闭或重启时安装停下了。'),
  'vc-runtime': () => ui('装好微软 VC++ 运行库后点「重试」。'),
  // Another MinerU found: the button says it all (停止另一份 MinerU 并重试). Otherwise what to close first, and the button that follows.
  'port-in-use': ({ external = false, origin = '' } = {}) => (external ? ''
    : uiFormat('关掉占用端口的程序后点「{0}」。', [origin === 'install' ? ui('修复') : ui('重新启动服务')])),
  'service-failed': ({ origin = '' } = {}) => (origin === 'install' ? ui('点「修复」会重新启用本机服务，已装好的步骤不会重做。') : ''),
  'service-timeout': () => ui('电脑较慢时第一次启动可能要几分钟，可以再试一次。'),
  unreadable: () => ui('它可能正忙或刚启动，过一会儿再检测。'),
};
/** context: { attempts, source, external, origin } of the failure, for the hints that depend on them. '' when there is nothing to add. */
export const errorHint = (code, context) => HINT[code]?.(context) || '';

/** The one fix button of each failure code (id is what the card does). */
export const FIX_FOR = Object.freeze({
  network: 'retry', checksum: 'retry',
  cancelled: 'continue', interrupted: 'continue',
  'no-space': 'relocate', 'not-writable': 'relocate', 'folder-in-use': 'relocate', 'bad-location': 'relocate', 'path-too-long': 'relocate',
  'tools-failed': 'repair', 'python-failed': 'repair', 'package-failed': 'repair', 'models-failed': 'repair', 'check-failed': 'repair', 'needs-models': 'repair', 'models-missing': 'repair',
  'service-failed': 'restart-service', 'service-timeout': 'restart-service', 'port-in-use': 'stop-external', 'vc-runtime': 'vc-runtime', unreadable: 'recheck',
});

const SOURCE_NAME = { mainland: () => ui('国内镜像'), global: () => ui('海外官方源') };
export const sourceName = id => SOURCE_NAME[id]?.() || SOURCE_NAME.mainland();
export const otherSourceId = id => (id === 'global' ? 'mainland' : 'global');

/**
 * The fix of a failure: { id, label, icon, tip? } (the icon says the action: a pin for another location, a square for stopping another MinerU). A second
 * network failure in a row on one source offers the other source; a port held by another MinerU stops it only when there is one. origin: 'install': the
 * service failed inside an install that has not finished, so there is no installed program to restart yet: the fix starts the install again (the finished
 * steps are skipped; 启用本机服务 and 检查 run again), after stopping the other MinerU when there is one.
 */
export function fixFor(code, { attempts = 1, external = false, source = 'mainland', origin = '' } = {}) {
  let id = FIX_FOR[code] || 'repair';
  if (id === 'retry' && attempts >= 2) id = 'switch-source';
  if (id === 'stop-external' && !external) id = 'restart-service';
  if (id === 'restart-service' && origin === 'install') id = 'repair';
  switch (id) {
    case 'retry': return { id, label: ui('重试'), icon: 'refresh', tip: ui('从停下的那一步接着装，已下载的部分不会重下。') };
    case 'switch-source': return { id, label: ui('换下载源重试'), icon: 'sync', tip: uiFormat('换成{0}再试；已装好的步骤不会重做。', [sourceName(otherSourceId(source))]), source: otherSourceId(source) };
    case 'continue': return { id, label: ui('继续安装'), icon: 'play' };
    case 'relocate': return { id, label: ui('换位置'), icon: 'location' };
    case 'restart-service': return { id, label: ui('重新启动服务'), icon: 'refresh' };
    case 'stop-external': return { id, label: ui('停止另一份 MinerU 并重试'), icon: 'stop', tip: ui('先停掉另一份 MinerU 的服务，再启动这一份；那一份的文件不会被改动。') };
    case 'vc-runtime': return { id, label: ui('下载 VC++ 运行库'), icon: 'download', tip: ui('微软官方安装包，装好后点「重试」。') };
    case 'recheck': return { id, label: ui('重新检测'), icon: 'refresh' };
    default: return { id: 'repair', label: ui('修复'), icon: 'refresh', tip: ui('重新检查每一步，只补装缺少的部分。') };
  }
}
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/** The six steps of an install: [{ id, name, state: done | active | failed | pending }]. */
export function stageStates(install) {
  const done = new Set(install?.done || []), ended = INSTALL_ENDED.includes(install?.status);
  return STAGES.map(id => ({ id, name: stageName(id),
    state: done.has(id) || install?.status === 'complete' ? 'done' : id === install?.stage ? (ended && install?.status === 'failed' ? 'failed' : 'active') : 'pending' }));
}

const SIZE = '(\\d+(?:\\.\\d+)?)\\s?([KMG])i?B?';
const UNIT_MB = { K: 1 / 1024, M: 1, G: 1024 };
const megabytes = (value, unit) => Number(value) * UNIT_MB[unit.toUpperCase()];
/**
 * What the card says under the bar while it installs, in the learner's words: 「已下载 x / 约 y」 when the last output line carries a size pair (or a size
 * and a percentage, as a progress bar prints them), otherwise nothing. The raw output (commands, package names, progress glyphs) stays in 更多 › 安装日志.
 */
export function installLine(install) {
  const line = String(install?.lastLine || '');
  if (!line.trim() || /^\s*(\$|==|\()/.test(line)) return '';
  const pair = new RegExp(`${SIZE}\\s*/\\s*${SIZE}`, 'i').exec(line);
  if (pair) return uiFormat('已下载 {0} / 约 {1}', [sizeLabel(megabytes(pair[1], pair[2])), sizeLabel(megabytes(pair[3], pair[4]))]);
  const total = new RegExp(`\\(${SIZE}\\)`, 'i').exec(line), percent = [...line.matchAll(/(\d{1,3})%\|/g)].at(-1);
  if (!total || !percent) return '';
  const whole = megabytes(total[1], total[2]);
  return uiFormat('已下载 {0} / 约 {1}', [sizeLabel(whole * Math.min(100, Number(percent[1])) / 100), sizeLabel(whole)]);
}

/** The progress of an install as a bar: finished steps plus how far the current step is (a parsed percentage or bytes), out of 6. */
export const installProgress = install => ({ value: Math.min(STAGES.length, (install?.done?.length || 0) + (Number(install?.stageFraction) || 0)), max: STAGES.length });

/** Where the default folder came from, in words (the hint under the location). */
export function locationHint(plan) {
  if (!plan) return '';
  const drive = plan.disk?.drive || '';
  if (plan.adjusted) return ui('这个文件夹里已经有别的文件，会装进里面新建的「StudyHub-MinerU」文件夹，不会动原有文件。');
  if (plan.platform && plan.platform !== 'win32') return ui('装在 StudyHub 的数据文件夹里。');
  const chosen = plan.drives?.find(item => item.root.slice(0, 2).toUpperCase() === drive);
  if (chosen?.system && plan.defaultReason === 'only-system-drive' && plan.folder === plan.defaultFolder) return uiFormat('这台电脑只有系统盘（{0}），只能装在这里。', [drive]);
  if (chosen?.system && plan.folder === plan.defaultFolder && plan.defaultReason === 'other-drives-full') return uiFormat('其他磁盘的剩余空间不够，只能装在系统盘（{0}）。', [drive]);
  if (chosen?.system && plan.folder === plan.defaultFolder && plan.defaultReason === 'other-drives-removable') return uiFormat('其他磁盘是外接硬盘，拔掉后就用不了，所以装在系统盘（{0}）。', [drive]);
  if (chosen?.system) return uiFormat('装在系统盘会占用 {0} 盘约 {1}。', [drive.replace(':', ''), sizeLabel(plan.disk?.neededMb)]);
  // An external USB/SD disk (Windows lists it as fixed): it works only while it is plugged in.
  if (chosen?.removable) return uiFormat('{0} 是外接硬盘：拔掉后 MinerU 就用不了，要用时请先插上。', [drive]);
  if (plan.folder === plan.defaultFolder && chosen) return uiFormat('默认装在剩余空间最大的非系统盘（{0}，剩余 {1}），不占用 C 盘。', [drive, sizeLabel(chosen.freeMb)]);
  return '';
}
