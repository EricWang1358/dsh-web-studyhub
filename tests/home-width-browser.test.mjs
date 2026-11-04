/* global document, window -- page.evaluate callbacks run in the browser */
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

/* #681: the first screen of an empty library (开始使用) used to be a 760 px column at the left of a 1200 px page, so at 1440 about a third of the width on
   the right was empty. Wide, the welcome words and the steps now share the page's width; the left and right margins of what is drawn are about equal, at 1440,
   1920 and (as one column, with no sideways scroll) 420. */

const SHOTS = process.env.HOME_WIDTH_SHOTS || '';

/** Where the first screen's drawn parts end, against the page it sits in. */
const measure = (page) => page.evaluate(() => {
  const area = document.querySelector('.first-run').closest('.page'), box = area.getBoundingClientRect(), pad = window.getComputedStyle(area);
  const parts = [...document.querySelectorAll('.first-run > *')].map((element) => element.getBoundingClientRect());
  const left = Math.min(...parts.map((rect) => rect.left)), right = Math.max(...parts.map((rect) => rect.right));
  return { inner: [box.left + parseFloat(pad.paddingLeft), box.right - parseFloat(pad.paddingRight)], left, right, overflow: document.documentElement.scrollWidth - window.innerWidth };
});

test('the first screen of an empty library fills its page evenly at 1440 and 1920, and stays one column at 420', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-home-width-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 50 }), distDir: dist });
  try {
    for (const [width, theme] of [[1440, 'light'], [1920, 'light'], [420, 'dark']]) {
      const { page, context, errors } = await openPage(browser, { server }, { lang: 'zh', theme, width, height: width < 700 ? 844 : 900 });
      await page.goto(server.url);
      await page.locator('.first-run').waitFor({ timeout: 60000 });
      await settleAnimations(page);
      const at = await measure(page), [innerLeft, innerRight] = at.inner;
      const leftGap = at.left - innerLeft, rightGap = innerRight - at.right;
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `home-${width}-${theme}.png`) });
      assert.ok(at.overflow <= 0, `${width}px: no sideways scroll`);
      if (width >= 1200) assert.ok(Math.abs(leftGap - rightGap) <= 60, `${width}px: left and right margins are about equal (left ${Math.round(leftGap)}, right ${Math.round(rightGap)})`);
      else assert.ok(rightGap <= 40 && leftGap <= 40, `${width}px: one column over the page's width (left ${Math.round(leftGap)}, right ${Math.round(rightGap)})`);
      assert.deepEqual(errors, [], `${width}px: no console or page errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
