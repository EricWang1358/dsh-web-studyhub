/* global process */
/* #894 on the screen: a crunch point's row says its exam-day band in one word with a Tooltip (never a percentage, never title=), and the Today
   strip names the chapters that will slip with one button that starts a round of their at-risk questions, lowest projected recall first (the
   `rank` lib/course-book-crunch.js gives), at most the learner's round size. Rendered on the server, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { setUiLanguage } from './ui/i18n.js';
      export { default as TodayFocusStrip } from './ui/board/TodayFocusStrip.jsx';
      export { default as CrunchDay } from './ui/book/CrunchDay.jsx';
      export { selectTodayFocusStrip, selectSlippingRound, SLIP_CHAPTERS_SHOWN } from './ui/board/today-focus-strip.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const uiModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, uiModule, uiModule.exports);
const { setUiLanguage, TodayFocusStrip, CrunchDay, selectTodayFocusStrip, selectSlippingRound, SLIP_CHAPTERS_SHOWN } = uiModule.exports;

const TODAY = '2026-11-10';
const ref = (cardId, rank) => ({ deckId: 'd', cardId, rank });
const point = (id, number, examDay) => ({ id, key: `bk:${id}`, code: id.toUpperCase(), number, title: `Point ${id}`, questions: 4, ...(examDay ? { examDay } : {}) });
/** Chapter 3 and chapter 7 slip, chapter 5 holds, chapter 2 is already weak, chapter 9 was never answered. */
const points = () => [
  point('a', '2.1', { band: 'weak' }),
  point('b', '3.1', { band: 'slip', atRisk: [ref('b1', 4), ref('b2', 1)] }),
  point('c', '3.2', { band: 'solid' }),
  point('d', '5.1', { band: 'solid' }),
  point('e', '7', { band: 'slip', atRisk: [ref('e1', 0), ref('e2', 3), ref('e3', 2)] }),
  point('f', '9.1'),
];
const planAnswer = (list = points()) => ({ status: 'ok', course: 'SA', examDate: '2026-12-10', today: TODAY, plan: { version: 1, status: 'active' }, points: list,
  schedule: { status: 'ok', today: null } });
const library = (roundSize) => ({ revision: 1, courses: [], focus: {}, progress: {}, settings: roundSize ? { practice: { roundSize } } : {} });

test('the round holds only the slipping chapters\' at-risk questions, lowest projected recall first, capped at the round size', () => {
  const round = selectSlippingRound(planAnswer(), 20);
  assert.deepEqual(round.chapters, ['3', '7']);
  assert.deepEqual(round.scope, [{ deckId: 'd', cardId: 'e1' }, { deckId: 'd', cardId: 'b2' }, { deckId: 'd', cardId: 'e3' }, { deckId: 'd', cardId: 'e2' }, { deckId: 'd', cardId: 'b1' }]);
  assert.deepEqual(selectSlippingRound(planAnswer(), 3).scope.map(item => item.cardId), ['e1', 'b2', 'e3']);
});

test('no slipping chapter, no exam date, no plan answer: no round', () => {
  assert.equal(selectSlippingRound(planAnswer(points().filter(item => item.examDay?.band !== 'slip')), 20), null);
  // No exam date: lib/exam-day-band.js gives no point a band.
  assert.equal(selectSlippingRound(planAnswer(points().map(({ examDay: _gone, ...rest }) => rest)), 20), null);
  assert.equal(selectSlippingRound(null, 20), null);
  assert.equal(selectSlippingRound({ status: 'no-plan', points: undefined }, 20), null);
});

