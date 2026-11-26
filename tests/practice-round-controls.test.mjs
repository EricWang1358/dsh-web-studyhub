import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { freshRoundCount, roundLimits } from '../lib/practice-settings.js';
import { followupDigest } from '../lib/followup.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { capabilityIndex } from '../lib/runtime/tools.js';
import { assistRunningOn, clozeBlankKeyAction, finishedTask, pendingCount, retriesWaiting, reviewPollResult, shortcutAction, skipTarget } from '../ui/review/session-logic.js';
import { reviewPollDelay } from '../ui/poll-schedule.js';
import { loadUi } from './helpers/ui-module.mjs';

/* #1008 / #1009 / #1011: inside a practice round the learner can set a question aside (先跳过, the existing review.move {index}) and stop the round with a
   result (到此为止, the existing review.end); the result page lists the round's questions with a read-only look-back from the run itself; 「继续下一批新题」 takes
   as many questions as the round size; the practice page's poll slows down while nothing changes. */

const MIN = 60000;
const quiz = (id) => ({ id, kind: 'quiz', topic: `T-${id}`, objective: 'Recall', prompt: `${id}?`, hint: 'H', explanation: `E-${id}`, misconception: `M-${id}`, citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'x' }, { id: 'b', text: 'no', correct: false, explanation: 'y' }] });

async function library(t, count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'round-controls-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const ids = Array.from({ length: count }, (_, index) => `q${index + 1}`);
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: ids.map(quiz) }); });
  const run = await service.call('review.start', { mode: 'path', fresh: true, scope: ids.map((cardId) => ({ deckId: 'd', cardId })) });
  return { service, run };
}
const age = (service, runId, ms) => service.store.update((s) => { for (const entry of s.runs.find((r) => r.id === runId).entries) entry.startedAt = Date.now() - ms; });
const answer = (service, run, selected = ['a']) => service.call('review.answer', { runId: run.id, cardId: run.card.id, selected });

/* ── 先跳过 (#1008) ── */

test('先跳过 goes to the next unanswered question after this one, wraps round, and is not offered when nothing else waits', () => {
  const nav = (answered) => answered.map((done, index) => ({ index, answered: done }));
  const run = (index, answered, extra = {}) => ({ id: 'r', mode: 'path', index, card: { id: `c${index}` }, feedback: null, navigation: nav(answered), ...extra });
  assert.equal(skipTarget(run(0, [false, false, false])), 1);
  assert.equal(skipTarget(run(1, [false, true, true, false])), 3, 'answered ones are passed over');
  assert.equal(skipTarget(run(2, [false, true, false])), 0, 'from the last it wraps to the first unanswered');
  assert.equal(skipTarget(run(0, [false, true, true])), null, 'the only unanswered question cannot be set aside');
  assert.equal(skipTarget(run(0, [false, false], { feedback: { grade: 4 } })), null, 'an answered question goes on with 下一题');
  assert.equal(skipTarget(run(0, [false, false], { mode: 'exam' })), null, 'an exam has its own rules');
  assert.equal(skipTarget(run(0, [false, false], { card: { id: 'c0', publicationUngrable: true } })), null, 'an ungradable question has its own 跳过');
  assert.equal(pendingCount(run(0, [false, true, false])), 2);
  assert.equal(pendingCount({ mode: 'exam', navigation: undefined }), 0);
  // A re-ask (再练) queued by a wrong answer is not a question of the round: 「N 题待答」 and 到此为止 say what the result page's 未答 will say.
  const withRetry = { mode: 'path', navigation: [{ index: 0, answered: true }, { index: 1, answered: false }, { index: 2, answered: false, retry: true }] };
  assert.equal(pendingCount(withRetry), 1, 'the waiting re-ask is not counted as unanswered');
  assert.equal(retriesWaiting(withRetry), 1, 'it is counted on its own');
  assert.equal(retriesWaiting({ ...withRetry, navigation: withRetry.navigation.slice(0, 2) }), 0);
});

test('a skipped question is timed afresh when it comes back, and records one answer', async (t) => {
  const { service, run } = await library(t);
  await age(service, run.id, 10 * MIN);
  // 先跳过 on q1: the existing jump to question 2.
  let current = await service.call('review.move', { runId: run.id, index: 1 });
  assert.equal(current.card.id, 'q2');
  await answer(service, current);
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  await answer(service, current);
  // 下一题 on the last question brings the skipped one back (the round's own rule), its clock restarted.
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.card.id, 'q1', 'the skipped question comes back at the end of the round');
  assert.equal(current.complete, false);
  await answer(service, current);
  const attempts = (await service.store.read()).attempts.filter((item) => item.quiz_id === 'q1');
  assert.equal(attempts.length, 1, 'one answer, no record for the skip');
  assert.ok(attempts[0].elapsed_ms < 5000, `the time before the skip is not counted, got ${attempts[0].elapsed_ms}`);
});

test('下一题 goes to the next question still waiting: after the skipped one comes back and is answered, one press opens the result', async (t) => {
  const { service, run } = await library(t, 4);
  let current = await service.call('review.move', { runId: run.id, index: 1 }); // 先跳过 q1
  for (const id of ['q2', 'q3', 'q4']) {
    assert.equal(current.card.id, id);
    assert.equal(current.position.last, false, `${id}: q1 still waits, so the button is 下一题, not 完成`);
    current = await answer(service, current);
    current = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(current.card.id, 'q1', 'the skipped question comes back');
  assert.equal(current.position.last, true, 'nothing else waits: the button says 完成');
  current = await answer(service, current);
  // ← still steps back one question to re-read an answered one, and 下一题 from there does not walk through the answered ones.
  const back = await service.call('review.move', { runId: run.id, direction: -1 });
  assert.equal(back.index, 0, 'nothing before q1: ← stays');
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.complete, true, 'one press from the last answer opens the result page, not question 2');
  assert.equal(current.answered, 4);
});

test('← steps back one question, answered or not, and 下一题 from a re-read question goes to the one still waiting', async (t) => {
  const { service, run } = await library(t, 4);
  let current = await answer(service, run);
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  current = await answer(service, current);
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.card.id, 'q3');
  current = await service.call('review.move', { runId: run.id, direction: -1 });
  assert.equal(current.card.id, 'q2', '← re-reads the answered question before');
  current = await service.call('review.move', { runId: run.id, direction: -1 });
  assert.equal(current.card.id, 'q1');
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.card.id, 'q3', '下一题 skips what is already answered');
});

