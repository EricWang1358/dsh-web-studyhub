/* global document, window, process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { COURSE, library as crunchLibrary } from './helpers/crunch-library.mjs';

test('Browser E2E (#861): Today upcoming study plan with plan, open-plan navigation, no-plan quiet entry, and narrow fold', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s7-dist-'));
  await buildPreview({ outdir: dist });

  const seed = async (root) => {
    await mkdir(root, { recursive: true });
    const service = new StudyService(root);
    await service.call('snapshot');
    const { state } = crunchLibrary();
    await service.store.update((own) => {
      own.sources.push(...state.sources);
      own.decks.push(...state.decks);
      own.focus = state.focus;
    });
    await service.call('course.book.open');
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 14) } });
    await service.call('course.save', {
      name: COURSE,
      plan: {
        version: 1,
        minutesPerDay: 45,
        restDates: [addDays(today, 2)],
        mockDates: [addDays(today, 3)],
      },
    });
    await service.dispose();
  };

  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.TODAY_S7_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  await running.api('daily.plan.profile', { date: today, weekdayMinutes: 50, weekendMinutes: 50 });
  const draft = await running.api('daily.plan.suggest', { date: today });
  if (draft.proposal?.id) await running.api('daily.plan.accept', { date: today, proposalId: draft.proposal.id });
  const b0 = await running.api('board.get', {});
  await running.api('board.card.add', {
    revision: b0.revision,
    title: '复盘系统架构关键决策题',
    plannedDate: today,
    slot: 'am',
    slotDate: today,
  });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 920 });
  await page.goto(running.server.url);

  // 1. Desktop with active plan: shows "备考计划 · 接下来", next 3 days (learn, rest, mock), and "打开备考计划" link
  const upcoming = page.locator('section.board-upcoming[data-plan-state="plan"]');
  await upcoming.waitFor({ timeout: 30000 });
  await settleAnimations(page);

  assert.equal(await upcoming.locator('.board-upcoming__more-toggle').isVisible(), false, 'desktop shows panel inline without narrow disclosure');
  const rows = upcoming.locator('.board-upcoming__day');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).innerText(), /读 /);
  assert.match(await rows.nth(1).innerText(), /休息/);
  assert.match(await rows.nth(2).innerText(), /模拟考 · 整套模拟卷/);
  assert.ok((await sideways(page)) <= 0, '1280px dark with plan: no horizontal overflow');
  if (shots) await page.screenshot({ path: join(shots, 's7-with-plan-1280-dark.png') });

  // 2. Clicking "打开备考计划" opens the review book page with the study plan section visible
  await upcoming.getByRole('button', { name: '打开备考计划' }).click();
  await page.locator('section.book-plan[data-plan="plan"]').waitFor({ timeout: 20000 });

  // 3. Narrow 390x844 light: "备考计划 · 接下来" folds into "更多 · 备考计划" and expands on click
  const narrow = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 390, height: 844 });
  await narrow.page.goto(running.server.url);
  const narrowUpcoming = narrow.page.locator('section.board-upcoming[data-plan-state="plan"]');
  await narrowUpcoming.waitFor({ timeout: 30000 });
  await settleAnimations(narrow.page);

  const moreBtn = narrowUpcoming.getByRole('button', { name: '更多 · 备考计划' });
  assert.equal(await moreBtn.isVisible(), true, 'narrow viewport shows More disclosure button');
  assert.equal(await moreBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(await narrowUpcoming.locator('.board-upcoming__panel').isVisible(), false, 'panel starts folded on narrow viewport');
  await narrowUpcoming.scrollIntoViewIfNeeded();
  await settleAnimations(narrow.page);
  assert.ok((await sideways(narrow.page)) <= 0, '390px light folded: no horizontal overflow');
  if (shots) await narrow.page.screenshot({ path: join(shots, 's7-narrow-390-light.png') });

  await moreBtn.click();
  assert.equal(await moreBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(await narrowUpcoming.locator('.board-upcoming__panel').isVisible(), true, 'panel expands when More is clicked');
  assert.equal(await narrowUpcoming.locator('.board-upcoming__day').count(), 3);
  assert.ok((await sideways(narrow.page)) <= 0, '390px light expanded: no horizontal overflow');
  assert.deepEqual(narrow.errors, []);
  await narrow.context.close();

  // 4. Without plan: clear the course plan -> Today shows single quiet "建一个备考计划" entry
  await running.api('course.save', { name: COURSE, plan: null });
  await page.goto(running.server.url);
  // With no active plan and a card scheduled today, initial landing still opens Today
  const emptyPlan = page.locator('section.board-upcoming[data-plan-state="empty"]');
  await emptyPlan.waitFor({ timeout: 30000 });
  await settleAnimations(page);
  assert.match(await emptyPlan.innerText(), /还没有备考计划/);
  const createBtn = emptyPlan.getByRole('button', { name: '建一个备考计划' });
  assert.equal(await createBtn.isVisible(), true);
  assert.ok((await sideways(page)) <= 0, '1280px dark without plan: no horizontal overflow');
  if (shots) await page.screenshot({ path: join(shots, 's7-no-plan-1280-dark.png') });

  await createBtn.click();
  await page.locator('p.book-plan--quiet[data-plan="invite"]').waitFor({ timeout: 20000 });

  assert.deepEqual(errors, []);
  await context.close();
});
