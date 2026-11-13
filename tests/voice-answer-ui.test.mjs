import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSpokenBlanks, clozeBlankIds } from '../ui/voice/cloze-split.js';
import { suggestedGrade } from '../ui/voice/suggest-grade.js';
import { createVoiceRecorder } from '../ui/voice/mic.js';
import { autopilotPlan, gradeRunning, gradesOutstanding, shortcutAction } from '../ui/review/session-logic.js';
import { mergeReviewPoll, voiceScopeKey } from '../ui/async.js';

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

test('a transcript that comes back after the learner moved to another question is dropped, not put into the new one', async () => {
  let where = 'q1';
  const calls = [];
  const capture = fakeCapture();
  const recorder = createVoiceRecorder({ capture: capture.fn, upload: async () => 'u-moved', scope: () => where,
    call: async (action, args) => { calls.push(action); where = 'q2'; return { text: '幂等' }; } });
  await recorder.start();
  capture.push(new Array(4000).fill(700));
  await assert.rejects(recorder.finish(), (error) => error.code === 'VOICE_MOVED' && /换了题/.test(error.message));
  assert.deepEqual(calls, ['audio.clip.transcribe'], 'the clip was still transcribed once, so the server deleted it');
  assert.equal(recorder.phase, 'idle');
  // Without a scope (a page with one box) nothing is dropped.
  const plain = fakeCapture();
  const free = createVoiceRecorder({ capture: plain.fn, upload: async () => 'u-plain', call: async () => ({ text: '好' }) });
  await free.start();
  plain.push(new Array(4000).fill(700));
  assert.equal(await free.finish(), '好');
});

test('cancel while the clip is uploading deletes the uploaded clip instead of leaving it for a day', async () => {
  const calls = [];
  const capture = fakeCapture();
  let recorder;
  recorder = createVoiceRecorder({ capture: capture.fn, call: async (action, args) => { calls.push([action, args]); return {}; },
    upload: async () => { await recorder.cancel(); return 'u-late'; } });
  await recorder.start();
  capture.push(new Array(4000).fill(700));
  await assert.rejects(recorder.finish());
  assert.deepEqual(calls, [['audio.upload.cancel', { uploadId: 'u-late' }]], 'cancelled on the server, never transcribed');
});

test('a finished round asks the host again only while a grade is running; an unread correction alone waits for the window to come back', () => {
  const done = { complete: true, mode: 'path', navigation: [{ index: 0, answered: true }] };
  assert.equal(gradeRunning({ ...done, navigation: [{ index: 0, answered: true, grading: true }] }), true);
  assert.equal(gradeRunning({ ...done, correctionsPending: 1 }), false, 'nothing will change on the host by itself');
  assert.equal(gradeRunning({ ...done, mode: 'exam', navigation: [{ index: 0, grading: true }] }), false);
  assert.equal(gradeRunning(null), false);
});

