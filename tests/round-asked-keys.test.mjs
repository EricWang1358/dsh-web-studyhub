import test from 'node:test';
import assert from 'node:assert/strict';
import { markRound, finishRound, owedKeys, roundKeys, nextPlannedKeys, resetRunning, roundsDue, stepOf, recordAttempts, endsWithoutProgress } from '../lib/coverage-run.js';
import { listOf } from '../lib/contexts/generation/coverage-runs.js';
import { annotateCoverage } from '../lib/coverage-state.js';
import { loadUi } from './helpers/ui-module.mjs';

/* The pure rules of a round that was ASKED for some of its sections only (lib/coverage-run.js askedKeys / triedKeys / owedKeys): what it tried, what it still owes, what its row counts.
   tests/round-asked-keys-exec.test.mjs runs the same story through the executor. */

const quotas = ['a', 'b', 'c', 'd', 'e'].map(key => ({ sectionId: key, quota: 2 }));
const plan = (rounds) => ({ quotas, weights: [], rounds });
const two = () => plan([{ round: 1, questions: 4, sectionIds: ['a', 'b'], status: 'done' }, { round: 2, questions: 6, sectionIds: ['c', 'd', 'e'], status: 'pending' }]);

test('a pass asked for some sections of a round leaves the round pending, owing the others; the next pass asks only those, and then it is done', () => {
  let spec = markRound(two(), 1, 'running', { questions: 2, asked: ['c'] });
  assert.deepEqual(spec.rounds[1].askedKeys, ['c']);
  spec = finishRound(spec, 1, { kept: 2, covered: 1, asked: ['c'], left: new Set(['d', 'e']) });
  assert.equal(spec.rounds[1].status, 'pending', 'd and e were never asked for: not done');
  assert.deepEqual(spec.rounds[1].triedKeys, ['c']);
  assert.equal(spec.rounds[1].questions, 4, 'what it asks next is the quotas of what it owes');
  assert.deepEqual(owedKeys(spec.rounds[1]), ['d', 'e']);
  assert.deepEqual(roundKeys(spec.rounds[1]), ['d', 'e'], 'the waiting row counts what it owes');
  assert.deepEqual(nextPlannedKeys(spec, new Set(['d', 'e'])), { index: 1, keys: ['d', 'e'] });
  assert.deepEqual(roundsDue(spec, { uncovered: new Set(['d', 'e']) }), [0, 4]);
  spec = markRound(spec, 1, 'running', { questions: 4, asked: ['d', 'e'] });
  assert.deepEqual(roundKeys(spec.rounds[1]), ['d', 'e']);
  spec = finishRound(spec, 1, { kept: 2, covered: 1, asked: ['d', 'e'], left: new Set(['e']) });
  assert.equal(spec.rounds[1].status, 'done', 'every section was covered or tried');
  assert.deepEqual(roundKeys(spec.rounds[1]), ['d', 'e'], 'the done row counts its last pass: 新覆盖 1/2');
  assert.deepEqual(listOf(spec).map(row => row.sections), [2, 2]);
  // e failed in the round that asked for it: a fill round retries it, as before.
  assert.deepEqual(stepOf({ spec, uncovered: new Set(['e']), run: { autoComplete: true, fillUsed: 0 } }), { type: 'fill', keys: ['e'], skipped: [] });
});

test('a section tried and failed is not asked again by its round: it is a fill round\'s; a failed pass owes what it never asked, and a whole round that failed is failed', () => {
  let spec = finishRound(markRound(two(), 1, 'running', { asked: ['c', 'd'] }), 1, { asked: ['c', 'd'], left: new Set(['c', 'd', 'e']) });
  assert.equal(spec.rounds[1].status, 'pending');
  assert.deepEqual(nextPlannedKeys(spec, new Set(['c', 'd', 'e'])).keys, ['e'], 'c and d were tried: the round asks for e only');
  const failed = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { status: 'failed', code: 'review-protocol', asked: ['c'], left: new Set(['c', 'd', 'e']) });
  assert.equal(failed.rounds[1].status, 'pending', 'd and e were never asked for: the round owes them, a failure of c is not theirs');
  assert.deepEqual([failed.rounds[1].triedKeys, failed.rounds[1].code, failed.rounds[1].questions], [['c'], 'review-protocol', 4]);
  assert.deepEqual(nextPlannedKeys(failed, new Set(['c', 'd', 'e'])).keys, ['d', 'e']);
  const whole = finishRound(markRound(two(), 1, 'running', { asked: ['c', 'd', 'e'] }), 1, { status: 'failed', asked: ['c', 'd', 'e'], left: new Set(['c', 'd', 'e']) });
  assert.equal(whole.rounds[1].status, 'failed', 'a round that failed every section it owed is failed');
  // The executor records attempts for the keys it asked for only: d and e keep no counter.
  assert.deepEqual(Object.keys(recordAttempts(failed, ['c'], () => 'plan-short', 2).attempts), ['c']);
});

