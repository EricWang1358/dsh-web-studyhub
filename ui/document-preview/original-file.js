import { ui, uiFormat } from '../i18n.js';
import { MAX_OFFICE_BYTES } from '../../lib/office/limits.js';
import { formatBytes } from '../format.js';
import { browserStorage, readJSON, writeJSON } from '../storage.js';

/* Pure logic and wording of the "补全原文件" flow: attach the ORIGINAL file to a document that only kept its text.
   The screens are in OriginalFile.jsx; everything that can be decided without React is here (and tested). */

/** The largest file the host accepts as an original (mirrors lib/contexts/materials/original-file.js). */
export const ORIGINAL_MAX_BYTES = MAX_OFFICE_BYTES;

export { unquotePath, isAbsolutePath } from '../paths.js';

/* The notice for a document that only kept its text can be closed (it is a hint, not a fault). Closing remembers the document in this browser (never anywhere else) and folds the notice
   into one quiet line that keeps the action; nothing is lost by closing it. At most NOTICE_KEEP documents are remembered, the oldest forgotten first. */
const NOTICE_KEY = 'study-original-notice', NOTICE_KEEP = 200;
const closedIds = storage => { const stored = readJSON(NOTICE_KEY, [], storage); return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []; };
/** Has the learner closed the full notice of this document in this browser? */
export const noticeCollapsed = (id, storage = browserStorage()) => !!id && closedIds(storage).includes(String(id));
/** Remember that the learner closed the notice of this document; true when it was stored (the caller keeps its own memory when not). */
export function collapseNotice(id, storage = browserStorage()) {
  if (!id) return false;
  const kept = closedIds(storage).filter(item => item !== String(id));
  return writeJSON(NOTICE_KEY, [...kept, String(id)].slice(-NOTICE_KEEP), storage);
}

/** "D:\…\book.pdf": the drive (or first folder) and the file name; a short path stays whole. */
export function shortPath(path, max = 32) {
  const value = String(path || '');
  if (value.length <= max) return value;
  const separator = value.includes('\\') ? '\\' : '/', parts = value.split(/[\\/]/);
  if (parts.length < 3) return value;
  const first = parts[0] === '' ? `${separator}${parts[1]}` : parts[0];
  return `${first}${separator}…${separator}${parts.at(-1)}`;
}

/** The one-line status of an original, for the row menu. */
export function originalLine(original) {
  const state = original || { mode: null, status: 'none' };
  if (state.mode === 'reference') {
    const where = shortPath(state.path), title = state.path;
    if (state.status === 'ok') return { tone: 'success', text: uiFormat('原文件：引用 {0}', [where]), title };
    if (state.status === 'missing') return { tone: 'warning', text: uiFormat('原文件：找不到 {0}', [where]), title };
    if (state.reason === 'redirected') return { tone: 'warning', text: ui('原文件：路径现在指向别处'), title };
    if (state.status === 'unreadable') return { tone: 'warning', text: ui('原文件：无法读取'), title };
    return { tone: 'warning', text: ui('原文件：已被修改'), title };
  }
  if (state.mode === 'copy') {
    return state.status === 'ok' ? { tone: 'success', text: uiFormat('原文件：已复制到资料库 · {0}', [formatBytes(state.bytes)]) }
      : { tone: 'warning', text: ui('原文件：资料库里的副本丢失') };
  }
  return { tone: 'muted', text: ui('原文件：未保存') };
}

/** What is wrong with the original (null when it is fine), and what can be done about it. */
export function issueOf(original) {
  const state = original || { mode: null, status: 'none' };
  if (state.status === 'ok') return null;
  if (state.mode === null || state.status === 'none') return { kind: 'none', message: null, canCopy: false };
  if (state.mode === 'copy') return { kind: 'missing', message: ui('资料库里保存的原文件副本丢失了'), canCopy: false };
  if (state.status === 'missing') return { kind: 'missing', message: uiFormat('找不到原文件：{0}', [state.path]), canCopy: false };
  if (state.status === 'unreadable') return { kind: 'unreadable', message: uiFormat('无法读取原文件：{0}', [state.path]), canCopy: false };
  if (state.reason === 'redirected') return { kind: 'redirected', message: uiFormat('这个路径现在指向别处：{0}', [state.path]), canCopy: true };
  return { kind: 'changed', message: ui('文件已被修改，和保存的文字对不上'), canCopy: true };
}