test('本轮题目 with a question still being graded: it is listed by default, blocks 全部过关, and opens as 批改中 without a verdict (an option card too)', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const ui = await loadUi(`
    export { default as RoundLookBack } from './ui/review/RoundLookBack.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setQueryData } from './ui/host-query.js';`);
  const noop = () => {};
  const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const options = [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }, { id: 'c', text: 'Gamma' }];
  const rows = [
    // What review.lookBack gives for a question being graded: the question alone.
    { number: 1, entryIndex: 0, deckId: 'd', cardId: 'o1', kind: 'open', status: 'grading', prompt: 'Explain idempotency' },
    // A row in the answered shape with no feedback yet (a read cached before the fix): it must not crash on the missing feedback.
    { number: 2, entryIndex: 1, deckId: 'd', cardId: 'q1', kind: 'quiz', status: 'grading', card: { id: 'q1', kind: 'quiz', prompt: 'Pick one', options }, feedback: null,
      solution: { options: [{ id: 'a', correct: true }], followups: [] } },
    { number: 3, entryIndex: 2, deckId: 'd', cardId: 'o2', kind: 'open', status: 'right', card: { id: 'o2', kind: 'open', prompt: 'Explain retries' },
      feedback: { grade: 4 }, solution: { answer: 'ref', followups: [] } },
    // Any answered-shape row without feedback draws its options without crashing (the look-back's own guard).
    { number: 4, entryIndex: 3, deckId: 'd', cardId: 'q2', kind: 'quiz', status: 'unanswered', card: { id: 'q2', kind: 'quiz', prompt: 'Pick again', options }, feedback: null,
      solution: { options: [{ id: 'b', correct: true }], followups: [] } },
  ];
  const run = { id: 'r-look', mode: 'practice', navigation: [{ grading: true }, { grading: true }, {}, {}], correctionsPending: 0 };
  const render = (openAll) => {
    ui.setQueryData('review.lookBack', { runId: run.id }, { rows });
    const realUseState = React.useState;
    if (openAll) React.useState = (init) => (typeof init === 'function' && init() instanceof Set ? realUseState(() => new Set([1, 2, 3, 4])) : realUseState(init));
    try {
      return renderToStaticMarkup(React.createElement(ui.StudyServicesContext.Provider, { value: services }, React.createElement(ui.RoundLookBack, { run })));
    } finally { React.useState = realUseState; }
  };
  const closed = render(false);
  assert.doesNotMatch(closed, /全部过关/, 'a grade on its way is not a pass yet');
  assert.match(closed, /批改中 2/);
  assert.match(closed, /Explain idempotency/, 'the graded question is listed by default');
  assert.match(closed, /Pick one/);
  assert.doesNotMatch(closed, /Explain retries/, 'the passed one waits behind 显示全部');
  const open = render(true);
  assert.match(open, /Explain idempotency/);
  assert.match(open, /正在批改，分数出来后这里会显示答案和讲解/);
  assert.doesNotMatch(open, /这道题这一轮没有作答/, 'it was answered');
  const panel = (number) => open.split(`id="look-back-r-look-${number}"`)[1].split('</li>')[0];
  for (const number of [1, 2]) assert.doesNotMatch(panel(number), /option-letter|answer-state|参考答案/, 'no verdict and no key while it is graded');
  assert.match(panel(4), /正确答案/, 'the guarded row still draws its options');
});

test('the voice pre-check asks with 只用付费密钥 from the audio settings, and a forgotten answer is asked again', async () => {
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const { forgetVoiceReadiness, voiceReadiness } = await loadUi(`export { forgetVoiceReadiness, voiceReadiness } from './ui/voice/useVoiceInput.js';`);
  const asked = [];
  let paidOnlyByDefault = true;
  const call = async (action, args) => {
    asked.push([action, args]);
    if (action === 'audio.settings.get') return { paidOnlyByDefault };
    if (action === 'audio.preflight') return args.paidOnly ? { transcription: false, reason: 'paid-missing' } : { transcription: true, reason: null };
    throw new Error(action);
  };
  forgetVoiceReadiness();
  assert.deepEqual(await voiceReadiness(call), { ready: false, reason: 'paid-missing' }, 'only a free key with 只用付费密钥 on is not ready');
  assert.deepEqual(asked.find(([action]) => action === 'audio.preflight')[1], { paidOnly: true });
  paidOnlyByDefault = false;
  asked.length = 0;
  await voiceReadiness(call);
  assert.equal(asked.length, 0, 'asked once per page');
  forgetVoiceReadiness();
  assert.deepEqual(await voiceReadiness(call), { ready: true, reason: 'no-provider' });
  assert.deepEqual(asked.find(([action]) => action === 'audio.preflight')[1], {});
  forgetVoiceReadiness();
});

test('the voice scope is the question on screen: a queue edit or a content resync keeps it, another question or its retry does not', () => {
  const run = { id: 'r1', index: 2, card: { id: 'c3' }, queueVersion: 4, revision: 1, retry: false };
  const key = voiceScopeKey(run);
  assert.ok(key);
  assert.equal(voiceScopeKey({ ...run, queueVersion: 5 }), key, 'review.queue.edit from the main chat');
  assert.equal(voiceScopeKey({ ...run, revision: 2 }), key, 'the review.get resync');
  for (const other of [{ ...run, index: 3 }, { ...run, card: { id: 'c4' } }, { ...run, id: 'r2' }, { ...run, retry: true }]) assert.notEqual(voiceScopeKey(other), key);
  assert.equal(voiceScopeKey({ id: 'r1', complete: true }), '');
});

