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

test('Browser E2E (#860): Today sticky memos empty state, + 新备忘 & 记一条 authoring, collapse/edit/archive/delete/undo, and narrow layout', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s6-dist-'));
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
  const shots = process.env.TODAY_S6_SHOTS;
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
    title: '推导死锁银行家安全性序列',
    plannedDate: today,
    slot: 'am',
    slotDate: today,
  });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 920 });
  await page.goto(running.server.url);

  const memosPanel = page.locator('section.board-memos');
  await memosPanel.waitFor({ timeout: 30000 });
  await settleAnimations(page);

  // 1. Empty state screenshot: single line "写下你的想法…"
  const emptyPrompt = memosPanel.locator('.board-memos__empty');
  await emptyPrompt.waitFor({ timeout: 5000 });
  assert.equal((await emptyPrompt.innerText()).trim(), '写下你的想法…');
  assert.ok((await sideways(page)) <= 0, '1280px dark empty memos: no horizontal overflow');
  if (shots) await page.screenshot({ path: join(shots, 's6-empty-1280-dark.png') });

  // 2. Add memo #1 via "+ 新备忘" button (unpinned -> stays until archived)
  await memosPanel.getByRole('button', { name: '新备忘' }).click();
  const newForm = memosPanel.locator('form[aria-label="新备忘"]');
  await newForm.waitFor({ timeout: 5000 });
  await newForm.getByLabel('备忘内容').fill('周四答疑记得问老师：PV 操作信号量初值怎么写才不扣步骤分？');
  await newForm.getByRole('button', { name: '保存备忘' }).click();
  await memosPanel.locator('.board-memo', { hasText: '周四答疑记得问老师' }).waitFor({ timeout: 10000 });

  // 3. Add memo #2 (long multi-line + pinned to today) via "+ 新备忘"
  await memosPanel.getByRole('button', { name: '新备忘' }).click();
  await newForm.waitFor({ timeout: 5000 });
  await newForm.getByLabel('备忘内容').fill([
    '银行家算法考场速查步骤：',
    '1. 先列 Need = Max - Allocation 矩阵；',
    '2. 核对 Request_i <= Need_i，越界直接判错；',
    '3. 核对 Request_i <= Available，不足则进程等待；',
    '4. 试分配更新 Available / Allocation / Need；',
    '5. 跑 Work + Finish 安全性序列，写出完整序列才给满分！',
  ].join('\n'));
  await newForm.locator('input[type="date"]').fill(today);
  await newForm.getByRole('button', { name: '保存备忘' }).click();
  await memosPanel.locator('.board-memo', { hasText: '银行家算法考场速查步骤' }).waitFor({ timeout: 10000 });

  // 4. Add memo #3 via top "记一条" switched to "备忘" mode
  const quickBar = page.locator('.board-today__quick');
  await quickBar.getByRole('button', { name: '备忘', exact: true }).click();
  const quickInput = quickBar.getByLabel('记一条', { exact: true });
  assert.equal(await quickInput.getAttribute('placeholder'), '写下你的想法…');
  await quickInput.fill('把虚拟内存页表两级映射画成草图贴在书桌旁');
  await quickBar.getByRole('button', { name: '记一条' }).click();
  await memosPanel.locator('.board-memo', { hasText: '把虚拟内存页表两级映射画成草图贴在书桌旁' }).waitFor({ timeout: 10000 });

  // Verify reverse-chronological order (memo #3 newest first, then #2, then #1)
  const items = memosPanel.locator('.board-memo');
  assert.equal(await items.count(), 3);
  assert.match(await items.nth(0).innerText(), /把虚拟内存页表两级映射/);
  assert.match(await items.nth(1).innerText(), /银行家算法考场速查步骤/);
  assert.match(await items.nth(1).innerText(), /挂在 /);
  assert.match(await items.nth(2).innerText(), /周四答疑记得问老师/);

  await settleAnimations(page);
  assert.ok((await sideways(page)) <= 0, '1280px dark 3 memos: no horizontal overflow');
  if (shots) await page.screenshot({ path: join(shots, 's6-memos-1280-dark.png') });

  // 5. Long memo expand / collapse
  const longItem = items.nth(1);
  assert.equal(await longItem.locator('.board-memo__text').getAttribute('data-collapsed'), 'true');
  await longItem.getByRole('button', { name: '展开' }).click();
  assert.equal(await longItem.locator('.board-memo__text').getAttribute('data-collapsed'), 'false');
  await longItem.getByRole('button', { name: '收起' }).click();
  assert.equal(await longItem.locator('.board-memo__text').getAttribute('data-collapsed'), 'true');

  // 6. Edit memo #3 + Undo
  await items.nth(0).getByRole('button', { name: /编辑备忘/ }).click();
  const editArea = memosPanel.locator('.board-memo__edit textarea');
  await editArea.waitFor({ timeout: 5000 });
  await editArea.fill('把虚拟内存页表三级映射画成草图（已核对 TLB 命中率公式）');
  await memosPanel.locator('.board-memo__edit').getByRole('button', { name: '保存', exact: true }).click();
  await memosPanel.locator('.board-memo', { hasText: '三级映射画成草图' }).waitFor({ timeout: 10000 });
  await page.locator('.sh-toast').getByRole('button', { name: '撤销' }).click();
  await memosPanel.locator('.board-memo', { hasText: '两级映射画成草图' }).waitFor({ timeout: 10000 });

  // 7. Archive memo #1 + Undo
  await items.nth(2).getByRole('button', { name: /归档备忘/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.board-memo').length === 2, null, { timeout: 10000 });
  await page.locator('.sh-toast').getByRole('button', { name: '撤销' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.board-memo').length === 3, null, { timeout: 10000 });

  // 8. Delete memo #1 + Undo
  await items.nth(2).getByRole('button', { name: /删除备忘/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.board-memo').length === 2, null, { timeout: 10000 });
  await page.locator('.sh-toast').getByRole('button', { name: '撤销' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.board-memo').length === 3, null, { timeout: 10000 });

  // 9. Switch to "全部待办" tab and verify memos never show up as task cards
  await page.getByRole('tab', { name: '全部待办' }).click();
  const allPanel = page.locator('#board-view-tabs-panel-all');
  await allPanel.waitFor({ timeout: 5000 });
  assert.doesNotMatch(await allPanel.innerText(), /把虚拟内存页表两级映射/);
  await page.getByRole('tab', { name: /今日/ }).click();

  assert.deepEqual(errors, []);
  await context.close();

  // 10. Narrow 390px light viewport check & screenshot
  const narrow = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 390, height: 844 });
  await narrow.page.goto(running.server.url);
  const narrowMemos = narrow.page.locator('section.board-memos');
  await narrowMemos.waitFor({ timeout: 30000 });
  await narrowMemos.scrollIntoViewIfNeeded();
  await settleAnimations(narrow.page);
  assert.equal(await narrowMemos.locator('.board-memo').count(), 3);
  assert.ok((await sideways(narrow.page)) <= 0, '390px light narrow: zero horizontal overflow');
  if (shots) await narrow.page.screenshot({ path: join(shots, 's6-narrow-390-light.png') });
  assert.deepEqual(narrow.errors, []);
  await narrow.context.close();
});
