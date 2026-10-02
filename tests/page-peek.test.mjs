/* 看原页 (page peek): a small on-demand glance at the ORIGINAL page from the text reader. The pure parts (which PDF page a text page is,
   how big it may be drawn, the six-bitmap LRU, the render gate that cancels, the progressive plan), the markup of every state in
   Chinese and English, and where the buttons are put. The real rendering (pdf.js, one canvas, memory) is checked in a browser:
   scripts/qa/peek.mjs. No network; generated PDFs only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const han = /[\u3400-\u9fff]/;
const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/peek/peek-logic.js';
  export { default as PagePeekView } from './ui/document-preview/peek/PagePeekView.jsx';
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const { LruCache, MAX_EDGE, MAX_CACHED_PAGES, ZOOMS, createRenderGate, isFigurePlaceholder, pdfPageFor, peekCanvasSize, peekPlan, peekStatus, stepZoom } = lib;
const h = React.createElement, noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };

/* ---------- which PDF page is a text page ---------- */

test('a text page is the same-numbered PDF page when both have the same number of pages', () => {
  assert.deepEqual(pdfPageFor({ page: 5, totalPages: 120, pdfPages: 120 }), { ok: true, pdfPage: 5 });
  assert.deepEqual(pdfPageFor({ page: 1, totalPages: 1, pdfPages: 1 }), { ok: true, pdfPage: 1 });
  assert.deepEqual(pdfPageFor({ page: 120, totalPages: 120, pdfPages: 120 }), { ok: true, pdfPage: 120 });
});

test('a document that keeps its own offset (a window of a longer file) maps through it', () => {
  assert.deepEqual(pdfPageFor({ page: 3, totalPages: 40, pdfPages: 140, offset: 100 }), { ok: false, reason: 'count-mismatch', totalPages: 40, pdfPages: 140 }, 'the whole-file page count still has to agree unless the window is declared');
  assert.deepEqual(pdfPageFor({ page: 3, totalPages: 40, pdfPages: 140, offset: 100, window: true }), { ok: true, pdfPage: 103 });
  assert.deepEqual(pdfPageFor({ page: 41, totalPages: 40, pdfPages: 140, offset: 100, window: true }), { ok: false, reason: 'out-of-range', pdfPages: 140 }, 'a page the text does not have is not guessed');
  assert.deepEqual(pdfPageFor({ page: 3, totalPages: 140, pdfPages: 140, offset: 0 }), { ok: true, pdfPage: 3 });
});

test('page counts that differ are said, never guessed; a page that is not a number or not there is refused', () => {
  assert.deepEqual(pdfPageFor({ page: 5, totalPages: 120, pdfPages: 98 }), { ok: false, reason: 'count-mismatch', totalPages: 120, pdfPages: 98 });
  assert.deepEqual(pdfPageFor({ page: 0, totalPages: 3, pdfPages: 3 }), { ok: false, reason: 'no-page' });
  assert.deepEqual(pdfPageFor({ page: 1.5, totalPages: 3, pdfPages: 3 }), { ok: false, reason: 'no-page' });
  assert.deepEqual(pdfPageFor({ page: undefined, totalPages: 3, pdfPages: 3 }), { ok: false, reason: 'no-page' });
  assert.deepEqual(pdfPageFor({ page: 4, totalPages: 3, pdfPages: 3 }), { ok: false, reason: 'out-of-range', pdfPages: 3 });
  assert.deepEqual(pdfPageFor({ page: 2, totalPages: 0, pdfPages: 3 }), { ok: true, pdfPage: 2 }, 'a text that does not know its length is trusted for pages that exist');
});

/* ---------- size, zoom and progressive drawing ---------- */

test('no page is ever drawn larger than 2000 px on its long edge', () => {
  assert.equal(MAX_EDGE, 2000);
  const portrait = peekCanvasSize({ width: 612, height: 792, scale: 4 });
  assert.ok(Math.max(portrait.width, portrait.height) <= MAX_EDGE);
  assert.equal(portrait.capped, true);
  assert.equal(portrait.height, 2000);
  const small = peekCanvasSize({ width: 612, height: 792, scale: 1 });
  assert.deepEqual({ w: small.width, h: small.height, capped: small.capped }, { w: 612, h: 792, capped: false });
  const wide = peekCanvasSize({ width: 2000, height: 100, scale: 3 });
  assert.equal(wide.width, 2000);
  assert.ok(wide.scale <= 1);
  assert.ok(peekCanvasSize({ width: 612, height: 792, scale: 0 }).width >= 1, 'never an empty canvas');
});