test('moving to another question while recording stops the microphone at once, sends nothing and says why', async () => {
  const { build } = await import('esbuild');
  // The hook's own code against a stand-in for react's hooks, with a fake microphone and upload (no DOM, no browser).
  const reactStandIn = `
    let slots = [], index = 0, pending = [];
    export const __begin = () => { index = 0; pending = []; };
    export const __flush = () => { for (const run of pending) run(); };
    export const useState = (initial) => { const slot = index++; slots[slot] ??= { value: initial };
      return [slots[slot].value, (value) => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; }]; };
    export const useRef = (initial) => { const slot = index++; return slots[slot] ??= { current: initial }; };
    export const useCallback = (fn) => { index++; return fn; };
    export const useSyncExternalStore = (subscribe, get) => get();
    export const useEffect = (effect, deps) => {
      const slot = index++, before = slots[slot];
      if (before && deps.every((dep, i) => Object.is(dep, before.deps[i]))) return;
      pending.push(() => { before?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; });
    };`;
  const fakes = {
    react: reactStandIn,
    'live-audio': `export const captureAudio = (...args) => globalThis.__voiceFake.capture(...args);`,
    upload: `export const uploadInChunks = (...args) => globalThis.__voiceFake.upload(...args);`,
  };
  const compiled = await build({ stdin: { contents: "export { useVoiceInput, forgetVoiceReadiness } from './ui/voice/useVoiceInput.js'; export { __begin, __flush } from 'react';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.json': 'json' },
    plugins: [{ name: 'stand-ins', setup(b) {
      b.onResolve({ filter: /^react$|\/live-audio\.js$|\/upload\.js$/ }, (args) => ({ path: args.path === 'react' ? 'react' : args.path.includes('live-audio') ? 'live-audio' : 'upload', namespace: 'stand-in' }));
      b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({ contents: fakes[args.path], loader: 'js' }));
    } }] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(module, module.exports, (await import('node:module')).createRequire(import.meta.url));
  const { useVoiceInput, forgetVoiceReadiness, __begin, __flush } = module.exports;
  const capture = fakeCapture(), calls = [];
  globalThis.__voiceFake = { capture: capture.fn, upload: async () => { calls.push('upload'); return 'u-1'; } };
  let hook = null;
  try {
    const call = async (action) => {
      calls.push(action);
      if (action === 'audio.settings.get') return {};
      if (action === 'audio.preflight') return { transcription: true };
      return {};
    };
    const render = (scope) => { __begin(); const hook = useVoiceInput({ call, scope, onText: () => assert.fail('no text') }); __flush(); return hook; };
    forgetVoiceReadiness();
    hook = render('q1');
    await hook.start();
    capture.push(new Array(8000).fill(1000));
    hook = render('q1');
    assert.equal(hook.phase, 'recording');
    hook = render('q2');
    await new Promise((resolve) => setImmediate(resolve));
    hook = render('q2');
    assert.ok(capture.stopped, 'the microphone is released at once');
    assert.equal(hook.phase, 'idle');
    assert.match(hook.error, /换了题/);
    assert.equal(calls.filter((action) => action === 'upload' || action === 'audio.clip.transcribe').length, 0, 'nothing is sent');
  } finally { hook?.cancel(); delete globalThis.__voiceFake; forgetVoiceReadiness(); }
});

test('the voice button is a microphone, and a stop mark while it records (the same Phosphor Light registry as every icon)', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const { ICON_PATHS } = await import('../ui/components/icon-paths.js');
  const { VoiceButton } = await loadUi(`export { default as VoiceButton } from './ui/voice/VoiceButton.jsx';`);
  const voice = (extra) => ({ phase: 'idle', left: 90, error: '', setup: null, unavailable: false, toggle() {}, cancel() {}, clearError() {}, closeSetup() {}, recheck() {}, ...extra });
  const idle = renderToStaticMarkup(React.createElement(VoiceButton, { voice: voice({}) }));
  assert.ok(idle.includes(ICON_PATHS.microphone), 'idle: the microphone');
  assert.ok(!idle.includes(ICON_PATHS.audio), 'not the music note');
  const recording = renderToStaticMarkup(React.createElement(VoiceButton, { voice: voice({ phase: 'recording', left: 75 }) }));
  assert.ok(recording.includes(ICON_PATHS.stop), 'recording: the stop mark, the button now ends the recording');
  assert.ok(!recording.includes(ICON_PATHS.microphone));
});

test('a rewrite that every criterion repeats is shown once after the criteria; different rewrites stay with their criterion', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const { RubricResult } = await loadUi(`export { RubricResult } from './ui/CaseResult.jsx';`);
  const rubric = (suggestions) => ({ total: 0, max: 4, band: 'weak', summary: '', criteria: suggestions.map((suggestion, index) =>
    ({ id: `c${index}`, label: `Criterion ${index}`, score: 0, max: 2, ratio: 0, ...(suggestion ? { suggestion } : {}) })) });
  const count = (html) => (html.match(/可以这样改写/g) || []).length;
  const same = renderToStaticMarkup(React.createElement(RubricResult, { rubric: rubric(['Connect the terms.', 'Connect the terms.']) }));
  assert.equal(count(same), 1, 'one rewrite, not one per criterion');
  assert.equal((same.match(/Connect the terms\./g) || []).length, 1);
  assert.ok(same.indexOf('可以这样改写') > same.lastIndexOf('rubric-row'), 'it comes after the last criterion');
  const different = renderToStaticMarkup(React.createElement(RubricResult, { rubric: rubric(['Say A.', 'Say B.']) }));
  assert.equal(count(different), 2, 'different rewrites stay with their criteria');
  const single = renderToStaticMarkup(React.createElement(RubricResult, { rubric: rubric(['Only one.']) }));
  assert.equal(count(single), 1, 'one criterion keeps its own');
  assert.ok(single.indexOf('可以这样改写') < single.lastIndexOf('</li>'), 'a lone criterion keeps its rewrite inside its row');
  const partial = renderToStaticMarkup(React.createElement(RubricResult, { rubric: rubric(['Same.', 'Same.', '']) }));
  assert.equal(count(partial), 2, 'a criterion without a rewrite means they are not all the same: each keeps its own');
});

