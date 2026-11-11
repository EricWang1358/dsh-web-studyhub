/* The reader's own marks and its 待出题 list as plain data (owner request 2026-11-11): what the right-click menu offers, how marks are painted with
   the link layer's ranges, and the ONE ordinary question run a list of waiting passages becomes. Pure, so it runs under node:test; the
   components are marks/SelectionMenu.jsx and marks/QueueChip.jsx, the store is materials.marks.* (lib/contexts/materials/mark-operations.js). */
import { DRAWN_STYLES } from '../../../lib/reader-marks.js';
import { generationFormDefaults } from '../../generation-status.js';
import { generationRequest } from '../../generate-form.js';
import { ui, uiFormat } from '../../i18n.js';

/** The highlight names of the learner's strokes (links.css draws them; the link layer's own names are study-link-*). */
export const MARK_HIGHLIGHTS = Object.freeze({ underline: 'study-mark-underline', bold: 'study-mark-bold', highlight: 'study-mark-highlight', queue: 'study-mark-queue', pending: 'study-mark-pending' });
/** Over a link's underline the learner's own stroke wins; the waiting and pending looks stay under everything. */
const PRIORITY = { underline: 6, bold: 6, highlight: 1, queue: 0, pending: 0 };

/** Questions per waiting passage, and what 一次性出题 starts with. */
export const PER_PASSAGE = Object.freeze([1, 2, 3]);
export const DEFAULT_PER_PASSAGE = 1;

/** The marks that can be drawn: resolved ones, as groups the link layer's locateGroups takes ({ selection }). Pending 词解 passages are drawn too. */
export function drawnMarks(items = [], pending = []) {
  return [...items.filter(item => item.status === 'resolved' && (DRAWN_STYLES.includes(item.style) || item.style === 'queue')),
    ...pending.map(entry => ({ ...entry, style: 'pending' }))];
}

/** The passages waiting under 待出题, in reading order (the store lists them so). */
export const queueOf = (items = []) => items.filter(item => item.style === 'queue' && item.status === 'resolved');

/** Paint located marks ([{ group, range }]) by style; returns the function that clears them. */
export function paintMarks(entries, env = supported()) {
  const { registry, Highlight } = env || {};
  if (!registry || typeof Highlight !== 'function') return () => {};
  const names = Object.values(MARK_HIGHLIGHTS), buckets = new Map();
  for (const { group, range } of entries) {
    const name = MARK_HIGHLIGHTS[group.style];
    if (!name) continue;
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(range);
  }
  for (const [style, name] of Object.entries(MARK_HIGHLIGHTS)) {
    const ranges = buckets.get(name);
    if (!ranges?.length) { registry.delete(name); continue; }
    const highlight = new Highlight(...ranges);
    highlight.priority = PRIORITY[style];
    registry.set(name, highlight);
  }
  return () => { for (const name of names) registry.delete(name); };
}
const supported = () => typeof window !== 'undefined' && window.CSS?.highlights && typeof window.Highlight === 'function'
  ? { registry: window.CSS.highlights, Highlight: window.Highlight } : { registry: null, Highlight: null };

/** The marks a selection lies in or covers: the same passage, or one that contains it (so 去掉下划线 is offered on any part of an underline). */
export function marksAt(items = [], capture) {
  if (!capture?.quote) return [];
  const quote = capture.quote.replace(/\s+/g, ''), source = capture.sourceId;
  return items.filter(item => item.status === 'resolved' && (!source || item.selection.sourceId === source)
    && (Number.isInteger(capture.start) && Number.isInteger(item.selection.start)
      ? capture.start >= item.selection.start && capture.end <= item.selection.end
      : item.selection.quote.replace(/\s+/g, '').includes(quote)));
}

/**
 * The right-click menu over a selection: [{ id, label, icon, hint?, disabled?, tip? }] in Menu's shape. `here`: the marks the selection is in
 * (marksAt); `explain`: 'ready' | 'no-model' | 'unavailable'; `queueFull`: the list is at its limit.
 * Each stroke turns into its 去掉 when the selection is already in one; 复制 is first, so the browser's own copy is never lost.
 */
