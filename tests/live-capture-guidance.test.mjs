import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 课堂实录 · 标签页 / 系统声音: a refusal of getDisplayMedia is told apart by what the code can actually observe (the frame's permissions
   policy, the browser's own message, how fast the refusal came, whether the page is embedded) and each case gets a true sentence.
   Measured in Chromium 2026-10-07 (scripts/qa-style probe, http://localhost): top-level, picker open -> still pending after 6 s;
   cross-origin <iframe> without allow="display-capture" -> NotAllowedError in 0-1 ms, document.permissionsPolicy.allowsFeature('display-capture') === false,
   message 'Access to the feature "display-capture" is disallowed by permissions policy.'; the same iframe with allow="display-capture" -> picker. */
const m = await loadUi(`
  export { classifyTabRefusal, tabSharingAllowed, describeCaptureError, captureAudio, INSTANT_REFUSAL_MS } from './ui/live-audio.js';
  export { SourceHint } from './ui/LiveClass.jsx';
  export { setUiLanguage, uiMessage } from './ui/i18n.js';`);
const h = React.createElement;
const HAN = /[㐀-鿿]/;
const named = (name, message = 'x') => Object.assign(new Error(message), { name });
const inLanguage = (language, run) => { try { m.setUiLanguage(language); return run(); } finally { m.setUiLanguage('zh'); } };

test('the classifier tells apart a frame that may not share, an instant refusal and a dismissed picker', () => {
  const classify = (context, error = named('NotAllowedError', 'Permission denied')) => m.classifyTabRefusal({ error, ...context });
  assert.equal(classify({ elapsedMs: 4000, policyAllowed: false, embedded: true }), 'blocked', 'the policy denies display-capture: certain, however long it took');
  assert.equal(classify({ elapsedMs: 4000, policyAllowed: true, embedded: false }, named('NotAllowedError', 'Access to the feature "display-capture" is disallowed by permissions policy.')), 'blocked',
    "the browser's own message is a second witness of the policy");
  assert.equal(classify({ elapsedMs: 1, policyAllowed: null, embedded: true }), 'embedded-instant', 'refused at once inside a frame, policy unreadable');
  assert.equal(classify({ elapsedMs: 1, policyAllowed: true, embedded: true }), 'embedded-instant');
  assert.equal(classify({ elapsedMs: 1, policyAllowed: true, embedded: false }), 'instant', 'refused at once at top level: no picker was shown either');
  assert.equal(classify({ elapsedMs: m.INSTANT_REFUSAL_MS - 1, policyAllowed: true, embedded: false }), 'instant');
  assert.equal(classify({ elapsedMs: m.INSTANT_REFUSAL_MS, policyAllowed: true, embedded: false }), 'cancelled', 'a human-scale delay: the picker was shown and dismissed');
  assert.equal(classify({ elapsedMs: 5200, policyAllowed: true, embedded: true }), 'cancelled', 'embedded but slow: the picker was used, so not the frame');
  assert.equal(classify({ elapsedMs: 5200, policyAllowed: null, embedded: false }), 'cancelled');
  assert.equal(classify({}), 'unknown', 'without a measurement nothing is claimed');
  assert.equal(classify({ elapsedMs: 1, policyAllowed: false }, named('NotFoundError')), null, 'only a NotAllowedError is a refusal');
});

test('tabSharingAllowed reads the permissions policy and says null when the browser cannot tell', () => {
  assert.equal(m.tabSharingAllowed({ permissionsPolicy: { allowsFeature: (name) => name !== 'display-capture' } }), false);
  assert.equal(m.tabSharingAllowed({ permissionsPolicy: { allowsFeature: (name) => name === 'display-capture' } }), true);
  assert.equal(m.tabSharingAllowed({ featurePolicy: { allowsFeature: () => false } }), false, 'older Chromium: featurePolicy');
  assert.equal(m.tabSharingAllowed({}), null);
  assert.equal(m.tabSharingAllowed(undefined), null, 'no document (server render, worker)');
  assert.equal(m.tabSharingAllowed({ permissionsPolicy: { allowsFeature: () => { throw new Error('x'); } } }), null);
});

test('each refusal gets its own true sentence, and none repeats the instruction the learner just followed', () => {
  const say = (context) => m.describeCaptureError(named('NotAllowedError'), 'tab', context);
  const blocked = say({ elapsedMs: 0, policyAllowed: false, embedded: true });
  assert.equal(blocked.tabRefusal, 'blocked');
  assert.equal(blocked.name, 'NotAllowedError');
  assert.match(blocked.message, /不允许共享标签页/);
  assert.match(blocked.message, /再点「开始实录」也没有用/);
  assert.match(blocked.message, /麦克风/);
  assert.match(blocked.message, /独立的浏览器窗口/);
  assert.match(blocked.message, /音频转写/);
  assert.doesNotMatch(blocked.message, /勾选「共享标签页音频」/, 'the policy case must not send the learner back to a picker that never opens');
  const probable = say({ elapsedMs: 2, policyAllowed: null, embedded: true });
  assert.equal(probable.tabRefusal, 'embedded-instant');
  assert.match(probable.message, /很可能不允许共享标签页/, 'the cause is only probable, and the sentence says so');
  assert.match(probable.message, /麦克风/);
  const instant = say({ elapsedMs: 2, policyAllowed: true, embedded: false });
  assert.equal(instant.tabRefusal, 'instant');
  assert.match(instant.message, /没有弹出选择窗口/);
  assert.doesNotMatch(instant.message, /嵌在别的页面/, 'top level: never claims an embedding');
  const cancelled = say({ elapsedMs: 6000, policyAllowed: true, embedded: false });
  assert.equal(cancelled.tabRefusal, 'cancelled');
  assert.equal(cancelled.message, '已取消共享。要录课，请再点一次「开始实录」，在弹出的窗口里选标签页并勾选「共享标签页音频」。');
  assert.ok(cancelled.message.length < 60, 'short');
  const unknown = m.describeCaptureError(named('NotAllowedError'), 'tab');
  assert.equal(unknown.tabRefusal, 'unknown');
  assert.doesNotMatch(unknown.message, /已取消|很可能/);
  assert.match(m.describeCaptureError(named('NotAllowedError'), 'microphone', { elapsedMs: 0, policyAllowed: false, embedded: true }).message, /没有允许使用麦克风/, 'the microphone keeps its own sentence');
  assert.match(m.describeCaptureError(named('NotSupportedError'), 'tab').message, /Chrome 或 Edge/);
  assert.match(m.describeCaptureError(named('TypeError'), 'tab').message, /HTTPS 或 localhost/);
});

test('English: every refusal sentence is translated and none loses its remedy', () => {
  inLanguage('en', () => {
    const say = (context) => m.uiMessage(m.describeCaptureError(named('NotAllowedError'), 'tab', context).message);
    const all = { blocked: say({ elapsedMs: 0, policyAllowed: false, embedded: true }), probable: say({ elapsedMs: 0, policyAllowed: null, embedded: true }),
      instant: say({ elapsedMs: 0, policyAllowed: true, embedded: false }), cancelled: say({ elapsedMs: 6000, policyAllowed: true, embedded: false }), unknown: say({}) };
    for (const [name, text] of Object.entries(all)) assert.doesNotMatch(text, HAN, name);
    assert.match(all.blocked, /not allowed to share a tab/);
    assert.match(all.blocked, /microphone/);
    assert.match(all.blocked, /separate browser window/);
    assert.match(all.blocked, /Audio transcription/);
    assert.match(all.probable, /probably not allowed to share a tab/);
    assert.match(all.instant, /without showing the picker/);
    assert.match(all.cancelled, /^Sharing was cancelled\./);
    assert.match(all.cancelled, /Share tab audio/);
  });
});

/** navigator.mediaDevices stand-in: getDisplayMedia fails the way the test says, after the clock moves by `after` ms. */
function fakeBrowser({ reject, after = 0, tracks } = {}) {
  const clock = { t: 1000 };
  const env = { now: () => clock.t, tabAllowed: () => env.policy, embedded: () => env.frame, policy: true, frame: false };
  const mediaDevices = {
    getDisplayMedia: async () => { clock.t += after; if (reject) throw reject; return { getTracks: () => tracks, getAudioTracks: () => tracks.filter(track => track.kind === 'audio') }; },
    getUserMedia: async () => { throw named('NotAllowedError'); },
  };
  return { env, mediaDevices };
}
async function withBrowser(fake, run) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), savedContext = globalThis.AudioContext;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: fake.mediaDevices } });
    globalThis.AudioContext = function AudioContext() {};
    return await run();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
    if (savedContext) globalThis.AudioContext = savedContext; else delete globalThis.AudioContext;
  }
}
const noop = () => {};

