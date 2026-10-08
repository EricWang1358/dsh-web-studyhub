/* The result page of a practice round: the next step is the first thing under the score, the score is worded by how the answers were graded,
   the weak topics start practice of that topic, and the 点评 says once that it asks the model and where to switch that. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { reviewElement } from './helpers/review-render.mjs';
import { continueDestination } from '../ui/review/session-logic.js';

const compiled = await build({ stdin: { contents: "export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { default: Review, StudyServicesContext, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const noop = () => {};
const card = { id: 'q', kind: 'quiz', topic: 'Context', prompt: 'Who processes payments?', options: [] };
const debrief = (next = 'continue_path', extra = {}) => ({ headline: '状态不错，接着学下一批。', why: '本轮 4 题。', next, insights: [], metrics: { answered: 4, gradedAnswered: 4, gradedCorrect: 2 },
  status: { enabled: true, consent: false, ready: 0 }, ...extra });
const destination = (label = '继续学习 →', extra = {}) => ({ kind: 'path', reason: 'continuing', label, go: noop, note: '', ...extra });
function result({ run = {}, coach = {}, data = {}, links = {}, ...rest } = {}) {
  return renderToStaticMarkup(reviewElement(Review, StudyServicesContext, {
    run: { id: 'r', mode: 'path', complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 2, selfAnswered: 0, weakTopics: ['Context'],
      weakScopes: { Context: [{ deckId: 'd1', topic: 'Context' }] }, scope: [], card, ...run },
    data: { sources: [], ...data }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: '今日学习', busy: false,
    act: noop, enterRun: noop, setPage: noop, askInChat: noop,
    coachProps: { call: async () => ({}), debrief: debrief(), autopilot: false, onPractice: noop, onContinue: noop, onReviewWeak: noop, destination: destination(), ...coach },
    ...links, ...rest,
  }));
}
const at = (html, marker) => html.indexOf(marker);
const primaries = (html) => (html.match(/class="sh-btn sh-btn--primary/g) || []).length;

test('the next step is the first thing under the score, above the recap panel, the 点评 and the weak topics', () => {
  setUiLanguage('zh');
  const html = result();
  const next = at(html, 'class="result-next"');
  assert.ok(next > at(html, 'class="result-hero'), 'under the score');
  for (const later of ['class="daily-recap"', 'coach-debrief', 'class="summary-topics', 'result-details']) assert.ok(next < at(html, later), `above ${later}`);
  assert.match(html.slice(next, at(html, 'coach-debrief')), /继续学习 →/);
});

test('a path round has its 继续学习 outside the fold, once; the fold keeps only what is an explicit repeat', () => {
  setUiLanguage('zh');
  const html = result();
  assert.equal((html.match(/继续学习 →/g) || []).length, 1, 'the next step is said once (the 点评 card does not repeat it)');
  const fold = html.slice(at(html, 'class="result-details"'));
  assert.doesNotMatch(fold, /继续学习/);
  const scoped = result({ run: { scope: [{ deckId: 'd1' }] }, coach: { destination: destination('继续这个范围 →', { kind: 'scope' }) } });
  assert.match(scoped, /再练此范围/, 'repeating the same scope stays an explicit, folded choice');
  assert.ok(at(scoped, '再练此范围') > at(scoped, 'result-details'));
});

test('exactly one filled button on the page, even when the 点评 suggests something else', () => {
  setUiLanguage('zh');
  assert.equal(primaries(result()), 1);
  for (const next of ['review_weak', 'practice_prepared']) {
    const html = result({ coach: { debrief: debrief(next, { status: { enabled: true, consent: false, ready: 3 } }) } });
    assert.equal(primaries(html), 1, next);
    assert.match(html, /先补薄弱点 →|刷 3 道为你定制的题 →/, 'the suggestion is still offered');
    assert.ok(at(html, 'class="result-next"') < at(html, '先补薄弱点 →') || at(html, 'class="result-next"') < at(html, '刷 3 道为你定制的题 →'));
  }
});

test('the way back to an original question or a workflow is the next step, and nothing else competes', () => {
  setUiLanguage('zh');
  const back = result({ run: { returnTo: 'orig' }, coach: { destination: destination('回到原题 →', { kind: 'original', runId: 'orig' }) } });
  assert.equal(primaries(back), 1);
  assert.match(back.slice(at(back, 'class="result-next"'), at(back, 'coach-debrief')), /回到原题 →/);
  assert.doesNotMatch(back, /继续学习/);
  const flow = result({ run: { workflow: { sessionId: 's', stepIndex: 0, stepCount: 3, stepTitle: 'x', current: true } }, onBackToWorkflow: noop });
  assert.match(flow.slice(at(flow, 'class="result-next"'), at(flow, 'coach-debrief')), /回到学习流，继续下一步 →/);
  assert.equal(primaries(flow), 1);
  const course = result({ run: { course: { name: '网络', next: { label: 'x', fresh: 3 }, learned: 1, cards: 5 } } });
  assert.match(course.slice(at(course, 'class="result-next"'), at(course, 'coach-debrief')), /继续课程下一批 →/);
  assert.equal(primaries(course), 1);
});

test('without a decision from the page (no library) the card keeps its own button, as before', () => {
  setUiLanguage('zh');
  const html = result({ coach: { destination: undefined } });
  assert.match(html, /继续学习 →/);
});

test('the score says what was measured: answered right for choices, met for self-graded cards, met for a mix', () => {
  setUiLanguage('zh');
  assert.match(result(), /道题答对 \/ 4 道/);
  assert.match(result({ run: { selfAnswered: 4 } }), /道题自评达标 \/ 4 道/);
  assert.doesNotMatch(result({ run: { selfAnswered: 4 } }), /道题答对/);
  const mixed = result({ run: { selfAnswered: 2 } });
  assert.match(mixed, /道题达标 \/ 4 道/);
  assert.doesNotMatch(mixed, /道题答对|自评达标 \/ 4/);
  setUiLanguage('en');
  try {
    assert.match(result({ run: { selfAnswered: 4 } }), /questions self-graded as met \/ 4/);
    assert.match(result({ run: { selfAnswered: 2 } }), /questions met the bar \/ 4/);
    assert.match(result(), /questions correct \/ 4/);
  } finally { setUiLanguage('zh'); }
});

test('a weak topic is a button that practises that topic; one with no known place stays a label', () => {
  setUiLanguage('zh');
  const html = result({ run: { weakTopics: ['Context', 'Orphan'], weakScopes: { Context: [{ deckId: 'd1', topic: 'Context' }] } } });
  const topics = html.slice(at(html, 'class="summary-topics'));
  assert.match(topics, /<button[^>]*>(?:(?!<\/button>).)*Context/);
  assert.match(topics, /练这个主题/);
  assert.doesNotMatch(topics, /<button[^>]*>(?:(?!<\/button>).)*Orphan/);
  assert.match(topics, /Orphan/);
});

test('the 点评 says once that it asks the model and links to the setting; switched off it says it did not', () => {
  setUiLanguage('zh');
  const on = result({ links: {}, data: { settings: {} } });
  assert.equal((on.match(/class="coach-model-note"/g) || []).length, 1);
  const noteOn = on.slice(at(on, 'class="coach-model-note"'));
  assert.match(noteOn, /请较轻量的模型写一句话/);
  assert.match(noteOn.slice(0, noteOn.indexOf('</p>')), /<button[^>]*>前往设置<\/button>/);
  const off = result({ data: { settings: { practice: { debrief: false } } } });
  const noteOff = off.slice(at(off, 'class="coach-model-note"'));
  assert.match(noteOff.slice(0, noteOff.indexOf('</p>')), /没有调用模型/);
  assert.match(noteOff.slice(0, noteOff.indexOf('</p>')), /<button[^>]*>前往设置<\/button>/);
  const short = result({ run: { answered: 2, questions: 2, total: 2 } });
  assert.doesNotMatch(short, /coach-model-note/, 'a round of fewer than three answers never asks the model, so there is nothing to disclose');
});

test('English: the new lines are translated', () => {
  setUiLanguage('en');
  try {
    const html = result({ run: { selfAnswered: 2 }, coach: { destination: destination('Continue studying →') } });
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.match(text, /Go to settings/);
    assert.match(text, /lighter model/);
    assert.match(html, /aria-label="Practise this topic: Context"/);
    assert.doesNotMatch(text.replace(/Context|状态不错，接着学下一批。|本轮 4 题。|今日学习/g, ''), han);
  } finally { setUiLanguage('zh'); }
});

/* ---------- what the server tells the page ---------- */

