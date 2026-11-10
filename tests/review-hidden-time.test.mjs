import test from 'node:test';
import assert from 'node:assert/strict';
import { openClock, noteVisibility, hiddenMsOf } from '../ui/review/hidden-time.js';

/* #883 slice S2, the panel's side: how long the page was hidden while one question was open. Pure, so the learner's window can be played with numbers. */

const KEY = 'run-1/0/q1';

test('a question that stayed in view has nothing hidden', () => {
  const clock = openClock(KEY, 1000, false);
  assert.equal(hiddenMsOf(clock, KEY, 90000), 0);
});

test('one hidden stretch is counted from hiding to returning', () => {
  let clock = openClock(KEY, 0, false);
  clock = noteVisibility(clock, true, 10000);
  clock = noteVisibility(clock, false, 70000);
  assert.equal(hiddenMsOf(clock, KEY, 100000), 60000);
});

test('several stretches add up', () => {
  let clock = openClock(KEY, 0, false);
  for (const [hide, back] of [[1000, 3000], [5000, 9000], [20000, 21000]]) {
    clock = noteVisibility(clock, true, hide);
    clock = noteVisibility(clock, false, back);
  }
  assert.equal(hiddenMsOf(clock, KEY, 30000), 7000);
});

test('answering while still hidden counts up to the answer (a key from a pinned window)', () => {
  let clock = openClock(KEY, 0, false);
  clock = noteVisibility(clock, true, 4000);
  assert.equal(hiddenMsOf(clock, KEY, 10000), 6000);
});

test('hiding twice in a row, or returning twice, does not count twice', () => {
  let clock = openClock(KEY, 0, false);
  clock = noteVisibility(clock, true, 1000);
  clock = noteVisibility(clock, true, 5000);
  clock = noteVisibility(clock, false, 8000);
  clock = noteVisibility(clock, false, 9000);
  assert.equal(hiddenMsOf(clock, KEY, 20000), 7000);
});

test('a question opened while the page is hidden counts from the moment it opened', () => {
  let clock = openClock(KEY, 2000, true);
  clock = noteVisibility(clock, false, 12000);
  assert.equal(hiddenMsOf(clock, KEY, 15000), 10000);
});

test('another question starts from zero: the clock only answers for the question it opened', () => {
  let clock = openClock(KEY, 0, false);
  clock = noteVisibility(clock, true, 1000);
  clock = noteVisibility(clock, false, 9000);
  assert.equal(hiddenMsOf(clock, 'run-1/1/q2', 9500), 0, 'the next question was never timed by this clock');
  const next = openClock('run-1/1/q2', 9500, false);
  assert.equal(hiddenMsOf(next, 'run-1/1/q2', 12000), 0);
  assert.equal(hiddenMsOf(next, KEY, 12000), 0, 'and the old question reports nothing from the new clock');
});

test('a clock running backwards (the system clock moved) never reports a negative time', () => {
  let clock = openClock(KEY, 10000, false);
  clock = noteVisibility(clock, true, 9000);
  clock = noteVisibility(clock, false, 5000);
  assert.equal(hiddenMsOf(clock, KEY, 20000), 0);
  assert.equal(hiddenMsOf(noteVisibility(clock, true, 8000), KEY, 3000), 0);
});

test('with no clock at all (nothing opened yet) nothing is reported', () => {
  assert.equal(hiddenMsOf(undefined, KEY, 1000), 0);
  assert.equal(hiddenMsOf(null, '', 1000), 0);
});
