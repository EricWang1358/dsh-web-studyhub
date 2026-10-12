/* The quality workflow on screen (static zh and en): an opened knowledge point shows its free text, 「概念覆盖 N/M」 and, when short, 「未达标：缺 N 个概念」
   with the missing names and 补漏; the 总纲 page's book line says the three-level coverage; the book's 查找 lists 生词与概念 with the codes of their points; the
   task console has the lanes 清点 · 归纳 · 写 · 审阅 · 修复 and a 知识点 tab with each point's state. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as LeafNotes } from './ui/outline/LeafNotes.jsx';
  export { levelsText } from './ui/outline/words.js';
  export { default as BookLookup } from './ui/book/BookLookup.jsx';
  export { default as BookBoard } from './ui/tasks/BookBoard.jsx';
  export { timelineLegend, callLabel } from './ui/tasks/call-model.js';
  export { bookLookup, renderLookup } from './lib/course-book-lookup.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const notes = { id: 'n1', body: { text: '**CIA triad**: confidentiality, integrity, availability [^1].', status: 'short',
  coverage: { must: 4, covered: ['i00000000001'], missing: [{ id: 'i00000000002', name: 'Risk scenario' }], optional: 0 }, issues: [],
  cites: [{ n: 1, sourceId: 's1', quote: 'the CIA triad', title: 'Lecture · p. 3' }] }, concepts: { covered: 3, total: 4, missing: [{ id: 'i00000000002', name: 'Risk scenario' }] } };

test('an opened knowledge point: its text, its concept coverage, and when short what it misses with 补漏', () => {
  const html = render(h(ui.LeafNotes, { notes, onOpenSource: noop, onReadMore: noop })), text = textOf(html);
  assert.match(text, /CIA triad/);
  assert.match(text, /未达标：缺 1 个概念 Risk scenario/);
  assert.match(text, /概念覆盖 3\/4/);
  assert.match(text, /补漏/);
  assert.doesNotMatch(text, /知识梳理|一句话/, 'no template of sections');
  const ok = textOf(render(h(ui.LeafNotes, { notes: { ...notes, body: { ...notes.body, status: 'ok', coverage: { ...notes.body.coverage, missing: [] } }, concepts: { covered: 4, total: 4, missing: [] } },
    onOpenSource: noop, onReadMore: noop })));
  assert.match(ok, /概念覆盖 4\/4/);
  assert.doesNotMatch(ok, /未达标|补漏/, 'a complete point offers no gap filling');
  const en = english(() => textOf(render(h(ui.LeafNotes, { notes, onOpenSource: noop, onReadMore: noop }))));
  assert.match(en, /Short: 1 concept\(s\) missing/);
  assert.match(en, /Concepts covered 3\/4/);
  assert.match(en, /Fill the gaps/);
  assert.doesNotMatch(en.replace(/CIA triad|Risk scenario/g, ''), han);
});

test('the book\'s coverage at three levels, and the glossary in the lookup pages', () => {
  const levels = { documents: { used: 3, total: 4 }, pages: { read: 40, total: 52 }, leaves: { ok: 18, total: 19 }, items: { covered: 77, total: 78 } };
  assert.equal(ui.levelsText(levels), '覆盖：资料用了 3/4 份、页 40/52；知识点达标 18/19；概念 77/78');
  assert.equal(english(() => ui.levelsText(levels)), 'Coverage: materials 3/4, pages 40/52; knowledge points complete 18/19; concepts 77/78');
  const book = { status: 'ok', title: '复习全书 · SA', language: 'zh', unplaced: { title: '未归位', text: '' },
    nodes: [{ hid: 'h1', key: 'bk:c', title: 'Security', number: '1', leaf: false, children: [{ hid: 'h2', key: 'bk:p', title: 'CIA triad', number: '1.1', leaf: true, gen: 'x', mine: '', qa: '', children: [] }] }],
    glossary: [{ term: 'Availability', gist: 'being there when needed', kind: 'term', hid: 'h2', material: 'Lecture', page: 3 }, { term: 'CIA triad', gist: 'the three goals', kind: 'concept', hid: 'h2', material: 'Lecture' }] };
  const lookup = ui.bookLookup(book, {});
  assert.deepEqual(lookup.glossary.map(entry => entry.term), ['Availability', 'CIA triad']);
  assert.ok(lookup.concepts.some(item => item.term === 'CIA triad' && item.from.includes('glossary')), 'a glossary term is listed by concept too');
  const text = textOf(render(h(ui.BookLookup, { lookup, onGo: noop })));
  assert.match(text, /生词与概念/);
  assert.match(text, /Availability ：being there when needed H2 第 3 页/);
  assert.match(ui.renderLookup(lookup), /### 生词与概念 \{#lookup-glossary\}\n\n- \*\*Availability\*\*：being there when needed \[H2\]\(#h2\)（第 3 页）/);
  assert.match(english(() => textOf(render(h(ui.BookLookup, { lookup, onGo: noop })))), /Glossary/);
});

test('the task console: the book\'s lanes and a 知识点 tab with each point\'s state', () => {
  assert.deepEqual(ui.timelineLegend('generation', 'course-book-build').map(([kind]) => kind), ['inventory', 'outline', 'write', 'review', 'repair']);
  assert.deepEqual(ui.timelineLegend('generation', 'course-book-build').map(([, label]) => label), ['清点', '归纳', '写', '审阅', '修复']);
  assert.equal(ui.callLabel({ kind: 'review', stage: 'review', part: 3, parts: 19 }), '审阅讲解 3/19');
  assert.equal(ui.callLabel({ kind: 'repair', stage: 'Repairing flagged questions within this run' }), '修复题目', 'a question run keeps its words');
  const contract = { detail: { book: { board: [{ id: 'a', title: 'CIA triad', status: 'ok', must: 4, missing: 0 }, { id: 'b', title: 'Risk', status: 'short', must: 5, missing: 2 },
    { id: 'c', title: 'Threats', status: 'writing', must: 3 }] } } };
  const text = textOf(render(h(ui.BookBoard, { contract })));
  assert.match(text, /CIA triad 概念 4\/4 达标/);
  assert.match(text, /Risk 概念 3\/5 未达标/);
  assert.match(text, /Threats 在写/);
  assert.match(english(() => textOf(render(h(ui.BookBoard, { contract })))), /Risk Concepts 3\/5 Short/);
});
