import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* 断句停顿 in the UI: the field in 音频设置 next to the live engine choice (a SegmentedControl, one Hint line, a Tooltip that never uses title=), the
   one quiet line on the live page when a fast speaker never pauses (a pure function decides), and the way from that line to the field. */

const mod = await loadUi(`export { LiveEngineChoice } from './ui/AudioSettings.jsx';
  export { LIVE_PAUSE_ANCHOR, initialPauseWatch, pauseHint } from './ui/live-pause-hint.js';
  export { audioFocusPending, audioFocusTarget, openAudioSettings, requestAudioSettingsFocus, takeAudioSettingsFocus } from './ui/audio-focus.js';
  export { categoryForAnchor } from './ui/settings-groups.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { LiveEngineChoice, LIVE_PAUSE_ANCHOR, initialPauseWatch, pauseHint } = mod;
const h = React.createElement;
const han = /[㐀-鿿]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const call = async () => ({});
const render = (view, language = 'zh') => {
  mod.setUiLanguage(language);
  try { return renderToStaticMarkup(h(LiveEngineChoice, { view, call, onSave() {}, initialLocal: null })); } finally { mod.setUiLanguage('zh'); }
};

test('the field sits with the live engine choice: label, three segments (the current one pressed), one hint, a tooltip, and the tour anchor', () => {
  const html = render({ liveProvider: 'auto', liveSentencePause: 'short' });
  const text = textOf(html);
  assert.match(html, /data-tour="settings-live-pause"/);
  assert.match(text, /断句停顿/);
  assert.match(text, /短 · 讲得快[\s\S]*标准[\s\S]*长 · 讲得慢/);
  assert.match(html, /aria-pressed="true"[^>]*>短 · 讲得快</, 'the saved value is the pressed one');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(text, /讲课很快、几乎不停顿时选『短』：停顿更短就断句，润色和出题更早能用。/);
  const visible = textOf(html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span>/g, ''));
  for (const part of [/切成两句/, /开始实录/, /接着录/]) assert.match(visible, part, 'side-effect and next-start timing stay visible in the hint');
  // After the engine cards, before the local engine's own card.
  assert.ok(html.indexOf('live-provider') < html.indexOf('settings-live-pause'));
  // The engine thresholds live in a Tooltip (role=tooltip, tied to the control with aria-describedby), never a title attribute on text.
  const tip = html.match(/role="tooltip"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(tip, 'a tooltip is in the markup');
  const tipText = textOf(tip[1]);
  for (const part of [/Gemini/, /0\.7 \/ 1\.5 \/ 2\.5 秒/, /本地/, /0\.25 \/ 0\.5 \/ 0\.8 秒/]) assert.match(tipText, part);
  assert.match(html, /aria-describedby="[^"]*"/);
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, m => (/断句|停顿/.test(m) ? 'BAD' : '')), /BAD/, 'no title= on the field');
});

test('an unset or unknown value shows standard as the pressed one', () => {
  for (const view of [{ liveProvider: 'auto' }, { liveProvider: 'auto', liveSentencePause: 'odd' }]) {
    assert.match(render(view), /aria-pressed="true"[^>]*>标准</);
  }
});

test('English shows no Chinese in the field, its hint or its tooltip', () => {
  const html = render({ liveProvider: 'auto', liveSentencePause: 'standard' }, 'en');
  const text = textOf(html);
  assert.match(html, /data-tour="settings-live-pause"/);
  assert.match(text, /Sentence pause/);
  assert.match(text, /Short · fast speaker[\s\S]*Standard[\s\S]*Long · slow speaker/);
  assert.match(text, /0\.7 \/ 1\.5 \/ 2\.5 s/);
  assert.match(text, /0\.25 \/ 0\.5 \/ 0\.8 s/);
  assert.doesNotMatch(text, han);
  assert.doesNotMatch(html, han);
});

test('the anchor belongs to the audio category, so a deep link finds it', () => {
  assert.equal(mod.categoryForAnchor('settings-live-pause'), mod.categoryForAnchor('settings-audio'));
  assert.ok(mod.categoryForAnchor('settings-live-pause'));
});

test('the audio settings request can name the field: it is pending until the section takes it, and is cleared with it', () => {
  mod.takeAudioSettingsFocus();
  const seen = [];
  mod.openAudioSettings(() => seen.push([mod.audioFocusPending(), mod.audioFocusTarget()]), LIVE_PAUSE_ANCHOR)();
  assert.deepEqual(seen, [[true, 'settings-live-pause']]);
  assert.equal(mod.takeAudioSettingsFocus(), true);
  assert.equal(mod.audioFocusTarget(), '', 'taken with the request');
  mod.openAudioSettings(() => seen.push([mod.audioFocusPending(), mod.audioFocusTarget()]))();
  assert.deepEqual(seen[1], [true, ''], 'the old call (no field) still asks for the section only');
  mod.takeAudioSettingsFocus();
});

/* ---- the live page's line ---- */

const long = 'x'.repeat(150);
const snap = (over = {}) => ({ id: 'a', active: true, count: 0, interim: long, ...over });
const step = (watch, over, now) => pauseHint(watch, snap(over), now);

test('the hint: more than 60 s of one growing line with at least 150 characters and no new sentence, and only then', () => {
  let r = step(initialPauseWatch(), {}, 1_000);
  assert.equal(r.show, false, 'just started');
  r = step(r.watch, {}, 1_000 + 60_000);
  assert.equal(r.show, false, 'exactly 60 s is not more than 60 s');
  r = step(r.watch, {}, 1_000 + 60_001);
  assert.equal(r.show, true);
  r = step(r.watch, { interim: long + ' more words' }, 1_000 + 90_000);
  assert.equal(r.show, true, 'it stays while the line grows');
});

test('the hint waits for 150 characters, and for text at all', () => {
  let r = step(initialPauseWatch(), { interim: 'x'.repeat(149) }, 0);
  r = step(r.watch, { interim: 'x'.repeat(149) }, 120_000);
  assert.equal(r.show, false, '149 characters is still below the 150-character threshold');
  r = step(r.watch, { interim: 'x'.repeat(150) }, 121_000);
  assert.equal(r.show, true, 'it shows as soon as the line reaches 150 characters');
  r = step(initialPauseWatch(), { interim: '' }, 0);
  r = step(r.watch, { interim: '' }, 300_000);
  assert.equal(r.show, false, 'silence is not a missing pause');
});

test('a new sentence hides it and starts the count again; so does another class or a class that is no longer running', () => {
  let r = step(initialPauseWatch(), {}, 0);
  r = step(r.watch, {}, 70_000);
  assert.equal(r.show, true);
  r = step(r.watch, { count: 1 }, 71_000);
  assert.equal(r.show, false, 'a sentence arrived');
  r = step(r.watch, { count: 1 }, 71_000 + 59_000);
  assert.equal(r.show, false, 'the count started again at the sentence');
  r = step(r.watch, { count: 1 }, 71_000 + 60_001);
  assert.equal(r.show, true);
  r = step(r.watch, { id: 'b', count: 1 }, 200_000);
  assert.equal(r.show, false, 'another class starts from zero');
  r = step(r.watch, { id: 'b', count: 1 }, 270_000);
  assert.equal(r.show, true);
  r = step(r.watch, { id: 'b', count: 1, active: false }, 271_000);
  assert.equal(r.show, false, 'an ended class has nothing to tell');
});

test('the same input twice gives the same answer (a render may run twice)', () => {
  const first = step(initialPauseWatch(), {}, 5_000);
  const again = step(first.watch, {}, 5_000);
  assert.deepEqual(again, first);
});

test('the live page carries the line, the link to the field, and no title= on it', async (t) => {
  let nowMs = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => nowMs);
  const interactive = await loadInteractiveUi(`
    export { default as LiveClass } from './ui/LiveClass.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { LIVE_PAUSE_ANCHOR } from './ui/live-pause-hint.js';
    export { audioFocusPending, audioFocusTarget, takeAudioSettingsFocus } from './ui/audio-focus.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const ih = interactive.React.createElement;
  await withBrowserGlobals(async () => {
    interactive.exports.setUiLanguage('zh');
    interactive.exports.takeAudioSettingsFocus();
    let settingsOpened = 0;
    const services = {
      call: async (action) => (action === 'live.list' ? { sessions: [] } : {}),
      act: async () => undefined,
      busy: false,
      notify() {},
      askInChat() {},
      host: {},
      openSettings() {},
      navigate() {},
      openModal() {},
    };
    const activeSession = {
      id: 'live-fast-1',
      status: 'live',
      title: 'Fast lecture',
      course: 'Algorithms',
      elapsedMs: 65_000,
      segments: [],
      total: 0,
      interim: 'x'.repeat(150),
    };
    const mounted = interactive.mount(() => ih(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      ih(interactive.exports.LiveClass, {
        data: { root: 'r', focus: { courses: [] } },
        visible: true,
        initialReadiness: { live: true, liveProvider: 'auto', providers: { free: true } },
        initialSession: activeSession,
        onSettings: () => { settingsOpened += 1; },
      }),
    ));
    try {
      assert.equal(
        mounted.find((n) => n.props && 'data-live-pause-hint' in n.props),
        null,
        'pause hint stays hidden before 60 s have elapsed',
      );

      nowMs += 60_001;
      mounted.rerender();

      const hint = mounted.find((n) => n.props && 'data-live-pause-hint' in n.props);
      assert.ok(hint, 'pause hint renders after >60 s of >=150 interim chars without a new sentence');
      assert.equal(hint.props.role, 'status');
      assert.match(mounted.text(hint), /讲得很快、一直没有断句？到 音频设置 › 断句停顿 选『短』，下次开始或接着录时生效。/);
      const titled = mounted.findAll((n) => typeof n.type === 'string' && n.props?.title !== undefined, hint);
      assert.deepEqual(titled, [], 'no title= attribute on the pause hint or its link');

      const btn = mounted.find((n) => n.type === 'button' && mounted.text(n).includes('打开断句停顿设置'), hint);
      assert.ok(btn, 'settings deep-link button renders inside pause hint');
      click(btn);
      assert.equal(settingsOpened, 1, 'clicking the pause hint opens audio settings');
      assert.equal(interactive.exports.audioFocusPending(), true);
      assert.equal(interactive.exports.audioFocusTarget(), interactive.exports.LIVE_PAUSE_ANCHOR);
    } finally {
      interactive.exports.takeAudioSettingsFocus();
      mounted.unmount();
    }
  });
});
