/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';

/* 3.0.2: the mistakes page in a real browser, at a desktop and a phone width. It opens grouped by deck with every group folded; one click
   narrows it to one deck; the generate button says how many questions it will act on; a refresh moves nothing and closes nothing; and nothing
   scrolls sideways. 48 mistakes in the course the page opens on, over two decks of 24 (scripts/qa/layout-late.mjs). */

const readState = (page) => page.evaluate(() => {
  const text = (element) => element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const scroller = document.scrollingElement;
  const wide = [...document.querySelectorAll('.wb, .wb *')].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1
    && getComputedStyle(element).position !== 'fixed' && !element.closest('[popover]'));
  return {
    heads: [...document.querySelectorAll('.wb-group-toggle')].map((element) => ({ title: text(element.querySelector('strong')), open: element.getAttribute('aria-expanded') === 'true' })),
    rows: document.querySelectorAll('.wb-row').length,
    groupBy: text(document.querySelector('.wb-view [aria-pressed="true"]')),
    result: text(document.querySelector('.wb-filter-result')),
    batch: text(document.querySelector('.wb-batch .sh-btn')),
    scrollsSideways: scroller.scrollWidth > scroller.clientWidth + 1,
    wide: wide.slice(0, 3).map((element) => `${element.tagName}.${element.className} ${Math.round(element.getBoundingClientRect().right)}`),
    filterBox: (() => { const box = document.querySelector('.wb-filter')?.getBoundingClientRect(); return box ? { y: Math.round(box.top), height: Math.round(box.height) } : null; })(),
    headBox: (() => { const box = document.querySelector('.wb-group')?.getBoundingClientRect(); return box ? { y: Math.round(box.top), height: Math.round(box.height) } : null; })(),
  };
});

test('mistakes page: folded by deck, one-click deck filter, honest generate button, steady on refresh (1280 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-wb-filters-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedWrongBookLibrary(root, { wrong: 72 }) });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width });
      let reads = 0;
      page.on('request', (request) => { if (request.url().includes('/api/call') && /"action":"wrongbook"/.test(request.postData() || '')) reads++; });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      const nav = page.locator('[data-tour="nav-wrongbook"]').first();
      await nav.waitFor({ state: 'visible' });
      await nav.dispatchEvent('click');
      await page.locator('.wb-group-toggle').first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await frames(page, 4);

      // 1. Folded, by deck, with the count line.
      const first = await readState(page);
      assert.equal(first.rows, 0, `${width}px: no question row while folded`);
      assert.equal(first.heads.length, 2, `${width}px: one header per deck that has mistakes`);
      assert.ok(first.heads.every((head) => !head.open), `${width}px: every group folded`);
      assert.equal(first.groupBy, '按题组');
      assert.match(first.result, /显示 48 \/ 共 48 题/);
      assert.equal(first.scrollsSideways, false, `${width}px: no sideways scroll (${first.wide.join(', ')})`);
      assert.equal(await page.locator('.wb-group-actions').first().isVisible(), true, `${width}px: the group action is on the header`);
      await page.screenshot({ path: join(running.base, `folded-${width}.png`) });

      // 2. Only this deck: one group left, opened, and the button counts the filtered questions.
      const hasBatch = (await page.locator('.wb-batch .sh-btn').count()) > 0;
      if (hasBatch) assert.match(first.batch, /为全部错题生成变式/);
      await page.locator('.wb-group-actions').nth(1).getByRole('button', { name: '只看这个题组' }).dispatchEvent('click');
      await until(async () => (await readState(page)).heads.length === 1, 'the list to narrow to one deck');
      await frames(page, 4);
      const narrowed = await readState(page);
      assert.match(narrowed.result, /显示 24 \/ 共 48 题/);
      assert.deepEqual(narrowed.heads.map((head) => head.open), [true], `${width}px: the deck the learner asked for is open`);
      assert.equal(narrowed.rows, 24);
      if (hasBatch) assert.match(narrowed.batch, /为当前筛选的 24 题生成变式/);
      assert.equal(narrowed.scrollsSideways, false, `${width}px: no sideways scroll when open (${narrowed.wide.join(', ')})`);
      await page.screenshot({ path: join(running.base, `narrowed-${width}.png`) });

      // 3. A refresh moves nothing, closes nothing, forgets no filter.
      await drainLayoutStability(page);
      const before = reads;
      await page.getByRole('button', { name: '刷新' }).first().dispatchEvent('click');
      await until(() => reads > before, 'the page to read the mistakes again');
      await frames(page, 10);
      await settleAnimations(page);
      const log = await drainLayoutStability(page);
      const verdict = judgeLayoutStability(log);
      const again = await readState(page);
      assert.deepEqual(again.heads, narrowed.heads, `${width}px: the open group stays open`);
      assert.equal(again.rows, 24);
      assert.match(again.result, /显示 24 \/ 共 48 题/, 'the filter survives the refresh');
      assert.ok(Math.abs(again.filterBox.y - narrowed.filterBox.y) <= 1 && Math.abs(again.headBox.y - narrowed.headBox.y) <= 1, `${width}px: the list moved on refresh`);
      assert.ok(verdict.cls <= 0.05, `${width}px: CLS ${verdict.cls}`);
      assert.equal(verdict.rowResizes, 0);

      // 4. Clearing brings every deck back; the one that was open stays open.
      await page.getByRole('button', { name: '清除筛选' }).first().dispatchEvent('click');
      await until(async () => (await readState(page)).heads.length === 2, 'the filter to clear');
      const cleared = await readState(page);
      assert.equal(cleared.heads.filter((head) => head.open).length, 1);
      assert.match(cleared.result, /显示 48 \/ 共 48 题/);

      // Coming back from another page (or from practice) keeps the group open for this tab; the filter starts clean.
      await page.locator('[data-tour="nav-library"]').first().dispatchEvent('click');
      await page.locator('.wb-group-toggle').first().waitFor({ state: 'detached', timeout: 30000 });
      await nav.dispatchEvent('click');
      await page.locator('.wb-group-toggle').first().waitFor({ timeout: 30000 });
      const back = await readState(page);
      assert.equal(back.heads.length, 2);
      assert.equal(back.heads.filter((head) => head.open).length, 1, `${width}px: the group that was open is still open after coming back`);

      // 5. The text filter narrows across decks.
      await page.getByRole('searchbox', { name: '搜索题目或主题' }).fill('zzz-no-such-question');
      await until(async () => /显示 0 \//.test((await readState(page)).result), 'the search to empty the list');
      assert.match(await page.locator('.wb-filter-empty').innerText(), /没有符合筛选的错题/);
      await page.getByRole('button', { name: '清除筛选' }).last().dispatchEvent('click');
      await until(async () => (await readState(page)).heads.length === 2, 'the filter to clear again');

      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