test('an exam keeps its plain order: 下一题 is the next question, answered or not', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'round-exam-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: ['e1', 'e2', 'e3'].map(quiz) }); });
  const exam = await service.call('review.start', { mode: 'exam', deckId: 'd', count: 3 });
  let current = await service.call('review.answer', { runId: exam.id, cardId: exam.card.id, selected: ['a'] });
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.index, 1);
  current = await service.call('review.answer', { runId: exam.id, cardId: current.card.id, selected: ['a'] });
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.index, 2);
  current = await service.call('review.move', { runId: exam.id, direction: -1 });
  current = await service.call('review.move', { runId: exam.id, direction: -1 });
  assert.equal(current.index, 0);
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.index, 1, 'an answered question next in order is still the next one');
  assert.equal(current.position.last, false);
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.position.last, true, 'an exam: the last in order');
});

/* ── 到此为止 (#1008) ── */

test('到此为止 keeps the answered grades, records nothing for the rest, and the round does not open again', async (t) => {
  const { service, run } = await library(t);
  const before = structuredClone((await service.store.read()).decks[0].cards.map((card) => card.review ?? null));
  const answered = await answer(service, run, ['b']);
  assert.equal(answered.feedback.correct, false);
  const ended = await service.call('review.end', { runId: run.id });
  assert.equal(ended.complete, true);
  assert.equal(ended.closed, true);
  assert.equal(ended.questions, 3);
  assert.equal(ended.answered, 1);
  assert.equal(ended.correct, 0);
  const state = await service.store.read();
  assert.deepEqual(state.attempts.map((item) => item.quiz_id), ['q1'], 'only the answered question has an attempt');
  assert.notDeepEqual(state.decks[0].cards[0].review ?? null, before[0], 'the answered question is scheduled as usual');
  assert.deepEqual(state.decks[0].cards.slice(1).map((card) => card.review ?? null), before.slice(1), 'the unanswered ones keep their schedule');
  const again = await service.call('review.start', { mode: 'path', scope: [1, 2, 3].map((n) => ({ deckId: 'd', cardId: `q${n}` })) });
  assert.notEqual(again.id, run.id, 'starting the same scope opens a new round, never the ended one');
});

/* ── the look-back (#1009) ── */

test('a finished round carries every question for the look-back: answer, solution and Q&A for the answered, only the question for the rest', async (t) => {
  const { service, run } = await library(t);
  await service.store.update((s) => { const card = s.decks[0].cards[0]; card.followups = [{ id: 'f1', question: 'Why?', answer: 'Because.', digest: followupDigest(card), createdAt: new Date().toISOString() }]; });
  await answer(service, run, ['b']);
  const current = await service.call('review.move', { runId: run.id, direction: 1 });
  await answer(service, current);
  assert.deepEqual((await service.call('review.lookBack', { runId: run.id })).rows, [], 'nothing while the round is open');
  const ended = await service.call('review.end', { runId: run.id });
  assert.equal(ended.lookBack, undefined, 'the run itself does not carry it (a main-chat tool result of a finished round stays small)');
  const { rows } = await service.call('review.lookBack', { runId: run.id });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), ['wrong', 'right', 'unanswered']);
  assert.deepEqual(rows.map((row) => row.number), [1, 2, 3]);
  assert.equal(rows[0].card.prompt, 'q1?');
  assert.equal(rows[0].prompt, undefined, 'an answered row has its prompt once, in its card');
  assert.equal(rows[2].prompt, 'q3?', 'an unanswered row has only its prompt');
  for (const row of rows) assert.deepEqual(Object.keys(row).filter((key) => ['index', 'retried'].includes(key)), [], 'no field the page does not read');
  assert.deepEqual(rows[0].feedback.selected, ['b'], 'what the learner chose');
  assert.equal(rows[0].solution.explanation, 'E-q1');
  assert.equal(rows[0].solution.options.find((option) => option.correct).id, 'a', 'the right answer');
  assert.deepEqual(rows[0].solution.followups.map((item) => item.question), ['Why?'], 'the Q&A');
  assert.ok(rows[0].card.options.length === 2 && rows[0].card.options.every((option) => option.correct === undefined), 'the card as it was asked, without the key');
  assert.equal(rows[2].solution, undefined, 'an unanswered question shows no answer');
  assert.equal(rows[2].feedback, undefined);
  // Reading it changes nothing: no attempt, no schedule, no clock.
  const state = await service.store.read();
  const snapshot = JSON.stringify({ attempts: state.attempts, cards: state.decks[0].cards.map((card) => card.review), clocks: state.runs[0].entries.map((entry) => entry.startedAt) });
  assert.equal((await service.call('review.lookBack', { runId: run.id })).rows.length, 3);
  const after = await service.store.read();
  assert.equal(JSON.stringify({ attempts: after.attempts, cards: after.decks[0].cards.map((card) => card.review), clocks: after.runs[0].entries.map((entry) => entry.startedAt) }), snapshot);
});

test('an exam never carries the look-back', async (t) => {
  const { service } = await library(t);
  const exam = await service.call('review.start', { mode: 'exam', scope: [{ deckId: 'd' }], count: 3 });
  await service.call('review.end', { runId: exam.id });
  assert.deepEqual((await service.call('review.lookBack', { runId: exam.id })).rows, [], 'its report has its own rules');
});

test('the look-back is the panel read: the main chat is refused it and does not see it, and review.end of a 50-question round stays small', async (t) => {
  assert.match(assistantRefusal('review.lookBack') || '', /not available to the assistant/);
  assert.equal(assistantRefusal('review.get'), null);
  const index = JSON.stringify(capabilityIndex([{ id: 'study', api: 'study.v1', operations: ['review.get', 'review.lookBack', 'review.end'].map((name) => ({ name, available: true })) }]));
  assert.doesNotMatch(index, /lookBack/, 'not listed to the assistant');
  const { service, run } = await library(t, 50);
  let current = run;
  for (let n = 0; n < 50; n++) {
    current = await answer(service, current);
    if (n < 49) current = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  const open = JSON.stringify(await service.call('review.get', { runId: run.id })).length;
  const ended = JSON.stringify(await service.call('review.end', { runId: run.id })).length;
  assert.ok(ended < open * 1.5, `review.end of 50 answered questions is about the size of the open run (${ended} vs ${open} characters)`);
  assert.ok(JSON.stringify(await service.call('review.lookBack', { runId: run.id })).length > ended, 'the rows are the big part, and only the panel reads them');
});

test('review.lookBack exposes answer-safe source metadata for cited questions without leaking quotes on unanswered rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lookback-sources-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update((s) => {
    s.sources.push(
      { id: 's1-p5', title: 'Algorithm Notes · p. 5', format: 'pdf', document: { id: 'doc-algo', format: 'pdf', bookTitle: 'Algorithm Notes', page: 5 }, text: 'Alpha beta.' },
      { id: 's-plain', title: 'Plain Note', text: 'Delta epsilon.' },
    );
    const cited = (id, sourceId, quote) => ({ ...quiz(id), citations: [{ sourceId, quote }] });
    s.decks.push({ id: 'd', title: 'D', course: 'C', cards: [cited('c1', 's1-p5', 'Alpha'), cited('c2', 's-plain', 'Delta'), quiz('c3')] });
  });
  const current = await service.call('review.start', { mode: 'path', fresh: true, scope: ['c1', 'c2', 'c3'].map((cardId) => ({ deckId: 'd', cardId })) });
  await answer(service, current, ['b']);
  await service.call('review.move', { runId: current.id, direction: 1 });
  // Leave c2 unanswered to verify quote stays private; c3 has no citation.
  await service.call('review.end', { runId: current.id });
  const { rows } = await service.call('review.lookBack', { runId: current.id });
  assert.equal(rows[0].sourceId, 's1-p5');
  assert.equal(rows[0].documentSourceId, 's1-p5');
  assert.equal(rows[0].sourceTitle, 'Algorithm Notes');
  assert.equal(rows[0].page, 5);
  assert.equal(rows[1].sourceId, 's-plain');
  assert.equal(rows[1].sourceTitle, 'Plain Note');
  assert.equal(rows[1].page, undefined, 'unpaged text source omits page');
  assert.equal(rows[1].solution, undefined, 'unanswered row leaks no solution or quote');
  assert.doesNotMatch(JSON.stringify(rows[1]), /Delta/, 'unanswered row does not leak cited quote');
  assert.equal(rows[2].sourceId, undefined);
  assert.equal(rows[2].sourceTitle, undefined);
});

