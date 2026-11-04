/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 3.0.2: the mistakes page in a real browser, at a desktop and a phone width. It opens grouped by deck with every group folded; one click
   narrows it to one deck; the generate button says how many questions it will act on; the page has no refresh button and keeps itself up to date
   (a quiet check moves nothing and closes nothing, a mistake corrected elsewhere is gone without a click, #675); and nothing scrolls sideways. 48 mistakes in the course the page opens on, over two decks of 24 (scripts/qa/layout-late.mjs); the second width starts with one of them corrected by the first. */

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
  const store = new Store(join(running.base, 'library'));
  try {
    for (const [round, width] of [1280, 420].entries()) {
      const { page, errors, context } = await openPage(browser, running, { width });
      // The first width corrects one mistake of the deck that gets narrowed to (step 6), so the second starts with one fewer.
      const all = 48 - round, deck = 24 - round;
      let reads = 0;
      page.on('request', (request) => { if (request.url().includes('/api/call') && /"action":"wrongbook"/.test(request.postData() || '')) reads++; });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      const nav = await revealNavRow(page, 'wrongbook');
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
      assert.match(first.result, new RegExp(`显示 ${all} / 共 ${all} 题`));
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
      assert.match(narrowed.result, new RegExp(`显示 ${deck} / 共 ${all} 题`));
      assert.deepEqual(narrowed.heads.map((head) => head.open), [true], `${width}px: the deck the learner asked for is open`);
      assert.equal(narrowed.rows, deck);
      if (hasBatch) assert.match(narrowed.batch, new RegExp(`为当前筛选的 ${deck} 题生成变式`));
      assert.equal(narrowed.scrollsSideways, false, `${width}px: no sideways scroll when open (${narrowed.wide.join(', ')})`);
      await page.screenshot({ path: join(running.base, `narrowed-${width}.png`) });

      // 3. No refresh button. The page asks by itself (here nudged by the tab coming back); asking moves nothing, closes nothing, forgets no filter.
      assert.equal(await page.getByRole('button', { name: '刷新' }).count(), 0, `${width}px: no refresh button`);
      await drainLayoutStability(page);
      const before = reads;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await until(() => reads > before, 'the page to check the mistakes again by itself');
      await frames(page, 10);
      await settleAnimations(page);
      const log = await drainLayoutStability(page);
      const verdict = judgeLayoutStability(log);
      const again = await readState(page);
      assert.deepEqual(again.heads, narrowed.heads, `${width}px: the open group stays open`);
      assert.equal(again.rows, deck);
      assert.match(again.result, new RegExp(`显示 ${deck} / 共 ${all} 题`), 'the filter survives the refresh');
      assert.ok(Math.abs(again.filterBox.y - narrowed.filterBox.y) <= 1 && Math.abs(again.headBox.y - narrowed.headBox.y) <= 1, `${width}px: the list moved on refresh`);
      assert.ok(verdict.cls <= 0.05, `${width}px: CLS ${verdict.cls}`);
      assert.equal(verdict.rowResizes, 0);

      // 4. Clearing brings every deck back; the one that was open stays open.
      await page.getByRole('button', { name: '清除筛选' }).first().dispatchEvent('click');
      await until(async () => (await readState(page)).heads.length === 2, 'the filter to clear');
      const cleared = await readState(page);
      assert.equal(cleared.heads.filter((head) => head.open).length, 1);
      assert.match(cleared.result, new RegExp(`显示 ${all} / 共 ${all} 题`));

      // Coming back from another page (or from practice) keeps the group open for this tab; the filter starts clean.
      await (await revealNavRow(page, 'library')).dispatchEvent('click');
      await page.locator('.wb-group-toggle').first().waitFor({ state: 'detached', timeout: 30000 });
      await (await revealNavRow(page, 'wrongbook')).dispatchEvent('click');
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

      // 6. A mistake corrected somewhere else leaves the list without a click: the quiet check sees the new count and reads the list again.
      const total = Number((await readState(page)).result.match(/共 (\d+) 题/)[1]);
      await store.update((library) => {
        const deck = library.decks[0], card = deck.cards[round];
        library.attempts.push({ id: `fixed-${round}`, runId: library.runs[0].id, quiz_id: card.id, deckId: deck.id, topic: card.topic,
          timestamp: new Date(Date.UTC(2026, 9, 1) + round * 60_000).toISOString(), grade: 4, elapsed_ms: 3000,
          before: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, after: { repetitions: 1, interval_days: 1, ease_factor: 2.5, due_at: null } });
      });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await until(async () => new RegExp(`共 ${total - 1} 题`).test((await readState(page)).result), 'the corrected mistake to leave the list by itself', { timeoutMs: 60000 });
      assert.equal((await readState(page)).heads.filter((head) => head.open).length, 1, `${width}px: the open group stays open`);

      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
