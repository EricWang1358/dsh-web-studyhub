/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { Store } from '../lib/store.js';

/* #1001 in the real page. A PDF with its original file has a 文字 | 原始 PDF switch on the toolbar (in 更多 only when the reader is narrow, so the toolbar
   stays one row): read to page 5, switch, and the original shows page 5; closed and opened again from its row it is still the original at that page
   (the same record as 上次读到); back to 文字 the text is at the page the PDF was on. A chapter whose formulas fell apart in conversion suggests 看原始 PDF
   once per material. Pictures go to READER_ORIGINAL_SHOTS when set. */

const lecture = Array.from({ length: 12 }, (_, index) => [`Lecture page ${index + 1}: the main idea of part ${index + 1}.`,
  ...[1, 2, 3, 4, 5, 6].map(n => `Line ${n} of page ${index + 1} explains part ${index + 1} of the lecture in plain words.`)]);
// What a converter without formula support makes of a formula: one piece per line (the text of #1001's screenshot).
const pieces = ['E', '[', 'X', ']', '=', 'x', 'i', 'p', 'i', '+', 'y', 'j', 'q', 'j', '(', 'a', 'b', ')'];
const formulas = Array.from({ length: 3 }, (_, index) => [`The expected value of the variable on page ${index + 1} is written below.`, ...pieces,
  'and the variance follows from the same definition here.']);

