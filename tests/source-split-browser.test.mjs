/* global document, window, performance, requestAnimationFrame, localStorage, getComputedStyle */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { until } from './helpers/wait.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';

/* #1012 对照栏 in the real page. A converted book of 60 pages (3 chapters of 20) and an imported PDF of 4 pages; a round of four questions: a (book p.2),
   b (book p.5), c (book p.25, another chapter) and d (the PDF's p.2, another material).
   1. At 1280 px, before answering, the page badge opens the book beside the question (no dialog). The focus in the column, the practice keys do nothing to
      the question while Ctrl+F opens the reader's find; the focus in the question, a number answers it and the column's find does not open.
   2. 下一题: the column follows to b's page in the same reader (the same DOM element: not mounted again) in under 150 ms from the new question being drawn,
      then to c's page in another chapter (same reader); d's material is another one and comes in its place.
   3. pdf.js is not fetched until 原始 PDF is chosen in the column. The divider is dragged and its width kept; one click folds the column to a rail, one more
      brings it back.
   4. At 900 px the page badge opens the reader dialog, with the 题干条 (the stem and the options, nothing of the answer); it folds to one line.
   Then pictures at 1280 / 1100 / 900 / 420 px in zh and en (column at 1280, where the question keeps 480 px beside it; dialog with its 题干条 at 1100,
   900 and 420), English without Chinese.
   SOURCE_SPLIT_SHOTS=<folder> keeps them. */

const at = '2026-11-01T08:00:00.000Z';
const PAGES = 60, PER_CHAPTER = 20;
const REFUSED = /Failed to load resource: the server responded with a status of 400/;
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const pageText = page => [`Heading ${page}`, ...[1, 2, 3, 4].map(n => `Paragraph ${n} of page ${page}: output relates to demand through spending, saving and the multiplier, read slowly.`)].join('\n\n');
const bookPage = page => ({ id: `book-p${page}`, title: `Book · p.${page}`, text: pageText(page), createdAt: at, courses: ['Macro'],
  document: { id: 'split-book-hash', materialId: 'document-split-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'split-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const question = (id, sourceId, quote) => ({ id, kind: 'quiz', topic: 'Demand', objective: `Objective ${id}`, prompt: `Question ${id} of the split?`, answer: 'Right',
  options: [{ id: 'r', text: 'Right answer', correct: true, explanation: 'Explained right.' }, { id: 'w', text: 'Wrong answer', correct: false, explanation: 'Explained wrong.' }],
  explanation: 'Because.', misconception: 'None.', citations: [{ sourceId, quote }] });

let shared = null;
const cleanups = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const setup = () => (shared ??= (async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-split-browser-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const library = join(root, 'library');
  await mkdir(library, { recursive: true });
  const service = new StudyService(library);
  await service.call('snapshot');
  await service.store.update(state => { state.sources.push(...Array.from({ length: PAGES }, (_, index) => bookPage(index + 1))); });
  await service.dispose();
  const runtime = createStudyRuntime(library);
  const lecture = Array.from({ length: 4 }, (_, i) => [`Lecture page ${i + 1}: the main idea of part ${i + 1}.`, ...[1, 2, 3].map(n => `Line ${n} of page ${i + 1} explains part ${i + 1} in plain words.`)]);
  const pdf = await runtime.call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: (await makeTextPdf(lecture)).toString('base64'), courses: ['Macro'] });
  runtime.dispose();
  const again = new StudyService(library);
  await again.store.update(state => {
    state.decks.push({ id: 'd1', title: 'Split', course: 'Macro', cards: [question('a', 'book-p2', 'Paragraph 2 of page 2'), question('b', 'book-p5', 'Paragraph 3 of page 5'),
      question('c', 'book-p25', 'Paragraph 1 of page 25'), question('d', pdf.sourceIds[1], 'Line 2 of page 2 explains part 2')] });
    // Three questions on one page, each with its own passage (the answer's evidence); one question answered in words.
    state.decks.push({ id: 'd2', title: 'Same', course: 'Macro', cards: [question('e', 'book-p2', 'Paragraph 1 of page 2'), question('f', 'book-p2', 'Paragraph 3 of page 2'),
      question('g', 'book-p2', 'Paragraph 4 of page 2')] });
    state.decks.push({ id: 'd3', title: 'Typed', course: 'Macro', cards: [{ id: 'o', kind: 'open', topic: 'Demand', objective: 'Objective o', prompt: 'Explain the multiplier in your words.',
      answer: 'Spending becomes income, which is spent again.', explanation: 'Because.', citations: [{ sourceId: 'book-p2', quote: 'Paragraph 2 of page 2' }] }] });
  });
  await again.dispose();
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: library, home: join(root, 'home'), port: 0, model: null, distDir });
  cleanups.push(() => server.close());
  const browser = await launchChromium();
  cleanups.push(() => browser.close());
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
  return { server, browser, pdf };
})());