test('下一题 is open while the AI grade of the answer is on its way, with no "answer first" nag', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const ui = await loadUi(`
    export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';`);
  const noop = () => {};
  const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const render = (run) => renderToStaticMarkup(React.createElement(ui.StudyServicesContext.Provider, { value: services },
    React.createElement(ui.ReviewToolbar, { run: { mode: 'path', index: 0, feedback: null, card: { id: 'c' }, navigation: [{}, {}], ...run }, onReviewAction: noop, onSkip: noop })));
  const next = (html) => html.match(/<button[^>]*data-usage="review.next"[^>]*>/)[0];
  assert.match(next(render({})), /disabled/, 'nothing answered yet: it waits');
  assert.match(render({}), /请先作答/);
  const grading = render({ grading: true });
  assert.doesNotMatch(next(grading), /disabled/, 'the answer is in and being graded: the learner may go on');
  assert.doesNotMatch(grading, /请先作答/);
});

test('one family of voice labels: 语音作答 / Answer by voice in practice and the oral mock, 语音提问 / Ask by voice beside the 帮我弄懂 box (#1031)', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const en = JSON.parse(await read('ui/locales/en.voice-review.json'));
  assert.equal(en['语音作答'], 'Answer by voice');
  assert.equal(en['语音提问'], 'Ask by voice');
  for (const gone of ['语音口述', '说出你的疑问']) assert.equal(gone in en, false, `${gone} is not a third name for the same button`);
  const sources = (await Promise.all(['ui/OralExam.jsx', 'ui/review/VoiceAnswer.jsx', 'ui/ShortcutHelp.jsx', 'ui/finder/entries.js'].map(read))).join(' ');
  assert.doesNotMatch(sources, /语音口述|说出你的疑问/);
  assert.match(await read('ui/review/VoiceAnswer.jsx'), /label="语音提问"/);
  assert.match(await read('ui/OralExam.jsx'), /<VoiceButton voice=\{answerVoice\} \/>/);
  for (const [zh, english] of Object.entries(en)) if (/语音作答|语音提问/.test(zh) && zh.length > 8) assert.match(english, /Answer by voice|Ask by voice/, `the English of "${zh.slice(0, 20)}…" uses the same names`);
});
