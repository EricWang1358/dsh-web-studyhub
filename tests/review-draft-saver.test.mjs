import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftSaver, DRAFT_SAVE_DELAY_MS, draftKey, draftPayloadOf, draftable, restoredDraft, savedSignature, entrySignature } from '../ui/review/draft-persistence.js';
import { emptyEntry, entryForRun } from '../ui/review/session-logic.js';

/* The save channel of a question's unsubmitted answer (#537), away from React: one write at a time, the newest text wins, a late answer never
   clears what came after it, and a failure keeps the words and says so to whoever waits. The browser test (guided-drafts-browser) drives it through the real page. */

const run = (extra = {}) => ({ id: 'r', index: 2, card: { id: 'c', kind: 'open' }, queueVersion: 1, feedback: null, ...extra });

/** A clock the test moves by hand, and a host whose answers the test releases one by one. */
function rig({ root = () => 'lib' } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const calls = [];
  const call = (action, args) => new Promise((resolve, reject) => { calls.push({ action, args, resolve, reject }); });
  const saver = createDraftSaver({ call, currentRoot: root,
    setTimer: (fn) => { const handle = ++nextTimer; timers.set(handle, fn); return handle; },
    clearTimer: (handle) => timers.delete(handle) });
  const tick = () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { saver, calls, tick, settle, timers };
}
const save = (text, key = 'k1', extra = {}) => ({ key, root: 'lib', args: { runId: 'r', cardId: 'c', index: 2, queueVersion: 1, draft: { selected: [], text, stepInputs: {} }, ...extra } });

test('the payload holds what was typed, picked and filled in, and empty values stay in it so a cleared answer is written', () => {
  assert.deepEqual(draftPayloadOf({ ...emptyEntry(), response: 'abc', selected: ['a'], clozeValues: { x: '1' } }).draft, { selected: ['a'], text: 'abc', stepInputs: { x: '1' } });
  assert.deepEqual(draftPayloadOf(emptyEntry()), { draft: { selected: [], text: '', stepInputs: {} } }, 'cleared values are sent as empty values, not left out');
  assert.deepEqual(draftPayloadOf({ ...emptyEntry(), assistance: { hintUsed: true } }).assistance, { hintUsed: true });
});

test('the key binds the library, the round, the place, the card and the queue', () => {
  const base = draftKey('lib', run());
  for (const other of [draftKey('other', run()), draftKey('lib', run({ id: 'x' })), draftKey('lib', run({ index: 3 })), draftKey('lib', run({ card: { id: 'd' } })), draftKey('lib', run({ queueVersion: 2 }))])
    assert.notEqual(other, base);
  assert.equal(draftKey('lib', run({ revision: 4 })), base, 'a corrected card is the same question: the learner keeps the words');
  assert.equal(draftKey('lib', null), '');
});

test('only an open, unanswered question outside an exam takes a draft', () => {
  assert.equal(draftable(run()), true);
  for (const closed of [null, run({ card: null }), run({ feedback: {} }), run({ complete: true }), run({ closed: true }), run({ mode: 'exam' })]) assert.equal(draftable(closed), false);
});

test('opening a question restores the saved answer and help, and nothing of it into an answered question', () => {
  const reader = { draft: () => '' };
  const card = { id: 'c', kind: 'multi', options: [{ id: 'a' }, { id: 'b' }] };
  const saved = run({ card, draft: { selected: ['a', 'gone'], text: 'half', stepInputs: { x: '1' }, updatedAt: 1 }, assistance: { used: true, hintUsed: true } });
  const entry = entryForRun(saved, null, reader);
  assert.deepEqual(entry.selected, ['a'], 'an option the corrected card no longer has cannot be picked, so it does not come back');
  assert.equal(entry.response, 'half');
  assert.deepEqual(entry.clozeValues, { x: '1' });
  assert.deepEqual(entry.assistance, { used: true, hintUsed: true });
  assert.equal(entry.hint, false, 'whether the hint panel was open is not saved, so it is not claimed');
  assert.equal(entry.explain, false);

  const answered = entryForRun({ ...saved, feedback: { selected: ['b'] } }, null, reader);
  assert.deepEqual(answered.selected, ['b'], 'the answer, not the old draft');
  assert.equal(answered.response, '');
  assert.deepEqual(answered.clozeValues, {});
  assert.equal(answered.assistance, null);

  const back = { key: JSON.stringify(['r', 2, 'c', 1, 0]), selected: [], response: 'newer', clozeValues: {}, assistance: { askedTutorBeforeAnswer: true } };
  const returned = entryForRun(saved, back, reader);
  assert.equal(returned.response, 'newer', 'what the learner left on screen is newer than the saved draft');
  assert.deepEqual(returned.selected, [], 'and a cleared choice stays cleared');
  assert.deepEqual(returned.assistance, { used: true, hintUsed: true, askedTutorBeforeAnswer: true }, 'evidence from either side is kept');
});

test('a restored question has nothing new to write: the saved draft and the entry made from it sign the same', () => {
  const card = { id: 'c', kind: 'multi', options: [{ id: 'a' }] };
  const saved = run({ card, draft: { selected: ['a'], text: 't', stepInputs: {}, updatedAt: 5 }, assistance: { used: true, hintUsed: true } });
  assert.equal(savedSignature(saved), entrySignature(entryForRun(saved, null, { draft: () => '' })));
  assert.equal(savedSignature(run()), entrySignature(emptyEntry()), 'and so does a question with no draft at all');
  assert.deepEqual(restoredDraft(run()), null);
});

