import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The home ("学习库") is the daily path: one continue card, one recommendation with its reason, the other ways to start folded
   under one line, and every number with one plain label and a hover that says what it counts. Nothing else is promised above
   the fold; the once-per-course setup lives in its own checklist (tests/setup-checklist.test.mjs). */
const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { default as StudyMap } from './ui/StudyMap.jsx'; export * from './ui/mastery-terms.js'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { StudyMap, TERMS, setUiLanguage } = mod.exports;

const deck = { id: 'd1', title: 'Behavioural patterns', folder: 'CS3219', course: 'CS3219', topics: ['Memento'], available: 5, count: 5, quizCount: 3, createdAt: '2026-09-01T00:00:00Z' };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active', topics: [] } };
const route = { course: 'CS3219', current: 0, learned: 3, cards: 5, chapters: [{ deckId: 'd1', title: 'Behavioural patterns', total: 5, learned: 3, weak: 1, status: 'current' }],
  next: { label: 'Behavioural patterns', fresh: 2, reviews: 1 } };
function render(patch = {}, props = {}) {
  const data = { root: '/tmp/lib', decks: [deck], progress, sources: [{ id: 's' }], drafts: [], jobs: [], runs: [], today: { due: 1, weak: 2, new: 1, size: 4 },
    next: { deckId: 'd1', deckTitle: 'Behavioural patterns', topic: 'Memento', mastery: 23 },
    coach: { ready: 4 }, focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: Array(14).fill({}), route }, ...patch };
  const noop = () => {};
  return renderToStaticMarkup(React.createElement(StudyMap, { data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop,
    retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop,
    startCourseFlow: noop, onCoachPractice: noop, onWeakPoints: noop, ...props }));
}
const count = (html, pattern) => (html.match(pattern) || []).length;

test('one continue card and one recommendation, however many ways there are to start', () => {
  setUiLanguage('zh');
  for (const html of [render(), render({ runs: [{ id: 'r', mode: 'path', scope: [], index: 1, total: 4, title: 'Today' }] }),
    render({ focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] }, today: { due: 0, weak: 0, new: 0, size: 0 }, coach: { ready: 0 } })]) {
    assert.equal(count(html, /class="today-card"/g), 1, 'one card');
    assert.equal(count(html, /class="desk-next"/g), 1, 'one recommendation');
    assert.equal(count(html, /class="primary today-go"/g), 1, 'one primary button');
  }
});

test('the recommendation says why: it is the first topic of the course that is not mastered yet', () => {
  setUiLanguage('zh');
  const html = render();
  assert.match(html, /推荐下一步/);
  assert.match(html, /课程里下一个没掌握的主题/);
  assert.match(html, /课程里下一个没掌握的主题 · 掌握 23%/);
  assert.match(html, /只学这个主题/);
});

test('the other ways to start sit under one folded line: new questions, due review, the flow, personalised questions, weak points', () => {
  setUiLanguage('zh');
  const html = render();
  assert.match(html, /<details class="desk-more"><summary>其他开始方式<\/summary>/);
  const more = html.slice(html.indexOf('<details class="desk-more">'), html.indexOf('</details>', html.indexOf('<details class="desk-more">')));
  assert.match(more, /到期复习与巩固 · 4 题/);
  assert.match(more, /先讲后练 · 学习流/);
  assert.match(more, /刷 4 道为你定制的题/);
  assert.match(more, /2 题薄弱/);
  assert.doesNotMatch(html.replace(more, ''), /到期复习与巩固 · 4 题/, 'not shown twice');
  assert.equal(count(html, /class="coach-offer"/g), 0, 'the personalised questions are a link here, not a third card');
  // Nothing to fold: no line.
  assert.doesNotMatch(render({ coach: { ready: 0 }, today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] } }), /desk-more/);
});

test('every number has one plain label and a hover that says what it counts', () => {
  setUiLanguage('zh');
  const html = render();
  // Today's plan when nothing else leads: the breakdown names each count.
  assert.match(render({ focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] } }), /1 题到期 · 2 题薄弱 · 1 题未学/);
  assert.match(html, /<span class="desk-mastery-label">掌握度<\/span>/);
  assert.match(html, /title="[^"]*间隔复习累积[^"]*"/, 'what mastered means');
  assert.match(html, /学过 3 \/ 5 题/);
  for (const key of ['due', 'learned', 'mastered', 'weak', 'new', 'mastery']) {
    assert.ok(TERMS[key]?.label && TERMS[key]?.hint, `${key} has a label and a hint`);
  }
  assert.match(TERMS.mastered.label, /已掌握（间隔复习累积）/);
  assert.match(TERMS.due.label, /到期/);
  assert.match(TERMS.learned.label, /学过/);
  // The legend carries the hints, so a colour is never the only explanation.
  assert.match(html, /<span title="[^"]*"><i class="lv-mastered"><\/i>已掌握<\/span>/);
});

test('English renders without Han outside the learner\'s own names', () => {
  setUiLanguage('en');
  try {
    const html = render({ coach: { ready: 4 } });
    assert.doesNotMatch(html.replace(/CS3219/g, ''), han);
    assert.match(render({ focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] } }), /1 due · 2 weak · 1 not started/);
    assert.match(html, /Other ways to start/);
    assert.match(html, /Mastery/);
  } finally { setUiLanguage('zh'); }
});

test('App no longer draws the personalised-questions card; the sidebar row and the home link remain', async () => {
  const app = (await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.doesNotMatch(app, /className="coach-offer"/);
  assert.match(app, /<CoachNavItem\b/);
  assert.match(app, /onCoachPractice=\{/);
  assert.match(app, /onWeakPoints=\{/);
});
