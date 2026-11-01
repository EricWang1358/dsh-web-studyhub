/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, holdActions, openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';

/* #153: the app runs one action at a time, so every button of a page is disabled while one runs, but only the button that was pressed shows the work. On the
   mistakes page: press 开始重练 while the answer to review.start is held. That one button has a spinner and aria-busy, keeps its width and height, and nothing
   around it moves; every other button that was enabled is disabled with no spinner, in the one disabled look (no faded copy). Once the answer is let through,
   no button on the page claims to be busy. At 1280 and 420 px. BUSY_LOCK_SHOTS=<dir> keeps a screenshot of the held state. */

const SHOTS = process.env.BUSY_LOCK_SHOTS || '';
const START = '.wb-retrain .sh-btn--primary';

const snapshot = (page) => page.evaluate((start) => {
  const box = (element) => { const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; };
  const buttons = [...document.querySelectorAll('main .sh-btn')].filter((element) => element.getClientRects().length);
  return {
    start: box(document.querySelector(start)),
    bar: box(document.querySelector('.wb-retrain')),
    busy: buttons.filter((element) => element.getAttribute('aria-busy') === 'true').map((element) => element.className),
    spinners: document.querySelectorAll('main .sh-btn .sh-spinner').length,
    startBusy: document.querySelector(start).getAttribute('aria-busy') === 'true',
    startSpinner: !!document.querySelector(`${start} .sh-spinner`),
    disabled: buttons.filter((element) => element.disabled).map((element) => ({ text: element.textContent.trim(), opacity: getComputedStyle(element).opacity, busy: element.hasAttribute('aria-busy') })),
    enabled: buttons.filter((element) => !element.disabled).length,
    segments: [...document.querySelectorAll('main .sh-seg__item:disabled')].map((element) => getComputedStyle(element).opacity),
  };
}, START);

test('only the pressed button shows the work while the app is locked (mistakes page, 1280 and 420 px)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-busy-lock-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedWrongBookLibrary(root) });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'light', width, height: 900 });
      const hold = await holdActions(page, ['review.start']);
      await page.goto(running.server.url);
      const nav = page.locator('[data-tour="nav-wrongbook"]').first();
      await nav.waitFor({ state: 'visible', timeout: 30000 });
      await nav.dispatchEvent('click');
      await page.locator(START).waitFor({ timeout: 30000 });
      await until(() => page.evaluate((start) => !document.querySelector(start).disabled, START), 'the retrain button to be enabled');
      await settleAnimations(page);
      await frames(page, 3);

      const idle = await snapshot(page);
      assert.deepEqual(idle.busy, [], `${width}px: nothing is busy at rest`);
      assert.ok(idle.enabled >= 2, `${width}px: there are other buttons that can be pressed`);

      await page.locator(START).click();
      await until(() => hold.seen('review.start'), 'review.start to be asked');
      await frames(page, 3);
      const held = await snapshot(page);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `held-${width}.png`) });

      assert.equal(held.startBusy, true, `${width}px: the pressed button announces aria-busy`);
      assert.equal(held.startSpinner, true, `${width}px: and shows the spinner`);
      assert.equal(held.busy.length, 1, `${width}px: it is the only busy button (${held.busy.join(' | ')})`);
      assert.equal(held.spinners, 1, `${width}px: one spinner on the page`);
      const others = held.disabled.filter((button) => !button.busy);
      assert.ok(others.length >= 2, `${width}px: the other buttons are locked, and quiet (${others.length})`);
      assert.ok(held.disabled.every((button) => button.opacity === '1'), `${width}px: every locked button has the one disabled look, not a faded copy`);
      assert.ok(held.segments.length >= 1 && held.segments.every((opacity) => opacity === '1'), `${width}px: a disabled segment has the same look, not opacity .4 (${held.segments})`);
      assert.ok(Math.abs(held.start.width - idle.start.width) <= 1, `${width}px: the busy button kept its width (${idle.start.width} -> ${held.start.width})`);
      assert.ok(Math.abs(held.start.height - idle.start.height) <= 1, `${width}px: and its height`);
      assert.ok(Math.abs(held.start.x - idle.start.x) <= 1 && Math.abs(held.start.y - idle.start.y) <= 1, `${width}px: and its place`);
      assert.ok(Math.abs(held.bar.height - idle.bar.height) <= 1, `${width}px: the bar around it did not change height`);

      hold.release('review.start');
      await until(() => page.evaluate(() => !document.querySelector('[aria-busy="true"]')), 'no button to claim it is busy');
      assert.deepEqual(errors, [], `${width}px: no console or page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
