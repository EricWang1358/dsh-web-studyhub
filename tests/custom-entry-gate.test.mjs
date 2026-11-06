/* 深度定制 entry that stays (the 资料 row) and the gate before a whole-book spend (the 总纲 page). A document of CUSTOM_BOOK_PAGES pages or more has a quiet
   「深度定制」 on its 资料 row all the time (「查看/修改定制」 once its course has a plan), and 「生成总纲」 / 「生成复习全书」 of a course with such a document and
   no plan ask first: 深度定制这本书（推荐） / 整本生成 / 取消, with a rough size from the build's own estimate (no model call). Static markup and pure functions; the
   clicks in the real page are tests/custom-entry-gate-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

const ui = await loadUi(`
  export { CUSTOM_BOOK_PAGES, customRowOffer, customGateOf, CUSTOM_ROW_LABEL, CUSTOM_ROW_EDIT_LABEL } from './ui/custom-entry.js';
  export { default as Sources } from './ui/Sources.jsx';
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { default as CustomGate, gateScaleOf } from './ui/outline/CustomGate.jsx';
  export { emptyPick } from './ui/outline/model.js';
  export { groupSourcesByDocument } from './lib/source-groups.js';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const inLanguage = (language, run) => { try { ui.setUiLanguage(language); return run(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/* ---- a converted book of `pages` pages, in `courses` ---- */
const book = (pages, { courses = ['宏经'], id = 'bigbook' } = {}) => Array.from({ length: pages }, (_, index) => ({
  id: `${id}-p${index + 1}`, title: `Macro book · p. ${index + 1}`, text: `Page ${index + 1} of the macro book.`, createdAt: '2026-11-01T08:00:00.000Z', courses,
  document: { materialId: `document-${id}`, page: index + 1, totalPages: pages, format: 'pdf', origin: 'converted', converter: 'mineru', filename: `${id}.pdf`, extractionVersion: 2 } }));
const note = { id: 'note', title: 'Lecture note', text: 'x'.repeat(40_000), createdAt: '2026-11-01T08:00:00.000Z', courses: ['宏经'], document: { materialId: 'document-note', format: 'md', filename: 'note.md' } };
const library = (sources, courses = [{ name: '宏经' }]) => ({ root: 'lib', sources, decks: [], drafts: [], jobs: [], settings: {}, courses, focus: { course: '宏经', courses: courses.map(({ name }) => ({ name })) }, modelReady: true });
const sourcesPage = data => renderToStaticMarkup(withStudy(ui.StudyServicesContext, h(ui.Sources, { data, setModal: noop, onGenerate: noop }), { act: noop, call: noop }));
const articleOf = (html, key) => html.split('<article').slice(1).map(part => '<article' + part.split('</article>')[0]).find(part => part.includes(`data-document-key="${key}"`));
const itemsOf = sources => ui.groupSourcesByDocument(sources);

/* ================= A: the entry on the 资料 row ================= */

test('the offer of a row: a paged document of 150 pages or more, with what the hand-off needs; not below, not a short text, not an archived one', () => {
  assert.equal(ui.CUSTOM_BOOK_PAGES, 150);
  const [big] = itemsOf(book(150));
  assert.deepEqual(ui.customRowOffer(big, [{ name: '宏经' }]), { course: '宏经', document: 'document-bigbook', pages: 150, hasCustom: false });
  assert.equal(ui.customRowOffer(itemsOf(book(149))[0], []), null, '149 pages');
  assert.equal(ui.customRowOffer(itemsOf([note])[0], []), null, 'a text is not paged');
  assert.equal(ui.customRowOffer({ ...big, archived: true }, []), null, 'an archived row offers nothing');
  assert.equal(ui.customRowOffer(null, []), null);
});

test('the offer follows the course plan: a course record with `custom` makes it hasCustom; a document in several courses names the one with the plan; in none, an empty course', () => {
  const [two] = itemsOf(book(200, { courses: ['微观', '宏经'] }));
  const records = [{ name: '微观' }, { name: '宏经', custom: { version: 1 } }];
  assert.deepEqual(ui.customRowOffer(two, records), { course: '宏经', document: 'document-bigbook', pages: 200, hasCustom: true });
  assert.deepEqual(ui.customRowOffer(two, [{ name: '微观' }, { name: '宏经' }]), { course: '微观', document: 'document-bigbook', pages: 200, hasCustom: false }, 'no plan: the first course');
  const [none] = itemsOf(book(200, { courses: [] }));
  assert.deepEqual(ui.customRowOffer(none, records), { course: '', document: 'document-bigbook', pages: 200, hasCustom: false });
  assert.equal(ui.customRowOffer(two, undefined).hasCustom, false, 'a snapshot without course records');
});

test('the message the row sends is the existing custom.start one (the same text as the other entries): the course, the document key and its pages; with a plan, only what changed is asked', () => {
  const [big] = itemsOf(book(513));
  const offer = ui.customRowOffer(big, [{ name: '宏经' }]);
  const text = ui.handOffText('custom.start', offer, 'zh');
  assert.match(text, /宏经/);
  assert.match(text, /513/);
  assert.match(text, /document-bigbook/);
  const planned = ui.handOffText('custom.start', ui.customRowOffer(big, [{ name: '宏经', custom: { version: 1 } }]), 'zh');
  assert.match(planned, /已有定制/);
});