test('captureAudio measures the refusal itself: policy, embedding and the time from click to rejection', async () => {
  const run = async (fake) => withBrowser(fake, () => m.captureAudio('tab', noop, noop, noop, fake.env).then(() => assert.fail('should reject'), (error) => error));
  const policy = fakeBrowser({ reject: named('NotAllowedError', 'Permission denied'), after: 0 });
  Object.assign(policy.env, { policy: false, frame: true });
  assert.equal((await run(policy)).tabRefusal, 'blocked');
  const quickFrame = fakeBrowser({ reject: named('NotAllowedError', 'Permission denied'), after: 2 });
  Object.assign(quickFrame.env, { policy: null, frame: true });
  assert.equal((await run(quickFrame)).tabRefusal, 'embedded-instant');
  const quickTop = fakeBrowser({ reject: named('NotAllowedError', 'Permission denied'), after: 2 });
  assert.equal((await run(quickTop)).tabRefusal, 'instant');
  const slow = fakeBrowser({ reject: named('NotAllowedError', 'Permission denied'), after: 7000 });
  Object.assign(slow.env, { policy: true, frame: true });
  const cancelled = await run(slow);
  assert.equal(cancelled.tabRefusal, 'cancelled');
  assert.equal(cancelled.name, 'NotAllowedError');
  assert.equal(cancelled.cause.message, 'Permission denied', 'the original error stays reachable');
  const notFound = await run(fakeBrowser({ reject: named('NotFoundError') }));
  assert.match(notFound.message, /所选内容里没有声音/);
});

