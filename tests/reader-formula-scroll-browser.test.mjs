/* global document window Range DataTransfer ClipboardEvent */
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
import { chooseMore } from './helpers/reader-more.mjs';

/* Scrolling a formula-heavy chapter does not stall (gate review of #996). A KaTeX drawing is 70–210 elements, and the reader's 19 highlight styles
   (find, link underlines, marks) were written for every element of the app (` ::highlight(…)`), so the browser resolved 19 highlight styles for each
   element drawn: one display formula cost ~100 ms of style, and drawing ten at once (one 450 px scroll step of this book) was a 180–780 ms task on
   every step. The styles now match the reading page's elements outside a drawn formula (~10 ms a formula), and formulas near the screen are drawn
   a few per frame through one queue for the page, the nearest first, those on screen at once. A generated converted book of 60 pages in 3
   chapters, each page with 9 inline formulas and a display one (200 a chapter), seeded through the real store, fake model, no key. At 1280 and 420 px:
   opening the chapter is measured and reported; no 450 px scroll step has a long task over 100 ms and every formula on screen after it is drawn; a copy
   and find read a formula not drawn yet by its own text; and a citation in a part of the chapter not drawn yet lands in view and stays there while the
   formulas around it are drawn. Revealing an answer full of formulas is measured and reported. */

const at = '2026-11-01T08:00:00.000Z';
const PAGES = 60, PER_CHAPTER = 20, CITED_PAGE = 15, COPIED_PAGE = 12, FOUND_PAGE = 18;
const STEP_PX = 450, STEPS = 20, LONGEST_STEP_MS = 100;
const BS = String.fromCharCode(92);
const tex = text => text.replaceAll('#', BS);
const inline = (page, n) => [tex(`$Y_{${page}} = C + I + G_{${n}}$`), tex(`$#frac{#Delta Y}{#Delta G} = ${n + 1}$`), tex(`$#mathbb{E}[X_{${page}}] = #sum_{i#ge1} p_i x_i$`)];
const display = page => tex(`$$#sum_{k=1}^{n} #frac{a_k^{2}}{b_k + ${page}} = #int_0^{${page}} f(x)#,dx + #left( #frac{#partial f}{#partial x} #right)^{2}$$`);
const paragraph = (page, n) => `Paragraph ${n} of page ${page} relates output ${inline(page, n).join(' and ')} to demand in this model.`;
const pageText = page => [`Heading ${page}`, paragraph(page, 1), display(page), paragraph(page, 2), paragraph(page, 3)].join('\n\n');
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const source = page => ({ id: `fm-p${page}`, title: `Formula book p.${page}`, text: pageText(page), createdAt: at, courses: ['宏经'],
  document: { id: 'fm-book-hash', materialId: 'document-fm-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'fm-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const quoteOn = page => `Paragraph 2 of page ${page} relates output`;
const card = { id: 'heavy', kind: 'flashcard', topic: 'Output', objective: 'Objective heavy',
  prompt: tex('Given $Y = C + I + G$, $#frac{#Delta Y}{#Delta G} = #frac{1}{1-c}$, $c = 0.8$, $#mathbb{E}[X] = #mu$ and $#sum_{i=1}^{n} x_i = S$, what is $#Delta Y$ when $#Delta G = 10$?'),
  answer: tex('$#Delta Y = 50$, since $#frac{1}{1-0.8} = 5$.'), hint: 'Think of the multiplier.',
  // A long explanation: 40 display formulas below the first screen, so a jump to its end lands among formulas not drawn yet.
  explanation: tex('The multiplier is $k = #frac{1}{1-c}$; with $c=0.8$, $k=5$. So $#Delta Y = k#,#Delta G = 5 #times 10 = 50$, and $#lim_{n#to#infty} #sum_{t=0}^{n} c^t = #frac{1}{1-c}$.')
    + Array.from({ length: 40 }, (_, n) => tex(`\n\nStep ${n + 1}:\n\n$$#sum_{t=0}^{${n + 1}} c^t = #frac{1-c^{${n + 2}}}{1-c}$$`)).join(''),
  misconception: 'None.', citations: [{ sourceId: `fm-p${CITED_PAGE}`, quote: quoteOn(CITED_PAGE) }] };
const seed = async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => source(index + 1)));
    state.decks.push({ id: 'fm-deck', title: 'FM deck', course: '宏经', cards: [card] });
  });
  await service.dispose();
};

