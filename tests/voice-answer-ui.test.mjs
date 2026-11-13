import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSpokenBlanks, clozeBlankIds } from '../ui/voice/cloze-split.js';
import { suggestedGrade } from '../ui/voice/suggest-grade.js';
import { createVoiceRecorder } from '../ui/voice/mic.js';
import { autopilotPlan, gradesOutstanding, shortcutAction } from '../ui/review/session-logic.js';
import { mergeReviewPoll } from '../ui/async.js';

/* The browser half of voice answering (#1031) without a browser: the transcript goes into the same inputs as typing (cloze blanks split locally, no
   model), a flashcard gets a local suggested grade, the recorder uploads one clip and gives back text, and the keys. */

test('a spoken cloze fills its blanks by 第N空 / ordinals; a transcript that does not match the blanks fills none', () => {
  const card = { cloze: { text: '重试要配合 {{b1}} 和 {{b2}}，否则会放大 {{b3}}。', blanks: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] } };
  const ids = clozeBlankIds(card);
  assert.deepEqual(ids, ['b1', 'b2', 'b3']);
  assert.deepEqual(splitSpokenBlanks('第一空幂等，第二空是指数退避；第三空：负载。', ids), { values: { b1: '幂等', b2: '指数退避', b3: '负载' } });
  assert.deepEqual(splitSpokenBlanks('第2空 指数退避 第1空 幂等 第3个空 负载', ids), { values: { b1: '幂等', b2: '指数退避', b3: '负载' } }, 'any order, digits, 第N个空');
  assert.deepEqual(splitSpokenBlanks('first blank idempotency, second blank exponential backoff, third blank load', ids),
    { values: { b1: 'idempotency', b2: 'exponential backoff', b3: 'load' } });
  for (const said of ['幂等 指数退避 负载', '第一空幂等，第二空指数退避', '第一空幂等 第一空退避 第三空负载', '第一空 第二空退避 第三空负载', ''])
    assert.deepEqual(splitSpokenBlanks(said, ids), { mismatch: true }, said);
  assert.deepEqual(splitSpokenBlanks('幂等。', ['only']), { values: { only: '幂等' } }, 'one blank takes the whole sentence');
});

test('a flashcard gets a suggested grade from the words it shares with the answer (local, no model); nothing said suggests nothing', () => {
  const answer = '重试必须幂等，并用指数退避加抖动，避免把下游压垮。';
  assert.ok(suggestedGrade('重试要幂等，用指数退避加抖动，避免把下游压垮', answer) >= 4);
  assert.ok(suggestedGrade('要幂等', answer) <= 1);
  assert.equal(suggestedGrade('完全无关的内容', answer), 0);
  assert.equal(suggestedGrade('', answer), null);
  assert.equal(suggestedGrade('anything', ''), null);
});

const fakeCapture = () => {
  const capture = { stopped: false, handle: null };
  capture.fn = async (kind, onAudio) => {
    assert.equal(kind, 'microphone');
    capture.push = (samples) => onAudio(Int16Array.from(samples).buffer);
    capture.handle = { stop: async () => { capture.stopped = true; } };
    return capture.handle;
  };
  return capture;
};

test('the recorder sends one WAV clip, asks for its text once, and cancels the upload when sending fails', async () => {
  const calls = [];
  const call = async (action, args) => {
    calls.push([action, args]);
    if (action === 'audio.clip.transcribe') return { text: ' 幂等和指数退避 ' };
    return {};
  };
  const capture = fakeCapture(), states = [];
  let uploaded = null;
  const recorder = createVoiceRecorder({ call, capture: capture.fn, language: 'zh', onState: (state) => states.push(state.phase),
    upload: async (_call, namespace, file) => { assert.equal(namespace, 'audio'); uploaded = file; return 'u-1'; } });
  await recorder.start();
  capture.push(new Array(8000).fill(1000));
  const text = await recorder.finish();
  assert.equal(text, '幂等和指数退避');
  assert.ok(capture.stopped);
  assert.equal(uploaded.name, 'voice-answer.wav');
  assert.equal(uploaded.size, 44 + 16000);
  assert.deepEqual(calls, [['audio.clip.transcribe', { uploadId: 'u-1', language: 'zh' }]]);
  assert.deepEqual(states, ['recording', 'sending', 'idle']);

  // Nothing heard: no upload at all.
  const quiet = createVoiceRecorder({ call, capture: fakeCapture().fn, upload: async () => assert.fail('nothing to upload') });
  await quiet.start();
  await assert.rejects(quiet.finish(), /没有录到声音/);

  // The transcription refused (no setup): the error keeps its code for the setup guide; the server already deleted the clip.
  const heard = fakeCapture();
  const refusing = createVoiceRecorder({ capture: heard.fn, upload: async () => 'u-2',
    call: async () => { throw Object.assign(new Error('还没有可用的语音转写'), { code: 'AUDIO_SETUP' }); } });
  await refusing.start();
  heard.push(new Array(4000).fill(500));
  await assert.rejects(refusing.finish(), (error) => error.code === 'AUDIO_SETUP');
});

