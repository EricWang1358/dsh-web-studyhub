import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../lib/store.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';

/* #1708, in the app: with no transcription service, 音频转写 shows its setup card, and the card is then the page's one way to the audio settings (the
   header had a second button under another name). */

scrubProcessEnv();
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import App from './ui/App.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import css from './ui/styles.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  window.callStudy = async (action, args) => {
    const reply = await window.invokeStudy(action, args);
    if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
    return reply.value;
  };
  createRoot(document.getElementById('root')).render(<App call={window.callStudy} />);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  loader: { '.css': 'text' }, logLevel: 'silent' });

test('音频转写 with no service set up has one way to the audio settings: the setup card\'s', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'audio-entry-'));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const store = new Store(join(root, 'library'));
  await store.update((state) => { state.decks.push({ id: 'deck', title: '检索练习', course: '学习方法', cards: [] }); });
  server = await createPreviewServer({ port: 0, libraryRoot: store.root, home: join(root, 'home'), model: createFakeModel() });
  try { browser = await launchChromium(); }
  catch (error) { skipMissingChromium(t, error); return; }
  const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('invokeStudy', async (action, args) => {
    try { return { ok: true, value: await previewCall(server, action, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.route('**/*', (route) => route.request().url() === 'http://audio-entry.test/'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div>' }) : route.abort());
  await page.goto('http://audio-entry.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-tour="nav-more"]').first().waitFor({ state: 'attached', timeout: 30000 });
  const item = page.locator('[data-tour="nav-audio"]').first();
  if (!await item.isVisible()) await page.locator('[data-nav-fold] .nav-fold__toggle').first().click();
  await item.click();
  await page.locator('main .audio-setup').waitFor({ timeout: 20000 });
  const ways = page.locator('main').getByRole('button', { name: /音频设置/ });
  await page.waitForFunction(() => [...document.querySelectorAll('main button')].filter((button) => button.textContent.includes('音频设置')).length === 1, null, { timeout: 5000 }).catch(() => {});
  assert.deepEqual(await ways.allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['打开音频设置']);
  assert.deepEqual(errors, []);
});
