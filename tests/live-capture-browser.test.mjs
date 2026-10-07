import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* The 课堂实录 page in a real browser, top level and as a cross-origin panel in an <iframe> WITHOUT allow="display-capture" (the DSH panel case):
   the quiet note is there before the click, the start button still works, and the refusal that follows is the policy sentence, not the old
   circular "pick the tab and tick the box". Measured: such a frame gets NotAllowedError in 0-1 ms, document.permissionsPolicy says false. */
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import LiveClass from './ui/LiveClass.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  const call = async (action) => { if (action === 'live.list') return { sessions: [] }; throw new Error('unexpected ' + action); };
  createRoot(document.getElementById('root')).render(<LiveClass call={call} visible initialReadiness={{ live: true }}
    data={{ root: 'r', decks: [], jobs: [], sources: [], focus: { course: '', courses: [] } }} onSettings={() => {}} />);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

test('a panel in an iframe without display-capture says so before the click and after it; a top-level page keeps the usual hint', { timeout: 120000 }, async (t) => {
  let browser;
  t.after(async () => { await browser?.close(); });
  try { browser = await launchChromium({ args: ['--use-fake-ui-for-media-stream'] }); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return;
  }
  const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === 'https://host.test/') return route.fulfill({ contentType: 'text/html', body: '<iframe id="panel" src="https://panel.test/" style="width:900px;height:900px"></iframe>' });
    if (url === 'https://panel.test/' || url === 'https://top.test/') return route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' });
    return route.abort();
  });
  const mount = async (frame) => { await frame.addScriptTag({ content: bundle.outputFiles[0].text }); await frame.getByRole('button', { name: '开始实录', exact: true }).waitFor(); };
  const chooseTab = async (frame) => { await frame.getByRole('combobox', { name: /声音来源/ }).click(); await frame.getByRole('option', { name: /标签页/ }).click(); };

  await page.goto('https://host.test/');
  const frame = await (await page.waitForSelector('#panel')).contentFrame();
  await frame.waitForLoadState();
  await mount(frame);
  assert.equal(await frame.evaluate("(document.permissionsPolicy || document.featurePolicy).allowsFeature('display-capture')"), false);
  await chooseTab(frame);
  assert.match(await frame.locator('[data-tab-sharing="blocked"]').innerText(), /这个面板不允许共享标签页/, 'the note, before any click');
  await frame.getByRole('button', { name: '开始实录', exact: true }).click();
  const banner = frame.locator('.sh-inline--error');
  await banner.waitFor();
  const said = await banner.innerText();
  assert.match(said, /这里不允许共享标签页/);
  assert.match(said, /再点「开始实录」也没有用/);
  assert.doesNotMatch(said, /勾选「共享标签页音频」/, 'no more circular guidance');
  await frame.getByRole('button', { name: '改用麦克风', exact: true }).click();
  assert.equal(await frame.locator('[data-tab-sharing]').count(), 0, 'the button switched the source to the microphone');

  await page.goto('https://top.test/');
  await mount(page);
  await chooseTab(page);
  assert.equal(await page.locator('[data-tab-sharing]').count(), 0, 'top level: the usual hint');
  assert.match(await page.locator('.live-setup').innerText(), /勾选「共享标签页音频」/);
  assert.deepEqual(errors, []);
});
