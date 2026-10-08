import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLAN_AFTER, REPEAT_LIMIT, FILL_ROUNDS, needsReplan, isRepeating } from '../lib/coverage-run.js';

const spec = n => ({ attempts: n === undefined ? {} : { a: { n } } });

test('a section is planned anew from its text after REPLAN_AFTER failed attempts, and given up only at REPEAT_LIMIT: the tries in between are not the same failed target again', () => {
  assert.ok(REPLAN_AFTER >= 1 && REPLAN_AFTER < REPEAT_LIMIT, 'there is room between planning anew and giving up');
  assert.ok(FILL_ROUNDS >= REPEAT_LIMIT - 1, 'the fill rounds a run may add are enough for every try a section is allowed');
  assert.equal(needsReplan(spec(), 'a'), false, 'no attempt recorded');
  assert.equal(needsReplan(spec(REPLAN_AFTER - 1), 'a'), false, 'the first retry writes the failed target again');
  assert.equal(needsReplan(spec(REPLAN_AFTER), 'a'), true, 'from the next try on it is planned anew');
  assert.equal(isRepeating(spec(REPLAN_AFTER), 'a'), false, 'and the run still tries it by itself');
  assert.equal(needsReplan(spec(REPEAT_LIMIT), 'a'), true);
  assert.equal(isRepeating(spec(REPEAT_LIMIT), 'a'), true);
});
