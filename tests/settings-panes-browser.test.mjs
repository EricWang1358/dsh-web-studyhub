/* global document, getComputedStyle */
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

/* #1699: every settings pane starts at the same height (课程 had a rule and 53px above its title). #1682: the 熟练 line of the review preview and its
   key are one colour under every accent, light and dark (the key was jade, the line cinnabar). */

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

test('settings: every pane starts at one height, and the review preview\'s 熟练 line matches its key', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'settings-panes-'));
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
  await page.route('**/*', (route) => route.request().url() === 'http://settings-panes.test/'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div>' }) : route.abort());
  await page.goto('http://settings-panes.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: '设置', exact: true }).first().click({ timeout: 30000 });
  await page.locator('.settings-nav__item').first().waitFor();
  const categories = await page.locator('.settings-nav__item').evaluateAll((items) => items.map((item) => item.dataset.category));
  assert.ok(categories.includes('courses') && categories.includes('data'));
  const gaps = {};
  for (const id of categories) {
    await page.locator(`.settings-nav__item[data-category="${id}"]`).click();
    await page.locator('.settings-pane .settings-section__title').first().waitFor();
    gaps[id] = await page.evaluate(() => {
      const pane = document.querySelector('.settings-pane');
      return Math.round(pane.querySelector('.settings-section__title').getBoundingClientRect().top - pane.getBoundingClientRect().top);
    });
  }
  assert.deepEqual(Object.entries(gaps).filter(([, gap]) => gap !== 0), [], `every pane's title sits at the top of the pane: ${JSON.stringify(gaps)}`);

  await page.locator('.settings-nav__item[data-category="data"]').click();
  await page.locator('.sm2-series.is-good circle').first().waitFor();
  for (const theme of ['light', 'dark']) for (const accent of [null, 'jade', 'ochre', 'graphite', 'plum']) {
    const colours = await page.evaluate(async ([nextTheme, nextAccent]) => {
      const app = document.querySelector('.study-app');
      app.dataset.theme = nextTheme;
      if (nextAccent) app.dataset.accent = nextAccent; else delete app.dataset.accent;
      // Colour transitions (reduced motion shortens them, it does not skip the first frame) have ended before the colours are read.
      await new Promise((done) => setTimeout(done, 400));
      // The same colour written as a probe, so a token and its computed form compare.
      const token = (value) => { const probe = document.createElement('i'); probe.style.color = value; document.querySelector('.sm2-preview').append(probe); const seen = getComputedStyle(probe).color; probe.remove(); return seen; };
      const style = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo);
      return { key: style('.sm2-key.is-good', '::before').backgroundColor, dot: style('.sm2-series.is-good circle').fill, days: style('.sm2-series.is-good text').fill,
        line: style('.sm2-series.is-good .sm2-track').stroke, ok: token('var(--ok)'), ink: token('var(--ok-ink)'), faded: token('color-mix(in srgb, var(--ok) 55%, transparent)') };
    }, [theme, accent]);
    const at = `${theme} ${accent || 'cinnabar'}`;
    assert.equal(colours.key, colours.ok, `${at}: the key is --ok`);
    assert.equal(colours.dot, colours.key, `${at}: the dots are the key's colour`);
    assert.equal(colours.line, colours.faded, `${at}: the line is --ok, faded`);
    assert.equal(colours.days, colours.ink, `${at}: the day numbers are --ok's text token`);
  }
  assert.deepEqual(errors, []);
});
