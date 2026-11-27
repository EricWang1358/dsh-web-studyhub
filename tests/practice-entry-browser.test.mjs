/* global document, window, localStorage -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { until } from '../scripts/qa/layout-late.mjs';

/* Entering a practice round, the way a learner does it (the sidebar's 回到题目), with the sample course and the fake model in the browser preview.
   #1678: the first flashcard sits where the later ones sit (pinned under the top bar), and once it is flipped the six 0–5 grade buttons are wholly on screen
   without scrolling, at 1440×900, 1536×730 and 1280×720.
   #1679: in a narrow pane (420 wide) the sidebar is a drawer. Going to the practice page through it, by mouse and by keyboard, leaves the focus on the question
   card, so Space flips the card instead of opening the drawer again; closing the drawer with Esc still gives the focus back to the button that opened it. */

const GRADES = 'button[aria-label*="分："]';

/** The grade buttons and the question card, measured once two looks 150 ms apart agree (the flip and the grading row animate in). */
async function settledGrades(page) {
  let last = '';
  return until(async () => {
    const now = await page.evaluate((selector) => {
      const grades = [...document.querySelectorAll(selector)].filter((button) => button.getClientRects().length);
      const card = document.querySelector('[data-tour="review-question"]')?.getBoundingClientRect();
      const bar = document.querySelector('main > .topbar')?.getBoundingClientRect();
      return JSON.stringify({ count: grades.length, vh: window.innerHeight, barBottom: Math.round(bar?.bottom ?? 0), cardTop: Math.round(card?.top ?? -1),
        tops: grades.map((button) => Math.round(button.getBoundingClientRect().top)), bottoms: grades.map((button) => Math.round(button.getBoundingClientRect().bottom)) });
    }, GRADES);
    const settled = now === last && JSON.parse(now).count === 6;
    last = now;
    if (!settled) await new Promise((done) => setTimeout(done, 150));
    return settled ? JSON.parse(now) : null;
  }, 'six settled grade buttons', { timeoutMs: 20000 });
}

/** The first question card's top edge, once it stops moving. */
async function settledCardTop(page) {
  let last = null;
  return until(async () => {
    const top = await page.evaluate(() => {
      const card = document.querySelector('[data-tour="review-question"]');
      return card ? Math.round(card.getBoundingClientRect().top) : null;
    });
    const settled = top !== null && top === last;
    last = top;
    if (!settled) await new Promise((done) => setTimeout(done, 150));
    return settled ? { top } : null;
  }, 'a settled question card', { timeoutMs: 20000 });
}

async function setup(t) {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return null; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-practice-entry-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0,
    model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const api = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: 'zh' });
  await api('sample.load', { language: 'zh' });
  return { browser, server, api };
}

async function openPractice({ browser, server, api }, { width, height }) {
  // A fresh round of the sample deck, opened from the sidebar the way the walk-through did it.
  await api('review.start', { deckId: 'sample-deck-patterns', mode: 'path', fresh: true });
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
  await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.url);
  await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return { context, page, errors };
}

test('#1678: the first flashcard is pinned like the next ones and, flipped, shows all six grade buttons without scrolling', { timeout: 600000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  for (const [width, height] of [[1440, 900], [1536, 730], [1280, 720]]) {
    const { context, page, errors } = await openPractice(env, { width, height });
    try {
      const tag = `${width}×${height}`;
      await page.getByRole('button', { name: /^回到题目/ }).first().click();
      await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
      await page.mouse.move(width - 5, 5);
      const first = await settledCardTop(page);
      await page.keyboard.press('Space');
      const flipped = await settledGrades(page);
      assert.ok(flipped.bottoms.every((bottom) => bottom <= flipped.vh), `${tag}: every grade button ends inside the window (${JSON.stringify(flipped)})`);
      assert.ok(flipped.tops.every((top) => top >= flipped.barBottom), `${tag}: and starts below the top bar (${JSON.stringify(flipped)})`);
      // The next card is pinned by the page itself; the first one must open in the same place.
      await page.keyboard.press('4');
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 0, GRADES, { timeout: 20000 });
      await page.waitForFunction(() => /^\s*2\s*\/\s*9/.test(document.querySelector('[data-tour="review-question"] .card-progress')?.textContent || ''), null, { timeout: 20000 })
        .catch(() => {});
      const second = await settledCardTop(page);
      assert.ok(Math.abs(first.top - second.top) <= 2, `${tag}: the first card opens where the second one does (${first.top} vs ${second.top})`);
      assert.deepEqual(errors, [], `${tag}: no page errors`);
    } finally { await context.close(); }
  }
});

test('#1679: at 420 wide, 回到题目 from the drawer leaves the focus on the question, so Space flips; Esc gives the focus back to the drawer button', { timeout: 600000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  for (const how of ['mouse', 'keyboard']) {
    const { context, page, errors } = await openPractice(env, { width: 420, height: 860 });
    try {
      const opener = page.getByRole('button', { name: '打开导航', exact: true }).first();
      await opener.waitFor({ timeout: 30000 });
      if (how === 'mouse') await opener.click();
      else { await opener.focus(); await page.keyboard.press('Enter'); }
      await page.locator('.nav-drawer[open]').waitFor();
      const back = page.locator('.nav-drawer[open]').getByRole('button', { name: /^回到题目/ }).first();
      if (how === 'mouse') await back.click();
      else { await back.focus(); await page.keyboard.press('Enter'); }
      await page.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
      await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
      const focus = await until(() => page.evaluate(() => {
        const active = document.activeElement;
        return active && active !== document.body && active.closest('[data-tour="review-question"]') ? 'card' : null;
      }), `${how}: the focus on the question card`, { timeoutMs: 10000 }).catch(() => page.evaluate(() => {
        const active = document.activeElement;
        return `${active?.tagName} ${active?.getAttribute('aria-label') || active?.className || ''}`;
      }));
      assert.equal(focus, 'card', `${how}: after arriving through the drawer the focus is on the question card`);
      await page.keyboard.press('Space');
      await page.locator(GRADES).first().waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.nav-drawer[open]').count(), 0, `${how}: Space did not open the drawer`);

      // Esc closes the drawer and puts the focus back on the button that opened it.
      await opener.click();
      await page.locator('.nav-drawer[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '打开导航', `${how}: Esc gives the focus back to the drawer button`);
      assert.deepEqual(errors, [], `${how}: no page errors`);
    } finally { await context.close(); }
  }
});
