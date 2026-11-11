/* global document, window */
/* 看原页图 on a question card (issue #897, slice S1), in a real browser: the whole QuestionRun with a fake study context. The entry appears
   only after the answer is shown, only for a cited page that has a figure and an original, costs no backend call for a question without
   citations, and a click opens the source dialog's modal with the right source, quote and page; the reader given that page puts the same
   看原页 panel up by itself. No network (every request is aborted), no real PDF: pdf.js is stubbed out, the panel only has to appear. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import QuestionRun from './ui/review/QuestionRun.jsx';
  import DocumentViewer from './ui/document-preview/DocumentViewer.jsx';
  import { StudyServicesContext } from './ui/study-context.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import { reviewParts } from './tests/helpers/review-render.mjs';
  import css from './ui/styles.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  window.calls = []; window.opened = [];
  const page = (id, number) => ({ id, title: 'OS book', format: 'pdf', text: 'page ' + number, document: { id: 'doc', materialId: 'doc', page: number, totalPages: 3 } });
  const sources = [page('p1', 1), page('p2', 2), page('p3', 3), { id: 'notes', title: 'notes', text: 'plain notes' }];
  const texts = { p1: 'plain page', p2: 'Intro.\\n\\n[Figure]\\n\\nMore.', p3: 'As Figure 3 shows, [Figure] inside a sentence is only text.' };
  const call = async (name, params) => {
    window.calls.push([name, params]);
    if (name === 'materials.original.status') return { status: window.originalStatus || 'ok' };
    if (name === 'source.get') return { id: params.id, text: texts[params.id] ?? '' };
    return {};
  };
  const card = { id: 'q', kind: 'quiz', topic: 'Context', prompt: 'Who schedules processes?', options: [{ id: 'a', text: 'Scheduler' }, { id: 'b', text: 'Clerk' }] };
  const solution = citations => ({ answer: 'Scheduler', explanation: 'The scheduler picks the next process.', misconception: 'Not the clerk.', citations,
    options: [{ id: 'a', correct: true, explanation: 'yes' }, { id: 'b', correct: false, explanation: 'no' }] });
  const root = createRoot(document.getElementById('root'));
  window.showQuestion = ({ citations, revealed = true, key = 'q' }) => {
    // Before the answer the card itself carries the citations, so an entry mounted outside the revealed-answer block would show (and read) here.
    const run = { id: key, index: 0, total: 1, mode: 'path', card: revealed ? card : { ...card, citations, selections: [] }, ...(revealed ? { revealed: true, feedback: { correct: true, selected: ['a'], level: 'learning' }, solution: solution(citations) } : {}) };
    const { services, props } = reviewParts({ run, data: { sources }, call, setModal: modal => window.opened.push(modal) });
    root.render(<StudyServicesContext.Provider value={services}><div key={key} className="study-app"><QuestionRun {...props} /></div></StudyServicesContext.Provider>);
  };
  const pdf = btoa('%PDF-1.4\\n%%EOF');
  const readerCall = async (name) => {
    if (name === 'materials.document.get') return { id: 'doc', documentId: 'doc', revision: 'r1', currentRevision: 'r1', format: 'pdf', originalAvailable: true, original: { status: 'ok' }, sources };
    if (name === 'materials.document.bytes') return { status: 'ok', dataBase64: pdf, mime: 'application/pdf' };
    if (name === 'materials.links.list') return { links: [] };
    return [];
  };
  window.showReader = peekPage => root.render(<DocumentViewer key={String(peekPage)} source={sources[1]} call={readerCall} data={{ sources, decks: [] }} peekPage={peekPage} />);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  plugins: [{ name: 'stub-pdfjs', setup(builder) {
    builder.onResolve({ filter: /^pdfjs-dist\// }, args => ({ path: args.path, namespace: 'stub-pdfjs' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub-pdfjs' }, () => ({ contents: 'export const getDocument = () => ({}); export const WorkerMessageHandler = {}; export class TextLayer {}', loader: 'js' }));
  } }],
  loader: { '.css': 'text' }, logLevel: 'silent' });

async function open(t, width = 1100) {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return null;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://figure-link.test/') return route.fulfill({ contentType: 'text/html', body: '<main id="root" style="height:760px"></main>' });
    return route.abort();
  });
  await page.goto('http://figure-link.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return { page, errors };
}
// The calls this entry makes (the question card asks for other things of its own, e.g. the book's questions).
const names = page => page.evaluate(() => window.calls.map(([name]) => name).filter(name => name === 'materials.original.status' || name === 'source.get'));
const settle = page => page.waitForTimeout(150);

test('the entry is absent before the answer is shown and nothing is read for it', { timeout: 60000 }, async t => {
  const opened = await open(t); if (!opened) return;
  const { page, errors } = opened;
  await page.evaluate(() => window.showQuestion({ citations: [{ sourceId: 'p2', quote: 'quote of p2' }], revealed: false }));
  await page.locator('.question-card').waitFor();
  await settle(page);
  assert.equal(await page.getByRole('button', { name: '看原页图' }).count(), 0);
  assert.deepEqual(await names(page), [], 'no backend call before the answer is shown');
  assert.deepEqual(errors, []);
});

test('after the answer, a cited page with a figure and an original gives one entry; a click opens the source modal at that page', { timeout: 60000 }, async t => {
  const opened = await open(t); if (!opened) return;
  const { page, errors } = opened;
  await page.evaluate(() => window.showQuestion({ citations: [{ sourceId: 'p1', quote: 'quote of p1' }, { sourceId: 'p2', quote: 'quote of p2' }, { sourceId: 'p3', quote: 'quote of p3' }] }));
  const entry = page.getByRole('button', { name: '看原页图' });
  await entry.waitFor();
  assert.equal(await entry.count(), 1);
  assert.deepEqual(await names(page), ['source.get', 'source.get', 'materials.original.status'], 'the pages up to the first with a figure, then one status for the material');
  await entry.click();
  const modals = await page.evaluate(() => window.opened.map(modal => ({ type: modal.type, id: modal.source.id, quote: modal.quote, peekPage: modal.peekPage })));
  assert.deepEqual(modals, [{ type: 'source', id: 'p2', quote: 'quote of p2', peekPage: 2 }]);
  assert.deepEqual(errors, []);
});

test('no entry when the original is missing, when the page has no figure, or when the question cites nothing; and nothing extra is read', { timeout: 60000 }, async t => {
  const opened = await open(t); if (!opened) return;
  const { page } = opened;
  const entry = page.getByRole('button', { name: '看原页图' });
  const reset = () => page.evaluate(() => { window.calls.length = 0; });

  await page.evaluate(() => { window.originalStatus = 'missing'; window.showQuestion({ citations: [{ sourceId: 'p2', quote: 'q' }], key: 'missing' }); });
  await page.locator('.explanation').waitFor(); await settle(page);
  assert.equal(await entry.count(), 0, 'original missing');
  assert.deepEqual(await names(page), ['source.get', 'materials.original.status'], 'the page with a figure is read, the original is missing, and no other page is read');

  await reset();
  await page.evaluate(() => { window.originalStatus = 'ok'; window.showQuestion({ citations: [{ sourceId: 'p1', quote: 'q' }, { sourceId: 'p3', quote: 'q' }], key: 'plain' }); });
  await page.locator('.explanation').waitFor(); await settle(page);
  assert.equal(await entry.count(), 0, 'no figure on the cited pages (a sentence that mentions one is not a figure)');
  assert.deepEqual(await names(page), ['source.get', 'source.get'], 'and the original (a whole-file hash) is not asked about at all');

  await reset();
  await page.evaluate(() => window.showQuestion({ citations: [], key: 'none' }));
  await page.locator('.explanation').waitFor(); await settle(page);
  assert.equal(await entry.count(), 0, 'no citation');
  assert.deepEqual(await names(page), [], 'a question without citations makes no backend call');

  await reset();
  await page.evaluate(() => window.showQuestion({ citations: [{ sourceId: 'notes', quote: 'plain notes' }], key: 'text' }));
  await page.locator('.explanation').waitFor(); await settle(page);
  assert.equal(await entry.count(), 0, 'a pasted text has no original page');
  assert.deepEqual(await names(page), [], 'and is not asked about');
});

test('the reader given a page puts the original page panel up by itself; without one it stays closed', { timeout: 60000 }, async t => {
  const opened = await open(t); if (!opened) return;
  const { page } = opened;
  await page.evaluate(() => window.showReader(undefined));
  await page.locator('.study-document-body').waitFor();
  await page.locator('.reader-peek').first().waitFor();
  assert.equal(await page.locator('.page-peek').count(), 0, 'closed unless asked');
  await page.evaluate(() => window.showReader(2));
  const panel = page.locator('.page-peek');
  await panel.waitFor();
  assert.ok((await panel.locator('.page-peek__where').textContent()).includes('第 2 / 3 页'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.page-peek'));
  await settle(page);
  assert.equal(await page.locator('.page-peek').count(), 0, 'closing it does not bring it back');
});