test('the 资料 row of a 150-page book has 深度定制 beside 查看 N 章, always; a 149-page book and a short note have none', () => {
  const html = sourcesPage(library([...book(150), note]));
  const row = articleOf(html, 'pdf:document-bigbook');
  assert.ok(row, 'the row');
  assert.match(row, /data-hand-off="custom\.start"/);
  assert.match(row, /data-tour="custom-book-row"/);
  const bar = /<div class="source-doc__pages-bar">([\s\S]*?)<\/div><\/div>|<div class="source-doc__pages-bar">([\s\S]*)/.exec(row);
  assert.ok(bar, 'the toggle and the entry share one line');
  assert.match(textOf(row), /查看 150 页 深度定制/, 'right after the toggle, in the toggle\'s row');
  assert.doesNotMatch(row, /查看\/修改定制/);
  assert.doesNotMatch(articleOf(html, 'source:note') ?? '', /custom\.start/);
  assert.doesNotMatch(sourcesPage(library(book(149))), /custom\.start/);
  // not once only: drawing the page again (it was pressed before) still offers it
  assert.match(sourcesPage(library([...book(150), note])), /data-hand-off="custom\.start"/);
});

test('a course that has a plan reads 查看/修改定制; the entry is a quiet link-sized button with a Tooltip, never a title attribute', () => {
  const html = sourcesPage(library(book(513), [{ name: '宏经', custom: { version: 1, purpose: 'exam' } }]));
  const row = articleOf(html, 'pdf:document-bigbook');
  assert.match(row, />查看\/修改定制</);
  assert.doesNotMatch(row, />深度定制</);
  const button = /<button[^>]*data-hand-off="custom\.start"[^>]*>/.exec(row)[0];
  assert.match(button, /sh-btn--quiet/);
  assert.doesNotMatch(button, /title=/);
});

test('English: both labels and the hover have the English of the catalogue', () => {
  inLanguage('en', () => {
    const plain = articleOf(sourcesPage(library(book(200))), 'pdf:document-bigbook');
    assert.match(plain, />Customize in depth</);
    assert.doesNotMatch(textOf(plain).replace(/Macro book|bigbook|宏经/g, ''), han);
    const planned = articleOf(sourcesPage(library(book(200), [{ name: '宏经', custom: { version: 1 } }])), 'pdf:document-bigbook');
    assert.match(planned, />View \/ change the custom plan</);
    assert.doesNotMatch(textOf(planned).replace(/Macro book|bigbook|宏经/g, ''), han);
  });
});

/* ================= B: the gate on the 总纲 page ================= */

test('the gate applies to a course with a document of 150 pages or more and no plan; the largest is named, one document is passed on', () => {
  const items = itemsOf([...book(513), note]);
  const within = () => true;
  assert.deepEqual(ui.customGateOf({ items, course: '宏经', records: [{ name: '宏经' }], within }), { pages: 513, document: 'document-bigbook', docPages: 513 });
  assert.equal(ui.customGateOf({ items, course: '宏经', records: [{ name: '宏经', custom: { version: 1 } }], within }), null, 'a plan: no gate');
  assert.equal(ui.customGateOf({ items: itemsOf([...book(149), note]), course: '宏经', records: [], within }), null, 'no big document: no gate');
  assert.equal(ui.customGateOf({ items, course: null, records: [], within }), null, 'no course');
  assert.equal(ui.customGateOf({ items: items.map(item => ({ ...item, archived: true })), course: '宏经', records: [], within }), null, 'archived documents do not count');
  assert.equal(ui.customGateOf({ items, course: '宏经', records: [], within: item => item.courses.includes('微观') }), null, 'a document of another course does not count');
  const two = itemsOf([...book(200, { id: 'a' }), ...book(300, { id: 'b' })]);
  assert.deepEqual(ui.customGateOf({ items: two, course: '宏经', records: [], within }), { pages: 300, document: '', docPages: 0 }, 'two big books: the course, not one of them');
});

