import test from 'node:test';
import assert from 'node:assert/strict';
import { shortfallOf, SHORTFALL_STATES } from '../lib/shortfall.js';

/* D-2: ONE shortfall object for the home banner, the 待发布 row, the console and the draft page. Pure: a draft, the coverage view of it, the round a top-up would run now, and the job (if any). */

const key = n => `s#${n}`;
const sections = (total, uncovered = 0, quota = 2, over = {}) => Array.from({ length: total }, (_, index) => ({ key: key(index), id: String(index), title: `Section ${index}`, cards: index < total - uncovered ? quota : 0,
  state: index < total - uncovered ? 'covered' : 'never-planned', weight: { quota }, ...(over[index] || {}) }));
const coverageOf = (total, uncovered, over = {}) => ({ leaves: total, covered: total - uncovered, plannedFailed: 0, neverPlanned: uncovered, percentLeaves: Math.round((total - uncovered) / total * 100), units: 'part', sections: sections(total, uncovered, 2, over) });
const spec = (over = {}, rounds = 9) => ({ version: 1, level: 'standard', goal: 251, leaves: 81, mustCover: 81, weightSource: 'model', weights: [], quotas: [],
  rounds: Array.from({ length: rounds }, (_, index) => ({ round: index + 1, questions: 30, sectionIds: [key(index)], status: 'done' })), ...over });
const draft = ({ cards = 174, marker, specOver, rounds = 9, requested = 28 } = {}) => ({ id: 'd1', title: 'Platform lectures', draftVersion: 4, cards: Array.from({ length: cards }, (_, index) => ({ id: `c${index}` })),
  editorial: { requested, generation: { sourceIds: ['s'] }, coverageSpec: spec(specOver, rounds), ...(marker ? { coverageRun: marker } : {}) } });
const stopped = (stop, extra = {}) => ({ jobId: 'j1', autoComplete: true, state: 'stopped', startedAt: '2026-10-06T00:00:00Z', tokensUsed: 2_800_000, stop: { reason: 'sections-left', round: 11, left: 2, ...stop }, ...extra });
const round = (sectionsN, questions, left, rounds = 1) => ({ sections: sectionsN, questions, left, rounds, limit: 30 });

test('a run that stopped with 2 sections left: 174 of 251 questions, 2 sections, the next round covers both, 77 questions are missing', () => {
  const s = shortfallOf({ draft: draft({ marker: stopped({}) }), coverage: coverageOf(81, 2), round: round(2, 3, 0) });
  assert.equal(s.state, 'stopped');
  assert.equal(s.reason, 'sections-left');
  assert.equal(s.questionsKept, 174);
  assert.equal(s.questionsGoal, 251, 'the goal is the plan\'s, not the first round\'s request (28)');
  assert.equal(s.questionsMissing, 77);
  assert.equal(s.sectionsUncovered, 2);
  assert.equal(s.nextRoundSections, 2);
  assert.equal(s.nextRoundQuestions, 3);
  assert.equal(s.sectionsAfterNextRound, 0);
  assert.equal(s.ready, false, 'a short draft is never ready');
  assert.equal(s.action, 'topup');
  assert.ok(s.percent < 100 && s.percent === 98, `a draft with a plan says its coverage (81 of 83 sections), the number the 任务 console says; the 174 of 251 questions are said as questions (${s.percent})`);
});

test('18 sections without a question and a round that covers 15: the sentence numbers are the same everywhere and 3 are left', () => {
  const s = shortfallOf({ draft: draft({ cards: 241, marker: stopped({ reason: 'no-progress', left: 18 }) }), coverage: coverageOf(81, 18), round: round(15, 30, 3, 2) });
  assert.equal(s.sectionsUncovered, 18);
  assert.equal(s.nextRoundSections, 15);
  assert.equal(s.sectionsAfterNextRound, 3);
  assert.equal(s.questionsMissing, 10);
  assert.equal(s.roundsLeft, 2);
  assert.equal(s.reason, 'no-progress');
});

test('sections that are covered by fewer questions than the plan gave them are counted apart', () => {
  const s = shortfallOf({ draft: draft({ cards: 100, marker: stopped({}) }), coverage: coverageOf(10, 0, { 0: { cards: 1 }, 1: { cards: 1 }, 2: { cards: 3 } }), round: round(0, 0, 0, 0) });
  assert.equal(s.sectionsUncovered, 0);
  assert.equal(s.sectionsUnderQuota, 2);
});

