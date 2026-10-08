import test from 'node:test';
import assert from 'node:assert/strict';
import { roundList, markRound, finishRound, appendFillRound, interruptedRounds, nextPlannedKeys, stepOf, progressOf, recordAttempts, runFacts, draftRunFacts, parseTokenBudget, STOP_REASONS, FILL_ROUNDS, REPEAT_LIMIT, RUN_STATES } from '../lib/coverage-run.js';
import { STRENGTH, autoCompleteOf } from '../lib/coverage-strength.js';

/* The pure core of a coverage run (lib/coverage-run.js): the state of the rounds a draft keeps, what to do after each round, why a run stops, and the numbers every screen shows. */

const spec = (statuses = [], extra = {}) => ({ version: 1, level: 'standard', goal: 12, quotas: ['a', 'b', 'c', 'd', 'e', 'f'].map(sectionId => ({ sectionId, quota: 2 })),
  rounds: [['a', 'b'], ['c', 'd'], ['e', 'f']].map((sectionIds, at) => ({ round: at + 1, questions: 4, sectionIds, ...(statuses[at] ? { status: statuses[at] } : {}) })), ...extra });
const run = (over = {}) => ({ autoComplete: true, fillUsed: 0, tokensUsed: 0, ...over });

test('the one table says when a run goes on by itself: 精简 waits for the learner, 标准 and 完整 go on to the end', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STRENGTH).map(([level, row]) => [level, row.auto])), { lean: false, standard: true, full: true });
  assert.equal(autoCompleteOf('lean'), false);
  assert.equal(autoCompleteOf('standard'), true);
  assert.equal(autoCompleteOf('full'), true);
  assert.equal(autoCompleteOf('nonsense'), true, 'the default level is 标准');
});

test('rounds of a spec from before round states were kept are pending; every status is one of the five', () => {
  const list = roundList(spec());
  assert.deepEqual(list.map(item => [item.index, item.round, item.status, item.fill]), [[0, 1, 'pending', false], [1, 2, 'pending', false], [2, 3, 'pending', false]]);
  assert.deepEqual(roundList(spec(['done', 'weird', 'running'])).map(item => item.status), ['done', 'pending', 'running']);
  assert.deepEqual(roundList(null), []);
  assert.deepEqual(RUN_STATES, ['running', 'paused', 'waiting', 'stopped', 'complete']);
});

test('marking a round never changes the spec it was given; a finished round keeps its counts', () => {
  const before = spec(), running = markRound(before, 0, 'running', { at: '2026-10-06T00:00:00.000Z' });
  assert.equal(before.rounds[0].status, undefined);
  assert.equal(running.rounds[0].status, 'running');
  assert.equal(running.rounds[0].startedAt, '2026-10-06T00:00:00.000Z');
  const done = finishRound(running, 0, { status: 'done', kept: 3, covered: 2, tokens: 1200, ms: 5000, at: '2026-10-06T00:01:00.000Z' });
  assert.deepEqual({ ...done.rounds[0] }, { round: 1, questions: 4, sectionIds: ['a', 'b'], status: 'done', startedAt: '2026-10-06T00:00:00.000Z', planned: 4, kept: 3, covered: 2, tokens: 1200, ms: 5000, finishedAt: '2026-10-06T00:01:00.000Z' });
  const failed = finishRound(done, 1, { status: 'failed', reason: 'timeout' });
  assert.equal(failed.rounds[1].reason, 'timeout');
  assert.throws(() => markRound(before, 9, 'running'), /round/);
  assert.throws(() => markRound(before, 0, 'weird'), /status/);
});

test('a fill round is appended to the list, once per call, and is a round like the others', () => {
  const next = appendFillRound(spec(['done', 'done', 'done']), { keys: ['b', 'd'], questions: 4 });
  assert.equal(next.rounds.length, 4);
  assert.deepEqual({ ...next.rounds[3] }, { round: 4, questions: 4, sectionIds: ['b', 'd'], fill: true, status: 'pending' });
  assert.deepEqual(roundList(next).map(item => item.fill), [false, false, false, true]);
});

test('a round that was running when the host stopped is run again: it is pending, and the list says which were in flight', () => {
  const crashed = spec(['done', 'running', 'pending']);
  assert.deepEqual(interruptedRounds(crashed), [1]);
  assert.deepEqual(roundList(crashed, { interrupted: true }).map(item => item.status), ['done', 'pending', 'pending']);
  assert.deepEqual(interruptedRounds(spec(['done', 'done'])), []);
});

