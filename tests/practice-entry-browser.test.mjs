/* global document, window, localStorage, getComputedStyle -- page.evaluate callbacks run in the browser */
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
   without scrolling, at 1440×900, 1536×730 and 1280×720; the first card keeps the focus through its flip, as the next ones do.
   #1679: in a narrow pane (420 wide) the sidebar is a drawer. Going to the practice page through it, by mouse and by keyboard, leaves the focus on the question
   card, so Space flips the card instead of opening the drawer again, also when the practice page was already on screen; closing the drawer with Esc still gives
   the focus back to the button that opened it.
   #1697: once flipped, the row above the grade buttons is one line of at most two items, and no grade's gap ("1 天") breaks between number and unit,
   at the three laptop sizes and at 420 wide. */

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

/** #1697: the row above the grade buttons (how many lines, how many items) and every "number unit" of the grade buttons' gaps (on how many lines). */
const gradingLayout = (page) => page.evaluate(() => {
  const meta = document.querySelector('.grading-head__meta');
  const lineHeight = meta ? parseFloat(getComputedStyle(meta).lineHeight) || 20 : 20;
  const split = [];
  for (const gap of document.querySelectorAll('.grade-gap')) {
    const walker = document.createTreeWalker(gap, 4);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const text = nodes.map((node) => node.data).join('');
    for (const match of text.matchAll(/\d+(?:\.\d+)?\s*(?:天|个月|年|days?|months?|years?)/g)) {
      // The text nodes that hold the match, and the boxes of its characters: two tops = the number and its unit on different lines.
      const range = document.createRange();
      let at = 0;
      for (const node of nodes) {
        const end = at + node.data.length;
        if (match.index >= at && match.index < end) range.setStart(node, match.index - at);
        if (match.index + match[0].length > at && match.index + match[0].length <= end) range.setEnd(node, match.index + match[0].length - at);
        at = end;
      }
      const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
      if (tops.size > 1) split.push(match[0]);
    }
  }
  return { metaLines: meta ? Math.round(meta.getBoundingClientRect().height / lineHeight) : 0,
    metaItems: meta ? meta.innerText.split('·').map((part) => part.trim()).filter(Boolean) : [], split };
});

function assertGradingLayout(layout, tag) {
  assert.ok(layout.metaLines <= 1, `${tag}: the row above the grades is one line (${JSON.stringify(layout)})`);
  assert.ok(layout.metaItems.length <= 2, `${tag}: and says at most two things (${JSON.stringify(layout.metaItems)})`);
  assert.deepEqual(layout.split, [], `${tag}: no number is on another line than its unit`);
}

