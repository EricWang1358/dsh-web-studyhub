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

test('Browser E2E (#859): Study Stats focus duration empty state, 7-day bar chart + shared tooltip, edit/delete syncing with Today Board, and 390px narrow layout', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s5-dist-'));
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
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 30) } });
    await service.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
    await service.dispose();
  };

  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.TODAY_S5_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  // 1. Empty state on Study Stats (1280x900 dark): single quiet sentence, no chart SVG
  const desktop = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
  await desktop.page.goto(running.server.url);
  await (await revealNavRow(desktop.page, 'dashboard')).click();

  const focusPanel = desktop.page.locator('.dash-focus-panel');
  await focusPanel.waitFor({ timeout: 30000 });
  assert.match(await focusPanel.innerText(), /还没有专注记录。在「待办 → 今日」点击卡片上的「开始专注」后会记在这里。/);
  assert.equal(await focusPanel.locator('svg.dash-svg').count(), 0, 'empty focus panel should not render an empty chart box');

  // Verify `?` tooltip explains manual-only start and local-only storage
  const helpIcon = focusPanel.locator('.dash-focus__help');
  await helpIcon.hover();
  const helpTooltip = desktop.page.locator('[role="tooltip"]', { hasText: '只计算手动点击' });
  await helpTooltip.waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await helpTooltip.innerText(), /只计算手动点击「开始专注」或「补记一段」的时长；数据仅保存在本机，不会上传。/);
  await desktop.page.mouse.move(10, 10);
  await settleAnimations(desktop.page);
  assert.ok((await sideways(desktop.page)) <= 0, '1280px empty state: no horizontal overflow');
  if (shots) {
    await focusPanel.scrollIntoViewIfNeeded();
    await settleAnimations(desktop.page);
    await desktop.page.screenshot({ path: join(shots, 's5-empty-1280-dark.png') });
  }

  // 2. Seed 7-day focus sessions + today sessions via board API, then refresh Study Stats
  let b = await running.api('board.get', {});
  b = await running.api('board.card.add', {
    revision: b.revision,
    title: '推导银行家安全性序列',
    plannedDate: today,
    slot: 'am',
    slotDate: today,
  });
  const cardId = b.columns[0].cardIds[0];
  b = await running.api('board.timeLog.add', {
    revision: b.revision,
    cardId,
    minutes: 35,
    date: addDays(today, -3),
    startedAt: `${addDays(today, -3)}T14:00:00.000Z`,
  });
  b = await running.api('board.timeLog.add', {
    revision: b.revision,
    cardId,
    minutes: 20,
    date: addDays(today, -1),
    startedAt: `${addDays(today, -1)}T15:30:00.000Z`,
  });
  b = await running.api('board.timeLog.add', {
    revision: b.revision,
    cardId,
    minutes: 25,
    date: today,
    startedAt: `${today}T09:10:00.000Z`,
  });
  b = await running.api('board.timeLog.add', {
    revision: b.revision,
    cardTitle: '复盘死锁错题集',
    minutes: 15,
    date: today,
    startedAt: `${today}T10:40:00.000Z`,
  });

  await desktop.page.getByRole('button', { name: '刷新', exact: true }).click();
  await focusPanel.locator('svg.dash-svg').waitFor({ timeout: 15000 });
  assert.match(await focusPanel.locator('[data-focus-today-total]').innerText(), /今日已专注 40 分钟/);
  assert.match(await focusPanel.locator('[data-focus-week-total]').innerText(), /近 7 天共 95 分钟/);
  assert.equal(await focusPanel.locator('g.dash-bar').count(), 7, 'renders 7 local calendar day bars');

  // Hover today's bar -> shared chart tooltip (.sh-tooltip--point) surfaces
  await focusPanel.scrollIntoViewIfNeeded();
  const todayBar = focusPanel.locator('g.dash-bar.today');
  await todayBar.hover();
  const barTip = focusPanel.locator('.sh-tooltip--point');
  await barTip.waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await barTip.innerText(), /今天 · 40 分钟/);
  assert.match(await barTip.innerText(), /2 段专注记录/);
  await settleAnimations(desktop.page);
  assert.ok((await sideways(desktop.page)) <= 0, '1280px populated state: no horizontal overflow');
  if (shots) await desktop.page.screenshot({ path: join(shots, 's5-with-data-1280-dark.png') });

  // Edit 25-min session -> 30 min, and delete 15-min session -> today becomes 30 min, week becomes 85 min
  await focusPanel.getByRole('button', { name: '修改时长：推导银行家安全性序列' }).click();
  const editForm = focusPanel.locator('.dash-focus__log-edit');
  await editForm.waitFor({ timeout: 5000 });
  await editForm.locator('input[type="number"]').fill('30');
  await editForm.getByRole('button', { name: '保存', exact: true }).click();
  await editForm.waitFor({ state: 'detached', timeout: 10000 });
  assert.match(await focusPanel.locator('[data-focus-today-total]').innerText(), /今日已专注 45 分钟/);
  assert.match(await focusPanel.locator('[data-focus-week-total]').innerText(), /近 7 天共 100 分钟/);

  await focusPanel.getByRole('button', { name: '删除记录：复盘死锁错题集' }).click();
  await desktop.page.waitForFunction(
    () => document.querySelector('[data-focus-today-total]')?.textContent?.includes('30'),
    null,
    { timeout: 10000 },
  );
  assert.match(await focusPanel.locator('[data-focus-today-total]').innerText(), /今日已专注 30 分钟/);
  assert.match(await focusPanel.locator('[data-focus-week-total]').innerText(), /近 7 天共 85 分钟/);

  // Navigate to Today Board via "去今日" -> verify Today Board shows the exact same 30 min total & card actualMinutes!
  await focusPanel.getByRole('button', { name: '去今日' }).click();
  const timerSummary = desktop.page.locator('.board-timer__summary');
  await timerSummary.waitFor({ timeout: 15000 });
  assert.match(await timerSummary.innerText(), /今日已专注 30 分钟/);
  const todayCard = desktop.page.locator('.board-card', { hasText: '推导银行家安全性序列' });
  assert.match(await todayCard.locator('.board-duration--actual').innerText(), /实际 85 分钟/);

  assert.deepEqual(desktop.errors, []);
  await desktop.context.close();

  // 3. Narrow viewport (390x844 light): open Study Stats and verify zero horizontal overflow
  const narrow = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 390, height: 844 });
  await narrow.page.goto(running.server.url);
  await (await revealNavRow(narrow.page, 'dashboard')).click();
  const narrowFocus = narrow.page.locator('.dash-focus-panel');
  await narrowFocus.locator('svg.dash-svg').waitFor({ timeout: 30000 });
  await narrowFocus.scrollIntoViewIfNeeded();
  await settleAnimations(narrow.page);
  assert.match(await narrowFocus.locator('[data-focus-today-total]').innerText(), /今日已专注 30 分钟/);
  assert.ok((await sideways(narrow.page)) <= 0, '390px light: no horizontal overflow on Study Stats focus panel');
  if (shots) await narrow.page.screenshot({ path: join(shots, 's5-narrow-390-light.png') });
  assert.deepEqual(narrow.errors, []);
  await narrow.context.close();
});