test('the Today strip says the slipping chapters in one sentence, the button says what it starts, and the round size is the learner\'s', () => {
  setUiLanguage('zh');
  const strip = selectTodayFocusStrip({ library: library(), planAnswer: planAnswer() });
  assert.equal(strip.visible, true);
  assert.equal(strip.slip.label, '按现在的进度，第 3、7 章到考试日会掉');
  assert.equal(strip.slip.action, '练这几章最容易忘的 5 道');
  assert.match(strip.slip.tooltip, /按不再复习推算/);
  assert.equal(selectTodayFocusStrip({ library: library(5), planAnswer: planAnswer() }).slip.scope.length, 5);
  // Nothing about it without a slipping chapter.
  assert.equal(selectTodayFocusStrip({ library: library(), planAnswer: planAnswer(points().filter(item => item.examDay?.band !== 'slip')) }).slip, null);
  setUiLanguage('en');
  const english = selectTodayFocusStrip({ library: library(), planAnswer: planAnswer() }).slip;
  assert.equal(english.label, 'At this pace, by the exam day these chapters will slip: 3, 7');
  assert.equal(english.action, 'Practise their most at-risk questions (5)');
  setUiLanguage('zh');
});

test('beyond the cap the sentence names the first chapters and says how many in all', () => {
  setUiLanguage('zh');
  const many = Array.from({ length: SLIP_CHAPTERS_SHOWN + 2 }, (_, at) => point(`p${at}`, `${at + 1}.1`, { band: 'slip', atRisk: [ref(`q${at}`, at)] }));
  const strip = selectTodayFocusStrip({ library: library(), planAnswer: planAnswer(many) });
  const shown = Array.from({ length: SLIP_CHAPTERS_SHOWN }, (_, at) => at + 1).join('、');
  assert.equal(strip.slip.label, `按现在的进度，第 ${shown} 章等 ${SLIP_CHAPTERS_SHOWN + 2} 章到考试日会掉`);
});

test('the strip renders the sentence with its button, which starts the round through the handler it is given; no title=, no percentage', () => {
  setUiLanguage('zh');
  const html = renderToStaticMarkup(React.createElement(TodayFocusStrip, { library: library(), today: TODAY, planAnswer: planAnswer(), onPracticeScope: () => {} }));
  assert.match(html, /按现在的进度，第 3、7 章到考试日会掉/);
  assert.match(html, /练这几章最容易忘的 5 道/);
  assert.doesNotMatch(html, /title=/);
  assert.doesNotMatch(html, /\d+(\.\d+)?\s*%/);
  // Without a way to start a round (a read-only board) the sentence stays and the button does not.
  const bare = renderToStaticMarkup(React.createElement(TodayFocusStrip, { library: library(), today: TODAY, planAnswer: planAnswer() }));
  assert.match(bare, /到考试日会掉/);
  assert.doesNotMatch(bare, /练这几章/);
});

test('a crunch point row says its band in one word with a Tooltip; a never-answered point says nothing new; the row\'s numbers stay', () => {
  setUiLanguage('zh');
  const day = { date: TODAY, mode: 'learn', points: points().map(item => item.id), done: [], reason: { code: 'learn', count: 6, tested: 0, minutes: 60 } };
  const html = renderToStaticMarkup(React.createElement(CrunchDay, { course: 'SA', day, points: points(), onRead: () => {}, onPractice: () => {} }));
  const rowOf = id => html.split(`data-point="${id}"`)[1].split('</li>')[0];
  assert.match(rowOf('a'), /已经不稳/);
  assert.match(rowOf('b'), /到考试日会掉/);
  assert.match(rowOf('c'), /到考试日仍稳/);
  assert.doesNotMatch(rowOf('f'), /已经不稳|到考试日会掉|到考试日仍稳/);
  assert.match(rowOf('b'), /4 道题/, 'the row keeps its question count');
  assert.doesNotMatch(html, /title=/);
  assert.doesNotMatch(html, /\d+(\.\d+)?\s*%/);
  setUiLanguage('en');
  const english = renderToStaticMarkup(React.createElement(CrunchDay, { course: 'SA', day, points: points(), onRead: () => {}, onPractice: () => {} }));
  assert.match(english, /Slips by exam day/);
  assert.match(english, /Holds on exam day/);
  assert.match(english, /Already shaky/);
  setUiLanguage('zh');
});
