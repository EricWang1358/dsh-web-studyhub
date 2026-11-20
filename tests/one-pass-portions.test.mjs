import test from 'node:test';
import assert from 'node:assert/strict';
import { packPortions } from '../lib/one-pass/portions.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';

/* One pass (docs/plans/2026-11-21-feat-one-pass-generation-plan.md §3, §10): consecutive sections are packed into portions of at most
   ONE_PASS_LIMITS.portionChars characters and ONE_PASS_LIMITS.cardsPerReply cards; a section is never cut. */

let at = 0;
const section = (chars, quota, sourceId = 'doc') => { const start = at; at += chars; return { key: `${sourceId}#s${start}`, sectionId: `${sourceId}#s${start}`, sourceId, start, end: start + chars, quota }; };
const fresh = () => { at = 0; };

test('consecutive sections share a portion until the characters or the cards would pass the bound', () => {
  fresh();
  const list = [section(4000, 3), section(4000, 3), section(4000, 3), section(500, 1)];
  const portions = packPortions(list);
  assert.deepEqual(portions.map(portion => portion.assignments.map(item => item.key)), [[list[0].key, list[1].key], [list[2].key, list[3].key]]);
  assert.deepEqual(portions.map(portion => [portion.chars, portion.questions]), [[8000, 6], [4500, 4]]);
});

test('the cards of one reply are bounded: a portion closes before it would ask for more than cardsPerReply', () => {
  fresh();
  const list = Array.from({ length: 5 }, () => section(1000, 5));
  const portions = packPortions(list);
  assert.ok(portions.every(portion => portion.questions <= ONE_PASS_LIMITS.cardsPerReply));
  assert.deepEqual(portions.map(portion => portion.questions), [10, 10, 5]);
});

test('a section longer than a portion is given alone and never cut', () => {
  fresh();
  const list = [section(1000, 1), section(20000, 6), section(1000, 1)];
  const portions = packPortions(list);
  assert.equal(portions.length, 3);
  assert.deepEqual(portions[1].assignments, [list[1]], 'the long section stands whole in its own portion');
});

test('a section whose quota alone is more than one reply holds is cut into equal ranges that share its quota (the only cut)', () => {
  fresh();
  const big = section(24000, 30);
  const portions = packPortions([big]);
  assert.ok(portions.every(portion => portion.questions <= ONE_PASS_LIMITS.cardsPerReply));
  assert.equal(portions.reduce((sum, portion) => sum + portion.questions, 0), 30);
  const ranges = portions.flatMap(portion => portion.assignments);
  assert.equal(ranges[0].start, big.start);
  assert.equal(ranges.at(-1).end, big.end);
  assert.ok(ranges.every(item => item.sectionId === big.sectionId), 'every range keeps the section it is part of');
  for (let index = 1; index < ranges.length; index++) assert.equal(ranges[index].start, ranges[index - 1].end, 'the ranges are contiguous');
});

test('the bounds can be given (the constants module is the default)', () => {
  fresh();
  const list = [section(100, 1), section(100, 1), section(100, 1)];
  assert.equal(packPortions(list, { portionChars: 150, cardsPerReply: 12 }).length, 3);
  assert.equal(packPortions(list, { portionChars: 9000, cardsPerReply: 2 }).length, 2);
  assert.deepEqual(packPortions([]), []);
});