test('RoundLookBack shows CitationDisclosure for answered rows and clickable source-page links in Chinese and English', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { readFileSync } = await import('node:fs');
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const uiMod = await loadUi(`
    export { default as RoundLookBack } from './ui/review/RoundLookBack.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setQueryData } from './ui/host-query.js';
    export { setUiLanguage, uiCatalogue } from './ui/i18n.js';`);
  Object.assign(uiMod.uiCatalogue(), JSON.parse(readFileSync(new URL('../ui/locales/en.polish-results.json', import.meta.url), 'utf8')));
  const inLanguage = (lang, fn) => { uiMod.setUiLanguage(lang); try { return fn(); } finally { uiMod.setUiLanguage('zh'); } };
  const noop = () => {};
  const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const sources = [{ id: 's1-p5', title: 'Algorithm Notes · p. 5', format: 'pdf', document: { id: 'doc-algo', format: 'pdf', bookTitle: 'Algorithm Notes', page: 5 }, text: 'Alpha beta.' }];
  const options = [{ id: 'a', text: 'yes' }, { id: 'b', text: 'no' }];
  const rows = [
    {
      number: 1, entryIndex: 0, deckId: 'd', cardId: 'c1', kind: 'quiz', status: 'wrong',
      sourceId: 's1-p5', documentSourceId: 's1-p5', sourceTitle: 'Algorithm Notes', page: 5,
      card: { id: 'c1', kind: 'quiz', prompt: 'Q1?', options },
      feedback: { selected: ['b'] },
      solution: { explanation: 'E1', options: [{ id: 'a', correct: true }], citations: [{ sourceId: 's1-p5', quote: 'Alpha beta' }], followups: [] },
    },
    {
      number: 2, entryIndex: 1, deckId: 'd', cardId: 'c2', kind: 'quiz', status: 'unanswered',
      sourceId: 's1-p5', documentSourceId: 's1-p5', sourceTitle: 'Algorithm Notes', page: 5,
      prompt: 'Q2?',
    },
    {
      number: 3, entryIndex: 2, deckId: 'd', cardId: 'c3', kind: 'open', status: 'grading',
      sourceId: 's1-p5', documentSourceId: 's1-p5', sourceTitle: 'Algorithm Notes', page: 5,
      prompt: 'Q3?',
      solution: { citations: [{ sourceId: 's1-p5', quote: 'Secret grading answer' }], followups: [] },
    },
  ];
  const run = { id: 'r-lb-src', mode: 'path', navigation: [{ answered: true }, { answered: false }, { grading: true }], correctionsPending: 0 };
  const render = () => {
    uiMod.setQueryData('review.lookBack', { runId: run.id }, { rows });
    const realUseState = React.useState;
    React.useState = (init) => (typeof init === 'function' && init() instanceof Set ? realUseState(() => new Set([1, 2, 3])) : realUseState(init));
    try {
      return renderToStaticMarkup(React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
        React.createElement(uiMod.RoundLookBack, { run, sources })));
    } finally { React.useState = realUseState; }
  };
  const zh = render();
  const panel = (n) => zh.split(`id="look-back-r-lb-src-${n}"`)[1].split('</li>')[0];
  assert.match(panel(1), /citation-disclosure/, 'answered row renders CitationDisclosure');
  assert.match(panel(1), /打开出处「Algorithm Notes」第 5 页/, 'answered row renders source page button');
  assert.doesNotMatch(panel(2), /citation-disclosure/, 'unanswered row hides CitationDisclosure');
  assert.match(panel(2), /打开出处「Algorithm Notes」第 5 页/, 'unanswered row still links to source page safely');
  assert.doesNotMatch(panel(3), /citation-disclosure/, 'grading row hides CitationDisclosure');
  const en = inLanguage('en', render);
  assert.doesNotMatch(en, /[\u3400-\u9fff]/, 'English look-back has no Chinese characters');
  assert.match(en, /Open source “Algorithm Notes” \(Page 5\)/);
  assert.match(en, /Check citations/);
});

/* ── the size of the next batch (#1009) ── */

test('a round of new questions takes the new-question limit of the round size (设置 › 练习: 「新题最多 N 道」)', () => {
  for (const [size, fresh] of [[5, 3], [10, 5], [30, 15]]) {
    assert.equal(freshRoundCount({ roundSize: size }), fresh, `round size ${size}`);
    assert.equal(freshRoundCount({ roundSize: size }), roundLimits(size).newLimit, 'the same number the settings hint shows');
  }
  assert.equal(freshRoundCount(undefined), 10, 'the default: 20 a round, at most 10 new');
  assert.equal(freshRoundCount({ roundSize: 999 }), 10, 'an out-of-range value falls back to the default');
});

