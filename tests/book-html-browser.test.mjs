/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { exportBook } from '../lib/course-book-export.js';
import { bookHtmlFile } from '../ui/book/book-html.js';
import { cardOf, exportBook as book, GEN } from './helpers/course-book-export-book.mjs';

/* The whole 复习全书 as one page (#896, ui/book/book-html.js) in a real Chromium, opened from a file with the network off at 420 and 1440 px: nothing is
   requested, nothing scrolls sideways even with a wide table, a long unbreakable word and a long formula, the maths is drawn, a footnote mark goes to its
   footnote and back, and printed (A4) each chapter starts a page, which the PDF shows by its page count. Screenshots and the PDF go to BOOK_HTML_SHOTS. */

const LONG = 'unbreakableword'.repeat(14);
const WIDE = ['| Column one | Column two | Column three | Column four |', '| --- | --- | --- | --- |',
  `| ${LONG} | ${'wide cell text '.repeat(8)} | x | y |`].join('\n');
const INLINE = '$' + Array.from({ length: 40 }, (_, at) => `y_{${at}}`).join('') + '$';
const FORMULA = '$$' + Array.from({ length: 24 }, (_, at) => `x_{${at}}`).join(' + ') + '$$';

/** The page as the export dialog saves it (bookHtmlFile: with the formula stylesheet and fonts when it draws a formula). */
async function sample() {
  const done = exportBook(book({ gen: GEN.replace('串联时 A = A1 x A2。', () => `串联时 $A = A_1 \\times A_2$。 A long one in a line: ${INLINE} and on.\n\n${FORMULA}\n\n${WIDE}\n\n${LONG}\n\n\`${LONG}\`\n`) }), { cardOf, answerKey: true, questions: 'all' });
  return (await bookHtmlFile(done)).html;
}

test('the book page opens offline, does not scroll sideways at 420 px, draws maths, links footnotes both ways, and prints a page per chapter', { timeout: 180000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const work = await mkdtemp(join(tmpdir(), 'study-book-html-'));
  const shots = process.env.BOOK_HTML_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    const path = join(work, 'book.html');
    await writeFile(path, await sample(), 'utf8');
    for (const width of [420, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, offline: true });
      const page = await context.newPage(), requested = [], errors = [];
      page.on('request', request => requested.push(request.url()));
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path).href);
      await page.locator('#h1').waitFor();
      assert.deepEqual(requested.filter(url => !url.startsWith('file:')), [], `${width}px: offline, no request left the file`);
      assert.deepEqual(errors, [], `${width}px: no page error`);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sideways <= 0, `${width}px: nothing scrolls sideways (${sideways}px too wide)`);
      assert.ok(await page.locator('main .katex math').count() >= 2, `${width}px: maths keeps its MathML`);
      assert.ok(await page.locator('main .katex-html').first().evaluate(element => element.getBoundingClientRect().width > 0), `${width}px: and the page draws it`);
      assert.equal(await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some(face => face.family.replace(/"/g, '') === 'KaTeX_Main' && face.status === 'loaded'); }), true,
        `${width}px: with the fonts inlined in the file`);
      // A footnote mark goes to its footnote, the footnote's arrow comes back to the mark.
      const mark = page.locator('a[href="#fn-h2g-1"]').first();
      await mark.click();
      assert.ok(await page.locator('#fn-h2g-1').evaluate(element => { const top = element.getBoundingClientRect().top; return top >= -1 && top < window.innerHeight; }), `${width}px: the footnote is on screen`);
      await page.locator('#fn-h2g-1 .fnback').click();
      assert.ok(await page.locator('#fnref-h2g-1').evaluate(element => { const top = element.getBoundingClientRect().top; return top >= -1 && top < window.innerHeight; }), `${width}px: and the arrow brings the mark back`);
      await page.locator('.contents a[href="#answers"]').click();
      assert.ok(await page.locator('#answers').evaluate(element => element.getBoundingClientRect().top < window.innerHeight), `${width}px: the contents goes to a chapter`);
      if (shots) await page.screenshot({ path: join(shots, `book-${width}.png`), fullPage: true });
      // On paper: every chapter starts a page; the PDF has at least one page for each chapter (and the cover).
      await page.emulateMedia({ media: 'print' });
      const chapters = await page.locator('h2.chapter').count();
      assert.ok(chapters >= 4);
      for (const style of await page.locator('h2.chapter').evaluateAll(list => list.map(element => window.getComputedStyle(element).breakBefore))) assert.equal(style, 'page', `${width}px: a chapter starts a page`);
      assert.equal(await page.locator('.footnotes .fn-title').first().evaluate(element => window.getComputedStyle(element).breakAfter), 'avoid', `${width}px: a footnote list stays with its title`);
      assert.equal(await page.locator('html').evaluate(element => window.getComputedStyle(element).colorScheme), 'light');
      if (width === 1440) {
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, ...(shots ? { path: join(shots, 'book-print.pdf') } : {}) });
        const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
        assert.ok(pages >= chapters + 1, `the PDF has a page for the cover and one for each of ${chapters} chapters at least (${pages})`);
      }
      await context.close();
    }
  } finally { await browser.close(); await rm(work, { recursive: true, force: true }); }
});