test('the next round of the plan: its sections that still have no question; a round that is covered already is skipped', () => {
  assert.deepEqual(nextPlannedKeys(spec(), new Set(['a', 'b', 'c', 'd', 'e', 'f'])), { index: 0, keys: ['a', 'b'] });
  assert.deepEqual(nextPlannedKeys(spec(['done']), new Set(['b', 'c', 'd', 'e', 'f'])), { index: 1, keys: ['c', 'd'] }, 'a failed section of a finished round waits for the fill rounds');
  assert.deepEqual(nextPlannedKeys(spec(['done']), new Set(['e', 'f'])), { index: 2, keys: ['e', 'f'], skipped: [1] }, 'round 2 is covered already');
  assert.equal(nextPlannedKeys(spec(['done', 'done', 'done']), new Set(['a'])), null, 'nothing left in the plan');
  assert.equal(nextPlannedKeys({ rounds: [] }, new Set(['a'])), null);
});

test('after a round: all done and covered; the target reached early; manual waits; the budget; the next round; fill rounds; and why it stops', () => {
  const all = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(stepOf({ spec: spec(['done', 'done', 'done']), uncovered: new Set(), run: run() }), { type: 'stop', reason: 'complete' });
  assert.deepEqual(stepOf({ spec: spec(['done']), uncovered: new Set(), run: run() }), { type: 'stop', reason: 'target', skipped: [1, 2] }, 'every section has a question before every round ran');
  assert.deepEqual(stepOf({ spec: spec(['done']), uncovered: new Set(['c', 'd', 'e', 'f']), run: run({ autoComplete: false }) }), { type: 'wait', next: 1 });
  assert.deepEqual(stepOf({ spec: spec(['done']), uncovered: new Set(['c', 'd', 'e', 'f']), run: run({ tokenBudget: 1000, tokensUsed: 1000 }) }), { type: 'stop', reason: 'budget' });
  assert.deepEqual(stepOf({ spec: spec(['done']), uncovered: new Set(['c', 'd', 'e', 'f']), run: run({ tokenBudget: 1000, tokensUsed: 999 }) }), { type: 'round', index: 1, keys: ['c', 'd'], skipped: [] });
  assert.deepEqual(stepOf({ spec: spec(['done', 'done', 'done']), uncovered: new Set(['b', 'e']), run: run() }), { type: 'fill', keys: ['b', 'e'], skipped: [] });
  assert.deepEqual(stepOf({ spec: spec(['done', 'done', 'done']), uncovered: new Set(['b']), run: run({ fillUsed: FILL_ROUNDS }) }), { type: 'stop', reason: 'sections-left', left: 1 });
  assert.deepEqual(stepOf({ spec: spec(['done', 'done', 'done']), uncovered: new Set(['b']), run: run({ fillUsed: 1 }), fillRounds: 1 }), { type: 'stop', reason: 'sections-left', left: 1 }, 'the bound is injectable');
  assert.equal(stepOf({ spec: spec(), uncovered: all, run: run() }).index, 0);
  assert.deepEqual(Object.keys(STOP_REASONS).sort(), ['budget', 'complete', 'learner', 'no-progress', 'refused', 'round-failed', 'sections-left', 'target']);
  for (const reason of Object.values(STOP_REASONS)) assert.ok(typeof reason.level === 'string');
});

test('自动补到完整 keeps filling a section until it has failed REPEAT_LIMIT times: sections-left only when every section left has, or the fill rounds are used up; with it off the run waits', () => {
  const done = spec(['done', 'done', 'done']), left = new Set(['b']);
  const failed = n => ({ ...done, attempts: { b: { n, reason: 'review-protocol', round: n } } });
  // The owner's report: a run with the checkbox ticked stopped at 92% because a section whose question failed review had already failed once or twice. Fewer than REPEAT_LIMIT failed attempts: it is written again.
  for (const n of [1, 2, REPEAT_LIMIT - 1]) {
    assert.deepEqual(stepOf({ spec: failed(n), uncovered: left, run: run({ fillUsed: Math.min(n - 1, FILL_ROUNDS - 1) }) }), { type: 'fill', keys: ['b'], skipped: [] }, `${n} failed attempt(s): the run writes the section again`);
  }
  assert.deepEqual(stepOf({ spec: done, uncovered: left, run: run() }), { type: 'fill', keys: ['b'], skipped: [] }, 'a section with no recorded attempt is written too');
  // REPEAT_LIMIT failed attempts: the run stops trying it by itself.
  assert.deepEqual(stepOf({ spec: failed(REPEAT_LIMIT), uncovered: left, run: run({ fillUsed: REPEAT_LIMIT - 1 }) }), { type: 'stop', reason: 'sections-left', left: 1, skipped: [] });
  // One section with attempts to spare keeps the run going, and only that one is written.
  const mixed = { ...done, attempts: { b: { n: REPEAT_LIMIT, reason: 'review-protocol', round: 4 }, c: { n: 1, reason: 'quote', round: 3 } } };
  assert.deepEqual(stepOf({ spec: mixed, uncovered: new Set(['b', 'c']), run: run({ fillUsed: 1 }) }), { type: 'fill', keys: ['c'], skipped: [] });
  // The bound on the fill rounds stays, whatever the attempts say.
  assert.deepEqual(stepOf({ spec: failed(1), uncovered: left, run: run({ fillUsed: FILL_ROUNDS }) }), { type: 'stop', reason: 'sections-left', left: 1 });
  // Without 自动补到完整 the run waits for the learner, with attempts to spare or not.
  for (const n of [1, REPEAT_LIMIT]) assert.deepEqual(stepOf({ spec: failed(n), uncovered: left, run: run({ autoComplete: false }) }), { type: 'wait', next: -1 }, `${n} failed attempt(s), 自动补到完整 off`);
});

