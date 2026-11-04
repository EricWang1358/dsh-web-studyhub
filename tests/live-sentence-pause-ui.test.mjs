import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 断句停顿 in the UI: the field in 音频设置 next to the live engine choice (a SegmentedControl, one Hint line, a Tooltip that never uses title=), the
   one quiet line on the live page when a fast speaker never pauses (a pure function decides), and the way from that line to the field. */

const mod = await loadUi(`export { LiveEngineChoice } from './ui/AudioSettings.jsx';
  export { LIVE_PAUSE_ANCHOR, PAUSE_HINT_CHARS, PAUSE_HINT_MS, initialPauseWatch, pauseHint } from './ui/live-pause-hint.js';
  export { audioFocusPending, audioFocusTarget, openAudioSettings, requestAudioSettingsFocus, takeAudioSettingsFocus } from './ui/audio-focus.js';
  export { categoryForAnchor } from './ui/settings-groups.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { LiveEngineChoice, LIVE_PAUSE_ANCHOR, PAUSE_HINT_CHARS, PAUSE_HINT_MS, initialPauseWatch, pauseHint } = mod;
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
  assert.equal(LIVE_PAUSE_ANCHOR, 'settings-live-pause');
  assert.match(html, /data-tour="settings-live-pause"/);
  assert.match(text, /断句停顿/);
  assert.match(text, /短 · 讲得快[\s\S]*标准[\s\S]*长 · 讲得慢/);
  assert.match(html, /aria-pressed="true"[^>]*>短 · 讲得快</, 'the saved value is the pressed one');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(text, /讲课很快、几乎不停顿时选『短』：停顿更短就断句，润色和出题更早能用。/);
  // After the engine cards, before the local engine's own card.
  assert.ok(html.indexOf('live-provider') < html.indexOf('settings-live-pause'));
  // The words behind it are a Tooltip (role=tooltip, tied to the control with aria-describedby), never a title attribute on text.
  const tip = html.match(/role="tooltip"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(tip, 'a tooltip is in the markup');
  const tipText = textOf(tip[1]);
  for (const part of [/Gemini/, /0\.7 \/ 1\.5 \/ 2\.5 秒/, /本地/, /0\.25 \/ 0\.5 \/ 0\.8 秒/, /切成两句/, /开始实录/, /接着录/]) assert.match(tipText, part);
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

const long = 'x'.repeat(PAUSE_HINT_CHARS);
const snap = (over = {}) => ({ id: 'a', active: true, count: 0, interim: long, ...over });
const step = (watch, over, now) => pauseHint(watch, snap(over), now);

test('the hint: more than 60 s of one growing line with at least 150 characters and no new sentence, and only then', () => {
  assert.equal(PAUSE_HINT_MS, 60_000);
  assert.equal(PAUSE_HINT_CHARS, 150);
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
  let r = step(initialPauseWatch(), { interim: 'short line' }, 0);
  r = step(r.watch, { interim: 'short line' }, 120_000);
  assert.equal(r.show, false, 'two minutes of a short line is not a fast speaker');
  r = step(r.watch, { interim: long }, 121_000);
  assert.equal(r.show, true, 'it shows as soon as the line is long enough');
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

test('the live page carries the line, the link to the field, and no title= on it', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../ui/LiveClass.jsx', import.meta.url), 'utf8');
  assert.match(source, /usePauseHint\(session\)/);
  assert.match(source, /openAudioSettings\(onSettings, LIVE_PAUSE_ANCHOR\)/);
  assert.match(source, /讲得很快、一直没有断句？到 音频设置 › 断句停顿 选『短』，下次开始或接着录时生效。/);
});