const percent = value => `${Math.round(value * 1000) / 10}%`;

/** The verdict in one sentence. */
export function reportHeadline(report) {
  if (report.verdict === 'identical') return { tone: 'success', text: ui('核对通过：和保存文字时用的是同一个文件') };
  if (report.verdict === 'match') return { tone: 'success', text: report.pages?.stored > 1 ? ui('核对通过：页数一致，文字对得上') : ui('核对通过：文字对得上') };
  return { tone: 'warning', text: ui('页数不同 / 文字对不上，可能不是同一份文件') };
}

/** The figures behind the verdict. */
export function reportLines(report) {
  if (report.verdict === 'identical') return [];
  const lines = [], { pages } = report;
  if (pages?.stored > 1 || !pages?.match) lines.push({ tone: pages.match ? 'success' : 'warning',
    text: pages.match ? uiFormat('页数一致：{0} 页', [pages.stored]) : uiFormat('页数不同：保存的文字来自 {0} 页，这个文件有 {1} 页', [pages.stored, pages.supplied]) });
  if (report.checked > 0) lines.push({ tone: report.reasons?.includes('text') ? 'warning' : 'success',
    text: uiFormat(report.reasons?.includes('text') ? '文字对不上：抽查 {0} 页，{1} 页一致，相似度 {2}' : '文字对得上：抽查 {0} 页，{1} 页一致，相似度 {2}', [report.checked, report.matched, percent(report.similarity)]) });
  return lines;
}

/** The two ways to keep the file, each with its cost in plain words. Without a path (a file the browser chose) only the copy is possible. */
export function modeOptions({ size, hasPath }) {
  return [
    { value: 'reference', label: ui('只记住位置'), disabled: !hasPath,
      detail: ui('指给它原文件的位置（只记路径，不复制，不占空间；文件移动或删除后预览会提示找不到）'),
      ...(hasPath ? {} : { note: ui('浏览器不会告诉我们文件在哪里；要只记路径，请在上面填写完整路径。') }) },
    { value: 'copy', label: ui('复制一份到资料库'), disabled: false, detail: uiFormat('复制一份到资料库（约 {0}，文件移动也不受影响）', [formatBytes(size)]) },
  ];
}

/** The choice that wastes no storage, when it is possible. */
export const defaultMode = ({ hasPath }) => hasPath ? 'reference' : 'copy';

/** 附上原文件 is available once a file was checked; a mismatch needs the learner's confirmation; a reference needs a path. */
export function canAttach({ phase, report, picked, mode, confirmed }) {
  if (phase !== 'verified' || !report || !picked) return false;
  if (!report.accepted && !confirmed) return false;
  return mode === 'copy' || picked.kind === 'path';
}

/** The host's English refusals, in the learner's language. Anything unknown is shown as it is. */
export function explainFailure(message) {
  const text = String(message || '');
  let found;
  if ((found = /The file was not found: (.+)$/.exec(text))) return uiFormat('找不到这个文件：{0}', [found[1]]);
  if (/Document path must be absolute/.test(text)) return ui('请填写完整路径（从盘符或 / 开始）');
  if ((found = /at most (\d+) MB/.exec(text)) || (found = /exceeds (\d+) MB/.exec(text))) return uiFormat('这不是文件，或超过 {0} MB 的上限', [found[1]]);
  if ((found = /same type as the document \((\w+)\)/.exec(text))) return uiFormat('这不是 {0} 文件，请选择和资料同类型的文件', [found[1].toUpperCase()]);
  if (/cannot be read/.test(text)) return ui('无法读取这个文件，请检查文件权限');
  if (/audio transcript/.test(text)) return ui('音频逐字稿没有原文件可附');
  if (/not a valid PDF/.test(text)) return ui('这不是有效的 PDF 文件');
  if (/changed while/.test(text)) return ui('文件在读取时被改动，请重试');
  return text;
}
