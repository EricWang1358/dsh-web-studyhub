import { ui } from './i18n.js';

/* The pure part of the one-click Marker install panel (ui/MarkerInstall.jsx): which section shows, how far the stages are,
   what the default download source is, and what blocks the button. The server decides everything real (lib/marker-install.js). */

export const STAGES = ['create-venv', 'install', 'verify', 'configure'];

export const stageName = id => ({
  'create-venv': ui('创建独立环境'),
  install: ui('下载并安装 marker-pdf'),
  verify: ui('验证 marker_single'),
  configure: ui('写入程序路径'),
})[id] || id;

/** loading | running | problem (failed, cancelled, interrupted) | installed | manual (a Marker that works, not made here) | offer (nothing yet, or moving). */
export function installMode({ install, markerReady = false, moving = false } = {}) {
  if (!install) return 'loading';
  if (install.status === 'running') return 'running';
  if (['failed', 'cancelled', 'interrupted'].includes(install.status)) return 'problem';
  if (install.installed && !moving) return 'installed';
  if (markerReady && !moving) return 'manual';
  return 'offer';
}

/** The four stages with a state each: done | active | failed | pending. A finished install has all four done. */
export function stageStates(install) {
  const at = install?.status === 'complete' ? STAGES.length : Math.max(0, STAGES.indexOf(install?.stage));
  const live = install?.status === 'running', broke = ['failed', 'cancelled', 'interrupted'].includes(install?.status);
  return STAGES.map((id, index) => ({ id, state: index < at ? 'done' : index === at && live ? 'active' : index === at && broke ? 'failed' : 'pending' }));
}

/** Mainland users reach the Tsinghua mirror; everyone else goes to PyPI directly. Only the first choice: it is always visible and changeable. */
const MIRROR_FOR = { zh: 'tsinghua' };
export const defaultMirror = language => MIRROR_FOR[language] ?? 'official';

export const canInstall = plan => !!plan && plan.ok === true;

/** What to try next, by the code the server gave the failure. */
export function failureHint(code) {
  switch (code) {
    case 'network': return ui('换用「国内直连」的下载源，或检查网络和代理后，点「重试」。');
    case 'no-space': return ui('清理磁盘，或点「更改位置」换到空间更大的磁盘后重试。');
    case 'not-writable': return ui('点「更改位置」换一个你有写入权限的文件夹后重试。');
    case 'python-too-old': return ui('安装 Python 3.10 – 3.12 后重试。');
    case 'configure-failed': return ui('把安装位置里 venv 的 marker_single 路径填到下面的输入框，点「检测并保存」。');
    case 'cancelled': return ui('没有改动任何设置。需要时点「重试」。');
    case 'interrupted': return ui('点「重试」接着安装，已下载的内容会被 pip 缓存复用。');
    default: return ui('展开「技术详情」查看原始日志，修正后点「重试」。');
  }
}
