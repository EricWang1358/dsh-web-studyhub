/* The markup of the reading loop in both languages: the control and its panel (counts before starting, the none-yet state), the
   mastery mark (shape AND words), the outline meters, the 资料 rows and the way back on the practice page. Interaction, scroll
   restoration and layout are checked in the browser journey (scripts/qa/reading-loop.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeLinked } from '../lib/material-summary.js';
import { structureOutline } from '../ui/document-preview/reader/outline.js';

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';
  export { default as ReadingPractice } from './ui/document-preview/practice/ReadingPractice.jsx';
  export { MasteryMark, MasteryLine } from './ui/document-preview/practice/MasteryMark.jsx';
  export { ReadingResult, ReadingBackButton, WrongAnswerSource, masteryChangeText } from './ui/document-preview/practice/ReadingReturn.jsx';
  export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
  export { ChapterList } from './ui/Sources.jsx';
  export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
// One instance of the bundle for the whole file: the interface language is module state, so every test must share it.
const instance = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, instance, instance.exports);
const load = () => instance.exports;
const render = element => renderToStaticMarkup(element);
const e = React.createElement;

const levels = (...list) => summarizeLinked(list.map(([level, due]) => ({ level, due })));
const five = levels(['weak', true], ['learning', true], ['new'], ['mastered'], ['familiar']);
const loopOf = (overrides = {}) => {
  const selected = { kind: 'here', count: 1, ids: new Set(['page-1']), cards: [], summary: five };
  return { open: true, setOpen() {}, status: 'ready', options: [selected], selected, kind: 'here', setKind() {}, reload() {}, inactiveCourses: [], ...overrides };
};
const practice = (loop, props = {}) => e(load().ReadingPractice, { loop, unit: 'page', onStart() {}, onGenerate() {}, ...props });

test('the control is a persistent button and the panel says what is about to be practised before it starts (Chinese)', () => {
  const { setUiLanguage } = load();
  setUiLanguage('zh');
  const closed = render(practice(loopOf({ open: false })));
  assert.ok(closed.includes('做这几页的题'));
  assert.match(closed, /aria-keyshortcuts="P"/);
  assert.ok(!closed.includes('role="dialog"'), 'closed: no panel');
  const html = render(practice(loopOf()));
  for (const text of ['5 道题 · 2 道到期 · 1 道薄弱题 · 1 道没做过', '开始做这 5 道题', '本页', '按这几页关联的题的复习状态计算；答对并拉长复习间隔才会上升'])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('role="dialog"'));
  assert.ok(!html.includes('为这几页出题'), 'with questions there is nothing to generate here');
});

test('the same panel in English has no Han characters and the counts line reads naturally', () => {
  const { setUiLanguage } = load();
  setUiLanguage('en');
  const html = render(practice(loopOf()));
  assert.doesNotMatch(html, han);
  for (const text of ['Practise these pages', '5 questions · 2 due · 1 weak · 1 new', 'Practise these 5 questions', 'This page']) assert.ok(html.includes(text), text);
  setUiLanguage('zh');
});

test('the range chooser lists this page / this chapter / the pages just read, each with its question count', () => {
  const { setUiLanguage } = load();
  const chapter = { kind: 'chapter', count: 4, ids: new Set(), cards: [], summary: levels(['new'], ['new'], ['mastered']) };
  const recent = { kind: 'recent', count: 3, ids: new Set(), cards: [], summary: levels(['new']) };
  const loop = loopOf({ options: [loopOf().selected, chapter, recent] });
  setUiLanguage('zh');
  const zh = render(practice(loop));
  for (const text of ['本页', '本章', '刚读过的 3 页', '做题范围', 'type="radio"']) assert.ok(zh.includes(text), text);
  assert.match(zh, /checked=""[^>]*value="here"|value="here"[^>]*checked=""/);
  setUiLanguage('en');
  const en = render(practice(loop));
  assert.doesNotMatch(en, han);
  for (const text of ['This page', 'This chapter', 'The 3 pages just read', 'What to practise', '3 questions', '1 question']) assert.ok(en.includes(text), text);
  setUiLanguage('zh');
});

test('with no question yet the panel says so and offers exactly one button, 为这几页出题', () => {
  const { setUiLanguage } = load();
  const none = { kind: 'here', count: 1, ids: new Set(), cards: [], summary: summarizeLinked([]) };
  const loop = loopOf({ options: [none], selected: none });
  setUiLanguage('zh');
  const zh = render(practice(loop));
  assert.ok(zh.includes('这几页还没有题'));
  assert.equal((zh.match(/<button/g) || []).length, 2, 'the control button and the one generate button');
  assert.ok(zh.includes('为这几页出题'));
  assert.ok(!zh.includes('开始做这'));
  setUiLanguage('en');
  const en = render(practice(loop));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('No questions for these pages yet') && en.includes('Make questions for these pages'));
  setUiLanguage('zh');
});

test('questions of a parked course are offered and said to be parked, not hidden', () => {
  const { setUiLanguage } = load();
  const parked = { kind: 'here', count: 1, ids: new Set(), cards: [], summary: { ...levels(['new'], ['mastered']), inactive: 1 } };
  const loop = loopOf({ options: [parked], selected: parked, inactiveCourses: ['Archive'] });
  setUiLanguage('zh');
  const zh = render(practice(loop));
  assert.ok(zh.includes('其中 1 道在未激活的课程「Archive」里') && zh.includes('开始做这 2 道题'));
  setUiLanguage('en');
  const en = render(practice(loop));
  assert.doesNotMatch(en.replace('Archive', ''), han);
  assert.ok(en.includes('1 of them are in the inactive course') || en.includes('of them are in the inactive course'));
  setUiLanguage('zh');
});

test('loading, unavailable and failed states are plain and offer a retry', () => {
  const { setUiLanguage } = load();
  setUiLanguage('en');
  assert.ok(render(practice(loopOf({ status: 'loading', options: [], selected: null }))).includes('Loading the questions for these pages…'));
  const failed = render(practice(loopOf({ status: 'error', options: [], selected: null })));
  assert.doesNotMatch(failed, han);
  assert.ok(failed.includes('Could not read the questions for these pages.') && failed.includes('Retry'));
  setUiLanguage('zh');
});

test('every state has its own shape and says its state in words, so it never depends on colour', () => {
  const { setUiLanguage, MasteryMark } = load();
  const marks = {
    none: summarizeLinked([]), unlearned: levels(['new']), learning: levels(['learning']), familiar: levels(['familiar']), mastered: levels(['mastered'], ['mastered']),
  };
  setUiLanguage('zh');
  const shapes = new Map();
  for (const [state, summary] of Object.entries(marks)) {
    const html = render(e(MasteryMark, { summary, title: '第 3 页' }));
    assert.ok(html.includes(`data-state="${state}"`), state);
    assert.match(html, /role="img"/);
    shapes.set(state, html.match(/<svg[^>]*>(.*)<\/svg>/)[1]);
  }
  assert.equal(new Set(shapes.values()).size, 5, 'five different drawings');
  assert.match(render(e(MasteryMark, { summary: marks.none, title: '第 3 页' })), /第 3 页：还没出题/);
  assert.match(render(e(MasteryMark, { summary: marks.learning, title: '第 3 页' })), /第 3 页：学习中 · 掌握 45% · 1 题/);
  assert.match(render(e(MasteryMark, { summary: marks.unlearned })), /aria-label="未学 · 1 道题"/);
  setUiLanguage('en');
  const en = render(e(MasteryMark, { summary: marks.mastered, title: 'Page 3' }));
  assert.doesNotMatch(en, han);
  assert.match(en, /Page 3：Mastered · Mastery 100% · 2 questions/);
  setUiLanguage('zh');
});

test('a row says 掌握 62% · 12 题, 未学 or 还没出题, and labels the questions of parked courses', () => {
  const { setUiLanguage, MasteryLine } = load();
  const twelve = { ...summarizeLinked([...Array(7).fill({ level: 'mastered' }), ...Array(5).fill({ level: 'learning' })]), inactive: 2 };
  setUiLanguage('zh');
  const row = render(e(MasteryLine, { summary: twelve }));
  assert.ok(row.includes('掌握 77% · 12 题') && row.includes('含 2 道未激活课程的题'));
  assert.ok(render(e(MasteryLine, { summary: null })).includes('还没出题'));
  assert.ok(render(e(MasteryLine, { summary: levels(['new'], ['new']) })).includes('未学 · 2 题'));
  setUiLanguage('en');
  const en = render(e(MasteryLine, { summary: twelve }));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('Mastery 77% · 12 questions') && en.includes('includes 2 from inactive courses'));
  assert.ok(render(e(MasteryLine, { summary: null })).includes('No questions yet'));
  setUiLanguage('zh');
});

test('the outline shows a meter per entry, a whole chapter counted at its own row, and none when the document has no questions', () => {
  const { setUiLanguage, OutlinePanel } = load();
  const items = structureOutline([{ id: 'a', level: 1, title: 'Chapter A' }, { id: 'a1', level: 2, title: 'Section A1' }, { id: 'b', level: 1, title: 'Chapter B' }], { fold: false });
  const meters = new Map([['a', levels(['mastered'], ['new'])], ['a1', levels(['mastered'])]]);
  setUiLanguage('zh');
  const html = render(e(OutlinePanel, { items, activeId: 'a', onJump() {}, meters, initialOpen: ['a'] }));
  assert.equal((html.match(/class="mastery-mark/g) || []).length, 3, 'one per row, the rows with no question included');
  assert.match(html, /Chapter A：熟悉 · 掌握 50% · 2 题|Chapter A：学习中 · 掌握 50% · 2 题/);
  assert.match(html, /Chapter B：还没出题/);
  assert.equal((render(e(OutlinePanel, { items, activeId: 'a', onJump() {}, meters: null })).match(/mastery-mark/g) || []).length, 0);
  setUiLanguage('en');
  assert.doesNotMatch(render(e(OutlinePanel, { items, activeId: 'a', onJump() {}, meters })).replace(/Chapter [AB]|Section A1/g, ''), han);
  setUiLanguage('zh');
});

test('the 资料 chapter rows carry their mastery, 还没出题 where there is none', () => {
  const { setUiLanguage, ChapterList } = load();
  const item = { key: 'k', format: 'pdf', chapterUnit: 'page', chapters: [
    { index: 0, title: 'One', level: 1, sourceIds: ['a', 'b'], startPage: 1, endPage: 2, chars: 100 }, { index: 1, title: 'Two', level: 1, sourceIds: ['c'], startPage: 3, endPage: 3, chars: 50 }] };
  const mastery = { chapters: { 0: { ...summarizeLinked([...Array(7).fill({ level: 'mastered' }), ...Array(5).fill({ level: 'learning' })]) } } };
  setUiLanguage('zh');
  const html = render(e(ChapterList, { item, busy: false, onOpen() {}, onGenerate() {}, listId: 'x', mastery }));
  assert.ok(html.includes('掌握 77% · 12 题'));
  assert.ok(html.includes('还没出题'));
  setUiLanguage('en');
  assert.doesNotMatch(render(e(ChapterList, { item: { ...item, chapters: item.chapters.map(chapter => ({ ...chapter, title: 'T' })) }, busy: false, onOpen() {}, onGenerate() {}, listId: 'x', mastery })).replace(/\bT\b/g, ''), han);
  setUiLanguage('zh');
});

const reading = { sourceId: 's1', sectionTitle: 'Hash indexes', page: 3, scope: { kind: 'chapter', count: 4 }, before: { percent: 41, total: 5 }, after: { percent: 58, total: 5, state: 'learning' } };

test('the result page of a run from reading says the mastery change and offers 回到阅读 as the next step', () => {
  const { setUiLanguage, ReadingResult } = load();
  setUiLanguage('zh');
  const html = render(e(ReadingResult, { run: { reading }, onReturn() {}, busy: false }));
  assert.ok(html.includes('这几页的掌握度 41% → 58%'));
  assert.match(html, /<button[^>]*class="sh-btn sh-btn--primary sh-btn--md sh-btn--wrap sh-btn--start reading-result__return"/);
  assert.ok(html.includes('回到阅读') && html.includes('回到「Hash indexes」'));
  assert.equal(render(e(ReadingResult, { run: {}, onReturn() {} })), '', 'a run that did not start from reading shows nothing');
  setUiLanguage('en');
  const en = render(e(ReadingResult, { run: { reading }, onReturn() {}, busy: false }));
  assert.doesNotMatch(en.replace('Hash indexes', ''), han);
  assert.ok(en.includes('Mastery of these pages 41% → 58%') && en.includes('Back to reading'));
  setUiLanguage('zh');
});

test('no change is said plainly, and an unreadable change is not invented', () => {
  const { setUiLanguage, masteryChangeText } = load();
  setUiLanguage('zh');
  assert.equal(masteryChangeText({ before: { percent: 50, total: 2 }, after: { percent: 50, total: 2 } }), '这几页的掌握度 50%（这一轮没有变化）');
  assert.equal(masteryChangeText({ before: { percent: null, total: 0 }, after: { percent: null, total: 0 } }), '');
  assert.equal(masteryChangeText({}), '');
});

test('the way back from an open run, and the source of a wrongly answered question with a way back to it', () => {
  const { setUiLanguage, ReadingBackButton, WrongAnswerSource } = load();
  setUiLanguage('zh');
  assert.ok(render(e(ReadingBackButton, { run: { reading }, onReturn() {} })).includes('回到原文'));
  assert.equal(render(e(ReadingBackButton, { run: {}, onReturn() {} })), '');
  const solution = { citations: [{ sourceId: 's1', quote: 'An index is an extra data structure' }], selections: [{ sourceId: 's1', start: 0, end: 10, quote: 'An index is an extra data structure' }] };
  const sources = [{ id: 's1', title: 'Lecture' }];
  const wrong = { feedback: { correct: false }, solution };
  assert.ok(render(e(WrongAnswerSource, { run: wrong, sources, onOpen() {} })).includes('看这题的原文'));
  assert.equal(render(e(WrongAnswerSource, { run: { feedback: { correct: true }, solution }, sources, onOpen() {} })), '', 'only after a wrong answer');
  assert.equal(render(e(WrongAnswerSource, { run: wrong, sources: [], onOpen() {} })), '', 'nothing to open when the material is gone');
  assert.equal(render(e(WrongAnswerSource, { run: { feedback: { correct: false }, solution: { citations: [] } }, sources, onOpen() {} })), '');
  setUiLanguage('en');
  assert.doesNotMatch(render(e(ReadingBackButton, { run: { reading }, onReturn() {} })), han);
  assert.doesNotMatch(render(e(WrongAnswerSource, { run: wrong, sources, onOpen() {} })), han);
  setUiLanguage('zh');
});

test('the keyboard shortcut is documented in the shortcut sheet and does not collide with another shortcut', () => {
  const { setUiLanguage, ShortcutHelp } = load();
  setUiLanguage('zh');
  const html = render(e(ShortcutHelp, { page: 'library', onClose() {} }));
  assert.match(html, /<kbd>P<\/kbd>/);
  assert.ok(html.includes('做这几页的题'));
  const keys = [...html.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map(match => match[1]);
  assert.equal(new Set(keys).size, keys.length, 'no key is listed twice');
  setUiLanguage('en');
  assert.doesNotMatch(render(e(ShortcutHelp, { page: 'library', onClose() {} })), han);
  setUiLanguage('zh');
  // The app-wide handler (ui/review/session-logic.js) uses these letters; P stays free so the reader's own handler can have it.
  const app = readFileSync(new URL('../ui/review/session-logic.js', import.meta.url), 'utf8');
  for (const letter of ['a', 's', 'h', 't']) assert.ok(app.includes(`letter === '${letter}'`), letter);
  assert.ok(!app.includes("letter === 'p'"));
});
