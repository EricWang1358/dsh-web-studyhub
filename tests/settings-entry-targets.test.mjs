import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* A link that says "audio settings" (or the model, the search extension, the PDF converter) opens Settings AT that section, never at the top.
   The mechanism is the existing one: the audio section is asked for with requestAudioSettingsFocus() just before navigating (ui/audio-focus.js);
   every other section is named to openSettings(anchor) (ui/app/use-settings-entry.js). Owner report 2026-10-07: the 课堂实录 header's 音频设置
   opened Settings at its first page instead. */
const m = await loadUi(`
  export { openAudioSettings, audioFocusPending, takeAudioSettingsFocus } from './ui/audio-focus.js';
  export { settingsSectionOr, categoryForAnchor } from './ui/settings-groups.js';`);

test('openAudioSettings asks for the audio section before it navigates, and is nothing without a way to navigate', () => {
  m.takeAudioSettingsFocus();
  const seen = [];
  const open = m.openAudioSettings(() => seen.push(m.audioFocusPending()));
  assert.equal(m.audioFocusPending(), false, 'nothing is requested until the click');
  open();
  assert.deepEqual(seen, [true], 'the request is already pending when Settings is opened');
  assert.equal(m.takeAudioSettingsFocus(), true);
  assert.equal(m.openAudioSettings(undefined), undefined);
});

test('settingsSectionOr keeps a known section and turns a click event or an unknown id into the fallback', () => {
  assert.equal(m.settingsSectionOr('settings-marker', 'settings-extensions'), 'settings-marker');
  assert.equal(m.settingsSectionOr('settings-mineru', 'settings-extensions'), 'settings-mineru');
  assert.equal(m.settingsSectionOr({ type: 'click' }, 'settings-extensions'), 'settings-extensions');
  assert.equal(m.settingsSectionOr(undefined, 'settings-extensions'), 'settings-extensions');
  assert.equal(m.settingsSectionOr('settings-nowhere', 'settings-extensions'), 'settings-extensions');
  for (const anchor of ['settings-audio', 'settings-model', 'settings-extensions', 'settings-marker', 'settings-generation-time'])
    assert.ok(m.categoryForAnchor(anchor), `${anchor} is an anchor of the registry`);
});

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('the other links to a configuration name their section (what was checked and changed)', async () => {
  const generate = await read('ui/Generate.jsx');
  assert.match(generate, /onOpenSettings=\{openLargeDocumentSettings\}/, 'Generate: the long-document card opens the extension / converter section');
  assert.match(generate, /openSettingsSection\(settingsSectionOr\(section, 'settings-extensions'\)\)/);
  assert.doesNotMatch(generate, /onOpenSettings=\{\(\) => setPage/, 'Generate: no bare jump to the top of 设置');
  const review = await read('ui/Review.jsx') + await read('ui/review/QuestionRun.jsx');
  assert.match(review, /onSetupModel=\{onModelSettings \|\| \(\(\) => openSettings\("settings-model"\)\)\}/, 'Review: the rubric answer opens the model section');
  assert.doesNotMatch(review, /navigate\("settings"\)/, 'Review: no bare navigate to 设置');
  const live = await read('ui/LiveClass.jsx');
  assert.doesNotMatch(live, /onClick=\{onSettings\}/, 'LiveClass: no button calls onSettings without asking for the audio section');
  const views = await read('ui/app/page-views.jsx');
  assert.match(views, /<AudioHeader onSettings=\{openAudioSettings\(/, 'the audio page header asks for the audio section');
  assert.doesNotMatch(views, /<AudioHeader onSettings=\{\(\) =>/);
});

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import LiveClass from './ui/LiveClass.jsx';
  import { AudioView } from './ui/app/page-views.jsx';
  import { AppContext } from './ui/app/app-context.js';
  import { audioFocusPending, takeAudioSettingsFocus } from './ui/audio-focus.js';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  window.opened = [];
  const opened = (where) => () => { window.opened.push({ where, focusPending: audioFocusPending() }); takeAudioSettingsFocus(); };
  const data = { root: 'r', decks: [], jobs: [], sources: [], focus: { course: '', courses: [] } };
  window.mountLive = (live) => createRoot(document.getElementById('root')).render(
    <LiveClass call={() => new Promise(() => {})} data={data} visible onSettings={opened('live')} initialReadiness={{ live }} />);
  window.mountAudio = () => createRoot(document.getElementById('root')).render(
    <AppContext.Provider value={{ data, host: {}, nav: { navigate: (page) => opened('audio:' + page)(), show: { page: () => {} } }, lib: {}, set: {}, learn: {}, sources: {} }}>
      <AudioView />
    </AppContext.Provider>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

test('in a real browser: 音频设置 on the live class and on the audio page asks for the audio section first', { timeout: 120000 }, async (t) => {
  let browser;
  t.after(async () => { await browser?.close(); });
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return;
  }
  const open = async (mount) => {
    const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://settings-entry.test/' ? route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' }) : route.abort());
    await page.goto('http://settings-entry.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(mount);
    return { page, errors };
  };
  const live = await open('window.mountLive(true)');
  await live.page.getByRole('button', { name: '音频设置', exact: true }).click();
  assert.deepEqual(await live.page.evaluate('window.opened'), [{ where: 'live', focusPending: true }], 'live class header');
  const gated = await open('window.mountLive(false)');
  await gated.page.getByRole('button', { name: '音频设置', exact: true }).click();
  await gated.page.getByRole('button', { name: '打开音频设置', exact: true }).click();
  assert.deepEqual(await gated.page.evaluate('window.opened'), [{ where: 'live', focusPending: true }, { where: 'live', focusPending: true }], 'live class header and the key card');
  const audio = await open('window.mountAudio()');
  await audio.page.getByRole('button', { name: '音频设置', exact: true }).first().click();
  assert.deepEqual(await audio.page.evaluate('window.opened'), [{ where: 'audio:settings', focusPending: true }], 'audio page header');
  for (const { errors } of [live, gated, audio]) assert.deepEqual(errors, []);
});
