import React, { useEffect, useRef, useState } from 'react';
import { ui, errorMessage } from '../../i18n.js';
import { useLiveEffect } from '../../use-async.js';
import { LoadingState } from '../../components/index.js';
import { clampPage } from '../page-scope.js';
import { createPeekRenderer, isCancelled } from './renderer.js';
import { LruCache, MAX_CACHED_PAGES, SLOW_PAGE_MS, TURN_COALESCE_MS, createRenderGate, exceedsPageBudget, pdfPageFor, peekCanvasSize } from './peek-logic.js';

const closeBitmap = bitmap => { try { bitmap.close?.(); } catch { /* already closed */ } };
const keyOf = (page, scale) => `${page}:s${Math.round(scale * 100)}`;
const isHiddenDocument = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Render one page within `budgetMs` (excluding async asset chunk downloads); cancels and reports `'slow'` when it stalls or exceeds budget. */
async function renderWithinBudget(opened, page, scale, { turn, gate, budgetMs, setStallTimer }) {
  const hiddenAtStart = isHiddenDocument();
  const enforce = Number.isFinite(budgetMs) && budgetMs > 0 && !hiddenAtStart;
  const startedAt = performance.now(), assetStart = opened.assetStats?.().totalMs || 0;
  let timedOut = false, resolveStall;
  const stallOutcome = new Promise(resolve => { resolveStall = resolve; });
  const arm = remaining => setStallTimer(setTimeout(() => {
    if (!turn.current() || isHiddenDocument()) return;
    const stats = opened.assetStats?.() || { totalMs: 0, active: 0 };
    const cpuElapsed = Math.max(0, performance.now() - startedAt - Math.max(0, stats.totalMs - assetStart));
    if (stats.active > 0 || cpuElapsed < budgetMs - 10) { arm(Math.max(25, budgetMs - cpuElapsed)); return; }
    timedOut = true;
    gate.cancelAll();
    resolveStall({ status: 'slow' });
  }, remaining));
  if (enforce) arm(budgetMs);
  let undecoded = 0;
  const rawRender = opened.render(page, { scale, signal: turn.signal, onReport: report => { undecoded = report.undecoded; } });
  rawRender.then(bitmap => { if (timedOut) closeBitmap(bitmap); }, () => {});
  try {
    const raced = await Promise.race([rawRender.then(bitmap => ({ status: 'done', bitmap })), stallOutcome]);
    if (raced.status === 'slow' || timedOut) return { status: 'slow' };
    const { bitmap } = raced;
    if (!turn.current()) { closeBitmap(bitmap); return { status: 'cancelled' }; }
    if (undecoded) { closeBitmap(bitmap); return { status: 'undecoded' }; }
    const assetSpent = Math.max(0, (opened.assetStats?.().totalMs || 0) - assetStart);
    if (exceedsPageBudget({ elapsedMs: performance.now() - startedAt, assetMs: assetSpent, budgetMs, hidden: hiddenAtStart || isHiddenDocument() })) {
      closeBitmap(bitmap);
      return { status: 'slow' };
    }
    return { status: 'ok', bitmap };
  } catch (failure) {
    if (timedOut) return { status: 'slow' };
    throw failure;
  } finally { setStallTimer(0); }
}

/*
 * 原始 PDF, one page at a time (#488, item 3). The browser's PDF viewer ignores a later change of #page= (checked again in Chromium), so turning the page there meant a new
 * frame: the file read again, its zoom and place lost. Here the file is opened once with the peek's pdf.js (the same lazy chunk, loaded when this view is first opened, never
 * with the reader) and only the page changes: the zoom is the viewer's (`zoom`, 1 = fit to the width), the sideways place stays, a new page starts at its top, and the page
 * shown is always the page the panel asks about. The text layer keeps the words selectable. Rapid page turns coalesce onto the latest target page so intermediate pages are
 * never drawn one by one. Heavy scanned pages that exceed `budgetMs` on the main thread (or stall) call `onSlow()`, and files that cannot be drawn truly call `onFail()`.
 */
