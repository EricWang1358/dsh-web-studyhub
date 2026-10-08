import test from 'node:test';
import assert from 'node:assert/strict';
import { stepOf, recordAttempts, isRepeating, finishRound, REPEAT_LIMIT, FILL_ROUNDS } from '../lib/coverage-run.js';
import { planRound } from '../lib/coverage-round.js';
import { jobContract } from '../lib/job-contract.js';

/* The pure rules behind the honest states: failed attempts per section (D-16), the bounded fill rounds (D-15), the round that carries a typed cause (D-5) and a progress that is never 100 while something is missing (D-1). */

const spec = (over = {}) => ({ version: 1, level: 'standard', goal: 100, quotas: [], rounds: [{ round: 1, questions: 10, sectionIds: ['s#1', 's#2'], status: 'done' }], ...over });

test('recordAttempts counts one more failed attempt per section, with the reason and the round; a section is repeating from REPEAT_LIMIT', () => {
  assert.ok(Number.isInteger(REPEAT_LIMIT) && REPEAT_LIMIT >= 2, 'a section is asked for more than once before a run gives up on it');
  let next = recordAttempts(spec(), ['s#1', 's#2'], key => (key === 's#1' ? 'review-protocol' : 'quote'), 1);
  assert.deepEqual(next.attempts, { 's#1': { n: 1, reason: 'review-protocol', round: 1, rounds: [{ round: 1 }] }, 's#2': { n: 1, reason: 'quote', round: 1, rounds: [{ round: 1 }] } });
  // s#1 fails once more in each later round: it is repeating exactly when its attempts reach REPEAT_LIMIT, not one attempt before.
  const tried = [{ round: 1 }];
  for (let n = 2; n <= REPEAT_LIMIT; n += 1) {
    assert.equal(isRepeating(next, 's#1'), false, `${n - 1} failed attempt(s) are fewer than REPEAT_LIMIT: the run still writes it`);
    next = recordAttempts(next, ['s#1'], () => 'review-protocol', n + 2);
    tried.push({ round: n + 2 });
    assert.deepEqual(next.attempts['s#1'], { n, reason: 'review-protocol', round: n + 2, rounds: tried });
  }
  assert.equal(isRepeating(next, 's#1'), true, 'REPEAT_LIMIT failed attempts: the run stops trying it by itself');
  assert.equal(isRepeating(next, 's#2'), false, 'a section with one failed attempt is not');
  assert.equal(isRepeating(spec(), 's#1'), false, 'a plan from before attempts were kept has none');
  assert.deepEqual(spec().attempts, undefined, 'recording never mutates the plan it was given');
});

test('a fill round writes again only the sections that have not failed again and again; when only those are left the run stops with sections-left and says how many', () => {
  const rounds = [{ round: 1, questions: 10, sectionIds: ['s#1', 's#2', 's#3'], status: 'done' }];
  const planned = spec({ rounds, attempts: { 's#2': { n: REPEAT_LIMIT, reason: 'review-protocol', round: REPEAT_LIMIT } } });
  const uncovered = new Set(['s#2', 's#3']);
  const step = stepOf({ spec: planned, uncovered, run: { autoComplete: true, fillUsed: 0, tokensUsed: 0 } });
  assert.deepEqual([step.type, step.keys], ['fill', ['s#3']]);
  const only = stepOf({ spec: planned, uncovered: new Set(['s#2']), run: { autoComplete: true, fillUsed: 1, tokensUsed: 0 } });
  assert.deepEqual([only.type, only.reason, only.left], ['stop', 'sections-left', 1]);
  assert.equal(stepOf({ spec: planned, uncovered, run: { autoComplete: true, fillUsed: FILL_ROUNDS } }).reason, 'sections-left', 'the bound on fill rounds stays');
  // One failed attempt fewer than the limit: the section is still written again (this is what 「自动补到完整」 asks for).
  const almost = spec({ rounds, attempts: { 's#2': { n: REPEAT_LIMIT - 1, reason: 'review-protocol', round: REPEAT_LIMIT - 1 } } });
  const again = stepOf({ spec: almost, uncovered, run: { autoComplete: true, fillUsed: 1, tokensUsed: 0 } });
  assert.deepEqual([again.type, again.keys], ['fill', ['s#2', 's#3']]);
});

test('a round that failed keeps its cause as a code', () => {
  const done = finishRound(spec({ rounds: [{ round: 1, questions: 10, sectionIds: ['s#1'], status: 'running' }] }), 0, { status: 'failed', reason: 'Part 1: 401 Unauthorized', code: 'credential' });
  assert.equal(done.rounds[0].code, 'credential');
  assert.equal(finishRound(spec({ rounds: [{ round: 1, questions: 10, sectionIds: ['s#1'], status: 'running' }] }), 0, { status: 'done' }).rounds[0].code, undefined);
});

const coverage = sections => ({ sections: sections.map(([key, state]) => ({ key, id: key, sourceId: 's', title: key, state, start: 0, end: 10 })) });
test('the default top-up round puts the sections that failed again and again last, so the ones that can succeed come first', () => {
  const view = coverage([['s#1', 'planned-failed'], ['s#2', 'never-planned'], ['s#3', 'planned-failed'], ['s#4', 'never-planned']]);
  assert.deepEqual(planRound(view, { limit: 10 }).picks.map(pick => pick.key), ['s#1', 's#3', 's#2', 's#4']);
  assert.deepEqual(planRound(view, { limit: 10, late: new Set(['s#1']) }).picks.map(pick => pick.key), ['s#3', 's#2', 's#4', 's#1']);
  assert.deepEqual(planRound(view, { limit: 2, late: new Set(['s#1']) }).picks.map(pick => pick.key), ['s#3', 's#2'], 'the round is cut after the sections that can succeed');
});

const job = (over = {}) => ({ id: 'j', status: 'complete', kind: 'quiz', savedCount: 174, requestedTotal: 251, ...over });
test('progress: questions kept over the plan\'s goal, 100 only when nothing is missing (D-1)', () => {
  const percent = over => jobContract(job(over)).progress.percent;
  assert.equal(percent({}), 69, 'a draft that came out short is 69%, not 100%');
  assert.equal(percent({ savedCount: 251 }), 100);
  assert.equal(percent({ requestedTotal: 0, savedCount: 12 }), 100, 'a run that asked for nothing in particular is done when it ends');
  const stopped = reason => ({ coveragePlan: { goal: 251, rounds: 9 }, coverageRun: { state: 'stopped', list: [], stop: { reason } } });
  assert.equal(percent(stopped('sections-left')), 69);
  assert.equal(percent({ ...stopped('sections-left'), savedCount: 251 }), 99, 'every question made but sections left: not 100');
  assert.equal(percent({ ...stopped('complete'), savedCount: 251 }), 100);
  assert.equal(percent({ ...stopped('target'), savedCount: 126, coveragePlan: { goal: 251, rounds: 9 }, requestedTotal: 126 }), 100, 'the plan was met at the target of its level');
  assert.equal(percent({ status: 'failed', ...stopped('refused'), savedCount: 24 }), 10);
  assert.equal(percent({ requestedTotal: 28, savedCount: 25, coveragePlan: { goal: 251, rounds: 9 }, coverageRun: { state: 'waiting', autoComplete: false, list: [] } }), 10, 'a manual run waiting after round 1 is the plan\'s 10%, not the round\'s 100%');
});
