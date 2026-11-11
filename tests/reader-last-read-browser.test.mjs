/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { until } from './helpers/wait.mjs';

/* 上次读到 in the real page: a converted book of 100 pages in 5 chapters, opened from its 资料 row. Read into chapter 3 and closed, the row opens
   it again at the same page (silently, as the review book does); back at the start the place is forgotten and the next open starts at page 1;
   a reader closed right after a scroll still keeps the place, and from a restored place the 目录 reaches another chapter; a chapter opened from
   「查看 N 章」 opens that chapter, not the kept place. Pictures go to READER_LAST_READ_SHOTS when set. */

const at = '2026-11-01T08:00:00.000Z';
const REFUSED = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
const PAGES = 100, PER_CHAPTER = 20, CHAPTERS = PAGES / PER_CHAPTER;
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const pageText = page => [`Heading ${page}`, ...[1, 2, 3, 4].map(n => `Paragraph ${n} of page ${page}: output relates to demand through spending, saving and the multiplier, read slowly.`)].join('\n\n');
const source = page => ({ id: `book-p${page}`, title: `Book · p.${page}`, text: pageText(page), createdAt: at, courses: ['宏经'],
  document: { id: 'last-read-book-hash', materialId: 'document-last-read-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'last-read-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const seed = async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => { state.sources.push(...Array.from({ length: PAGES }, (_, index) => source(index + 1))); });
  await service.dispose();
};

const drawnPages = page => page.evaluate(() => [...document.querySelectorAll('.study-document-viewer .reader-section[data-study-page]')].map(node => Number(node.dataset.studyPage)));
/** The page at the top of the reading area. */
const topPage = page => page.evaluate(() => {
  const area = document.querySelector('.study-document-viewer .reader-scroll')?.getBoundingClientRect();
  if (!area) return 0;
  const hit = [...document.querySelectorAll('.study-document-viewer .reader-section[data-study-page]')].find(node => node.getBoundingClientRect().bottom > area.top + 40);
  return hit ? Number(hit.dataset.studyPage) : 0;
});
const chapterPages = index => Array.from({ length: PER_CHAPTER }, (_, n) => index * PER_CHAPTER + n + 1);

let built = null;
const previewDist = () => built ??= (async () => {
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-last-read-dist-'));
  await buildPreview({ outdir: dist });
  return dist;
})();
test.after(async () => { if (built) await rm(await built.catch(() => null) ?? '', { recursive: true, force: true }); });

test('a material opened from its 资料 row goes back to where it was last read; 从头读 and a chosen chapter do not', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const running = await startLateServer({ distDir: await previewDist(), seed });
  t.after(() => running.close?.());
  const { page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
  const refused = [];
  page.on('response', response => { if (response.status() === 400) { try { refused.push(JSON.parse(response.request().postData() || '{}').action); } catch { refused.push(response.url()); } } });
  const viewer = page.locator('.study-document-viewer');
  const shots = process.env.READER_LAST_READ_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `last-read-${name}.png`) }); };
  const waitChapter = (index, what) => until(async () => JSON.stringify(await drawnPages(page)) === JSON.stringify(chapterPages(index)), what, { timeoutMs: 30000 });
  const closeReader = async () => { await page.keyboard.press('Escape'); await until(async () => !(await viewer.count()), 'the reader to close', { timeoutMs: 15000 }); };
  /** Wheel over the text (the learner's own scroll) until page `n` is at the top. */
  const wheelTo = async n => {
    const box = await viewer.locator('.reader-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await until(async () => { if ((await topPage(page)) >= n) return true; await page.mouse.wheel(0, 500); await page.waitForTimeout(60); return false; }, `page ${n} at the top`, { timeoutMs: 30000 });
  };
  await page.goto(running.server.url);
  await (await revealNavRow(page, 'sources')).dispatchEvent('click');
  const row = page.locator('.source-doc', { hasText: 'last-read-book' }).first();
  await row.waitFor({ timeout: 60000 });
  const openRow = async () => { await row.locator('.source-main').click(); await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 }); };

  // First open: the start. Read on into chapter 3 (下一章 twice), down to page 50.
  await openRow();
  await waitChapter(0, 'the first chapter');
  const readToChapter3 = async () => {
    for (const index of [1, 2]) {
      await viewer.locator('.reader-pager[data-pager="chapter"] [data-direction="next"]').click();
      await waitChapter(index, `chapter ${index + 1}`);
    }
    await wheelTo(50);
    return topPage(page);
  };
  const left = await readToChapter3();
  await page.waitForTimeout(1200);
  await closeReader();

  // Again from the row: chapter 3, the same page, without a word (as the review book lands at its kept place).
  await openRow();
  await waitChapter(chapterOf(left), 'the chapter last read');
  await until(async () => Math.abs((await topPage(page)) - left) <= 1, `page ${left} at the top again`, { timeoutMs: 15000 });
  await shot('restored');

  // Back at the start (the 目录's first chapter): the place is forgotten and the next open starts at page 1.
  const outline = viewer.locator('.reader-outline');
  if (!(await outline.count())) await viewer.getByRole('button', { name: '目录', exact: true }).click();
  await outline.locator('.reader-outline__link', { hasText: 'Chapter 1' }).first().click();
  await waitChapter(0, 'the 目录 to draw the first chapter');
  assert.equal(await topPage(page), 1);
  await page.waitForTimeout(1200);
  await closeReader();
  await openRow();
  await waitChapter(0, 'the start after going back to it');
  await page.waitForTimeout(800);
  assert.equal(await topPage(page), 1);

  // Closed right after a scroll, before the keep that follows it: closing keeps the place.
  const quick = await readToChapter3();
  await page.waitForTimeout(250); // past one measure, well before the keep after the scroll ends
  await closeReader();
  await openRow();
  await waitChapter(chapterOf(quick), 'the chapter left by a quick close');
  await until(async () => Math.abs((await topPage(page)) - quick) <= 1, `page ${quick} after a quick close`, { timeoutMs: 15000 });

  // From the restored place the 目录 still reaches another chapter.
  if (!(await outline.count())) await viewer.getByRole('button', { name: '目录', exact: true }).click();
  await outline.getByRole('searchbox', { name: '在目录中查找' }).fill('Heading 85');
  await outline.locator('.reader-outline__link', { hasText: 'Heading 85' }).first().click();
  await waitChapter(chapterOf(85), 'the 目录 to draw the chapter of page 85');
  await closeReader();

  // A chapter chosen from 「查看 N 章」 opens that chapter, not the kept place.
  await row.getByRole('button', { name: `查看 ${CHAPTERS} 章` }).click();
  await row.locator('[data-chapter-index="3"] .source-doc__row').click();
  await viewer.waitFor({ timeout: 30000 });
  await waitChapter(3, '「查看 N 章」 to open chapter 4');
  await closeReader();
  // A seeded book has no materials record, so its per-material lists (translations, the 批注 that carry 词解, the learner's marks) are refused, as in
  // reader-one-chapter-browser: those 400s only.
  assert.ok(refused.every(action => ['materials.translation.list', 'materials.annotation.list', 'materials.marks.list'].includes(action)), `only the per-material lists are refused: ${JSON.stringify(refused)}`);
  assert.deepEqual(errors.filter(error => error !== REFUSED), [], 'no other console or page errors');
});
