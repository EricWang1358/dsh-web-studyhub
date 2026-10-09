import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* 总纲 in the real page at 1280 and 420 px: the home's course area opens it (the folded 课程路线 list is gone, one continue button stays); a
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
      { id: 'slides', title: 'Unused slides', text: text('Slides'), createdAt: at, courses: ['Databases'] });
    state.decks.push({ id: 'deck-index', title: 'Indexes deck', course: 'Databases', cards: [card('i1', [cite('book-p1', 'Page1', 1)]), card('i2', [cite('book-p3', 'Page3', 1)]),
      card('i3', [cite('book-p2', 'Page2', 2), cite('book-p4', 'Page4', 2)]), card('i4')] },
    { id: 'deck-notes', title: 'Notes deck', course: 'Databases', cards: [card('n1', [cite('notes', 'Notes', 2)]), card('n2', [cite('notes', 'Notes', 3)])] });
    state.focus = { mode: 'class', course: 'Databases', role: '', jd: '', targetTopics: [] };
  });
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.outline-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
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
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 1000 });
      await page.goto(running.server.url);
      const link = page.locator('.course-route-outline .sh-btn').first();
      await link.waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.course-route details').count(), 0, `${width}px: the folded 课程路线 list is gone`);
      assert.equal(await page.locator('.today-go').count(), 1, `${width}px: the home keeps one continue button`);
      if (shots) await page.screenshot({ path: join(shots, `home-${width}.png`) });
      await link.click();
      const tree = page.locator('.outline-tree');
      await tree.waitFor({ timeout: 30000 });
      assert.match(await page.locator('.outline-page h1').innerText(), /总纲 · Databases/);
      const rows = await page.locator('.outline-tree > .outline-row').evaluateAll(list => list.map(row => [row.dataset.key, row.querySelector('.outline-row__title')?.innerText, row.querySelector('.mastery-line__text')?.innerText]));
      assert.deepEqual(rows.map(row => row[1]), ['database-book', 'Lecture notes', 'Unused slides', '未归位'], `${width}px: ${JSON.stringify(rows)}`);
      assert.match(rows[0][2], /3 题/, 'i1, i2 and i3 (cited in both chapters, once)');
      assert.match(rows[2][2], /还没出题/);
      assert.match(rows[3][2], /1 题/, '未归位 counts the question that cites nothing');

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
      assert.match(await page.locator('[data-key="unplaced"] .outline-q').innerText(), /没有引用资料/);

      await page.locator('.outline-what').hover();
      const tip = page.locator('[role="tooltip"]', { hasText: '到期 → 薄弱 → 新题' });
      await tip.waitFor({ state: 'visible', timeout: 5000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `outline-hover-${width}.png`) });
      await page.mouse.move(0, 0);

      await page.locator(`[data-key="${book}#0"] [data-card="i1"] input[type="checkbox"]`).check();
      await page.locator(`[data-key="${book}#1"] [data-card="i2"] input[type="checkbox"]`).check();
      const bar = page.locator('.outline-bar');
      await bar.locator('.outline-bar__count', { hasText: '已选 2 题' }).waitFor();
      const overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await page.screenshot({ path: join(shots, `outline-${width}.png`), fullPage: true }); await bar.screenshot({ path: join(shots, `bar-${width}.png`) }); }

      const started = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await bar.locator('.sh-btn--primary').click();
      const args = JSON.parse((await started).postData()).args;
      assert.deepEqual(args.scope.map(ref => ref.cardId).sort(), ['i1', 'i2'], `${width}px: the round is exactly the two picked questions`);
      assert.equal(args.fresh, true);
      const back = page.locator('.review-detour', { hasText: '返回总纲' });
      await back.waitFor({ timeout: 30000 });
      const { runs } = await running.api('snapshot');
      assert.deepEqual(runs.at(-1).scope.map(ref => ref.cardId).sort(), ['i1', 'i2'], 'the run holds exactly those two');
      if (shots) await page.screenshot({ path: join(shots, `review-${width}.png`) });
      await back.click();
      await tree.waitFor();
      assert.equal(await page.locator(`[data-outline-toggle="${book}#0"]`).getAttribute('aria-expanded'), 'true', `${width}px: back on the outline as it was left`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