test('zoom steps stop at the ends and fit is 100%', () => {
  assert.deepEqual(ZOOMS, [0.5, 0.75, 1, 1.5, 2, 3]);
  assert.equal(stepZoom(1, 1), 1.5);
  assert.equal(stepZoom(1, -1), 0.75);
  assert.equal(stepZoom(3, 1), 3);
  assert.equal(stepZoom(0.5, -1), 0.5);
  assert.equal(stepZoom(1.2, 1), 1.5, 'an odd value moves to the next step');
  assert.equal(stepZoom(1.2, -1), 1);
});

test('the page is drawn small first, then sharp: one cheap pass, then the pass for the zoom, and a cached sharp page is just shown', () => {
  const plan = peekPlan({ fitScale: 1.2, zoom: 1, dpr: 2, cached: { low: false, sharp: false } });
  assert.deepEqual(plan.map(step => step.quality), ['low', 'sharp']);
  assert.ok(plan[0].scale < plan[1].scale);
  assert.equal(plan[1].scale, 1.2 * 1 * 2, 'sharp = fit x zoom x device pixel ratio');
  assert.deepEqual(peekPlan({ fitScale: 1.2, zoom: 2, dpr: 1, cached: { low: false, sharp: false } }).at(-1).scale, 2.4);
  assert.deepEqual(peekPlan({ fitScale: 1, zoom: 1, dpr: 1, cached: { low: true, sharp: false } }).map(step => step.quality), ['sharp']);
  assert.deepEqual(peekPlan({ fitScale: 1, zoom: 1, dpr: 1, cached: { low: false, sharp: true } }), [], 'nothing to render');
  assert.equal(peekPlan({ fitScale: 1, zoom: 0.5, dpr: 1, cached: { low: false, sharp: false } }).length, 1, 'a page that is already small is not drawn twice');
});

/* ---------- the cache and the gate ---------- */

test('the cache keeps at most six page bitmaps, the least recently used goes first and is released', () => {
  assert.equal(MAX_CACHED_PAGES, 6);
  const released = [];
  const cache = new LruCache(MAX_CACHED_PAGES, (value, key) => released.push(key));
  for (let page = 1; page <= 6; page += 1) cache.set(`p${page}`, { page });
  assert.equal(cache.size, 6);
  assert.deepEqual(cache.get('p1'), { page: 1 }, 'a hit');
  cache.set('p7', { page: 7 });
  assert.deepEqual(released, ['p2'], 'p1 was used last, so p2 is the one that leaves');
  assert.equal(cache.has('p2'), false);
  assert.equal(cache.has('p1'), true);
  assert.equal(cache.size, 6);
  cache.set('p7', { page: 70 });
  assert.deepEqual(released, ['p2', 'p7'].slice(0, 1).concat(['p7']), 'replacing a value releases the old one');
  cache.delete('p3');
  assert.ok(released.includes('p3'));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(released.length, 3 + 5, 'clearing releases every bitmap that was left');
});

test('a cache of any other capacity still bounds itself, and a get of an absent key is undefined', () => {
  const cache = new LruCache(2);
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual([...cache.keys()], ['b', 'c']);
  assert.equal(new LruCache(0).set('x', 1) === undefined, true);
  assert.equal(new LruCache(0).size, 0, 'a cache of zero keeps nothing');
});

test('only the latest render may draw: starting another one, closing or changing the page cancels the one before', () => {
  const gate = createRenderGate();
  const first = gate.begin();
  assert.equal(first.signal.aborted, false);
  assert.equal(first.current(), true);
  const second = gate.begin();
  assert.equal(first.signal.aborted, true, 'a page change cancels the render in flight');
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
  gate.cancelAll();
  assert.equal(second.signal.aborted, true, 'closing cancels it too');
  assert.equal(second.current(), false);
  const third = gate.begin();
  assert.equal(third.current(), true, 'and the gate can be used again');
});