test('a run whose every fill round gains a section goes on to the last one, which is written REPEAT_LIMIT times (its planned round and REPEAT_LIMIT - 1 fill rounds) and no more', () => {
  assert.ok(FILL_ROUNDS >= REPEAT_LIMIT - 1, 'the attempts of a section run out before the fill rounds do: a section that fails every time is not what uses up the fill rounds');
  // The bookkeeping of the executor (lib/contexts/generation/operations.js), round by round: the sections a round was asked for that still have no question get one more failed attempt; a fill round that
  // gains no section ends the run (no-progress), so here every fill round gains one: helper k comes out in fill round k, the stuck section never.
  const helpers = Array.from({ length: REPEAT_LIMIT - 1 }, (_, at) => `h${at + 1}`);
  let uncovered = new Set([...helpers, 'stuck']), current = recordAttempts(spec(['done', 'done', 'done']), [...uncovered], () => 'review-protocol', 3);
  let fills = 0, step = stepOf({ spec: current, uncovered, run: run({ fillUsed: fills }) });
  while (step.type === 'fill' && fills < 20) {
    fills += 1;
    assert.ok(step.keys.includes('stuck') && fills <= FILL_ROUNDS, `fill round ${fills} writes the stuck section again`);
    const before = uncovered;
    uncovered = new Set([...before].filter(key => key !== `h${fills}`));
    assert.equal(progressOf(before, uncovered).progress, true, `fill round ${fills} gains a section`);
    current = recordAttempts(current, step.keys.filter(key => uncovered.has(key)), () => 'review-protocol', 3 + fills, undefined, true);
    step = stepOf({ spec: current, uncovered, run: run({ fillUsed: fills }) });
  }
  assert.equal(fills, REPEAT_LIMIT - 1);
  assert.deepEqual([step.type, step.reason, step.left], ['stop', 'sections-left', 1]);
  assert.equal(current.attempts.stuck.n, REPEAT_LIMIT, 'the stuck section was asked for exactly REPEAT_LIMIT times');
  assert.deepEqual(current.attempts.stuck.rounds.map(item => !!item.fill), Array.from({ length: REPEAT_LIMIT }, (_, at) => at > 0), 'its planned round, then fill rounds');
  assert.deepEqual(helpers.map(key => current.attempts[key].n), helpers.map((_, at) => at + 1), 'a helper failed in every round before the one it came out in');
});

test('progress of a round: the sections it covered that had none; a round that covered none made no progress', () => {
  assert.deepEqual(progressOf(new Set(['a', 'b', 'c']), new Set(['c'])), { gained: 2, progress: true });
  assert.deepEqual(progressOf(new Set(['a', 'b']), new Set(['a', 'b'])), { gained: 0, progress: false });
  assert.deepEqual(progressOf(new Set(), new Set()), { gained: 0, progress: false });
});

test('the numbers every screen shows are one function: round i of n, coverage, tokens used, and a projection from the rounds done', () => {
  let marked = spec();
  marked = finishRound(marked, 0, { status: 'done', kept: 4, covered: 2, tokens: 400_000, ms: 600_000 });
  marked = finishRound(marked, 1, { status: 'done', kept: 4, covered: 2, tokens: 600_000, ms: 600_000 });
  const rounds = roundList(marked);
  const facts = runFacts({ rounds, run: run({ tokensUsed: 1_000_000 }), percent: 67 });
  assert.deepEqual({ round: facts.round, rounds: facts.rounds, done: facts.done, left: facts.left, percent: facts.percent, tokensUsed: facts.tokensUsed }, { round: 3, rounds: 3, done: 2, left: 1, percent: 67, tokensUsed: 1_000_000 });
  assert.deepEqual(facts.projection, { tokens: 500_000, minutes: 10, basis: 'history' }, '125 000 tokens and 150 seconds per planned question, 4 questions left');
  const none = runFacts({ rounds: roundList(spec()), run: run({ estimate: { tokens: { low: 100_000, high: 300_000 } } }), percent: 0 });
  assert.deepEqual({ round: none.round, done: none.done }, { round: 1, done: 0 });
  assert.deepEqual(none.projection, { tokens: 200_000, minutes: null, basis: 'estimate' }, 'no history: the estimator, labelled as such, no minutes');
  assert.equal(runFacts({ rounds: roundList(spec()), run: run(), percent: 0 }).projection, null, 'nothing known: nothing is made up');
  const finished = runFacts({ rounds: roundList(spec(['done', 'done', 'done'])), run: run({ state: 'complete' }), percent: 100 });
  assert.equal(finished.projection, null);
  assert.equal(finished.left, 0);
  assert.equal(runFacts({ rounds: roundList(spec(['done'])), run: run({ state: 'paused' }), percent: 10 }).pausedAfter, 1, 'paused after round 1');
  assert.equal(runFacts({ rounds: roundList(spec(['done'])), run: run({ state: 'waiting', autoComplete: false }), percent: 10 }).waiting, true);
});

