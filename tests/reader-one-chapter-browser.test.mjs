/* global document window Element */
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

/* The reader draws one chapter (owner decision 2026-11-06; a real 513-page book blocked the page for 9.6 s with 53,687 nodes): a generated converted book of
   500 pages in 25 chapters of 20, with about 3000 inline formulas, seeded through the real store, fake model, no key. In the real page at 1280 and 420 px:
   opening draws one chapter (its 20 pages, under 6000 nodes, the formulas drawn only near the screen, no long task near the old one), scrolling does not
   measure the outline entries, the 目录 lists the chapters, and every way to a page reaches the chapter that holds it: 下一章, a chapter row, the 目录 filter, find in
   another chapter, the 资料 row's 「查看 N 章」, a citation (看这题的原文 → 回到这道题) and the way back to reading from a practice run (回到原文).
   Pictures go to READER_CHAPTER_SHOTS when set. */

const at = '2026-11-01T08:00:00.000Z';
const REFUSED = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
const PAGES = 500, PER_CHAPTER = 20, CHAPTERS = PAGES / PER_CHAPTER;
const UNIQUE_PAGE = 377, CITED_PAGE = 333, PRACTICE_PAGE = 205;
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const paragraph = (page, n) => `Paragraph ${n} of page ${page} relates output $Y_{${page}} = C + I + G$ to demand, with $\\frac{\\Delta Y}{\\Delta G} = ${n + 1}$ as the multiplier.`;
const pageText = page => [`Heading ${page}`, paragraph(page, 1), paragraph(page, 2), `${paragraph(page, 3)}${page === UNIQUE_PAGE ? ' The zebracorn effect appears only here.' : ''}`].join('\n\n');
const source = page => ({ id: `macro-p${page}`, title: `Macro book · p.${page}`, text: pageText(page), createdAt: at, courses: ['宏经'],
  document: { id: 'macro-book-hash', materialId: 'document-macro-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'macro-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const quoteOn = page => `Paragraph 2 of page ${page} relates output`;
const card = (id, page) => ({ id, kind: 'flashcard', topic: 'Output', objective: `Objective ${id}`, prompt: `Question about page ${page}: what relates output to demand?`, answer: 'The multiplier.',
  hint: 'Think.', explanation: 'See the book.', misconception: 'None.', citations: [{ sourceId: `macro-p${page}`, quote: quoteOn(page) }] });

const seed = async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => source(index + 1)));
    state.decks.push({ id: 'macro-deck', title: 'Macro deck', course: '宏经', cards: [card('cited', CITED_PAGE), card('practised', PRACTICE_PAGE)] });
  });
  await service.dispose();
};

/** What the reader draws: its page sections (their pages), formulas drawn and waiting, and the nodes of the whole page. */
const drawn = page => page.evaluate(() => {
  const viewer = document.querySelector('.study-document-viewer');
  return { pages: [...viewer.querySelectorAll('.reader-section[data-study-page]')].map(node => Number(node.dataset.studyPage)), nodes: document.querySelectorAll('*').length,
    formulas: viewer.querySelectorAll('.reader-math').length, pending: viewer.querySelectorAll('.reader-math__view--pending').length };
});
/** Whether page `n` is in the reading area (its section overlaps the top half). */
const pageInView = (page, n) => page.evaluate(n => {
  const node = document.querySelector(`.study-document-viewer [data-study-page="${n}"]`), area = document.querySelector('.study-document-viewer .reader-scroll')?.getBoundingClientRect();
  if (!node || !area) return false;
  const rect = node.getBoundingClientRect();
  return rect.top < area.top + area.height / 2 && rect.bottom > area.top;
}, n);
const chapterPages = index => Array.from({ length: PER_CHAPTER }, (_, n) => index * PER_CHAPTER + n + 1);
const waitChapter = (page, index, what) => until(async () => JSON.stringify((await drawn(page)).pages) === JSON.stringify(chapterPages(index)), what, { timeoutMs: 30000 });

