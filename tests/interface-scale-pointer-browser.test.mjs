/* 界面大小 is a CSS zoom on the app, so there are two pixels: the ones the screen draws (pointer events, getBoundingClientRect) and the app's own
   (styles, scrollTop, offsetWidth). Code that mixes them is off by the zoom: 10 % at 90 %, half at 50 %. These are the places that were, measured
   in the browser at 50 % (and 70 % where the first paint depends on the size): what is dragged follows the pointer, what is drawn to a measured width
   fills it, and a 420 px panel does not paint one sidebar layout and then jump to the other. Temporary seeded library, fake model. */
/* global document, window, localStorage, getComputedStyle, MutationObserver */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { seedLibrary } from '../scripts/qa/perf-seed.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { confirmStartIfAsked } from '../scripts/qa/confirm-start.mjs';
import { frames, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { Store } from '../lib/store.js';

const SCALE = 50;
const rect = (locator) => locator.evaluate((element) => { const box = element.getBoundingClientRect(); return { x: box.left, y: box.top, w: box.width, h: box.height }; });
const near = (actual, expected, slack, message) => assert.ok(Math.abs(actual - expected) <= slack, `${message}: ${actual}, expected ${expected} ± ${slack}`);
/* A slow machine draws later, never differently: read until the number is there, and say the last one when it never is. */
const eventually = async (read, expected, slack, message) => {
  let last = NaN;
  await until(async () => Math.abs((last = await read()) - expected) <= slack, message, { timeoutMs: 15000, intervalMs: 50 }).catch(() => {});
  near(last, expected, slack, message);
};
/* Where something rests: two readings a few frames apart that agree. */
const atRest = async (locator, page) => {
  let last = null;
  await until(async () => {
    const now = await rect(locator), same = last && ['x', 'y', 'w', 'h'].every((key) => Math.abs(now[key] - last[key]) < 0.5);
    last = now;
    await frames(page, 6);
    return same;
  }, 'the element comes to rest', { timeoutMs: 15000, intervalMs: 100 });
  return last;
};

/* The 词解 card is position: fixed inside the zoomed reader, and the passage it explains is known in drawn pixels. */
const explainHarness = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import ExplainCard from './ui/document-preview/marks/ExplainCard.jsx';
  window.show = (rect) => createRoot(document.getElementById('app')).render(<ExplainCard shown={{ rect, card: { term: '双边市场', answer: '两类用户通过平台找到彼此。' } }} />);
`;

test('the 词解 card opens right under its passage at 50 %, 100 % and 150 %', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  try {
    const bundle = await build({ stdin: { contents: explainHarness, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser',
      loader: { '.css': 'text', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const styles = await Promise.all(['ui/tokens.css', 'ui/base.css', 'ui/document-preview/marks/marks.css'].map((file) => readFile(file, 'utf8')));
    for (const scale of [50, 100, 150]) await t.test(`${scale}%`, async (t2) => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      t2.after(() => page.close());
      await page.setContent(`<!doctype html><meta charset="utf-8">${styles.map((css) => `<style>${css}</style>`).join('')}<div class="study-app" data-theme="light" data-ui-scale="${scale}"><div id="app"></div></div>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() => window.show({ left: 400, top: 300, right: 520, bottom: 320, width: 120, height: 20 }));
      const card = page.locator('.reader-explain');
      await card.waitFor({ state: 'visible' });
      const drawn = await rect(card);
      near(drawn.x, 400, 2, 'its left edge lines up with the passage');
      near(drawn.y, 320 + 6 * (scale / 100), 2, 'it starts just under the passage');
    });
  } finally {
    await browser.close().catch(() => {});
  }
});