test('the host defaults for new questions are the same number (review.start mode new, focus.fresh)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-defaults-'));
  const service = new StudyService(root);
  try {
    await service.store.update((s) => {
      s.decks.push({ id: 'n', title: 'New', course: 'C', cards: Array.from({ length: 30 }, (_, i) => quiz(`n${i}`)) });
      s.settings = { ...s.settings, practice: { roundSize: 30 } };
    });
    await service.call('focus.set', { course: 'C' });
    assert.equal((await service.call('snapshot')).focus.fresh.length, 15, 'focus.fresh: the new-question limit of a 30 round');
    const run = await service.call('review.start', { mode: 'new', currentCourse: true, fresh: true });
    assert.equal(run.total, 15, 'review.start mode new without a count');
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/* ── the keys (#1008) ── */

test('K sets the question aside, N writes a note, F marks it as focus, O opens its page; never inside a field, never in an exam', () => {
  const run = { id: 'r', mode: 'path', index: 0, card: { id: 'c', kind: 'quiz', options: [{ id: 'a' }, { id: 'b' }] }, feedback: null, revealed: false };
  const ctx = (extra = {}) => ({ inside: true, modalOpen: false, page: 'review', run, busy: false, shortcutHelp: false, choice: true, isCloze: false, rubricCard: false, selected: [], clozeValues: {}, ...extra });
  const press = (key, { inEditable = false, ...extra } = {}) => shortcutAction({ key, code: `Key${key.toUpperCase()}`, shiftKey: false, repeat: false, defaultPrevented: false, inEditable }, ctx(extra))?.action;
  assert.deepEqual(press('k'), { type: 'skip' });
  assert.deepEqual(press('n'), { type: 'note' });
  assert.deepEqual(press('f'), { type: 'focus' });
  assert.deepEqual(press('o'), { type: 'source' });
  assert.equal(press('k', { inEditable: true }), undefined, 'typing a k in an answer is typing');
  assert.equal(press('n', { inEditable: true }), undefined);
  const exam = { ...run, mode: 'exam' };
  for (const key of ['k', 'n', 'f', 'o']) assert.equal(press(key, { run: exam }), null, `${key} does nothing in an exam`);
  // The old keys keep their meaning.
  assert.deepEqual(press('h'), { type: 'hint' });
  assert.deepEqual(press('1'), { type: 'choose', id: 'a' });
});

test('Cloze Enter jumps into the first blank, advances across empty blanks, submits when filled, and Esc returns focus to the card', () => {
  const clozeRun = { id: 'rc', mode: 'path', index: 0, card: { id: 'c', kind: 'cloze', cloze: { text: '{{b1}} and {{b2}}' } }, feedback: null, revealed: false };
  const ctx = (extra = {}) => ({ inside: true, modalOpen: false, page: 'review', run: clozeRun, busy: false, shortcutHelp: false, choice: false, isCloze: true, rubricCard: false, selected: [], clozeValues: {}, ...extra });
  const press = (key, extra = {}) => shortcutAction({ key, code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`, shiftKey: false, repeat: false, defaultPrevented: false, inEditable: false }, ctx(extra))?.action;
  assert.deepEqual(press('Enter'), { type: 'focus-cloze' }, 'Enter on an empty cloze jumps into the first blank');
  assert.deepEqual(press('Enter', { clozeValues: { b1: 'one' } }), { type: 'answer', args: { answers: { b1: 'one' } } }, 'Enter from the card submits once a blank has text');
  assert.deepEqual(press('v'), { type: 'voice' }, 'V still triggers voice while the card holds focus');
  assert.deepEqual(press('h'), { type: 'hint' }, 'H still opens hint while the card holds focus');
  assert.deepEqual(press('Enter', { run: { ...clozeRun, feedback: { grade: 5 } } }), { type: 'move', direction: 1 }, 'Enter after feedback still advances');

  const key = (k, extra = {}) => ({ key: k, repeat: false, isComposing: false, keyCode: k === 'Enter' ? 13 : 27, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(clozeBlankKeyAction(key('Enter', { isComposing: true }), { blankIds: ['b1'], currentId: 'b1', values: { b1: 'x' } }), null, 'IME Enter is ignored');
  assert.equal(clozeBlankKeyAction(key('Enter', { keyCode: 229 }), { blankIds: ['b1'], currentId: 'b1', values: { b1: 'x' } }), null, 'legacy IME keyCode 229 is ignored');
  assert.equal(clozeBlankKeyAction(key('Escape', { isComposing: true }), { blankIds: ['b1'], currentId: 'b1', values: {} }), null, 'IME Escape cancels composition first');
  assert.deepEqual(clozeBlankKeyAction(key('Escape'), { blankIds: ['b1'], currentId: 'b1', values: {} }), { type: 'blur' }, 'Escape returns focus to the card');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1'], currentId: 'b1', values: {} }), { type: 'noop' }, 'single empty blank does not submit');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1'], currentId: 'b1', values: { b1: 'ok' } }), { type: 'submit' }, 'single filled blank submits');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: 'one', b2: '' } }), { type: 'focus', id: 'b2' }, 'Enter moves from filled blank 1 to empty blank 2');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b2', values: { b1: '', b2: 'two' } }), { type: 'focus', id: 'b1' }, 'Enter wraps back to an earlier empty blank');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: '', b2: 'two' } }), { type: 'noop' }, 'stays on the only empty blank');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b2', values: { b1: 'one', b2: 'two' } }), { type: 'submit' }, 'all filled submits on Enter');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { ctrlKey: true }), { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: 'one' } }), { type: 'submit' }, 'Ctrl+Enter submits with >=1 blank filled');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { metaKey: true }), { blankIds: ['b1', 'b2'], currentId: 'b1', values: {} }), { type: 'noop' }, 'Cmd+Enter with all empty does nothing');
});

/* ── the poll (#1011) ── */

test('the practice page polls every 4 s, slows down while nothing changes up to about 30 s, and keeps 4 s while a helper task runs', () => {
  const delays = Array.from({ length: 12 }, (_, unchanged) => reviewPollDelay(4000, { unchanged }));
  assert.equal(delays[0], 4000);
  for (let index = 1; index < delays.length; index++) assert.ok(delays[index] >= delays[index - 1], 'never faster while nothing changes');
  assert.ok(delays[3] > 4000, 'slower after a few unchanged answers');
  assert.equal(Math.max(...delays), 30000, 'capped at 30 s');
  assert.equal(reviewPollDelay(4000, { unchanged: 50, running: true }), 4000, 'a running helper task keeps the quick rhythm');
});

test('a poll that changes nothing says so, and a helper task on the open question keeps the poll quick', () => {
  const open = { id: 'r', index: 0, queueVersion: 0, revealed: false, feedback: null, card: { id: 'c' }, followups: [] };
  assert.deepEqual(reviewPollResult(open, { ...open }), { unchanged: true, running: false });
  assert.deepEqual(reviewPollResult(open, { ...open, followups: [{ id: 'f1', question: 'Q', answer: 'A' }] }), { running: false }, 'a new Q&A is a change');
  assert.deepEqual(reviewPollResult(open, { ...open, card: { id: 'c', prompt: 'fixed' } }), { running: false }, 'a fixed question is a change');
  assert.deepEqual(reviewPollResult(open, { ...open }, true), { unchanged: true, running: true });
  const tasks = [{ cardId: 'c', status: 'running', mode: 'ask' }, { cardId: 'x', status: 'running', mode: 'improve' }, { cardId: 'g', status: 'running', mode: 'grade' }];
  assert.equal(assistRunningOn(tasks, 'c'), true);
  assert.equal(assistRunningOn(tasks, 'g'), true, '批改 arrives through the same poll, so it keeps the quick rhythm too');
  assert.equal(assistRunningOn(tasks, 'y'), false);
  assert.equal(assistRunningOn([{ cardId: 'c', status: 'done', mode: 'ask' }], 'c'), false);
  assert.equal(assistRunningOn(undefined, 'c'), false);

  // The page asks at once when a task on the open question ends (its answer or its 批改 is in the run): which task to watch, whatever its mode.
  const own = [{ id: 't1', cardId: 'g', status: 'running', mode: 'grade' }];
  assert.deepEqual(finishedTask('', own, 'g'), { watch: 't1', done: false }, 'a running 批改 is watched');
  assert.deepEqual(finishedTask('t1', [{ ...own[0], status: 'done' }], 'g'), { watch: '', done: true }, 'it ended: ask now');
  assert.deepEqual(finishedTask('t1', [{ ...own[0], status: 'failed' }], 'g'), { watch: '', done: false }, 'a failed task brings nothing to show');
  assert.deepEqual(finishedTask('', [], 'g'), { watch: '', done: false });

  // Concurrent tasks on the same card: completing t1 while t2 is still running triggers an immediate poll while keeping t2 watched.
  const twoRunning = [
    { id: 't1', cardId: 'g', status: 'running', mode: 'terms' },
    { id: 't2', cardId: 'g', status: 'running', mode: 'terms' },
  ];
  assert.deepEqual(finishedTask('', twoRunning, 'g'), { watch: 't1,t2', done: false });
  assert.deepEqual(
    finishedTask('t1,t2', [{ ...twoRunning[0], status: 'done' }, twoRunning[1]], 'g'),
    { watch: 't2', done: true },
    'completing t1 while t2 still runs immediately signals done and keeps watching t2',
  );
  assert.deepEqual(
    finishedTask('t2', [{ ...twoRunning[0], status: 'done' }, { ...twoRunning[1], status: 'done' }], 'g'),
    { watch: '', done: true },
    'completing t2 afterwards signals done again',
  );
});

test('Cloze Shift+Enter steps back through blanks cleanly and ignores modifiers/IME (#32)', () => {
  const key = (k, extra = {}) => ({ key: k, repeat: false, isComposing: false, keyCode: 13, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { shiftKey: true }), { blankIds: ['b1', 'b2', 'b3'], currentId: 'b2', values: {} }), { type: 'focus', id: 'b1' });
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { shiftKey: true }), { blankIds: ['b1', 'b2', 'b3'], currentId: 'b1', values: {} }), { type: 'focus', id: 'b3' }, 'wraps from first to last blank');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { shiftKey: true }), { blankIds: ['b1'], currentId: 'b1', values: {} }), { type: 'noop' }, 'single blank does not step');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { shiftKey: true, ctrlKey: true }), { blankIds: ['b1', 'b2'], currentId: 'b2', values: {} }), { type: 'noop' });
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { shiftKey: true, altKey: true }), { blankIds: ['b1', 'b2'], currentId: 'b2', values: {} }), { type: 'noop' });
  assert.equal(clozeBlankKeyAction(key('Enter', { shiftKey: true, isComposing: true }), { blankIds: ['b1', 'b2'], currentId: 'b2', values: {} }), null);
});

test('appendFixPhrase appends without overwriting and avoids duplicates (#40)', async () => {
  const { appendFixPhrase } = await loadUi("export { appendFixPhrase } from './ui/review/FixPhrases.jsx';");
  assert.equal(appendFixPhrase('', '解析没说清'), '解析没说清');
  assert.equal(appendFixPhrase('   ', '解析没说清'), '解析没说清');
  assert.equal(appendFixPhrase('选项 B 有歧义', '解析没说清'), '选项 B 有歧义；解析没说清');
  assert.equal(appendFixPhrase('选项 B 有歧义；解析没说清', '解析没说清'), '选项 B 有歧义；解析没说清');
});

test('RoundPending renders pending chip only when waiting questions remain (#5, #36)', async () => {
  const { default: RoundPending } = await loadUi("export { default } from './ui/review/RoundPending.jsx';");
  const mixed = [
    { index: 0, answered: true, correct: true, prompt: 'Answered Q' },
    { index: 1, answered: false, prompt: 'Skipped Q' },
    { index: 2, answered: false, prompt: 'Normal Q' },
  ];
  const html = renderToStaticMarkup(React.createElement(RoundPending, {
    run: { id: 'r1', mode: 'path', index: 2, navigation: mixed }, skippedIndices: new Set([0, 1]), onJump() {}, onEnd() {},
  }));
  assert.match(html, /2 题待答/);

  const finished = renderToStaticMarkup(React.createElement(RoundPending, {
    run: { id: 'r1', mode: 'path', index: 0, navigation: [{ index: 0, answered: true, prompt: 'Done' }] }, onJump() {}, onEnd() {},
  }));
  assert.equal(finished, '', 'hides chip once all questions are answered');
});

test('RoundEndConfirm renders confirm controls when endAsked is active (#37)', async () => {
  const { RoundEndConfirm } = await loadUi("export { RoundEndConfirm } from './ui/review/RoundSteps.jsx';");
  const html = renderToStaticMarkup(React.createElement(RoundEndConfirm, {
    session: { endAsked: true, run: { navigation: [{ index: 0, answered: false }, { index: 1, answered: true }] }, actions: { confirmEnd() {}, cancelEnd() {} } },
  }));
  assert.match(html, /到此为止，看结果/);
  assert.match(html, /接着做/);
});

async function loadLookBackUi() {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { readFileSync } = await import('node:fs');
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const uiMod = await loadUi(`
    export { default as RoundLookBack, formatLookBackMarkdown } from './ui/review/RoundLookBack.jsx';
    export { default as ResultBreakdown } from './ui/ResultBreakdown.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setQueryData } from './ui/host-query.js';
    export { setUiLanguage, uiCatalogue } from './ui/i18n.js';`);
  Object.assign(uiMod.uiCatalogue(), JSON.parse(readFileSync(new URL('../ui/locales/en.polish-results.json', import.meta.url), 'utf8')));
  return { React, renderToStaticMarkup, uiMod };
}

function mountLookBackSync(React, uiMod, services) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    render(Component, props) {
      cursor = 0;
      pending = [];
      const prev = internals.H;
      internals.H = {
        useContext: (ctx) => (ctx === uiMod.StudyServicesContext ? services : ctx._currentValue),
        useState: (init) => {
          const i = cursor++;
          if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
            hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
          }];
          return hooks[i];
        },
        useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
        useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
        useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
        useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
        useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:lb${i}:`; return hooks[i]; },
        useDeferredValue: (v) => v,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
      let tree;
      try { tree = Component(props); } finally { internals.H = prev; }
      for (const eff of pending) {
        cleanups[eff.i]?.();
        cleanups[eff.i] = undefined;
        const done = eff.fn();
        hooks[eff.i] = { deps: eff.deps };
        if (typeof done === 'function') cleanups[eff.i] = done;
      }
      return tree;
    },
    unmount() { for (const c of cleanups) c?.(); },
  };
}

function walkLookBack(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walkLookBack(c, visit); return; }
  if (node.props) {
    visit(node);
    if (typeof node.props.render === 'function' && Array.isArray(node.props.items)) {
      node.props.items.forEach((item) => walkLookBack(node.props.render(item), visit));
    }
    walkLookBack(node.props.children, visit);
  }
}

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return typeof node === 'object' && node.props ? textOf(node.props.children) : '';
};

