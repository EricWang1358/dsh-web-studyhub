/* global document, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { startNavServer } from '../scripts/qa/nav-layout.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 「更多」 says "hold an item and drag it up to put it in the main list". The main list is full from the first day (six pages, the most it holds),
   so the first thing a learner tries, lifting 任务 or 学习笔记 or 复习全书 up to the top, cannot land. This test is that learner, with the real
   mouse (press, hold, move in steps, release) in a wide window, in the drawer of a narrow one and on the keyboard: a full main list SAYS why on
   screen (a toast, not only the live region a screen reader hears), the live region never claims a move that did not happen, and once the learner
   has sent one page down to 「更多」 the same drag lands in the main list and is still there after a reload. Needs a Chromium. */
const MAIN = ['library', 'sources', 'generate', 'wrongbook', 'exam', 'dashboard'];
const FULL = /主导航最多放 6 项/;

async function openSidebar(browser, running, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', 'dark'); } catch { /* blocked */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(running.server.url);
  await page.locator('.sidebar, .nav-menu-toggle').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  return { context, page, errors };
}

/** What each sidebar group holds now, by page id (a drawer that is shut holds nothing: open it first). */
const groups = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sidebar [data-nav-group]')].map((group) =>
  [group.dataset.navGroup, [...group.querySelectorAll('[data-nav-id]')].map((row) => row.dataset.navId)])));
const live = (page) => page.locator('.side-nav [role="status"]').first().textContent();

/** Lift `id` with the left button the way a learner does (press, hold past the lift, move in small steps) and let go over the row of `overId`. */
async function drag(page, id, overId) {
  const row = await revealNavRow(page, id);
  await row.scrollIntoViewIfNeeded();
  const from = await row.boundingBox();
  const over = await page.locator(`[data-tour="nav-${overId}"]`).first().boundingBox();
  const x = from.x + 40, y0 = from.y + from.height / 2, y1 = over.y + over.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.nav.is-dragging').count(), 1, `${id} is lifted after the hold`);
  for (let step = 1; step <= 20; step += 1) { await page.mouse.move(x, y0 + ((y1 - y0) * step) / 20); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function reopen(page) {
  await page.reload();
  await page.locator('.sidebar, .nav-menu-toggle').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
}

for (const [label, width] of [['wide window', 1440], ['narrow window (the drawer)', 420]]) {
  test(`dragging a page from 「更多」 up into a full main list says why; after one goes down the same drag lands and stays (${label})`, { timeout: 300000 }, async (t) => {
    let browser;
    try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to drag with: ${String(error.message).split('\n')[0]}`); return; }
    const dist = await mkdtemp(join(tmpdir(), 'study-nav-drag-'));
    await buildPreview({ outdir: dist });
    const running = await startNavServer({ distDir: dist });
    const { context, page, errors } = await openSidebar(browser, running, width);
    try {
      await revealNavRow(page, 'tasks');
      assert.deepEqual((await groups(page)).main, MAIN, 'the main list starts full: six pages');

      // 1. Full: nothing moves, and the screen says why.
      await drag(page, 'tasks', 'library');
      assert.deepEqual((await groups(page)).main, MAIN, 'a full main list does not take a seventh page');
      assert.equal((await groups(page)).notes[0], 'tasks', 'the page is back where it was');
      const toast = page.locator('.sh-toast').filter({ hasText: FULL });
      assert.equal(await toast.count(), 1, 'the refusal is on screen, not only in the live region');
      assert.doesNotMatch(await live(page), /已移到/, 'the live region does not claim a move that did not happen');
      assert.match(await live(page), FULL);

      // 2. One page goes down to its home in 「更多」 ...
      await drag(page, 'dashboard', 'examprep');
      assert.deepEqual((await groups(page)).main, MAIN.slice(0, 5), 'the page went down; the main list has room');
      assert.equal((await groups(page)).exam[0], 'dashboard');

      // 3. ... and now the same drag lands in the main list, last, and survives a reload.
      await drag(page, 'tasks', 'library');
      const placed = [...MAIN.slice(0, 5), 'tasks'];
      assert.deepEqual((await groups(page)).main, placed, 'the page is in the main list');
      assert.match(await live(page), /任务 已移到「主导航」第 6 位，共 6 项/);
      await reopen(page);
      await revealNavRow(page, 'tasks');
      assert.deepEqual((await groups(page)).main, placed, 'the main list is the same after a reload');
      assert.deepEqual(errors, []);
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await running.close();
      await rm(dist, { recursive: true, force: true });
    }
  });
}

test('on the keyboard too: Alt+ArrowUp on the first page of a section with a full main list says why on screen', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-nav-drag-key-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  const { context, page, errors } = await openSidebar(browser, running, 1440);
  try {
    await revealNavRow(page, 'tasks');
    await page.locator('[data-nav-id="tasks"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(300);
    assert.deepEqual((await groups(page)).main, MAIN);
    assert.equal(await page.locator('.sh-toast').filter({ hasText: FULL }).count(), 1, 'the refusal is on screen');
    assert.match(await live(page), FULL);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});