export function selectionMenu({ here = [], explain = 'ready', queueFull = false, canMark = true } = {}) {
  const has = style => here.some(item => item.style === style);
  const stroke = (style, add, remove, icon) => ({ id: has(style) ? `unmark:${style}` : `mark:${style}`, label: has(style) ? remove : add, icon, disabled: !canMark });
  return [
    { id: 'copy', label: ui('复制'), icon: 'copy', hint: 'Ctrl+C' },
    stroke('underline', ui('下划线'), ui('去掉下划线'), 'underline'),
    stroke('bold', ui('加粗'), ui('去掉加粗'), 'bold'),
    stroke('highlight', ui('荧光笔'), ui('去掉荧光笔'), 'highlighter'),
    has('queue') ? { id: 'unmark:queue', label: ui('移出待出题'), icon: 'close', disabled: !canMark }
      : { id: 'mark:queue', label: ui('加入待出题'), icon: 'plus', disabled: !canMark || queueFull, ...(queueFull ? { tip: ui('待出题已满，先一次性出题或移出一些。') } : {}) },
    ...(explain === 'unavailable' ? [] : [{ id: 'explain', label: ui('AI 词解'), icon: 'sparkle', disabled: !canMark,
      tip: explain === 'no-model' ? ui('需要先连接模型；点一下去设置。') : ui('让 AI 用通俗、具体的话解释选中的词，解释留在原文上，鼠标移上去就能看。') }]),
    ...(here.length > 1 ? [{ id: 'unmark:all', label: ui('去掉这里的所有标记'), icon: 'trash', danger: true, disabled: !canMark }] : []),
  ];
}

/** The question a 词解 asks (materials.selection.ask), in the interface language; `term` is the selected words. */
export const explainQuestion = term => uiFormat('请用通俗、具体的话解释「{0}」：它在这里是什么意思，再举一个具体的例子。控制在 150 字以内。', [clipText(term, 80)]);

const clipText = (value, size) => { const clean = String(value ?? '').replace(/\s+/g, ' ').trim(); return clean.length > size ? `${clean.slice(0, size - 1)}…` : clean; };
export { clipText };

/** What the 一次性出题 focus says: one numbered line per waiting passage, so the run writes about exactly these words. */
export function batchFocus(queue, perPassage = DEFAULT_PER_PASSAGE) {
  const lines = queue.map((item, index) => `${index + 1}. 「${clipText(item.selection.quote, 400)}」`);
  return [uiFormat('只围绕下面这 {0} 段原文出题，每段约 {1} 题；题目要考这段原文本身的意思，不要考资料的其他部分：', [queue.length, perPassage]), ...lines].join('\n');
}

/**
 * The ONE ordinary question run (`generate`, the same request the 出题 page sends, ui/generate-form.js) that the waiting passages become: the
 * saved 出题偏好 (kind, difficulty, language), only the sources the passages are in, a focus naming each passage, a count of `perPassage` each,
 * and no going on by itself. Without `course` the run takes the material's own course from its sources (an empty course would file it under 未分类). It writes a draft like any run, shown in the 任务 console.
 */
export function batchRequest({ queue, perPassage = DEFAULT_PER_PASSAGE, settings, title = '', course, language }) {
  const sourceIds = [...new Set(queue.map(item => item.selection.sourceId))];
  const count = Math.max(1, queue.length * perPassage);
  const gen = { ...generationFormDefaults(settings?.generation, language), customCount: String(count), autoComplete: false, focus: batchFocus(queue, perPassage),
    title: title ? uiFormat('{0} · 待出题 {1} 段', [title, queue.length]) : '' };
  const request = generationRequest(gen, { course, sourceIds });
  if (course === undefined) delete request.course;
  return request;
}

/** The toast when 一次性出题 has started: it goes on without the reader. */
export const batchStartedText = (passages, count) =>
  uiFormat('已开始：{0} 段出约 {1} 题，在后台进行，可以继续读；完成后在「草稿」里检查，进度在「任务」里。', [passages, count]);
