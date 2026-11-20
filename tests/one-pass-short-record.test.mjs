import test from 'node:test';
import assert from 'node:assert/strict';
import { shortRecords } from '../lib/assigned-plan.js';
import { shortOfPlans } from '../lib/plan-record.js';

/* A section with more than `cardsPerReply` questions is written in pieces (`key/1`, `key/2`, lib/one-pass/portions.js), and the pieces may land in different portions,
   so two parts of one run each say what their piece of the section came back short. What the run says about the section is the sum of its pieces; a later word on the
   SAME piece (a part written again) still replaces the earlier one. */

const row = (key, quota, planned) => ({ key, sectionId: 'doc#s1', sourceId: 'doc', start: 0, end: 100, quota, planned, missing: quota - planned, chars: 50 });

test('the short rows of two pieces of one section in two parts add up; a later word on the same piece replaces the earlier one', () => {
  const first = { part: 1, short: shortRecords([row('doc#s1/1', 7, 2)]) }, second = { part: 2, short: shortRecords([row('doc#s1/2', 6, 1)]) };
  const both = shortOfPlans([first, second]).get('doc#s1');
  assert.deepEqual([both.needed, both.got, both.chars], [13, 3, 100]);
  const again = { part: 3, short: shortRecords([row('doc#s1/2', 6, 5)]) };
  const later = shortOfPlans([first, second, again]).get('doc#s1');
  assert.deepEqual([later.needed, later.got], [13, 7], 'piece 2 is now what its later part says; piece 1 stays');
});

test('a section that is not cut is one row, replaced by a later word as before', () => {
  const earlier = { short: shortRecords([{ ...row('doc#s1', 3, 1) }]) }, later = { short: shortRecords([{ ...row('doc#s1', 3, 2) }]) };
  assert.equal(shortOfPlans([earlier, later]).get('doc#s1').got, 2);
});