/** The formulas of the reader, the ones still waiting, and the ones on screen not drawn yet. */
const formulas = page => page.evaluate(() => {
  const viewer = document.querySelector('.study-document-viewer'), area = viewer?.querySelector('.reader-scroll')?.getBoundingClientRect();
  if (!viewer || !area) return { all: 0, waiting: 0, waitingOnScreen: 0 };
  const waiting = [...viewer.querySelectorAll('.reader-math__view--pending')];
  const onScreen = waiting.filter(node => { const rect = node.getBoundingClientRect(); return rect.bottom > area.top && rect.top < area.bottom; });
  return { all: viewer.querySelectorAll('.reader-math').length, waiting: waiting.length, waitingOnScreen: onScreen.length };
});
const takeLong = page => page.evaluate(() => { const long = window.__long.slice(); window.__long = []; return long; });
const pageInView = (page, n) => page.evaluate(n => {
  const node = document.querySelector(`.study-document-viewer [data-study-page="${n}"]`), area = document.querySelector('.study-document-viewer .reader-scroll')?.getBoundingClientRect();
  if (!node || !area) return false;
  const rect = node.getBoundingClientRect();
  return rect.top < area.bottom && rect.bottom > area.top;
}, n);
/** Whether the first formula of paragraph 1 on page `n` is still waiting to be drawn. */
const firstFormulaWaiting = (page, n) => page.evaluate(n => {
  const paragraph = [...document.querySelectorAll(`.study-document-viewer [data-study-page="${n}"] .reader-p`)].find(node => node.textContent.includes(`Paragraph 1 of page ${n}`));
  return !!paragraph?.querySelector('.reader-math__view--pending');
}, n);

/** Whether a highlight called `name` over the first words of paragraph 3 of FOUND_PAGE changes how they look (the rule of that name reaches the text). */
const paints = async (page, name) => {
  await page.evaluate(n => {
    const paragraph = [...document.querySelectorAll(`.study-document-viewer [data-study-page="${n}"] .reader-p`)].find(node => node.textContent.includes(`Paragraph 3 of page ${n}`));
    paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, FOUND_PAGE);
  await page.waitForTimeout(300);
  const box = await page.evaluate(n => {
    const paragraph = [...document.querySelectorAll(`.study-document-viewer [data-study-page="${n}"] .reader-p`)].find(node => node.textContent.includes(`Paragraph 3 of page ${n}`));
    const text = [...paragraph.childNodes].find(node => node.nodeType === 3 && node.data.startsWith('Paragraph 3'));
    const range = new Range(); range.setStart(text, 0); range.setEnd(text, 'Paragraph 3 of page'.length);
    window.__paintRange = range;
    const rect = range.getBoundingClientRect();
    return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  }, FOUND_PAGE);
  await page.waitForTimeout(200);
  const plain = await page.screenshot({ clip: box });
  await page.evaluate(name => { window.CSS.highlights.set(name, new window.Highlight(window.__paintRange)); }, name);
  await page.waitForTimeout(200);
  const marked = await page.screenshot({ clip: box });
  await page.evaluate(name => { window.CSS.highlights.delete(name); }, name);
  return !plain.equals(marked);
};

/** The formulas of the practice card: all, drawn, on screen, and on screen but not drawn yet. */
const cardFormulas = page => page.evaluate(() => {
  const all = [...document.querySelectorAll('.review-page .md-math')], height = window.innerHeight;
  const onScreen = all.filter(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > 0 && rect.top < height; });
  return { all: all.length, drawn: all.filter(node => node.querySelector('.md-math-content')).length, onScreen: onScreen.length,
    waitingOnScreen: onScreen.filter(node => node.querySelector('.md-math-source')).length };
});

