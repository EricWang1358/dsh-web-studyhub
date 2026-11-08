/* global document window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { COURSE, library } from './helpers/crunch-library.mjs';

/* 深度定制 (4.4 S3): a weekly 备考计划 with no exam date in the real pages. The home has a 本周 card (「本周：第 1 章」, today's day, the way into the book) and the review book's
   备考计划 section says the same line instead of an exam countdown, with today's day and no hand-over to 期末一周. Zh dark at 1440 and English light at 420 px, nothing scrolls
   sideways; pictures go to WEEKLY_SHOTS (output/qa/custom-apply-s3/ by hand). */

const PLAN = { version: 1, by: 'weekly', chaptersPerWeek: 2, minutesPerDay: 60 };

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { state } = library();
  await service.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  await service.call('course.book.open');
  await service.call('course.save', { name: COURSE, plan: PLAN });
  await service.dispose();
}

const sideways = page => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth }));

test('a weekly plan with no exam date: 「本周：第 1 章」 on the home and in the book (zh dark 1440, en light 420)', { timeout: 300000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-custom-weekly-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.WEEKLY_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const cases = [{ lang: 'zh', theme: 'dark', width: 1440, line: '本周：第 1 章', card: '本周 · SA' }, { lang: 'en', theme: 'light', width: 420, line: 'This week: chapter 1', card: 'This week · SA' }];
  try {
    for (const { lang, theme, width, line, card } of cases) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors } = await openPage(browser, running, { lang, theme, width, height: 900 });
      await page.goto(running.server.url);
      await page.locator('.board-today').waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'library')).click();
      const home = page.locator('.crunch-card[data-tour="home-weekly"]');
      await home.waitFor({ timeout: 30000 });
      const text = await home.innerText();
      assert.ok(text.includes(card) && text.includes(line), `${width}px home card: ${text}`);
      assert.equal(await home.locator('.crunch-day__point').count() > 0, true, 'today has points to read');
      assert.ok(!/距考试|exam in|days to the exam/i.test(text), 'no exam countdown');
      assert.ok((await sideways(page)).doc <= 0, `${width}px: the home does not scroll sideways`);
      await settleAnimations(page);
      if (shots) { await home.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `home-weekly-${lang}-${theme}-${width}.png`) }); }

      await home.locator('[data-usage="home.weekly"]').click();
      const section = page.locator('.book-plan[data-plan="plan"]');
      await section.waitFor({ timeout: 30000 });
      const book = await section.innerText();
      assert.ok(book.includes(line), `${width}px book section: ${book}`);
      assert.equal(await section.locator('.book-plan__weekline').count(), 1);
      assert.equal(await section.locator('.crunch-day').count(), 1, "today's day once");
      assert.equal(await section.locator('.book-plan__handover').count(), 0, 'no hand-over to the final week: there is no exam');
      assert.ok(!/距考试|exam in|days to the exam/i.test(book), 'no exam countdown in the section either');
      assert.ok((await sideways(page)).doc <= 0, `${width}px: the book page does not scroll sideways`);
      await settleAnimations(page);
      if (shots) { await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `book-weekly-${lang}-${theme}-${width}.png`) }); }
      assert.deepEqual(errors.filter(error => !/favicon|Failed to load resource/i.test(error)), [], `${width}px: no console errors`);
      await page.close();
    }
  } finally {
    await browser.close();
    await running.close();
  }
});