test('captureAudio still asks the browser when the policy check says no (the check can be wrong)', async () => {
  const fake = fakeBrowser({ reject: named('NotAllowedError'), after: 0 });
  let asked = 0;
  const ask = fake.mediaDevices.getDisplayMedia;
  fake.mediaDevices.getDisplayMedia = (...args) => { asked += 1; return ask(...args); };
  fake.env.policy = false;
  await withBrowser(fake, () => m.captureAudio('tab', noop, noop, noop, fake.env).catch(noop));
  assert.equal(asked, 1);
});

test('a picker used without the audio checkbox says what Chrome and Edge share, and where the checkbox is', async () => {
  const stopped = [];
  const video = { kind: 'video', stop: () => stopped.push('video'), addEventListener: noop, removeEventListener: noop };
  const fake = fakeBrowser({ tracks: [video], after: 4000 });
  const error = await withBrowser(fake, () => m.captureAudio('tab', noop, noop, noop, fake.env).then(() => assert.fail('should reject'), (failure) => failure));
  assert.match(error.message, /^没有共享声音/);
  assert.match(error.message, /只有在共享「标签页」时才带声音/);
  assert.match(error.message, /共享窗口没有/);
  assert.match(error.message, /左下角/);
  assert.match(error.message, /共享标签页音频/);
  assert.deepEqual(stopped, ['video'], 'the shared video is released');
  inLanguage('en', () => {
    const english = m.uiMessage(error.message);
    assert.doesNotMatch(english, HAN);
    assert.match(english, /only when you share a tab/i);
    assert.match(english, /bottom-left/);
  });
});

test('without the media API the message is the unsupported-browser one, as before', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await assert.rejects(m.captureAudio('tab', noop, noop, noop, {}), /Chrome 或 Edge/);
  } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; }
});

const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
const hint = (props, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(h(m.SourceHint, props)));

test('the source hint: a quiet note before the click when this frame may not share, the usual hint otherwise', () => {
  const blocked = hint({ kind: 'tab', tabAllowed: false, onUseMicrophone: noop });
  assert.match(blocked, /data-tab-sharing="blocked"/);
  assert.match(blocked, /^<p class="muted/, 'a muted line, not a banner');
  assert.doesNotMatch(blocked, /role="alert"|sh-inline-message|banner/i);
  assert.match(text(blocked), /不允许共享标签页/);
  assert.match(text(blocked), /改用麦克风/);
  assert.doesNotMatch(text(blocked), /勾选「共享标签页音频」/, 'the usual instruction would be a lie here');
  for (const tabAllowed of [true, null, undefined]) {
    const usual = hint({ kind: 'tab', tabAllowed, onUseMicrophone: noop });
    assert.match(text(usual), /勾选「共享标签页音频」/);
    assert.doesNotMatch(usual, /data-tab-sharing/);
  }
  assert.equal(hint({ kind: 'microphone', tabAllowed: false, onUseMicrophone: noop }), '', 'only the tab source has a hint');
  assert.doesNotMatch(hint({ kind: 'tab', tabAllowed: false }), /<button/, 'no button without a handler');
  const english = text(hint({ kind: 'tab', tabAllowed: false, onUseMicrophone: noop }, 'en'));
  assert.doesNotMatch(english, HAN);
  assert.match(english, /not allowed to share a tab/);
  assert.match(english, /Use the microphone instead/);
  assert.doesNotMatch(text(hint({ kind: 'tab', tabAllowed: true }, 'en')), HAN);
});
