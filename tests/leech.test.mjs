import test from 'node:test';
import assert from 'node:assert/strict';
import { leechLimits, leechOf, openLeeches } from '../lib/leech.js';
import { PRACTICE_DEFAULTS, PRACTICE_LIMITS, normalizePracticeSettings, validatePracticePatch } from '../lib/practice-settings.js';
import { emptyState } from '../lib/store.js';
import { wrongBook } from '../lib/insights.js';

/* 顽固题 (#884 S1): a question is a leech when the attempt log says it keeps being failed. The numbers are practice settings, so every case here reads them
   from the settings and only the edges are written as numbers. */

const LIMITS = leechLimits();
const at = n => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
/** A log of one question from a string: x failed (grade 1), o passed (grade 4), oldest first. */
const log = (marks, extra = {}) => [...marks].map((mark, n) => ({ deckId: 'd', quiz_id: 'q', grade: mark === 'x' ? 1 : 4, timestamp: at(n), ...extra }));

test('the agreed numbers are practice settings with limits, not literals: 4 failures, the latest 5, 60 per cent', () => {
  assert.deepEqual(LIMITS, { failures: 4, window: 5, rate: 60 });
  assert.equal(PRACTICE_DEFAULTS.leechFailures, 4);
  assert.equal(PRACTICE_DEFAULTS.leechWindow, 5);
  assert.equal(PRACTICE_DEFAULTS.leechRate, 60);
  for (const key of ['leechFailures', 'leechWindow', 'leechRate']) assert.ok(PRACTICE_LIMITS[key].min < PRACTICE_LIMITS[key].max, key);
  assert.deepEqual(leechLimits({ leechFailures: 6, leechWindow: 8, leechRate: 75 }), { failures: 6, window: 8, rate: 75 });
  assert.deepEqual(leechLimits({ leechFailures: 'many' }), LIMITS, 'a wrong saved value is the default');
});

test('the settings validate the three numbers like the round size: whole numbers inside their limits', () => {
  for (const key of ['leechFailures', 'leechWindow', 'leechRate']) {
    const { min, max } = PRACTICE_LIMITS[key];
    assert.equal(validatePracticePatch({ [key]: min })[key], min);
    assert.equal(validatePracticePatch({ [key]: max })[key], max);
    for (const bad of [min - 1, max + 1, 4.5, '4', null, NaN, true]) assert.throws(() => validatePracticePatch({ [key]: bad }), /Invalid practice setting/, `${key} ${bad}`);
    assert.equal(normalizePracticeSettings({ [key]: max + 1 })[key], PRACTICE_DEFAULTS[key]);
  }
});

test('failed 4 times in total is a leech; 3 is not', () => {
  assert.equal(leechOf(log('xxxx')), true);
  assert.equal(leechOf(log('xxx')), false);
  // spread out, with right answers between them: the total counts, but see below for the recovery
  assert.equal(leechOf(log('xoxoxox')), true);
  assert.equal(leechOf(log('xoxoxo')), false, '3 failures in 6');
});

test('the latest 5 attempts with at least 60 per cent failed is a leech even with fewer than 4 failures in all', () => {
  assert.equal(leechOf(log('xxxoo')), true, '3 of 5 is 60 per cent: the edge counts');
  assert.equal(leechOf(log('xxooo')), false, '2 of 5');
  assert.equal(leechOf(log('xxxo')), false, 'only 4 attempts: the window is not full yet, and 3 failures is below the total');
  assert.equal(leechOf(log('ooxxx')), true, 'the latest 5, not the first 5');
  assert.equal(leechOf(log('xxxxoooo')), true, 'the total rule: 4 failures stand while fewer than 5 right answers followed');
});

test('the thresholds come from the settings: a stricter or looser learner moves the edges', () => {
  const strict = leechLimits({ leechFailures: 3, leechWindow: 4, leechRate: 75 });
  assert.equal(leechOf(log('xxx'), strict), true);
  assert.equal(leechOf(log('xxxo'), strict), true, '3 of 4 is 75 per cent');
  assert.equal(leechOf(log('xxoo'), strict), false);
  const loose = leechLimits({ leechFailures: 8 });
  assert.equal(leechOf(log('xxxx'), loose), false);
  assert.equal(leechOf(log('xxxxxxxx'), loose), true);
});

test('a retry, an answer after the question was opened up again, and an unverified self-report are not counted', () => {
  assert.equal(leechOf([...log('xxx'), { ...log('x')[0], timestamp: at(9), retry: true }]), false, 'a retry is extra practice of the same answer');
  assert.equal(leechOf([...log('xxx'), { ...log('x')[0], timestamp: at(9), updatedAfterOpening: true }]), false);
  assert.equal(leechOf([...log('xxx'), { ...log('x')[0], timestamp: at(9), selfReported: true }]), false, 'a self-report is not a verified failure');
  assert.equal(leechOf([...log('xxx'), { ...log('x')[0], timestamp: at(9), assessment: 'self-report' }]), false);
  assert.equal(leechOf([...log('xxx'), { ...log('x')[0], timestamp: at(9) }]), true, 'the same fourth attempt, counted');
  // and they do not dilute the window either
  assert.equal(leechOf([...log('xxxoo'), ...log('oooo', { retry: true }).map((a, n) => ({ ...a, timestamp: at(20 + n) }))]), true);
});

