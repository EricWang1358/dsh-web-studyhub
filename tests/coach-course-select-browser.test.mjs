/* global document, innerWidth */
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

/* #1698: the course picker of 考试教练 carries the label the other pages use (课程范围) and shows an ordinary course name whole while there is room
   (it was held to 14rem, label included, and cut 「示例课程 · 设计模式」). */

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

const course = '示例课程 · 设计模式';

test('考试教练: the course picker is 课程范围 and its course name is not cut', { timeout: 600000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'coach-select-'));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const store = new Store(join(root, 'library'));
  await store.update((state) => { state.decks.push({ id: 'deck', title: '检索练习', course, cards: [] }); });
  server = await createPreviewServer({ port: 0, libraryRoot: store.root, home: join(root, 'home'), model: createFakeModel() });
  await previewCall(server, 'focus.set', { course });
  try { browser = await launchChromium(); }
  catch (error) { skipMissingChromium(t, error); return; }
  const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('invokeStudy', async (action, args) => {
    try { return { ok: true, value: await previewCall(server, action, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.route('**/*', (route) => route.request().url() === 'http://coach-select.test/'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div>' }) : route.abort());
  await page.goto('http://coach-select.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-tour="nav-more"]').first().waitFor({ state: 'attached', timeout: 30000 });
  const item = page.locator('[data-tour="nav-examcoach"]').first();
  if (!await item.isVisible()) await page.locator('[data-nav-fold] .nav-fold__toggle').first().click();
  await item.click();
  const picker = page.getByRole('combobox', { name: '课程范围', exact: true });
  await picker.waitFor();
  for (const [width, height] of [[1440, 900], [420, 860]]) {
    await page.setViewportSize({ width, height });
    const cut = await picker.evaluate((button, name) => [...button.querySelectorAll('span'), button]
      .filter((element) => element.textContent.trim() === name).map((element) => element.scrollWidth - element.clientWidth), course);
    assert.ok(cut.length > 0, `${width}px: the picker shows the course name`);
    assert.ok(cut.every((over) => over <= 0), `${width}px: not cut (${cut.join(', ')}px over)`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px: nothing runs off the side`);
  }
  assert.deepEqual(errors, []);
});
