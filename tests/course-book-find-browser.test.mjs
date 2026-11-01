/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { seedBigBook } from '../scripts/qa/big-book.mjs';

/* #489 items 3, 4, 11 in the real page at 1280 and 420 px on a book of 200 points: 在书里找 lists the points that have the words, one click goes to the point (not drawn until then, in
   逐节读) with the words marked, the same in 整章连着读; the 目录 of a big book shows chapters with the one being read open, and its caret opens another. Nothing scrolls sideways. */

const marks = page => page.evaluate(() => window.CSS.highlights.get('study-find')?.size ?? 0);

test('复习全书 find and the big 目录 (1280 and 420 px)', { timeout: 420000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-find-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: root => seedBigBook(root, { points: 200, chars: 300 }) });
  try {
    const opened = await running.api('course.book.open', {}), target = opened.nodes[7].children[3];
    await running.api('course.book.save', { file: target.files.mine, text: '那个独一无二的公式，再说一次独一无二。', version: opened.files[target.files.mine].version });
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      const entry = page.locator('[data-tour="nav-book"]').first();
      await entry.waitFor({ state: 'attached', timeout: 30000 });
      await entry.dispatchEvent('click');
      await page.locator('[data-book-point]').first().waitFor({ timeout: 60000 });
      const toc = async () => { if (!await page.locator('.book-toc').count()) await page.locator('.book-bar__toc').click(); await page.locator('.book-toc').waitFor(); };
      await toc();
      // A big 目录: every chapter, and the points of the one being read only.
      const rows = await page.locator('.book-toc__go').count();
      assert.ok(rows <= 10 + 20 + 1, `${width}px: ${rows} rows, not 210`);
      assert.equal(await page.locator('.book-toc__go[aria-current="location"]').count(), 1, `${width}px: the point being read is shown`);
      const caret = page.locator('.book-toc__fold[aria-expanded="false"]').first();
      await caret.click();
      assert.ok(await page.locator('.book-toc__go').count() >= rows + 20, `${width}px: its caret opens another chapter`);
      assert.equal(await page.locator('.book-toc [title]:not(.book-toc__fold)').count(), 0, `${width}px: no title= on text`);
      // Words that are in one point, not drawn yet: one row, one click, there with the words marked. The width of the characters does not matter.
      const box = page.getByRole('searchbox', { name: '在书里找' });
      await box.fill('独一无二');
      const hit = page.locator('[data-book-hit]');
      await hit.first().waitFor({ timeout: 30000 });
      assert.equal(await hit.count(), 1, `${width}px: one point has them`);
      assert.match(await hit.innerText(), /2 处/);
      assert.equal(await page.locator('.book-toc__hit-text mark').innerText(), '独一无二');
      assert.equal(await page.locator(`[data-book-step="${target.hid}"]`).count(), 0, `${width}px: the point is not drawn yet`);
      await hit.click();
      await page.locator(`[data-book-step="${target.hid}"]`).waitFor({ timeout: 30000 });
      await page.waitForFunction(() => window.CSS.highlights.get('study-find')?.size > 0, null, { timeout: 30000 });
      assert.equal(await marks(page), 2, `${width}px: both places are marked`);
      const seen = await page.evaluate(() => { const range = [...window.CSS.highlights.get('study-find')][0], box = range.getBoundingClientRect(); return { top: box.top, height: window.innerHeight, text: range.toString() }; });
      assert.equal(seen.text, '独一无二');
      assert.ok(seen.top >= 0 && seen.top < seen.height, `${width}px: the first one is on screen (${seen.top})`);
      if (width === 420) assert.equal(await page.locator('.book-toc').count(), 0, '420px: the 目录 closes after a jump');
      // Another point: the marks go. Back in the 目录 what was typed is still there; 清空 brings the headings back.
      await page.locator('.book-bar').getByRole('button', { name: /下一/ }).first().click();
      await page.waitForFunction(() => !window.CSS.highlights.get('study-find')?.size, null, { timeout: 30000 });
      await toc();
      assert.equal(await box.inputValue(), '独一无二', `${width}px: what was typed stays`);
      await box.press('Escape');
      assert.equal(await box.inputValue(), '', `${width}px: Esc clears the box first`);
      assert.ok(await page.locator('.book-toc__go').count() >= 10, `${width}px: the headings are back`);
      // No match says so. 整章连着读 goes to the same words.
      await box.fill('全书里没有的词');
      await page.locator('.book-toc__found', { hasText: '没有找到' }).waitFor({ timeout: 30000 });
      await box.fill('');
      if (width === 420) await page.keyboard.press('Escape');
      await page.locator('.book-bar__more').evaluate(element => element.click());
      await page.locator('[role^="menuitem"]', { hasText: '整章连着读' }).click();
      await page.locator('.book-chapter').first().waitFor({ timeout: 30000 });
      await toc();
      await box.fill('独一无二');
      await hit.first().click();
      await page.locator(`[data-book-point="${target.hid}"]`).waitFor({ timeout: 30000 });
      await page.waitForFunction(() => window.CSS.highlights.get('study-find')?.size === 2, null, { timeout: 30000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, true, `${width}px: nothing scrolls sideways`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
