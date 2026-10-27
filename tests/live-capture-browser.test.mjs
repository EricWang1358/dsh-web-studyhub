/* global document, window */
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
  // A refusal that retrying cannot fix moves the form to the microphone by itself, and the button under the message starts it.
  await frame.locator('[data-capture-help="blocked"]').waitFor();
  assert.equal(await frame.getByRole('button', { name: '再试一次共享' }).count(), 0, 'the frame cannot share: no retry is offered');
  assert.equal(await frame.locator('[data-tab-sharing]').count(), 0, 'the form already moved to the microphone');
  assert.match(await frame.getByRole('combobox', { name: /声音来源/ }).innerText(), /麦克风/);

  await page.goto('https://top.test/');
  await mount(page);
  await chooseTab(page);
  assert.equal(await page.locator('[data-tab-sharing]').count(), 0, 'top level: the usual hint');
  assert.match(await page.locator('.live-setup').innerText(), /勾选「共享标签页音频」/);
  assert.deepEqual(errors, []);
});

/* A refusal at top level, as a desktop Chrome on Windows and as an app shell (Electron user agent) would give it: at once, with no picker. The buttons under the message,
   the facts line and the form moving to the microphone are what the learner sees. */
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WINDOWS_ELECTRON = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.0 Chrome/126.0.6478.234 Electron/31.7.7 Safari/537.36';

test('a refused tab share at top level: the next step is a button, the facts are listed, and the microphone button starts the microphone', { timeout: 120000 }, async (t) => {
  let browser;
  t.after(async () => { await browser?.close(); });
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return;
  }
  const open = async (userAgent, size = { width: 1280, height: 900 }) => {
    const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce', userAgent, viewport: size });
    page.setDefaultTimeout(15000);
    page.errors = [];
    page.on('pageerror', (error) => page.errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'https://top.test/' ? route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' }) : route.abort());
    await page.addInitScript(() => {
      window.__asked = { tab: 0, microphone: 0 };
      const refuse = (kind) => async () => { window.__asked[kind] += 1; throw new DOMException('Permission denied', 'NotAllowedError'); };
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: refuse('tab'), getUserMedia: refuse('microphone') } });
    });
    await page.goto('https://top.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('button', { name: '开始实录', exact: true }).waitFor();
    await page.getByRole('combobox', { name: /声音来源/ }).click();
    await page.getByRole('option', { name: /标签页/ }).click();
    await page.getByRole('button', { name: '开始实录', exact: true }).click();
    return page;
  };

  const page = await open(WINDOWS_CHROME);
  const help = page.locator('[data-capture-help="instant"]');
  await help.waitFor();
  const message = await page.locator('.sh-inline--error').innerText();
  assert.match(message, /没有弹出选择窗口/);
  assert.match(message, /通常不需要系统授权/, 'Windows: no claim about a system screen-recording permission');
  assert.doesNotMatch(message, /屏幕录制权限没打开/);
  assert.equal(await help.getByRole('button', { name: '改用麦克风并开始' }).count(), 1);
  assert.equal(await help.getByRole('button', { name: '再试一次共享' }).count(), 1, 'instant at top level: a retry can work once a policy is changed');
  assert.equal(await page.getByRole('button', { name: '开始实录', exact: true }).count(), 1, 'the start button is still there');
  await help.locator('summary').click();
  const facts = await help.locator('.live-capture-facts').innerText();
  assert.match(facts, /浏览器：Chrome 126/);
  assert.match(facts, /系统：Windows/);
  assert.match(facts, /窗口：独立页面/);
  assert.match(facts, /点击后 \d+ 毫秒被拒绝/);
  assert.equal(await page.evaluate(() => window.__asked.tab), 1);
  await help.getByRole('button', { name: '再试一次共享' }).click();
  await page.waitForFunction(() => window.__asked.tab === 2);
  await help.waitFor();
  await help.getByRole('button', { name: '改用麦克风并开始' }).click();
  await page.waitForFunction(() => window.__asked.microphone === 1);
  assert.match(await page.getByRole('combobox', { name: /声音来源/ }).innerText(), /麦克风/, 'the form moved to the microphone');
  assert.match(await page.locator('.sh-inline--error').innerText(), /没有允许使用麦克风/, 'the microphone had its own refusal sentence');
  assert.equal(await page.locator('[data-capture-help]').count(), 0, 'no tab help under a microphone error');
  assert.deepEqual(page.errors, []);

  const shell = await open(WINDOWS_ELECTRON);
  await shell.locator('[data-capture-help="app-window"]').waitFor();
  assert.match(await shell.locator('.sh-inline--error').innerText(), /应用内置的窗口/);
  assert.equal(await shell.getByRole('button', { name: '再试一次共享' }).count(), 0, 'an app window cannot share: no retry');
  assert.match(await shell.getByRole('combobox', { name: /声音来源/ }).innerText(), /麦克风/, 'the form already moved to the microphone, so the next click works');
  assert.match(await shell.locator('[data-capture-loopback]').innerText(), /立体声混音/, 'on Windows the note says how to record the computer\'s sound without sharing');
  assert.deepEqual(shell.errors, []);

  const narrow = await open(WINDOWS_CHROME, { width: 420, height: 900 });
  await narrow.locator('[data-capture-help="instant"]').waitFor();
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll at 420 px');
  assert.deepEqual(narrow.errors, []);
});
