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
import { FULL_TOUR_ORDER } from '../ui/tour/steps.js';
import { gradeRowPaint, withoutScrollState } from './helpers/grade-row.mjs';

/* Entering a practice round, the way a learner does it (the sidebar's 回到题目), with the sample course and the fake model in the browser preview.
   #1678: the first flashcard sits where the later ones sit (pinned under the top bar), and once it is flipped the six 0–5 grade buttons are wholly on screen
   without scrolling, at 1440×900, 1536×730 and 1280×720; the first card keeps the focus through its flip, as the next ones do. At 界面大小 150% those windows
   are short (600 px of the app's own or less), so the row is one line per button and sticks to the bottom over the card: all six are in the window and
   clickable for two cards running, Tab never leaves the focus under the row, and the answer's last line still scrolls above it. Stuck, the row is opaque in the
   page's colour down to the window's edge; where the card fits it paints nothing over the card's shadow, also in an engine without scroll-state queries
   (tests/helpers/grade-row.mjs). At 420×860 the short row covers at most a fifth of the window.
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

async function openPractice({ browser, server, api }, { width, height, scale = 100, mode = 'path' }) {
  // A fresh round of the sample deck, opened from the sidebar the way the walk-through did it; `scale` is 界面大小 (设置 › 界面) in percent.
  await api('review.start', { deckId: 'sample-deck-patterns', mode, fresh: true });
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
  await context.addInitScript((size) => {
    try {
      localStorage.setItem('study-ui-language', 'zh');
      if (size !== 100) localStorage.setItem('study-interface', JSON.stringify({ scale: size }));
    } catch { /* blocked */ }
  }, scale);
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
      // At 100% these windows are not short (ui/use-short-view.js): the row keeps its full look, each button with its gap under the words.
      assert.equal(await page.locator('.grading--short').count(), 0, `${tag}: the full grade row, not the short window's one-line row`);
      assert.equal(await page.locator('.grade .grade-gap').count(), 6, `${tag}: every grade button says its gap under its words`);
      // The card fits, so the row is not stuck: it paints nothing over the card's shadow, also where the engine has no scroll-state queries.
      await withoutScrollState(page);
      await assertRowPaint(page, tag, false);
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

/** The flipped card under 界面大小: each grade button's box, and whether the window shows that button at its middle (nothing drawn over it). */
const gradeReach = (page) => page.evaluate((selector) => {
  const bar = document.querySelector('main > .topbar')?.getBoundingClientRect();
  return { vh: window.innerHeight, barBottom: Math.round(bar?.bottom ?? 0),
    grades: [...document.querySelectorAll(selector)].filter((button) => button.getClientRects().length).map((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { grade: button.dataset.grade, top: Math.round(box.top), bottom: Math.round(box.bottom), hit: !!hit && button.contains(hit) };
    }) };
}, GRADES);

/** How the row is painted: stuck over a card taller than the window, it is on the window's bottom edge (no strip of the card under it) and opaque in the
 *  page's own colour; under a card that fits it paints nothing, so the card's shadow shows. `stuck` says which one this card must be (else either). */
async function assertRowPaint(page, tag, stuck) {
  let row = null;
  const right = (now) => (now.stuck ? now.rowAtEdge && now.paints === now.surface : now.paints === 'none');
  await until(async () => { row = await gradeRowPaint(page); return right(row) && (stuck === undefined || row.stuck === stuck); }, `${tag}: the row painted`, { timeoutMs: 5000 })
    .catch(() => {});
  if (stuck !== undefined) assert.equal(row.stuck, stuck, `${tag}: the grade row is ${stuck ? '' : 'not '}stuck to the window's bottom edge (${JSON.stringify(row)})`);
  if (row.stuck) {
    assert.ok(row.rowAtEdge, `${tag}: the stuck row reaches the window's bottom edge, nothing of the card under it (${JSON.stringify(row)})`);
    assert.equal(row.paints, row.surface, `${tag}: the stuck row is opaque in the colour of the page it scrolls in (${JSON.stringify(row)})`);
  } else assert.equal(row.paints, 'none', `${tag}: the row under a card that fits paints nothing over the card's shadow (${JSON.stringify(row)})`);
  return row;
}

