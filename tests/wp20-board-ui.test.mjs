/* WP20 · board UI (server-rendered): calm cards, ⋯ menu, composer, columns,
   filters, card detail, empty states, zh and en. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as Board, boardColumnLabel } from './ui/Board.jsx';
  export { default as BoardCard } from './ui/board/Card.jsx';
  export { default as Composer } from './ui/board/Composer.jsx';
  export { default as CardEditor } from './ui/board/CardEditor.jsx';
  export { default as FilterBar } from './ui/board/FilterBar.jsx';
  export { default as Menu } from './ui/board/Menu.jsx';
  export { studyRefLabel, dueText } from './ui/board/meta.js';
  export { labelHue } from './lib/board-model.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Board, BoardCard, Composer, CardEditor, FilterBar, Menu, studyRefLabel, dueText, labelHue, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const TODAY = '2026-10-02';
const library = { root: '/lib', courses: [{ name: 'Platform Engineering' }], decks: [{ id: 'deck-a', title: 'Kubernetes basics' }],
  sources: [{ id: 's1', title: 'Lecture 3 slides' }], notes: [{ id: 'n1', title: 'Week 2 notes' }], skeletons: [{ id: 'k1', title: 'Platform map' }] };
const card = (id, extra = {}) => ({ id, title: id, note: '', due: '', labels: [], createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T09:30:00.000Z',
  origin: { workspace: '/ws/SWE5001', workspaceTitle: 'SWE5001' }, ...extra });
const longNote = '时间：2026 年 10 月 19 日 13:00-17:00\n地点：SIT@Dover 一楼大厅\n形式：校园招聘 / 职业活动\n**报名**：提前在 TechConnect 平台完成\n现场带上简历与学生证';
const boardData = () => ({ version: 1, revision: 7,
  columns: [{ id: 'todo', title: '待办', done: false, cardIds: ['a', 'b', 'c'] }, { id: 'doing', title: '进行中', done: false, cardIds: ['d'] }, { id: 'done', title: '已完成', done: true, cardIds: ['e'] }],
  cards: {
    a: card('a', { title: 'SCS TechConnect 2026 校园招聘/职业活动', note: longNote, labels: ['career', 'event', 'SIT'], due: '2026-10-19' }),
    b: card('b', { title: 'Platform Engineering 期末复习', labels: ['exam'], due: '2026-09-30', studyRef: { root: '/lib', kind: 'course', course: 'Platform Engineering' },
      checklist: [{ id: 'i1', text: '看第 1 章', done: true }, { id: 'i2', text: '做题', done: false }, { id: 'i3', text: '整理错题', done: false }] }),
    c: card('c', { title: '读论文', note: 'Chapter **3**', due: TODAY }),
    d: card('d', { title: '写报告', due: '2026-10-05', studyRef: { root: '/lib', kind: 'card', deckId: 'deck-a', cardId: 'q1' } }),
    e: card('e', { title: '旧任务', due: '2026-09-01', labels: ['career'] }),
  },
  archived: [card('z', { title: '已归档的一张' })] });
const columnsOf = (b) => b.columns.map((c) => ({ id: c.id, title: c.title, done: c.done }));
const noop = () => {};

const cardProps = (b, id, overrides = {}) => {
  const column = b.columns.find((c) => c.cardIds.includes(id));
  return { card: b.cards[id], column, columns: columnsOf(b), index: column.cardIds.indexOf(id), count: column.cardIds.length, today: TODAY, library,
    onToggleDone: noop, onEdit: noop, onAction: noop, ...overrides };
};
const cardHtml = (id, language = 'zh', overrides = {}) => render(React.createElement(BoardCard, cardProps(boardData(), id, overrides)), language);

test('pure copy: relative due text and study link labels resolve names cheaply', () => {
  setUiLanguage('zh');
  assert.equal(dueText({ kind: 'today', days: 0 }), '今天截止');
  assert.equal(dueText({ kind: 'tomorrow', days: 1 }), '明天截止');
  assert.equal(dueText({ kind: 'soon', days: 3 }), '3 天后');
  assert.equal(dueText({ kind: 'later', days: 17 }), '17 天后');
  assert.equal(dueText({ kind: 'overdue', days: -1 }), '已逾期 1 天');
  assert.equal(dueText({ kind: 'overdue', days: -2 }), '已逾期 2 天');
  setUiLanguage('en');
  assert.equal(dueText({ kind: 'today', days: 0 }), 'Due today');
  assert.equal(dueText({ kind: 'soon', days: 3 }), 'In 3 days');
  assert.equal(dueText({ kind: 'overdue', days: -2 }), '2 days overdue');
  assert.equal(dueText({ kind: 'overdue', days: -1 }), '1 day overdue');
  setUiLanguage('zh');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'course', course: 'Platform Engineering' }, library).text, '课程 · Platform Engineering');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'card', deckId: 'deck-a', cardId: 'q1' }, library).text, '题目 · Kubernetes basics');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'source', id: 's1' }, library).text, '资料 · Lecture 3 slides');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'note', id: 'n1' }, library).text, '笔记 · Week 2 notes');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'skeleton', id: 'k1' }, library).text, '知识骨架 · Platform map');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'workflow', sessionId: 'w1' }, library).text, '学习流', 'unknown names fall back to the kind');
  assert.equal(studyRefLabel({ root: '/elsewhere', kind: 'source', id: 's1' }, library).text, '资料', 'another library is never resolved against this one');
  assert.equal(studyRefLabel({ root: '/lib', kind: 'course', course: '' }, library).text, '未分类课程');
});

test('a card is calm: 2-line title, markdown note with a real expand button, no arrow row', () => {
  const html = cardHtml('a');
  assert.match(html, /board-card__title/);
  assert.match(html, /SCS TechConnect 2026 校园招聘\/职业活动/);
  assert.match(html, /board-card__note/);
  assert.match(html, /<strong>报名<\/strong>/, 'the note is rendered as Markdown');
  assert.match(html, /data-collapsed="true"/);
  assert.match(html, /<button[^>]*board-card__toggle[^>]*aria-expanded="false"[^>]*>展开<\/button>/);
  assert.doesNotMatch(html, /…|\.\.\./, 'nothing is cut with a literal ellipsis');
  assert.doesNotMatch(html, /board-card-controls|左移|右移|aria-label="[^"]*[←→↑↓]/, 'the arrow button row is gone');
  assert.match(html, /tabindex="0"/, 'the card itself is focusable');
  assert.match(html, /draggable="true"/);
  const en = cardHtml('a', 'en');
  assert.match(en, /aria-expanded="false"[^>]*>Expand<\/button>/);
});

test('a short note has no expand button; a card without a note has no note block', () => {
  assert.doesNotMatch(cardHtml('c'), /board-card__toggle/);
  assert.match(cardHtml('c'), /<strong>3<\/strong>/);
  assert.doesNotMatch(cardHtml('d'), /board-card__note/);
});

test('labels are small neutral chips with a stable hue class each, never all one colour', () => {
  const html = cardHtml('a');
  for (const label of ['career', 'event', 'SIT'])
    assert.match(html, new RegExp(`class="board-chip board-hue-${labelHue(label)}"[^>]*>(?:<[^>]+>)*${label}`), `${label} chip carries its own hue`);
  assert.doesNotMatch(html, /board-chip[^"]*(bad|danger|red)/);
  assert.equal(labelHue('career'), labelHue('career'));
  // the same label gets the same class on another card
  assert.match(cardHtml('e'), new RegExp(`board-hue-${labelHue('career')}`));
});

test('the due chip shows an icon and relative text; overdue is danger only when the card is open', () => {
  const later = cardHtml('a');
  assert.match(later, /board-due is-later/);
  assert.match(later, /17 天后/);
  assert.match(later, /<svg[^>]*class="sh-icon[^"]*"/, 'chips carry an icon');
  const overdue = cardHtml('b');
  assert.match(overdue, /board-due is-overdue/);
  assert.match(overdue, /已逾期 2 天/);
  assert.match(cardHtml('c'), /board-due is-today[^"]*"[^>]*>(?:<[^>]+>)*今天截止/);
  assert.match(cardHtml('d'), /board-due is-soon/);
  const done = cardHtml('e');
  assert.doesNotMatch(done, /is-overdue/, 'a finished card is never flagged overdue');
  assert.doesNotMatch(done, /已逾期/);
  assert.match(done, /board-card is-done/);
  assert.match(cardHtml('b', 'en'), /2 days overdue/);
});

test('the checklist progress shows on the card and the done circle is a labelled checkbox', () => {
  const html = cardHtml('b');
  assert.match(html, /board-progress[^>]*>(?:<[^>]+>)*1\/3/);
  assert.match(html, /role="checkbox"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="checkbox"/);
  assert.match(html, /aria-label="标记完成：Platform Engineering 期末复习"/);
  const done = cardHtml('e');
  assert.match(done, /aria-checked="true"/);
  assert.match(done, /aria-label="标记为未完成：旧任务"/);
  assert.match(cardHtml('e', 'en'), /aria-label="Mark as not done: 旧任务"/);
  assert.doesNotMatch(cardHtml('a'), /board-progress/, 'no checklist, no progress chip');
});

test('the meta row names the origin workspace and the study link with icons', () => {
  const html = cardHtml('b');
  assert.match(html, /board-meta/);
  assert.match(html, /SWE5001/);
  assert.match(html, /课程 · Platform Engineering/);
  assert.doesNotMatch(html, /打开关联内容/, 'the old meaningless label is gone');
  assert.match(cardHtml('d'), /题目 · Kubernetes basics/);
  assert.match(cardHtml('d', 'en'), /Question · Kubernetes basics/);
  assert.match(cardHtml('d', 'en', {}), /SWE5001/);
});

test('the ⋯ menu holds move-to, reorder, edit, archive and delete', () => {
  const html = cardHtml('a', 'zh', { menuOpen: true });
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /role="menu"/);
  for (const label of ['移到', '进行中', '已完成', '上移', '下移', '编辑', '归档', '删除'])
    assert.ok(strip(html).includes(label), `menu has ${label}`);
  assert.doesNotMatch(strip(html.replace(/<[^>]*role="menuitem"[^>]*>\s*(?:<[^>]+>)*待办/, '')), /移到\s+待办\s/, 'the current column is not offered as a destination');
  assert.match(html, /role="menuitem"[^>]*disabled=""[^>]*>(?:<[^>]+>)*上移/, 'the first card cannot move up');
  const en = cardHtml('a', 'en', { menuOpen: true });
  for (const label of ['Move to', 'Move up', 'Move down', 'Edit', 'Archive', 'Delete']) assert.ok(strip(en).includes(label), `en menu has ${label}`);
  assert.match(cardHtml('a'), /aria-label="更多操作：SCS TechConnect/);
});

test('Menu renders items only when open and marks the danger item', () => {
  const closed = render(React.createElement(Menu, { label: '更多', items: [{ id: 'x', label: '删除', danger: true }], onSelect: noop }));
  assert.doesNotMatch(closed, /role="menu"/);
  const open = render(React.createElement(Menu, { label: '更多', defaultOpen: true, items: [{ id: 'x', label: '删除', danger: true }, { id: 'y', label: '只读', disabled: true, hint: '原因' }], onSelect: noop }));
  assert.match(open, /role="menu"/);
  assert.match(open, /is-danger/);
  assert.match(open, /原因/);
});

test('the composer: title textarea, optional due and labels, and the study link as a removable chip', () => {
  const html = render(React.createElement(Composer, { columnTitle: '待办', studyRef: { root: '/lib', kind: 'course', course: 'Platform Engineering' }, library,
    labelSuggestions: ['exam', 'career'], onSubmit: async () => true, onClose: noop, onClearStudyRef: noop }));
  assert.match(html, /<textarea[^>]*aria-label="待办卡片标题"|<textarea[^>]*placeholder="想做什么？"/);
  assert.match(html, /type="date"/);
  assert.match(html, /截止日期/);
  assert.match(html, /标签/);
  assert.match(html, /<datalist[^>]*>[\s\S]*value="exam"/);
  assert.match(html, /board-study-chip/);
  assert.match(html, /关联：课程 · Platform Engineering/);
  assert.match(html, /aria-label="取消关联"/);
  assert.match(html, /添加/);
  assert.match(html, /完成|关闭/);
  assert.doesNotMatch(html, /不关联/, 'no orphan "do not link" button');
  const en = render(React.createElement(Composer, { columnTitle: 'To do', studyRef: { root: '/lib', kind: 'course', course: 'Platform Engineering' }, library,
    labelSuggestions: [], onSubmit: async () => true, onClose: noop, onClearStudyRef: noop }), 'en');
  assert.match(en, /Linked: Course · Platform Engineering/);
  assert.match(en, /Due date/);
  assert.match(en, /Remove link/);
});

test('the composer rejects empty and punctuation-only titles with an inline hint', () => {
  const props = { columnTitle: '待办', library, labelSuggestions: [], onSubmit: async () => true, onClose: noop };
  const empty = render(React.createElement(Composer, props));
  assert.doesNotMatch(empty, /role="alert"/, 'no scolding before the learner typed anything');
  assert.match(empty, /<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*添加/);
  const bad = render(React.createElement(Composer, { ...props, initialTitle: '?' }));
  assert.match(bad, /role="alert"/);
  assert.match(bad, /具体的待办/);
  assert.match(bad, /<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*添加/);
  const good = render(React.createElement(Composer, { ...props, initialTitle: '复习第 3 章' }));
  assert.doesNotMatch(good, /role="alert"/);
  assert.doesNotMatch(good, /<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*添加/);
});

const filterProps = (query = {}, extra = {}) => ({ query, labels: [{ label: 'exam', count: 2 }, { label: 'career', count: 1 }], onChange: noop, open: true, onToggle: noop, matched: 5, total: 5, ...extra });

test('the filter bar searches, filters by label chip and by due, and collapses to an icon on narrow screens', () => {
  const html = render(React.createElement(FilterBar, filterProps()));
  assert.match(html, /type="search"/);
  assert.match(html, /搜索待办/);
  assert.match(html, /exam/);
  assert.match(html, /只看逾期/);
  assert.match(html, /本周截止/);
  assert.match(html, /board-filter__toggle/, 'the icon button that opens the bar on narrow screens');
  const active = render(React.createElement(FilterBar, filterProps({ text: 'x', labels: ['exam'], due: 'overdue' }, { matched: 1 })));
  assert.match(active, /aria-pressed="true"[^>]*>(?:<[^>]+>)*exam/);
  assert.match(active, /aria-pressed="true"[^>]*>(?:<[^>]+>)*只看逾期/);
  assert.match(active, /1 \/ 5|1\/5/);
  assert.match(active, /清除筛选/);
  const en = render(React.createElement(FilterBar, filterProps()), 'en');
  for (const text of ['Search cards', 'Overdue only', 'Due this week']) assert.ok(en.includes(text), text);
});

const board = (state = {}, extra = {}) => React.createElement(Board, { state: { board: boardData(), error: '', conflict: false, busy: false, mutate: async () => true, refresh: noop, clearError: noop, ...state },
  library, today: TODAY, ...extra });

test('the board page: header, columns with counts, a quiet + 新建列 button instead of an always-open form', () => {
  const html = render(board());
  assert.match(html, /<h1[^>]*>待办看板<\/h1>/);
  assert.doesNotMatch(html, /ACROSS WORKSPACES/, 'no hard-coded English eyebrow');
  for (const title of ['待办', '进行中', '已完成']) assert.ok(strip(html).includes(title));
  assert.match(html, /board-count[^>]*>3</);
  assert.match(html, /新建列/);
  assert.doesNotMatch(html, /placeholder="新列名称"|aria-label="新列名称"/, 'the add-column input only appears after clicking');
  assert.match(html, /aria-label="更多操作：读论文"/);
  assert.match(html, /aria-label="列设置：待办"/);
  assert.match(html, /添加卡片/);
  assert.doesNotMatch(html, /board-card-controls|aria-label="[^"]*左移/);
  assert.match(html, /aria-live="polite"/, 'moves are announced');
  assert.match(html, /归档 \(1\)|归档<[^>]*>\s*\(1\)|归档.{0,40}1/);
  const en = render(board(), 'en');
  assert.match(en, /<h1[^>]*>Task board<\/h1>/);
  assert.match(en, /New column/);
  assert.match(en, /Add card/);
  const english = { ...boardData(), cards: Object.fromEntries(Object.entries(boardData().cards).map(([id, c]) => [id, { ...c, title: `Card ${id}`, note: '' }])),
    archived: [] };
  assert.doesNotMatch(strip(render(board({ board: english }), 'en')), han, 'English UI shows no Chinese chrome');
});

test('a card with a studyRef opens the composer with the link chip already attached', () => {
  const html = render(board({}, { studyRef: { root: '/lib', kind: 'course', course: 'Platform Engineering' } }));
  assert.match(html, /board-composer/);
  assert.match(html, /关联：课程 · Platform Engineering/);
});

test('an empty board explains what it is for and how cards get here', () => {
  const empty = { ...boardData(), cards: {}, archived: [], columns: boardData().columns.map((c) => ({ ...c, cardIds: [] })) };
  const html = render(board({ board: empty }));
  assert.match(html, /sh-empty/);
  assert.match(html, /加入待办/, 'tells the learner where cards come from');
  assert.match(html, /添加第一张卡片/);
  const en = render(board({ board: empty }), 'en');
  assert.match(en, /Add to to-do/);
});

test('an empty column in a busy board shows its own small empty state', () => {
  const b = boardData();
  b.columns[1].cardIds = []; delete b.cards.d;
  const html = render(board({ board: b }));
  assert.match(html, /sh-empty--sm/);
});

test('read-only and conflict messages stay visible and plain', () => {
  const broken = { ...boardData(), readOnly: true, error: 'Cannot read board: x. Restore or repair it.' };
  assert.match(render(board({ board: broken })), /Cannot read board/);
  const conflict = render(board({ error: 'Board revision conflict: expected 1, current 2.', conflict: true }));
  assert.match(conflict, /看板已在其他位置更新/);
  assert.doesNotMatch(conflict, /Board revision conflict: expected/);
  assert.match(render(board({ error: 'Board revision conflict: expected 1, current 2.', conflict: true }), 'en'), /updated somewhere else/);
});

const editorProps = (extra = {}) => ({ card: boardData().cards.b, board: boardData(), library, today: TODAY, labelSuggestions: ['exam', 'career'], saving: false, error: '',
  onSave: async () => true, onArchive: noop, onDelete: noop, onClose: noop, ...extra });

test('card detail: title, markdown note with preview, due, labels, checklist, link, times and actions', () => {
  const html = render(React.createElement(CardEditor, editorProps()));
  assert.match(html, /<dialog[^>]*sh-dialog/);
  assert.match(html, /value="Platform Engineering 期末复习"/);
  assert.match(html, /<textarea/);
  assert.match(html, /预览/);
  assert.match(html, /type="date"[^>]*value="2026-09-30"|value="2026-09-30"[^>]*type="date"/);
  assert.match(html, /value="看第 1 章"/);
  assert.match(html, /整理错题/);
  assert.match(html, /1\/3|1 \/ 3/);
  assert.match(html, /添加子项/);
  assert.match(html, /课程 · Platform Engineering/);
  assert.match(html, /SWE5001/);
  assert.match(html, /创建于/);
  assert.match(html, /更新于/);
  assert.match(html, /归档/);
  assert.match(html, /删除/);
  assert.match(html, /board-chip is-choice board-hue-\d[^>]*>\+ career/, 'existing labels are offered as suggestions');
  assert.match(html, /保存/);
  const en = render(React.createElement(CardEditor, editorProps()), 'en');
  for (const text of ['Preview', 'Add item', 'Created', 'Updated', 'Archive', 'Delete', 'Save']) assert.ok(en.includes(text), text);
});

test('the editor shows the stale-board warning and keeps the learner’s input', () => {
  const stale = render(React.createElement(CardEditor, editorProps({ board: { ...boardData(), revision: 99 }, baseRevision: 7 })));
  assert.match(stale, /看板已在其他位置更新/);
  assert.match(stale, /载入最新卡片/);
});
