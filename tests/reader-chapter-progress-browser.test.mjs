/* global document, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { planOutline } from '../lib/contexts/materials/outline.js';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { chooseMore } from './helpers/reader-more.mjs';
import { until } from './helpers/wait.mjs';

/* #1014 in the real page: a converted book of 100 pages in 5 chapters. Chapter 1 read to its end gets a ✓ in the 目录 and 已读 1/5 章, written to the
   study library once, when the chapter changes (never while scrolling); ] and [ turn the chapter, not while typing in the 目录 filter. Closed, the
   browser's storage cleared and opened again, the ✓ is still there (it is in the library); 标为未读 takes it back for good. Then, with a fake study
   context, the linked questions start with 本章 (the chapter on screen, in the order of the text) and 全书 lists them all; ] changes 本章 with the chapter.
   Pictures go to READER_PROGRESS_SHOTS when set. */

const at = '2026-11-01T08:00:00.000Z';
const REFUSED = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
const PAGES = 100, PER_CHAPTER = 20, CHAPTERS = PAGES / PER_CHAPTER;
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const pageText = page => [`Heading ${page}`, ...[1, 2, 3, 4].map(n => `Paragraph ${n} of page ${page}: output relates to demand through spending, saving and the multiplier, read slowly.`)].join('\n\n');
const source = page => ({ id: `book-p${page}`, title: `Book · p.${page}`, text: pageText(page), createdAt: at, courses: ['宏经'],
  document: { id: 'progress-book-hash', materialId: 'document-progress-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'progress-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const seed = async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => { state.sources.push(...Array.from({ length: PAGES }, (_, index) => source(index + 1))); });
  await service.dispose();
};
const drawnPages = page => page.evaluate(() => [...document.querySelectorAll('.study-document-viewer .reader-section[data-study-page]')].map(node => Number(node.dataset.studyPage)));
const chapterPages = index => Array.from({ length: PER_CHAPTER }, (_, n) => index * PER_CHAPTER + n + 1);

test('a chapter read to its end is ✓ in the 目录, kept in the library (not the browser), and [ / ] turn the chapter (#1014)', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-progress-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  t.after(() => running.close?.());
  const { page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
  const actions = [], refused = [];
  page.on('request', request => { try { const action = JSON.parse(request.postData() || '{}').action; if (action) actions.push(action); } catch { /* not a call */ } });
  page.on('response', response => { if (response.status() === 400) { try { refused.push(JSON.parse(response.request().postData() || '{}').action); } catch { refused.push(response.url()); } } });
  const saves = () => actions.filter(action => action === 'materials.reading.save').length;
  const viewer = page.locator('.study-document-viewer'), outline = viewer.locator('.reader-outline');
  const shots = process.env.READER_PROGRESS_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `progress-${name}.png`) }); };
  const waitChapter = (index, what) => until(async () => JSON.stringify(await drawnPages(page)) === JSON.stringify(chapterPages(index)), what, { timeoutMs: 30000 });
  const closeReader = async () => { await page.keyboard.press('Escape'); await until(async () => !(await viewer.count()), 'the reader to close', { timeoutMs: 15000 }); };
  const readCount = () => outline.locator('[data-read-count]').innerText().catch(() => '');
  const openOutline = async () => { if (!(await outline.count())) await viewer.getByRole('button', { name: '目录', exact: true }).click(); await outline.waitFor(); };
  /** Wheel over the text (the learner's own scroll) to the end of the chapter. */
  const wheelToEnd = async () => {
    const area = viewer.locator('.reader-scroll'), box = await area.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await until(async () => {
      const done = await area.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 2);
      if (!done) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(40); }
      return done;
    }, 'the end of the chapter', { timeoutMs: 60000 });
  };
  await page.goto(running.server.url);
  await (await revealNavRow(page, 'sources')).dispatchEvent('click');
  const row = page.locator('.source-doc', { hasText: 'progress-book' }).first();
  await row.waitFor({ timeout: 60000 });
  const openRow = async () => { await row.locator('.source-main').click(); await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 }); };

  await openRow();
  await waitChapter(0, 'the first chapter');
  await openOutline();
  await until(async () => (await readCount()) === `已读 0/${CHAPTERS} 章`, 'the read count', { timeoutMs: 15000 });

  // Read chapter 1 to its end: ✓ at once on screen, nothing written while scrolling.
  await wheelToEnd();
  await outline.locator('[data-chapter-read="chapter-0"]').waitFor({ timeout: 15000 });
  assert.equal(await readCount(), `已读 1/${CHAPTERS} 章`);
  assert.equal(saves(), 0, 'nothing is written while scrolling');
  await shot('read');

  // ] turns to chapter 2 and writes once; not while typing in the 目录 filter; [ goes back.
  await viewer.locator('.reader-scroll').focus();
  await page.keyboard.press(']');
  await waitChapter(1, '] to draw chapter 2');
  await until(async () => saves() === 1, 'one write when the chapter changed', { timeoutMs: 15000 });
  const filter = outline.getByRole('searchbox', { name: '在目录中查找' });
  await filter.fill('Heading 3');
  await filter.press(']');
  assert.equal(await filter.inputValue(), 'Heading 3]', 'the key types in the filter');
  await page.waitForTimeout(300);
  assert.deepEqual(await drawnPages(page), chapterPages(1), 'and turns no chapter');
  await filter.fill('');
  await viewer.locator('.reader-scroll').focus();
  await page.keyboard.press('[');
  await waitChapter(0, '[ back to chapter 1');
  const keyed = await viewer.locator('.reader-pager [data-direction="next"]').getAttribute('aria-keyshortcuts');
  assert.equal(keyed, ']', 'the pager says its key');
  await closeReader();

  // Not in the browser: with the browser's storage cleared, the ✓ comes back from the library.
  await page.evaluate(() => localStorage.clear());
  await openRow();
  await waitChapter(0, 'the start after clearing the browser storage');
  await openOutline();
  await outline.locator('[data-chapter-read="chapter-0"]').waitFor({ timeout: 15000 });
  assert.equal(await readCount(), `已读 1/${CHAPTERS} 章`);
  await shot('reopened');

  // 标为未读 takes it back, also after a reopen.
  await outline.getByRole('button', { name: /已读：.*Chapter 1.*标为未读/ }).click();
  await until(async () => (await readCount()) === `已读 0/${CHAPTERS} 章`, 'the chapter to be unread', { timeoutMs: 15000 });
  await until(async () => saves() >= 2, 'the unread to be written', { timeoutMs: 15000 });
  await page.waitForTimeout(300);
  await closeReader();
  await openRow();
  await openOutline();
  await until(async () => (await readCount()) === `已读 0/${CHAPTERS} 章`, 'still unread after a reopen', { timeoutMs: 15000 });
  assert.equal(await outline.locator('[data-chapter-read]').count(), 0);
  await closeReader();

  // With a kept AI outline the 目录 lists its own entries: the ✓ and 标为未读 sit on the first entry of each chapter (gate review of #1021, 2).
  const firsts = new Map();
  for (const unit of planOutline(Array.from({ length: PAGES }, (_, index) => source(index + 1))).units) {
    const chapter = chapterOf(Number(unit.sourceId.slice('book-p'.length)));
    if (!firsts.has(chapter)) firsts.set(chapter, { title: `Part ${chapter + 1} opens`, level: 1, startBlock: unit.index });
  }
  await running.api('materials.outline.save', { sourceId: 'book-p1', entries: [...firsts.values()] });
  await page.goto(running.server.url);
  await (await revealNavRow(page, 'sources')).dispatchEvent('click');
  await openRow();
  await waitChapter(0, 'the first chapter under the kept outline');
  await openOutline();
  await outline.locator('.reader-outline__link', { hasText: 'Part 1 opens' }).waitFor({ timeout: 15000 });
  await until(async () => (await readCount()) === `已读 0/${CHAPTERS} 章`, 'the read count under the kept outline', { timeoutMs: 15000 });
  await wheelToEnd();
  await outline.locator('[data-chapter-read="chapter-0"]').waitFor({ timeout: 15000 });
  assert.equal(await readCount(), `已读 1/${CHAPTERS} 章`);
  assert.equal(await outline.locator('[data-chapter-read]').count(), 1, 'one ✓, on the entry of chapter 1');
  await shot('read-ai-outline');
  await outline.getByRole('button', { name: /已读：.*Part 1 opens.*标为未读/ }).click();
  await until(async () => (await readCount()) === `已读 0/${CHAPTERS} 章`, 'unread from the kept outline', { timeoutMs: 15000 });
  assert.equal(await outline.locator('[data-chapter-read]').count(), 0);
  await closeReader();

  assert.ok(refused.every(action => ['materials.translation.list', 'materials.annotation.list', 'materials.marks.list'].includes(action)), `only the per-material lists are refused: ${JSON.stringify(refused)}`);
  assert.deepEqual(errors.filter(error => error !== REFUSED), [], 'no other console or page errors');
});

