/* global window document */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* 总纲 in the real page at 1280 and 420 px: the home opens it from two visible secondary buttons, one beside the course title and one in the 学习目录 heading (the folded 课程路线 list and the tiny link line are gone, one primary button stays); a
   converted book with two chapters, a note without chapters, a material without questions; two questions picked in two chapters start a
   round of exactly those two, and the round's way back returns to the outline as it was left; 未归位 is listed; the hover explanation shows;
   nothing scrolls sideways. Seeded through the real store. Screenshots go to COURSE_OUTLINE_SHOTS when it is set. */

const at = '2026-10-01T08:00:00.000Z';
const fact = (topic, i) => `${topic} fact ${i}: the database keeps every committed write durable on disk.`;
const text = topic => Array.from({ length: 5 }, (_, i) => fact(topic, i)).join(' ');
const CHAPTERS = [{ index: 0, title: 'Indexes', level: 1 }, { index: 1, title: 'Transactions, isolation levels and the write-ahead log in everyday practice', level: 1 }];
const bookPage = (n, chapter) => ({ id: `book-p${n}`, title: `Database book · p. ${n}`, text: text(`Page${n}`), createdAt: at, courses: ['Databases'],
  document: { materialId: 'document-dbbook', page: n, totalPages: 4, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'database-book.pdf', chapter, extractionVersion: 2 } });
const card = (id, citations = []) => ({ id, kind: 'flashcard', topic: 'Storage', prompt: `Question ${id}: what does the database promise here?`, answer: 'Durability.', explanation: 'See the source.', citations });
const cite = (sourceId, topic, i) => ({ sourceId, quote: fact(topic, i) });

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(bookPage(1, CHAPTERS[0]), bookPage(2, CHAPTERS[0]), bookPage(3, CHAPTERS[1]), bookPage(4, CHAPTERS[1]),
      { id: 'notes', title: 'Lecture notes', text: text('Notes'), createdAt: at, courses: ['Databases'], document: { materialId: 'document-notes', format: 'md', filename: 'lecture-notes.md' } },
      { id: 'slides', title: 'Unused slides', text: text('Slides'), createdAt: at, courses: ['Databases'] },
      { id: 'loose', title: 'Loose handout', text: text('Loose'), createdAt: at, courses: [] });
    state.decks.push({ id: 'deck-index', title: 'Indexes deck', course: 'Databases', cards: [card('i1', [cite('book-p1', 'Page1', 1)]), card('i2', [cite('book-p3', 'Page3', 1)]),
      card('i3', [cite('book-p2', 'Page2', 2), cite('book-p4', 'Page4', 2)]), card('i4'), card('i5', [cite('loose', 'Loose', 1)])] },
    { id: 'deck-notes', title: 'Notes deck', course: 'Databases', cards: [card('n1', [cite('notes', 'Notes', 2)]), card('n2', [cite('notes', 'Notes', 3)])] });
    state.focus = { mode: 'class', course: 'Databases', role: '', jd: '', targetTopics: [] };
  });
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.outline-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

/** Answers every question of the round that is on the page, one at a time: waits for a question not answered yet, flips it, grades it, and only then looks for the next, so a slow
    answer never makes the loop grade the same card twice or look for a button the result page has already replaced (#1131: the old loop watched the card's text, which a flip alone changes). */
async function answerRound(page, count) {
  const answered = [];
  for (let step = 0; step < count; step += 1) {
    const handle = await page.waitForFunction((done) => {
      const ids = [...document.querySelectorAll('.flashcard')].map(card => /Question (i\d+):/.exec(card.innerText)?.[1]).filter(Boolean);
      return ids.find(id => !done.includes(id)) || false;
    }, answered, { timeout: 30000 });
    const id = await handle.jsonValue(), card = page.locator('.flashcard', { hasText: `Question ${id}:` });
    await card.locator('[data-usage="review.flip"]').click({ timeout: 30000 });
    await page.locator('.grade.high').first().click({ timeout: 30000 });
    answered.push(id);
  }
  await page.locator('.result-page').waitFor({ timeout: 30000 });
  return answered;
}