const WORDS = {
  zh: { resume: '继续 Split', fold: '收起资料栏', unfold: '展开对照资料', close: '关闭资料栏', more: '更多', original: '原始 PDF', read: '阅读', strip: '本题' },
  en: { resume: 'Continue Split', fold: 'Fold the source column', unfold: 'Show the source beside the question', close: 'Close the source column', more: 'More', original: 'Original PDF', read: 'Read', strip: 'Question' },
};

/* Counts the renders of the column's reader (DocumentReader: the component that draws .study-document-viewer) from React's commits, through the devtools
   hook React calls in any build: after a commit, the reader's fiber is another object when React went through it, and it carries PerformedWork (1) only
   when the component ran. window.__readerRenders.start() counts from then on: `renders` all of them, `refreshes` those with new library data (a snapshot
   the app refreshed meanwhile, which the reader shows), `changed` the props that were new. */
const countReaderRenders = () => {
  const counts = { renders: 0, refreshes: 0, changed: [], on: false, last: null, root: null };
  const readerFiber = root => {
    const element = document.querySelector('.source-column .study-document-viewer');
    if (!element || !root) return null;
    const stack = [root.current];
    while (stack.length) {
      const fiber = stack.pop();
      if (fiber.stateNode === element) {
        let up = fiber.return;
        while (up && typeof up.type !== 'function') up = up.return;
        return up;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return null;
  };
  counts.start = () => { counts.renders = 0; counts.refreshes = 0; counts.changed = []; counts.last = readerFiber(counts.root); counts.on = !!counts.last; return counts.on; };
  window.__readerRenders = counts;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      counts.root = root;
      if (!counts.on) return;
      const fiber = readerFiber(root);
      if (fiber && fiber !== counts.last && (fiber.flags & 1)) {
        counts.renders += 1;
        const before = fiber.alternate?.memoizedProps || {}, now = fiber.memoizedProps || {};
        counts.changed = [...new Set([...counts.changed, ...Object.keys(now).filter(key => now[key] !== before[key])])];
        if (now.data !== before.data) counts.refreshes += 1;
      }
      if (fiber) counts.last = fiber;
    },
  };
};

async function openRound(browser, server, { lang, width, height = 860, deck = { id: 'd1', title: 'Split' }, renders = false }) {
  for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: deck.id }] });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage(), errors = [], scripts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
  await page.addInitScript(language => { try { localStorage.setItem('study-ui-language', language); localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } }, lang);
  if (renders) await page.addInitScript(countReaderRenders);
  await page.goto(server.url);
  await page.getByRole('button', { name: WORDS[lang].resume.replace('Split', deck.title) }).first().click();
  await page.locator('.question-card').waitFor({ timeout: 30000 });
  return { context, page, errors, scripts };
}

const promptOf = page => page.locator('.review-body .question-card .question').first().innerText();
const answered = page => page.locator('.review-body .option.correct, .review-body .option.incorrect').count();
/** How soon the column shows the new question's place: frame by frame from before 下一题, the frame the new question is first painted in (start) and the
    frame its page is first at the top of the column's text (end; the same frame: 0 ms). `from`: where that page was before (not already there). Also the
    time from the click, which includes the server's answer to review.move. */