test('below 100% the pointer, the measured widths and the first paint agree with what is drawn', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-scale-pointer-'));
  let server;
  try {
    const dist = join(base, 'dist'), library = join(base, 'library');
    await buildPreview({ outdir: dist });
    await seedLibrary(library, { sources: 10, decks: 3, cardsPerDeck: 10, runs: 2, attempts: 30, courses: 1, largeSources: 1, largeSourceChars: 6000 });
    // The score chart draws answers of the last days only: some are dated today, so the test does not empty itself as the calendar moves on.
    await new Store(library).update((state) => {
      state.attempts.slice(-12).forEach((attempt, index) => { attempt.timestamp = new Date(Date.now() - index * 60_000).toISOString(); });
    });
    server = await createPreviewServer({ libraryRoot: library, home: join(base, 'home'), port: 0, distDir: dist, model: createFakeModel({ latencyMs: 20 }) });

    const open = async (t2, { scale = SCALE, width = 1440, height = 900, init } = {}) => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
      t2.after(() => context.close());
      await context.addInitScript((value) => {
        localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-autopilot', 'off');
        localStorage.setItem('study-interface', JSON.stringify({ scale: value }));
      }, scale);
      if (init) await context.addInitScript(init);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(server.url);
      await page.locator(`.study-app[data-ui-scale="${scale}"]`).waitFor({ timeout: 30000 });
      await page.locator('.sidebar, .nav-menu-toggle').first().waitFor({ timeout: 30000 });
      return { page, errors };
    };

    for (const scale of [70, 50]) await t.test(`a 420 px panel at ${scale}% draws the docked sidebar from the first paint, never the drawer button first`, async (t2) => {
      const { page, errors } = await open(t2, { scale, width: 420, height: 860, init: () => {
        window.sidebarStates = [];
        new MutationObserver(() => {
          const now = document.querySelector('.nav-menu-toggle') ? 'drawer' : document.querySelector('.study-app > .sidebar') ? 'docked' : '';
          if (now && window.sidebarStates.at(-1) !== now) window.sidebarStates.push(now);
        }).observe(document, { childList: true, subtree: true });
      } });
      await page.waitForTimeout(800);
      assert.deepEqual(await page.evaluate(() => window.sidebarStates), ['docked']);
      assert.deepEqual(errors, []);
    });

    await t.test('a lifted sidebar row stays under the pointer', async (t2) => {
      const { page, errors } = await open(t2);
      const row = page.locator('.study-app > .sidebar [data-nav-id="generate"]');
      const before = await atRest(row, page), x = before.x + before.w / 2, y = before.y + before.h / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.locator('.study-app > .sidebar [data-nav-id="generate"].is-dragging').waitFor({ timeout: 15000 }); // held long enough to be lifted
      await page.mouse.move(x, y + 6, { steps: 3 });
      await page.mouse.move(x, y + 40, { steps: 12 });
      await eventually(async () => { const lifted = await rect(row); return lifted.y + lifted.h / 2; }, y + 40, 2, 'the row centre follows the pointer');
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.deepEqual(errors, []);
    });

    await t.test('the score chart is drawn as wide as its box, and the outline filter bar sticks right under the top bar', async (t2) => {
      const { page, errors } = await open(t2);
      await (await revealNavRow(page, 'dashboard')).click();
      const chart = page.locator('.dash-trend-panel .dash-chart-box');
      await chart.locator('svg').waitFor({ timeout: 30000 });
      await eventually(async () => (await rect(chart.locator('svg'))).w, (await atRest(chart, page)).w, 2, 'the svg is as wide as its box');
      await (await revealNavRow(page, 'library')).click();
      await page.getByRole('button', { name: '总纲' }).first().click();
      await page.locator('.outline-filter-bar').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const bar = await page.evaluate(() => ({ top: parseFloat(getComputedStyle(document.querySelector('.outline-page')).getPropertyValue('--outline-bar-top')),
        topbar: document.querySelector('.study-app .topbar').offsetHeight }));
      near(bar.top, bar.topbar, 1, 'the bar sticks at the top bar\'s own height, in the app\'s pixels');
      assert.deepEqual(errors, []);
    });

    await t.test('dragging the course graph moves it as far as the pointer went', async (t2) => {
      const { page, errors } = await open(t2);
      await page.getByRole('button', { name: '查看图谱' }).first().click();
      const view = page.locator('.graph-viewport').first();
      await view.waitFor({ timeout: 30000 });
      const node = view.getByText('Deck 1', { exact: true }).first();
      await node.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const before = await atRest(node, page), area = await rect(view), x = area.x + 30, y = area.y + area.h - 30;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 120, y - 60, { steps: 12 });
      await page.mouse.up();
      await eventually(async () => (await rect(node)).x - before.x, 120, 2, 'sideways');
      await eventually(async () => (await rect(node)).y - before.y, -60, 2, 'up');
      assert.deepEqual(errors, []);
    });

    await t.test('dragging the divider of 对照资料 changes the column by what the pointer moved', async (t2) => {
      const { page, errors } = await open(t2);
      await page.locator('.resume-nav').first().click();
      await confirmStartIfAsked(page, page.locator('.review-page'));
      await page.locator('.review-page .question-card').first().waitFor({ timeout: 30000 });
      const original = page.getByRole('button', { name: /看这题的原文/ }).first();
      if (!await original.count()) await page.locator('.review-page .question-card').first().click();
      await original.click();
      const column = page.locator('.source-column'), handle = page.locator('.source-column__handle');
      await handle.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const grip = await atRest(handle, page), width = (await rect(column)).w, x = grip.x + grip.w / 2, y = Math.min(grip.y + grip.h / 2, 450);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 60, y, { steps: 10 });
      await eventually(async () => grip.x - (await rect(handle)).x, 60, 2, 'the divider follows the pointer while it is held');
      await page.mouse.up();
      await eventually(async () => (await rect(column)).w - width, 60, 2, 'the column takes the width the pointer asked for');
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close().catch(() => {});
    await server?.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