/* ---------- what the popover says ---------- */

test('the popover knows five states and says them in plain words', () => {
  const original = status => ({ mode: 'reference', status, path: 'D:\\books\\os.pdf' });
  assert.equal(peekStatus({ available: true, original: { mode: 'copy', status: 'ok' } }).kind, 'ok');
  const none = peekStatus({ available: false, original: { mode: null, status: 'none' } });
  assert.equal(none.kind, 'none');
  assert.equal(none.canAttach, true);
  const moved = peekStatus({ available: false, original: original('missing') });
  assert.equal(moved.kind, 'missing');
  assert.match(moved.message, /找不到/);
  assert.equal(moved.canAttach, true);
  assert.equal(peekStatus({ available: false, original: original('changed') }).kind, 'changed');
  assert.equal(peekStatus(undefined).kind, 'none');
});

test('only a lone figure placeholder is a figure: [Figure], 图, or the doc: image block the converter names', () => {
  for (const line of ['[Figure]', ' [Figure] ', '[图]', '[图片]', '![Image block](doc:5008352/tier:basic/page:11/block:1)', '![](doc:1/page:2)']) assert.equal(isFigurePlaceholder(line), true, line);
  for (const line of ['See [Figure] 3 for details.', 'A figure shows the cache.', '', '[Figures]', '![Image block](https://example.com/a.png)', undefined]) assert.equal(isFigurePlaceholder(line), false, String(line));
});

const base = { page: 3, total: 12, pdfPage: 3, zoom: 1, onClose: noop, onPrev: noop, onNext: noop, onZoom: noop, onFit: noop, onAttach: noop, onRetry: noop };
const view = props => renderToStaticMarkup(h(lib.PagePeekView, { ...base, ...props }));

test('the ready state is a floating dialog with one canvas, page buttons, zoom and a plain note about figures', () => {
  const html = view({ phase: 'ready', figure: true });
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="原页预览"/);
  assert.match(html, /aria-modal="false"/);
  assert.equal((html.match(/<canvas/g) || []).length, 1, 'rendered into one canvas');
  assert.match(text(html), /第 3 \/ 12 页/);
  for (const label of ['上一页', '下一页', '放大', '缩小', '适合宽度', '关闭']) assert.match(html, new RegExp(`aria-label="${label}"`), label);
  assert.match(text(html), /文字版不含图片：这里直接显示原文件的这一页。/);
  assert.match(text(html), /100%/);
  assert.doesNotMatch(view({ phase: 'ready', figure: false }), /文字版不含图片/, 'the note is for figures');
});

test('the first and last page disable their own arrow, and zoom stops at its ends', () => {
  const disabled = (html, label) => (html.match(/<button[^>]*>/g) || []).find(tag => tag.includes(`aria-label="${label}"`))?.includes('disabled=""');
  const first = view({ phase: 'ready', page: 1 }), last = view({ phase: 'ready', page: 12 });
  assert.equal(disabled(first, '上一页'), true);
  assert.equal(disabled(first, '下一页'), false);
  assert.equal(disabled(last, '下一页'), true);
  assert.equal(disabled(view({ phase: 'ready', zoom: 3 }), '放大'), true);
  assert.equal(disabled(view({ phase: 'ready', zoom: 0.5 }), '缩小'), true);
  assert.equal(disabled(view({ phase: 'ready', zoom: 1 }), '放大'), false);
});

test('without an original it explains in one line and offers 补全原文件 instead of an empty frame', () => {
  const none = view({ phase: 'none', issue: { kind: 'none', message: '', canAttach: true } });
  assert.doesNotMatch(none, /<canvas/);
  assert.match(text(none), /这份资料只保存了提取出的文字，没有原文件，所以看不到原页。/);
  assert.match(none, /补全原文件…/);
  const moved = view({ phase: 'none', issue: { kind: 'missing', message: '原文件找不到了：D:\\books\\os.pdf', canAttach: true } });
  assert.match(text(moved), /原文件找不到了：D:\\books\\os\.pdf/);
  assert.match(moved, /重新指定…/);
});

