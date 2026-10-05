import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs, openConsole, measure, measureCards } from '../scripts/qa/task-console.mjs';

/* WP-TC in the browser, on a seeded temporary library with the fake model: an audio batch and a question run held in flight, and four days of 为你定制 in the
   coach's file. At 1280 the console is as tall as the window and every list scrolls INSIDE its panel (the page never grows); at 420 the columns stack and the page
   scrolls; picking another task moves nothing; the compact cards line up on the pages that carry them, and 「查看详情」 opens the console on that job. */

test('the 任务 console fits the window, scrolls inside its panels, stacks when narrow and does not shift when another task is picked', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist });
  try {
    await startJobs(running);
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
      await until(async () => (await page.locator('.tc-callrow').count()) > 0, 'a call in flight');
      await until(async () => (await page.locator('.tc-row').count()) >= 4, 'the jobs and the days of 为你定制 in the list');
      await frames(page, 6);
      await drainLayoutStability(page);
      const first = await measure(page);
      assert.equal(first.viewport.width, width);
      if (width === 1280) {
        assert.equal(first.appScrolls, false, 'the console fits the window: the page does not scroll');
        assert.ok(first.docHeight <= first.viewport.height + 1, `the document grew to ${first.docHeight}px in a ${first.viewport.height}px window`);
        assert.ok(Math.abs(first.console.bottom - first.main.bottom) <= 2, 'the console reaches the bottom of the window: it takes the height the bar leaves');
        const [left, right] = first.cols;
        assert.equal(left.height, right.height, 'the two columns are as tall as each other');
      } else assert.equal(first.appScrolls, true, 'stacked: the page scrolls instead of splitting a phone-height window into panels');
      assert.ok(first.scrollWidth <= width, `no sideways scroll at ${width}px`);
      // every task in the list: pick it, and nothing around it moves
      const rows = await page.locator('.tc-row').count();
      for (let index = 0; index < rows; index++) {
        await page.locator('.tc-row').nth(index).dispatchEvent('click');
        await frames(page, 4);
        const picked = await measure(page);
        if (width === 1280) {
          assert.deepEqual(picked.console, first.console, `picking task ${index} moved the console`);
          assert.equal(picked.cols[0].height, picked.cols[1].height, `task ${index}: the two columns are as tall as each other`);
          assert.equal(picked.appScrolls, false, `picking task ${index} made the page scroll`);
        }
        assert.ok(picked.scrollWidth <= width);
      }
      const verdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
      assert.ok(verdict.ok, `${width}px: ${verdict.message}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

test('the compact cards on the audio page and the library line up, and 查看详情 opens the console on that job', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist });
  try {
    await startJobs(running);
    for (const [nav, width] of [['audio', 1280], ['library', 1280], ['audio', 420]]) {
      const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width, height: 900, nav });
      await frames(page, 6);
      await drainLayoutStability(page);
      const { cards, scrollWidth } = await measureCards(page);
      assert.ok(cards.length >= 1, `${nav}: a card for the job in flight`);
      assert.ok(scrollWidth <= width, `${nav} ${width}px: no sideways scroll`);
      for (const card of cards) {
        assert.equal(card.box.height, cards[0].box.height, `${nav}: the cards are the same height`);
        assert.equal(card.go.width, cards[0].go.width, `${nav}: the buttons are the same width`);
        assert.equal(card.go.x, cards[0].go.x, `${nav}: the buttons line up`);
        assert.ok(card.line.height <= 20, `${nav}: the status is ONE line`);
      }
      if (width === 1280) assert.equal(cards[0].go.width, 168);
      const id = cards[0].id;
      await page.locator('.cjc__go').first().dispatchEvent('click');
      await page.locator('.tc-detail').first().waitFor({ state: 'attached', timeout: 30000 });
      const shown = await page.locator('.tc-detail').first().getAttribute('data-task-id');
      assert.ok(shown === id || (await page.locator(`.tc-row[data-task-id="${shown}"]`).count()) === 1, `${nav}: the console opens on the job of the card (${id} -> ${shown})`);
      const verdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
      assert.ok(verdict.ok, `${nav} ${width}px: ${verdict.message}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