/** Scrolls the answer's last line to just above the area under the card (the grade row), as far as the page lets it, and says where that line ends up. */
const answerLastLine = (page) => page.evaluate(() => {
  const answer = document.querySelector('.flip-back .flash-prompt');
  const follow = document.querySelector('.flash-follow');
  let scroller = answer.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const drawn = scroller.getBoundingClientRect().width / scroller.offsetWidth;
  const lastLine = () => { const range = document.createRange(); range.selectNodeContents(answer); return [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1); };
  for (let i = 0; i < 3; i++) {
    const over = lastLine().bottom - follow.getBoundingClientRect().top;
    if (over <= 0) break;
    scroller.scrollTop += Math.ceil(over / drawn) + 4;
  }
  const line = lastLine(), row = follow.getBoundingClientRect(), bar = document.querySelector('main > .topbar').getBoundingClientRect();
  // The card's flip button lies over its faces, so what the window shows there is the card (that button), not the row or the top bar.
  const hit = document.elementFromPoint(line.left + line.width / 2, line.top + line.height / 2);
  return { top: Math.round(line.top), bottom: Math.round(line.bottom), rowTop: Math.round(row.top), barBottom: Math.round(bar.bottom), shown: !!hit?.closest('.flashcard') };
});

/** Tabs forward from the question card into the grade row and says, for each stop before the row, its box and the row's top edge then. */
const tabToGrades = (page) => page.evaluate(() => ({ barBottom: Math.round(document.querySelector('main > .topbar').getBoundingClientRect().bottom) }))
  .then(async ({ barBottom }) => {
    const stops = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const active = document.activeElement, follow = document.querySelector('.flash-follow');
        if (!active || follow.contains(active) || !active.closest('.question-card')) return null;
        const box = active.getBoundingClientRect();
        // The room the page keeps for a focus: under the scroller's scroll-padding-top (the top bar) and above the stop's scroll-margin-bottom (the row).
        let scroller = active.parentElement;
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        const area = scroller.getBoundingClientRect(), drawn = area.width / scroller.offsetWidth;
        const room = Math.min(area.bottom, window.innerHeight) - parseFloat(getComputedStyle(active).scrollMarginBottom) * drawn
          - (area.top + (parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0) * drawn);
        return { what: active.getAttribute('aria-label') || active.className, top: Math.round(box.top), bottom: Math.round(box.bottom), rowTop: Math.round(follow.getBoundingClientRect().top),
          fits: box.height <= room };
      });
      if (!stop) break;
      stops.push(stop);
    }
    return { barBottom, stops };
  });

test('#1678: at 界面大小 150% the six grade buttons of a flipped flashcard stay in the window, over the card, for two cards running', { timeout: 600000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  // The three laptop sizes of the walk-through, and a window so short that the card cannot fit above the row: it scrolls behind the row.
  for (const [width, height] of [[1440, 900], [1536, 730], [1280, 720], [1280, 600]]) {
    // A flashcard round: the cards graded at one size are no longer due at the next, and a path round would then open on a choice question.
    const { context, page, errors } = await openPractice(env, { width, height, scale: 150, mode: 'flashcard' });
    try {
      await page.getByRole('button', { name: /^回到题目/ }).first().click();
      await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.study-app').getAttribute('data-ui-scale'), '150', 'the app is drawn at 150%');
      await page.mouse.move(width - 5, 5);
      const cardTops = [];
      for (const card of [1, 2]) {
        const tag = `150% ${width}×${height}, card ${card}`;
        // The second card as an engine without scroll-state queries draws it (WebKit, Firefox): the row must look the same there.
        if (card === 2) await withoutScrollState(page);
        const front = await settledCardTop(page);
        cardTops.push(front.top);
        await page.keyboard.press('Space');
        const flipped = await settledGrades(page);
        // The flip does not scroll (usePinQuestion keeps the card where it was pinned).
        assert.ok(Math.abs(flipped.cardTop - front.top) <= 2, `${tag}: the flip leaves the card where it was (${front.top} → ${flipped.cardTop})`);
        const reach = await gradeReach(page);
        assert.equal(reach.grades.length, 6, `${tag}: six grade buttons`);
        for (const grade of reach.grades) {
          assert.ok(grade.top >= reach.barBottom && grade.bottom <= reach.vh, `${tag}: grade ${grade.grade} is wholly in the window, below the top bar (${JSON.stringify(reach)})`);
          assert.ok(grade.hit, `${tag}: grade ${grade.grade} is what the window shows at its middle (${JSON.stringify(reach)})`);
        }
        await assertRowPaint(page, tag);
        assert.equal(await page.locator('.grading--short').count(), 1, `${tag}: the window is short at 150% (under 640 px of the app's own), so the row is one line per button`);
        // Tabbing through the card never leaves the focus under the row (WCAG 2.4.11): a stop that fits in the room the page keeps for a focus (under the top bar's scroll-padding, above its own scroll-margin for the row) is wholly there.
        const tabbed = await tabToGrades(page);
        for (const stop of tabbed.stops) {
          assert.ok(stop.top < stop.rowTop && stop.bottom > tabbed.barBottom, `${tag}: the focus on ${stop.what} is not hidden under the grade row (${JSON.stringify(tabbed)})`);
          if (stop.fits) assert.ok(stop.bottom <= stop.rowTop + 1 && stop.top >= tabbed.barBottom - 1, `${tag}: ${stop.what} is wholly between the top bar and the row (${JSON.stringify(tabbed)})`);
        }
        // Nothing of the card is hidden for good: the answer's last line scrolls up above the row.
        const line = await answerLastLine(page);
        assert.ok(line.bottom <= line.rowTop + 1 && line.top >= line.barBottom - 1 && line.shown, `${tag}: the answer's last line can be scrolled above the grade row (${JSON.stringify(line)})`);
        await page.keyboard.press('4');
        await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 0, GRADES, { timeout: 20000 });
        // The next card is up, face down (the round's progress bar has moved on).
        await page.waitForFunction((at) => Number(document.querySelector('[data-tour="review-question"] .card-progress')?.getAttribute('aria-valuenow')) === at
          && document.querySelector('.flashcard:not(.flipped)'), card + 1, { timeout: 20000 });
      }
      assert.ok(Math.abs(cardTops[0] - cardTops[1]) <= 2, `150% ${width}×${height}: the first card opens where the second one does (${cardTops.join(' vs ')})`);
      assert.deepEqual(errors, [], `150% ${width}×${height}: no page errors`);
    } finally { await context.close(); }
  }
});

