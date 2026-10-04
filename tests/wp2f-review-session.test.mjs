import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_ADVANCE_MS, emptyEntry, entryForRun, shouldResetEntry, isPassed, advanceKeyOf, autopilotPlan, shortcutGate, shortcutAction,
  isCurrentEntry, createFlightSet, reviewChoiceKind,
} from '../ui/review/session-logic.js';

// UI wave 2 · WP-F (#112): the practice session's rules, away from the DOM.

const card = (extra = {}) => ({ id: 'c', kind: 'flashcard', options: [{ id: 'a' }, { id: 'b' }], ...extra });
const run = (extra = {}) => ({ id: 'r', index: 1, total: 4, card: card(), revealed: false, feedback: null, queueVersion: 0, ...extra });

test('the answer entry of a new question is empty, and restored input only returns to the same, unanswered question', () => {
  assert.deepEqual(emptyEntry(), { selected: [], hint: false, explain: false, response: '', clozeValues: {}, teaching: null, teachAnswer: '' });
  assert.notEqual(emptyEntry().selected, emptyEntry().selected, 'fresh containers every time');
  const first = run();
  const restored = { key: JSON.stringify(['r', 1, 'c', 0, 0]), selected: ['a'], hint: true, explain: true, response: 'typed', clozeValues: { x: '1' }, teachAnswer: 'half' };
  assert.deepEqual(entryForRun(first, restored, { draft: () => '' }), { selected: ['a'], hint: true, explain: true, response: 'typed', clozeValues: { x: '1' }, teaching: null, teachAnswer: 'half' });
  assert.deepEqual(entryForRun(first, { ...restored, key: 'other' }, { draft: () => '' }), emptyEntry(), 'another question does not inherit the typed answer');
  assert.deepEqual(entryForRun(run({ feedback: { selected: ['b'] } }), restored, { draft: () => '' }).selected, ['b'], 'an answered question shows what was picked, not the restored input');
  assert.equal(entryForRun(run({ feedback: {} }), restored, { draft: () => '' }).response, '', 'nothing is restored into an answered question');
  assert.equal(entryForRun(first, restored, { draft: () => 'saved draft' }).teachAnswer, 'saved draft', 'a saved teaching draft wins over the restored one');
  const teaching = { id: 't', index: 0 };
  assert.deepEqual(entryForRun(run({ teaching }), null, { draft: (value) => (value === teaching ? 'd' : '') }).teaching, teaching);
});

test('a changed queue version resets the entry; the same run and version does not; another run is not this rule\'s business', () => {
  assert.equal(shouldResetEntry({ id: 'r', version: 1 }, { id: 'r', queueVersion: 2 }), true);
  assert.equal(shouldResetEntry({ id: 'r', version: 1 }, { id: 'r', queueVersion: 1 }), false);
  assert.equal(shouldResetEntry({ id: 'r', version: 0 }, { id: 'r' }), false, 'a missing version is 0');
  assert.equal(shouldResetEntry({ id: 'r', version: 1 }, { id: 'other', queueVersion: 5 }), false);
  assert.equal(shouldResetEntry(null, { id: 'r', queueVersion: 5 }), false, 'the first run seen has nothing to reset');
});

test('what counts as a pass: a grade of 3 or more, or a correct choice', () => {
  assert.equal(isPassed(run({ feedback: { grade: 3 } })), true);
  assert.equal(isPassed(run({ feedback: { grade: 2 } })), false);
  assert.equal(isPassed(run({ feedback: { grade: 0 } })), false, 'a zero grade is still a grade');
  assert.equal(isPassed(run({ feedback: { correct: true } })), true);
  assert.equal(isPassed(run({ feedback: { correct: false } })), false);
  assert.equal(isPassed(run()), false);
  assert.equal(isPassed(null), false);
});

test('autopilot moves on by itself only after a pass, on the practice page, and only until the learner touches something', () => {
  const ready = { autopilot: true, page: 'review', passed: true, complete: false, teaching: false, skippedKey: '', advanceKey: 'r:1:0' };
  assert.deepEqual(autopilotPlan(ready), { schedule: true, key: 'r:1:0', ms: AUTO_ADVANCE_MS });
  assert.equal(AUTO_ADVANCE_MS, 1500);
  for (const [name, patch] of Object.entries({ off: { autopilot: false }, elsewhere: { page: 'library' }, 'not passed': { passed: false },
    finished: { complete: true }, teaching: { teaching: true }, 'learner stopped it': { skippedKey: 'r:1:0' } })) {
    assert.deepEqual(autopilotPlan({ ...ready, ...patch }), { schedule: false, key: '', ms: 0 }, name);
  }
  assert.deepEqual(autopilotPlan({ ...ready, skippedKey: 'r:0:0' }).schedule, true, 'stopping one question does not stop the next');
  assert.equal(advanceKeyOf(run({ queueVersion: 2 })), 'r:1:2');
  assert.equal(advanceKeyOf(null), '');
});