test('the recorder stops itself at the time limit and counts down meanwhile', async () => {
  let now = 0;
  const timers = [];
  const capture = fakeCapture(), left = [];
  const recorder = createVoiceRecorder({ call: async () => ({ text: '好' }), capture: capture.fn, upload: async () => 'u', maxSeconds: 3,
    now: () => now, every: (fn) => { timers.push(fn); return () => {}; }, onState: (state) => left.push(state.left), onLimit: (promise) => { recorder.limited = promise; } });
  await recorder.start();
  capture.push(new Array(1600).fill(300));
  now = 1200; timers[0]();
  now = 3100; timers[0]();
  assert.equal(await recorder.limited, '好', 'the limit finishes the clip by itself');
  assert.ok(left.includes(3) && left.includes(2), `counts down: ${left}`);
});

test('V answers by voice on a flashcard, an open question or a cloze, never on a choice, a task or in an exam; Shift+V asks by voice', () => {
  const base = { id: 'r', mode: 'path', index: 0, feedback: null, revealed: false };
  const ctx = (run, extra = {}) => ({ inside: true, modalOpen: false, page: 'review', run, busy: false, shortcutHelp: false, choice: false, isCloze: false, rubricCard: false, selected: [], clozeValues: {}, ...extra });
  const press = (run, extra = {}, shiftKey = false) => shortcutAction({ key: shiftKey ? 'V' : 'v', code: 'KeyV', shiftKey, repeat: false, defaultPrevented: false, inEditable: false }, ctx(run, extra))?.action;
  assert.deepEqual(press({ ...base, card: { id: 'c', kind: 'flashcard' } }), { type: 'voice' });
  assert.deepEqual(press({ ...base, card: { id: 'c', kind: 'open' } }), { type: 'voice' });
  assert.deepEqual(press({ ...base, card: { id: 'c', kind: 'cloze' } }, { isCloze: true }), { type: 'voice' });
  assert.equal(press({ ...base, card: { id: 'c', kind: 'quiz', options: [{ id: 'a' }] } }, { choice: true }), null);
  assert.equal(press({ ...base, card: { id: 'c', kind: 'task' } }), null);
  assert.equal(press({ ...base, mode: 'exam', card: { id: 'c', kind: 'open' } }), null);
  assert.equal(press({ ...base, card: { id: 'c', kind: 'open' }, feedback: { grade: 3 } }), null, 'an answered question takes no voice answer');
  assert.deepEqual(press({ ...base, card: { id: 'c', kind: 'quiz', options: [{ id: 'a' }] } }, { choice: true }, true), { type: 'voice-ask' }, 'asking works on any question');
  assert.equal(press({ ...base, mode: 'exam', card: { id: 'c', kind: 'open' } }, {}, true), null);
});

test('the autopilot moves on from a question whose AI grade is on its way, as it does after a pass', () => {
  const plan = (extra) => autopilotPlan({ autopilot: true, page: 'review', passed: false, complete: false, teaching: false, skippedKey: '', advanceKey: 'r:0:0', ...extra });
  assert.equal(plan({}).schedule, false);
  assert.equal(plan({ grading: true }).schedule, true);
  assert.equal(plan({ grading: true, skippedKey: 'r:0:0' }).schedule, false, 'stopped by the learner stays stopped');
  assert.equal(autopilotPlan({ autopilot: false, page: 'review', grading: true, advanceKey: 'k' }).schedule, false);
});

test('the poll brings 正在批改 and 待看订正 to the question on screen, and takes them away again', () => {
  const current = { id: 'r', index: 0, queueVersion: 0, revealed: false, feedback: null, card: { id: 'c' } };
  const marked = mergeReviewPoll(current, { ...current, grading: true });
  assert.equal(marked.grading, true, 'the grade job started: the question shows it is being graded');
  assert.equal(mergeReviewPoll(marked, { ...current }).grading, undefined, 'the job failed: the marker is gone');
  const waiting = mergeReviewPoll(current, { ...current, correctionsPending: 1 });
  assert.equal(waiting.correctionsPending, 1, 'a miss graded after the learner left counts in the header');
  assert.equal(mergeReviewPoll(current, { ...current }), current, 'nothing changed: the same object, no re-render');
});

test('a finished round with a grade still running or a correction unread holds its result page: the autopilot waits and the page keeps asking', () => {
  const done = { complete: true, mode: 'path', navigation: [{ index: 0, answered: true, passed: true }] };
  assert.equal(gradesOutstanding(done), false, 'nothing waits: the autopilot may carry on');
  assert.equal(gradesOutstanding({ ...done, navigation: [{ index: 0, answered: true, grading: true }] }), true, 'a grade is still on its way');
  assert.equal(gradesOutstanding({ ...done, correctionsPending: 1 }), true, 'a correction waits to be read');
  assert.equal(gradesOutstanding({ ...done, mode: 'exam', correctionsPending: 1 }), false, 'an exam has no 待看订正');
  assert.equal(gradesOutstanding(null), false);
});
