import { ui, uiFormat, uiMessage } from '../i18n.js';
import { formatDuration, joinMeta } from '../format.js';

/* The lines a PDF conversion writes into its log (lib/mineru-job.js convertPdf, lib/contexts/audio/pdf/convert-run.js; docs/job-contract.md «日志»), as sentences.
   A conversion makes no model calls: its log is the story of its windows, what the converter printed, and how it ended. */

const TOOL = { marker: () => ui('Marker 本机解析'), local: () => ui('MinerU 本机解析'), cloud: () => ui('MinerU 云端解析') };
const ORIGIN = { installed: () => ui('StudyHub 安装的 Marker'), saved: () => ui('设置里填写的 Marker 程序'), search: () => ui('自动找到的 Marker') };
const took = seconds => formatDuration(Math.max(0, Number(seconds) || 0) * 1000);

function windowsText(windows) {
  if (windows?.kind === 'adaptive' && windows.firstPages > 0) return uiFormat('分段：先做 {0} 页，之后每段约 {1} 秒（{2}–{3} 页）', [windows.firstPages, windows.targetSeconds, windows.minPages, windows.maxPages]);
  if (windows?.kind === 'fixed' && windows.pages > 0) return uiFormat('每段 {0} 页', [windows.pages]);
  return '';
}

/** The sentence of one line of a conversion's log, or null when the code is not a conversion's. */
export function convertEventText(event) {
  const a = event.args || {};
  switch (event.code) {
    case 'convert-start': return joinMeta([uiFormat('开始转换 · 共 {0} 页', [a.pages]), (TOOL[a.converter === 'marker' ? 'marker' : a.route === 'local' ? 'local' : 'cloud'])(),
      ORIGIN[a.origin]?.() || '', a.version ? (a.converter === 'marker' ? uiFormat('Marker {0}', [a.version]) : uiFormat('MinerU {0}', [a.version])) : '',
      a.python ? uiFormat('Python {0}', [a.python]) : '', windowsText(a.windows)]);
    case 'reused': return uiFormat('复用之前转换好的 {0} 页（{1} 段），不再重做', [a.pages, a.windows]);
    case 'window-start': return uiFormat('第 {0} 段开始：第 {1}–{2} 页（{3} 页）', [a.index, a.start, a.end, a.pages]);
    case 'window-end': return joinMeta([uiFormat('第 {0} 段完成：第 {1}–{2} 页，用时 {3}', [a.index, a.start, a.end, took(a.seconds)]), uiFormat('已完成 {0}/{1} 页', [a.done, a.total]),
      Number.isFinite(a.etaSeconds) ? uiFormat('预计还需约 {0}', [took(a.etaSeconds)]) : '']);
    case 'window-failed': return joinMeta([uiFormat('第 {0} 段没有完成：第 {1}–{2} 页，用时 {3}', [a.index, a.start, a.end, took(a.seconds)]),
      Number.isInteger(a.exitCode) ? uiFormat('退出码 {0}', [a.exitCode]) : '', event.text ? uiMessage(event.text) : '']);
    case 'window-retry': return joinMeta([uiFormat('第 {0}–{1} 页没有成功，拆成两段重试（第 {2} 次）', [a.start, a.end, a.attempt]), event.text ? uiMessage(event.text) : '']);
    case 'tool-output': return event.text || '';
    case 'tool-omitted': return uiFormat('…… 中间省略 {0} 行输出', [a.count]);
    case 'merge': return uiFormat('合并 {0} 段结果（共 {1} 页）', [a.windows, a.pages]);
    case 'save': return uiFormat('保存为资料：{0} 页，{1} 字', [a.pages, a.chars]);
    case 'empty-pages': return uiFormat('{0} 页没有文字（空白页或只有图），没有存为资料', [a.count]);
    case 'convert-end': return joinMeta([uiFormat('转换完成：{0} 页资料', [a.pages]), a.title ? uiFormat('「{0}」', [a.title]) : '', uiFormat('{0} 段', [a.windows]),
      a.retries > 0 ? uiFormat('重试 {0} 次', [a.retries]) : '', Number.isFinite(a.chars) ? uiFormat('{0} 字', [a.chars]) : '', uiFormat('共用时 {0}', [took(a.seconds)])]);
    case 'convert-failed': return uiFormat('转换失败：{0}', [uiMessage(event.text || '')]);
    default: return null;
  }
}

/** The lines the converter printed last, under the line of the failure (selectable, kept as they were printed). */
export const convertEventBlock = event => (event.code === 'convert-failed' && Array.isArray(event.args?.lines) && event.args.lines.length ? event.args.lines : undefined);
