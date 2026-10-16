/* global document window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, holdActions, openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';

/* 复习全书 S2 (ui/DESIGN.md "Late content"): the 期末一周 plan (book.crunch) and 本节问答 (course.outline.qa) come late. Inside the 期末一周 the reading surface waits
   for the plan, so its first paint is final: the bar's 今天 2/4, the 目录's 今天 and the end button. Outside it the book draws at once with the end button's
   default disabled in its final height; when the plan comes nothing above the fold moves, and once enabled the button keeps its words. 本节问答 (N) never waits
   for course.outline.qa: course.book.open counts it. The 'questions' fixture (most points with questions, two with a Q&A), 1280 and 420 px. */

const ABOVE = ['.book-bar', '.book-step__heading', '.book-point__gist', '.book-point__part', '.book-toc__head', '.book-toc__item', '.book-end'];
const place = page => page.evaluate(selectors => Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].slice(0, 12)
  .map(element => { const box = element.getBoundingClientRect(); return box.top < window.innerHeight ? [Math.round(box.top), Math.round(box.height)] : null; }).filter(Boolean)])), ABOVE);
const endOf = page => page.evaluate(() => { const end = document.querySelector('.book-end'); return end ? { waiting: end.hasAttribute('data-waiting'), words: end.querySelector('.book-end__actions').innerText.replace(/\s+/g, ' ').trim(),
  disabled: !!end.querySelector('.book-end__primary:disabled') } : null; });

async function open(page, running) {
  await page.goto(running.server.url);
  await page.locator('[data-tour="nav-book"]').click({ timeout: 30000 });
}

test('the plan and 本节问答 come late: inside the 期末一周 the book waits for the plan; outside it nothing above the fold moves and the end button keeps its words', { timeout: 300000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-late-book-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: root => seedBookFixture(root, 'questions') });
  try {
    await running.api('focus.set', { course: BOOK_COURSE });
    for (const width of [1280, 420]) {
      // Inside the 期末一周 (the exam in five days): nothing of the reading surface until the plan is in, then all of it at once.
      {
        const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
        try {
          const hold = await holdActions(page, ['book.crunch', 'course.outline.qa']);
          await open(page, running);
          await until(() => hold.seen('book.crunch'), 'the page to ask for the plan');
          await page.locator('.book-page .sh-loading, .book-page [role="status"]').first().waitFor({ timeout: 30000 });
          await frames(page, 6);
          assert.equal(await page.locator('[data-book-point], .book-bar').count(), 0, `${width}px: no reading surface before the plan`);
          hold.release('book.crunch');
          await page.locator('.book-end').waitFor({ timeout: 30000 });
          await frames(page, 2);
          const first = await place(page), end = await endOf(page);
          assert.ok(first['.book-bar'].length && first['.book-step__heading'].length && first['.book-toc__head'].length >= (width < 900 ? 0 : 2), `${width}px: measured ${JSON.stringify(first)}`);
          assert.equal(end.waiting, false, `${width}px: the end button is final at the first paint`);
          assert.match(await page.locator('.book-bar__where').innerText(), /今天 1\/\d+/, `${width}px: the bar counts today's points at once`);
          await settleAnimations(page);
          await frames(page, 6);
          assert.deepEqual(await place(page), first, `${width}px: nothing moved after the first paint`);
          assert.deepEqual(await endOf(page), end, `${width}px: the end button kept its words`);
          assert.match(await page.locator('.book-point__actions').innerText(), /本节问答 \(1\)/, `${width}px: 本节问答 (1) without course.outline.qa`);
          assert.equal(hold.seen('course.outline.qa'), false, `${width}px: course.outline.qa is not asked to draw the point`);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    }
    // Outside the 期末一周 (the exam two months away): the book draws at once; the plan, held, comes later.
    await running.api('course.save', { name: BOOK_COURSE, exam: { date: addDays(localDate(), 60) } });
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      try {
        const hold = await holdActions(page, ['book.crunch', 'course.outline.qa']);
        await open(page, running);
        await page.locator('.book-end').waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await frames(page, 4);
        const before = await place(page), waiting = await endOf(page);
        assert.ok(before['.book-bar'].length && before['.book-point__gist'].length, `${width}px: measured ${JSON.stringify(before)}`);
        assert.deepEqual([waiting.waiting, waiting.disabled, waiting.words], [true, true, '读完了，下一个'], `${width}px: the default, disabled, while the plan is out`);
        assert.match(await page.locator('.book-bar__where').innerText(), /知识点 1\/16|^1\/16/, `${width}px: the book's order`);
        hold.release('book.crunch');
        await page.locator('.book-end:not([data-waiting])').waitFor({ timeout: 30000 });
        await frames(page, 4);
        const enabled = await endOf(page);
        assert.equal(enabled.disabled, false);
        assert.match(enabled.words, /^练 5 道 读完了，下一个$/, `${width}px: a point with questions: 练 5 道 first`);
        assert.deepEqual(await place(page), before, `${width}px: nothing above the fold moved when the plan came`);
        // Another answer of the plan (a reload of it) never swaps the words under the pointer.
        await page.locator('.book-end__primary').hover();
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await frames(page, 10);
        assert.deepEqual(await endOf(page), enabled, `${width}px: the end button keeps its words`);
        assert.equal(hold.seen('course.outline.qa'), false);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
