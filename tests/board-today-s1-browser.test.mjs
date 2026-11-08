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
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { COURSE, library as crunchLibrary } from './helpers/crunch-library.mjs';

test('Browser E2E (#855): Today landing, quick-add, schedule chip, done-today strikethrough, tab switch, Home 去今日, and responsive widths (1280, 420, 390 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s1-dist-'));
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
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 25) } });
    await service.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
    await service.dispose();
  };

  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.TODAY_S1_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  // Seed one due-today card and one unscheduled card on the board.
  let seededBoard = await running.api('board.get');
  seededBoard = await running.api('board.card.add', { revision: seededBoard.revision, title: '复习第 2 章错题', due: today, labels: ['复习'] });
  await running.api('board.card.add', { revision: seededBoard.revision, title: '整理实验报告提纲', labels: ['写作'] });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 860 });
  await page.goto(running.server.url);

  // Decision 1: active course.plan lands directly on 待办 → 今日.
  const todayRoot = page.locator('.board-today');
  await todayRoot.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.study-app').getAttribute('data-usage-area'), 'board');
  assert.match(await todayRoot.locator('.board-today__plan').innerText(), /SA · .*距考试 25 天/);
  assert.ok((await sideways(page)) <= 0, '1280px: no horizontal overflow');

  // Quick-add a card directly into Today.
  await todayRoot.getByPlaceholder('记一条今天要做的事…').fill('做 10 道概念辨析');
  await todayRoot.getByRole('button', { name: '记一条' }).click();
  await todayRoot.locator('.board-card__title', { hasText: '做 10 道概念辨析' }).waitFor({ timeout: 15000 });

  // Pull an unscheduled card into Today with one click.
  const pick = todayRoot.getByRole('button', { name: '排到今天：整理实验报告提纲' });
  await pick.waitFor({ timeout: 15000 });
  await pick.click();
  await todayRoot.locator('.board-card__title', { hasText: '整理实验报告提纲' }).waitFor({ timeout: 15000 });
  assert.equal(await todayRoot.locator('.board-today__backlog').count(), 0, 'backlog hides once all cards are scheduled');

  // Check one card done: stays visible under 今天已完成 with strikethrough.
  await todayRoot.getByRole('checkbox', { name: '标记完成：做 10 道概念辨析' }).click();
  await todayRoot.locator('.board-today__done').waitFor({ timeout: 15000 });
  assert.match(await todayRoot.locator('.board-today__done').innerText(), /今天已完成 · 1/);
  assert.equal(await todayRoot.locator('.board-today__done .board-card.is-done').count(), 1);
  await settleAnimations(page);
  if (shots) await page.screenshot({ path: join(shots, 'today-populated-1280-dark.png') });

  // Switch to 全部待办: 3 columns intact.
  await page.getByRole('tab', { name: '全部待办' }).click();
  await page.locator('.board-columns').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.board-column:not(.board-column--new)').count(), 3);
  if (shots) await page.screenshot({ path: join(shots, 'board-all-1280-dark.png') });

  // Navigate to 学习库, then click 去今日 on Home's DailyPlan -> lands back on 待办 → 今日.
  await (await revealNavRow(page, 'library')).click();
  const goToday = page.locator('.daily-plan').getByRole('button', { name: '去今日' });
  await goToday.waitFor({ timeout: 30000 });
  await goToday.click();
  await todayRoot.waitFor({ timeout: 15000 });

  // Narrow viewports (420px and 390px): zero horizontal overflow.
  for (const width of [420, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await settleAnimations(page);
    assert.ok((await sideways(page)) <= 0, `${width}px: no horizontal overflow on Today`);
    if (shots) await page.screenshot({ path: join(shots, `today-populated-${width}-dark.png`) });
  }

  assert.deepEqual(errors.filter((line) => !/favicon|status of 400/.test(line)), [], 'no page console errors');
  await context.close();

  // Decision 1 negative check: without an active plan and without open Today items, StudyHub opens on 学习库.
  await running.api('course.save', { name: COURSE, plan: null });
  let currentBoard = await running.api('board.get');
  for (const id of Object.keys(currentBoard.cards)) {
    currentBoard = await running.api('board.card.remove', { revision: currentBoard.revision, id });
  }
  const fresh = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 860 });
  await fresh.page.goto(running.server.url);
  await fresh.page.locator('[data-usage-area="library"]').waitFor({ timeout: 30000 });
  assert.equal(await fresh.page.locator('.board-today').count(), 0, 'lands on 学习库 when no plan and no open Today cards exist');

  // Empty Today state check when user navigates to 待办.
  await (await revealNavRow(fresh.page, 'board')).click();
  await fresh.page.locator('.board-today__empty').waitFor({ timeout: 15000 });
  assert.match(await fresh.page.locator('.board-today__empty').innerText(), /今天还没有排事。/);
  await settleAnimations(fresh.page);
  if (shots) await fresh.page.screenshot({ path: join(shots, 'today-empty-1280-light.png') });
  await fresh.context.close();
});