test('typing is debounced into one plain review.draft.save with the newest text', async () => {
  const { saver, calls, tick, settle } = rig();
  saver.schedule(save('a'));
  saver.schedule(save('ab'));
  saver.schedule(save('abc'));
  assert.equal(calls.length, 0, 'nothing is sent while the learner types');
  assert.equal(saver.dirty(), true);
  tick();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'review.draft.save');
  assert.equal(calls[0].args.draft.text, 'abc');
  calls[0].resolve({ ok: true });
  await settle();
  assert.equal(saver.dirty(), false);
  assert.ok(DRAFT_SAVE_DELAY_MS >= 300 && DRAFT_SAVE_DELAY_MS <= 500, 'the 300-500 ms of the plan');
});

test('an old request finishing does not clear the newer text, and writes never overtake each other', async () => {
  const { saver, calls, tick, settle } = rig();
  saver.schedule(save('old'));
  tick();
  await settle();
  saver.schedule(save('new'));
  tick();
  await settle();
  assert.equal(calls.length, 1, 'the newer write waits for the one in flight');
  calls[0].resolve({ ok: true });
  await settle();
  assert.equal(saver.dirty(), true, 'the old answer did not mark the new text saved');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.draft.text, 'new');
  calls[1].resolve({ ok: true });
  await settle();
  assert.equal(saver.dirty(), false);
});

test('flush sends at once, waits for the write and reports success', async () => {
  const { saver, calls, settle, timers } = rig();
  saver.schedule(save('typed'));
  let flushed;
  saver.flush().then((value) => { flushed = value; });
  await settle();
  assert.equal(timers.size, 0, 'the debounce is over');
  assert.equal(calls.length, 1);
  assert.equal(flushed, undefined, 'it is still waiting');
  calls[0].resolve({ ok: true });
  await settle();
  assert.equal(flushed, true);
});

test('a failed write keeps the words, reports false to the flush that waits, and the next flush sends them again', async () => {
  const { saver, calls, settle } = rig();
  saver.schedule(save('keep me'));
  let flushed;
  saver.flush().then((value) => { flushed = value; });
  await settle();
  calls[0].reject(new Error('offline'));
  await settle();
  assert.equal(flushed, false);
  assert.equal(saver.dirty(), true, 'never shown as saved');
  let again;
  saver.flush().then((value) => { again = value; });
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.draft.text, 'keep me');
  calls[1].resolve({ ok: true });
  await settle();
  assert.equal(again, true);
  assert.equal(saver.dirty(), false);
});

test('a failed old write does not bring its text back over what was typed after it', async () => {
  const { saver, calls, tick, settle } = rig();
  saver.schedule(save('old'));
  tick();
  await settle();
  saver.schedule(save('new'));
  calls[0].reject(new Error('offline'));
  await settle();
  let flushed;
  saver.flush().then((value) => { flushed = value; });
  await settle();
  assert.equal(calls.at(-1).args.draft.text, 'new');
  assert.equal(calls.filter((item) => item.args.draft.text === 'old').length, 1, 'the old text is not sent again');
  calls.at(-1).resolve({ ok: true });
  await settle();
  assert.equal(flushed, true);
});

test('moving to another question sends what was waiting for the last one first', async () => {
  const { saver, calls, settle } = rig();
  saver.schedule(save('on the first question', 'k1'));
  saver.schedule(save('on the second question', 'k2'));
  await settle();
  assert.equal(calls.length, 1, 'the first question does not wait for the second one\'s debounce');
  assert.equal(calls[0].args.draft.text, 'on the first question');
  calls[0].resolve({ ok: true });
  await settle();
  assert.equal(calls.length, 1, 'the second question is still within its debounce');
});

test('a save for another library is never sent, and one in flight when the library changes cannot come back', async () => {
  let root = 'lib';
  const { saver, calls, tick, settle } = rig({ root: () => root });
  saver.schedule(save('for the old library'));
  root = 'other';
  tick();
  await settle();
  assert.equal(calls.length, 0, 'it would have been written to the library now open');
  assert.equal(saver.dirty(), false);

  root = 'lib';
  saver.schedule(save('in flight'));
  tick();
  await settle();
  saver.discard();
  calls[0].reject(new Error('The library changed'));
  await settle();
  assert.equal(saver.dirty(), false, 'it is not queued again');
  assert.equal(await saver.flush(), true, 'and blocks nothing');
});

test('discarding one question drops only that question: an answered question takes no late draft', async () => {
  const { saver, calls, settle, tick } = rig();
  saver.schedule(save('late', 'k1'));
  saver.discard('k1');
  tick();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(saver.dirty(), false);
});

test('a save the host calls stale counts as done: the question is gone, nothing is left to block on', async () => {
  const { saver, calls, settle } = rig();
  saver.schedule(save('old queue'));
  let flushed;
  saver.flush().then((value) => { flushed = value; });
  await settle();
  calls[0].resolve({ ok: false, stale: 'queue' });
  await settle();
  assert.equal(flushed, true);
  assert.equal(saver.dirty(), false);
});