/** A grade is answered late, as it is on a busy machine: the loop that answers the round has to wait for it, not for the clock of the day. */
const slowGrades = (page, ms = 400) => page.route('**/api/call', async (route) => {
  if (/"action":"review\.answer"/.test(route.request().postData() || '')) await new Promise(done => setTimeout(done, ms));
  await route.continue();
});

test('总纲: open from the home, expand, pick two questions in two chapters, practise exactly those, come back (1280 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-outline-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_OUTLINE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    // The pictures are made in both themes; the checks run once.
    for (const [theme, width] of (shots ? [['dark', 1280], ['dark', 420], ['light', 1280], ['light', 420]] : [['dark', 1280], ['dark', 420]])) {
      const tag = `${width}${theme === 'light' ? '-light' : ''}`;
      const { page, errors, context } = await openPage(browser, running, { width, height: 1000, theme });
      await slowGrades(page);
      await page.goto(running.server.url);
      const link = page.locator('.course-header .outline-entry');
      await link.waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.course-route details').count(), 0, `${width}px: the folded 课程路线 list is gone`);
      assert.equal(await page.locator('.course-route-outline').count(), 0, `${width}px: the tiny link line under the bar is gone`);
      assert.equal(await page.locator('.today-go').count(), 1, `${width}px: the home keeps one continue button`);
      const entries = page.locator('.outline-entry');
      assert.equal(await entries.count(), 2, `${width}px: one 总纲 button beside the course title and one in the 学习目录 heading`);
      assert.equal(await page.locator('.map-heading .section-heading-actions > .sh-popover-anchor:first-child .outline-entry').count(), 1, 'the first of the 学习目录 heading buttons');
      for (const where of ['.course-header', '.map-heading']) {
        const button = page.locator(`${where} .outline-entry`);
        assert.equal(await button.evaluate(element => element.tagName), 'BUTTON', `${where}: a real button`);
        assert.equal(await button.evaluate(element => element.classList.contains('sh-btn--secondary') && !element.classList.contains('sh-btn--primary') && !element.classList.contains('sh-btn--link')), true, `${where}: secondary, not primary`);
        assert.equal(await button.innerText(), '总纲');
        assert.equal(await button.getAttribute('title'), null, 'the words are a Tooltip, not a title attribute');
      }
      assert.equal(await page.locator('.sh-btn--primary:visible').count(), 1, `${width}px: exactly one primary button on the home`);
      const place = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const title = rect('.course-header .sh-page-header__title'), button = rect('.course-header .outline-entry'), bar = rect('.course-route-bar'), screen = window.innerWidth;
        return { sameRow: button.top < title.bottom && button.bottom > title.top, above: button.bottom <= bar.top, inside: button.left >= 0 && button.right <= screen, height: button.height, gap: Math.round(bar.top - button.bottom) };
      });
      assert.equal(place.above && place.inside, true, `${width}px: above the progress bar and inside the window: ${JSON.stringify(place)}`);
      assert.ok(place.height >= 28, `${width}px: a button-sized target: ${JSON.stringify(place)}`);
      if (width === 1280) assert.equal(place.sameRow, true, `1280px: on the course title's row: ${JSON.stringify(place)}`);
      const home = { doc: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) };
      assert.equal(home.doc <= 0, true, `${width}px: the home does not scroll sideways: ${JSON.stringify(home)}`);
      await link.hover();
      await page.locator('[role="tooltip"]', { hasText: '按资料的章节找题、挑题练' }).first().waitFor({ state: 'visible', timeout: 5000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `home-${tag}.png`) });
      await page.mouse.move(0, 0);
      // The 学习目录 heading's button opens the same page.
      await page.locator('.map-heading .outline-entry').click();
      await page.locator('.outline-tree').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.outline-page h1').innerText(), /总纲 · Databases/, `${width}px: the 学习目录 button opens the 总纲`);
      await page.goto(running.server.url);
      await link.waitFor({ timeout: 30000 });
      await link.click();
      const tree = page.locator('.outline-tree');
      await tree.waitFor({ timeout: 30000 });
      assert.match(await page.locator('.outline-page h1').innerText(), /总纲 · Databases/);
      const rows = await page.locator('.outline-tree > .outline-row').evaluateAll(list => list.map(row => [row.dataset.key, row.querySelector('.outline-row__title')?.innerText, row.querySelector('.mastery-line__text')?.innerText]));
      assert.deepEqual(rows.map(row => row[1]), ['database-book', 'Lecture notes', 'Unused slides', '未归位'], `${width}px: ${JSON.stringify(rows)}`);
      assert.match(rows[0][2], /3 题/, 'i1, i2 and i3 (cited in both chapters, once)');
      assert.match(rows[2][2], /还没出题/);
      assert.match(rows[3][2], /2 题/, '未归位 counts the question that cites nothing and the one on an uncategorised material');

      const toggle = key => page.locator(`[data-outline-toggle="${key}"]`).click();
      const book = rows[0][0];
      if (await page.locator(`[data-outline-toggle="${book}"]`).getAttribute('aria-expanded') !== 'true') await toggle(book);
      await page.locator(`[data-outline-toggle="${book}#1"]`).waitFor();
      for (const index of [0, 1]) if (await page.locator(`[data-outline-toggle="${book}#${index}"]`).getAttribute('aria-expanded') !== 'true') await toggle(`${book}#${index}`);
      await page.locator(`[data-key="${book}#1"] .outline-q`).first().waitFor();
      assert.deepEqual(await page.locator(`[data-key="${book}#0"] .outline-q`).evaluateAll(list => list.map(item => item.dataset.card)), ['i1', 'i3']);
      assert.deepEqual(await page.locator(`[data-key="${book}#1"] .outline-q`).evaluateAll(list => list.map(item => item.dataset.card)), ['i2', 'i3']);
      assert.match(await page.locator(`[data-key="${book}#0"] [data-card="i3"]`).innerText(), /也列在别处/);
      if (await page.locator('[data-outline-toggle="unplaced"]').getAttribute('aria-expanded') !== 'true') await toggle('unplaced');
      await page.locator('[data-key="unplaced"] .outline-q').first().waitFor();
      assert.match(await page.locator('[data-key="unplaced"] [data-card="i4"]').innerText(), /没有引用资料/);
      assert.match(await page.locator('[data-key="unplaced"] [data-card="i5"]').innerText(), /引用的资料没有归入这门课/);
      const hint = page.locator('[data-key="unplaced"] .outline-row__hint');
      if (shots) await page.locator('[data-key="unplaced"]').screenshot({ path: join(shots, `unplaced-${tag}.png`) });
      assert.match(await hint.innerText(), /把这些资料归入这门课后，引用它们的题会出现在总纲里：Loose handout/);

      await page.locator('.outline-what').hover();
      const tip = page.locator('[role="tooltip"]', { hasText: '到期 → 薄弱 → 新题' });
      await tip.waitFor({ state: 'visible', timeout: 5000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `outline-hover-${tag}.png`) });
      await page.mouse.move(0, 0);

      await page.locator(`[data-key="${book}#0"] [data-card="i1"] input[type="checkbox"]`).check();
      await page.locator(`[data-key="${book}#1"] [data-card="i2"] input[type="checkbox"]`).check();
      const bar = page.locator('.outline-bar');
      await bar.locator('.outline-bar__count', { hasText: '已选 2 题' }).waitFor();
      const overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await page.screenshot({ path: join(shots, `outline-${tag}.png`), fullPage: true }); await bar.screenshot({ path: join(shots, `bar-${tag}.png`) }); }

      const started = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await bar.locator('.sh-btn--primary').click();
      const args = JSON.parse((await started).postData()).args;
      assert.deepEqual(args.scope.map(ref => ref.cardId).sort(), ['i1', 'i2'], `${width}px: the round is exactly the two picked questions`);
      assert.equal(args.fresh, true);
      const back = page.locator('.review-return', { hasText: '回到总纲' });
      await back.waitFor({ timeout: 30000 });
      const { runs } = await running.api('snapshot');
      assert.deepEqual(runs.at(-1).scope.map(ref => ref.cardId).sort(), ['i1', 'i2'], 'the run holds exactly those two');
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `review-${tag}.png`) });
      // Finished, the result page goes back to the 总纲 first (no second line: the 总纲 has no point to name); the page's own next step is the plain button after it.
      assert.deepEqual((await answerRound(page, 2)).sort(), ['i1', 'i2'], `${width}px: each picked question is answered once`);
      const primary = page.locator('.result-next .sh-btn--primary');
      assert.equal(await page.locator('.result-page .sh-btn--primary').count(), 1, `${width}px: one filled button on the result page`);
      assert.equal((await primary.innerText()).replace(/\s+/g, ' ').trim(), '回到总纲', `${width}px: the main button goes back to the 总纲, with no second line`);
      assert.equal(await primary.locator('small').count(), 0);
      assert.equal(await page.locator('.review-return').count(), 0, `${width}px: the header does not say the same thing twice`);
      await settleAnimations(page);
      if (shots) {
        await page.screenshot({ path: join(shots, `outline-result-${tag}.png`), fullPage: true });
        // The 点评 card below the button: a plain surface, and the three levels in three tones, none of them blue.
        await page.locator('.coach-debrief h2').waitFor({ timeout: 10000 });
        await page.locator('.coach-debrief').scrollIntoViewIfNeeded();
        await settleAnimations(page);
        await page.locator('.coach-debrief').screenshot({ path: join(shots, `outline-result-debrief-${tag}.png`) });
      }
      await primary.click();
      await tree.waitFor();
      assert.equal(await page.locator(`[data-outline-toggle="${book}#0"]`).getAttribute('aria-expanded'), 'true', `${width}px: back on the outline as it was left`);
      if (width === 420) {
        await page.locator('[data-key="unplaced"] .outline-row__hint .sh-btn').click();
        await page.locator('.sources-page').first().waitFor({ timeout: 30000 });
      }
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* The round does not depend on the day (#1131: the test looked date-dependent because it failed after midnight; the cause was a loop that raced the answer of a grade, and the same
   failure happened at noon). Run it with the page's clock and the service's clock fixed at several days, including mid-October, both sides of midnight, a year end and a day in March.
   Both clocks are fixed to the same instant.
   (#1152: playwright-core's Clock.setFixedTime embeds Node's Date.now() into the browser initScript's controller.log('setFixedTime', Date.now(), timeMillis). If Node's Date is mocked
   BEFORE setFixedTime runs, Chromium's ClockController._replayLogOnce() advances ticks by (realDateNow - mockedDay); for a day 25–49 days in the past (e.g. Oct 15 when run in Nov,
   or Nov 17 once Dec 12 passes), ticks > 2^31 - 1 and _updateRealTimeTimer()'s negative delay (100 - ticks) wraps around WebIDL signed 32-bit long (ToInt32) to +10..24 days, freezing
   every page timer including React's Suspense throttle on deferredView. Fixing the browser clock BEFORE enabling Node's mock.timers keeps lastLogTime at real wall-clock time while both
   browser Date and server Date stay frozen at `day`.) */