test('#1678: at 420×860 and 界面大小 150% the short grade row stays in reach and covers at most a fifth of the window', { timeout: 600000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { context, page, errors } = await openPractice(env, { width: 420, height: 860, scale: 150, mode: 'flashcard' });
  try {
    const tag = '150% 420×860';
    const opener = page.getByRole('button', { name: '打开导航', exact: true }).first();
    await opener.click();
    await page.locator('.nav-drawer[open]').getByRole('button', { name: /^回到题目/ }).first().click();
    await page.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
    await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
    await page.mouse.move(415, 5);
    await settledCardTop(page);
    await page.keyboard.press('Space');
    await settledGrades(page);
    const reach = await gradeReach(page);
    assert.equal(reach.grades.length, 6, `${tag}: six grade buttons`);
    for (const grade of reach.grades) assert.ok(grade.hit && grade.top >= reach.barBottom && grade.bottom <= reach.vh, `${tag}: grade ${grade.grade} is wholly in the window (${JSON.stringify(reach)})`);
    const row = await assertRowPaint(page, tag, true);
    assert.ok(row.height <= row.vh / 5, `${tag}: the stuck row covers at most a fifth of the window (${JSON.stringify(row)})`);
    // What the row no longer spells out on screen is still each group's name.
    for (const name of ['未达标 · 留在本题看解析', '达标']) assert.equal(await page.getByRole('group', { name, exact: true }).count(), 1, `${tag}: the group ${name} keeps its name`);
    assert.deepEqual(errors, [], `${tag}: no page errors`);
  } finally { await context.close(); }
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

/* The arrival's wait belongs to the arrival it was asked for. A tour started later switches pages by itself and keeps the focus on its card (its arrow keys
   work only there): a drawer visit made before must not take it to the heading of the page the tour opens, which may still be loading its code. */
test('#1679: after a visit through the drawer, the feature tour keeps the focus on its card on a page that loads late', { timeout: 600000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { context, page, errors } = await openPractice(env, { width: 420, height: 860 });
  try {
    const opener = page.getByRole('button', { name: '打开导航', exact: true }).first();
    await opener.waitFor({ timeout: 30000 });
    const { root } = await env.api('snapshot');
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`study-tour:${root}`, JSON.stringify({ stepId: 'dashboard', done: false, full: true, order: FULL_TOUR_ORDER })]);
    await opener.click();
    await page.locator('.nav-drawer[open] [data-tour="nav-settings"]').click();
    await page.locator('.settings-nav__item[data-category="profile"]').click();
    await page.getByRole('button', { name: /^继续功能导览/ }).click();
    await page.locator('.tour-layer:not(.is-measuring) .tour-pop').waitFor({ timeout: 30000 });
    // 学习统计 is opened for the first time here: its heading comes late. Give it time to draw, then see who holds the focus.
    await page.locator('.dash-trend-panel, .dash-chart-box').first().waitFor({ timeout: 30000 });
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.tour-pop')), true,
      `the focus is on the tour's card (it is on ${await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.className}`)})`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await context.close(); }
});