test('a pass stopped before it settled tries nothing; a round a stopped host left running owes what that pass was asked for again', () => {
  const stopped = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { status: 'failed', reason: 'cancelled' });
  assert.equal(stopped.rounds[1].triedKeys, undefined);
  let spec = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { asked: ['c'], left: new Set(['c', 'd', 'e']) });
  spec = markRound(spec, 1, 'running', { asked: ['c'] });
  assert.deepEqual(resetRunning(spec).rounds[1].triedKeys, [], 'the in-flight pass is run again from its start');
  assert.equal(resetRunning(spec).rounds[1].status, 'pending');
});

test('a plan from before askedKeys / triedKeys reads as it did: every round was asked for all its sections', () => {
  const old = two();
  assert.deepEqual(owedKeys(old.rounds[1]), ['c', 'd', 'e']);
  assert.deepEqual(roundKeys(old.rounds[0]), ['a', 'b']);
  assert.deepEqual(nextPlannedKeys(old, new Set(['b', 'd'])), { index: 1, keys: ['d'] });
  assert.deepEqual(listOf(old).map(row => row.sections), [2, 3]);
  const done = finishRound(old, 1, { kept: 6, covered: 3 });
  assert.equal(done.rounds[1].status, 'done', 'without asked, finishRound does what it always did');
  assert.equal(done.rounds[1].triedKeys, undefined);
});

test('the coverage view: a section of a round that was never asked for is waiting, not planned-and-failed', () => {
  const base = (key, state) => ({ key, state });
  const coverage = { covered: 1, plannedFailed: 0, neverPlanned: 3, leaves: 5, sections: [base('a', 'covered'), base('b', 'covered'), base('c', 'never-planned'), base('d', 'never-planned'), base('e', 'never-planned')] };
  const partly = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { asked: ['c'], left: new Set(['c', 'd', 'e']) });
  const view = annotateCoverage(coverage, partly);
  assert.deepEqual(view.sections.slice(2).map(section => [section.key, section.state, section.scheduled === true]), [['c', 'planned-failed', false], ['d', 'never-planned', true], ['e', 'never-planned', true]]);
  // A later pass stopped (cancelled) leaves the round failed while it still owes d and e: they wait for a retry, never 「没有计划」.
  const stopped = finishRound(markRound(partly, 1, 'running', { asked: ['d'] }), 1, { status: 'failed', reason: 'cancelled' });
  assert.equal(stopped.rounds[1].status, 'failed');
  assert.deepEqual(annotateCoverage(coverage, stopped).sections.slice(2).map(section => [section.key, section.state, section.scheduled === true]), [['c', 'planned-failed', false], ['d', 'never-planned', true], ['e', 'never-planned', true]]);
});

test('a row of the rounds list opens to the sections its pass asked for', async () => {
  const { sectionsOfRound } = await loadUi(`export { sectionsOfRound } from './ui/tasks/RunRounds.jsx';`);
  let spec = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { asked: ['c'], left: new Set(['d', 'e']) });
  spec = finishRound(markRound(spec, 1, 'running', { asked: ['d', 'e'] }), 1, { asked: ['d', 'e'], left: new Set() });
  const draft = { editorial: { coverageSpec: spec } };
  assert.deepEqual(sectionsOfRound(draft, { round: 2, index: 1, status: 'done' }, null).map(section => section.key), ['d', 'e']);
  assert.deepEqual(sectionsOfRound(draft, { round: 1, index: 0, status: 'done' }, null).map(section => section.key), ['a', 'b']);
});

test('while a pass runs, its round counts what it owes besides the pass; the draft page says done where the executor does; a document top-up does not count a section a round already tried as in flight', async () => {
  const { owedDue, draftRunFacts } = await import('../lib/coverage-run.js');
  const running = markRound(two(), 1, 'running', { questions: 2, asked: ['c'] });
  assert.equal(owedDue(running, 1, new Set(['c', 'd', 'e'])), 4, 'd and e: 2 + 2');
  assert.deepEqual(roundsDue(running, { uncovered: new Set(['c', 'd', 'e']), running: { left: 2 } }), [0, 6], 'the pass makes 2, the round owes 4 more');
  assert.equal(owedDue(two(), 1, new Set(['c', 'd', 'e']), ['c']), 4, 'at the start of a job: what the round owes besides what the job asks');
  assert.equal(owedDue({ ...two(), rounds: [two().rounds[0], { ...two().rounds[1], status: 'running' }] }, 1, new Set(['c'])), 0, 'a pass from before askedKeys was the whole round');
  // A round that ran a pass and owes nothing any more (d, e covered by another round): done, as the executor marks it, not 「这一轮的小节都已经有题了」.
  const partly = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { asked: ['c'], left: new Set(['c', 'd', 'e']) });
  const sections = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key, state: 'covered' }));
  const facts = draftRunFacts({ cards: [{}], editorial: { coverageSpec: partly, coverageRun: { state: 'waiting' } } }, { coverage: { sections } });
  assert.equal(facts.done, 2);
});