let built = null;
const previewDist = () => built ??= (async () => {
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-formula-scroll-dist-'));
  await buildPreview({ outdir: dist });
  return dist;
})();
test.after(async () => { if (built) await rm(await built.catch(() => null) ?? '', { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('a formula-heavy chapter scrolls without long tasks; copy, find and a citation work on formulas not drawn yet (1280 and 420 px)', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await previewDist();
  for (const width of [1280, 420]) {
    const running = await startLateServer({ distDir: dist, seed });
    try {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript(() => {
        window.__long = [];
        try { new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* no longtask timing */ }
      });
      const viewer = page.locator('.study-document-viewer');
      const area = () => page.evaluate(() => { const node = document.querySelector('.study-document-viewer .reader-scroll'); return { top: node.scrollTop }; });
      await page.goto(running.server.url);

      // ---- practice: a question and an answer full of formulas (measured), then the citation into a part of the chapter not drawn yet ----
      await page.getByRole('button', { name: '开始今日学习' }).first().click();
      await page.locator('.review-page').waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200);
      const questionLong = await takeLong(page);
      await page.locator('.review-heading h1').first().click().catch(() => {});
      await page.keyboard.press('Space');
      await page.waitForTimeout(1200);
      const answerLong = await takeLong(page);
      const shownFormulas = await cardFormulas(page);
      t.diagnostic(`${width}px practice: question long tasks ${JSON.stringify(questionLong)}; answer shown long tasks ${JSON.stringify(answerLong)}; ${shownFormulas.drawn} of ${shownFormulas.all} formulas drawn`);
      assert.equal(shownFormulas.waitingOnScreen, 0, 'every formula of the card on screen is drawn');
      await page.keyboard.press('5');
      // Graded, the explanation shows. A jump to its end: the formulas there are drawn at once (they are on screen), not after the ones above them.
      await until(async () => (await cardFormulas(page)).all > 40, 'the long explanation', { timeoutMs: 15000 });
      await page.evaluate(() => { const all = document.querySelectorAll('.review-page .md-math'); all[all.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' }); });
      await page.waitForTimeout(150);
      const atEnd = await cardFormulas(page);
      t.diagnostic(`${width}px explanation end: ${JSON.stringify(atEnd)}`);
      assert.ok(atEnd.onScreen > 0, 'the end of the explanation is on screen');
      assert.equal(atEnd.waitingOnScreen, 0, `${width}px: the formulas at the end of a long explanation are drawn at once after a jump (${JSON.stringify(atEnd)})`);
      await page.getByRole('button', { name: '看这题的原文' }).click();
      await viewer.waitFor({ timeout: 30000 });
      const quoteInView = () => page.evaluate(() => {
        const set = window.CSS?.highlights?.get('study-source-quote'), range = set ? [...set][0] : null;
        if (!range) return null;
        const rect = range.getBoundingClientRect(), box = document.querySelector('.study-document-viewer .reader-scroll').getBoundingClientRect();
        return { text: range.toString(), inView: rect.height > 0 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 };
      });
      const placed = await until(quoteInView, 'the cited passage highlighted', { timeoutMs: 20000 });
      assert.equal(placed.text, quoteOn(CITED_PAGE));
      await page.waitForTimeout(1500);
      const settled = await quoteInView();
      assert.ok(settled?.inView, `${width}px: the cited passage stays in view while the formulas around it are drawn (${JSON.stringify(settled)})`);
      assert.equal((await formulas(page)).waitingOnScreen, 0, 'every formula on screen at the citation is drawn');
      await viewer.getByRole('button', { name: '回到这道题' }).click();
      await page.locator('.review-page').waitFor();

      // ---- open the book: measured, the formulas near the screen drawn, the rest waiting ----
      await (await revealNavRow(page, 'sources')).dispatchEvent('click');
      const row = page.locator('.source-doc', { hasText: 'fm-book' }).first();
      await row.waitFor({ timeout: 60000 });
      await page.waitForTimeout(800);
      await takeLong(page);
      const started = Date.now();
      await row.locator('.source-main').click();
      await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 });
      const toSection = Date.now() - started;
      // The book opens where it was last read (the cited page): back to the top of the chapter.
      await page.evaluate(() => { document.querySelector('.study-document-viewer .reader-scroll').scrollTop = 0; });
      await page.waitForTimeout(1500);
      const opened = await formulas(page), openLong = await takeLong(page);
      t.diagnostic(`${width}px open: to the first section ${toSection} ms; ${opened.all} formulas, ${opened.waiting} waiting; long tasks ${JSON.stringify(openLong)}`);
      assert.equal(opened.all, PER_CHAPTER * 10, 'every formula of the chapter is there');
      assert.ok(opened.waiting > opened.all / 2, `most formulas wait until they come near the screen (${opened.waiting} of ${opened.all})`);
      assert.equal(opened.waitingOnScreen, 0, 'every formula on screen is drawn');

      // ---- a copy over a formula not drawn yet carries its stored text ----
      assert.ok(await firstFormulaWaiting(page, COPIED_PAGE), `a formula on page ${COPIED_PAGE} is not drawn yet`);
      const copied = await page.evaluate(n => {
        const paragraph = [...document.querySelectorAll(`.study-document-viewer [data-study-page="${n}"] .reader-p`)].find(node => node.textContent.includes(`Paragraph 1 of page ${n}`));
        const range = new Range(); range.selectNodeContents(paragraph);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const data = new DataTransfer(), event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        paragraph.dispatchEvent(event);
        selection.removeAllRanges();
        return { text: data.getData('text/plain'), taken: event.defaultPrevented };
      }, COPIED_PAGE);
      assert.equal(copied.taken, true, 'the reader writes the copy itself');
      assert.equal(copied.text, paragraph(COPIED_PAGE, 1), 'the copy is the stored text, formulas as their source');

      // ---- find reads a formula not drawn yet, and goes to it ----
      assert.ok(await firstFormulaWaiting(page, FOUND_PAGE), `a formula on page ${FOUND_PAGE} is not drawn yet`);
      await chooseMore(page, '在文中查找', { viewer });
      await page.getByRole('searchbox', { name: '在文中查找' }).fill(`b_k + ${FOUND_PAGE}}`);
      await until(async () => (await page.locator('.reader-find__count').innerText()) === '1 / 1', 'find to count the formula not drawn', { timeoutMs: 15000 });
      await until(() => pageInView(page, FOUND_PAGE), 'the match in view', { timeoutMs: 15000 });
      await page.keyboard.press('Escape');

      // ---- the reader's highlights reach its text (find, a linked question, a 荧光笔 mark) ----
      for (const name of ['study-find', 'study-link-question', 'study-mark-highlight']) assert.ok(await paints(page, name), `${width}px: ${name} is painted on the text`);
      await page.evaluate(() => { document.querySelector('.study-document-viewer .reader-scroll').scrollTop = 0; });
      await page.waitForTimeout(1500);
      await takeLong(page);

      // ---- scrolling: no long task over LONGEST_STEP_MS on any step, every formula on screen drawn after it ----
      const steps = [];
      for (let step = 0; step < STEPS; step += 1) {
        const before = await formulas(page);
        await page.evaluate(px => { document.querySelector('.study-document-viewer .reader-scroll').scrollTop += px; }, STEP_PX);
        await page.waitForTimeout(250);
        const after = await formulas(page);
        steps.push({ top: (await area()).top, drew: before.waiting - after.waiting, waitingOnScreen: after.waitingOnScreen, long: await takeLong(page) });
      }
      t.diagnostic(`${width}px scroll ${STEP_PX} px: drew ${JSON.stringify(steps.map(step => step.drew))}; long tasks ${JSON.stringify(steps.map(step => step.long))}`);
      const longest = Math.max(0, ...steps.flatMap(step => step.long));
      assert.ok(longest <= LONGEST_STEP_MS, `${width}px: no scroll step has a long task over ${LONGEST_STEP_MS} ms (longest ${longest})`);
      assert.ok(steps.every(step => step.waitingOnScreen === 0), `every formula on screen is drawn after each step (${JSON.stringify(steps.map(step => step.waitingOnScreen))})`);
      assert.ok(steps.reduce((sum, step) => sum + step.drew, 0) >= 30, 'the scroll draws the formulas it comes to');

      assert.deepEqual(errors.filter(error => !error.includes('400 (Bad Request)')), [], 'no console or page errors');
      await context.close();
    } finally {
      await running.close();
    }
  }
});
