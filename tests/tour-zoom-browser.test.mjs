/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';

/* The tour's spotlight at a larger 界面大小 (設置 › 界面, CSS zoom on the app). The tour layer lives inside the zoomed app, so screen
   rectangles have to be divided by the zoom before they become its left/top; at 125 % the spotlight used to land to the right of and below
   the 今天 card (owner's screenshot, 2026-11-05). At 90 %, 100 % and 125 %, the lit box frames the step's anchor. */

const box = (page, selector) => page.evaluate((css) => {
  const rect = document.querySelector(css)?.getBoundingClientRect();
  return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
}, selector);

test('the tour spotlight frames its anchor at every interface size', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-tour-zoom-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const scale of [90, 100, 125]) {
      const base = await mkdtemp(join(tmpdir(), 'study-tour-zoom-'));
      const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0,
        model: createFakeModel({ latencyMs: 20 }), distDir: dist });
      try {
        const { page } = await openPage(browser, { server }, { lang: 'zh', theme: 'dark', width: 1440, height: 900 });
        await page.addInitScript((value) => { localStorage.setItem('study-interface', JSON.stringify({ scale: value })); }, scale);
        await page.goto(server.url);
        await page.locator(`.study-app[data-ui-scale="${scale}"]`).waitFor({ timeout: 30000 });
        await page.getByRole('button', { name: '载入示例并开始导览' }).click();
        await page.locator('.tour-pop').waitFor({ timeout: 30000 });
        // The short tour ends on a step that offers the full one, which visits the home's 今天 card.
        const next = () => page.locator('.tour-pop').getByRole('button', { name: '下一步', exact: true }).click({ timeout: 2000 }).then(() => false, () => false);
        const full = page.locator('.tour-pop').getByRole('button', { name: '看完整导览' });
        await until(async () => (await full.count()) > 0 || next(), 'the short tour reaches its last step', { timeoutMs: 60000, intervalMs: 1200 });
        await full.click();
        await until(async () => /今天学什么/.test(await page.locator('.tour-pop__title').innerText().catch(() => '')) || next(),
          'the full tour reaches 学习库：今天学什么', { timeoutMs: 30000, intervalMs: 1200 });
        await page.locator('.tour-spot').waitFor({ timeout: 15000 });
        await settleAnimations(page);
        await frames(page, 4);
        const [spot, anchor] = await Promise.all([box(page, '.tour-spot'), box(page, '[data-tour="home-today"]')]);
        // The spotlight is the anchor padded by 6 CSS px on each side: a few screen pixels at any zoom, never a shifted box.
        const slack = 6 * (scale / 100) + 3;
        for (const side of ['left', 'top']) assert.ok(anchor[side] - spot[side] >= 0 && anchor[side] - spot[side] <= slack,
          `${scale}%: the spotlight's ${side} edge sits just outside the card (spot ${JSON.stringify(spot)}, card ${JSON.stringify(anchor)})`);
        for (const side of ['right', 'bottom']) assert.ok(spot[side] - anchor[side] >= 0 && spot[side] - anchor[side] <= slack,
          `${scale}%: the spotlight's ${side} edge sits just outside the card (spot ${JSON.stringify(spot)}, card ${JSON.stringify(anchor)})`);
      } finally {
        await server.close();
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      }
    }
  } finally {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