test('a token budget is typed as people type it: 800K, 2.5M, 1,200,000; nothing or nonsense is no budget', () => {
  assert.equal(parseTokenBudget('800K'), 800_000);
  assert.equal(parseTokenBudget('2.5m'), 2_500_000);
  assert.equal(parseTokenBudget('1,200,000'), 1_200_000);
  assert.equal(parseTokenBudget(' 3000000 '), 3_000_000);
  for (const bad of ['', '  ', 'abc', '-5', '0', '12 apples', null, undefined]) assert.equal(parseTokenBudget(bad), null, String(bad));
  assert.equal(parseTokenBudget('50'), null, 'below a thousand tokens is not a budget');
});

test('a draft whose plan is fully covered owes no round: the rounds that never ran are skipped, the plan is complete', () => {
  const draft = { cards: [{ id: 'c' }], editorial: { coverageSpec: spec(['done']), coverageRun: { state: 'waiting', autoComplete: false, tokensUsed: 5 } } };
  const sections = keys => ({ sections: ['a', 'b', 'c', 'd', 'e', 'f'].map(key => ({ key, state: keys.includes(key) ? 'covered' : 'never-planned' })) });
  const open = draftRunFacts(draft, { coverage: sections(['a', 'b']), percent: 33 });
  assert.deepEqual([open.left, open.state, open.waiting, open.ended], [2, 'waiting', true, false]);
  const covered = draftRunFacts(draft, { coverage: sections(['a', 'b', 'c', 'd', 'e', 'f']), percent: 100 });
  assert.deepEqual([covered.left, covered.state, covered.ended, covered.waiting], [0, 'complete', true, false]);
  assert.equal(draftRunFacts(draft, { percent: 33 }).left, 2, 'without a coverage nothing is assumed');
  const interrupted = draftRunFacts({ ...draft, editorial: { ...draft.editorial, coverageRun: { state: 'running' } } }, { coverage: sections(['a', 'b', 'c', 'd', 'e', 'f']) });
  assert.equal(interrupted.interrupted, true, 'an interrupted run is shown as such, never as complete');
});

test('the coverage view of a draft that ran rounds: sections of rounds not run are waiting, sections of rounds that ran and have no question are planned-and-failed, fill rounds are counted apart', async () => {
  const { annotateCoverage } = await import('../lib/coverage-state.js');
  const base = (key, state) => ({ key, state });
  const coverage = { covered: 1, plannedFailed: 0, neverPlanned: 5, leaves: 6, sections: [base('a', 'covered'), base('b', 'never-planned'), base('c', 'never-planned'), base('d', 'never-planned'), base('e', 'never-planned'), base('f', 'never-planned')] };
  const ran = { ...spec(['done', 'failed', 'pending']), weights: [], fills: undefined };
  ran.rounds.push({ round: 4, questions: 2, sectionIds: ['b'], fill: true, status: 'done' });
  const view = annotateCoverage(coverage, ran);
  assert.deepEqual(view.sections.map(section => [section.key, section.state, section.scheduled === true, section.attempted === true]),
    [['a', 'covered', false, false], ['b', 'planned-failed', false, true], ['c', 'planned-failed', false, true], ['d', 'planned-failed', false, true], ['e', 'never-planned', true, false], ['f', 'never-planned', true, false]]);
  assert.equal(view.sections[1].reason, 'plan-short');
  assert.deepEqual([view.plannedFailed, view.neverPlanned, view.scheduled], [3, 2, 2]);
  assert.deepEqual({ ...view.spec }, { level: 'standard', goal: 12, rounds: 3, fills: 1, weightSource: undefined });
  const legacy = annotateCoverage(coverage, { ...spec([undefined, undefined, undefined]), weights: [] });
  assert.deepEqual([legacy.plannedFailed, legacy.scheduled], [1, 4], 'a plan from before round states: its first round (a, b) ran, the others wait');
});