test('refused: the key was refused; the action is the model settings, the reason a code, and 接着做 is still there once it is fixed', () => {
  const s = shortfallOf({ draft: draft({ cards: 24, marker: stopped({ reason: 'refused', round: 2, code: 'credential', detail: 'Part 1: 401 Unauthorized: Invalid API key' }) }), coverage: coverageOf(81, 75), round: round(8, 30, 67, 8) });
  assert.equal(s.state, 'refused');
  assert.equal(s.reason, 'refused');
  assert.equal(s.failure, 'credential', 'the failure code, never the provider\'s English');
  assert.equal(s.action, 'model-settings');
  assert.equal(s.canContinue, true, 'what was kept stays and the run continues from its next round');
});

test('every state has one primary action: interrupted 接着做, paused 继续, stopped with sections left 补题, refused 去配置模型, done none, running none', () => {
  const live = (status, run = {}, extra = {}) => ({ id: 'j1', draftId: 'd1', status, coverageRun: { autoComplete: true, state: 'running', list: Array.from({ length: 9 }, (_, i) => ({ round: i + 1, questions: 30, status: i < 3 ? 'done' : 'pending', fill: false, sections: 5 })), ...run }, ...extra });
  const base = { draft: draft({ cards: 80, marker: { jobId: 'j1', autoComplete: true, state: 'running', startedAt: 'x', tokensUsed: 1 } }), coverage: coverageOf(81, 50), round: round(5, 30, 45, 9) };
  assert.deepEqual([shortfallOf({ ...base, job: live('running') }).state, shortfallOf({ ...base, job: live('running') }).action], ['running', null]);
  assert.deepEqual([shortfallOf({ ...base, job: live('running', { state: 'paused' }, { paused: true }) }).state, shortfallOf({ ...base, job: live('running', { state: 'paused' }, { paused: true }) }).action], ['paused', 'resume']);
  assert.deepEqual([shortfallOf({ ...base, job: live('interrupted') }).state, shortfallOf({ ...base, job: live('interrupted') }).action], ['interrupted', 'continue']);
  // The host stopped and nothing of this process works on it: the draft says running, the state is interrupted all the same.
  assert.equal(shortfallOf({ ...base }).state, 'interrupted');
  assert.equal(shortfallOf({ ...base }).action, 'continue');
  const learner = shortfallOf({ ...base, draft: draft({ cards: 80, marker: stopped({ reason: 'learner', round: 3 }) }) });
  assert.deepEqual([learner.state, learner.reason, learner.action], ['cancelled', 'learner', 'topup']);
  const done = shortfallOf({ draft: draft({ cards: 251, marker: { jobId: 'j1', autoComplete: true, state: 'complete', tokensUsed: 5, stop: { reason: 'complete', round: 9 } } }), coverage: coverageOf(81, 0), round: round(0, 0, 0, 0) });
  assert.deepEqual([done.state, done.action, done.ready, done.questionsMissing, done.percent], ['done', null, true, 0, 100]);
  for (const state of ['running', 'paused', 'interrupted', 'cancelled', 'refused', 'stopped', 'done']) assert.ok(SHORTFALL_STATES.includes(state));
});

test('a run that reached the target of its level is done and short of nothing (its goal is what it made)', () => {
  const s = shortfallOf({ draft: draft({ cards: 126, specOver: { goal: 126, level: 'lean' }, marker: { jobId: 'j1', autoComplete: true, state: 'complete', stop: { reason: 'target', round: 3 }, tokensUsed: 5 } }), coverage: coverageOf(81, 40), round: round(30, 30, 10, 2) });
  assert.equal(s.state, 'done');
  assert.equal(s.questionsMissing, 0);
});

test('a manual 精简 run waits for the learner: stopped, reason manual, automatic completion off, the level named', () => {
  const marker = { jobId: 'j1', autoComplete: false, state: 'waiting', startedAt: 'x', tokensUsed: 9 };
  const s = shortfallOf({ draft: draft({ cards: 25, specOver: { level: 'lean', goal: 126, rounds: [{ round: 1, questions: 28, sectionIds: [key(0)], status: 'done' }, { round: 2, questions: 30, sectionIds: [key(1)] }, { round: 3, questions: 30, sectionIds: [key(2)] }] }, marker }), coverage: coverageOf(81, 71), round: round(10, 30, 61, 3) });
  assert.deepEqual([s.state, s.reason, s.auto, s.level, s.action], ['stopped', 'manual', false, 'lean', 'topup']);
  assert.equal(s.percent, 12, 'the coverage (10 of 81 sections), not the questions kept over the plan goal (25 of 126 = 20): one fact, one number');
});