test('#7: roundLookBack flags hesitant-correct rows when elapsed_ms >= 25s and >= 3x median across >= 3 timed answers, and RoundLookBack renders badge + filter', async (t) => {
  const { service, run } = await library(t, 5);
  // Answer q1..q4 as right, wrong, right, right; leave q5 unanswered.
  let cur = run;
  for (let i = 0; i < 4; i++) {
    cur = await answer(service, cur, [i === 1 ? 'b' : 'a']);
    if (i < 3) cur = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  await service.call('review.end', { runId: run.id });
  const elapsed = { q1: 4000, q2: 32000, q3: 5000, q4: 95000 };
  await service.store.update((s) => {
    for (const a of s.attempts) {
      if (a.runId === run.id && elapsed[a.quiz_id]) a.elapsed_ms = elapsed[a.quiz_id];
    }
    // Add a slow retry attempt on q3 that must be ignored for non-retry hesitant timing
    s.attempts.push({ runId: run.id, quiz_id: 'q3', retry: true, elapsed_ms: 90000, grade: 5 });
  });
  const { rows } = await service.call('review.lookBack', { runId: run.id });
  const byId = Object.fromEntries(rows.map((r) => [r.cardId, r]));
  assert.equal(byId.q1.hesitant, undefined);
  assert.equal(byId.q2.hesitant, undefined, 'wrong rows are never marked hesitant');
  assert.equal(byId.q3.hesitant, undefined, 'retry attempt does not mark q3 hesitant');
  assert.equal(byId.q4.hesitant, true, 'q4 (95s >= 25s and >= 3x median 18.5s) is hesitant');

  // Verify exact threshold: [4000, 5000, 6000, 26000] -> median=(5000+6000)/2=5500, 3x=16500 -> 26000 qualifies
  await service.store.update((s) => {
    for (const a of s.attempts) {
      if (a.runId === run.id && a.quiz_id === 'q2') a.elapsed_ms = 6000;
      if (a.runId === run.id && a.quiz_id === 'q4') a.elapsed_ms = 26000;
    }
  });
  const rowsFixed = (await service.call('review.lookBack', { runId: run.id })).rows;
  const q4Fixed = rowsFixed.find((r) => r.cardId === 'q4');
  assert.equal(q4Fixed.hesitant, true);
  assert.equal(q4Fixed.elapsedMs, 26000);

  // < 3 timed answers never flags hesitant
  await service.store.update((s) => {
    for (const a of s.attempts) if (a.runId === run.id && (a.quiz_id === 'q1' || a.quiz_id === 'q2')) a.elapsed_ms = 0;
  });
  const rowsTooFew = (await service.call('review.lookBack', { runId: run.id })).rows;
  assert.equal(rowsTooFew.find((r) => r.cardId === 'q4').hesitant, undefined);

  const { React, renderToStaticMarkup, uiMod } = await loadLookBackUi();
  const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: () => {}, openModal: () => {} };
  const sampleRows = [
    { number: 1, entryIndex: 0, deckId: 'd', cardId: 'q1', kind: 'quiz', status: 'wrong', card: { id: 'q1', kind: 'quiz', prompt: 'Wrong Q', options: [{ id: 'a', text: 'yes' }] }, feedback: { selected: [] }, solution: { explanation: 'E1', options: [{ id: 'a', correct: true }] } },
    { number: 2, entryIndex: 1, deckId: 'd', cardId: 'q4', kind: 'quiz', status: 'right', hesitant: true, elapsedMs: 26000, card: { id: 'q4', kind: 'quiz', prompt: 'Slow right Q', options: [{ id: 'a', text: 'yes' }] }, feedback: { selected: ['a'] }, solution: { explanation: 'E4', options: [{ id: 'a', correct: true }] } },
  ];
  const uiRun = { id: 'r-hesitant', mode: 'path', navigation: [{ answered: true }, { answered: true }], correctionsPending: 0 };
  const renderHtml = () => {
    uiMod.setQueryData('review.lookBack', { runId: uiRun.id }, { rows: sampleRows });
    return renderToStaticMarkup(React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
      React.createElement(uiMod.RoundLookBack, { run: uiRun })));
  };
  uiMod.setUiLanguage('zh');
  const htmlZh = renderHtml();
  assert.match(htmlZh, /只看想了较久 \(1\)/);

  uiMod.setQueryData('review.lookBack', { runId: uiRun.id }, { rows: sampleRows });
  const app = mountLookBackSync(React, uiMod, services);
  let tree = app.render(uiMod.RoundLookBack, { run: uiRun });
  let filterBtn = null;
  walkLookBack(tree, (n) => { if (!filterBtn && textOf(n).trim() === '只看想了较久 (1)') filterBtn = n; });
  assert.ok(filterBtn);
  filterBtn.props.onClick();
  tree = app.render(uiMod.RoundLookBack, { run: uiRun });
  const renderedNumbers = [];
  walkLookBack(tree, (n) => { if (n.type === 'li' && n.props.className === 'look-back__row') renderedNumbers.push(n.props['data-number']); });
  assert.deepEqual(renderedNumbers, [2], 'hesitant toggle filters list to hesitant-correct rows');
  const badgeNodes = [];
  walkLookBack(tree, (n) => { if (textOf(n) === '想了较久') badgeNodes.push(n); });
  assert.ok(badgeNodes.length >= 1, 'renders 想了较久 badge');

  uiMod.setUiLanguage('en');
  try {
    tree = app.render(uiMod.RoundLookBack, { run: uiRun });
    let enFilter = null;
    walkLookBack(tree, (n) => { if (!enFilter && textOf(n).trim() === 'Took longer only (1)') enFilter = n; });
    assert.ok(enFilter, 'English hesitant filter toggle');
    const enBadges = [];
    walkLookBack(tree, (n) => { if (textOf(n) === 'Took longer') enBadges.push(n); });
    assert.ok(enBadges.length >= 1, 'English hesitant badge');
  } finally {
    uiMod.setUiLanguage('zh');
    app.unmount();
  }
});

