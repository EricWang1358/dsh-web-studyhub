/* 顽固题 on the result page of a round (#884 S2): when the finished round held questions that keep being failed, ONE line says so and opens the wrong book on them;
   a round without any shows nothing about it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewElement } from './helpers/review-render.mjs';

const compiled = await build({ stdin: { contents: `export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';
  export { askForLeeches, takeArrival } from './ui/wrongbook-model.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { default: Review, StudyServicesContext, setUiLanguage, askForLeeches, takeArrival } = module.exports;
const noop = () => {};
const han = /[㐀-鿿]/;
const card = { id: 'q', kind: 'quiz', topic: 'Context', prompt: 'Who processes payments?', options: [] };
const debrief = () => ({ headline: '状态不错，接着学下一批。', why: '本轮 4 题。', next: 'continue_path', insights: [], metrics: { answered: 4, gradedAnswered: 4, gradedCorrect: 2 },
  status: { enabled: true, consent: false, ready: 0 } });
function result({ run = {}, data = {}, mode = 'path' } = {}) {
  return renderToStaticMarkup(reviewElement(Review, StudyServicesContext, {
    run: { id: 'r', mode, complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 2, selfAnswered: 0, weakTopics: ['Context'],
      weakScopes: { Context: [{ deckId: 'd1', topic: 'Context' }] }, scope: [], card, ...run },
    data: { sources: [], features: {}, ...data }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: '今日学习', busy: false,
    act: noop, enterRun: noop, setPage: noop, askInChat: noop,
    coachProps: { debrief: debrief(), autopilot: false, onPractice: noop, onContinue: noop, onReviewWeak: noop, destination: { kind: 'path', reason: 'continuing', label: '继续学习 →', go: noop, note: '' } },
  }));
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const leeches = (n) => Array.from({ length: n }, (_, k) => ({ deckId: 'd1', cardId: `c${k}` }));

test('a round with leeches says so in one line, with the way to the wrong book', () => {
  setUiLanguage('zh');
  const html = result({ run: { leechCards: leeches(2) } });
  assert.equal((text(html).match(/反复答错/g) || []).length, 1, 'one line');
  assert.match(text(html), /本轮有 2 道题你已经反复答错/);
  assert.match(html, /<button[^>]*>[^<]*在错题本里看看[^<]*<\/button>/);
  assert.match(text(result({ run: { leechCards: leeches(1) } })), /本轮有 1 道题你已经反复答错/);
});

test('a round without leeches, a mock exam and an old run without the list show nothing about it', () => {
  setUiLanguage('zh');
  for (const run of [{ leechCards: [] }, {}]) assert.doesNotMatch(text(result({ run })), /反复答错|错题本里看看/);
  assert.doesNotMatch(text(result({ run: { leechCards: leeches(2) }, mode: 'exam' })), /反复答错/);
});

test('English', () => {
  setUiLanguage('en');
  try {
    const html = text(result({ run: { leechCards: leeches(3) } }));
    assert.match(html, /3 questions in this round/);
    assert.match(html, /Look in the wrong book/);
    assert.doesNotMatch(html.match(/3 questions in this round.*?wrong book/)[0], han, 'the line is wholly translated');
  } finally { setUiLanguage('zh'); }
});

test('the line opens the wrong book on the 顽固题 once: asked before navigating, taken and forgotten on arrival', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  assert.deepEqual(takeArrival('root', storage), {}, 'nobody asked');
  askForLeeches('root', storage);
  assert.deepEqual(takeArrival('other', storage), {}, 'another library is not asked');
  assert.deepEqual(takeArrival('root', storage), { filter: { leech: true }, course: '*' });
  assert.deepEqual(takeArrival('root', storage), {}, 'read once');
});
