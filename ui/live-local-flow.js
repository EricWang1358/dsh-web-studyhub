/* The pure side of the local live engine's card (ui/LiveLocalCard.jsx): which state the card shows, the one wording of each, the one fix of each
   failure, the three steps of an install and the honest facts (no key, the sound stays on this computer, the sizes, accuracy and speed). No React, so
   it runs in tests. The stage names are the backend's own (lib/live-local-install-text.js), translated through the catalogue. */

import { ui, uiFormat, uiMessage } from './i18n.js';
import { LIVE_LOCAL_STAGE_NAMES } from '../lib/live-local-install-text.js';
import { sizeLabel } from './mineru-flow.js';

export const LOCAL_STAGES = Object.freeze(['engine', 'model', 'check']);
export const localStageName = id => (LIVE_LOCAL_STAGE_NAMES[id] ? ui(LIVE_LOCAL_STAGE_NAMES[id]) : '');
const PAUSED = ['cancelled', 'interrupted'];

/** The card's state from live.local.status (null while it is read): checking, unsupported, installing, ready, paused, error, repair (installed once,
 *  its files changed since: a quarantined addon) or not-installed. */
export function localCardState(status) {
  if (status == null) return { state: 'checking' };
  if (status.status === 'running') return { state: 'installing' };
  if (status.ready) return { state: 'ready' };
  if (status.supported === false) return { state: 'unsupported' };
  if (PAUSED.includes(status.status)) return { state: 'paused', code: status.status };
  if (status.status === 'failed') return { state: 'error', code: status.error?.code || 'failed' };
  if (status.needsRepair) return { state: 'repair' };
  return { state: 'not-installed' };
}

/** The three steps of an install: [{ id, name, state: done | active | failed | pending }]. */
export function localStageStates(install) {
  const done = new Set(install?.done || []), failed = install?.status === 'failed';
  return LOCAL_STAGES.map(id => ({ id, name: localStageName(id),
    state: done.has(id) || install?.status === 'complete' ? 'done' : id === install?.stage ? (failed ? 'failed' : 'active') : 'pending' }));
}

/** Finished steps plus how far the current one is, out of 3 (the download of the model is most of it). */
export const localProgress = install => ({ value: Math.min(LOCAL_STAGES.length, (install?.done?.length || 0) + (Number(install?.stageFraction) || 0)), max: LOCAL_STAGES.length });

/** The one short line under the title: what it is and what it costs. */
export const localFacts = () => ui('不需要密钥 · 转写在这台电脑上进行');

/** The hover explanation of the local engine: what runs where, the sizes, and accuracy and speed as they really are. */
export const localTip = status => [
  ui('SenseVoice 语音识别（普通话、英语、粤语、日语、韩语）在这台电脑的 CPU 上运行，声音不上传。'),
  uiFormat('首次安装下载约 {0}：识别模型约 {1}、语音检测模型约 2 MB，其余是识别引擎。之后不再下载。', [sizeLabel(status?.downloadMb || 240), sizeLabel(status?.modelMb || 228)]),
  ui('准确度：发音清楚时普通话和英语都不错，口音重、噪音大或专业术语多时比云端差一些；中文直接写成中文。速度：一句话说完后约 1 秒出字。'),
  ui('翻译和上下文润色仍用你设置的文字模型（文字会发给模型服务商）；没有文字模型时只有原文。'),
].join('\n');

/** One sentence per state: the badge, its tone and the line beside it. */
export const LOCAL_STATUS = Object.freeze({
  checking: { badge: () => ui('检测中'), tone: 'neutral', sentence: () => ui('正在检测本地转写引擎…') },
  'not-installed': { badge: () => ui('未安装'), tone: 'neutral', sentence: status => localFacts(status) },
  unsupported: { badge: () => ui('不支持'), tone: 'warning', sentence: () => ui('这台电脑没有现成的本地转写引擎。') },
  installing: { badge: () => ui('安装中'), tone: 'neutral',
    sentence: status => uiFormat('第 {0}/3 步：{1}', [Math.max(1, status?.step || 1), localStageName(status?.stage) || localStageName('engine')]) },
  paused: { badge: () => ui('已暂停'), tone: 'neutral', sentence: () => ui('已暂停；已下载的部分会保留。') },
  ready: { badge: () => ui('可以用了'), tone: 'success', sentence: status => uiFormat('装在 {0}；转写在这台电脑上进行。', [status?.installedFolder || status?.folder || '']) },
  repair: { badge: () => ui('需要修复'), tone: 'warning', sentence: () => ui('本地转写引擎的文件不完整或被改动（可能被杀毒软件隔离）；点「修复」只补装出问题的部分。') },
  error: { badge: () => ui('出错'), tone: 'error', sentence: status => (status?.error?.message ? uiMessage(status.error.message) : ui('安装没有完成。')) },
});

const RELOCATE = ['no-space', 'not-writable', 'folder-in-use', 'bad-location'];
/** The one fix of a failure: { id, label, icon, tip? }. */
export function localFix(code) {
  if (PAUSED.includes(code)) return { id: 'continue', label: ui('继续安装'), icon: 'play' };
  if (code === 'network' || code === 'checksum') return { id: 'retry', label: ui('重试'), icon: 'refresh', tip: ui('从停下的地方接着下载，已校验的文件不会重下。') };
  if (RELOCATE.includes(code)) return { id: 'relocate', label: ui('换位置'), icon: 'location' };
  if (code === 'vc-runtime') return { id: 'vc-runtime', label: ui('下载 VC++ 运行库'), icon: 'download', tip: ui('微软官方安装包，装好后点「重试」。') };
  return { id: 'repair', label: ui('修复'), icon: 'refresh', tip: ui('重新检查每一步，只补装缺少的部分。') };
}

/**
 * The arguments of 安装 / 继续安装 / 修复 / 安装到这个位置: always confirmed; `location` when the card has one; and, when the learner chose a different
 * folder than the one the install uses now, removePrevious, so a broken or unfinished install there is removed once the new one works.
 */
export function installArgs({ location = '', current = '' } = {}) {
  const moving = !!location && !!current && location.toLowerCase() !== current.toLowerCase();
  return { confirm: true, ...(location ? { location } : {}), ...(moving ? { removePrevious: true } : {}) };
}
