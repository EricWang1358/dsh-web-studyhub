/* 看原页图 on a question card (issue #897, slice S1): after the answer is shown, one step from the question to the original page its citation
   points at, when that page has a figure. The pure parts (which cited pages can have an original page, the same figure detection as the
   reader, the lookup that reads only what it needs) and the markup in both languages. The click, the peek that opens and the card's own
   place in the answer are checked in a browser: tests/question-figure-link-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/practice/figure-page.js';
  export { FigurePageLinkView } from './ui/document-preview/practice/FigurePageLink.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const instance = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), instance, instance.exports);
const lib = instance.exports;
const { citedPages, pageHasFigure, findFigurePage } = lib;
const h = React.createElement;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };

// The real shape: the format is on the source itself, the page extractors never put one in `document` (a page of an older record has neither).
const page = (id, number, extra = {}) => ({ id, title: 'OS book', format: 'pdf', document: { id: 'doc', materialId: 'doc', page: number, totalPages: 9 }, ...extra });
const sources = [page('p2', 2), page('p3', 3), page('p5', 5, { format: undefined }), { id: 'notes', title: 'notes' },
  page('slide', 4, { format: 'pptx', document: { id: 'deck', materialId: 'deck', page: 4, totalPages: 9 } }),
  page('json', 6, { title: 'JSON 导入：题目' })];
const cardOf = (...citations) => ({ citations: citations.map(sourceId => ({ sourceId, quote: `quote of ${sourceId}` })) });

/* ---------- which cited pages can show an original page ---------- */

test('only the cited pages of a PDF are candidates, in the order they are cited, each once', () => {
  const found = citedPages(cardOf('p3', 'notes', 'slide', 'p2', 'p3', 'missing'), sources);
  assert.deepEqual(found.map(item => [item.source.id, item.page, item.quote]), [['p3', 3, 'quote of p3'], ['p2', 2, 'quote of p2']]);
  assert.deepEqual(citedPages(cardOf('p5', 'slide'), sources).map(item => item.source.id), ['p5'], 'a source with no format at all counts as a PDF page; a slide never does');
});

test('a card without citations, or one that only cites an imported question\'s own JSON, has no candidate', () => {
  assert.deepEqual(citedPages({}, sources), []);
  assert.deepEqual(citedPages({ citations: [] }, sources), []);
  assert.deepEqual(citedPages(cardOf('json'), sources), []);
  assert.deepEqual(citedPages(undefined, sources), []);
});

test('a candidate opens the reader the way a citation does: its source carries the selection of the same quote', () => {
  const selection = { sourceId: 'p5', quote: 'quote of p5', revision: 'r1', start: 4, end: 20 };
  const [item] = citedPages({ citations: [{ sourceId: 'p5', quote: 'quote of p5' }], selections: [selection] }, sources);
  assert.equal(item.source.id, 'p5');
  assert.deepEqual(item.source.selection, selection);
  assert.equal(item.page, 5);
});

/* ---------- a figure is what the reader calls a figure ---------- */

test('only a lone figure marker is a figure: [Figure], 图, or the doc: image block, never a sentence that mentions one', () => {
  assert.equal(pageHasFigure('Intro text.\n\n[Figure]\n\nMore text.'), true);
  assert.equal(pageHasFigure('第一段。\n\n[图]\n\n第二段。'), true);
  assert.equal(pageHasFigure('第一段。\n\n![架构图](doc:abc/fig1.png)\n\n第二段。'), true);
  assert.equal(pageHasFigure('As Figure 3 shows, the [Figure] marker inside a sentence is only text.'), false);
  assert.equal(pageHasFigure(''), false);
  assert.equal(pageHasFigure(undefined), false);
});

/* ---------- the lookup reads only what it needs ---------- */

const calls = [];
const fakeCall = ({ texts = {}, originals = {} } = {}) => async (name, params) => {
  calls.push([name, params]);
  if (name === 'source.get') return { id: params.id, text: texts[params.id] ?? '' };
  if (name === 'materials.original.status') return { status: originals[params.sourceId] ?? 'ok' };
  throw new Error(`unexpected call ${name}`);
};