const DAYS = [
  '2026-10-15T12:00:00+08:00',
  '2026-11-17T12:00:00+08:00',
  '2026-11-17T23:59:40+08:00',
  '2026-11-18T00:00:20+08:00',
  '2026-11-18T03:20:00+08:00',
  '2026-12-31T23:59:50+00:00',
  '2027-03-01T00:00:10-08:00',
];

/** Fix the browser clock while Node's Date is still real, then freeze Node's Date for the server (#1152). */
async function freezePageThenServerClock(context, day, timers = mock.timers) {
  const target = new Date(day);
  await context.clock.setFixedTime(target);
  timers.enable({ apis: ['Date'], now: target });
  return target.getTime();
}

test('总纲: the practice round of two picked questions finishes on any day (the clock fixed at seven days, including mid-October and both sides of midnight)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-outline-days-'));
  await buildPreview({ outdir: dist });
  try {
    for (const day of DAYS) {
      const { page, errors, context } = await openPage(browser, null, { width: 420, height: 1000, theme: 'dark' });
      let running;
      try {
        const expectedMs = await freezePageThenServerClock(context, day);
        running = await startLateServer({ distDir: dist, seed });
        await slowGrades(page);
        await page.goto(running.server.url);
        assert.equal(Date.now(), expectedMs, `${day}: server clock is fixed to the target day`);
        assert.equal(await page.evaluate(() => Date.now()), expectedMs, `${day}: browser clock is fixed to the target day`);
        await page.locator('.course-header .outline-entry').click();
        await page.locator('.outline-tree').waitFor({ timeout: 30000 });
        const book = await page.locator('.outline-tree > .outline-row').first().getAttribute('data-key');
        if (await page.locator(`[data-outline-toggle="${book}"]`).getAttribute('aria-expanded') !== 'true') await page.locator(`[data-outline-toggle="${book}"]`).click();
        for (const index of [0, 1]) if (await page.locator(`[data-outline-toggle="${book}#${index}"]`).getAttribute('aria-expanded') !== 'true') await page.locator(`[data-outline-toggle="${book}#${index}"]`).click();
        await page.locator(`[data-key="${book}#0"] [data-card="i1"] input[type="checkbox"]`).check();
        await page.locator(`[data-key="${book}#1"] [data-card="i2"] input[type="checkbox"]`).check();
        await page.locator('.outline-bar .outline-bar__count', { hasText: '已选 2 题' }).waitFor();
        await page.locator('.outline-bar .sh-btn--primary').click();
        assert.deepEqual((await answerRound(page, 2)).sort(), ['i1', 'i2'], `${day}: each picked question is answered once`);
        assert.equal((await page.locator('.result-next .sh-btn--primary').innerText()).replace(/\s+/g, ' ').trim(), '回到总纲', `${day}: the round ends on the way back to the 总纲`);
        assert.deepEqual(errors, [], `${day}: no page errors`);
      } finally {
        mock.timers.reset();
        await context.close().catch(() => {});
        if (running) await running.close();
      }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

test('#1152: freezePageThenServerClock sets browser clock before mocking Node Date so Playwright ClockController never overflows WebIDL int32 timers', async (t) => {
  const oct15 = '2026-10-15T12:00:00+08:00';
  const expectedMs = new Date(oct15).getTime();
  let nodeNowDuringSetFixedTime = null;
  const fakeContext = {
    clock: {
      async setFixedTime(date) {
        nodeNowDuringSetFixedTime = Date.now();
        assert.equal(date.getTime(), expectedMs);
      },
    },
  };
  const realBefore = Date.now();
  try {
    await freezePageThenServerClock(fakeContext, oct15, t.mock.timers);
    assert.ok(Math.abs(nodeNowDuringSetFixedTime - realBefore) < 5000, 'setFixedTime must observe real Node Date.now(), not the mocked past date');
    assert.equal(Date.now(), expectedMs, 'server clock is frozen at the target October instant after setFixedTime');
  } finally {
    t.mock.timers.reset();
  }
  assert.ok(DAYS.includes(oct15), 'mid-October is restored to the multi-day outline test matrix');
});