const watchFollow = (page, sourceId) => page.evaluate(id => {
  const prompt = () => document.querySelector('.review-body .question-card .question')?.textContent;
  const placeTop = () => {
    const scroller = document.querySelector('.source-column .reader-scroll'), target = scroller?.querySelector(`[data-study-source="${id}"]`);
    return target ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  };
  const before = prompt(), from = placeTop();
  const watch = { clicked: 0, start: 0, end: 0, from: from === null ? null : Math.round(from) };
  window.__follow = watch;
  document.addEventListener('click', () => { watch.clicked = performance.now(); }, { capture: true, once: true });
  const look = now => {
    if (!watch.start && prompt() !== before) watch.start = now;
    const top = placeTop();
    if (watch.start && top !== null && top >= -2 && top <= 40) { watch.end = now; return; }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}, sourceId);
const followTime = async (t, page, what) => {
  const watch = await until(() => page.evaluate(() => (window.__follow?.end ? window.__follow : null)), 'the column to follow', { timeoutMs: 30000 });
  assert.ok(watch.from === null || watch.from > 40, `the page was elsewhere before the question changed (${watch.from} px from the top)`);
  t.diagnostic(`${what}: the place is shown ${(watch.end - watch.start).toFixed(1)} ms after the new question is painted (${(watch.end - watch.clicked).toFixed(1)} ms after the click, server included)`);
  return watch.end - watch.start;
};
const markViewer = page => page.evaluate(() => { const viewer = document.querySelector('.source-column .study-document-viewer'); viewer.__splitMark = 'first'; return !!viewer; });
const sameViewer = page => page.evaluate(() => document.querySelectorAll('.source-column .study-document-viewer').length === 1
  && document.querySelector('.source-column .study-document-viewer').__splitMark === 'first');

test('对照栏: open before answering, keys stay apart, answer, the column follows without mounting again, lazy PDF, drag, fold, dialog on a narrow page (#1012)', { timeout: 600000 }, async t => {
  let served;
  try { served = await setup(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const { server, browser, pdf } = served;
  const words = WORDS.zh;
  const { context, page, errors, scripts } = await openRound(browser, server, { lang: 'zh', width: 1280 });
  assert.ok(Array.isArray(scripts));
  t.after(() => context.close());
  const column = page.locator('.source-column'), viewer = column.locator('.study-document-viewer'), scroller = viewer.locator('.reader-scroll');
  assert.match(await promptOf(page), /Question a of the split\?/);

  // 1. Before answering, the page badge: the book beside the question, at page 2; no dialog.
  await page.locator('.question-source-page').click();
  await viewer.locator('.reader-section[data-study-page="2"]').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('dialog.source-preview').count(), 0, 'no reader dialog over the question');
  assert.equal(await page.locator('.study-document-viewer').count(), 1, 'one reader');
  assert.ok(await page.locator('.review-body .question-card').isVisible(), 'the question stays on screen');
  assert.equal(await answered(page), 0, 'nothing answered by opening the source');
  assert.ok(await markViewer(page));

  // Focus in the column: a number does not answer the question, Ctrl+F opens the reader's find there.
  await scroller.click({ position: { x: 40, y: 60 } });
  for (const key of ['1', '2', 'Enter', 'k']) await page.keyboard.press(key);
  await page.waitForTimeout(500);
  assert.equal(await answered(page), 0, 'the practice keys do not reach the question from the column');
  assert.match(await promptOf(page), /Question a/, 'K did not skip the question from the column');
  await page.keyboard.press('Control+f');
  await column.locator('.reader-find').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await until(async () => !(await column.locator('.reader-find').count()), 'the find bar to close');

  // Esc in the column (nothing of the reader open) gives the focus back to the question; the column stays.
  await scroller.click({ position: { x: 40, y: 60 } });
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => document.activeElement?.matches('.review-body .question-card')), 'Esc to give the focus back to the question');
  assert.equal(await column.count(), 1, 'Esc does not close the column');

  // Focus in the question: a number answers it; Ctrl+F does not open the column's find.
  await page.locator('.review-body .question-card .question').click();
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(300);
  assert.equal(await column.locator('.reader-find').count(), 0, 'the reader\'s find stays the reader\'s');
  await page.keyboard.press('Escape');
  await page.locator('.review-body .question-card .question').click();
  await until(async () => { await page.keyboard.press('1'); return (await answered(page)) > 0; }, 'a answered by its key');

  // 2. 下一题: b on page 5 of the same chapter; the same reader, in under 150 ms.
  await watchFollow(page, 'book-p5');
  await page.locator('[data-usage="review.next"]').click();
  const sameChapter = await followTime(t, page, 'within the chapter');
  assert.match(await promptOf(page), /Question b/);
  assert.ok(await sameViewer(page), 'the reader is not mounted again for the next question');
  assert.ok(sameChapter < 150, `the column follows within 150 ms (${sameChapter.toFixed(1)} ms)`);

  // c on page 25: another chapter of the same book, the same reader.
  await until(async () => { await page.locator('.review-body .question-card .question').click(); await page.keyboard.press('1'); return (await answered(page)) > 0; }, 'b answered');
  await watchFollow(page, 'book-p25');
  await page.locator('[data-usage="review.next"]').click();
  const otherChapter = await followTime(t, page, 'into another chapter');
  assert.ok(await sameViewer(page), 'another chapter of the same material: still the same reader');
  assert.ok(otherChapter < 150, `the column follows into another chapter within 150 ms (${otherChapter.toFixed(1)} ms)`);

  // d: another material, mounted in its place (a PDF, with 原始 PDF).
  await until(async () => { await page.locator('.review-body .question-card .question').click(); await page.keyboard.press('1'); return (await answered(page)) > 0; }, 'c answered');
  await page.locator('[data-usage="review.next"]').click();
  await viewer.locator(`[data-study-source="${pdf.sourceIds[1]}"]`).waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => document.querySelector('.source-column .study-document-viewer').__splitMark), undefined, 'another material is another reader');

  // 3. pdf.js only once 原始 PDF is chosen (in the narrow column the views are items of 更多).
  const chooseView = async label => {
    await viewer.getByRole('button', { name: words.more, exact: true }).click();
    await page.locator('.sh-menu [role^="menuitem"]', { hasText: label }).first().click();
  };
  // pdf.js marks itself on globalThis when it is first opened (ui/document-preview/peek/renderer.js); in a split build its code is a chunk of its own.
  const pdfjsHere = () => page.evaluate(() => !!window.pdfjsWorker);
  assert.equal(await pdfjsHere(), false, 'pdf.js is not opened by the column, the follow or the swap');
  const before = new Set(scripts);
  await chooseView(words.original);
  await viewer.locator('.reader-pdf-view').waitFor({ timeout: 60000 });
  await until(pdfjsHere, 'pdf.js to open for 原始 PDF', { timeoutMs: 60000 });
  t.diagnostic(`scripts fetched for 原始 PDF: ${scripts.filter(url => !before.has(url)).map(url => url.split('/').pop()).join(', ') || '(none: the preview is one bundle)'}`);
  await chooseView(words.read);

  // The divider: dragged 60 px to the right, only its line moves while it is held (the reader is not laid out per frame); let go, the column is narrower and
  // the width kept.
  const handle = column.locator('.source-column__handle');
  const widthBefore = (await column.boundingBox()).width, box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) await page.mouse.move(box.x + box.width / 2 + step * 10, box.y + 300);
  await until(async () => Math.abs((await handle.boundingBox()).x - (box.x + 60)) < 4, 'the divider\'s line to follow the pointer');
  assert.equal((await column.boundingBox()).width, widthBefore, 'the column keeps its width while the divider is held');
  await page.mouse.up();
  const widthAfter = (await column.boundingBox()).width;
  t.diagnostic(`column ${widthBefore.toFixed(0)} → ${widthAfter.toFixed(0)} px`);
  assert.ok(Math.abs(widthBefore - widthAfter - 60) < 4, `the column follows the divider (${widthBefore} → ${widthAfter})`);
  assert.equal(Number(await page.evaluate(() => localStorage.getItem('study-source-column-width'))), Math.round(widthAfter), 'the width is kept');
  // Home / End on the divider: the narrowest column, then the widest that leaves the question its 480 px.
  await handle.focus();
  await page.keyboard.press('Home');
  assert.ok(Math.abs((await column.boundingBox()).width - 360) < 2, 'Home: the narrowest column');
  await page.keyboard.press('End');
  const leftForQuestion = (await page.locator('.review-body').boundingBox()).width;
  assert.ok(Math.abs(leftForQuestion - 480) < 2, `End: the question keeps 480 px (${leftForQuestion})`);
  await page.keyboard.press('Home');

  // Fold with one click, unfold with one more: the reader is the same one, where it was.
  const questionWidth = async () => (await page.locator('.review-body').boundingBox()).width;
  const wideQuestion = await questionWidth();
  await page.evaluate(() => { document.querySelector('.source-column .study-document-viewer').__splitMark = 'folded'; });
  await column.getByRole('button', { name: words.fold }).click();
  await until(async () => (await column.getAttribute('data-collapsed')) === 'true', 'the column to fold');
  assert.ok((await questionWidth()) > wideQuestion + 200, 'the question takes the room back');
  assert.ok((await column.boundingBox()).width <= 40, 'folded to a rail');
  if (process.env.SOURCE_SPLIT_SHOTS) await page.screenshot({ path: join(process.env.SOURCE_SPLIT_SHOTS, 'source-split-zh-1280-folded.png') });
  await column.getByRole('button', { name: words.unfold }).click();
  await viewer.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.querySelector('.source-column .study-document-viewer').__splitMark), 'folded', 'unfolded, the same reader');

  // Closed, then a narrow page: the dialog, with the 题干条.
  await column.getByRole('button', { name: words.close }).click();
  await until(async () => !(await column.count()), 'the column to close');
  await page.setViewportSize({ width: 900, height: 860 });
  await page.locator('.question-source-page').click();
  const dialog = page.locator('dialog.source-preview');
  await dialog.waitFor({ timeout: 30000 });
  assert.equal(await column.count(), 0, 'no column on a narrow page');
  const strip = dialog.locator('.question-strip');
  await strip.waitFor();
  const stripText = await strip.innerText();
  assert.match(stripText, /Question d of the split\?/);
  assert.match(stripText, /Right answer/);
  assert.match(stripText, /Wrong answer/);
  assert.doesNotMatch(stripText, /Explained|正确|✓/, 'the 题干条 says nothing of the answer');
  const marked = locator => locator.evaluateAll(rows => rows.map(row => row.innerText.replace(/\s+/g, ' ').replace(/^([A-Z])\.? /, '$1 ').trim()));
  assert.deepEqual(await marked(strip.locator('.question-strip__option')), await marked(page.locator('.review-body .question-card .option')),
    'the 题干条 lists the options with the letters and in the order of the card');
  await strip.locator('summary').click();
  await until(async () => !(await strip.evaluate(node => node.open)), 'the 题干条 to fold');
  assert.equal(await strip.locator('.question-strip__options').isVisible(), false, 'folded to its stem');
  assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], 'no console or page errors');
});