/** Where the focus is (run in the page): 'card' when it is on the question card or inside it, else what holds it. */
function focusWhere() {
  const active = document.activeElement;
  if (active && active !== document.body && active.closest('[data-tour="review-question"]')) return 'card';
  return `${active?.tagName} ${active?.getAttribute('aria-label') || active?.className || ''}`;
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
      // The first card's focus survives the flip, as the next cards' does: it is on the card, not on the front face that the flip hides.
      assert.equal(await page.evaluate(focusWhere), 'card', `${tag}: after the first flip the focus is still on the question card`);
      assert.ok(flipped.bottoms.every((bottom) => bottom <= flipped.vh), `${tag}: every grade button ends inside the window (${JSON.stringify(flipped)})`);
      assert.ok(flipped.tops.every((top) => top >= flipped.barBottom), `${tag}: and starts below the top bar (${JSON.stringify(flipped)})`);
      assertGradingLayout(await gradingLayout(page), tag);
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
      const backThroughDrawer = async () => {
        if (how === 'mouse') await opener.click();
        else { await opener.focus(); await page.keyboard.press('Enter'); }
        await page.locator('.nav-drawer[open]').waitFor();
        const back = page.locator('.nav-drawer[open]').getByRole('button', { name: /^回到题目/ }).first();
        if (how === 'mouse') await back.click();
        else { await back.focus(); await page.keyboard.press('Enter'); }
        await page.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
        await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
        // Settled: the focus has to stay on the card, not only pass through it (the drawer hands it back to its button as it closes).
        await new Promise((done) => setTimeout(done, 400));
        return until(() => page.evaluate(focusWhere).then((where) => (where === 'card' ? where : null)), `${how}: the focus on the question card`, { timeoutMs: 10000 })
          .catch(() => page.evaluate(focusWhere));
      };
      assert.equal(await backThroughDrawer(), 'card', `${how}: after arriving through the drawer the focus is on the question card`);
      // Already on the practice page, 回到题目 from the drawer again: the page does not change, and the focus still goes to the question, not back to the drawer button.
      assert.equal(await backThroughDrawer(), 'card', `${how}: 回到题目 from the drawer while already on the question leaves the focus on the question card`);
      await page.keyboard.press('Space');
      await page.locator(GRADES).first().waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.nav-drawer[open]').count(), 0, `${how}: Space did not open the drawer`);
      await settledGrades(page);
      assertGradingLayout(await gradingLayout(page), `420 ${how}`);

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

/* #1679, every destination: the drawer's rows start a page change with a leave animation, and most pages load their code when first opened. The focus must wait
   for the page the row leads to and take its heading: taken from the page that is leaving, it falls to <body> when that page goes, and nothing takes it after. */
const DRAWER_PAGES = ['exam', 'dashboard', 'live', 'book', 'skeleton', 'examprep', 'examcoach', 'tasks', 'notes', 'board', 'sources'];

/** The focus, run in the page: the heading's words when it is on a heading of the page now on screen, else what holds it. */
function headingFocus() {
  const active = document.activeElement;
  const main = document.querySelector('.study-app main');
  if (active && active !== document.body && main?.contains(active) && !main.classList.contains('is-leaving') && /^H[12]$/.test(active.tagName)) {
    return { heading: active.innerText.replace(/\s+/g, ' ').trim() };
  }
  return { other: `${active?.tagName} ${active?.getAttribute('aria-label') || active?.className || ''}`.trim() };
}

test('#1679: at 420 wide, every page opened from the drawer takes the focus on its own heading, also the first time its code is loaded', { timeout: 600000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { context, page, errors } = await openPractice(env, { width: 420, height: 860 });
  try {
    const opener = page.getByRole('button', { name: '打开导航', exact: true }).first();
    await opener.waitFor({ timeout: 30000 });
    const home = await page.evaluate(() => document.querySelector('.study-app main h1')?.innerText.replace(/\s+/g, ' ').trim() || '');
    const wrong = [];
    for (const id of DRAWER_PAGES) {
      await opener.click();
      const drawer = page.locator('.nav-drawer[open]');
      await drawer.waitFor();
      const row = drawer.locator(`[data-tour="nav-${id}"]`).first();
      if (!await row.isVisible()) {
        const folds = drawer.locator('.nav-fold__toggle[aria-expanded="false"]');
        for (let i = 0; i < 4 && await folds.count(); i += 1) await folds.first().click();
      }
      await row.click();
      await drawer.waitFor({ state: 'detached' });
      const landed = await until(() => page.evaluate(headingFocus).then((now) => (now.heading && now.heading !== home ? now : null)), `${id}: its heading`, { timeoutMs: 8000 })
        .catch(() => page.evaluate(headingFocus));
      // Settled: it stays there once the page has drawn.
      await new Promise((done) => setTimeout(done, 500));
      const later = await page.evaluate(headingFocus);
      if (!later.heading || later.heading === home) wrong.push(`${id}: ${JSON.stringify(landed)} then ${JSON.stringify(later)}`);
    }
    assert.deepEqual(wrong, [], 'every destination keeps the focus on its heading');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await context.close(); }
});
