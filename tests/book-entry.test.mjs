/* The way into the 复习全书 (3.4.1, static zh and en): a sidebar entry in 「阶段性」 with a book icon; where it leads (the book page once its notes are written, else
   the 总纲 page); the 总纲 page's one line on what the book is (only while no book is written and the course has materials) and its one primary button; the
   book header's quiet 期末一周 date hints. Fakes only; the real page is tests/book-entry-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export * from './ui/outline/model.js';
  export { bookEntryPage, crunchDateHint } from './ui/book/model.js';
  export { NavItem } from './ui/SideNav.jsx';
  export { PAGES, navLabelOf, backLabelOf } from './ui/pages.js';
  export { NAV_DEFAULTS } from './ui/nav-order.js';
  export { USAGE_REGISTRY } from './lib/usage-registry.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage, ui } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const summary = total => ({ total, counts: { new: total, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: total, inactive: 0, percent: null, state: total ? 'new' : 'none' });
const notesLine = extra => ({ id: 'n1', createdAt: '2026-10-09T00:00:00.000Z', supersedes: null, language: 'zh', leaves: 2, papers: false, stale: false, missing: 0, changed: 0, ...extra });
const book = notes => ({ id: 'o1', title: '总纲 · SA', createdAt: null, supersedes: null, papers: 0, stale: false, orderBasis: { codes: ['logic'] }, counts: { units: 1, leftover: 0, invalid: 0, repeated: 0 }, other: null, notes,
  nodes: [{ key: 'bk:c1', id: 'c1', title: 'Thermodynamics', total: 0, summary: summary(0), deckCount: 0, depth: 1, children: [] }] });
const outline = (notes, documents = 1) => ({ status: 'ok', course: 'SA', total: 0, placed: 0, summary: summary(0), draftCards: 0, limit: 200, decks: [], deckId: null,
  documents: Array.from({ length: documents }, (_, i) => ({ key: `doc:${i}`, title: `Textbook ${i}.pdf`, format: 'pdf', chapters: 2, total: 0, summary: summary(0), deckCount: 0 })),
  unplaced: { key: 'unplaced', total: 0, summary: summary(0), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] }, book: notes === undefined ? null : book(notes), open: {} });
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, onOpenSource: noop, onOpenBook: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop, onPick: noop,
  onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop };
const page = (extra = {}) => render(h(ui.CourseOutlineView, { course: 'SA', outline: outline(undefined), details: {}, open: new Set(), pick: ui.emptyPick(), actions, ...extra }));
const buttons = html => dom(html).all.filter(item => item.tagName === 'BUTTON' || item.tagName === 'button');
const primary = html => buttons(html).filter(item => /sh-btn--primary/.test(item.getAttribute('class') || '')).map(item => item.textContent.trim());

test('the registry row: 复习全书 is a sidebar page of 阶段性 after 备考补习, with a book icon, and its way back keeps its own words', () => {
  assert.deepEqual([ui.PAGES.book.label, ui.PAGES.book.group, ui.PAGES.book.glyph], ['复习全书', 'periodic', 'book']);
  assert.deepEqual(ui.NAV_DEFAULTS.periodic, ['exam', 'examprep', 'book', 'dashboard']);
  assert.equal(ui.backLabelOf('book'), '回到复习全书', 'a practice round started in the book still says 回到复习全书, not 返回复习全书');
  assert.equal(ui.PAGES.outline.group, null, 'the 总纲 page itself is still reached from the home and from here');
  const entry = ui.USAGE_REGISTRY.find(item => item.key === 'nav.book');
  assert.deepEqual([entry.zh, entry.en, entry.group, entry.navGroup], ['复习全书', 'Review book', 'nav', 'periodic']);
});

test('the sidebar row is one line with the book icon, in Chinese and in English', () => {
  const row = () => render(h(ui.NavItem, { glyph: ui.PAGES.book.glyph, label: ui.ui(ui.PAGES.book.label), 'data-tour': 'nav-book', 'data-usage': 'nav.book' }));
  const zh = row();
  assert.match(zh, /<span class="nav-label">复习全书<\/span>/);
  assert.match(zh, /data-tour="nav-book"/);
  assert.match(zh, /<svg/, 'an icon');
  const en = english(row);
  assert.match(en, /<span class="nav-label">Review book<\/span>/);
  assert.doesNotMatch(en, han);
});

test('where the sidebar leads: the book page once its notes are written, else the 总纲 page (no outline, no course, or an outline without notes)', () => {
  assert.equal(ui.bookEntryPage({ status: 'ok', notes: true }), 'book');
  assert.equal(ui.bookEntryPage({ status: 'ok', notes: false }), 'outline');
  assert.equal(ui.bookEntryPage({ status: 'rebuild-pending', moves: {} }), 'book', 'the preview is on the book page');
  assert.equal(ui.bookEntryPage({ status: 'empty', reason: 'no-outline' }), 'outline');
  assert.equal(ui.bookEntryPage({ status: 'empty', reason: 'no-course' }), 'outline');
  assert.equal(ui.bookEntryPage(null), 'outline');
  const sidebar = readFileSync('ui/app/AppSidebar.jsx', 'utf8');
  assert.match(sidebar, /id === 'book' \? openBookEntry\(\)/, 'the book row asks first');
  assert.match(sidebar, /course\.book\.open/);
});

test('the 总纲 page says in one line what the 复习全书 is while none is written, and only then', () => {
  const line = /复习全书：按总纲给每个知识点写一段讲解/;
  assert.match(textOf(page()), line, 'no outline yet');
  assert.match(textOf(page({ outline: outline(null) })), line, 'an outline without the book');
  assert.doesNotMatch(textOf(page({ outline: outline(notesLine()) })), line, 'the book is written');
  assert.doesNotMatch(textOf(page({ outline: outline(undefined, 0) })), line, 'no materials: the empty state alone');
  assert.match(textOf(english(() => page({ outline: outline(null) }))), /Review book: a short explanation for every knowledge point/);
  assert.doesNotMatch(textOf(english(() => page({ outline: outline(null) }))), han);
});

test('one primary button: 生成总纲, then 生成复习全书, then (updating) 更新全书, and 打开书页 once the book is current', () => {
  assert.deepEqual(primary(page({ outline: { ...outline(undefined), total: 3 } })), ['生成总纲']);
  assert.deepEqual(primary(page()), ['创建题组'], 'a course without questions: 创建题组 is the empty state\'s');
  assert.deepEqual(primary(page({ outline: outline(null) })), ['生成复习全书']);
  assert.deepEqual(primary(page({ outline: outline(notesLine({ stale: true })) })), ['更新全书'], 'out of date: the update leads, 打开书页 is the quiet one beside it');
  const current = page({ outline: outline(notesLine()) });
  assert.deepEqual(primary(current), ['打开书页'], 'current notes: reading the book is the one primary button');
  const labels = buttons(current).map(item => item.textContent.trim());
  assert.ok(labels.indexOf('打开书页') < labels.indexOf('更新全书'), '打开书页 comes first in the row');
  assert.deepEqual(primary(page({ outline: outline(notesLine()), actions: { ...actions, onOpenBook: undefined } })), [], 'without a way to the book there is nothing to lead with');
});

test('the 期末一周 date hint: a link without a date, the window beside a far date, nothing inside it or after the exam', () => {
  const now = new Date(2026, 9, 11, 12);
  assert.deepEqual(ui.crunchDateHint(undefined, 21, now), { kind: 'none' });
  assert.deepEqual(ui.crunchDateHint({ format: 'other', sections: [] }, 21, now), { kind: 'none' }, 'an exam profile without a date');
  assert.deepEqual(ui.crunchDateHint({ date: '2026-12-31' }, 21, now), { kind: 'later', window: 21 });
  assert.deepEqual(ui.crunchDateHint({ date: '2026-12-31' }, 60, now), { kind: 'later', window: 60 }, 'the window is the learner\'s setting');
  assert.equal(ui.crunchDateHint({ date: '2026-11-01' }, 21, now), null, '21 days away is inside the window');
  assert.equal(ui.crunchDateHint({ date: '2026-10-11' }, 21, now), null, 'the day itself');
  assert.equal(ui.crunchDateHint({ date: '2026-10-01' }, 21, now), null, 'past: the plan says so itself');
});

test('更多 › 期末一周 wires the hint: 设置考试日期 to the course settings, or the line on 前往设置, and only for a written book', () => {
  const source = readFileSync('ui/book/BookPage.jsx', 'utf8'), menu = readFileSync('ui/book/BookMore.jsx', 'utf8'), actions = readFileSync('ui/book/more-actions.js', 'utf8');
  assert.match(source, /crunchDateHint\(courseRecord\?\.exam, crunchWindow\(data\?\.settings\?\.book\)\)/);
  assert.match(source, /book\?\.status === 'ok' && book\.notes \? crunchDateHint/, 'only with a written book');
  assert.match(menu, /期末一周在考前 \{0\} 天开始/);
  assert.match(menu, /dateHint\?\.kind === 'none' && settings && \{ id: 'exam-date'/, '设置考试日期 only without a date');
  assert.match(actions, /onCourseSettings\?\.\(courseRecord\?\.id\)/);
  const views = readFileSync('ui/app/page-views.jsx', 'utf8');
  assert.match(views, /onCourseSettings=\{settingsEntry\.setCourseSettings\}/, 'the book page opens the same course settings as the home');
});