// ── 本章 / 全书, with a fake study context: two chapters of 15 pages, passages linked on pages 3, 12 (chapter 1) and 20 (chapter 2). ──
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import DocumentViewer from './ui/document-preview/DocumentViewer.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import css from './ui/styles.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const text = n => 'Heading ' + n + '\\n\\nPage ' + n + ' explains a point of the lecture. Point ' + n + ' is the one to remember about it.';
  const sources = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + (i + 1), title: 'Book · p.' + (i + 1), text: text(i + 1),
    document: { id: 'doc', materialId: 'doc', page: i + 1, totalPages: 30, format: 'pdf', origin: 'converted', converter: 'mineru', extractionVersion: 2, chapter: { index: i < 15 ? 0 : 1, title: i < 15 ? 'Demand' : 'Supply', level: 1 } } }));
  const link = (page, cardId, prompt) => { const t = text(page), quote = 'Point ' + page + ' is the one'; const start = t.indexOf(quote);
    return { status: 'resolved', deckId: 'deck', cardId, prompt, deckTitle: 'Macro', selection: { documentId: 'doc', revision: 'r1', sourceId: 'p' + page, start, end: start + quote.length, quote, page } }; };
  // Listed out of order on purpose: the panel puts them in the order of the text.
  const links = [link(20, 'c20', 'Question on page 20'), link(12, 'c12', 'Question on page 12'), link(3, 'c3', 'Question on page 3')];
  const call = async (name) => {
    if (name === 'materials.document.get') return { id: 'doc', documentId: 'doc', revision: 'r1', currentRevision: 'r1', format: 'pdf', originalAvailable: false, original: { status: 'none' }, sources };
    if (name === 'materials.links.list') return { links };
    if (name === 'materials.reading.get') return { read: [] };
    return [];
  };
  createRoot(document.getElementById('root')).render(<div className="study-app" style={{ height: '100%' }}><DocumentViewer source={sources[0]} call={call} data={{ sources, decks: [] }} /></div>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

test('the linked questions start with 本章, in the order of the text; 全书 lists them all; ] changes 本章 (#1014)', { timeout: 120000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  for (const width of [1280, 420]) {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => (route.request().url() === 'http://progress.test/' ? route.fulfill({ contentType: 'text/html', body: '<main id="root" style="height:880px"></main>' }) : route.abort()));
    await page.goto('http://progress.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const viewer = page.locator('.study-document-viewer');
    await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 30000 });
    if (!(await viewer.locator('[data-tour="source-tools"]').isVisible())) await chooseMore(page, '学习工具');
    const links = viewer.locator('.reader-links');
    await links.waitFor({ timeout: 15000 });
    const listed = () => links.locator('.reader-link-group__no').allInnerTexts();
    const scope = links.getByRole('group', { name: '关联题目的范围' });
    assert.equal(await scope.getByRole('button', { pressed: true }).innerText(), '本章 2', `${width}px: 本章 first`);
    // Chapter 1 holds the passages of pages 3 and 12 (numbers [3] and [2]), in the order of the text.
    const numbers = async () => (await listed()).join(' ');
    assert.equal(await numbers(), '[3] [2]', `${width}px: 本章 in the order of the text`);
    await scope.getByRole('button', { name: '全书 3' }).click();
    assert.equal(await numbers(), '[3] [2] [1]', `${width}px: 全书 in the order of the text`);
    await scope.getByRole('button', { name: '本章 2' }).click();
    await viewer.locator('.reader-scroll').focus();
    await page.keyboard.press(']');
    await until(async () => (await numbers()) === '[1]', `${width}px: ] shows the second chapter's passage`, { timeoutMs: 15000 });
    assert.equal(await scope.getByRole('button', { pressed: true }).innerText(), '本章 1');
    assert.deepEqual(errors, [], `${width}px: no page errors`);
    await page.close();
  }
});
