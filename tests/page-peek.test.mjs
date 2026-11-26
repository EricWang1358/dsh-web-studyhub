/* 看原页 (page peek): a small on-demand glance at the ORIGINAL page from the text reader. The pure parts (which PDF page a text page is,
   how big it may be drawn, the six-bitmap LRU, the render gate that cancels, the progressive plan), the markup of every state in
   Chinese and English, and where the buttons are put. The real rendering (pdf.js, one canvas, memory) is checked in a browser:
   scripts/qa/peek.mjs. No network; generated PDFs only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const han = /[\u3400-\u9fff]/;
const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/peek/peek-logic.js';
  export { default as PagePeekView } from './ui/document-preview/peek/PagePeekView.jsx';
  export { default as PdfOriginal } from './ui/document-preview/reader/PdfOriginal.jsx';
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'],
  plugins: [{ name: 'stub-pdfjs', setup(builder) {
    builder.onResolve({ filter: /^pdfjs-dist\// }, args => ({ path: args.path, namespace: 'stub-pdfjs' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub-pdfjs' }, () => ({ contents: 'export const getDocument = () => ({}); export const WorkerMessageHandler = {}; export class TextLayer {}', loader: 'js' }));
  } }],
  loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const { LruCache, MAX_EDGE, MAX_CACHED_PAGES, SLOW_PAGE_MS, TURN_COALESCE_MS, ZOOMS, createRenderGate, exceedsPageBudget, isFigurePlaceholder, pdfPageFor, peekCanvasSize, peekPlan, peekStatus, stepZoom } = lib;
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
  const prevWin = globalThis.window, prevDoc = globalThis.document, prevLS = globalThis.localStorage;
  const hooksByPath = new Map();
  let curHooks = [], cursor = 0, pendingEffects = [];
  const hLocal = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const domNode = () => ({
    scrollTop: 0, clientHeight: 500, focus: () => {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }), scrollTo() {},
    ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) },
  });
  const eff = (fn, deps) => {
    const bucket = curHooks, i = cursor++, prev = bucket[i];
    if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) {
      bucket[i] = { deps, cleanup: prev?.cleanup };
      pendingEffects.push(() => { bucket[i].cleanup?.(); bucket[i].cleanup = fn(); });
    }
  };
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: hLocal,
    cloneElement: (el, p, ...ch) => ({ ...el, props: { ...(el?.props || {}), ...(p || {}), ...(ch.length ? { children: ch.length === 1 ? ch[0] : ch } : {}) } }),
    isValidElement: x => !!x && typeof x === 'object' && '$$type' in x,
    Children: { toArray: c => (Array.isArray(c) ? c.flat(Infinity) : c == null ? [] : [c]), map: (c, fn) => (Array.isArray(c) ? c : [c]).map(fn) },
    memo: c => c, forwardRef: fn => (props => fn(props, props?.ref)),
    Suspense: p => p.children,
    lazy: () => (p => hLocal('div', { 'data-comp': 'PagePeek', ...p })),
    createContext: def => { const ctx = { _def: def, _val: def }; ctx.Provider = Object.assign(({ value, children }) => { ctx._val = value; return children; }, { $$providerCtx: ctx }); return ctx; },
    useContext: ctx => ctx?._val ?? ctx?._def,
    useState(init) { const bucket = curHooks, i = cursor++; if (!(i in bucket)) bucket[i] = typeof init === 'function' ? init() : init; return [bucket[i], v => { bucket[i] = typeof v === 'function' ? v(bucket[i]) : v; }]; },
    useReducer(reducer, init, initFn) { const bucket = curHooks, i = cursor++; if (!(i in bucket)) bucket[i] = initFn ? initFn(init) : init; return [bucket[i], a => { bucket[i] = reducer(bucket[i], a); }]; },
    useRef(init) { const i = cursor++; if (!(i in curHooks)) curHooks[i] = { current: init }; return curHooks[i]; },
    useId() { const i = cursor++; if (!(i in curHooks)) curHooks[i] = `:id${i}:`; return curHooks[i]; },
    useDeferredValue: v => v,
    useCallback: fn => fn,
    useImperativeHandle() {},
    useMemo(fn, deps) { const i = cursor++, prev = curHooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) curHooks[i] = { val: fn(), deps }; return curHooks[i].val; },
    useEffect: eff, useLayoutEffect: eff, useInsertionEffect() {},
    useSyncExternalStore: (_s, snap) => snap(),
  };
  reactShim.default = reactShim;
  globalThis.__DV_PEEK_REACT__ = reactShim;
  const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.localStorage = ls;
  globalThis.window = {
    getSelection: () => null, addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), localStorage: ls,
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute: () => {} }), head: { appendChild: () => {} } };

  const withBucket = (slot, fn) => {
    let bucket = hooksByPath.get(slot);
    if (!bucket) { bucket = []; hooksByPath.set(slot, bucket); }
    const prevH = curHooks, prevC = cursor;
    curHooks = bucket; cursor = 0;
    try { return fn(); } finally { curHooks = prevH; cursor = prevC; }
  };
  const expand = (node, path = '0') => {
    if (Array.isArray(node)) return node.map((item, idx) => expand(item, `${path}[${idx}]`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$$type === 'symbol') return expand(node.props?.children, `${path}:F`);
    if (node.$$type?.$$providerCtx) { node.$$type.$$providerCtx._val = node.props?.value; return expand(node.props?.children, `${path}:P`); }
    if (typeof node.$$type === 'function') {
      const slot = `${path}/${node.$$type.name || 'fn'}${node.props?.key != null ? `#${node.props.key}` : ''}`;
      return expand(withBucket(slot, () => node.$$type(node.props || {})), slot);
    }
    if (node.props?.ref && typeof node.props.ref === 'object' && !node.props.ref.current) node.props.ref.current = domNode();
    return { ...node, props: { ...(node.props || {}), children: expand(node.props?.children, `${path}:c`) } };
  };
  const findAll = (node, pred, out = [], seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(item => findAll(item, pred, out, seen)); return out; }
    if (node.$$type && pred(node)) out.push(node);
    if (node.props?.children !== undefined) findAll(node.props.children, pred, out, seen);
    return out;
  };
  try {
    const built = await build({
      stdin: { contents: `export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-dv-peek',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'dvpr' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpr' }, () => ({
            contents: `const R = globalThis.__DV_PEEK_REACT__; export default R; export const { Fragment, createElement, cloneElement, isValidElement, Children, memo, forwardRef, Suspense, lazy, createContext, useContext, useState, useReducer, useRef, useId, useDeferredValue, useCallback, useImperativeHandle, useMemo, useEffect, useLayoutEffect, useInsertionEffect, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /^dompurify$/ }, () => ({ path: 'dp', namespace: 'dvpdp' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpdp' }, () => ({ contents: `export default { sanitize: s => s };`, loader: 'js' }));
          builder.onResolve({ filter: /^katex$|^katex\// }, () => ({ path: 'kt', namespace: 'dvpkt' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpkt' }, () => ({ contents: `const k = { renderToString: s => s, __defineMacro: () => {} }; export default k;`, loader: 'js' }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'dvpc' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpc' }, () => ({
            contents: `const R = globalThis.__DV_PEEK_REACT__;
              const tag = el => p => R.createElement(el, p, p.children);
              export const Button = tag('button'); export const IconButton = p => R.createElement('button', { ...p, 'aria-label': p.label });
              export const Icon = p => R.createElement('span', { 'data-icon': p.name }); export const ICON_NAMES = new Set();
              export const IconBox = tag('span'); export const InlineMessage = tag('div'); export const LoadingState = p => R.createElement('div', p, p.label);
              export const SegmentedControl = tag('div'); export const Tooltip = p => R.createElement('span', {}, p.children);
              export const focusQuietly = () => {}; export const Disclosure = tag('div'); export const PANEL_TONES = {};
              export const Banner = tag('div'); export const Hint = tag('div'); export const SetupRequired = tag('div'); export const HelpTip = tag('div');
              export const Panel = tag('div'); export const Dialog = tag('div'); export const useTopDialog = () => false;
              export const ConfirmDialog = tag('div'); export const InlineConfirm = tag('div'); export const Popover = tag('div');
              export const Menu = tag('div'); export const ContextMenu = tag('div'); export const CloseButton = tag('button');
              export const Badge = tag('span'); export const Chip = tag('button'); export const ProgressBar = tag('div');
              export const StackedBar = tag('div'); export const Spinner = tag('span'); export const ErrorState = tag('div');
              export const CrashFallback = tag('div'); export const CopyDiagnosticsButton = tag('button'); export const errorText = e => String(e || '');
              export const EmptyState = tag('div'); export const AddSourceButton = tag('button'); export const addSourceAction = onClick => ({ label: '', icon: '', onClick });
              export const ADD_SOURCE_ICON = 'upload'; export const PageHeader = tag('div'); export const FileDrop = tag('div');
              export const partitionFiles = f => ({ accepted: f, rejected: [] }); export const formatBytes = n => String(n);
              export const describeAccept = () => ''; export const createDropHandlers = () => ({}); export const guardFileDrag = () => {};
              export const ScrollWindow = tag('div'); export const ChunkedRows = tag('div'); export const filterItems = a => a;
              export const scrollWindowCount = () => 0; export const scrollEdges = () => ({}); export const edgeTracker = () => ({});
              export const Field = tag('div'); export const TextInput = tag('input'); export const TextArea = tag('textarea');
              export const Select = tag('select'); export const NumberInput = tag('input'); export const Combobox = tag('div');
              export const flattenOptions = o => o; export const filterEntries = e => e; export const matchRanges = () => [];
              export const highlightParts = t => [{ text: t, hit: false }]; export const resolveActions = a => a;
              export const Checkbox = tag('input'); export const CheckboxInput = tag('input'); export const Switch = tag('button');
              export const RadioCard = tag('div'); export const RadioCardGroup = tag('div'); export const SettingsSection = tag('div');
              export const ProviderCard = tag('div'); export const ProviderGrid = tag('div'); export const StepList = tag('div');
              export const Tabs = tag('div'); export const TabPanel = tag('div'); export const nextTabIndex = () => 0; export const tabIds = () => ({});
              export const DisclosureToggle = tag('button'); export const foldLabel = () => ''; export const JobRow = tag('div');
              export const jobAnnouncement = () => ''; export const useNow = () => Date.now(); export const createClock = () => ({ now: () => Date.now() });
              export const TONES = {}; export const toneOf = () => 'neutral'; export const TONE_ICONS = {}; export const useDismiss = () => {};
              export const useAnchoredPosition = () => ({}); export const computePlacement = () => ({}); export const placeInHost = () => ({});
              export const SecretKeyForm = tag('div'); export const Toast = tag('div'); export const ToastRegion = tag('div');
              export const ToastContext = R.createContext(null); export const shouldAutoDismiss = () => true; export const TOAST_TIMEOUT = 3000;
              export const createToastApi = () => ({ show: () => {}, success: () => {}, info: () => {}, warning: () => {}, error: () => {} });
              export const useToast = () => ({ show: () => {}, success: () => {}, info: () => {}, warning: () => {}, error: () => {} });
              export const useInjectCss = () => {};`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/css\.js$/ }, () => ({ path: 'compcss', namespace: 'dvpcss' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpcss' }, () => ({ contents: `export const useInjectCss = () => {}; export const useComponentCss = () => {};`, loader: 'js' }));
          builder.onResolve({ filter: /app-context\.js$/ }, () => ({ path: 'appctx', namespace: 'dvpa' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpa' }, () => ({ contents: `const R = globalThis.__DV_PEEK_REACT__; export const AppContext = R.createContext({}); export const useApp = () => ({ data: { contexts: [], capabilities: [], settings: {} }, core: {}, host: {}, nav: {}, learn: {}, intents: {}, drafts: {}, dailyPlan: null, selectionNotices: { subscribe: () => () => {} }, settingsEntry: {}, set: {}, session: {} });`, loader: 'js' }));
          builder.onResolve({ filter: /useReadingPosition\.js$/ }, () => ({ path: 'pos', namespace: 'dvpp' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpp' }, () => ({ contents: `export const scrollToNode = () => {}; export const anchorScroll = () => () => {}; export const cancelAnchorScroll = () => {}; export const scrollerScale = () => 1; export const targetRect = () => null; export const useReadingPosition = () => [{ activeId: 'p1', progress: 0 }, () => {}];`, loader: 'js' }));
          builder.onResolve({ filter: /OutlinePanel\.jsx$|PdfOriginal\.jsx$|PagePeek\.jsx$|DocumentLearning\.jsx$/ }, args => ({ path: args.path, namespace: 'dvpcomp' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvpcomp' }, () => ({ contents: `export default () => null;`, loader: 'js' }));
          builder.onResolve({ filter: /useReadingLoop\.jsx$|useReaderMarks\.jsx$|useBilingual\.jsx$|usePassageLinkLayer\.js$|RereadBar\.jsx$/ }, args => ({ path: args.path, namespace: 'dvphook' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvphook' }, args => {
            if (args.path.endsWith('RereadBar.jsx')) return { contents: `export default () => null;`, loader: 'js' };
            if (args.path.endsWith('useReadingLoop.jsx')) return { contents: `export const useReadingLoop = () => ({ status: 'idle', open: false, setOpen: () => {}, cards: [], meters: new Map(), here: () => null, start: () => {}, generateIds: () => [], upgradedIds: new Set(), coverage: null, outlineCoverage: null, resumeNote: null });`, loader: 'js' };
            if (args.path.endsWith('useReaderMarks.jsx')) return { contents: `export const useReaderMarks = () => ({ chip: null, moreItems: [], menu: null, onContextMenu: () => {} });`, loader: 'js' };
            if (args.path.endsWith('useBilingual.jsx')) return { contents: `const useBilingual = () => ({ supported: false, notice: null, displayRow: null, layer: null, dialog: null, openDialog: () => {} }); export default useBilingual; export { useBilingual };`, loader: 'js' };
            return { contents: `export const usePassageLinkLayer = () => {};`, loader: 'js' };
          });
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { DocumentViewer, setUiLanguage } = mod.exports;
    setUiLanguage('zh');

    const pages = [
      { id: 'p1', title: 'Page 1', text: 'First page body.', document: { materialId: 'doc-1', page: 1, totalPages: 2, format: 'pdf', title: 'Book' } },
      { id: 'p2', title: 'Page 2', text: 'Second page body.', document: { materialId: 'doc-1', page: 2, totalPages: 2, format: 'pdf', title: 'Book' } },
    ];
    const doc = { id: 'doc-1', documentId: 'doc-1', revision: 'r1', format: 'pdf', originalAvailable: false, original: { mode: null, status: 'none' }, sources: pages };
    const call = async name => {
      if (name === 'materials.document.get') return doc;
      if (name === 'materials.links.list') return { links: [] };
      if (name === 'materials.annotation.list') return { items: [], stale: [] };
      return {};
    };

    const mountViewer = async initialMode => {
      hooksByPath.clear();
      const props = { source: pages[0], call, data: { sources: pages, root: 'r', contexts: [], capabilities: [] }, initialMode };
      const renderTree = () => {
        pendingEffects = [];
        const tree = expand(hLocal(DocumentViewer, props), 'root');
        pendingEffects.splice(0).forEach(fn => fn());
        return tree;
      };
      renderTree();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      return { renderTree, tree: renderTree() };
    };

    // 阅读 view: ReadingSections gets onPeek, clicking opens ONE PagePeek and re-clicking updates it without duplicating.
    const clickEvent = () => ({ currentTarget: {}, stopPropagation() {}, preventDefault() {} });
    const readView = await mountViewer('read');
    const readPeekBtns = findAll(readView.tree, n => n.props?.['data-peek-page'] != null);
    assert.deepEqual(readPeekBtns.map(b => b.props['data-peek-page']), [1, 2], '阅读 view renders 看原页 buttons via onPeek');
    assert.equal(findAll(readView.tree, n => n.props?.['data-comp'] === 'PagePeek').length, 0, 'closed before clicking');
    readPeekBtns[1].props.onClick(clickEvent());
    let peeks = findAll(readView.renderTree(), n => n.props?.['data-comp'] === 'PagePeek');
    assert.equal(peeks.length, 1, 'ONE PagePeek mount');
    assert.equal(peeks[0].props.page, 2);
    readPeekBtns[0].props.onClick(clickEvent());
    peeks = findAll(readView.renderTree(), n => n.props?.['data-comp'] === 'PagePeek');
    assert.equal(peeks.length, 1, 'switching peek page still mounts ONE PagePeek');
    assert.equal(peeks[0].props.page, 1);
    peeks[0].props.onClose();
    assert.equal(findAll(readView.renderTree(), n => n.props?.['data-comp'] === 'PagePeek').length, 0, 'closing unmounts it');

    // 原文 view: page sections carry the same data-peek-page buttons and open the same single PagePeek.
    const textView = await mountViewer('text');
    const textPeekBtns = findAll(textView.tree, n => n.props?.['data-peek-page'] != null);
    assert.deepEqual(textPeekBtns.map(b => b.props['data-peek-page']), [1, 2], '原文 view page labels carry data-peek-page buttons too');
    textPeekBtns[1].props.onClick(clickEvent());
    const textPeeks = findAll(textView.renderTree(), n => n.props?.['data-comp'] === 'PagePeek');
    assert.equal(textPeeks.length, 1, 'ONE PagePeek mount from 原文 view');
    assert.equal(textPeeks[0].props.page, 2);
  } finally {
    delete globalThis.__DV_PEEK_REACT__;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLS;
  }
});

/* ---------- moving and resizing the panel ---------- */