test('对照栏 and 题干条 at 1280 / 1100 / 900 / 420 px in zh and en (#1012)', { timeout: 600000 }, async t => {
  let served;
  try { served = await setup(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const { server, browser } = served;
  const shots = process.env.SOURCE_SPLIT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const lang of ['zh', 'en']) for (const width of [1280, 1100, 900, 420]) {
    const where = `${lang} ${width}px`, words = WORDS[lang];
    const { context, page, errors } = await openRound(browser, server, { lang, width, height: width === 420 ? 860 : 820 });
    await page.locator('.question-source-page').click();
    const docked = width >= 1280;
    const reader = docked ? page.locator('.source-column') : page.locator('dialog.source-preview');
    await reader.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.source-column').count(), docked ? 1 : 0, `${where}: the column only on a wide page`);
    assert.equal(await page.locator('dialog.source-preview').count(), docked ? 0 : 1, `${where}: the dialog only on a narrow page`);
    const prompt = (await promptOf(page)).trim();
    if (!docked) {
      const strip = await reader.locator('.question-strip').innerText();
      assert.ok(strip.startsWith(words.strip) && strip.includes(prompt), `${where}: the 题干条 holds the question on the page: ${strip}`);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${where}: no sideways scroll (${overflow})`);
    // The room the question and the column share (ui/review/source-dock.js questionRoom); the window where it reaches 840 px is where the column comes.
    const room = await page.evaluate(() => {
      const page = document.querySelector('.review-page'), style = getComputedStyle(page), ticks = page.classList.contains('has-rail') ? page.querySelector(':scope > .review-navigator') : null;
      return page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (ticks ? ticks.offsetWidth + 2 * (parseFloat(style.columnGap) || 0) : 0);
    });
    if (lang === 'zh' && width === 1280) t.diagnostic(`room at 1280 px: ${room} px; the column comes from a window of about ${width + 840 - room} px`);
    if (docked) {
      const fits = await page.evaluate(() => {
        const body = document.querySelector('.review-body').getBoundingClientRect(), column = document.querySelector('.source-column').getBoundingClientRect();
        return body.right <= column.left + 1 && body.width >= 480;
      });
      assert.ok(fits, `${where}: the question and the column side by side`);
    }
    if (lang === 'en') {
      const text = docked ? await page.locator('.source-column__head').innerText() + await page.locator('.source-column').getAttribute('aria-label')
        : await reader.locator('.question-strip').innerText();
      assert.doesNotMatch(text, /[一-鿿]/, `${where}: no Chinese in the English page: ${text}`);
    }
    if (shots) await page.screenshot({ path: join(shots, `source-split-${lang}-${width}.png`) });
    assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], `${where}: no console or page errors`);
    await context.close();
  }
});

/** What of a quote the column shows: its bar above the text, and the mark on the passage. */
const quoteShown = page => page.evaluate(() => ({ bar: !!document.querySelector('.source-column .reader-aux__quote'), mark: !!window.CSS?.highlights?.has('study-source-quote') }));
const answerWrong = async page => {
  await page.locator('.review-body .option', { hasText: 'Wrong answer' }).click();
  await until(async () => (await answered(page)) > 0, 'the answer');
};
const nextQuestion = async page => {
  const before = await promptOf(page);
  await page.locator('[data-usage="review.next"]').click();
  await until(async () => (await promptOf(page)) !== before, 'the next question');
};

test('对照栏: the next question takes down the passage of the answer before, on the same page too (#1012)', { timeout: 600000 }, async t => {
  let served;
  try { served = await setup(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const { server, browser } = served;
  const { context, page, errors } = await openRound(browser, server, { lang: 'zh', width: 1280, deck: { id: 'd2', title: 'Same' } });
  t.after(() => context.close());
  const column = page.locator('.source-column');
  // A wrong answer, then 看这题的原文: the column opens at the answer's passage, quoted and marked.
  await answerWrong(page);
  await page.locator('.reading-source').click();
  await column.locator('.reader-section[data-study-page="2"]').waitFor({ timeout: 60000 });
  await until(async () => { const shown = await quoteShown(page); return shown.bar && shown.mark; }, 'the answer\'s passage quoted and marked');
  assert.ok(await markViewer(page));
  // The next question is on the same page: the column stays, the passage of the answer before goes.
  await nextQuestion(page);
  await until(async () => { const shown = await quoteShown(page); return !shown.bar && !shown.mark; }, 'the quote of the answer before to go');
  assert.ok(await sameViewer(page), 'the same reader');
  // Opened while docked (a seek with the passage): marked, and taken down by the next question all the same.
  await answerWrong(page);
  await page.locator('.reading-source').click();
  await until(async () => (await quoteShown(page)).mark, 'the passage marked by the seek');
  await nextQuestion(page);
  await until(async () => { const shown = await quoteShown(page); return !shown.bar && !shown.mark; }, 'the seek\'s mark to go');
  assert.ok(await sameViewer(page), 'still the same reader');
  assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], 'no console or page errors');
});

test('对照栏: typing an answer beside it does not draw the reader again (#1012)', { timeout: 600000 }, async t => {
  let served;
  try { served = await setup(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const { server, browser } = served;
  const { context, page, errors } = await openRound(browser, server, { lang: 'zh', width: 1280, deck: { id: 'd3', title: 'Typed' }, renders: true });
  t.after(() => context.close());
  await page.locator('.question-source-page').click();
  await page.locator('.source-column .reader-section[data-study-page="2"]').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000); // the reader's own loading (marks, links) is done
  assert.ok(await page.evaluate(() => window.__readerRenders.start()), 'the reader is found among React\'s commits');
  const field = page.locator('.response-label textarea');
  await field.click();
  await field.pressSequentially('spending, then again', { delay: 15 });
  await page.waitForTimeout(400);
  const { renders, refreshes, changed } = await page.evaluate(() => { const { renders, refreshes, changed } = window.__readerRenders; return { renders, refreshes, changed }; });
  t.diagnostic(`20 characters typed: the column's reader drew ${renders} time(s), ${refreshes} of them for new library data${changed.length ? ` (new props: ${changed.join(', ')})` : ''}`);
  assert.equal(await field.inputValue(), 'spending, then again');
  assert.equal(renders - refreshes, 0, 'typing in the question does not draw the reader again');
  assert.ok(refreshes <= 1, `at most a library refresh that landed meanwhile (${refreshes})`);
  // The counter counts: the reader's own find draws it.
  await page.locator('.source-column .reader-scroll').click({ position: { x: 40, y: 60 } });
  await page.keyboard.press('Control+f');
  await page.locator('.source-column .reader-find').waitFor({ timeout: 10000 });
  assert.ok(await page.evaluate(() => window.__readerRenders.renders) > 0, 'the counter sees the reader\'s own renders');
  assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], 'no console or page errors');
});

test('对照栏: one reader at a time: a narrower window hands it to the dialog, a reader dialog replaces it, other dialogs stay dialogs (#1012)', { timeout: 600000 }, async t => {
  let served;
  try { served = await setup(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const { server, browser } = served;
  // A round on one material (the book): 去资料选页做题 opens its reader straight away.
  const { context, page, errors } = await openRound(browser, server, { lang: 'zh', width: 1280, deck: { id: 'd2', title: 'Same' } });
  t.after(() => context.close());
  const column = page.locator('.source-column'), dialog = page.locator('dialog.source-preview');
  const dock = async () => {
    await page.locator('.question-source-page').click();
    await column.locator('.reader-section[data-study-source]').first().waitFor({ timeout: 60000 });
  };
  // Narrower while docked: the column goes and the reader is the dialog (with the 题干条), at the column's place.
  await dock();
  const place = await column.locator('.reader-section[data-study-source]').first().getAttribute('data-study-source');
  await page.setViewportSize({ width: 900, height: 860 });
  await dialog.waitFor({ timeout: 30000 });
  await dialog.locator(`[data-study-source="${place}"]`).first().waitFor({ timeout: 60000 });
  assert.equal(await column.count(), 0, 'no column left behind');
  assert.equal(await page.locator('.study-document-viewer').count(), 1, 'one reader');
  await dialog.locator('.question-strip').waitFor();
  await page.keyboard.press('Escape');
  await until(async () => !(await dialog.count()), 'the dialog to close');
  await page.setViewportSize({ width: 1280, height: 860 });
  // Another dialog of the practice page (查看资料) is a dialog, as before.
  await dock();
  await page.getByRole('button', { name: /查看 \d+ 份资料/ }).click();
  await page.locator('dialog[open]').filter({ hasNot: page.locator('.study-document-viewer') }).first().waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('dialog[open]').count()), 'the list to close');
  // 去资料选页做题 is the reader dialog with its guide, as before, and the column gives way to it.
  if (!(await column.count())) await dock();
  await page.getByRole('button', { name: '去资料选页做题' }).click();
  await dialog.waitFor({ timeout: 30000 });
  await dialog.getByText(/先翻到正在看的那一章或那几页/).waitFor({ timeout: 30000 });
  await until(async () => !(await column.count()), 'the column to give way to the reader dialog');
  assert.equal(await page.locator('.study-document-viewer').count(), 1, 'one reader');
  assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], 'no console or page errors');
});