test('only the grade decides: 2 is a failure and 3 is not', () => {
  const grades = list => list.map((grade, n) => ({ deckId: 'd', quiz_id: 'q', grade, timestamp: at(n) }));
  assert.equal(leechOf(grades([2, 2, 2, 2])), true);
  assert.equal(leechOf(grades([3, 3, 3, 3, 3, 3])), false);
  assert.equal(leechOf(grades([0, 5, 2, 3, 1])), true, '3 of the latest 5 under 3');
});

test('the order of the log does not matter, only the times', () => {
  const shuffled = [...log('ooxxx')].reverse();
  assert.equal(leechOf(shuffled), true);
  assert.equal(leechOf(log('xxxxooooo').reverse()), false);
});

test('a question failed 4 times long ago and answered right in the whole latest window since is not a leech any more', () => {
  // The decision (documented in docs/review.md): the total rule would otherwise mark a question for ever, and the latest-attempts rule exists so that it can recover.
  assert.equal(leechOf(log('xxxxooooo')), false, 'a full window of right answers since');
  assert.equal(leechOf(log('xxxxoooo')), true, 'one short of a full window: still a leech');
  assert.equal(leechOf(log('xxxxooooox')), true, 'a new failure inside the window brings the total back: 5 failures in all');
  assert.equal(leechOf(log('xxxxoooooxx')), true, '6 failures in all, 2 of the latest 5 failed');
});

test('no attempts, or attempts that do not count, is not a leech', () => {
  assert.equal(leechOf([]), false);
  assert.equal(leechOf(undefined), false);
  assert.equal(leechOf(log('xxxx', { retry: true })), false);
});

/* ---------- in the wrong book ---------- */

const card = (id, topic = id) => ({ id, kind: 'quiz', topic, prompt: `${id}?`, options: [{ id: 'y', text: 'Y', correct: true }, { id: 'n', text: 'N', correct: false }] });
function stateOf(attemptsByCard, settings) {
  const state = emptyState();
  state.decks = [{ id: 'd', title: 'Deck', course: 'C', cards: Object.keys(attemptsByCard).map(id => card(id)) }];
  state.attempts = Object.entries(attemptsByCard).flatMap(([id, marks]) => log(marks).map(attempt => ({ ...attempt, quiz_id: id })));
  if (settings) state.settings.practice = settings;
  return state;
}
const flags = (state, options) => Object.fromEntries(wrongBook(state, options).items.map(item => [item.cardId, item.leech]));

test('both wrong-book views mark a leech, whatever the card record says (lapses 0 from the older format)', () => {
  const state = stateOf({ again: 'xxxx', once: 'x', cured: 'xxxo', history: 'xxxxo' });
  for (const item of state.decks[0].cards) item.review = { lapses: 0, repetitions: 0 };
  assert.deepEqual(flags(state), { again: true, once: false }, 'weak: the last answer of each is still wrong');
  assert.deepEqual(flags(state, { view: 'history' }), { cured: false, history: true }, 'history: failed 4 times and then put right');
  assert.deepEqual(wrongBook(state, { view: 'history' }).items.map(item => item.wrongCount), [4, 3]);
});

test('the wrong book reads the thresholds from the practice settings', () => {
  const attempts = { two: 'xx', four: 'xxxx' };
  assert.deepEqual(flags(stateOf(attempts)), { two: false, four: true });
  assert.deepEqual(flags(stateOf(attempts, { leechFailures: 2 })), { two: true, four: true });
  assert.deepEqual(flags(stateOf(attempts, { leechFailures: 8 })), { two: false, four: false });
});

test('the flag is computed for the page that is returned, not for the whole list', () => {
  const state = stateOf({ a: 'xxxx', b: 'xxxx', c: 'xxxx' });
  const page = wrongBook(state, { limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].leech, true);
  assert.equal(page.counts.weak, 3);
});

/* ---------- the round end ---------- */

test('openLeeches: of a round\'s questions, the leeches the wrong book still holds, found in one pass over the log', () => {
  const attempts = [
    ...log('xxxx').map(a => ({ ...a, quiz_id: 'stuck' })),
    ...log('xxxxo').map(a => ({ ...a, quiz_id: 'put-right' })),
    ...log('xx').map(a => ({ ...a, quiz_id: 'twice' })),
    ...log('xxxx').map(a => ({ ...a, quiz_id: 'not-in-the-round' })),
  ];
  const refs = ['stuck', 'put-right', 'twice', 'never-answered'].map(cardId => ({ deckId: 'd', cardId }));
  assert.deepEqual(openLeeches(attempts, refs), [{ deckId: 'd', cardId: 'stuck' }], 'put-right is in 已订正, twice is no leech');
  assert.deepEqual(openLeeches(attempts, refs, leechLimits({ leechFailures: 2 })).map(ref => ref.cardId), ['stuck', 'twice']);
  assert.deepEqual(openLeeches([], refs), []);
});
