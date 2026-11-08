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

test('Browser E2E (#858): Today focus timer desktop side panel, reload recovery, Fullscreen Focus, manual log, and narrow sticky bottom bar', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s4-dist-'));
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
  const shots = process.env.TODAY_S4_SHOTS;
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
    title: '手写推导死锁银行家安全性序列',
    note: '核对 Available / Allocation / Need 三张矩阵每一步更新。',
    plannedDate: today,
    slot: 'am',
    slotDate: today,
  });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
  await page.goto(running.server.url);

  const timerPanel = page.locator('.board-timer');
  await timerPanel.waitFor({ timeout: 30000 });
  assert.match(await timerPanel.innerText(), /点卡片上的「开始专注」才开始计时/);

  // Click "开始专注" on our manual card
  const targetCard = page.locator('.board-card', { hasText: '手写推导死锁银行家安全性序列' });
  await targetCard.waitFor({ timeout: 15000 });
  await targetCard.getByRole('button', { name: /开始专注/ }).click();

  await timerPanel.locator('.board-timer__active').waitFor({ timeout: 10000 });
  assert.match(await timerPanel.locator('.board-timer__target').innerText(), /手写推导死锁银行家安全性序列/);
  await settleAnimations(page);
  assert.ok((await sideways(page)) <= 0, '1280px dark: no horizontal overflow with side timer');
  if (shots) await page.screenshot({ path: join(shots, 's4-desktop-side-timer-1280-dark.png') });

  // Pause -> reload -> verify persisted paused timer recovers cleanly
  await timerPanel.getByRole('button', { name: '暂停', exact: true }).click();
  await timerPanel.locator('.board-timer__clock[data-timer-state="paused"]').waitFor({ timeout: 5000 });
  await page.reload();
  await timerPanel.locator('.board-timer__clock[data-timer-state="paused"]').waitFor({ timeout: 20000 });
  await timerPanel.getByRole('button', { name: '继续', exact: true }).click();
  await timerPanel.locator('.board-timer__clock[data-timer-state="running"]').waitFor({ timeout: 5000 });

  // Open Fullscreen Focus modal and capture screenshot
  await timerPanel.getByRole('button', { name: '全屏专注' }).click();
  const focusDialog = page.locator('dialog.board-focus-dialog[open]');
  await focusDialog.waitFor({ timeout: 5000 });
  assert.match(await focusDialog.locator('.board-focus-stage__title').innerText(), /手写推导死锁银行家安全性序列/);
  await settleAnimations(page);
  if (shots) await page.screenshot({ path: join(shots, 's4-fullscreen-focus-1280-dark.png') });

  // Complete session from inside Fullscreen Focus -> closes modal & records actualMinutes
  await focusDialog.getByRole('button', { name: /完成，记 \d+ 分钟/ }).click();
  await focusDialog.waitFor({ state: 'detached', timeout: 10000 });
  await targetCard.locator('.board-duration--actual').waitFor({ timeout: 10000 });
  assert.match(await targetCard.locator('.board-duration--actual').innerText(), /实际 \d+ 分钟/);

  // Backfill a 20-minute session via "补记一段"
  await timerPanel.getByRole('button', { name: '补记一段' }).click();
  const manualForm = timerPanel.locator('form[aria-label="补记一段"]');
  await manualForm.waitFor({ timeout: 5000 });
  await manualForm.locator('input[type="number"]').fill('20');
  await manualForm.getByRole('button', { name: '记录这一段' }).click();
  await manualForm.waitFor({ state: 'detached', timeout: 10000 });
  assert.match(await timerPanel.locator('.board-timer__summary').innerText(), /今日已专注 21 分钟/);
  assert.match(await page.locator('.board-today__focus-budget-label').innerText(), /已专注 21 分钟/);

  assert.deepEqual(errors, []);
  await context.close();

  // Narrow viewport (390x844, light theme): start timer and verify sticky bottom bar
  const narrow = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 390, height: 844 });
  await narrow.page.goto(running.server.url);
  const narrowCard = narrow.page.locator('.board-card', { hasText: '手写推导死锁银行家安全性序列' });
  await narrowCard.waitFor({ timeout: 30000 });
  await narrowCard.getByRole('button', { name: /开始专注/ }).click();

  const stickyBar = narrow.page.locator('.board-timer-bar');
  await stickyBar.waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await stickyBar.locator('.board-timer-bar__title').innerText(), /手写推导死锁银行家安全性序列/);
  assert.equal(await stickyBar.getByRole('button', { name: '暂停', exact: true }).isVisible(), true);
  await settleAnimations(narrow.page);
  assert.ok((await sideways(narrow.page)) <= 0, '390px light: no horizontal overflow with sticky timer bar');
  if (shots) await narrow.page.screenshot({ path: join(shots, 's4-narrow-sticky-bar-390-light.png') });
  assert.deepEqual(narrow.errors, []);
  await narrow.context.close();
});
