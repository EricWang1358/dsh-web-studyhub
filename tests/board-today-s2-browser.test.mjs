/* global document, window, process, DataTransfer, DragEvent */
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

test('Browser E2E (#856): AM/PM lanes, per-lane quick-add, drag & keyboard reordering across reloads, one-lane-empty, and narrow stacked layout', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s2-dist-'));
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
      // Record a failed attempt on the first deck's first card so daily.plan.accept tags one task as 错题.
      const firstDeck = own.decks[0];
      if (firstDeck?.cards?.[0]) {
        firstDeck.cards[0].review = {
          repetitions: 1,
          interval_days: 1,
          ease_factor: 2.0,
          due_at: '2026-01-01T00:00:00.000Z',
        };
        own.attempts.push({
          id: 'seed-mistake-attempt',
          deckId: firstDeck.id,
          quiz_id: firstDeck.cards[0].id,
          correct: false,
          grade: 1,
          at: '2026-01-02T10:00:00.000Z',
        });
      }
    });
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 21) } });
    await service.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
    await service.dispose();
  };

  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.TODAY_S2_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  await running.api('daily.plan.profile', { date: today, weekdayMinutes: 35, weekendMinutes: 35 });
  const draft = await running.api('daily.plan.suggest', { date: today });
  assert.ok(draft.proposal?.id, 'daily plan suggestion generated');
  await running.api('daily.plan.accept', { date: today, proposalId: draft.proposal.id });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const laneTitles = (page, lane) => page.locator(`.board-today__lane[data-lane="${lane}"] .board-card__title`).allInnerTexts();

  const planBefore = await running.api('daily.plan.get', { date: today });
  const snapBefore = await running.api('snapshot');
  const coursePlanBefore = snapBefore.courses.find((c) => c.name === COURSE)?.plan;

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
  await page.goto(running.server.url);

  const todayRoot = page.locator('.board-today');
  await todayRoot.waitFor({ timeout: 30000 });
  const amLane = todayRoot.locator('.board-today__lane[data-lane="am"]');
  const pmLane = todayRoot.locator('.board-today__lane[data-lane="pm"]');
  await amLane.waitFor({ timeout: 15000 });
  await pmLane.waitFor({ timeout: 15000 });

  // Add manual cards via bottom per-lane inputs: 加到上午… and 加到下午…
  await amLane.getByPlaceholder('加到上午…').fill('晨间默写核心公式');
  await amLane.getByRole('button', { name: '添加' }).click();
  await amLane.locator('.board-card__title', { hasText: '晨间默写核心公式' }).waitFor({ timeout: 15000 });

  await pmLane.getByPlaceholder('加到下午…').fill('整理实验二讨论纪要');
  await pmLane.getByRole('button', { name: '添加' }).click();
  await pmLane.locator('.board-card__title', { hasText: '整理实验二讨论纪要' }).waitFor({ timeout: 15000 });

  // Verify source badges & absence of 约 N 分钟 on manual cards.
  const manualCardEl = amLane.locator('.board-card', { hasText: '晨间默写核心公式' });
  assert.equal(await manualCardEl.locator('.board-source').innerText(), '自己加的');
  assert.equal(await manualCardEl.locator('.board-duration').count(), 0, 'manual card omits duration');

  // Screenshot 1: 两段都有卡 (1280px dark).
  await settleAnimations(page);
  assert.ok((await sideways(page)) <= 0, '1280px dark: no horizontal overflow');
  if (shots) await page.screenshot({ path: join(shots, 's2-both-lanes-1280-dark.png') });

  // Drag "晨间默写核心公式" from AM to top of PM using HTML5 DataTransfer drag events.
  await page.evaluate(() => {
    const source = [...document.querySelectorAll('.board-today__lane[data-lane="am"] .board-card')]
      .find((el) => el.textContent.includes('晨间默写核心公式'));
    const targetLane = document.querySelector('.board-today__lane[data-lane="pm"]');
    const firstPmCard = targetLane.querySelector('.board-card');
    const rect = firstPmCard.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/x-study-board-card', source.getAttribute('data-card-id'));
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    targetLane.querySelector('.board-today__lane-cards').dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 20, clientY: rect.top + 2 }),
    );
    targetLane.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 20, clientY: rect.top + 2 }),
    );
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await pmLane.locator('.board-card__title', { hasText: '晨间默写核心公式' }).waitFor({ timeout: 15000 });
  assert.equal((await laneTitles(page, 'pm'))[0], '晨间默写核心公式', 'dropped at top of PM');

  // Keyboard move within PM: Alt+ArrowDown moves "晨间默写核心公式" from index 0 to index 1.
  const movedCard = pmLane.locator('.board-card', { hasText: '晨间默写核心公式' });
  await movedCard.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForFunction(() => {
    const titles = [...document.querySelectorAll('.board-today__lane[data-lane="pm"] .board-card__title')].map((el) => el.textContent);
    return titles[1] === '晨间默写核心公式';
  }, null, { timeout: 15000 });

  const expectedAm = await laneTitles(page, 'am');
  const expectedPm = await laneTitles(page, 'pm');

  // Reload and assert order & lanes persisted in board.json AND budgets/course.plan are untouched.
  await page.reload();
  await todayRoot.waitFor({ timeout: 30000 });
  assert.deepEqual(await laneTitles(page, 'am'), expectedAm, 'AM order persisted across reload');
  assert.deepEqual(await laneTitles(page, 'pm'), expectedPm, 'PM order persisted across reload');

  const planAfter = await running.api('daily.plan.get', { date: today });
  const snapAfter = await running.api('snapshot');
  assert.equal(planAfter.budgetMinutes, planBefore.budgetMinutes, 'daily plan budget unchanged');
  assert.deepEqual(snapAfter.courses.find((c) => c.name === COURSE)?.plan, coursePlanBefore, 'course.plan unchanged');

  // Screenshot 3: 窄屏下两段上下排 (390px dark) + verify PM stacks vertically below AM with zero overflow.
  for (const width of [420, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await settleAnimations(page);
    assert.ok((await sideways(page)) <= 0, `${width}px: no horizontal overflow`);
  }
  const amBox = await amLane.boundingBox();
  const pmBox = await pmLane.boundingBox();
  assert.ok(pmBox.y >= amBox.y + amBox.height - 2, `390px: PM lane (${pmBox.y}) stacks below AM lane (${amBox.y + amBox.height})`);
  if (shots) await page.screenshot({ path: join(shots, 's2-narrow-stacked-390-dark.png'), fullPage: true });

  assert.deepEqual(errors.filter((line) => !/favicon|status of 400/.test(line)), [], 'no page console errors');
  await context.close();

  // Screenshot 2: 某一段为空 (1280px light) — move all remaining PM cards to AM so PM is empty while AM has cards.
  let b = await running.api('board.get');
  for (const card of Object.values(b.cards)) {
    if (card.slot === 'pm') {
      b = await running.api('board.today.move', { revision: b.revision, id: card.id, date: today, slot: 'am' });
    }
  }
  const light = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 860 });
  await light.page.goto(running.server.url);
  await light.page.locator('.board-today__lane-empty').waitFor({ timeout: 30000 });
  assert.match(await light.page.locator('.board-today__lane[data-lane="pm"] .board-today__lane-meta').innerText(), /0 项 · 约 0 分钟/);
  await settleAnimations(light.page);
  if (shots) await light.page.screenshot({ path: join(shots, 's2-one-lane-empty-1280-light.png') });
  await light.context.close();
});