const gate = { pages: 513, document: 'document-bigbook', docPages: 513 };
const gateHtml = (props = {}) => renderToStaticMarkup(withStudy(ui.StudyServicesContext, h(ui.CustomGate, { kind: 'outline', gate, scale: null, onCustom: noop, onWhole: noop, onClose: noop, ...props })));
const buttonsOf = html => [...html.matchAll(/<button[^>]*class="[^"]*sh-btn[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map(match => textOf(match[1]).trim()).filter(Boolean);

test('the gate offers 深度定制这本书（推荐）, 整本生成, 取消, in that order, and says what the click would do in plain words', () => {
  const html = gateHtml();
  assert.deepEqual(buttonsOf(html).filter(label => label !== '关闭'), ['深度定制这本书（推荐）', '整本生成', '取消']);
  const primaries = [...html.matchAll(/<button[^>]*sh-btn--primary[^>]*>([\s\S]*?)<\/button>/g)].map(match => textOf(match[1]).trim());
  assert.deepEqual(primaries, ['深度定制这本书（推荐）'], 'the recommended one is the primary');
  assert.match(textOf(html), /生成总纲.*整本读一遍.*513 页/);
  assert.match(textOf(gateHtml({ kind: 'book' })), /生成复习全书.*513 页/);
  assert.doesNotMatch(/<footer[\s\S]*<\/footer>/.exec(html)[0], /title="/, 'hover words are Tooltips, not title attributes');
  assert.equal((html.match(/role="tooltip"/g) || []).length, 3, 'each of the three buttons explains itself on hover');
});

test('the estimate of an outline build: calls as a range and the tokens of the material it reads, from the build\'s own estimate; never a price', () => {
  const scale = ui.gateScaleOf('outline', { outline: { status: 'estimate', steps: 51, estimate: { calls: 43, chars: 900000, readTokens: { low: 210000, high: 340000 } } } });
  assert.deepEqual(scale, { points: null, calls: { low: 43, high: 51 }, tokens: { low: 210000, high: 340000 }, write: null, total: null }, 'an estimate from before the writing was priced says what it always said');
  const text = textOf(gateHtml({ scale }));
  assert.match(text, /43–51 次模型调用/);
  assert.match(text, /210\.0K–340\.0K tok|210K–340K tok/);
  assert.doesNotMatch(text, /元|¥|\$|价格|费用|美元|RMB|USD|price|cost/i);
  assert.match(textOf(gateHtml({ scale: 'loading' })), /正在估算/);
  assert.doesNotMatch(textOf(gateHtml({ scale: null })), /次模型调用/, 'no estimate: no number is made up');
});

test('the estimate of a book build that already has an outline: the points, the calls and the material read of the build\'s own scale', () => {
  const answer = { book: { points: 120, chapters: null, sample: true, inventory: 0, calls: { low: 240, high: 480 }, readTokens: { low: 1_200_000, high: 2_400_000 } } };
  const scale = ui.gateScaleOf('book', answer);
  assert.equal(scale.points, 120);
  assert.deepEqual(scale.calls, { low: 240, high: 480 });
  const text = textOf(gateHtml({ kind: 'book', scale }));
  assert.match(text, /120 个知识点/);
  assert.match(text, /240–480 次模型调用/);
  assert.doesNotMatch(text, /元|¥|\$|价格|费用|美元|RMB|USD|price|cost/i);
  // no outline yet: the book build says nothing of its scale, the organising step is what is estimated first
  const first = ui.gateScaleOf('book', { outline: { status: 'estimate', steps: 20, estimate: { calls: 12, chars: 1, readTokens: { low: 5, high: 9 } } } });
  assert.equal(first.points, null);
  assert.equal(ui.gateScaleOf('book', null), null);
  assert.equal(ui.gateScaleOf('outline', { outline: { status: 'estimate', steps: 1, estimate: { calls: 0, chars: 0, readTokens: { low: 0, high: 0 } } } }), null, 'nothing to read: nothing to say');
});

test('English: every word of the gate is in the catalogue', () => {
  inLanguage('en', () => {
    const scale = ui.gateScaleOf('outline', { outline: { status: 'estimate', steps: 51, estimate: { calls: 43, chars: 1, readTokens: { low: 210000, high: 340000 } } } });
    for (const kind of ['outline', 'book']) {
      const html = gateHtml({ kind, scale });
      assert.doesNotMatch(textOf(html), han, kind);
      assert.deepEqual(buttonsOf(html).filter(label => label !== 'Close'), ['Customize this book in depth (recommended)', 'Generate the whole book', 'Cancel']);
    }
  });
});

/* ---- the page: with a gate the buttons are still there (the click opens the dialog, tests/custom-entry-gate-browser.test.mjs) ---- */
const summary = { total: 0, counts: { new: 0, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: 0, inactive: 0, percent: null, state: 'none' };
const outline = { status: 'ok', course: '宏经', total: 0, placed: 0, summary, draftCards: 0, limit: 200, decks: [], deckId: null, book: null,
  documents: [{ key: 'pdf:document-bigbook', title: 'Macro book', format: 'pdf', chapters: 24, total: 0, summary, deckCount: 0 }],
  unplaced: { key: 'unplaced', total: 0, summary, reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] }, open: {} };
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop, onPick: noop, onPickCard: noop,
  onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop };
const outlinePage = (extra = {}) => renderToStaticMarkup(withStudy(ui.StudyServicesContext, h(ui.CourseOutlineView, { course: '宏经', outline, open: new Set(), pick: ui.emptyPick(), actions, ...extra })));

test('the page with a gate still draws 生成总纲 and 生成复习全书 as before; the dialog is closed until one is pressed', () => {
  for (const extra of [{}, { gate }]) {
    const html = outlinePage(extra);
    assert.match(html, />生成总纲</);
    assert.match(html, />生成复习全书</);
    assert.doesNotMatch(html, /sh-dialog/, 'closed');
  }
});