test('the panel stays inside the window while it is moved, and a corner grip moves exactly the edges it sits on', () => {
  const { clampTo, moveBox, resizeBox, PEEK_MIN } = lib;
  const win = { width: 1000, height: 800 };
  assert.equal(clampTo(5, 8, 100), 8);
  assert.equal(clampTo(500, 8, 100), 100);
  assert.equal(clampTo(50, 8, 100), 50);
  const box = { left: 420, top: 100, width: 560, height: 600 };
  // moved far right and down: held 8 px inside, the title bar always reachable
  assert.deepEqual(moveBox(box, 900, 900, win), { ...box, left: 1000 - 8 - 560, top: 800 - 40 });
  assert.deepEqual(moveBox(box, -900, -900, win), { ...box, left: 8, top: 8 });
  // bottom-right grip: the top-left corner stays, the box grows towards the cursor, never past the window
  assert.deepEqual(resizeBox('se', 10, 40, box, win), { left: 420, top: 100, width: 570, height: 640 });
  assert.deepEqual(resizeBox('se', 400, 400, box, win), { left: 420, top: 100, width: 1000 - 8 - 420, height: 800 - 8 - 100 });
  // top-left grip: the bottom-right corner stays; dragging up/left grows the box, which is the only way a bottom-right docked panel can grow
  const grown = resizeBox('nw', -100, -150, box, win);
  assert.equal(grown.left + grown.width, 980, 'the right edge did not move');
  assert.equal(grown.top + grown.height, 700, 'the bottom edge did not move');
  assert.ok(grown.top >= 8 && grown.left >= 8);
  // never smaller than the minimum
  const small = resizeBox('se', -5000, -5000, box, win);
  assert.deepEqual([small.width, small.height], [PEEK_MIN.width, PEEK_MIN.height]);
  const smallNw = resizeBox('nw', 5000, 5000, box, win);
  assert.deepEqual([smallNw.width, smallNw.height], [PEEK_MIN.width, PEEK_MIN.height]);
  assert.equal(smallNw.left + smallNw.width, 980);
});

