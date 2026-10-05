import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { uiFormat, errorMessage } from '../../i18n.js';
import PagePeekView from './PagePeekView.jsx';
import { createPeekRenderer } from './renderer.js';
import { LruCache, MAX_CACHED_PAGES, clampTo, createRenderGate, moveBox, pdfPageFor, peekCanvasSize, peekPlan, resizeBox, stepZoom } from './peek-logic.js';

const bitmapKey = (pdfPage, quality, scale) => quality === 'low' ? `${pdfPage}:low` : `${pdfPage}:s${Math.round(scale * 100)}`;
const closeBitmap = bitmap => { try { bitmap.close?.(); } catch { /* already closed */ } };

/**
 * The panel for the reader. page: the text page it was opened at; figure: opened from a figure placeholder. status: peekStatus(document);
 * totalPages / offset / windowed: what the text says about its pages (pdfPageFor); loadBytes(): the original's bytes as a Uint8Array (the
 * viewer already has them; null when they are gone); openRenderer(bytes): renderer.js's createPeekRenderer (injectable for tests);
 * onAttach(kind): the 补全原文件 dialog; onShowOriginal(pdfPage): switch the viewer to its 原始 PDF tab at that page (offered when a page's images did not decode); onClose().
 */
export default function PagePeek({ page, figure = false, totalPages = 0, offset = 0, windowed = false, status, loadBytes, openRenderer, onAttach, onShowOriginal, onClose }) {
  const [phase, setPhase] = useState(status?.kind === 'ok' ? 'loading' : 'none'), [current, setCurrent] = useState(page), [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState(''), [mismatch, setMismatch] = useState(null), [busy, setBusy] = useState(false), [tries, setTries] = useState(0), [fitKey, setFitKey] = useState(0), [undecoded, setUndecoded] = useState(0);
  const panel = useRef(null), canvas = useRef(null), scroller = useRef(null), renderer = useRef(null), drag = useRef(null);
  const gate = useRef(null), cache = useRef(null), opener = useRef(null), rect = useRef(null), stats = useRef({ renders: 0, hits: 0 });
  // How many images of each page pdf.js could not decode (renderer.js reports it), and the PDF page now shown: a scan whose decoder is missing must not look like a blank page.
  const undecodedPages = useRef(new Map()), shownPage = useRef(0);
  // What the panel did, as data attributes (the browser QA reads them): pages drawn, pages served from the cache, bitmaps and bytes kept.
  const note = () => {
    const area = panel.current; if (!area) return;
    area.dataset.renders = stats.current.renders; area.dataset.cacheHits = stats.current.hits; area.dataset.cached = cache.current.size;
    area.dataset.cacheBytes = [...cache.current.keys()].reduce((sum, key) => { const bitmap = cache.current.peek(key); return sum + (bitmap ? bitmap.width * bitmap.height * 4 : 0); }, 0);
  };
  const total = Math.max(totalPages, renderer.current?.numPages || 0, current);
  gate.current ||= createRenderGate();
  cache.current ||= new LruCache(MAX_CACHED_PAGES, closeBitmap);

  // Open the document once; everything is released when the panel goes away.
  useEffect(() => {
    opener.current = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    let live = true;
    const run = gate.current, bitmaps = cache.current;
    (async () => {
      if (status?.kind !== 'ok') return;
      try {
        const bytes = await loadBytes();
        if (!live) return;
        if (!bytes) { setPhase('none'); return; }
        const opened = await (openRenderer || createPeekRenderer)(bytes);
        if (!live) { opened.destroy(); return; }
        renderer.current = opened;
        if (!windowed && totalPages > 0 && opened.numPages !== totalPages) { setMismatch({ totalPages, pdfPages: opened.numPages }); setPhase('mismatch'); return; }
        setPhase('ready');
      } catch (failure) { if (live) { setMessage(errorMessage(failure)); setPhase('error'); } }
    })();
    return () => {
      live = false;
      run.cancelAll(); bitmaps.clear();
      renderer.current?.destroy(); renderer.current = null;
      const shown = canvas.current; // eslint-disable-line react-hooks/exhaustive-deps -- the canvas as it is when the panel closes
      if (shown) { shown.width = 0; shown.height = 0; }
      const back = opener.current;
      if (back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- one document per panel

  // Draw the page: from the cache when it is there, else small first and then sharp. A newer request (page, zoom, size) cancels this one.
  useEffect(() => {
    if (phase !== 'ready' || !renderer.current || !canvas.current || !scroller.current) return undefined;
    const mapped = pdfPageFor({ page: current, totalPages, pdfPages: renderer.current.numPages, offset, window: windowed });
    if (!mapped.ok) { setMessage(uiFormat('原文件里没有第 {0} 页', [current])); setPhase('error'); return undefined; }
    const turn = gate.current.begin(), pdfPage = mapped.pdfPage, target = canvas.current, area = scroller.current;
    shownPage.current = pdfPage;
    setUndecoded(undecodedPages.current.get(pdfPage) || 0);
    setBusy(true);
    (async () => {
      try {
        const unit = await renderer.current.pageSize(pdfPage);
        if (!turn.current()) return;
        const fit = Math.max(0.1, (area.clientWidth - 2) / unit.width), dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = unit.width * fit * zoom;
        target.style.width = `${Math.round(cssWidth)}px`; target.style.height = `${Math.round(cssWidth * unit.height / unit.width)}px`;
        const sharpSize = peekCanvasSize({ width: unit.width, height: unit.height, scale: fit * zoom * dpr });
        const sharpKey = bitmapKey(pdfPage, 'sharp', sharpSize.scale), lowKey = bitmapKey(pdfPage, 'low');
        const show = bitmap => { if (!bitmap || !turn.current()) return; target.width = bitmap.width; target.height = bitmap.height; target.getContext('2d').drawImage(bitmap, 0, 0); };
        const hit = cache.current.get(sharpKey);
        if (hit) stats.current.hits += 1;
        show(hit || cache.current.get(lowKey));
        note();
        for (const step of peekPlan({ fitScale: fit, zoom, dpr, cached: { low: cache.current.has(lowKey), sharp: cache.current.has(sharpKey) } })) {
          const bitmap = await renderer.current.render(pdfPage, { scale: step.scale, signal: turn.signal, onReport: report => { if (!turn.current()) return; undecodedPages.current.set(pdfPage, report.undecoded); setUndecoded(report.undecoded); } });
          if (!turn.current()) { closeBitmap(bitmap); return; }
          stats.current.renders += 1;
          cache.current.set(step.quality === 'low' ? lowKey : sharpKey, bitmap);
          show(bitmap);
          note();
        }
      } catch (failure) {
        if (turn.current() && failure?.name !== 'RenderingCancelledException' && failure?.name !== 'AbortError' && failure?.name !== 'AbortException') { setMessage(errorMessage(failure)); setPhase('error'); }
      } finally { if (turn.current()) setBusy(false); }
    })();
    return () => gate.current?.cancelAll();
  }, [phase, current, zoom, tries, fitKey, totalPages, offset, windowed]);

  // The panel can be resized by hand: draw again at the new width once it settles.
  useEffect(() => {
    const area = scroller.current;
    if (phase !== 'ready' || !area || typeof ResizeObserver === 'undefined') return undefined;
    let timer = 0, width = area.clientWidth;
    const watch = new ResizeObserver(() => { if (Math.abs(area.clientWidth - width) < 24) return; width = area.clientWidth; clearTimeout(timer); timer = setTimeout(() => setFitKey(key => key + 1), 200); });
    watch.observe(area);
    return () => { clearTimeout(timer); watch.disconnect(); };
  }, [phase]);

  const go = useCallback(delta => setCurrent(value => Math.min(Math.max(1, value + delta), total || value + delta)), [total]);
  const zoomBy = direction => setZoom(value => stepZoom(value, direction));
  const fit = () => { setZoom(1); scroller.current?.scrollTo?.({ top: 0, left: 0 }); };
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.target?.matches?.('input, textarea, select')) return;
    if (event.key === 'PageUp') { event.preventDefault(); go(-1); }
    else if (event.key === 'PageDown') { event.preventDefault(); go(1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1); }
    else if (event.key === '-') { event.preventDefault(); zoomBy(-1); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
  };
  /* The panel's box is plain left/top/width/height (set once it is showing a page, from where it sits), so every handle moves exactly what it is
     dragged on: the title moves the box, the corner grips resize it (the bottom-right one keeps the top-left still, the top-left one keeps the
     bottom-right still, because the panel starts docked in the bottom-right corner and can only grow towards the top-left). Always inside the window. */
  const win = () => ({ width: window.innerWidth, height: window.innerHeight });
  const apply = useCallback(() => {
    const element = panel.current, box = rect.current;
    if (!element) return;
    if (!box || phase !== 'ready') { for (const name of ['left', 'top', 'width', 'height', 'right', 'bottom']) element.style[name] = ''; return; }
    Object.assign(element.style, { left: `${Math.round(box.left)}px`, top: `${Math.round(box.top)}px`, width: `${Math.round(box.width)}px`, height: `${Math.round(box.height)}px`, right: 'auto', bottom: 'auto' });
  }, [phase]);
  useLayoutEffect(() => {
    const element = panel.current;
    if (phase === 'ready' && element && !rect.current) { const box = element.getBoundingClientRect(); rect.current = { left: box.left, top: box.top, width: box.width, height: box.height }; }
    apply();
  }, [phase, apply]);
  useEffect(() => {
    // The window got smaller: pull the box back inside it.
    const inside = () => { const box = rect.current; if (!box) return; const width = Math.min(box.width, window.innerWidth - 16), height = Math.min(box.height, window.innerHeight - 16); rect.current = { width, height, left: clampTo(box.left, 8, window.innerWidth - 8 - width), top: clampTo(box.top, 8, window.innerHeight - 8 - height) }; apply(); };
    window.addEventListener('resize', inside);
    return () => window.removeEventListener('resize', inside);
  }, [apply]);
  const track = (event, onMove) => {
    const stop = () => { drag.current = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
    drag.current = true;
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
    event.preventDefault();
  };
  // Dragging the title moves the panel; the buttons in it still click.
  const onDragStart = event => {
    if (event.button !== 0 || event.target.closest('button, output') || !rect.current) return;
    const from = { ...rect.current }, x = event.clientX, y = event.clientY;
    track(event, at => { rect.current = moveBox(from, at.clientX - x, at.clientY - y, win()); apply(); });
  };
  const onResizeStart = corner => event => {
    if (event.button !== 0 || !rect.current) return;
    event.stopPropagation();
    const from = { ...rect.current }, x = event.clientX, y = event.clientY;
    track(event, at => { rect.current = resizeBox(corner, at.clientX - x, at.clientY - y, from, win()); apply(); });
  };
  const onGripKey = corner => event => {
    const step = event.shiftKey ? 64 : 24, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!move || !rect.current) return;
    event.preventDefault(); event.stopPropagation();
    rect.current = resizeBox(corner, move[0], move[1], rect.current, win()); apply();
  };
  return <PagePeekView phase={phase} page={current} total={total} zoom={zoom} figure={figure} busy={busy} message={message} mismatch={mismatch} issue={status} undecoded={undecoded}
    panelRef={panel} canvasRef={canvas} scrollRef={scroller} onClose={onClose} onPrev={() => go(-1)} onNext={() => go(1)} onZoom={zoomBy} onFit={fit}
    onAttach={onAttach} onShowOriginal={onShowOriginal ? () => onShowOriginal(shownPage.current) : undefined} onRetry={() => { setPhase('ready'); setTries(count => count + 1); }} onDragStart={onDragStart} onResizeStart={onResizeStart} onGripKey={onGripKey} onKeyDown={onKeyDown} />;
}
