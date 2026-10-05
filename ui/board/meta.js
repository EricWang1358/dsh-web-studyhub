import { ui, uiFormat } from '../i18n.js';
import { formatDateTime } from '../format.js';

const defaultColumnTitles = { todo: '待办', doing: '进行中', done: '已完成' };
/** Built-in column names follow the UI language; names the learner chose stay as typed. */
export const boardColumnLabel = (column) => column.title === defaultColumnTitles[column.id] ? ui(column.title) : column.title;

/** "今天截止", "3 天后", "已逾期 2 天" for a dueState() result. */
export function dueText({ kind, days }) {
  if (kind === 'today') return ui('今天截止');
  if (kind === 'tomorrow') return ui('明天截止');
  if (kind === 'overdue') return days === -1 ? ui('已逾期 1 天') : uiFormat('已逾期 {0} 天', [-days]);
  return uiFormat('{0} 天后', [days]);
}

/** The long form for tooltips and the detail dialog: the date itself plus how far away it is. */
export const dueTitle = (due, state) => state ? `${due} · ${dueText(state)}` : due;

export const normalizeRoot = (value) => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

const KIND = {
  card: () => ui('题目'), source: () => ui('资料'), note: () => ui('笔记'), skeleton: () => ui('知识骨架'), deck: () => ui('题组'),
  exam: () => ui('考试'), oral: () => ui('口试'), course: () => ui('未分类课程'), workflow: () => ui('学习流'),
};

/**
 * What a study link points at, in words: "课程 · Platform Engineering". Names
 * are resolved from the current library snapshot only when the link belongs to
 * that library (a link into another library keeps just the kind). Missing
 * names fall back to the kind name.
 */
export function studyRefLabel(ref, library) {
  const kind = (KIND[ref?.kind] || (() => ui('学习内容')))();
  const label = (name) => ref?.kind === 'course' ? (name ? uiFormat('课程 · {0}', [name]) : ui('未分类课程')) : name ? `${kind} · ${name}` : kind;
  let name = '';
  if (ref && library && normalizeRoot(ref.root) === normalizeRoot(library.root)) {
    const find = (list, id) => (list || []).find((item) => item.id === id)?.title;
    if (ref.kind === 'course') name = ref.course || '';
    else if (ref.kind === 'card') name = find(library.decks, ref.deckId);
    else if (ref.kind === 'deck') name = find(library.decks, ref.id);
    else if (ref.kind === 'source') name = find(library.sources, ref.id);
    else if (ref.kind === 'note') name = find(library.notes, ref.id);
    else if (ref.kind === 'skeleton') name = find(library.skeletons, ref.id);
  }
  name = String(name || '').trim();
  return { kind, name, text: label(name) };
}

/** Local date and time for "created / updated" lines. */
export function stamp(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return formatDateTime(date);
}

/** "1 card" / "{n} cards". */
export const cardsText = (n) => n === 1 ? ui('1 张卡片') : uiFormat('{0} 张卡片', [n]);