test('the panel no longer uses the browser\'s own resize corner, which sat on the scrollbars and moved the wrong way when docked bottom-right', () => {
  const { declarations } = parseCss(readFileSync(new URL('../ui/document-preview/peek/peek.css', import.meta.url), 'utf8'));
  assert.equal(declarations.some(d => d.prop === 'resize' && /\bboth\b/.test(d.value)), false, 'no native resize: both corner');
  assert.equal(declarations.some(d => /\.page-peek__grip--nw\b/.test(d.ctx.at(-1)) && d.prop === 'cursor'), true, 'top-left grip styled');
  assert.equal(declarations.some(d => /\.page-peek__grip--se\b/.test(d.ctx.at(-1)) && d.prop === 'cursor'), true, 'bottom-right grip styled');
  assert.equal(
    declarations.some(d => /\.page-peek__scroll\[data-fit=['"]true['"]\]/.test(d.ctx.at(-1)) && d.prop === 'overflow-x' && d.value === 'hidden'),
    true,
    'fitted to the width there is no sideways bar',
  );
  // Real rendered PagePeekView markup: both grips appear when ready, absent while loading, and data-fit tracks zoom === 1.
  const readyFit = view({ phase: 'ready', zoom: 1 });
  assert.match(readyFit, /class="page-peek__grip page-peek__grip--nw"/);
  assert.match(readyFit, /class="page-peek__grip page-peek__grip--se"/);
  assert.match(readyFit, /class="page-peek__scroll"[^>]*data-fit="true"/);
  assert.match(view({ phase: 'ready', zoom: 1.5 }), /class="page-peek__scroll"[^>]*data-fit="false"/);
  assert.doesNotMatch(view({ phase: 'loading' }), /page-peek__grip/);
});

test('the single-page PDF budget counts CPU render work only (not asset downloads, hidden tabs or manual opt-in), and its fallback notice is translated', () => {
  assert.equal(TURN_COALESCE_MS, 160);
  assert.equal(SLOW_PAGE_MS, 1200);
  assert.equal(exceedsPageBudget({ elapsedMs: 600 }), false);
  assert.equal(exceedsPageBudget({ elapsedMs: 1200 }), true);
  assert.equal(exceedsPageBudget({ elapsedMs: 1800, assetMs: 1000 }), false, 'chunk download time is excluded');
  assert.equal(exceedsPageBudget({ elapsedMs: 2300, assetMs: 1000 }), true, 'remaining CPU time still exceeds budget');
  assert.equal(exceedsPageBudget({ elapsedMs: 5000, hidden: true }), false, 'background-tab throttling is not a slow file');
  assert.equal(exceedsPageBudget({ elapsedMs: 5000, budgetMs: Infinity }), false, 'manual opt-in disables the auto-switch');

  const slowZh = renderToStaticMarkup(h(lib.PdfOriginal, {
    fileUrl: 'blob:test', title: 'Scan.pdf', page: 4, total: 20, onPage: noop,
    settings: { zoom: 1, native: true, slow: true }, onSettings: noop,
  }));
  assert.match(text(slowZh), /这份文件单页绘制太慢，已换成浏览器的查看器，避免翻页卡顿。/);
  assert.match(slowZh, /回到单页视图/, 'manual toggle back to single-page view stays available');
  assert.match(slowZh, /<iframe[^>]*src="blob:test#page=4"/);

  inLanguage('en', () => {
    const slowEn = renderToStaticMarkup(h(lib.PdfOriginal, {
      fileUrl: 'blob:test', title: 'Scan.pdf', page: 4, total: 20, onPage: noop,
      settings: { zoom: 1, native: true, slow: true }, onSettings: noop,
    }));
    assert.match(text(slowEn), /This file draws too slowly here, so the browser’s viewer is shown instead to keep page turns responsive\./);
    assert.match(slowEn, /Back to the single-page view/);
    assert.doesNotMatch(text(slowEn), han);
    for (const attribute of slowEn.match(/aria-label="[^"]*"|title="[^"]*"/g) || []) assert.doesNotMatch(attribute, han, attribute);
  });
});

test('#55 PagePeek and PagePeekView support ArrowLeft/ArrowRight paging at fit zoom, Ctrl/Meta wheel zoom, and canvas double-click toggle', async () => {
  const hooks = []; let cursor = 0, tree = null;
  const hLocal = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: hLocal,
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useCallback(fn) { return fn; },
    useEffect() {},
    useLayoutEffect() {},
    useSyncExternalStore(_sub, snap) { return snap(); },
  };
  reactShim.default = reactShim;
  globalThis.__PEEK_TEST_REACT__ = reactShim;
  try {
    const built = await build({
      stdin: { contents: `export { default as PagePeek } from './ui/document-preview/peek/PagePeek.jsx'; export { default as PagePeekView } from './ui/document-preview/peek/PagePeekView.jsx';`, resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-peek',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'pr' }));
          builder.onLoad({ filter: /.*/, namespace: 'pr' }, () => ({
            contents: `const R = globalThis.__PEEK_TEST_REACT__; export default R; export const { Fragment, createElement, useState, useRef, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'pc' }));
          builder.onLoad({ filter: /.*/, namespace: 'pc' }, () => ({
            contents: `const R = globalThis.__PEEK_TEST_REACT__; export const Button = p => R.createElement('button', p); export const CloseButton = p => R.createElement('button', p); export const IconButton = p => R.createElement('button', p); export const LoadingState = p => R.createElement('div', p);`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /renderer\.js$/ }, () => ({ path: 'renderer', namespace: 'prd' }));
          builder.onLoad({ filter: /.*/, namespace: 'prd' }, () => ({
            contents: `export const createPeekRenderer = () => ({ pages: 10, destroy() {} }); export const isCancelled = () => false; export const openPdf = async () => ({ pages: 10, destroy() {} });`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /shared\.js$/ }, () => ({ path: 'shared', namespace: 'psh' }));
          builder.onLoad({ filter: /.*/, namespace: 'psh' }, () => ({ contents: `export const useInjectCss = () => {}; export const focusVisible = () => {};`, loader: 'js' }));
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { PagePeek, PagePeekView } = mod.exports;
    const expandNode = node => {
      if (Array.isArray(node)) return node.map(expandNode);
      if (!node || typeof node !== 'object') return node;
      if (typeof node.$$type === 'function') return expandNode(node.$$type(node.props));
      return node.props?.children ? { ...node, props: { ...node.props, children: expandNode(node.props.children) } } : node;
    };
    const renderPeek = (props = { fileUrl: 'blob:test', page: 3, totalPages: 10, onClose: noop }) => {
      cursor = 0; tree = expandNode(PagePeek(props)); return tree;
    };
    const find = (pred, node = tree) => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const c of node) { const hit = find(pred, c); if (hit) return hit; } return null; }
      if (pred(node)) return node;
      return node.props?.children ? find(pred, node.props.children) : null;
    };

    // Direct PagePeekView checks: double-click zoom/fit and Ctrl/Meta wheel handler.
    const zoomed = []; let fitted = 0, viewPrevented = 0;
    const viewAtFit = expandNode(PagePeekView({ ...base, phase: 'ready', zoom: 1, onZoom: d => zoomed.push(d), onFit: () => { fitted += 1; } }));
    find(n => n.$$type === 'canvas', viewAtFit).props.onDoubleClick();
    assert.deepEqual(zoomed, [2]);
    const viewZoomed = expandNode(PagePeekView({ ...base, phase: 'ready', zoom: 1.5, onZoom: d => zoomed.push(d), onFit: () => { fitted += 1; } }));
    find(n => n.$$type === 'canvas', viewZoomed).props.onDoubleClick();
    assert.equal(fitted, 1);
    const scroller = find(n => n.props?.className === 'page-peek__scroll', viewAtFit);
    scroller.props.onWheel({ ctrlKey: true, metaKey: false, deltaY: -100, preventDefault: () => { viewPrevented += 1; } });
    scroller.props.onWheel({ ctrlKey: false, metaKey: true, deltaY: 100, preventDefault: () => { viewPrevented += 1; } });
    scroller.props.onWheel({ ctrlKey: false, metaKey: false, deltaY: -100, preventDefault: () => { viewPrevented += 1; } });
    assert.deepEqual(zoomed, [2, 1, -1]);
    assert.equal(viewPrevented, 2);

    renderPeek();
    const viewProps = () => find(n => n.props?.className === 'page-peek').props;
    let prevented = 0;
    const key = name => ({ key: name, preventDefault: () => { prevented += 1; }, stopPropagation() {} });
    // Force phase='ready' hook state so PagePeekView receives active paging/zoom handlers.
    hooks[0] = 'ready';
    renderPeek();
    viewProps().onKeyDown(key('ArrowRight'));
    renderPeek();
    assert.equal(find(n => n.props?.className === 'page-peek__where').props.children, '第 4 / 10 页');
    viewProps().onKeyDown(key('ArrowLeft'));
    renderPeek();
    assert.equal(find(n => n.props?.className === 'page-peek__where').props.children, '第 3 / 10 页');
    assert.equal(prevented, 2);

    // Wheel zoom in -> zoom becomes 1.5, so ArrowRight should no longer page-turn.
    find(n => n.props?.className === 'page-peek__scroll').props.onWheel({ ctrlKey: true, metaKey: false, deltaY: -120, preventDefault: () => { prevented += 1; } });
    renderPeek();
    assert.equal(find(n => n.props?.className === 'page-peek__zoom').props.children.join(''), '150%');
    viewProps().onKeyDown(key('ArrowRight'));
    renderPeek();
    assert.equal(find(n => n.props?.className === 'page-peek__where').props.children, '第 3 / 10 页', 'zoomed in: arrow keys pan rather than paging');

    // Canvas double-click while zoomed fits back to 100%, then double-clicking again zooms in to 150%.
    find(n => n.props?.className === 'page-peek__canvas').props.onDoubleClick();
    renderPeek();
    assert.equal(find(n => n.props?.className === 'page-peek__zoom').props.children.join(''), '100%');
    find(n => n.props?.className === 'page-peek__canvas').props.onDoubleClick();
    renderPeek();
    assert.equal(find(n => n.props?.className === 'page-peek__zoom').props.children.join(''), '150%');
  } finally {
    delete globalThis.__PEEK_TEST_REACT__;
  }
});
