/* 只生成部分章节 on the 总纲 page (#708; static zh and en): the whole book stays the one main button; picking chapters is folded beside it. Each chapter says
   whether it is built (未生成 / 已生成 a/b), the pick shows its scale before it starts (points, calls, material read; no price) and the tip about cheaper ways,
   and the build sends the chapters in outline order. A book of some chapters says how many are 未生成 on its line and on their rows, and its whole-book
   button says it builds the rest. No outline yet: the way there is said (生成总纲 first). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { default as BookPick, ScaleLines, partState, pickedInOrder } from './ui/outline/BookPick.jsx';
  export * from './ui/outline/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const buttons = html => dom(html).all.filter(item => item.tagName === 'BUTTON' || item.tagName === 'button');
const primary = html => buttons(html).filter(item => /sh-btn--primary/.test(item.getAttribute('class') || '')).map(item => item.textContent.trim());
const summary = total => ({ total, counts: { new: total, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: total, inactive: 0, percent: null, state: total ? 'new' : 'none' });

const point = (id, title) => ({ key: `bk:${id}`, id, title, total: 0, summary: summary(0), deckCount: 0, depth: 2, anchors: 1, opensRows: false });
const chapter = (id, title, points) => ({ key: `bk:${id}`, id, title, total: 0, summary: summary(0), deckCount: 0, depth: 1, children: points });
const PARTS = [{ id: 'c1', title: 'Thermodynamics', points: 2, written: 2 }, { id: 'c2', title: 'Kinetics', points: 3, written: 0 },
  { id: 'c3', title: 'Equilibrium', points: 4, written: 1 }];
const notesLine = extra => ({ id: 'notes-1', createdAt: null, supersedes: null, language: 'zh', leaves: 3, papers: false, stale: false, missing: 0, changed: 0, ...extra });
const outline = ({ notes = null, parts = PARTS, extra = {} } = {}) => ({ status: 'ok', course: 'SA', total: 0, placed: 0, summary: summary(0), draftCards: 0, limit: 200, decks: [],
  deckId: null, documents: [{ key: 'doc:t', title: 'Textbook.pdf', format: 'pdf', chapters: 2, total: 0, summary: summary(0), deckCount: 0 }],
  unplaced: { key: 'unplaced', total: 0, summary: summary(0), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] },
  book: { id: 'outline-1', title: '总纲 · SA', createdAt: null, supersedes: null, papers: 0, stale: false, from: 'inventory', orderBasis: { codes: ['logic'] },
    counts: { units: 9, leftover: 0, invalid: 0, repeated: 0 }, other: null, notes, parts,
    nodes: [chapter('c1', 'Thermodynamics', [point('p1', 'Entropy'), point('p2', 'Enthalpy')]), chapter('c2', 'Kinetics', [point('p3', 'Rate laws')]),
      chapter('c3', 'Equilibrium', [point('p4', 'Le Chatelier')])], ...extra }, open: {} });
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, onOpenSource: noop, onOpenBook: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop,
  onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop, setCoverage: noop, pickScale: async () => ({}) };
const page = (args, extra = {}) => render(h(ui.CourseOutlineView, { course: 'SA', outline: outline(args), details: {}, open: new Set(), pick: ui.emptyPick(), actions, coverage: 'standard', ...extra }));
const range = (low, high) => ({ low, high });

test('an outline without a book: 生成复习全书 stays the one main button; 只生成部分章节 is folded beside it, each chapter with its points', () => {
  const html = page({ parts: PARTS.map(part => ({ ...part, written: 0 })) }), text = textOf(html);
  assert.deepEqual(primary(html), ['生成复习全书'], 'the whole book is still one click');
  assert.match(text, /只生成部分章节/);
  assert.match(text, /勾选要生成的章：只写这些章的知识点、只读它们的资料；已经写好的不会重写，也不会再花一次。/);
  assert.match(text, /Kinetics 未生成 · 3 个知识点/);
  assert.match(text, /生成所选章节/);
  const pick = buttons(html).find(item => /生成所选章节/.test(item.textContent));
  assert.ok(pick.hasAttribute('disabled'), 'nothing picked: nothing to build');
  assert.doesNotMatch(text, /章未生成/, 'a course without a book has no 未生成 line');
});

test('a book of some chapters: its line and rows say what is 未生成, the whole-book button says it builds the rest, the pick is offered again', () => {
  const html = page({ notes: notesLine() }), text = textOf(html);
  assert.match(text, /已生成 2\/3 章，其余 1 章未生成/);
  assert.match(text, /生成其他章节/);
  assert.match(text, /Thermodynamics 已生成/);
  assert.match(text, /Equilibrium 已生成 1\/4 个知识点/);
  assert.ok(buttons(html).some(item => item.textContent.trim() === '生成全部其余章节'), 'the whole-book button names what it writes');
  assert.doesNotMatch(text, /更新全书/);
  assert.doesNotMatch(text, /资料有更新/, 'not out of date');
  const rows = dom(html).all.filter(item => item.getAttribute?.('data-key') === 'bk:c2');
  assert.match(rows[0].textContent, /未生成/, 'the chapter row says it');
  assert.doesNotMatch(dom(html).all.find(item => item.getAttribute?.('data-key') === 'bk:c1').textContent, /未生成/);
});

test('no picker without a current outline, with a waiting sample or with one chapter; without an outline the way there is said', () => {
  assert.doesNotMatch(textOf(page({ extra: { stale: true } })), /只生成部分章节/, 'an outline to organise again first');
  assert.doesNotMatch(textOf(page({ extra: { from: 'descriptors' } })), /只生成部分章节/);
  assert.doesNotMatch(textOf(page({ parts: PARTS.slice(0, 1) })), /只生成部分章节/, 'one chapter: nothing to pick');
  const sample = { level: 'standard', written: true, points: [{ id: 'p1', title: 'Entropy' }, { id: 'p2', title: 'Enthalpy' }] };
  assert.doesNotMatch(textOf(page({ notes: notesLine({ sample }) })), /生成其他章节/, 'the sample card leads');
  const bare = render(h(ui.CourseOutlineView, { course: 'SA', outline: { ...outline(), book: null }, details: {}, open: new Set(), pick: ui.emptyPick(), actions, coverage: 'standard' }));
  assert.match(textOf(bare), /想先只生成几章：先点「生成总纲」（只清点资料、排章节，不写讲解），再回来选章节。/);
});

test('the scale of a pick: points, calls and the material read, the sample said, the tip; nothing to write said so; no price', () => {
  const scale = { points: 14, chapters: 2, sample: true, calls: range(28, 84), readTokens: range(120000, 410000) };
  const text = textOf(render(h(ui.ScaleLines, { scale })));
  assert.match(text, /要写 14 个知识点 · 28–84 次模型调用/);
  assert.match(text, /读资料约 120K–410K tok（不含提示和模型写出的内容）/);
  assert.match(text, /先写 2 个样例，按它们实际用的 token 推算其余的，你看过再继续/);
  assert.match(text, /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);
  assert.doesNotMatch(text, /元|￥|\$|价格|费用/);
  assert.match(textOf(render(h(ui.ScaleLines, { scale: { ...scale, points: 0 } }))), /选的章都已经写好，不用再生成/);
  assert.deepEqual(ui.pickedInOrder(PARTS, new Set(['c3', 'c1'])), ['c1', 'c3'], 'sent in outline order');
  assert.equal(ui.partState({ points: 3, written: 0 }), '未生成 · 3 个知识点');
});

test('English: the picker and the scale without a Chinese character', () => english(() => {
  const html = page({ notes: notesLine() });
  const own = dom(html).all.filter(item => /book-pick/.test(item.getAttribute?.('class') || '')).map(item => item.textContent).join(' ');
  assert.ok(own.length > 0 && !han.test(own), own);
  const scale = textOf(render(h(ui.ScaleLines, { scale: { points: 3, chapters: 1, sample: false, calls: range(6, 18), readTokens: range(1000, 3000) } })));
  assert.ok(!han.test(scale), scale);
  assert.match(textOf(html), /Build all the other chapters/);
}));
