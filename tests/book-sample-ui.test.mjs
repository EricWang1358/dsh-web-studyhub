/* The sample of a 复习全书 build on the pages (#710; static zh and en): while it waits, the 总纲's book line shows its two points, the scale of the rest (points,
   calls, tokens like DSH's panel, time at the current concurrency; no price) and the tip, with ONE primary button, 生成其余 N 个; 重做样例 is quiet (its hover
   says what it does) and leads only when the settings changed since. 更新全书 is not offered beside it. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { default as BookSample } from './ui/book/BookSample.jsx';
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

const range = (low, high) => ({ low, high });
const estimate = (extra = {}) => ({ points: { total: 40, sample: 2, rest: 38 }, calls: range(76, 120), totalTokens: range(1200000, 2400000), inputTokens: range(1000000, 2000000),
  uncachedInputTokens: range(400000, 900000), cacheReadTokens: range(600000, 1100000), outputTokens: range(200000, 400000), minutes: range(18, 31), concurrency: 4,
  stages: [{ id: 'bookPoints', calls: 95, inputTokens: range(900000, 1800000), outputTokens: range(180000, 360000) }, { id: 'exam', calls: 3, inputTokens: range(50000, 50000), outputTokens: range(9000, 9000) }],
  feature: 'other', notes: ['cache-depends', 'retries'], ...extra });
const sample = (extra = {}) => ({ level: 'standard', written: true, points: [{ id: 'p1', title: 'Entropy', hid: 'h-1' }, { id: 'p2', title: 'Enthalpy', hid: 'h-2' }], estimate: estimate(), ...extra });
const notesLine = extra => ({ id: 'course-outline-notes-1', createdAt: '2026-10-09T00:00:00.000Z', supersedes: null, language: 'zh', leaves: 2, papers: false, stale: false, missing: 0, changed: 0, ...extra });
const point = (id, title) => ({ key: `bk:${id}`, id, title, total: 0, summary: summary(0), deckCount: 0, depth: 2, anchors: 1, opensRows: false });
const outline = notes => ({ status: 'ok', course: 'SA', total: 0, placed: 0, summary: summary(0), draftCards: 0, limit: 200, decks: [], deckId: null,
  documents: [{ key: 'doc:t', title: 'Textbook.pdf', format: 'pdf', chapters: 2, total: 0, summary: summary(0), deckCount: 0 }],
  unplaced: { key: 'unplaced', total: 0, summary: summary(0), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] },
  book: { id: 'course-outline-1', title: '总纲 · SA', createdAt: null, supersedes: null, papers: 0, stale: false, orderBasis: { codes: ['logic'] },
    counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 }, other: null, notes,
    nodes: [{ key: 'bk:c1', id: 'c1', title: 'Thermodynamics', total: 0, summary: summary(0), deckCount: 0, depth: 1, children: [point('p1', 'Entropy'), point('p2', 'Enthalpy')] }] }, open: {} });
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, onOpenSource: noop, onOpenBook: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop,
  onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop, setCoverage: noop };
const page = (notes, extra = {}) => render(h(ui.CourseOutlineView, { course: 'SA', outline: outline(notes), details: {}, open: new Set(), pick: ui.emptyPick(), actions, coverage: 'standard', ...extra }));

test('a waiting sample is the 总纲 line\'s one action: 生成其余 N 个; 重做样例 quiet with a hover; no 更新全书 beside it', () => {
  assert.equal(ui.mainAction({ notes: notesLine({ sample: sample() }) }), 'sample');
  assert.equal(ui.mainAction({ notes: notesLine({ sample: sample(), stale: true }) }), 'sample', 'the sample waits even when the materials changed');
  const html = page(notesLine({ sample: sample() })), text = textOf(html);
  assert.deepEqual(primary(html), ['生成其余 38 个']);
  assert.match(text, /样例：先写了 2 个知识点/);
  assert.match(text, /典型 Entropy/);
  assert.match(text, /较重 Enthalpy/);
  assert.match(text, /整本 40 个知识点，样例 2 个，其余 38 个/);
  assert.match(text, /生成其余：预计 1\.2M–2\.4M tok · 76–120 次模型调用/);
  assert.match(text, /按现在的并行 4 个，大约 18–31 分钟/);
  assert.match(text, /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);
  assert.match(text, /重做样例/);
  assert.match(text, /改了讲解详尽程度或样卷以后，按新的设置只重写这 2 个知识点/, 'the hover of 重做样例');
  assert.doesNotMatch(text, /更新全书/, 'one way on: the sample\'s');
  assert.doesNotMatch(text, /元|￥|\$|价格|费用/, 'no prices');
  const titled = dom(html).all.filter(item => item.getAttribute?.('title') && item.getAttribute('title') !== item.getAttribute('aria-label'));
  assert.deepEqual(titled.map(item => item.getAttribute('title')), [], 'no title= on text (an icon button\'s own label only)');
});

test('changed settings or a sample not written: 重做样例 leads and 生成其余 is not offered', () => {
  const changed = page(notesLine({ sample: sample() }), { coverage: 'full' });
  assert.deepEqual(primary(changed), ['重做样例']);
  assert.match(textOf(changed), /讲解详尽程度改成了「详尽」，样例是按「标准」写的：先重做样例，再生成其余/);
  assert.ok(!buttons(changed).some(item => /生成其余/.test(item.textContent)), 'no 生成其余 button');
  const failed = page(notesLine({ sample: sample({ written: false, estimate: undefined }) }));
  assert.deepEqual(primary(failed), ['重做样例']);
  assert.match(textOf(failed), /样例没写成：模型没有给出可用的讲解/);
});

test('the scale without the provider\'s usage: points, calls and time, no token figures; minutes under one said so', () => {
  const html = render(h(ui.BookSample, { sample: sample({ estimate: estimate({ totalTokens: null, inputTokens: null, uncachedInputTokens: null, cacheReadTokens: null, outputTokens: null,
    minutes: range(0, 0) }) }), coverage: 'standard', onRest: noop, onRedo: noop })), text = textOf(html);
  assert.match(text, /生成其余：76–120 次模型调用/);
  assert.doesNotMatch(text, /tok/);
  assert.match(text, /按现在的并行 4 个，不到 1 分钟/);
  // The book page names the points as links to their headings.
  const opened = [];
  const linked = render(h(ui.BookSample, { sample: sample(), coverage: 'standard', onRest: noop, onRedo: noop, onOpen: point => opened.push(point) }));
  assert.equal(buttons(linked).filter(item => /Entropy|Enthalpy/.test(item.textContent)).length, 2);
});

test('English: the same card without a Chinese character', () => english(() => {
  const html = page(notesLine({ sample: sample() }));
  const card = textOf(html).slice(textOf(html).indexOf('Sample'));
  assert.deepEqual(primary(html), ['Build the other 38']);
  assert.match(card, /web AI/);
  const own = dom(html).all.filter(item => /book-sample/.test(item.getAttribute?.('class') || '')).map(item => item.textContent).join(' ');
  assert.ok(own.length > 0 && !han.test(own.replace(/Entropy|Enthalpy/g, '')), own);
}));
