/* global document, window */
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

/* The full tour's step 「开始前先看一眼用量」 (ui/tour/steps.js, anchor generate-summary) talks about the 「预计 … tok」 line: that line is inside the lit
   area and not under the tour's card, at 1440 and 420 (#1082: the line had moved under the bar, out of the spotlight and under the docked card). */

const box = (page, selector) => page.evaluate(css => {
  const rect = document.querySelector(css)?.getBoundingClientRect();
  return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
}, selector);

test('the tour step about the cost lights the estimate it talks about, clear of its card', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-tour-cost-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const [width, height] of [[1440, 900], [420, 860]]) {
      const base = await mkdtemp(join(tmpdir(), 'study-tour-cost-'));
      const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
      try {
        const { page, errors, context } = await openPage(browser, { server }, { lang: 'zh', theme: 'dark', width, height });
        await page.goto(server.url);
        await page.getByRole('button', { name: '载入示例并开始导览' }).click();
        await page.locator('.tour-pop').waitFor({ timeout: 30000 });
        const next = () => page.locator('.tour-pop').getByRole('button', { name: '下一步', exact: true }).click({ timeout: 2000 }).then(() => false, () => false);
        const full = page.locator('.tour-pop').getByRole('button', { name: '看完整导览' });
        await until(async () => (await full.count()) > 0 || next(), 'the short tour reaches its last step', { timeoutMs: 90000, intervalMs: 1200 });
        await full.click();
        await until(async () => /看一眼用量/.test(await page.locator('.tour-pop__title').innerText().catch(() => '')) || next(),
          'the full tour reaches 开始前先看一眼用量', { timeoutMs: 90000, intervalMs: 1200 });
        await page.locator('.tour-spot').waitFor({ timeout: 15000 });
        await until(async () => (await page.locator('[data-generate-estimate] [data-token-estimate][data-status="ready"]').count()) > 0, 'the estimate', { timeoutMs: 60000 });
        await settleAnimations(page);
        await frames(page, 6);
        const [spot, pop, estimate] = await Promise.all([box(page, '.tour-spot'), box(page, '.tour-layer:not(.is-measuring) .tour-pop'), box(page, '[data-generate-estimate]')]);
        const where = `${width}: estimate ${JSON.stringify(estimate)}, spot ${JSON.stringify(spot)}, card ${JSON.stringify(pop)}`;
        assert.ok(estimate, `${width}: the page shows an estimate`);
        assert.match(await page.locator('[data-generate-estimate]').innerText(), /预计 .*tok/, `${width}: the estimate says 「预计 … tok」`);
        assert.ok(estimate.left >= spot.left && estimate.right <= spot.right && estimate.top >= spot.top && estimate.bottom <= spot.bottom, `${where}: the estimate is inside the lit area`);
        const overlaps = estimate.left < pop.right && estimate.right > pop.left && estimate.top < pop.bottom && estimate.bottom > pop.top;
        assert.equal(overlaps, false, `${where}: the tour's card is not on the estimate`);
        assert.ok(estimate.top >= 0 && estimate.bottom <= height, `${where}: the estimate is in the view`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${width}: no sideways scroll`);
        assert.deepEqual(errors, []);
        await context.close();
      } finally {
        await server.close();
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
