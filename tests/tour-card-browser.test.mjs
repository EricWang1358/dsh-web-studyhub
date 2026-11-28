/* global document, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage, until } from '../scripts/qa/layout-late.mjs';
import { FULL_TOUR_ORDER, TOUR_STEPS } from '../ui/tour/steps.js';

/* The full tour's card in a real browser. 下一步 stays at the bottom right, beside 上一步, in both languages (跳到下一章 once pushed the English one onto a
   row of its own at the left). A full tour paused in the old order of the list is offered from its start, and a library with nothing published walks no
   step about 掌握度, 总纲 or 复习全书. */

const titleOf = (id) => TOUR_STEPS.find((step) => step.id === id).title;

async function openSettingsProfile(page) {
  await page.locator('[data-tour="nav-menu"], [data-tour="nav-settings"]').first().waitFor({ timeout: 30000 });
  if (await page.locator('[data-tour="nav-menu"]').isVisible()) await page.locator('[data-tour="nav-menu"]').click();
  await page.locator('[data-tour="nav-settings"]').click();
  await page.locator('.settings-nav__item[data-category="profile"]').click();
  await page.locator('.onboarding-settings').waitFor({ timeout: 30000 });
}

async function openWithProgress(browser, server, key, value, view) {
  const opened = await openPage(browser, { server }, { theme: 'light', ...view });
  await opened.page.goto(server.url);
  await opened.page.locator('.study-app').waitFor({ timeout: 30000 });
  await opened.page.evaluate(([name, saved]) => localStorage.setItem(name, saved), [key, JSON.stringify(value)]);
  await opened.page.reload();
  await opened.page.locator('.study-app').waitFor({ timeout: 30000 });
  await openSettingsProfile(opened.page);
  return opened;
}

const footer = (page) => page.evaluate(() => {
  const foot = document.querySelector('.tour-pop__foot'), box = (element) => element.getBoundingClientRect();
  const buttons = [...foot.querySelectorAll('button')];
  const primary = box(buttons.at(-1)), back = box(buttons.at(-2));
  const middle = (rect) => (rect.top + rect.bottom) / 2;
  return { texts: buttons.map((button) => button.textContent.trim()), rightGap: Math.round(box(foot).right - primary.right),
    besideBack: Math.abs(middle(back) - middle(primary)) < 2, oneRow: buttons.every((button) => Math.abs(middle(box(button)) - middle(primary)) < 6),
    inside: buttons.every((button) => box(button).left >= box(foot).left - 1 && box(button).right <= box(foot).right + 1) };
});

test('the full tour card: 下一步 at the bottom right, no resume into another order, no steps about data that is not there', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-tour-card-dist-'));
  await buildPreview({ outdir: dist });
  const withLibrary = async (sample, run) => {
    const base = await mkdtemp(join(tmpdir(), 'study-tour-card-'));
    const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
    try {
      if (sample) await previewCall(server, 'sample.load', { language: 'zh' });
      const { root } = await previewCall(server, 'snapshot', { uiLanguage: 'zh' });
      await run(server, `study-tour:${root}`);
    } finally {
      await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    }
  };
  try {
    await t.test('下一步 sits at the bottom right beside 上一步', () => withLibrary(true, async (server, key) => {
      for (const view of [{ lang: 'en', width: 1440, height: 900 }, { lang: 'zh', width: 1440, height: 900 }, { lang: 'en', width: 420, height: 860 }]) {
        const { page, errors, context } = await openWithProgress(browser, server, key, { stepId: 'finder', done: false, full: true, order: FULL_TOUR_ORDER }, view);
        await page.locator('.onboarding-settings__actions button').first().click();
        await page.locator('.tour-layer:not(.is-measuring) .tour-pop').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.tour-pop__title').textContent() !== titleOf('welcome'), true, 'resumed at the saved step');
        const seen = await footer(page), where = `${view.lang} ${view.width}: ${JSON.stringify(seen)}`;
        assert.equal(seen.texts.length, 4, `skip, next chapter, back, next (${where})`);
        assert.ok(seen.inside, `every button is inside the footer (${where})`);
        assert.ok(Math.abs(seen.rightGap) <= 2, `下一步 ends where the footer ends (${where})`);
        assert.ok(seen.besideBack, `and shares its row with 上一步 (${where})`);
        if (view.lang === 'zh') assert.ok(seen.oneRow, `the Chinese footer keeps one row (${where})`);
        assert.deepEqual(errors, [], 'no console or page errors');
        await context.close();
      }
    }));

    // The step that says what 发布并开始练 lets through is the long one: its last words (the way to repair a question) are read without scrolling the card.
    await t.test('the whole 发布前抽查 text is in sight at 1440 × 900, in both languages', () => withLibrary(true, async (server, key) => {
      for (const lang of ['en', 'zh']) {
        const { page, errors, context } = await openWithProgress(browser, server, key, { stepId: 'draft-check', done: false, full: true, order: FULL_TOUR_ORDER },
          { lang, width: 1440, height: 900 });
        await page.locator('.onboarding-settings__actions button').first().click();
        await page.locator('.tour-layer:not(.is-measuring) .tour-pop').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.tour-pop__title').textContent() !== titleOf('welcome'), true, 'resumed at the saved step');
        const hidden = await page.locator('.tour-pop__body').evaluate((body) => body.scrollHeight - body.clientHeight);
        assert.ok(hidden <= 1, `${lang}: ${hidden} px of the text are below the fold of the card`);
        assert.deepEqual(errors, [], 'no console or page errors');
        await context.close();
      }
    }));

    await t.test('nothing published: the old paused place is not resumed, and 掌握度, 总纲, 复习全书 are not walked', () => withLibrary(false, async (server, key) => {
      // As 5.4.0 wrote a paused full tour: no order.
      const { page, errors, context } = await openWithProgress(browser, server, key, { stepId: 'home', done: false, full: true }, { lang: 'zh', width: 1440, height: 900 });
      assert.equal(await page.getByRole('button', { name: /^继续功能导览/ }).count(), 0, 'no 继续 into the middle of another order');
      // 开始功能导览 goes back to the kind of tour that was paused: the full one, from its first step.
      await page.getByRole('button', { name: '开始功能导览', exact: true }).click();
      const pop = page.locator('.tour-pop');
      await pop.waitFor({ timeout: 30000 });
      assert.equal(await pop.locator('.tour-pop__title').textContent(), titleOf('welcome'));
      await pop.getByRole('button', { name: '只看界面', exact: true }).click();
      await until(async () => (await pop.locator('.tour-pop__title').first().textContent()) !== titleOf('welcome'), 'past the welcome step', { timeoutMs: 15000 });
      const titles = [];
      for (let walked = 0; walked < 60; walked++) {
        titles.push(await pop.locator('.tour-pop__title').first().textContent());
        const next = pop.getByRole('button', { name: '下一步', exact: true });
        if (!await next.count()) break;
        const count = await pop.locator('.tour-pop__count').first().textContent();
        await next.click();
        await until(async () => (await page.locator('.tour-pop__count').first().textContent()) !== count, 'the next card', { timeoutMs: 15000 });
      }
      for (const id of ['flow', 'wrongbook', 'exam-plan', 'finish']) assert.ok(titles.includes(titleOf(id)), `${id} is walked: ${titles.join(' / ')}`);
      for (const id of ['mastery', 'outline', 'book']) assert.ok(!titles.includes(titleOf(id)), `${id} is left out: ${titles.join(' / ')}`);
      assert.deepEqual(errors, [], 'no console or page errors');
      await context.close();
    }));
  } finally {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