async function study(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-practice-result-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const quiz = (id, topic) => ({ id, kind: 'quiz', topic, prompt: `${id}?`, answer: 'a',
    options: [{ id: 'y', text: 'Yes', correct: true }, { id: 'n', text: 'No', correct: false }] });
  const flash = (id, topic) => ({ id, kind: 'flashcard', topic, prompt: `${id}?`, answer: 'a' });
  await service.store.update((s) => { s.decks.push({ id: 'd1', title: 'D1', course: 'A', cards: [quiz('q1', 'Alpha'), flash('f1', 'Beta'), quiz('q2', 'Alpha')] },
    { id: 'd2', title: 'D2', course: 'A', cards: [quiz('q3', 'Alpha')] }); });
  return service;
}

test('a finished round says how many answers were self-graded and where each weak topic lives', async (t) => {
  const service = await study(t);
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1' }, { deckId: 'd2' }], fresh: true });
  for (let step = 0; step < run.total; step++) {
    const card = run.card;
    if (card.kind === 'flashcard') { await service.call('review.reveal', { runId: run.id, cardId: card.id }); run = await service.call('review.answer', { runId: run.id, cardId: card.id, grade: 1 }); }
    else run = await service.call('review.answer', { runId: run.id, cardId: card.id, selected: ['n'] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(run.complete, true);
  assert.equal(run.answered, 4);
  assert.equal(run.selfAnswered, 1, 'the flashcard was graded by the learner');
  assert.equal(run.correct, 0);
  assert.deepEqual(Object.keys(run.weakScopes).sort(), ['Alpha', 'Beta']);
  assert.deepEqual(run.weakScopes.Beta, [{ deckId: 'd1', topic: 'Beta' }]);
  assert.deepEqual(run.weakScopes.Alpha.map((ref) => ref.deckId).sort(), ['d1', 'd2'], 'the same topic name in two decks is one button over both');
  assert.ok(run.weakScopes.Alpha.every((ref) => ref.topic === 'Alpha'));
});

test('the round of a course carries on with the next round of that course, never with the whole course as a scope', () => {
  const run = { id: 'r1', mode: 'path', scope: [{ deckId: 'd1' }, { deckId: 'd2' }], dailyCourse: '网络', questions: 20, answered: 20, complete: true };
  const progress = { d1: { counts: { new: 9 }, due: 3, topics: [] }, d2: { counts: { new: 9 }, due: 3, topics: [] } };
  const tasks = [{ id: 't', title: '读讲义', kind: 'reading', status: 'todo', available: true }];
  assert.deepEqual(continueDestination({ run, progress, tasks }), { kind: 'path', reason: 'continuing', course: '网络' });
  assert.deepEqual(continueDestination({ run: { ...run, dailyCourse: '' }, progress, tasks: [] }), { kind: 'path', reason: 'continuing', course: '' }, 'the decks without a course are a course too');
  assert.equal(continueDestination({ run: { ...run, returnTo: 'orig' }, runs: [{ id: 'orig' }], progress, tasks }).kind, 'original', 'a way back still wins');
  assert.equal(continueDestination({ run: { ...run, dailyCourse: undefined }, progress, tasks }).kind, 'scope', 'a run that is not a course round keeps its scope');
});

test('a course round has no 再练此范围: it is not a scope the learner chose', () => {
  setUiLanguage('zh');
  const round = result({ run: { scope: [{ deckId: 'd1' }], dailyCourse: 'A' } });
  assert.doesNotMatch(round, /再练此范围/);
  assert.match(result({ run: { scope: [{ deckId: 'd1' }] } }), /再练此范围/);
});