const ctx = (extra = {}) => ({ inside: true, modalOpen: false, page: 'review', run: run(), busy: false, shortcutHelp: false, choice: false, isCloze: false, rubricCard: false,
  selected: [], clozeValues: {}, ...extra });
const key = (k, extra = {}) => ({ key: k, code: k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : k, shiftKey: false, repeat: false, defaultPrevented: false,
  ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false, ...extra });

test('the gate: shortcuts only inside the panel, outside text fields and dialogs, without modifiers, while nothing is open', () => {
  assert.equal(shortcutGate(key('a'), ctx()), true);
  for (const [name, event, patch] of [['outside', key('a'), { inside: false }], ['typing', key('a', { inEditable: true }), {}], ['ctrl', key('a', { ctrlKey: true }), {}],
    ['meta', key('a', { metaKey: true }), {}], ['alt', key('a', { altKey: true }), {}], ['dialog open', key('a'), { modalOpen: true }]]) {
    assert.equal(shortcutGate(event, ctx(patch)), false, name);
  }
  assert.equal(shortcutAction(key('a', { defaultPrevented: true }), ctx()), null, 'already handled');
  assert.equal(shortcutAction(key('a', { repeat: true }), ctx()), null, 'held keys do nothing');
  assert.equal(shortcutAction(key('a'), ctx({ inside: false })), null);
});

const act = (event, patch) => shortcutAction(event, ctx(patch));

test('shortcuts: help, autopilot and resume work from anywhere; every key stops the autopilot countdown', () => {
  assert.deepEqual(act(key('?'), {}), { cancelAuto: true, preventDefault: true, action: { type: 'help' } });
  assert.deepEqual(act(key('/', { code: 'Slash', shiftKey: true }), {}).action, { type: 'help' });
  assert.deepEqual(act(key('Escape'), { shortcutHelp: true }), { cancelAuto: true, preventDefault: false, action: { type: 'help-close' } });
  assert.equal(act(key('Escape'), { shortcutHelp: false }).action, null);
  assert.deepEqual(act(key('a'), {}).action, { type: 'autopilot' });
  assert.deepEqual(act(key('A'), {}).action, { type: 'autopilot' }, 'case does not matter');
  assert.deepEqual(act(key('s'), { page: 'library', run: null }).action, { type: 'resume' });
  assert.deepEqual(act(key('s'), { run: run({ complete: true }) }).action, { type: 'resume' }, 'a finished round resumes');
  assert.equal(act(key('s'), {}).action, null, 'a question is open: S does nothing');
  assert.equal(act(key('s'), { page: 'library', busy: true }).action, null);
  assert.equal(act(key('a', { shiftKey: true }), {}).action, null, 'shift is another key');
  assert.equal(act(key('Enter', { onButton: true }), {}).action, null, 'Enter on a button presses the button');
  assert.equal(act(key(' ', { code: 'Space', onButton: true }), {}).action, null);
  assert.equal(act(key('a'), { page: 'library', run: null }).cancelAuto, true);
});

test('shortcuts: nothing but the global ones work off the practice page, without a card, or while saving', () => {
  for (const patch of [{ page: 'library' }, { run: null }, { run: run({ card: null }) }, { busy: true }]) {
    assert.equal(act(key('h'), patch).action, null, JSON.stringify(Object.keys(patch)));
    assert.equal(act(key('Enter'), patch).action, null);
  }
});

test('shortcuts: grading keys 0-5 apply to a revealed, unanswered self-graded card only', () => {
  const revealed = { run: run({ revealed: true }) };
  assert.deepEqual(act(key('4'), revealed), { cancelAuto: true, preventDefault: true, action: { type: 'answer', args: { grade: 4 } } });
  assert.deepEqual(act(key('0'), revealed).action, { type: 'answer', args: { grade: 0 } });
  assert.equal(act(key('6'), revealed).action, null);
  assert.equal(act(key('4'), { run: run({ revealed: false }) }).action, null, 'the back of the card has not been seen');
  assert.equal(act(key('4'), { run: run({ revealed: true, feedback: {} }) }).action, null, 'already graded');
  assert.equal(act(key('4'), { ...revealed, choice: true }).action, null, 'a choice question has no self grade');
  assert.equal(act(key('4'), { ...revealed, isCloze: true }).action, null);
});

