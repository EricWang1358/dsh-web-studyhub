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

test('Browser E2E (#857): Today focus strip full chips + Tooltip hover, partial chips without plan, and narrow wrapping', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s3-dist-'));
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
      const firstDeck = own.decks[0];
      if (firstDeck?.cards?.length >= 4) {
        // Two weak cards on the same topic so weakest topic + mistake count surfaces.
        for (let i = 0; i < 2; i += 1) {
          firstDeck.cards[i].review = {
            repetitions: 1,
            interval_days: 1,
            ease_factor: 2.0,
            due_at: '2026-01-01T00:00:00.000Z',
          };
          own.attempts.push({
            id: `seed-weak-${i}`,
            deckId: firstDeck.id,
            quiz_id: firstDeck.cards[i].id,
            correct: false,
            grade: 1,
            timestamp: '2026-01-02T10:00:00.000Z',
            at: '2026-01-02T10:00:00.000Z',
          });
        }
        // Two learnt cards whose review is due today so due review count > 0.
        for (let i = 2; i < 4; i += 1) {
          firstDeck.cards[i].review = {
            repetitions: 2,
            interval_days: 3,
            ease_factor: 2.5,
            due_at: '2026-01-01T00:00:00.000Z',
          };
          own.attempts.push({
            id: `seed-due-${i}`,
            deckId: firstDeck.id,
            quiz_id: firstDeck.cards[i].id,
            correct: true,
            grade: 4,
            timestamp: '2026-01-02T10:00:00.000Z',
            at: '2026-01-02T10:00:00.000Z',
          });
        }
      }
    });
    await service.call('course.book.open');
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 35) } });
    await service.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
    await service.dispose();
  };

  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.TODAY_S3_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  await running.api('daily.plan.profile', { date: today, weekdayMinutes: 45, weekendMinutes: 45 });
  const draft = await running.api('daily.plan.suggest', { date: today });
  if (draft.proposal?.id) await running.api('daily.plan.accept', { date: today, proposalId: draft.proposal.id });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
  await page.goto(running.server.url);

  const strip = page.locator('.board-today__focus-strip');
  await strip.waitFor({ timeout: 30000 });
  await strip.locator('[data-focus-chip="plan"]').waitFor({ timeout: 15000 });
  await strip.locator('[data-focus-chip="weak"]').waitFor({ timeout: 15000 });
  await strip.locator('[data-focus-chip="due"]').waitFor({ timeout: 15000 });

  const budgetText = await strip.locator('.board-today__focus-budget-label').innerText();
  assert.match(budgetText, /今天计划 45 分钟/);
  assert.doesNotMatch(budgetText, /已专注/, 'omits focused half before S4');

  // Verify zero title= attributes inside the focus strip and test keyboard/hover Tooltip open.
  const titledCount = await strip.locator('[title]').count();
  assert.equal(titledCount, 0, 'no native title= attribute inside TodayFocusStrip');

  await strip.locator('[data-focus-chip="plan"]').focus();
  const openTip = page.locator('[role="tooltip"]:popover-open');
  await openTip.waitFor({ timeout: 5000 });
  assert.match(await openTip.innerText(), /备考计划/);
  await page.keyboard.press('Escape');

  await settleAnimations(page);
  assert.ok((await sideways(page)) <= 0, '1280px dark: no horizontal overflow');
  if (shots) await page.screenshot({ path: join(shots, 's3-full-strip-1280-dark.png') });

  // Narrow viewport (390x844): chips and progress bar wrap cleanly without overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await settleAnimations(page);
  assert.ok((await sideways(page)) <= 0, '390px dark: no horizontal overflow');
  const stripBox = await strip.boundingBox();
  const budgetBox = await strip.locator('.board-today__focus-budget').boundingBox();
  assert.ok(budgetBox.width >= stripBox.width * 0.8, 'budget bar spans full row width on narrow viewport');
  if (shots) await page.screenshot({ path: join(shots, 's3-narrow-wrap-390-dark.png') });
  assert.deepEqual(errors, []);
  await context.close();

  // Partial data: remove course.plan so only weak + due chips render (1-2 chips screenshot in light theme).
  await running.api('course.save', { name: COURSE, plan: null });
  const light = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 900 });
  await light.page.goto(running.server.url);
  const lightStrip = light.page.locator('.board-today__focus-strip');
  await lightStrip.waitFor({ timeout: 30000 });
  assert.equal(await lightStrip.locator('[data-focus-chip="plan"]').count(), 0, 'plan chip omitted when course has no plan');
  assert.equal(await lightStrip.locator('[data-focus-chip="weak"]').count(), 1, 'weak chip shown');
  assert.equal(await lightStrip.locator('[data-focus-chip="due"]').count(), 1, 'due chip shown');
  await settleAnimations(light.page);
  assert.ok((await sideways(light.page)) <= 0, '1280px light: no horizontal overflow');
  if (shots) await light.page.screenshot({ path: join(shots, 's3-partial-chips-1280-light.png') });
  assert.deepEqual(light.errors, []);
  await light.context.close();
});