export default function PdfPageView({ loadBytes, page, totalPages = 0, zoom = 1, budgetMs = SLOW_PAGE_MS, coalesceMs = TURN_COALESCE_MS, openRenderer, onPage, onSlow, onFail }) {
  const [ready, setReady] = useState(false), [fitKey, setFitKey] = useState(0);
  const area = useRef(null), canvas = useRef(null), textLayer = useRef(null), renderer = useRef(null);
  const callbacks = useRef({ onFail, onSlow });
  callbacks.current = { onFail, onSlow };
  const gate = useRef(null), cache = useRef(null), lastPage = useRef(page), drawn = useRef(false), inFlight = useRef(null), wantedPage = useRef(page);
  gate.current ||= createRenderGate();
  cache.current ||= new LruCache(MAX_CACHED_PAGES, closeBitmap);
  useEffect(() => { wantedPage.current = page; }, [page]);

  // The file is opened once and let go with the view.
  useLiveEffect((isLive) => {
    const bitmaps = cache.current, run = gate.current;
    (async () => {
      try {
        const bytes = await loadBytes();
        if (!isLive()) return;
        if (!bytes) { callbacks.current.onFail?.(); return; }
        const opened = await (openRenderer || createPeekRenderer)(bytes);
        if (!isLive()) { opened.destroy(); return; }
        renderer.current = opened;
        if (!pdfPageFor({ page: 1, totalPages, pdfPages: opened.numPages }).ok) { callbacks.current.onFail?.(); return; }
        setReady(true);
      } catch (failure) { if (isLive()) { console.warn('PDF page view:', errorMessage(failure)); callbacks.current.onFail?.(); } }
    })();
    return () => { run.cancelAll(); bitmaps.clear(); renderer.current?.destroy(); renderer.current = null; };
  }, []); // one file per view; the caller keys it by the file

  // Draw the page in a single sharp pass: cached pages show at once; rapid uncached page turns coalesce onto the latest page.
  useEffect(() => {
    const scroller = area.current, target = canvas.current, words = textLayer.current;
    if (!ready || !renderer.current || !scroller || !target || !words) return undefined;
    if (!pdfPageFor({ page, totalPages, pdfPages: renderer.current.numPages }).ok) { callbacks.current.onFail?.(); return undefined; }
    const turn = gate.current.begin();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fitOf = unit => Math.max(0.1, (scroller.clientWidth - 2) / unit.width);
    const showPage = async (unit, css, bitmap) => {
      target.style.width = `${Math.round(unit.width * css)}px`; target.style.height = `${Math.round(unit.height * css)}px`;
      const box = target.parentElement; box.style.width = target.style.width; box.style.height = target.style.height;
      if (lastPage.current !== page) scroller.scrollTop = 0;
      target.width = bitmap.width; target.height = bitmap.height;
      target.getContext('2d').drawImage(bitmap, 0, 0);
      drawn.current = true;
      await renderer.current.textLayer(page, { scale: css, container: words, signal: turn.signal, current: turn.current })
        .catch(failure => { if (turn.current()) words.replaceChildren(); if (isCancelled(failure)) throw failure; return null; });
      if (!turn.current()) return;
      lastPage.current = page;
      const next = String(page);
      if (scroller.dataset.pdfPage !== next) scroller.dataset.pdfPage = next;
    };

    // A page already in the 6-bitmap LRU cache shows immediately without waiting for the coalesce window.
    const knownUnit = renderer.current.cachedPageSize?.(page);
    const knownCss = knownUnit ? fitOf(knownUnit) * zoom : 0;
    const cached = knownUnit ? cache.current.get(keyOf(page, peekCanvasSize({ width: knownUnit.width, height: knownUnit.height, scale: knownCss * dpr }).scale)) : null;
    let waitTimer = 0, stallTimer = 0;
    const setStallTimer = next => { clearTimeout(stallTimer); stallTimer = next; };
    if (cached) {
      showPage(knownUnit, knownCss, cached).catch(() => {});
      return () => { gate.current?.cancelAll(); };
    }

    const runRender = async () => {
      if (inFlight.current) await inFlight.current.catch(() => {});
      if (!turn.current() || !renderer.current) return;
      const job = (async () => {
        try {
          const unit = await renderer.current.pageSize(page);
          if (!turn.current() || !renderer.current) return;
          const css = fitOf(unit) * zoom;
          const sharp = peekCanvasSize({ width: unit.width, height: unit.height, scale: css * dpr });
          const sharpKey = keyOf(page, sharp.scale);
          const hit = cache.current.get(sharpKey);
          if (hit) { await showPage(unit, css, hit); return; }
          const outcome = await renderWithinBudget(renderer.current, page, sharp.scale, { turn, gate: gate.current, budgetMs, setStallTimer });
          if (outcome.status === 'slow') { callbacks.current.onSlow?.(); return; }
          if (outcome.status === 'undecoded') { callbacks.current.onFail?.(); return; }
          if (outcome.status !== 'ok') return;
          cache.current.set(sharpKey, outcome.bitmap);
          await showPage(unit, css, outcome.bitmap);
        } catch (failure) {
          if (turn.current() && !isCancelled(failure)) { console.warn('PDF page view:', errorMessage(failure)); callbacks.current.onFail?.(); }
        }
      })();
      inFlight.current = job;
      await job;
      if (inFlight.current === job) inFlight.current = null;
    };

    const delay = drawn.current && coalesceMs > 0 ? coalesceMs : 0;
    if (delay > 0) waitTimer = setTimeout(runRender, delay);
    else runRender();
    return () => { clearTimeout(waitTimer); clearTimeout(stallTimer); gate.current?.cancelAll(); };
  }, [ready, page, zoom, fitKey, totalPages, budgetMs, coalesceMs]);

  // The reader's width changed (the panel opened, the window moved): draw again once it settles.
  useEffect(() => {
    const scroller = area.current;
    if (!ready || !scroller || typeof ResizeObserver === 'undefined') return undefined;
    let timer = 0, width = scroller.clientWidth;
    const watch = new ResizeObserver(() => { if (Math.abs(scroller.clientWidth - width) < 24) return; width = scroller.clientWidth; clearTimeout(timer); timer = setTimeout(() => setFitKey(key => key + 1), 200); });
    watch.observe(scroller);
    return () => { clearTimeout(timer); watch.disconnect(); };
  }, [ready]);

  const stepPage = delta => {
    const next = clampPage(wantedPage.current + delta, totalPages);
    if (next === null || next === wantedPage.current) return;
    wantedPage.current = next;
    onPage?.(next);
  };
  const onKeyDown = event => {
    if (event.key === 'PageUp') { event.preventDefault(); stepPage(-1); }
    else if (event.key === 'PageDown') { event.preventDefault(); stepPage(1); }
  };
  return <div className="reader-pdf-view" ref={area} tabIndex={0} role="region" aria-label={ui('原始 PDF')} data-pdf-page={lastPage.current} onKeyDown={onKeyDown}>
    {!ready && <LoadingState label={ui('正在打开资料…')} />}
    <div className="reader-pdf-sheet" hidden={!ready}>
      <canvas ref={canvas} aria-hidden="true" />
      <div className="reader-pdf-text" ref={textLayer} />
    </div>
  </div>;
}