test('shortcuts: Enter flips, submits or moves on, depending on the card', () => {
  assert.deepEqual(act(key('Enter'), { run: run({ feedback: {} }) }), { cancelAuto: true, preventDefault: true, action: { type: 'move', direction: 1 } });
  assert.deepEqual(act(key('Enter'), {}).action, { type: 'flip' });
  assert.equal(act(key('Enter'), { rubricCard: true }).action, null, 'a written answer is not flipped');
  const multi = { choice: true, run: run({ card: card({ multiple: true, kind: 'multi' }) }) };
  assert.deepEqual(act(key('Enter'), { ...multi, selected: ['a', 'b'] }).action, { type: 'answer', args: { selected: ['a', 'b'] } });
  assert.equal(act(key('Enter'), { ...multi, selected: [] }).action, null);
  assert.equal(act(key('Enter'), { ...multi, selected: [] }).preventDefault, true, 'Enter is still taken');
  assert.deepEqual(act(key('Enter'), { isCloze: true, clozeValues: { x: ' ', y: 'ok' } }).action, { type: 'answer', args: { answers: { x: ' ', y: 'ok' } } });
  assert.equal(act(key('Enter'), { isCloze: true, clozeValues: { x: '  ' } }).action, null, 'blanks only');
});

test('shortcuts: H toggles the hint before and the explanation after revealing; T asks for a plain explanation outside exams', () => {
  assert.deepEqual(act(key('h'), {}).action, { type: 'hint' });
  assert.deepEqual(act(key('h'), { run: run({ revealed: true }) }).action, { type: 'explain' });
  assert.deepEqual(act(key('t'), {}).action, { type: 'assist-plain' });
  assert.equal(act(key('t'), { run: run({ mode: 'exam' }) }).action, null);
});

test('shortcuts: arrows move, Space flips, 1-6 choose an option that exists', () => {
  assert.deepEqual(act(key('ArrowRight'), { run: run({ feedback: {} }) }).action, { type: 'move', direction: 1 });
  assert.equal(act(key('ArrowRight'), {}).action, null, 'you cannot skip an unanswered question');
  assert.deepEqual(act(key('ArrowLeft'), {}).action, { type: 'move', direction: -1 });
  assert.equal(act(key('ArrowLeft'), { run: run({ index: 0 }) }).action, null, 'nothing before the first question');
  assert.deepEqual(act(key(' ', { code: 'Space' }), {}).action, { type: 'flip' });
  assert.equal(act(key(' ', { code: 'Space' }), { choice: true }).action, null);
  assert.deepEqual(act(key('2'), { choice: true }), { cancelAuto: true, preventDefault: false, action: { type: 'choose', id: 'b' } });
  assert.equal(act(key('3'), { choice: true }).action, null, 'there is no third option');
  assert.equal(act(key('2'), { choice: true, run: run({ feedback: {} }) }).action, null, 'answered');
});

test('the card kinds the session distinguishes', () => {
  assert.deepEqual(reviewChoiceKind(run({ card: card({ kind: 'quiz' }) })), { choice: true, isCloze: false, rubricCard: false });
  assert.deepEqual(reviewChoiceKind(run({ card: card({ kind: 'multi' }) })).choice, true);
  assert.deepEqual(reviewChoiceKind(run({ card: card({ kind: 'cloze' }) })), { choice: false, isCloze: true, rubricCard: false });
  assert.deepEqual(reviewChoiceKind(run({ card: card({ kind: 'open', rubricCriteria: [{}] }) })), { choice: false, isCloze: false, rubricCard: true });
  assert.deepEqual(reviewChoiceKind(run({ card: card({ kind: 'open' }) })).rubricCard, false);
  assert.deepEqual(reviewChoiceKind(run({ mode: 'flashcard', card: card({ kind: 'quiz' }) })), { choice: false, isCloze: false, rubricCard: false }, 'flashcard mode shows every card as a flashcard');
  assert.deepEqual(reviewChoiceKind(null), { choice: false, isCloze: false, rubricCard: false });
});

test('stale guards: an answer for a question the learner has left is dropped', () => {
  const current = run();
  const key0 = JSON.stringify(['r', 1, 'c', 0, 0]);
  assert.equal(isCurrentEntry(current, key0), true);
  assert.equal(isCurrentEntry(run({ index: 2 }), key0), false, 'moved on');
  assert.equal(isCurrentEntry(run({ queueVersion: 1 }), key0), false, 'the queue changed under it');
  assert.equal(isCurrentEntry(run({ revision: 1 }), key0), false, 'the card was rewritten');
  assert.equal(isCurrentEntry(null, key0), false);
  assert.equal(isCurrentEntry(current, key0, { page: 'library', needPage: 'review' }), false, 'teaching answers also need the practice page');
  assert.equal(isCurrentEntry(current, key0, { page: 'review', needPage: 'review' }), true);
});

test('one request per question: a second click joins the one in flight', () => {
  const flights = createFlightSet();
  assert.equal(flights.begin('k'), true);
  assert.equal(flights.begin('k'), false);
  assert.equal(flights.has('k'), true);
  assert.equal(flights.begin('other'), true);
  flights.end('k');
  assert.equal(flights.begin('k'), true, 'free again once it finished');
  assert.equal(flights.begin(''), false, 'no question, no request');
});