test('文字 | 原始 PDF: the original opens at the page being read and is remembered per material; garbled formulas suggest it once (#1001)', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip('no Chromium to check the view with: ' + String(error.message).split('\n')[0]); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-original-view-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    const book = await runtime.call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: (await makeTextPdf(lecture)).toString('base64'), courses: ['QA'] });
    await runtime.call('materials.document.import', { filename: 'Formulas.pdf', dataBase64: (await makeTextPdf(formulas)).toString('base64'), courses: ['QA'] });
    runtime.dispose();
    // Two new questions citing the Lecture (pages 3 and 9), for the opens aimed somewhere: 去资料选页做题 and 看这题的原文.
    const card = (id, page) => ({ id, kind: 'flashcard', topic: 'Lecture', objective: `Objective ${id}`, prompt: `Question about part ${page}: what does page ${page} explain?`,
      answer: `Part ${page}.`, hint: 'Think.', explanation: 'See the lecture.', misconception: 'None.', citations: [{ sourceId: book.sourceIds[page - 1], quote: `Line 2 of page ${page} explains part ${page}` }] });
    await new Store(root).update(state => { state.decks.push({ id: 'lecture-deck', title: 'Lecture deck', course: 'QA', cards: [card('c3', 3), card('c9', 9)] }); });
  } });
  t.after(() => running.close?.());
  const shots = process.env.READER_ORIGINAL_SHOTS || '';
  if (shots) await mkdir(shots, { recursive: true });
  const { page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
  const viewer = page.locator('.study-document-viewer'), toolbar = viewer.locator('.reader-toolbar');
  const sw = viewer.locator('.reader-view-switch');
  const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `original-${name}.png`) }); };
  const mode = () => viewer.locator('.reader-scroll').getAttribute('data-mode');
  const pdfPage = () => viewer.locator('.reader-pdf-view').getAttribute('data-pdf-page').catch(() => '');
  const topPage = () => page.evaluate(() => {
    const area = document.querySelector('.study-document-viewer .reader-scroll')?.getBoundingClientRect();
    const hit = [...document.querySelectorAll('.study-document-viewer .reader-section[data-study-page]')].find(node => node.getBoundingClientRect().bottom > (area?.top ?? 0) + 40);
    return hit ? Number(hit.dataset.studyPage) : 0;
  });
  const closeReader = async () => { await page.keyboard.press('Escape'); await until(async () => !(await viewer.count()), 'the reader to close', { timeoutMs: 15000 }); };
  const openRow = async name => {
    await page.locator('.source-doc', { hasText: name }).first().locator('.source-main').click();
    await viewer.waitFor({ timeout: 30000 });
  };
  const rows = () => toolbar.evaluate(node => ({ rows: new Set([...node.querySelectorAll('button')].filter(button => button.offsetParent).map(button => { const rect = button.getBoundingClientRect(); return Math.round((rect.top + rect.height / 2) / 8); })).size,
    overflow: node.scrollWidth > node.clientWidth + 1 }));
  await page.goto(running.server.url);
  await (await revealNavRow(page, 'sources')).click().catch(() => {});

  // Read to page 5 (the learner's own wheel, then page 5 at the top), switch: the original opens at page 5.
  await openRow('Lecture');
  await viewer.locator('.reader-section[data-study-page="5"]').waitFor({ timeout: 30000 });
  await sw.waitFor({ timeout: 30000 });
  assert.equal(await sw.getByRole('button', { pressed: true }).innerText(), '文字');
  assert.deepEqual(await rows(), { rows: 1, overflow: false }, '1280px: the toolbar is one row with the switch');
  const box = await viewer.locator('.reader-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await until(async () => { if ((await topPage()) >= 5) return true; await page.mouse.wheel(0, 300); await page.waitForTimeout(60); return false; }, 'page 5 at the top', { timeoutMs: 30000 });
  await viewer.locator('.reader-section[data-study-page="5"]').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await shot('text-page-5');
  await sw.getByRole('button', { name: '原始 PDF' }).click();
  await until(async () => (await mode()) === 'original' && (await pdfPage()) === '5', 'the original at page 5', { timeoutMs: 30000 });
  await shot('original-page-5');

  // Closed and opened again from its row: still the original, still page 5; a page turn is kept too.
  await closeReader();
  await openRow('Lecture');
  await until(async () => (await mode()) === 'original' && (await pdfPage()) === '5', 'the original at page 5 after a reopen', { timeoutMs: 30000 });
  assert.equal(await sw.getByRole('button', { pressed: true }).innerText(), '原始 PDF');
  await viewer.locator('.reader-pdf-bar').getByRole('button', { name: '下一页' }).click();
  await viewer.locator('.reader-pdf-bar').getByRole('button', { name: '下一页' }).click();
  await until(async () => (await pdfPage()) === '7', 'page 7', { timeoutMs: 30000 });
  await closeReader();
  await openRow('Lecture');
  await until(async () => (await mode()) === 'original' && (await pdfPage()) === '7', 'page 7 after a reopen', { timeoutMs: 30000 });

  // Back to 文字: the text is at the page the PDF was on; and the next open is the text again.
  await sw.getByRole('button', { name: '文字' }).click();
  await until(async () => (await mode()) === 'read' && (await topPage()) === 7, 'the text at page 7', { timeoutMs: 30000 });
  await closeReader();
  await openRow('Lecture');
  await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  assert.equal(await mode(), 'read', 'left in the text, it opens in the text');

  // 420px: the views are in 更多 only, and the toolbar stays one row.
  await closeReader();
  await page.setViewportSize({ width: 420, height: 900 });
  await openRow('Lecture');
  await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  assert.equal(await sw.count(), 0, '420px: no switch on the toolbar');
  assert.deepEqual(await rows(), { rows: 1, overflow: false }, '420px: the toolbar is one row');
  await viewer.getByRole('button', { name: '更多', exact: true }).click();
  const items = await page.locator('.sh-menu [role^="menuitem"]').allInnerTexts();
  assert.ok(['阅读', '原文', '原始 PDF'].every(word => items.some(item => item.startsWith(word))), `420px: 更多 holds the views (${JSON.stringify(items)})`);
  await shot('narrow-more');
  await page.keyboard.press('Escape');
  await page.locator('.sh-menu').waitFor({ state: 'detached' });
  await closeReader();
  await page.setViewportSize({ width: 1280, height: 900 });

  // Garbled formulas: the suggestion comes once per material, and 看原始 PDF opens the original.
  await openRow('Formulas');
  const hint = viewer.locator('[data-formula-hint]');
  await hint.waitFor({ timeout: 30000 });
  assert.match(await hint.innerText(), /公式较多/);
  await shot('formula-hint');
  await hint.getByRole('button', { name: '看原始 PDF' }).click();
  await until(async () => (await mode()) === 'original', 'the original from the suggestion', { timeoutMs: 30000 });
  await sw.getByRole('button', { name: '文字' }).click();
  await until(async () => (await mode()) === 'read', 'the text again', { timeoutMs: 30000 });
  await page.waitForTimeout(500);
  assert.equal(await hint.count(), 0, 'told once: not again in the same open');
  await closeReader();
  await openRow('Formulas');
  await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  assert.equal(await hint.count(), 0, 'told once: not again on the next open');
  await closeReader();

  // Opens aimed somewhere do not take the kept 原始 PDF (gate review of #1021): the Lecture is left in the original at page 4, then
  // 去资料选页做题 from a practice round (pick pages, with a way back) opens the text with its guide, and 看这题的原文 (a quote) opens the text at the quote.
  await openRow('Lecture');
  await sw.getByRole('button', { name: '原始 PDF' }).click();
  await until(async () => (await mode()) === 'original', 'the Lecture in the original', { timeoutMs: 30000 });
  await viewer.locator('.reader-pdf-bar').getByRole('spinbutton', { name: '页码' }).fill('4');
  await viewer.locator('.reader-pdf-bar').getByRole('spinbutton', { name: '页码' }).press('Enter');
  await until(async () => (await pdfPage()) === '4', 'page 4', { timeoutMs: 30000 });
  await page.evaluate(() => document.activeElement?.blur()); // Esc in the page field is the field's own
  await closeReader();
  await page.goto(running.server.url);
  await page.getByRole('button', { name: '开始今日学习' }).first().click();
  await page.locator('.review-page').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '去资料选页做题' }).click();
  await viewer.waitFor({ timeout: 30000 });
  await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  assert.equal(await mode(), 'read', 'picking pages opens the text, not the kept 原始 PDF');
  assert.match(await viewer.innerText(), /先翻到正在看的那一章或那几页/, 'with the guide to picking pages');
  await shot('pick-pages');
  await closeReader();
  // Back in the round (the reader had a way back to it): show the answer, then its citation.
  await page.locator('.review-page').waitFor({ timeout: 30000 });
  const citedPage = /part 9/.test(await page.locator('.review-page').innerText()) ? 9 : 3;
  await page.locator('.review-heading h1').first().click().catch(() => {});
  await page.keyboard.press('Space'); await page.waitForTimeout(400);
  await page.keyboard.press('5'); await page.waitForTimeout(400);
  const cited = page.getByRole('button', { name: '看这题的原文' });
  await cited.waitFor({ timeout: 15000 });
  await cited.click();
  await viewer.waitFor({ timeout: 30000 });
  await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  assert.equal(await mode(), 'read', 'a quote opens the text, not the kept 原始 PDF');
  await until(async () => (await topPage()) <= citedPage && (await topPage()) >= citedPage - 1, `the text near the quoted page ${citedPage}`, { timeoutMs: 15000 });
  assert.deepEqual(errors, [], 'no console or page errors');
});
