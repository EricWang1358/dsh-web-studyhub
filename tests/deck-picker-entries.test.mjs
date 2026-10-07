import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// The deck pickers are grouped by course ("it is so hard to find things"): one builder, the existing Combobox, every place a deck is picked by name.
const m = await loadUi(`
  export { deckEntries, deckChoices, courseOfDeck } from './ui/deck-picker-entries.js';
  export { filterEntries, flattenOptions, listRows, selectableOptions, isGroup } from './ui/components/option-list.js';
  export { default as Ingest } from './ui/Ingest.jsx';
  export { default as Manage } from './ui/Manage.jsx';
  export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const { deckEntries, deckChoices, filterEntries, flattenOptions, listRows, selectableOptions, isGroup } = m;
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

const P = 'Cloud Native Solution Design';
const deck = (id, title, extra = {}) => ({ id, title, count: 10, ...extra });
const labels = (entries) => entries.map((entry) => entry.group);
const ids = (entries) => entries.map((entry) => entry.options.map((option) => option.value));

const LIBRARY = [
  deck('a', '图与最短路', { course: 'CS2040S 数据结构', createdAt: '2026-09-01T00:00:00Z', count: 20 }),
  deck('b', '第 4 章 特征值', { course: 'MA1522 线性代数', createdAt: '2026-09-02T00:00:00Z', count: 38 }),
  deck('c', '期末 · 错题', { course: 'MA1522 线性代数', createdAt: '2026-09-10T00:00:00Z', count: 12 }),
  deck('d', '随手记', { createdAt: '2026-09-20T00:00:00Z' }),
  deck('e', 'SWE5001 MOD1 课堂实录', { folder: 'SWE5001', createdAt: '2026-08-01T00:00:00Z', count: 32 }),
];

test('decks are grouped by course; a deck with only a folder uses it; no course goes to 未分类, last', () => {
  const entries = deckEntries(LIBRARY);
  assert.deepEqual(labels(entries).slice(-1), ['未分类']);
  assert.deepEqual(new Set(labels(entries)), new Set(['CS2040S 数据结构', 'MA1522 线性代数', 'SWE5001', '未分类']));
  assert.ok(entries.every((entry) => isGroup(entry) && entry.indent === true));
  const byGroup = Object.fromEntries(entries.map((entry) => [entry.group, entry.options.map((option) => option.value)]));
  assert.deepEqual(byGroup['未分类'], ['d']);
  assert.deepEqual(byGroup.SWE5001, ['e'], 'the legacy folder is the course when there is no course');
  assert.equal(deckEntries([deck('x', 'a', { course: '  ' })])[0].group, '未分类', 'blank is no course');
  assert.equal(inLanguage('en', () => deckEntries([deck('x', 'a')])[0].group), 'Uncategorised');
});

test('a chapter is not a group: its deck sits under the course and the chapter leads the hint', () => {
  const entries = deckEntries([
    deck('1', 'Intro', { course: P, count: 5 }),
    deck('2', 'K8s drill', { course: `${P} / 05 Kubernetes`, count: 32 }),
    deck('3', 'Serverless', { course: `${P}/10 Serverless`, count: 7, focusCourse: '', courseNames: [P] }),
  ]);
  assert.deepEqual(labels(entries), [P]);
  const hints = Object.fromEntries(entries[0].options.map((option) => [option.value, option.hint]));
  assert.equal(hints['1'], '5 题');
  assert.equal(hints['2'], '05 Kubernetes · 32 题');
  assert.equal(hints['3'], '10 Serverless · 7 题', 'a no-space slash counts when the course before it is known');
  assert.equal(inLanguage('en', () => deckEntries([deck('2', 'x', { course: `${P} / 05 Kubernetes`, count: 32 })])[0].options[0].hint), '05 Kubernetes · 32 questions');
});

test('groups: the course in focus first (also when it is a chapter), then the most recently used, then by name; 未分类 last even when current', () => {
  const choices = (focus, listed = LIBRARY) => deckChoices(listed, { focus });
  assert.deepEqual(labels(deckEntries(choices({ course: 'CS2040S 数据结构' }))), ['CS2040S 数据结构', 'MA1522 线性代数', 'SWE5001', '未分类']);
  // Without a focus: the most recently changed decks decide (MA1522 has the 09-10 deck, CS2040S 09-01, SWE5001 08-01).
  assert.deepEqual(labels(deckEntries(choices(undefined))), ['MA1522 线性代数', 'CS2040S 数据结构', 'SWE5001', '未分类']);
  assert.deepEqual(labels(deckEntries(choices({ course: 'SWE5001' }))), ['SWE5001', 'MA1522 线性代数', 'CS2040S 数据结构', '未分类']);
  assert.deepEqual(labels(deckEntries(choices({ course: '' }))).slice(-1), ['未分类'], 'no course in focus: the uncategorised stay last');
  // A focused chapter makes its course current.
  const chapters = [deck('1', 'x', { course: 'Alpha', createdAt: '2026-09-30T00:00:00Z' }), deck('2', 'y', { course: `${P} / 05 K`, createdAt: '2026-01-01T00:00:00Z' })];
  assert.deepEqual(labels(deckEntries(choices({ course: `${P} / 05 K`, courses: [{ name: P }, { name: `${P} / 05 K` }] }, chapters))), [P, 'Alpha']);
  // The focus' course records say when a course was last used, beyond its decks' own dates.
  const used = [deck('1', 'x', { course: 'Alpha', createdAt: '2026-09-01T00:00:00Z' }), deck('2', 'y', { course: 'Beta', createdAt: '2026-08-01T00:00:00Z' })];
  assert.deepEqual(labels(deckEntries(choices({ courses: [{ name: 'Beta', lastUsedAt: '2026-10-01T00:00:00Z' }] }, used))), ['Beta', 'Alpha']);
  // Nothing dated at all: Chinese-aware alphabetical order, numbers in natural order.
  const plain = ['乙课', '甲课', 'Course 10', 'Course 2'].map((course, i) => deck(String(i), 't', { course }));
  const sorted = labels(deckEntries(plain));
  assert.ok(sorted.indexOf('Course 2') < sorted.indexOf('Course 10'), 'numbers are in natural order');
  assert.ok(sorted.indexOf('甲课') < sorted.indexOf('乙课'), 'Chinese names follow the pinyin collation');
});

test('inside a group the most recently changed deck comes first; undated decks keep their order after the dated ones', () => {
  const list = [deck('u1', 'undated 1', { course: 'X' }), deck('old', 'old', { course: 'X', createdAt: '2026-01-01T00:00:00Z' }),
    deck('u2', 'undated 2', { course: 'X' }), deck('new', 'new', { course: 'X', createdAt: '2026-01-01T00:00:00Z', publishedAt: '2026-05-01T00:00:00Z' }),
    deck('mid', 'mid', { course: 'X', updatedAt: '2026-03-01T00:00:00Z' })];
  assert.deepEqual(ids(deckEntries(list)), [['new', 'mid', 'old', 'u1', 'u2']]);
});

test('archived and system decks are not offered; nothing else is lost: every deck appears exactly once with a unique value', () => {
  const list = [...LIBRARY, deck('z', '已归档', { course: 'MA1522 线性代数', archived: true }), deck('s', '被消灭', { systemKind: 'slain' }), null];
  const entries = deckEntries(list);
  const values = flattenOptions(entries).map((option) => option.value);
  assert.deepEqual([...values].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(deckEntries([]), []);
  assert.deepEqual(deckEntries([deck('z', 'x', { archived: true })]), [], 'no group is left empty');
  const many = Array.from({ length: 100 }, (_, i) => deck(`d${i}`, `题组 ${i}`, { course: `课程 ${i % 7}` }));
  assert.equal(flattenOptions(deckEntries(many)).length, 100);
});

test('hints are the question count; titles are whole; duplicate titles stay distinct and are told apart by the day they were made', () => {
  const list = [deck('1', '解决方案架构导论：概念辨析与情境迁移', { course: 'SA', createdAt: '2026-09-01T10:00:00Z', count: 30 }),
    deck('2', '解决方案架构导论：概念辨析与情境迁移', { course: 'SA', createdAt: '2026-09-05T10:00:00Z', count: 31 }),
    deck('3', '解决方案架构导论：概念辨析与情境迁移与应用', { course: 'SA', createdAt: '2026-08-05T10:00:00Z' }),
    deck('4', 'no count', { course: 'SA', count: undefined })];
  const options = deckEntries(list)[0].options;
  const byId = Object.fromEntries(options.map((option) => [option.value, option]));
  assert.equal(byId['1'].label, '解决方案架构导论：概念辨析与情境迁移', 'the title is never cut');
  assert.equal(byId['1'].hint, '30 题 · 2026-09-01');
  assert.equal(byId['2'].hint, '31 题 · 2026-09-05');
  assert.equal(byId['3'].hint, '10 题', 'a title that is unique has no date');
  assert.equal(byId['4'].hint, undefined);
  assert.ok(options.every((option) => option.wrap === true), 'long titles may take two lines');
  assert.equal(new Set(options.map((option) => `${option.label}|${option.hint}`)).size, options.length, 'no two rows look the same');
});

test('deckChoices completes a bare listing from the snapshot (course, count, dates) and keeps the listing\'s own title and id', () => {
  const listed = [{ id: 'a', title: 'T', archived: false, cards: 4 }, { id: 'gone', title: 'U', archived: false, cards: 2 }];
  const choices = deckChoices(listed, { decks: [{ id: 'a', title: 'old title', course: 'C', count: 9, createdAt: '2026-01-01T00:00:00Z' }], focus: { course: 'C' } });
  assert.equal(choices[0].title, 'T');
  assert.equal(choices[0].course, 'C');
  assert.equal(choices[0].count, 9);
  assert.equal(choices[1].count, 2, 'the listing\'s card count is used when the snapshot does not know the deck');
  assert.deepEqual(labels(deckEntries(choices)), ['C', '未分类']);
  assert.deepEqual(deckChoices(undefined), []);
  assert.equal(deckChoices(listed, null).length, 2, 'no snapshot yet (the reader opens before the library has loaded)');
});

test('searching: the title or the course name; a course name shows its whole group; empty groups lose their heading; words combine across both', () => {
  const entries = deckEntries(LIBRARY);
  const found = (query) => filterEntries(entries, query);
  assert.deepEqual(flattenOptions(found('特征')).map((option) => option.value), ['b']);
  assert.deepEqual(labels(found('特征')), ['MA1522 线性代数'], 'the groups with no match have no heading');
  assert.deepEqual(flattenOptions(found('MA1522')).map((option) => option.value).sort(), ['b', 'c'], 'a course name shows the whole group');
  assert.deepEqual(flattenOptions(found('swe5001')).map((option) => option.value), ['e']);
  assert.deepEqual(flattenOptions(found('ma1522 错题')).map((option) => option.value), ['c'], 'a course word and a title word together');
  assert.deepEqual(found('没有这个'), []);
  assert.equal(found(''), entries);
  assert.deepEqual(selectableOptions(found('MA1522')).length, 2, 'headings are never choices');
  assert.deepEqual(listRows(found('MA1522')).map((row) => row.type + (row.index ?? '')), ['group', 'option0', 'option1'], 'keyboard order counts the choices only');
});

// ── The pickers themselves (a Combobox is a native <select> in a server render: what it offers is what is asserted) ──
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const optgroups = (html) => [...html.matchAll(/<optgroup label="([^"]*)">(.*?)<\/optgroup>/g)].map((match) => [match[1], [...match[2].matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((option) => text(option[1]))]);
const library = [
  deck('a', 'Graphs', { course: 'CS2040S', createdAt: '2026-09-01T00:00:00Z', count: 20 }),
  deck('b', 'Eigenvalues', { course: 'MA1522', createdAt: '2026-09-02T00:00:00Z', count: 38 }),
  deck('c', 'Final · mistakes', { course: 'MA1522', createdAt: '2026-09-10T00:00:00Z', count: 12 }),
  deck('d', 'Scratch', { createdAt: '2026-09-20T00:00:00Z', count: 3 }),
  deck('x', 'Archived', { course: 'MA1522', archived: true }),
];
const focus = { course: 'CS2040S', courses: [{ name: 'CS2040S' }, { name: 'MA1522' }] };

test('Ingest: the deck picker is grouped by course, the current course first, in Chinese and English', () => {
  const html = (language) => inLanguage(language, () => renderToStaticMarkup(React.createElement(m.Ingest, { data: { decks: library, modelReady: true, focus }, busy: false, start() {} })));
  assert.deepEqual(optgroups(html('en')), [['CS2040S', ['Graphs · 20 questions']], ['MA1522', ['Final · mistakes · 12 questions', 'Eigenvalues · 38 questions']], ['Uncategorised', ['Scratch · 3 questions']]]);
  assert.deepEqual(optgroups(html('zh')).map(([name]) => name), ['CS2040S', 'MA1522', '未分类']);
  assert.doesNotMatch(html('en').replace(/Final · mistakes|Eigenvalues|Scratch|Graphs/g, ''), /[㐀-鿿]/);
});

test('the reader\'s 补充到现有题组 picker is grouped by course and never offers an archived deck', () => {
  const html = (language) => inLanguage(language, () => renderToStaticMarkup(React.createElement(m.LearningPanel, { capture: { quote: 'q' }, decks: deckChoices(library.filter((d) => !d.archived), { focus }),
    resolution: { status: 'resolved', selection: { quote: 'q', sourceId: 's', documentId: 'doc', revision: 'r' } }, deckId: 'a', jobs: [] })));
  assert.deepEqual(optgroups(html('en')).map(([name, options]) => [name, options.length]), [['CS2040S', 1], ['MA1522', 2], ['Uncategorised', 1]]);
  assert.deepEqual(optgroups(html('zh')).map(([name]) => name), ['CS2040S', 'MA1522', '未分类']);
});

test('the merge target picker on the deck page is grouped by course and leaves out the deck itself', () => {
  const managed = { id: 'b', title: 'Eigenvalues', folder: '', cards: [] };
  const html = (language) => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.Manage, { openDraft() {}, setPage() {}, managedDeck: managed, decks: library, focus, sources: [],
    setManagedDeck() {}, folderDraft: '', setFolderDraft() {}, onRemoveDeck() {} }), { data: {} })));
  assert.deepEqual(optgroups(html('en')), [['CS2040S', ['Graphs · 20 questions']], ['MA1522', ['Final · mistakes · 12 questions']], ['Uncategorised', ['Scratch · 3 questions']]]);
  assert.deepEqual(optgroups(html('zh')).map(([name]) => name), ['CS2040S', 'MA1522', '未分类']);
});
