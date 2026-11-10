/* Pure state and wording helpers for the hot-installable system-audio loopback card (ui/LiveLoopbackCard.jsx).
   Stage names come from lib/live-loopback-install-text.js and speak through the i18n catalogue. */

import { ui, uiFormat, uiMessage } from './i18n.js';
import { LIVE_LOOPBACK_STAGE_NAMES } from '../lib/live-loopback-install-text.js';
import { installArgs } from './live-local-flow.js';

export { installArgs };

export const LOOPBACK_STAGES = Object.freeze(['compile', 'check']);
export const loopbackStageName = id => (LIVE_LOOPBACK_STAGE_NAMES[id] ? ui(LIVE_LOOPBACK_STAGE_NAMES[id]) : '');
const PAUSED = ['cancelled', 'interrupted'];

export function loopbackCardState(status) {
  if (status == null) return { state: 'checking' };
  if (status.status === 'running') return { state: 'installing' };
  if (status.ready) return { state: 'ready' };
  if (status.supported === false) return { state: 'unsupported' };
  if (PAUSED.includes(status.status)) return { state: 'paused', code: status.status };
  if (status.status === 'failed') return { state: 'error', code: status.error?.code || 'failed' };
  if (status.needsRepair) return { state: 'repair' };
  return { state: 'not-installed' };
}

export function loopbackStageStates(install) {
  const done = new Set(install?.done || []), failed = install?.status === 'failed';
  return LOOPBACK_STAGES.map(id => ({
    id,
    name: loopbackStageName(id),
    state: done.has(id) || install?.status === 'complete' ? 'done' : id === install?.stage ? (failed ? 'failed' : 'active') : 'pending',
  }));
}

export const loopbackProgress = install => ({
  value: Math.min(LOOPBACK_STAGES.length, (install?.done?.length || 0) + (Number(install?.stageFraction) || 0)),
  max: LOOPBACK_STAGES.length,
});

export const loopbackFacts = () => ui('不用虚拟声卡 · 平时零后台进程，只在实录时启动，暂停或结束立即释放声卡');

export const loopbackTip = () => [
  ui('使用 Windows 原生共享环回接口（WASAPI）只读采集耳机或扬声器正在播放的声音：不装任何虚拟声卡驱动，不改系统默认音频设备，也不会触发蓝牙耳机通话降质模式。'),
  ui('按需热插拔：点安装时在本地生成约 20 KB 的辅助程序并记录 SHA-256 校验值（无需联网下载）；平时没有任何后台进程，也不占用声卡。'),
  ui('只在点击「开始实录」时启动采音，暂停实录、结束实录或关闭窗口都会立即退出进程并释放全部声卡句柄；不用时可随时一键卸载。'),
].join('\n');

export const LOOPBACK_STATUS = Object.freeze({
  checking: { badge: () => ui('检测中'), tone: 'neutral', sentence: () => ui('正在检测电脑声音组件…') },
  'not-installed': { badge: () => ui('未安装'), tone: 'neutral', sentence: () => loopbackFacts() },
  unsupported: { badge: () => ui('不支持'), tone: 'warning', sentence: () => ui('电脑声音本机直采组件目前仅支持 Windows 10/11。') },
  installing: { badge: () => ui('安装中'), tone: 'neutral',
    sentence: status => uiFormat('第 {0}/2 步：{1}', [Math.max(1, status?.step || 1), loopbackStageName(status?.stage) || loopbackStageName('compile')]) },
  paused: { badge: () => ui('已取消'), tone: 'neutral', sentence: () => ui('安装已取消；随时可以重新安装。') },
  ready: { badge: () => ui('可以用了'), tone: 'success',
    sentence: status => uiFormat('装在 {0} · 平时零后台进程，实录时按需启动。', [status?.installedFolder || status?.folder || '']) },
  repair: { badge: () => ui('需要修复'), tone: 'warning',
    sentence: () => ui('电脑声音组件的文件不完整或被改动（可能被杀毒软件隔离）；点「修复」重新生成。') },
  error: { badge: () => ui('出错'), tone: 'error',
    sentence: status => (status?.error?.message ? uiMessage(status.error.message) : ui('安装没有完成。')) },
});

const RELOCATE = ['no-space', 'not-writable', 'folder-in-use', 'bad-location', 'path-too-long'];
export function loopbackFix(code) {
  if (PAUSED.includes(code)) return { id: 'continue', label: ui('重新安装'), icon: 'play' };
  if (RELOCATE.includes(code)) return { id: 'relocate', label: ui('换位置'), icon: 'location' };
  return { id: 'repair', label: ui('修复'), icon: 'refresh', tip: ui('在本地重新生成并校验采音组件。') };
}
