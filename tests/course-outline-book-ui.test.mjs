/* 课程总纲 step 2 on the page (static zh and en): with an AI outline the page reads like a book's contents (第 1 章 › 1.1 › 1.1.1, each with its short
   introduction, the questions computed by the engine), what the order rests on, a staleness line and a quiet 重新整理; without one, the v3.3.0 list with one
   primary 生成总纲 and, folded, the choice of sample papers (none picked). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export * from './ui/outline/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const summary = (total, percent = 40) => ({ total, counts: { new: 0, weak: 0, learning: total, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: 0, inactive: 0, percent: total ? percent : null, state: total ? 'learning' : 'none' });
const node = (id, title, total, extra = {}) => ({ key: `bk:${id}`, id, title, total, summary: summary(total), deckCount: 1, ...extra });
const point = (id, title, total, extra = {}) => node(id, title, total, { depth: 3, anchors: 1, opensRows: false, ...extra });

const book = {
  id: 'course-outline-1', title: '总纲 · SA', createdAt: '2026-10-09T00:00:00.000Z', supersedes: null, papers: 0, stale: false,
  orderBasis: { codes: ['syllabus', 'numbering'], syllabus: 'SA 讲义大纲' }, counts: { units: 10, leftover: 1, invalid: 0, repeated: 0 },
  nodes: [
    node('c1', 'Introduction to Solution Architecture', 30, { depth: 1, intro: 'What architects do and for whom.', children: [
      node('s1', 'Foundations', 22, { depth: 2, intro: 'The ideas first.', children: [
        point('p1', 'What architects do', 14, { intro: 'Roles and decisions.', anchors: 3, opensRows: true }), point('p2', 'Stakeholders and concerns', 8)] }),
      node('s2', 'In practice', 8, { depth: 2, children: [point('p3', 'Views and viewpoints', 8)] })] }),
    node('c2', 'Architecture Patterns', 12, { depth: 1, intro: 'Layers, services, events.', children: [point('p4', 'Layers', 12, { depth: 2 })] }),
  ],
  other: { key: 'bk:other', id: 'other', total: 3, summary: summary(3), deckCount: 1, anchors: 2, opensRows: true },
};
const documents = [{ key: 'doc:l1', title: '01. Introduction to Solution Architecture v2.1.pdf', format: 'pdf', chapters: 3, total: 30, summary: summary(30), deckCount: 1 },
  { key: 'doc:paper', title: 'SA 2025 样卷', format: 'md', chapters: 0, total: 0, summary: summary(0), deckCount: 0 },
  { key: 'doc:notes', title: '补充笔记 · Reintroduction', format: 'md', chapters: 0, total: 1, summary: summary(1), deckCount: 1 }];
const outline = { status: 'ok', course: 'SA', total: 45, placed: 44, summary: summary(45), draftCards: 0, limit: 200, decks: [], deckId: null, documents,
  unplaced: { key: 'unplaced', total: 1, summary: summary(1), reasons: { none: 1, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] }, book, open: {} };
const details = {
  'bk:p1': { anchors: [{ key: 'doc:l1#0', kind: 'chapter', index: 0, title: 'What architects do', material: '01. Introduction to Solution Architecture v2.1.pdf', total: 12, summary: summary(12), deckCount: 1 },
    { key: 'doc:notes', kind: 'document', title: '补充笔记 · Reintroduction', format: 'md', chapters: 0, total: 1, summary: summary(1), deckCount: 1 }] },
  'bk:p2': { cards: [{ deckId: 'd1', cardId: 'q9', deckTitle: 'Lecture deck', prompt: 'Who are the stakeholders?', level: 'new', due: false }], more: 0 },
};
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, organise: noop, retry: noop, toggle: noop, onPick: noop, onPickCard: noop, onPracticeRow: noop,
  clearPick: noop, practisePicked: noop, chooseDeck: noop };
const OPEN = new Set(['bk:c1', 'bk:c2', 'bk:s1', 'bk:p1', 'bk:p2']);
const page = (extra = {}) => render(h(ui.CourseOutlineView, { course: 'SA', outline, details, open: OPEN, pick: ui.emptyPick(), actions, ...extra }));
const primaries = html => (html.match(/sh-btn--primary/g) || []).length;

test('the rows of the AI outline: 章 › 节 › 知识点 › the rows a point holds, 其他 and 未归位 last; chapters open by default; the keys walk them', () => {
  assert.deepEqual(ui.bookDefaultOpen(book), ['bk:c1', 'bk:c2']);
  const rows = ui.outlineRows(outline, details, OPEN);
  assert.deepEqual(rows.map(row => [row.key, row.level, row.kind, row.number ?? null, row.hasChildren]), [
    ['bk:c1', 1, 'part', '1', true], ['bk:s1', 2, 'section', '1.1', true], ['bk:p1', 3, 'point', '1.1.1', true], ['doc:l1#0', 4, 'anchor', null, false], ['doc:notes', 4, 'anchor', null, false],
    ['bk:p2', 3, 'point', '1.1.2', false], ['bk:s2', 2, 'section', '1.2', true], ['bk:c2', 1, 'part', '2', true], ['bk:p4', 2, 'point', '2.1', false],
    ['bk:other', 1, 'other', null, true], ['unplaced', 1, 'unplaced', null, false]]);
  assert.deepEqual(rows.find(row => row.key === 'doc:l1#0').ancestors, ['bk:c1', 'bk:s1', 'bk:p1']);
  assert.deepEqual(ui.outlineKey(rows, 'bk:c1', 'ArrowRight'), { focus: 'bk:s1' }, 'an open chapter: Right goes to its first section');
  assert.deepEqual(ui.outlineKey(rows, 'bk:s2', 'ArrowRight'), { toggle: 'bk:s2', open: true }, 'a closed section opens');
  assert.deepEqual(ui.outlineKey(rows, 'bk:p2', 'ArrowLeft'), { toggle: 'bk:p2', open: false }, 'an open point closes');
  assert.deepEqual(ui.outlineKey(rows, 'bk:p4', 'ArrowLeft'), { focus: 'bk:c2' }, 'a closed one goes to its chapter');
  assert.deepEqual(ui.outlineRows(outline, details, new Set()).map(row => row.key), ['bk:c1', 'bk:c2', 'bk:other', 'unplaced']);
});

test('the page reads like a book: numbered chapters with their introduction, sections and points with counts and practice, the order\'s basis, one quiet 重新整理', () => {
  const html = page(), text = textOf(html);
  assert.match(text, /第 1 章 Introduction to Solution Architecture 掌握 40% · 30 题 练这一节 What architects do and for whom\./);
  assert.match(text, /1\.1 Foundations 掌握 40% · 22 题 练这一节 The ideas first\./);
  assert.match(text, /1\.1\.1 What architects do 掌握 40% · 14 题 练这一节 Roles and decisions\./);
  assert.match(text, /01\. Introduction to Solution Architecture v2\.1 · What architects do 掌握 40% · 12 题/, 'a point\'s chapter row names its material');
  assert.match(text, /补充笔记 · Reintroduction 掌握 40% · 1 题/);
  assert.match(text, /Who are the stakeholders\? Lecture deck/, 'a one-row point opens to its questions');
  assert.match(text, /第 2 章 Architecture Patterns/);
  assert.match(text, /其他 掌握 40% · 3 题 练这一节 2 处资料没有归入上面的章节/);
  assert.match(text, /未归位/);
  assert.match(text, /学习顺序依据：讲义大纲《SA 讲义大纲》的顺序 · 资料标题里的编号/);
  assert.match(text, /重新整理/);
  assert.doesNotMatch(text, /资料有更新|生成总纲|样卷考过（|补充 /, 'not stale, no paper: nothing said about either');
  // The outline exists: 重新整理 is quiet; the one main button is the next step, 生成复习全书 (tests/course-book-ui.test.mjs).
  assert.equal(primaries(html), 1);
  assert.match(textOf(html.slice(html.indexOf('sh-btn--primary'))), /^[^<]*?生成复习全书/);
  assert.match(textOf(page({ outline: { ...outline, book: { ...book, stale: true } } })), /资料有更新，建议重新整理/);
  const tip = dom(html).all.find(item => item.getAttribute('role') === 'tooltip' && /章 → 节 → 知识点/.test(item.textContent));
  assert.match(tip.textContent, /只是参考：题目的出处仍是原来的资料/);
});

test('with sample papers a point says 样卷考过（N/M 份） or 补充; picking a chapter ticks the questions of its points', () => {
  const marked = { ...book, papers: 2, nodes: [{ ...book.nodes[0], children: [{ ...book.nodes[0].children[0], children: [
    { ...book.nodes[0].children[0].children[0], tier: 'must', papers: 2 }, { ...book.nodes[0].children[0].children[1], tier: 'extra', papers: 0 }] }, book.nodes[0].children[1]] }, book.nodes[1]] };
  const text = textOf(page({ outline: { ...outline, book: marked } }));
  assert.match(text, /What architects do 样卷考过（2\/2 份）/);
  assert.match(text, /Stakeholders and concerns 补充/);
  const pick = ui.pickRow(ui.emptyPick(), 'bk:c1', true);
  const html = page({ pick }), checks = dom(html).all.filter(item => item.getAttribute('type') === 'checkbox');
  assert.ok(checks.filter(item => item.getAttribute('checked') !== null).length >= 6, 'the chapter, its sections, points, rows and the question under it');
  assert.equal(ui.cardTicked(pick, { deckId: 'd1', cardId: 'q9' }, ['bk:p2', 'bk:c1', 'bk:s1']), true);
});

test('no outline yet: the materials as in v3.3.0, one primary 生成总纲, and folded the choice of sample papers (the likely one first, none picked)', () => {
  const flat = { ...outline, book: null };
  const html = page({ outline: flat, open: new Set() }), text = textOf(html);
  assert.match(text, /现在按资料排开（3 份）。生成总纲会让模型把它们整理成像书一样的「章 → 节 → 知识点」/);
  assert.match(text, /生成总纲/);
  assert.equal(primaries(html), 1);
  assert.match(text, /提供了试卷？/);
  const picks = dom(html).all.filter(item => item.getAttribute('class')?.includes('outline-papers__list'));
  assert.equal(picks.length, 1);
  assert.match(textOf(html.slice(html.indexOf('outline-papers__list'))), /^[^]*?SA 2025 样卷 像样卷/, 'the paper-like material first, with why');
  assert.equal(dom(html).all.filter(item => item.getAttribute('type') === 'checkbox' && item.getAttribute('checked') !== null).length, 0, 'none picked');
  assert.deepEqual(ui.paperChoices(documents).map(choice => [choice.key, choice.likely]), [['doc:paper', true], ['doc:l1', false], ['doc:notes', false]]);
  assert.doesNotMatch(text, /学习顺序依据/);
  // While a build of the course runs: the line says so and leads to the task, no second start.
  const running = textOf(page({ outline: flat, open: new Set(), running: { jobId: 'course-outline-1', status: 'running', done: 1, total: 3 } }));
  assert.match(running, /正在整理总纲（2\/3 步）… 看进度/);
  assert.doesNotMatch(running, /生成总纲 /);
  // Without a model the button cannot work and says where to set one up.
  const gated = page({ outline: flat, open: new Set(), model: { ready: false, reason: 'no-route', label: '' } });
  assert.match(textOf(gated), /生成总纲需要先配置模型/);
  assert.ok(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*生成总纲/s.test(gated));
});

test('the running build of the course is found in the jobs; another course\'s or a finished one is not', () => {
  const job = (status, course) => ({ contract: { contractVersion: 1, jobId: `j-${status}-${course}`, kind: 'course-outline-build', title: 't', status, detail: { course }, progress: { done: 1, total: 3 },
    stage: { code: 'x', text: '' }, capabilities: {}, actions: {}, result: { refs: [] }, runtime: {} } });
  assert.deepEqual(ui.runningBuild([job('complete', 'SA'), job('running', 'DB'), job('running', 'SA')], 'SA'), { jobId: 'j-running-SA', status: 'running', done: 1, total: 3 });
  assert.equal(ui.runningBuild([job('complete', 'SA')], 'SA'), null);
});

test('in English the AI outline has no Chinese of its own', () => {
  english(() => {
    const data = /Introduction to Solution Architecture|01\. |v2\.1|What architects do|Stakeholders and concerns|Views and viewpoints|Architecture Patterns|Layers|Foundations|In practice|The ideas first\.|Roles and decisions\.|Layers, services, events\.|What architects do and for whom\.|补充笔记 · Reintroduction|SA 2025 样卷|SA 讲义大纲|Who are the stakeholders\?|Lecture deck|SA/g;
    for (const html of [page({ outline: { ...outline, book: { ...book, stale: true, papers: 1, nodes: [{ ...book.nodes[0], children: [book.nodes[0].children[0]] }] } } }), page({ outline: { ...outline, book: null }, open: new Set() }),
      page({ outline: { ...outline, book: null }, running: { jobId: 'j', status: 'running', done: 0, total: 2 } })]) {
      const text = textOf(html).replace(data, '');
      assert.doesNotMatch(text, han, text.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    }
    const text = textOf(page());
    assert.match(text, /Chapter 1/);
    assert.match(text, /Learning order based on: the order of the syllabus “SA 讲义大纲” · the numbers in the material titles/);
    assert.match(text, /Reorganise/);
    assert.match(textOf(page({ outline: { ...outline, book: null }, open: new Set() })), /Generate outline/);
  });
});