test('a draft with no plan and no run: its own request is the goal, and a covered material is done', () => {
  const plain = { id: 'd2', title: 'T', cards: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` })), editorial: { requested: 20, generation: { sourceIds: ['s'] } } };
  const s = shortfallOf({ draft: plain, coverage: coverageOf(4, 0), round: round(0, 0, 0, 0) });
  assert.equal(s.questionsGoal, 20);
  assert.equal(s.questionsMissing, 10);
  assert.equal(s.state, 'done');
  assert.equal(s.reason, 'questions-short');
  assert.equal(s.ready, false);
  const open = shortfallOf({ draft: plain, coverage: coverageOf(4, 2), round: round(2, 4, 0, 1) });
  assert.deepEqual([open.state, open.action, open.reason, open.secondary], ['stopped', 'continue', 'no-plan', 'topup'], 'a plain draft that is short of its count is continued (the 2 it owes); the sections are the top-up');
});

test('without the coverage view (it has not arrived) the questions are still said and nothing is invented', () => {
  const s = shortfallOf({ draft: draft({ marker: stopped({}) }) });
  assert.equal(s.questionsKept, 174);
  assert.equal(s.questionsGoal, 251);
  assert.equal(s.sectionsUncovered, null);
  assert.equal(s.nextRoundSections, null);
  assert.equal(s.state, 'stopped');
});

test('the sections that failed again and again are listed with their reason (D-16), and a run does not count them as a next round', () => {
  const attempts = { [key(79)]: { n: 3, reason: 'review-protocol' }, [key(80)]: { n: 1, reason: 'quote' } };
  const s = shortfallOf({ draft: draft({ marker: stopped({}), specOver: { attempts } }), coverage: coverageOf(81, 2, { 79: { state: 'planned-failed', reason: 'review-protocol' }, 80: { state: 'planned-failed', reason: 'quote' } }), round: round(2, 3, 0) });
  assert.deepEqual(s.repeating.map(item => [item.key, item.reason, item.attempts, item.title]), [[key(79), 'review-protocol', 3, 'Section 79']]);
});

/* The owner's draft: a plain run (a count, no plan) that kept 13 of the 15 questions it was asked for, on a material with 94 sections that have no question. */
const plainDraft = ({ cards = 13, requested = 15, extra = {} } = {}) => ({ id: 'p1', title: 'Recovered questions', draftVersion: 3, cards: Array.from({ length: cards }, (_, index) => ({ id: `c${index}` })),
  editorial: { requested, generation: { sourceIds: ['s'], kind: 'quiz' }, ...extra } });
const failedPlain = (stage = 'Generation reached its 20-minute total budget; approved questions were retained') => ({ id: 'j9', draftId: 'p1', status: 'failed', stage, retryable: true, savedCount: 13, requestedTotal: 15,
  contract: { actions: { retry: { available: true } } } });

test('a plain run that stopped short is NOT told about sections it never promised: 13 of 15 questions, and the one action continues the 2 it still owes', () => {
  const s = shortfallOf({ draft: plainDraft(), coverage: coverageOf(108, 94), round: round(27, 27, 67, 4), job: failedPlain() });
  assert.equal(s.planned, false, 'no plan: nothing but a number of questions was promised');
  assert.deepEqual([s.questionsKept, s.questionsGoal, s.questionsMissing], [13, 15, 2]);
  assert.equal(s.state, 'stopped');
  assert.equal(s.action, 'continue', 'one primary action, worded as continuing');
  assert.equal(s.continueKind, 'count', 'it continues the count that was asked for (2 more), not the uncovered sections');
  assert.equal(s.canContinue, true);
  assert.equal(s.secondary, 'topup', 'the top-up of the uncovered sections is still there, as the other, deliberate thing');
  assert.equal(s.sectionsUncovered, 94, 'the sections stay a fact of the material (the coverage line says them)');
});

test('the way a top-up goes from here to full coverage: coverage now, after the round, and what it takes (rounds and questions)', () => {
  const s = shortfallOf({ draft: plainDraft(), coverage: coverageOf(108, 94), round: { ...round(27, 27, 67, 4), allQuestions: 100 } });
  assert.equal(s.coveragePercent, 13);
  assert.equal(s.afterRoundPercent, Math.round((14 + 27) / 108 * 100));
  assert.equal(s.roundsToFull, 4);
  assert.equal(s.questionsToFull, 100);
});

test('a plain run whose key was refused says so (去配置模型 first) and can still be continued once the key works', () => {
  const s = shortfallOf({ draft: plainDraft(), coverage: coverageOf(108, 94), round: round(27, 27, 67, 4), job: failedPlain('401 Unauthorized: Invalid API key') });
  assert.deepEqual([s.state, s.action, s.failure, s.canContinue, s.continueKind], ['refused', 'model-settings', 'credential', true, 'count']);
});

test('a plain draft that is full, or whose request is unknown, has nothing to continue: its sections without a question are the top-up\'s business', () => {
  const full = shortfallOf({ draft: plainDraft({ cards: 15 }), coverage: coverageOf(108, 94), round: round(27, 27, 67, 4) });
  assert.deepEqual([full.questionsMissing, full.action, full.secondary], [0, 'topup', null]);
  const old = shortfallOf({ draft: { id: 'o', title: 'Old', cards: [{ id: 'c' }], editorial: {} }, coverage: coverageOf(10, 5), round: round(5, 5, 0, 1) });
  assert.equal(old.action, 'topup');
});

test('a draft with a plan promises sections as before (planned), and a top-up\'s plan counts as one', () => {
  const s = shortfallOf({ draft: draft({ marker: stopped({}) }), coverage: coverageOf(81, 2), round: round(2, 3, 0) });
  assert.equal(s.planned, true);
  assert.equal(shortfallOf({ draft: plainDraft({ extra: { coverageSpec: { version: 1, topup: true, goal: 113, leaves: 108, mustCover: 94, quotas: [], rounds: [{ round: 1, questions: 27, sectionIds: [] }] } } }), coverage: coverageOf(108, 94), round: round(27, 27, 67, 4) }).planned, true);
});

test('why a plain run stands still is said by a reason of its own: the time limit, a failure, or the learner stopping it; and what ended it is carried for the sentence', () => {
  const base = { draft: plainDraft(), coverage: coverageOf(108, 94), round: round(27, 27, 67, 4) };
  const limit = shortfallOf({ ...base, job: failedPlain() });
  assert.deepEqual([limit.state, limit.reason, limit.action], ['stopped', 'time-limit', 'continue']);
  assert.match(limit.ended.stage, /budget/);
  const other = shortfallOf({ ...base, job: failedPlain('Part 1: the model timed out') });
  assert.deepEqual([other.state, other.reason, other.action], ['stopped', 'run-failed', 'continue']);
  const learner = shortfallOf({ ...base, job: { ...failedPlain('Generation was cancelled'), status: 'cancelled' } });
  assert.deepEqual([learner.state, learner.reason, learner.action], ['cancelled', 'learner', 'continue']);
  assert.equal(shortfallOf(base).ended, null, 'a draft with no record of how it ended says nothing about it');
});

test('a coverage run that stopped because a round failed (the time limit of a round) is continued, not topped up', () => {
  const marker = stopped({ reason: 'round-failed', round: 3, detail: 'Generation reached its 20-minute budget for this round' });
  const failed = { id: 'j2', draftId: 'd1', status: 'failed', stage: 'Generation reached its 20-minute budget for this round', retryable: true, contract: { actions: { retry: { available: true } } } };
  const s = shortfallOf({ draft: draft({ cards: 80, marker }), coverage: coverageOf(81, 40), round: round(5, 10, 35, 8), job: failed });
  assert.deepEqual([s.state, s.reason, s.action, s.continueKind], ['stopped', 'round-failed', 'continue', 'rounds']);
  const gone = shortfallOf({ draft: draft({ cards: 80, marker }), coverage: coverageOf(81, 40), round: round(5, 10, 35, 8) });
  assert.equal(gone.action, 'topup', 'without a job to continue (the record is gone) the top-up is what is left');
});

test('the percent is the one the 任务 console says: the coverage of a draft with a plan, the questions over the request for a plain one, never 99 for "not done"', () => {
  const planned = shortfallOf({ draft: draft({ cards: 251, marker: stopped({}) }), coverage: coverageOf(81, 2), round: round(2, 3, 0) });
  assert.equal(planned.percent, 98, 'every question made, two sections without one: the coverage, not 100');
  const plain = shortfallOf({ draft: plainDraft({ cards: 10, requested: 20 }), coverage: coverageOf(4, 0), round: round(0, 0, 0, 0) });
  assert.equal(plain.percent, 50, 'no plan: the questions kept over what the draft was asked for');
  const done = shortfallOf({ draft: draft({ cards: 251, marker: { jobId: 'j1', autoComplete: true, state: 'complete', startedAt: 'x', tokensUsed: 1, stop: { reason: 'complete', round: 9 } } }), coverage: coverageOf(81, 0), round: round(0, 0, 0, 0) });
  assert.equal(done.percent, 100);
});
