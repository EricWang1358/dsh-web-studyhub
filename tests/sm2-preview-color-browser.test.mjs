/* global document, window -- page.evaluate callbacks run in the browser */
/* #1682: In Settings › 导入、计划与备份, the FSRS interval preview's "熟练" (is-good) legend dot
   used --ok (green) while the curve, dots and labels used --accent / --accent-text (cinnabar red).
   Both now share --sm2-good: var(--ok), so across all 5 accent colours and both dark/light themes
   the legend dot, nodes, day labels and curve track all match. */
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
import { openPage, settleAnimations } from '../scripts/qa/layout-late.mjs';
import { ACCENTS } from '../ui/appearance-prefs.js';

test('Settings SM2 preview "熟练" legend dot and series curve share the same color across all 5 accents and light/dark themes (#1682)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-sm2-color-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 50 }), distDir: dist });
  try {
    for (const theme of ['dark', 'light']) {
      const { page, context, errors } = await openPage(browser, { server }, { lang: 'zh', theme, width: 1280, height: 900 });
      await page.goto(server.url);
      await page.locator('.nav-rail, .sidebar-nav, button[aria-label*="设置"], [data-page="settings"]').first().waitFor({ timeout: 60000 });
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, a')];
        const settingsBtn = btns.find((el) => /设置/.test(el.textContent || '') || el.getAttribute('data-page') === 'settings');
        if (settingsBtn) settingsBtn.click();
      });
      await page.locator('.settings-page').waitFor({ timeout: 20000 });
      await page.locator('.settings-nav__item', { hasText: /导入、计划与备份|计划|复习/ }).first().click();
      await page.locator('.sm2-preview .sm2-series.is-good circle').first().waitFor({ timeout: 20000 });
      await settleAnimations(page);

      for (const accent of ACCENTS) {
        const colors = await page.evaluate((acc) => {
          const root = document.querySelector('.study-app, .study-seat');
          if (root) root.setAttribute('data-accent', acc);
          const keyEl = document.querySelector('.sm2-key.is-good');
          const circleEl = document.querySelector('.sm2-series.is-good circle');
          const textEl = document.querySelector('.sm2-series.is-good text');
          const trackEl = document.querySelector('.sm2-series.is-good .sm2-track');
          return {
            legendBg: window.getComputedStyle(keyEl, '::before').backgroundColor,
            circleFill: window.getComputedStyle(circleEl).fill,
            textFill: window.getComputedStyle(textEl).fill,
            trackStroke: window.getComputedStyle(trackEl).stroke,
          };
        }, accent);

        assert.ok(colors.legendBg && colors.legendBg !== 'rgba(0, 0, 0, 0)', `${theme}/${accent}: legend dot has color`);
        assert.equal(colors.circleFill, colors.legendBg, `${theme}/${accent}: node fill (${colors.circleFill}) must match legend dot (${colors.legendBg})`);
        assert.equal(colors.textFill, colors.legendBg, `${theme}/${accent}: day label fill (${colors.textFill}) must match legend dot (${colors.legendBg})`);
        assert.ok(colors.trackStroke && colors.trackStroke !== 'none', `${theme}/${accent}: curve track has stroke`);
      }

      assert.deepEqual(errors, [], `${theme}: no console or page errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