test('a document top-up: the sections a pending round already tried (and that did not come out) are not in flight, what it owes is', async () => {
  const { documentTopUp } = await import('../lib/coverage-state.js');
  const { sectionKey } = await import('../lib/coverage.js');
  const { transcriptFixture } = await import('./helpers/coverage-fixture.mjs');
  const fx = transcriptFixture({ recordings: 2, parts: 6, paragraphs: 4 }), keyOf = section => sectionKey(section.sourceId, section.id);
  const first = fx.leaves.slice(0, 2).map(section => fx.card(section)), waiting = fx.leaves.slice(2, 6).map(keyOf);
  const spec = { topup: true, goal: 4, quotas: waiting.map(sectionId => ({ sectionId, quota: 1 })), rounds: [{ round: 1, questions: 3, sectionIds: waiting, status: 'pending', askedKeys: [waiting[0]], triedKeys: [waiting[0]] }] };
  const draft = { id: 'p', title: 'part', cards: [], editorial: { requested: 4, generation: { sourceIds: fx.sources.map(source => source.id) }, part: { deckId: 'D', n: 2 }, coverageSpec: spec, coverageRun: { state: 'waiting' } } };
  const found = documentTopUp({ sources: fx.sources, decks: [{ id: 'D', title: 'Deck D', cards: first }], drafts: [draft] }, { sourceId: fx.sources[0].id });
  assert.equal(found.inFlight, waiting.length - 1, 'the tried section is a retry anyone may take; the three the round owes are in flight');
});

test('when a pass that gained nothing ends a run that goes on by itself (no-progress)', () => {
  const round = (index) => ({ type: 'round', index, keys: ['d'], skipped: [] });
  assert.equal(endsWithoutProgress({ progress: true, step: round(2), index: 1 }), false, 'a pass that gained a section never does');
  assert.equal(endsWithoutProgress({ progress: false, step: round(2), index: 1 }), true, 'another planned round behind it: it stops (D-15)');
  assert.equal(endsWithoutProgress({ progress: false, step: round(1), index: 1 }), false, 'a pass that ended done: the same round asks what nobody tried yet');
  assert.equal(endsWithoutProgress({ progress: false, step: round(1), index: 1, failed: true, code: 'review-protocol' }), false, 'the first failed pass of the round may go on once');
  assert.equal(endsWithoutProgress({ progress: false, step: round(1), index: 1, failed: true, code: 'review-protocol', previous: { failed: true, code: 'review-protocol' } }), true, 'the same failure twice: stop, the round still owes the rest');
  assert.equal(endsWithoutProgress({ progress: false, step: round(1), index: 1, failed: true, code: 'timeout', previous: { failed: true, code: 'review-protocol' } }), false, 'another cause may go on once more');
  assert.equal(endsWithoutProgress({ progress: false, step: round(1), index: 1, failed: true, previous: { failed: true } }), true, 'an unknown cause twice is the same cause');
  assert.equal(endsWithoutProgress({ progress: false, step: round(1), index: 1, failed: true, code: 'quality', previous: { failed: false } }), false, 'after a pass that ended done');
  assert.equal(endsWithoutProgress({ progress: false, step: { type: 'fill', keys: ['c'], skipped: [] }, index: 3, fill: true }), true, 'a fill round that gained nothing');
  assert.equal(endsWithoutProgress({ progress: false, step: { type: 'fill', keys: ['c'], skipped: [] }, index: 1 }), false, 'a planned round before the first fill round');
  assert.equal(endsWithoutProgress({ progress: false, step: { type: 'wait', next: 1 }, index: 1 }), false);
});

test('a pass that ends done clears the failure an earlier pass of the round left', () => {
  let spec = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { status: 'failed', code: 'review-protocol', reason: 'Review JSON protocol failed', asked: ['c'], left: new Set(['c', 'd', 'e']) });
  assert.deepEqual([spec.rounds[1].status, spec.rounds[1].code], ['pending', 'review-protocol']);
  spec = finishRound(markRound(spec, 1, 'running', { asked: ['d', 'e'] }), 1, { kept: 4, covered: 2, asked: ['d', 'e'], left: new Set(['c']) });
  assert.equal(spec.rounds[1].status, 'done');
  assert.deepEqual([spec.rounds[1].code, spec.rounds[1].reason], [undefined, undefined], 'its row does not say the old failure');
  assert.ok(!('code' in spec.rounds[1]) && !('reason' in spec.rounds[1]));
});
