/* global document, window -- page.evaluate callbacks run in the browser */
/* #1704: The compact "第一组题" card on the home desk used to inherit `.today-card`'s full-height
   `repeating-linear-gradient` ruling, so horizontal lines poked out on both sides of the primary
   button. Ruling now paints only on `.frl-steps` (and `.frl-compact-plan` when present) and stops
   before the button area in both light and dark themes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage, settleAnimations } from '../scripts/qa/layout-late.mjs';

test('compact first-run card keeps 32px ruling behind step rows and stops before the primary button in light and dark themes (#1704)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-frl-ruling-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 50 }), distDir: dist });
  try {
    await previewCall(server, 'sample.load', { language: 'zh' });
    for (const theme of ['light', 'dark']) {
      const { page, context, errors } = await openPage(browser, { server }, { lang: 'zh', theme, width: 1280, height: 900 });
      await page.goto(server.url);
      await page.locator('[data-first-run="later"], .first-run-card').first().waitFor({ timeout: 60000 });
      const laterBtn = page.locator('[data-first-run="later"]');
      if (await laterBtn.count()) await laterBtn.first().click();
      await page.locator('.first-run-card .today-go').waitFor({ timeout: 30000 });
      await settleAnimations(page);

      const info = await page.evaluate(() => {
        const card = document.querySelector('.first-run-card');
        const steps = card.querySelector('.frl-steps');
        const btn = card.querySelector('.today-go');
        const cardRect = card.getBoundingClientRect();
        const stepsRect = steps.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        return {
          cardBgImage: window.getComputedStyle(card).backgroundImage,
          stepsBgImage: window.getComputedStyle(steps).backgroundImage,
          cardLeft: Math.round(cardRect.left),
          cardRight: Math.round(cardRect.right),
          stepsLeft: Math.round(stepsRect.left),
          stepsRight: Math.round(stepsRect.right),
          stepsBottom: Math.round(stepsRect.bottom),
          btnTop: Math.round(btnRect.top),
        };
      });

      assert.equal(info.cardBgImage, 'none', `${theme}: .first-run-card itself must not paint full-height ruling behind the button`);
      assert.match(info.stepsBgImage, /repeating-linear-gradient/, `${theme}: .frl-steps must keep the 32px index-card ruling`);
      assert.ok(Math.abs(info.stepsLeft - info.cardLeft) <= 2 && Math.abs(info.stepsRight - info.cardRight) <= 2,
        `${theme}: .frl-steps ruling spans full card width (${info.stepsLeft}..${info.stepsRight} vs ${info.cardLeft}..${info.cardRight})`);
      assert.ok(info.stepsBottom < info.btnTop, `${theme}: ruling stops above primary button (stepsBottom=${info.stepsBottom} < btnTop=${info.btnTop})`);
      assert.deepEqual(errors, [], `${theme}: no console or page errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
