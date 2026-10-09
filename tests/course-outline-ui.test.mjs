/* The 总纲 page drawn (zh and en) from a course.outline answer, its rows and keys (pure), the registry row that reaches it, and the home:
   the folded 课程路线 list is gone, the course area links to the 总纲, and the home keeps its one continue button. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { default as CourseOutline, CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export * from './ui/outline/model.js';
  export { default as CourseRoute } from './ui/CourseRoute.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { PAGES, backLabelOf, navLabelOf } from './ui/pages.js';
  export { pageAvailable } from './ui/capabilities.js';`);
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const summary = (total, state = 'learning', percent = 40) => ({ total, counts: { new: 0, weak: 0, learning: total, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: 0, inactive: 0, percent: total ? percent : null, state: total ? state : 'none' });
const outline = {
  status: 'ok', course: 'Databases', total: 5, placed: 4, summary: summary(5), draftCards: 2, limit: 200,
  decks: [{ id: 'd1', title: 'Indexes deck', total: 4 }, { id: 'd2', title: 'Fuzzy deck', total: 1 }], deckId: null,
  documents: [
    { key: 'pdf:book', title: 'book.pdf', format: 'pdf', chapters: 2, total: 4, summary: summary(4), deckCount: 2 },
    { key: 'source:empty', title: 'Unused slides', format: 'text', chapters: 0, total: 0, summary: summary(0), deckCount: 0 },
  ],
  unplaced: { key: 'unplaced', total: 1, summary: summary(1, 'unlearned', 0), reasons: { none: 1, elsewhere: 0, missing: 0 } },
  open: {},
};
const details = {
  'pdf:book': { chapters: [
    { key: 'pdf:book#0', kind: 'chapter', index: 0, title: 'Indexes', level: 1, total: 3, summary: summary(3), deckCount: 2 },
    { key: 'pdf:book#1', kind: 'chapter', index: 1, title: 'Transactions', level: 1, total: 2, summary: summary(2), deckCount: 1, resume: { runId: 'r1', index: 1, total: 2 } },
  ] },
  'pdf:book#0': { cards: [
    { deckId: 'd1', cardId: 'c1', deckTitle: 'Indexes deck', prompt: 'What does a B-tree index speed up?', level: 'learning', due: true },
    { deckId: 'd1', cardId: 'c3', deckTitle: 'Indexes deck', prompt: 'Why is a covering index cheaper?', level: 'new', due: false, shared: true },
  ], more: 0 },
  unplaced: { cards: [{ deckId: 'd1', cardId: 'c4', deckTitle: 'Indexes deck', prompt: 'A question with no source', level: 'new', due: false, reason: 'none' }], more: 0 },
};
const actions = { onBack: noop, onCreate: noop, retry: noop, toggle: noop, onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop };
const page = (extra = {}) => render(h(ui.CourseOutlineView, { course: 'Databases', outline, details, open: new Set(['pdf:book', 'pdf:book#0', 'unplaced']), pick: ui.emptyPick(), actions, ...extra }));
const DATA = /Databases|book\.pdf|Unused slides|Indexes deck|Fuzzy deck|Indexes|Transactions|What does a B-tree index speed up\?|Why is a covering index cheaper\?|A question with no source/g;

test('the rows: documents, the chapters of an open one, 未归位 last; the keys walk and open them', () => {
  const rows = ui.outlineRows(outline, details, new Set(['pdf:book']));
  assert.deepEqual(rows.map(row => [row.key, row.level, row.kind, row.hasChildren]),
    [['pdf:book', 1, 'document', true], ['pdf:book#0', 2, 'chapter', false], ['pdf:book#1', 2, 'chapter', false], ['source:empty', 1, 'document', false], ['unplaced', 1, 'unplaced', false]]);
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book', 'ArrowRight'), { focus: 'pdf:book#0' }, 'an open document: Right goes to its first chapter');
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book#0', 'ArrowRight'), { toggle: 'pdf:book#0', open: true }, 'a chapter opens its questions');
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book#1', 'ArrowLeft'), { focus: 'pdf:book' });
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book', 'ArrowLeft'), { toggle: 'pdf:book', open: false });
  assert.deepEqual(ui.outlineKey(rows, 'source:empty', 'End'), { focus: 'unplaced' });
  assert.equal(ui.outlineKey(rows, 'pdf:book', 'a'), null);
  const closed = ui.outlineRows(outline, details, new Set());
  assert.deepEqual(closed.map(row => row.key), ['pdf:book', 'source:empty', 'unplaced']);
});

test('the pick: rows and questions, as the argument course.outline takes, and a question in a picked row shows ticked', () => {
  let pick = ui.pickRow(ui.emptyPick(), 'pdf:book#0', true);
  pick = ui.pickCard(pick, { deckId: 'd1', cardId: 'c4' }, true);
  assert.deepEqual(ui.pickArgs(pick), { keys: ['pdf:book#0'], cards: [{ deckId: 'd1', cardId: 'c4' }] });
  assert.equal(ui.cardTicked(pick, { deckId: 'd1', cardId: 'c1' }, ['pdf:book#0', 'pdf:book']), true);
  assert.equal(ui.cardTicked(pick, { deckId: 'd1', cardId: 'c1' }, ['pdf:book#1']), false);
  assert.equal(ui.isPicked(ui.pickRow(pick, 'pdf:book#0', false)), true, 'the question picked alone stays');
  ui.keepView('root', 'Databases', { open: new Set(['pdf:book']), deckId: 'd2' });
  assert.deepEqual(ui.keptView('root', 'Databases'), { open: ['pdf:book'], deckId: 'd2' });
  assert.equal(ui.keptView('root', 'Other'), null);
});

test('the page: title, mastery in the 资料 list\'s words, the rows with 练这一节 / 接着练, the questions with their deck and level, 未归位', () => {
  const html = page(), text = textOf(html);
  assert.match(text, /总纲 · Databases/);
  assert.match(text, /返回学习库/);
  assert.match(text, /掌握 40% · 5 题/, 'the course line: MasteryLine, the 资料 list\'s words');
  assert.match(text, /2 份资料 · 草稿里另有 2 题（发布后计入）/);
  assert.match(text, /Indexes 掌握 40% · 3 题/);
  assert.match(text, /练这一节/);
  assert.match(text, /接着练 2\/2/, 'a row with an unfinished round of its questions goes on with it');
  assert.match(text, /Unused slides 还没出题/);
  assert.match(text, /What does a B-tree index speed up\? Indexes deck/);
  assert.match(text, /学习中 到期/);
  assert.match(text, /也列在别处/);
  assert.match(text, /未归位 未学 · 1 题/);
  assert.match(text, /A question with no source Indexes deck · 没有引用资料/);
  const tree = dom(html).all;
  const toggles = tree.filter(node => node.getAttribute('data-outline-toggle') !== null);
  assert.deepEqual(toggles.map(node => node.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1'], 'one tab stop for the row buttons');
  assert.equal(toggles[0].getAttribute('aria-expanded'), 'true');
  assert.equal(tree.filter(node => node.getAttribute('class')?.includes('outline-bar')).length, 0, 'nothing picked: no bar');
});

test('the one hover explanation says what the outline is and how a round orders its questions; it is reachable by keyboard', () => {
  const html = page(), nodes = dom(html).all;
  const tips = nodes.filter(node => node.getAttribute('role') === 'tooltip');
  const what = tips.find(tip => /总纲把这门课的资料/.test(tip.textContent));
  assert.ok(what, 'the explanation is there');
  assert.match(what.textContent, /到期 → 薄弱 → 新题/);
  assert.match(what.textContent, /一轮最多 200 题/);
  const anchor = nodes.find(node => (node.getAttribute('aria-describedby') || '').split(/\s+/).includes(what.getAttribute('id')));
  assert.equal(anchor?.getAttribute('tabindex'), '0');
});

test('a pick shows the bar with the de-duplicated count and, over 200, what a round takes', () => {
  const pick = ui.pickRow(ui.emptyPick(), 'pdf:book', true);
  const counting = textOf(page({ pick }));
  assert.match(counting, /正在计算…/);
  const html = page({ pick, picked: { scope: [], total: 250, capped: true, limit: 200 } }), text = textOf(html);
  assert.match(text, /已选 250 题/);
  assert.match(text, /共 250 题，一轮最多 200 题：先练到期、薄弱和新题里排在前面的 200 题。/);
  assert.match(text, /练选中的 200 题/);
  assert.equal((html.match(/data-variant="primary"|sh-btn--primary/g) || []).length, 1, 'one primary on the page');
});

test('the empty states: no question yet points to 创建题组; loading and failure', () => {
  const none = textOf(render(h(ui.CourseOutlineView, { course: 'Databases', outline: { ...outline, total: 0, placed: 0, documents: [outline.documents[1]], unplaced: { ...outline.unplaced, total: 0 } },
    details: {}, open: new Set(), pick: ui.emptyPick(), actions })));
  assert.match(none, /这门课还没有题/);
  assert.match(none, /创建题组/);
  const loading = textOf(render(h(ui.CourseOutline, { data: { root: 'r', revision: 1, focus: { course: 'Databases' } }, onBack: noop, onCreate: noop, onPractice: noop })));
  assert.match(loading, /正在读取总纲…/);
  assert.match(textOf(render(h(ui.CourseOutlineView, { course: 'Databases', outline: null, error: new Error('boom'), open: new Set(), pick: ui.emptyPick(), actions }))), /总纲读取失败/);
});

test('in English the page has no Chinese of its own', () => {
  const pick = ui.pickRow(ui.emptyPick(), 'pdf:book', true);
  english(() => {
    const text = textOf(page({ pick, picked: { scope: [], total: 250, capped: true, limit: 200 } })).replace(DATA, '');
    assert.doesNotMatch(text, han, text.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    assert.match(text, /Course outline · /);
    assert.match(text, /Practise this/);
    assert.match(text, /Not placed/);
    assert.match(text, /What is the outline\?/);
  });
});

test('the page is in the registry, reached from the home, not in the sidebar, and the way back from a round names it', () => {
  assert.deepEqual({ ...ui.PAGES.outline }, { label: '总纲', title: '总纲', glyph: null, group: null, needs: ['bank', 'study', 'materials'], back: '返回总纲' });
  assert.equal(ui.navLabelOf('outline'), undefined);
  assert.equal(ui.backLabelOf('outline'), '返回总纲');
  assert.equal(ui.backLabelOf('graph'), undefined, 'the other pages keep their way back');
  const views = readFileSync('ui/app/page-views.jsx', 'utf8');
  assert.match(views, /outline: OutlineView/);
  assert.match(views, /onShowOutline: pageAvailable\(data, 'outline'\) \? \(\) => nav\.navigate\('outline'\)/);
  assert.match(readFileSync('ui/app/use-learning-navigation.js', 'utf8'), /backLabelOf\(origin\.page\)/);
});

test('the home: the folded 课程路线 list is gone, the course area links to the 总纲 instead', () => {
  const route = { course: 'Databases', cards: 10, learned: 4, mastered: 1, weak: 0, current: 0, next: null,
    chapters: [{ deckId: 'd1', title: 'Indexes deck', total: 6, learned: 4, weak: 0, mastered: 1, status: 'current' }, { deckId: 'd2', title: 'Fuzzy deck', total: 4, learned: 0, weak: 0, mastered: 0, status: 'upcoming' }] };
  const html = render(h(ui.CourseRoute, { route, onShowOutline: noop })), text = textOf(html);
  assert.doesNotMatch(html, /<details/, 'no folded list');
  assert.doesNotMatch(text, /课程路线 ·|从这一章学|接着学/);
  assert.match(text, /课程进度/);
  assert.match(text, /总纲 按资料的章节找题、挑题练/);
  assert.doesNotMatch(textOf(render(h(ui.CourseRoute, { route }))), /总纲/, 'without the page, no link');
  const desk = readFileSync('ui/study-map/DeskIntro.jsx', 'utf8');
  assert.match(desk, /<CourseRoute route=\{route\} onShowOutline=\{onShowOutline\} \/>/);
  assert.doesNotMatch(desk, /onStartChapter/);
});
