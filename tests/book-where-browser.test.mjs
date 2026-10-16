/* global document window CSS */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';
import { POINTS } from './helpers/book-topics.mjs';

/* 复习全书 S2, 「我在哪」 in the real page at 1280 and 420 px (docs/review-book.md): the 'archss' fixture (sixteen points without questions, the exam in five
   days). The 目录 has 今天 on top and 全书 under it; the bar counts today's points; a point ends in 读完了，下一个, which marks it (✓ in the 目录, 已读完 1) and goes to
   today's next point; 在书里找 (Ctrl+F) finds a word only a point not on screen has, and choosing it opens that point with the word painted; H12 typed jumps to
   that heading. Nothing scrolls sideways. Screenshots go to BOOK_WHERE_SHOTS when set. */

const words = locator => locator.innerText().then(text => text.replace(/\s+/g, ' ').trim());
const sideways = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('复习全书: 今天 in the 目录, the end button marks 读完 and goes on, 在书里找 over the whole book, H12 (1280 and 420 px)', { timeout: 300000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-where-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: root => seedBookFixture(root, 'archss') });
  const shots = process.env.BOOK_WHERE_SHOTS || null;
  try {
    await running.api('focus.set', { course: BOOK_COURSE });
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      const toc = async () => { if (width < 900) { await page.locator('.book-bar__toc').click(); await page.locator('.book-toc[data-overlay]').waitFor({ timeout: 30000 }); } };
      const untoc = async () => { if (width < 900) { await page.keyboard.press('Escape'); await page.locator('.book-toc').waitFor({ state: 'detached', timeout: 30000 }); } };
      try {
        await page.goto(running.server.url);
        await page.locator('[data-tour="nav-book"]').click({ timeout: 30000 });
        await page.locator('.book-end').waitFor({ timeout: 30000 });
        await settleAnimations(page);
        // The bar counts today's points; the 目录 lists them on top, then the whole book.
        assert.match(await words(page.locator('.book-bar__where')), /^今天 1\/5/, `${width}px: the bar counts today's points`);
        await toc();
        const today = page.locator('[data-book-today]');
        assert.match(await words(today.locator('.book-toc__head')), /^今天 5 个 · 已读完 0$/);
        const ids = await today.locator('.book-toc__go').allInnerTexts();
        assert.equal(ids.length, 5);
        assert.match(await words(page.locator('.book-toc__group').nth(1).locator('.book-toc__head')), /^全书 · 已读完 0\/16$/);
        assert.equal(await page.locator('.book-toc__item').count(), await page.locator('.book-toc__item .book-toc__mark').count(), `${width}px: every row has its mark slot`);
        await untoc();

        // The end button: 读完了，下一个 marks the point and goes to today's next one; back, the point says 下一个 and the 目录 has its ✓.
        const end = page.locator('.book-end:not([data-waiting])');
        await end.scrollIntoViewIfNeeded();
        assert.match(await words(end), /^读完了，下一个 接下来：1\.1\.2 Architect the Solution \(Asset\)$/, `${width}px: the default end`);
        if (width < 900) {
          const [box, column] = await Promise.all([page.locator('.book-end__primary').boundingBox(), page.locator('.book-end').boundingBox()]);
          assert.ok(Math.abs(box.width - column.width) <= 1, `${width}px: the button takes the whole line (${box.width} of ${column.width})`);
        }
        if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `where-end-${width}.png`) }); }
        const first = await page.locator('[data-book-step]').getAttribute('data-book-step');
        await page.locator('.book-end__primary').click();
        await page.locator('.book-step__heading', { hasText: 'Architect the Solution' }).waitFor({ timeout: 30000 });
        assert.match(await words(page.locator('.book-bar__where')), /^今天 2\/5/);
        await page.locator('.book-bar__prev').click();
        await page.locator('.book-end[data-book-end="next"]').waitFor({ timeout: 30000 });
        await toc();
        assert.match(await words(today.locator('.book-toc__head')), /^今天 5 个 · 已读完 1$/);
        assert.equal(await page.locator(`.book-toc__item:has(.book-toc__go[aria-current="location"]) .book-toc__mark[data-mark="read"]`).count(), 2, `${width}px: ✓ in 今天 and in 全书`);
        if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `where-toc-${width}.png`) }); }
        await untoc();
        await running.api('book.crunch.mark', { course: BOOK_COURSE, hid: first, kind: 'read', on: false });

        // 在书里找: Ctrl+F while the book has the focus; a word only the last point has (not on screen); choosing it opens that point, the word painted.
        const word = POINTS.at(-1).example.slice(0, 6);
        await page.locator('.book-step__heading').click();
        await page.keyboard.press('Control+f');
        const field = page.locator('.book-find .reader-find__input');
        await field.waitFor({ timeout: 30000 });
        await page.waitForFunction(() => document.activeElement?.classList.contains('reader-find__input'), null, { timeout: 5000 });
        await page.keyboard.type(word);
        await page.locator('.book-find__hit').first().waitFor({ timeout: 30000 });
        assert.match(await words(page.locator('.book-find__hit').first()), new RegExp(`^4\\.2\\.2 ${POINTS.at(-1).title}`), `${width}px: the match names its point`);
        assert.match(await words(page.locator('.book-find .reader-find__count')), /^1 \/ \d+$/);
        assert.equal(await page.locator('.book-find__hit').filter({ hasText: 'AI' }).count() > 0, true, `${width}px: the AI blocks are searched (folded)`);
        if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `where-find-${width}.png`) }); }
        await page.locator('.book-find__hit').first().click();
        await page.locator('.book-step__heading', { hasText: POINTS.at(-1).title }).waitFor({ timeout: 30000 });
        await page.waitForFunction(() => CSS.highlights?.get('study-find-current')?.size === 1, null, { timeout: 10000 });
        if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `where-find-hit-${width}.png`) }); }
        // Shift+Enter from the first match goes round to the last one, in the point's folded AI block: the block opens and the word is painted inside it.
        await page.keyboard.press('Control+f');
        await field.waitFor({ timeout: 30000 });
        await page.waitForFunction(() => document.activeElement?.classList.contains('reader-find__input'), null, { timeout: 5000 });
        await field.press('Shift+Enter');
        await page.waitForFunction(() => {
          const range = [...(CSS.highlights?.get('study-find-current') || [])][0];
          return !!range?.startContainer?.parentElement?.closest('[data-ai-block]:not([data-ai-folded])');
        }, null, { timeout: 10000 });
        // H12 (any case): the jump comes first; Enter takes it.
        await page.keyboard.press('Control+f');
        await field.fill('h12');
        const jump = page.locator('.book-find__jump');
        await jump.waitFor({ timeout: 30000 });
        assert.match(await words(jump), /^跳到 H12 · /);
        await field.press('Enter');
        await page.waitForFunction(title => !document.querySelector('.book-step__heading')?.textContent.includes(title), POINTS.at(-1).title, { timeout: 30000 });
        await field.press('Escape').catch(() => {});
        assert.ok(await sideways(page) <= 0, `${width}px: nothing scrolls sideways`);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