test('#6, #41, #42, #43, #44: ResultBreakdown legend filtering, RoundLookBack expand all, practice wrong, Markdown copy, and keyboard nav', async () => {
  const { React, renderToStaticMarkup, uiMod } = await loadLookBackUi();
  const { RoundLookBack, ResultBreakdown, formatLookBackMarkdown, setQueryData, setUiLanguage } = uiMod;

  // #41: ResultBreakdown interactive legend items (only count > 0)
  const pickedSegments = [];
  const breakdownHtml = renderToStaticMarkup(React.createElement(ResultBreakdown, {
    total: 3, answered: 3, correct: 2, activeSegment: 'practice',
    onSelectSegment: (k) => pickedSegments.push(k),
  }));
  assert.match(breakdownHtml, /aria-pressed="true"[^>]*>[\s\S]*?<span>需要巩固<\/span><strong>1<\/strong>/);
  assert.match(breakdownHtml, /aria-pressed="false"[^>]*>[\s\S]*?<span>掌握<\/span><strong>2<\/strong>/);
  assert.doesNotMatch(breakdownHtml, /<button[^>]*>(?:(?!<\/button>)[\s\S])*?未答/, 'zero-count segment stays non-interactive');
  const bdApp = mountLookBackSync(React, uiMod, { call: async () => ({}), act: async () => undefined, busy: false });
  const bdTree = bdApp.render(ResultBreakdown, { total: 3, answered: 3, correct: 2, activeSegment: 'practice', onSelectSegment: (k) => pickedSegments.push(k) });
  let rightBtn = null;
  walkLookBack(bdTree, (n) => { if (!rightBtn && n.props?.className === 'result-legend-item' && typeof n.props?.onClick === 'function' && textOf(n).includes('掌握')) rightBtn = n; });
  rightBtn.props.onClick();
  bdApp.unmount();
  assert.deepEqual(pickedSegments, ['correct']);

  // Look-back rows across right, wrong, unanswered + sources
  const srcA = { id: 'src-a', title: 'Notes A', format: 'pdf', document: { id: 'doc-a', format: 'pdf', bookTitle: 'Notes A', page: 3 }, text: 'Alpha' };
  const sampleRows = [
    {
      number: 1, entryIndex: 0, deckId: 'd1', cardId: 'c1', kind: 'quiz', status: 'wrong',
      sourceId: 'src-a', documentSourceId: 'src-a', sourceTitle: 'Notes A', page: 3,
      card: { id: 'c1', kind: 'quiz', prompt: 'Q1?', options: [{ id: 'a', text: 'OptA' }, { id: 'b', text: 'OptB' }] },
      feedback: { selected: ['b'] },
      solution: { explanation: 'Exp 1', misconception: 'Mis 1', options: [{ id: 'a', correct: true }] },
    },
    {
      number: 2, entryIndex: 1, deckId: 'd1', cardId: 'c2', kind: 'quiz', status: 'wrong',
      card: { id: 'c2', kind: 'quiz', prompt: 'Q2?', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] },
      feedback: { selected: ['b'] },
      solution: { explanation: 'Exp 2', options: [{ id: 'a', correct: true }] },
    },
    {
      number: 3, entryIndex: 2, deckId: 'd1', cardId: 'c3', kind: 'quiz', status: 'right',
      card: { id: 'c3', kind: 'quiz', prompt: 'Q3?', options: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Bad' }] },
      feedback: { selected: ['a'] },
      solution: { explanation: 'Exp 3', options: [{ id: 'a', correct: true }] },
    },
    {
      number: 4, entryIndex: 3, deckId: 'd1', cardId: 'c4', kind: 'quiz', status: 'unanswered',
      prompt: 'Q4?',
    },
  ];
  const modals = [];
  const practicedWrong = [];
  const run = { id: 'r-kb', mode: 'path', navigation: [{ answered: true }, { answered: true }, { answered: true }, { answered: false }], correctionsPending: 0 };
  const services = {
    call: async (action) => (action === 'review.lookBack' ? { rows: sampleRows } : {}),
    act: async () => undefined,
    busy: false,
    notify: () => {},
    openModal: (m) => modals.push(m),
  };

  setUiLanguage('zh');
  setQueryData('review.lookBack', { runId: run.id }, { rows: sampleRows });
  const app = mountLookBackSync(React, uiMod, services);
  const props = { run, sources: [srcA], onPracticeWrong: (refs) => practicedWrong.push(refs) };
  let tree = app.render(RoundLookBack, props);

  // #42: Expand all / Collapse all
  const findButton = (label) => {
    let found = null;
    walkLookBack(tree, (n) => { if (!found && typeof n.type !== 'string' && textOf(n).trim() === label) found = n; });
    return found;
  };
  assert.ok(findButton('全部展开'), 'shows 全部展开 when >= 2 rows shown');
  findButton('全部展开').props.onClick();
  tree = app.render(RoundLookBack, props);
  assert.ok(findButton('全部收起'), 'flips to 全部收起 once all shown rows are expanded');

  // #43: 重练这 2 道错题 & singular 重练这道错题
  const retryBtn = findButton('重练这 2 道错题');
  assert.ok(retryBtn);
  retryBtn.props.onClick();
  assert.deepEqual(practicedWrong, [[{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]]);

  // #41: segment prop filters RoundLookBack rows to matching status
  tree = app.render(RoundLookBack, { ...props, segment: 'unanswered' });
  const segNumbers = [];
  walkLookBack(tree, (n) => { if (n.type === 'li' && n.props.className === 'look-back__row') segNumbers.push(n.props['data-number']); });
  assert.deepEqual(segNumbers, [4]);

  // #44: formatLookBackMarkdown & clipboard copy button
  const mdZh = formatLookBackMarkdown([{ ...sampleRows[0], mode: 'path' }]);
  assert.match(mdZh, /### 1\. \[答错\] Q1\?/);
  assert.match(mdZh, /\*\*你的答案\*\*：B\. OptB/);
  assert.match(mdZh, /\*\*正确答案\*\*：A\. OptA/);
  assert.match(mdZh, /\*\*解析\*\*：Exp 1/);
  assert.match(mdZh, /\*\*易错点\*\*：Mis 1/);
  assert.match(formatLookBackMarkdown([{ number: 9, status: 'wrong', mode: 'path', card: { id: 'empty', kind: 'open', prompt: '' }, solution: { answer: 'Ans' } }]), /题干尚未填写/);

  const copiedTexts = [];
  const origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (txt) => { copiedTexts.push(txt); } } } });
  try {
    tree = app.render(RoundLookBack, props);
    const copyBtn = findButton('复制复盘摘录');
    assert.ok(copyBtn);
    await copyBtn.props.onClick();
    assert.equal(copiedTexts.length, 1);
    assert.match(copiedTexts[0], /### 1\. \[答错\] Q1\?/);
    assert.match(copiedTexts[0], /### 2\. \[答错\] Q2\?/);
    tree = app.render(RoundLookBack, props);
    assert.ok(findButton('已复制'), 'button shows 已复制 feedback');

    setUiLanguage('en');
    tree = app.render(RoundLookBack, props);
    assert.ok(findButton('Practise these 2 missed questions'));
    assert.ok(findButton('Copied'));
    assert.ok(findButton('Collapse all'));
  } finally {
    setUiLanguage('zh');
    if (origNavigator) Object.defineProperty(globalThis, 'navigator', origNavigator); else delete globalThis.navigator;
  }

  // #6: keyboard ArrowDown/ArrowUp/Home/End + O opens source modal
  tree = app.render(RoundLookBack, props);
  const focusedLines = [];
  const lineNodes = [1, 2, 4].map((num) => {
    const rowEl = { dataset: { number: String(num) } };
    const el = {
      focus: () => focusedLines.push(num),
      closest: (sel) => (sel === '.look-back__line' ? el : sel === '.look-back__row' ? rowEl : null),
    };
    return el;
  });
  const sectionContainer = { querySelectorAll: (sel) => (sel === '.look-back__line' ? lineNodes : []) };
  const fireKey = (key, idx, extra = {}) => {
    let prevented = false;
    tree.props.onKeyDown({
      key,
      metaKey: false, ctrlKey: false, altKey: false, isComposing: false,
      ...extra,
      target: lineNodes[idx],
      currentTarget: sectionContainer,
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  };
  assert.equal(fireKey('ArrowDown', 0), true);
  assert.equal(fireKey('End', 0), true);
  assert.equal(fireKey('ArrowUp', 2), true);
  assert.equal(fireKey('Home', 2), true);
  assert.deepEqual(focusedLines, [2, 4, 2, 1]);

  assert.equal(fireKey('o', 0), true);
  assert.equal(modals.length, 1);
  assert.equal(modals[0].type, 'source');
  assert.equal(modals[0].source.id, 'src-a');
  assert.equal(fireKey('O', 0, { ctrlKey: true }), false, 'modified O does not trigger source jump');

  app.unmount();
});

test('Review passes session.skippedIndices to ReviewNavigator so skipped unanswered items show skipped indicators', async () => {
  const { Review, StudyServicesContext, setUiLanguage } = await loadUi(`
    export { default as Review } from './ui/Review.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  setUiLanguage('zh');
  const noop = () => {};
  const run = {
    id: 'run-skip-ui',
    mode: 'path',
    index: 1,
    total: 3,
    questions: 3,
    complete: false,
    deckId: 'd',
    card: quiz('q2'),
    navigation: [
      { index: 0, answered: false, level: 0, topic: 'T-q1' },
      { index: 1, answered: false, level: 0, topic: 'T-q2' },
      { index: 2, answered: true, passed: true, level: 1, topic: 'T-q3' },
    ],
    position: { total: 3, at: 2, retries: 0, retryAt: 0, last: false },
  };
  const emptyEntry = { selected: [], response: '', clozeValues: {}, hint: false, explain: false, teaching: null, teachAnswer: '', assistance: {} };
  const makeSession = (skippedIndices) => ({
    run,
    choice: true,
    isCloze: false,
    rubricCard: false,
    entry: emptyEntry,
    skippedIndices,
    subscribeLive: () => () => {},
    getLive: () => ({ entry: emptyEntry, keyGrade: null, autoAdvancePaused: false, explainHidden: false, pendingAnswer: null }),
    enterRun: noop,
    flushDraft: async () => true,
    questionKeys: { current: {} },
    actions: {
      reviewAct: async () => undefined,
      choose: noop,
      clearChoice: noop,
      flipCard: noop,
      toggleHelp: noop,
      toggleEn: noop,
      toggleAutoTerms: noop,
      toggleAutopilot: noop,
      toggleSelfGradeAdvance: noop,
      skipQuestion: noop,
      askEnd: noop,
      cancelEnd: noop,
      endRound: noop,
      setAutoAdvancePaused: noop,
      setResponse: noop,
      setClozeValue: noop,
      setTeachAnswer: noop,
      noteAssistance: noop,
    },
  });
  const data = { root: 'r', decks: [{ id: 'd', title: 'D', course: 'C', cards: [] }], sources: [], settings: {} };
  const services = {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    host: { capabilities: {} },
    navigate: noop,
    openSettings: noop,
    notify: noop,
    openModal: noop,
  };
  const renderTicks = (skippedIndices) => {
    const html = renderToStaticMarkup(React.createElement(
      StudyServicesContext.Provider,
      { value: services },
      React.createElement(Review, { session: makeSession(skippedIndices), data, shellTitle: 'D' }),
    ));
    const navMatch = html.match(/<nav class="review-navigator"[\s\S]*?<\/nav>/);
    assert.ok(navMatch, 'Review renders ReviewNavigator rail for an active round');
    return [...navMatch[0].matchAll(/<button class="review-tick"[^>]*>/g)].map((m) => m[0]);
  };

  try {
    const ticksWithSkip = renderTicks(new Set([0, 2]));
    assert.equal(ticksWithSkip.length, 3, 'ReviewNavigator renders one tick per question');
    assert.match(ticksWithSkip[0], /data-skipped="true"/, 'unanswered skipped index carries data-skipped="true"');
    assert.match(ticksWithSkip[0], /aria-label="[^"]*先跳过待答"/, 'unanswered skipped tick announces 先跳过待答');
    assert.doesNotMatch(ticksWithSkip[1], /data-skipped="true"/, 'current unskipped index is not marked skipped');
    assert.doesNotMatch(ticksWithSkip[1], /先跳过待答/);
    assert.match(ticksWithSkip[1], /aria-current="step"/);
    assert.doesNotMatch(ticksWithSkip[2], /data-skipped="true"/, 'answered index is not marked skipped even if present in skippedIndices');
    assert.doesNotMatch(ticksWithSkip[2], /先跳过待答/);

    const ticksNoSkip = renderTicks(new Set());
    assert.equal(ticksNoSkip.length, 3);
    for (const tick of ticksNoSkip) {
      assert.doesNotMatch(tick, /data-skipped="true"/, 'empty skippedIndices marks no tick as skipped');
      assert.doesNotMatch(tick, /先跳过待答/);
    }
  } finally {
    setUiLanguage('zh');
  }
});