test('no cited page: no backend call at all', async () => {
  calls.length = 0;
  assert.equal(await findFigurePage({ pages: [], call: fakeCall() }), null);
  assert.deepEqual(calls, []);
});

test('the first cited page that has a figure and an original is the answer; the pages after it are never read', async () => {
  calls.length = 0;
  const pages = citedPages(cardOf('p2', 'p3', 'p5'), sources);
  const found = await findFigurePage({ pages, call: fakeCall({ texts: { p2: 'plain page', p3: 'text\n\n[Figure]', p5: '[Figure]' } }) });
  assert.equal(found.page, 3);
  assert.equal(found.source.id, 'p3');
  assert.equal(found.quote, 'quote of p3');
  assert.ok(!calls.some(([, params]) => params.id === 'p5' || params.sourceId === 'p5'), 'p5 was not looked at');
});

test('the original is asked about only once a page has a figure, once per material: then the rest of that material is not read', async () => {
  calls.length = 0;
  const pages = citedPages(cardOf('p2', 'p3', 'p5'), sources);
  assert.equal(await findFigurePage({ pages, call: fakeCall({ originals: { p2: 'missing' }, texts: { p2: '[Figure]', p3: '[Figure]', p5: '[Figure]' } }) }), null);
  assert.deepEqual(calls.map(([name]) => name), ['source.get', 'materials.original.status'], 'one status for the whole material, no further page read');
});

test('a page without a figure never asks about the original: the status of a native PDF (a whole-file hash) is not paid for nothing', async () => {
  calls.length = 0;
  const pages = citedPages(cardOf('p2', 'p3'), sources);
  assert.equal(await findFigurePage({ pages, call: fakeCall({ texts: { p2: 'plain', p3: 'also plain' } }) }), null);
  assert.deepEqual(calls.map(([name]) => name), ['source.get', 'source.get']);
});

test('a figure on a later page asks once; a second figure page of the same material does not ask again', async () => {
  calls.length = 0;
  const pages = citedPages(cardOf('p2', 'p3', 'p5'), sources);
  const found = await findFigurePage({ pages, call: fakeCall({ texts: { p2: 'plain', p3: '[Figure]', p5: '[Figure]' } }) });
  assert.equal(found.page, 3);
  assert.deepEqual(calls.map(([name]) => name), ['source.get', 'source.get', 'materials.original.status']);
});

test('a failing backend call hides the entry instead of breaking the card', async () => {
  const pages = citedPages(cardOf('p2'), sources);
  assert.equal(await findFigurePage({ pages, call: async () => { throw new Error('offline'); } }), null);
  const broken = async name => { if (name === 'source.get') throw new Error('gone'); return { status: 'ok' }; };
  assert.equal(await findFigurePage({ pages, call: broken }), null);
});

/* ---------- the entry, in both languages ---------- */

test('the entry is one small button; with nothing found there is nothing', () => {
  assert.equal(renderToStaticMarkup(h(lib.FigurePageLinkView, { found: null, onOpen() {} })), '');
  const found = citedPages(cardOf('p3'), sources)[0];
  const zh = renderToStaticMarkup(h(lib.FigurePageLinkView, { found, onOpen() {} }));
  assert.match(zh, /<button/);
  assert.equal((zh.match(/<button/g) || []).length, 1);
  assert.ok(text(zh).includes('看原页图'));
  assert.doesNotMatch(zh, /title=/, 'words on hover go through the Tooltip, never title=');
});

test('in English the entry has no Chinese left', () => {
  const found = citedPages(cardOf('p3'), sources)[0];
  const en = inLanguage('en', () => renderToStaticMarkup(h(lib.FigurePageLinkView, { found, onOpen() {} })));
  assert.doesNotMatch(en, han);
  assert.ok(text(en).includes('See the figure on the original page'));
});