test('the reader draws one chapter of a 500-page book and every way to a page reaches its chapter (1280 and 420 px)', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-chapter-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildPreview({ outdir: dist });
  const shots = process.env.READER_CHAPTER_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const width of [1280, 420]) {
    const running = await startLateServer({ distDir: dist, seed });
    try {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript(() => {
        window.__long = [];
        try { new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* no longtask timing */ }
      });
      const refused = [];
      page.on('response', response => { if (response.status() === 400) { try { refused.push(JSON.parse(response.request().postData() || '{}').action); } catch { refused.push(response.url()); } } });
      const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `reader-chapter-${name}-${width}.png`) }); };
      const viewer = page.locator('.study-document-viewer');
      const openOutline = async () => { if (!(await viewer.locator('.reader-outline').count())) await viewer.getByRole('button', { name: '目录', exact: true }).click(); await viewer.locator('.reader-outline').waitFor(); };
      const closeReader = async () => { await page.keyboard.press('Escape'); await until(async () => !(await viewer.count()), 'the reader to close', { timeoutMs: 15000 }); };
      await page.goto(running.server.url);
      await (await revealNavRow(page, 'sources')).dispatchEvent('click');
      const row = page.locator('.source-doc', { hasText: 'macro-book' }).first();
      await row.waitFor({ timeout: 60000 });

      // ---- open: one chapter, few nodes, formulas drawn near the screen only ----
      await page.evaluate(() => { window.__long = []; });
      await row.locator('.source-main').click();
      await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 });
      await waitChapter(page, 0, 'the first chapter');
      await page.waitForTimeout(1500);
      const first = await drawn(page), long = await page.evaluate(() => window.__long.slice());
      t.diagnostic(`${width}px open: ${first.nodes} nodes, ${first.pages.length} pages, formulas ${first.formulas} (${first.pending} waiting), long tasks ${JSON.stringify(long)}`);
      assert.equal(first.pages.length, PER_CHAPTER, 'the sections drawn are the pages of the chapter');
      assert.ok(first.nodes < 6000, `${width}px: under 6000 nodes (${first.nodes})`);
      assert.equal(first.formulas, PER_CHAPTER * 6, 'every formula of the chapter is there');
      assert.ok(first.pending > first.formulas / 2, `most formulas wait until they come near the screen (${first.pending} of ${first.formulas})`);
      assert.ok(Math.max(0, ...long) < 2000, `${width}px: no long task anywhere near the old seconds (${JSON.stringify(long)})`);
      await shot('open');

      // ---- scrolling does not measure every outline entry ----
      if (width === 1280) await openOutline();
      const measured = await page.evaluate(async () => {
        const area = document.querySelector('.study-document-viewer .reader-scroll'), original = Element.prototype.getBoundingClientRect;
        let calls = 0;
        Element.prototype.getBoundingClientRect = function counted() { calls += 1; return original.call(this); };
        for (let step = 0; step < 12; step += 1) { area.scrollTop += 400; await new Promise(done => window.requestAnimationFrame(() => window.requestAnimationFrame(done))); }
        Element.prototype.getBoundingClientRect = original;
        return { calls, entries: document.querySelectorAll('.study-document-viewer [data-outline-id]').length };
      });
      t.diagnostic(`${width}px: ${measured.calls} getBoundingClientRect calls over 12 scroll steps (${measured.entries} outline targets drawn)`);
      assert.ok(measured.calls < 12 * 6, `scrolling measures no outline entry per frame (${measured.calls} calls over 12 steps)`);
      const typed = await drawn(page);
      assert.ok(typed.pending < first.pending, `formulas are drawn as they come near the screen (${first.pending} → ${typed.pending} waiting)`);

      // ---- 下一章 at the bottom ----
      await viewer.locator('.reader-pager[data-pager="chapter"] [data-direction="next"]').click();
      await waitChapter(page, 1, '下一章 to draw chapter 2');
      assert.ok(await pageInView(page, 21), 'the next chapter opens at its top');

      // ---- the 目录: chapters, a chapter row, the filter ----
      await openOutline();
      const outline = viewer.locator('.reader-outline');
      const rows = await outline.locator('li').allInnerTexts();
      assert.equal(rows.filter(text => /Chapter \d+/.test(text)).length, CHAPTERS, 'the 目录 lists every chapter');
      assert.ok(rows.length <= CHAPTERS + PER_CHAPTER + 1, `only the pages of the current chapter are open (${rows.length} rows)`);
      await outline.locator('.reader-outline__link', { hasText: 'Chapter 5' }).first().click();
      await waitChapter(page, 4, 'the chapter row to draw chapter 5');
      assert.ok(await pageInView(page, 81), 'a chapter opens at its top');
      await openOutline();
      await outline.getByRole('searchbox', { name: '在目录中查找' }).fill('Heading 450');
      await outline.locator('.reader-outline__link', { hasText: 'Heading 450' }).first().click();
      await waitChapter(page, chapterOf(450), 'the filtered page to draw its chapter');
      await until(() => pageInView(page, 450), 'page 450 in view', { timeoutMs: 15000 });
      await shot('outline');

      // ---- find in another chapter ----
      await viewer.getByRole('button', { name: '在文中查找', exact: true }).click();
      await page.getByRole('searchbox', { name: '在文中查找' }).fill('zebracorn');
      const elsewhere = page.locator('[data-find-elsewhere] .reader-find__chapter');
      await elsewhere.first().waitFor({ timeout: 15000 });
      assert.match(await elsewhere.first().innerText(), new RegExp(`Chapter ${chapterOf(UNIQUE_PAGE) + 1}[\\s\\S]*第 ${UNIQUE_PAGE} 页 · 1 处`));
      assert.equal(await page.locator('.reader-find__count').innerText(), '本章没有');
      await shot('find');
      // Both ways there: the chip, and Enter in the box (no match here, so it goes to the next chapter that has one).
      if (width === 420) await page.getByRole('searchbox', { name: '在文中查找' }).press('Enter');
      else await elsewhere.first().click();
      await waitChapter(page, chapterOf(UNIQUE_PAGE), 'find to draw the chapter of the match');
      await until(async () => (await page.locator('.reader-find__count').innerText()) === '1 / 1', 'the match counted in its chapter', { timeoutMs: 15000 });
      await until(() => pageInView(page, UNIQUE_PAGE), 'the match in view', { timeoutMs: 15000 });
      await page.keyboard.press('Escape');

      // ---- 「查看 N 章」 on the 资料 row opens a given chapter ----
      await closeReader();
      await row.getByRole('button', { name: `查看 ${CHAPTERS} 章` }).click();
      await row.locator('[data-chapter-index="12"] .source-doc__row').click();
      await viewer.waitFor({ timeout: 30000 });
      await waitChapter(page, 12, '「查看 N 章」 to open chapter 13');
      await closeReader();

      // ---- a citation: 看这题的原文 opens the chapter of the cited page, the quote in view; 回到这道题 ----
      await page.goto(running.server.url);
      await page.getByRole('button', { name: '开始今日学习' }).first().click();
      await page.locator('.review-page').waitFor({ timeout: 30000 });
      const answer = async () => {
        await page.locator('.review-heading h1').first().click().catch(() => {});
        await page.keyboard.press('Space'); await page.waitForTimeout(400);
        await page.keyboard.press('5'); await page.waitForTimeout(400);
      };
      for (let guard = 0; guard < 3; guard += 1) {
        if ((await page.locator('.review-page').innerText()).includes(`page ${CITED_PAGE}`)) break;
        await answer();
        await page.keyboard.press('Enter'); await page.waitForTimeout(600);
      }
      await answer();
      const sourceButton = page.getByRole('button', { name: '看这题的原文' });
      await sourceButton.waitFor({ timeout: 15000 }).catch(async error => { await shot('citation-missing'); throw new Error(`${error.message}\n${(await page.locator('main').innerText()).slice(0, 600)}`); });
      await sourceButton.click();
      await viewer.waitFor({ timeout: 30000 });
      await waitChapter(page, chapterOf(CITED_PAGE), 'the citation to draw the chapter of its page');
      const quote = await until(() => page.evaluate(() => {
        const set = window.CSS?.highlights?.get('study-source-quote'), range = set ? [...set][0] : null;
        if (!range) return null;
        const rect = range.getBoundingClientRect(), area = document.querySelector('.study-document-viewer .reader-scroll').getBoundingClientRect();
        return { text: range.toString(), inView: rect.height > 0 && rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1 };
      }), 'the cited passage highlighted', { timeoutMs: 20000 });
      assert.equal(quote.text, quoteOn(CITED_PAGE));
      assert.ok(quote.inView, 'the cited passage is in view');
      await shot('citation');
      await viewer.getByRole('button', { name: '回到这道题' }).click();
      await page.locator('.review-page').waitFor();
      // The rest of the day's run is answered, so the practice below starts a run of its own.
      for (let guard = 0; guard < 4 && !(await page.locator('.result-page').count()); guard += 1) {
        await page.locator('.review-heading h1').first().click().catch(() => {});
        await page.keyboard.press('Enter'); await page.waitForTimeout(600);
        if (!(await page.locator('.result-page').count())) await answer();
      }
      await page.locator('.result-page').waitFor({ timeout: 20000 });

      // ---- the way back from a practice run: 回到原文 reopens the chapter at the page it left ----
      await (await revealNavRow(page, 'sources')).dispatchEvent('click');
      await row.locator('.source-main').click();
      await waitChapter(page, 0, 'the reader opens at the first chapter again');
      await openOutline();
      await outline.getByRole('searchbox', { name: '在目录中查找' }).fill(`Heading ${PRACTICE_PAGE}`);
      await outline.locator('.reader-outline__link', { hasText: `Heading ${PRACTICE_PAGE}` }).first().click();
      await waitChapter(page, chapterOf(PRACTICE_PAGE), 'the practice page chapter');
      await until(() => pageInView(page, PRACTICE_PAGE), 'the practice page in view', { timeoutMs: 15000 });
      await page.waitForTimeout(600);
      await viewer.getByRole('button', { name: /做这几页的题/ }).first().click();
      const practice = page.getByRole('button', { name: /开始做这/ }).first();
      await practice.waitFor({ timeout: 15000 });
      await practice.click();
      await page.locator('.review-page').waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: '回到原文' }).click();
      await viewer.waitFor({ timeout: 30000 });
      await waitChapter(page, chapterOf(PRACTICE_PAGE), 'the way back to reading draws the chapter it left');
      await until(() => pageInView(page, PRACTICE_PAGE), 'the page it left in view', { timeoutMs: 15000 });
      await closeReader();

      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sideways <= 0, `${width}px: the page does not scroll sideways (${sideways})`);
      // A seeded book has no materials record, so the reader's translations (materials.translation.list) are refused for it, as before this change: those 400s only.
      assert.ok(refused.every(action => action === 'materials.translation.list'), `only the translation list is refused: ${JSON.stringify(refused)}`);
      assert.deepEqual(errors.filter(error => error !== REFUSED), [], 'no other console or page errors');
      await context.close();
    } finally {
      await running.close();
    }
  }
});