test('loading, a page that did not draw, and page counts that disagree each have their own plain message', () => {
  assert.match(text(view({ phase: 'loading' })), /正在读取原文件…/);
  assert.match(view({ phase: 'loading' }), /role="status"/);
  const error = view({ phase: 'error', message: 'Invalid PDF structure' });
  assert.match(error, /role="alert"/);
  assert.match(text(error), /这一页没能显示：Invalid PDF structure/);
  assert.match(error, /重试/);
  const mismatch = view({ phase: 'mismatch', mismatch: { totalPages: 120, pdfPages: 98 } });
  assert.doesNotMatch(mismatch, /<canvas/);
  assert.match(text(mismatch), /文字版共 120 页，原文件有 98 页：页码对不上，为避免看错页，这里不显示。/);
  assert.match(mismatch, /重新指定…/);
});

test('every state in English has no Chinese left', () => {
  inLanguage('en', () => {
    for (const props of [{ phase: 'ready', figure: true }, { phase: 'loading' }, { phase: 'error', message: 'Invalid PDF structure' },
      { phase: 'none', issue: { kind: 'none', message: '', canAttach: true } }, { phase: 'mismatch', mismatch: { totalPages: 120, pdfPages: 98 } }]) {
      const html = view(props);
      assert.doesNotMatch(text(html), han, props.phase);
      assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), han);
      for (const attribute of html.match(/aria-label="[^"]*"|title="[^"]*"/g) || []) assert.doesNotMatch(attribute, han, attribute);
    }
    assert.match(text(view({ phase: 'ready', figure: true })), /Figures are not kept in the text: this shows that page of the original file\./);
    assert.match(text(view({ phase: 'mismatch', mismatch: { totalPages: 120, pdfPages: 98 } })), /The text has 120 pages and the original file has 98/);
  });
});

/* ---------- where the buttons are ---------- */

const sections = [
  { id: 'p1', kind: 'page', page: 1, sourceId: 's1', title: '', paragraphs: [{ kind: 'prose', text: 'Page one has some words on it.' }, { kind: 'heading', text: '[Figure]' }] },
  { id: 'p2', kind: 'page', page: 2, sourceId: 's2', title: '', paragraphs: [{ kind: 'prose', text: 'Page two as well.' }] },
  { id: 't1', kind: 'part', title: 'Part one', paragraphs: [{ kind: 'prose', text: 'A transcript part.' }] },
];
const render = props => renderToStaticMarkup(h(lib.ReadingSections, { sections, labelOf: section => section.kind === 'page' ? `第 ${section.page} 页` : '', ...props }));

test('each page header gets a 看原页 button and each figure placeholder one beside it, and only when peeking is possible', () => {
  const html = render({ onPeek: noop });
  assert.equal((html.match(/data-peek-page="/g) || []).length, 3, 'two page headers and one figure');
  assert.equal((html.match(/data-peek-figure="true"/g) || []).length, 1);
  assert.match(html, /data-peek-page="1"[^>]*>看原页</);
  assert.match(html, /data-study-marker="true"[^>]*><button[^>]*data-peek-figure="true"/, 'the figure button is a marker: it is not part of the text a selection or a quote sees');
  assert.doesNotMatch(html.slice(html.indexOf('Part one')), /data-peek-page/, 'a transcript has no pages');
  const none = render({});
  assert.doesNotMatch(none, /看原页|data-peek/, 'without a way to peek the markup is what it was');
  assert.match(none, /<h4 class="reader-p reader-p--heading">\[Figure\]<\/h4>/);
  inLanguage('en', () => assert.match(render({ onPeek: noop }), /Original page/));
});

test('the viewer mounts the peek once, and the 原文 view has the same buttons', async () => {
  const viewer = await readFile(new URL('../ui/document-preview/DocumentViewer.jsx', import.meta.url), 'utf8');
  assert.equal((viewer.match(/<PagePeek\b/g) || []).length, 1, 'ONE mount');
  assert.match(viewer, /onPeek=/);
  assert.match(viewer, /data-peek-page/, 'the 原文 view page labels carry the button too');
});
