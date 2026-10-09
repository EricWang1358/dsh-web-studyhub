import test from 'node:test';
import assert from 'node:assert/strict';
import { markRound, finishRound, owedKeys, roundKeys, nextPlannedKeys, resetRunning, roundsDue, stepOf, recordAttempts } from '../lib/coverage-run.js';
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

test('a section tried and failed is not asked again by its round: it is a fill round\'s; a pass that failed is failed, and what it never asked stays untried', () => {
  let spec = finishRound(markRound(two(), 1, 'running', { asked: ['c', 'd'] }), 1, { asked: ['c', 'd'], left: new Set(['c', 'd', 'e']) });
  assert.equal(spec.rounds[1].status, 'pending');
  assert.deepEqual(nextPlannedKeys(spec, new Set(['c', 'd', 'e'])).keys, ['e'], 'c and d were tried: the round asks for e only');
  const failed = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { status: 'failed', asked: ['c'], left: new Set(['c', 'd', 'e']) });
  assert.equal(failed.rounds[1].status, 'failed', 'a failure is said as one');
  assert.deepEqual(failed.rounds[1].triedKeys, ['c']);
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
  const failed = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { status: 'failed', asked: ['c'], left: new Set(['c', 'd', 'e']) });
  assert.deepEqual(annotateCoverage(coverage, failed).sections.slice(2).map(section => section.state), ['planned-failed', 'never-planned', 'never-planned'], 'a failed pass tried c only');
});

test('a row of the rounds list opens to the sections its pass asked for', async () => {
  const { sectionsOfRound } = await loadUi(`export { sectionsOfRound } from './ui/tasks/RunRounds.jsx';`);
  let spec = finishRound(markRound(two(), 1, 'running', { asked: ['c'] }), 1, { asked: ['c'], left: new Set(['d', 'e']) });
  spec = finishRound(markRound(spec, 1, 'running', { asked: ['d', 'e'] }), 1, { asked: ['d', 'e'], left: new Set() });
  const draft = { editorial: { coverageSpec: spec } };
  assert.deepEqual(sectionsOfRound(draft, { round: 2, index: 1, status: 'done' }, null).map(section => section.key), ['d', 'e']);
  assert.deepEqual(sectionsOfRound(draft, { round: 1, index: 0, status: 'done' }, null).map(section => section.key), ['a', 'b']);
});
