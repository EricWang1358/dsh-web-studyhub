import React, { useCallback, useEffect, useRef, useState } from 'react';
import { uiFormat } from '../../i18n.js';
import PagePeekView from './PagePeekView.jsx';
import { createPeekRenderer } from './renderer.js';
import { LruCache, MAX_CACHED_PAGES, createRenderGate, pdfPageFor, peekCanvasSize, peekPlan, stepZoom } from './peek-logic.js';

const bitmapKey = (pdfPage, quality, scale) => quality === 'low' ? `${pdfPage}:low` : `${pdfPage}:s${Math.round(scale * 100)}`;
const closeBitmap = bitmap => { try { bitmap.close?.(); } catch { /* already closed */ } };

/**
 * The panel for the reader. page: the text page it was opened at; figure: opened from a figure placeholder. status: peekStatus(document);
 * totalPages / offset / windowed: what the text says about its pages (pdfPageFor); loadBytes(): the original's bytes as a Uint8Array (the
 * viewer already has them; null when they are gone); openRenderer(bytes): renderer.js's createPeekRenderer (injectable for tests);
 * onAttach(kind): the 补全原文件 dialog; onClose().
 */
export default function PagePeek({ page, figure = false, totalPages = 0, offset = 0, windowed = false, status, loadBytes, openRenderer, onAttach, onClose }) {
  const [phase, setPhase] = useState(status?.kind === 'ok' ? 'loading' : 'none'), [current, setCurrent] = useState(page), [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState(''), [mismatch, setMismatch] = useState(null), [busy, setBusy] = useState(false), [tries, setTries] = useState(0), [fitKey, setFitKey] = useState(0);
  const panel = useRef(null), canvas = useRef(null), scroller = useRef(null), renderer = useRef(null), drag = useRef(null);
  const gate = useRef(null), cache = useRef(null), opener = useRef(null), position = useRef({ x: 0, y: 0 }), stats = useRef({ renders: 0, hits: 0 });
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
      } catch (failure) { if (live) { setMessage(failure?.message || String(failure)); setPhase('error'); } }
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
          const bitmap = await renderer.current.render(pdfPage, { scale: step.scale, signal: turn.signal });
          if (!turn.current()) { closeBitmap(bitmap); return; }
          stats.current.renders += 1;
          cache.current.set(step.quality === 'low' ? lowKey : sharpKey, bitmap);
          show(bitmap);
          note();
        }
      } catch (failure) {
        if (turn.current() && failure?.name !== 'RenderingCancelledException' && failure?.name !== 'AbortError' && failure?.name !== 'AbortException') { setMessage(failure?.message || String(failure)); setPhase('error'); }
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
  // Dragging the title moves the panel (kept inside the window); the buttons in it still click.
  const onDragStart = event => {
    if (event.button !== 0 || event.target.closest('button, output')) return;
    const box = panel.current.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, start: { ...position.current }, box };
    const move = at => {
      const state = drag.current; if (!state) return;
      const x = Math.min(Math.max(state.start.x + at.clientX - state.x, 8 - state.box.left + state.start.x), window.innerWidth - 8 - state.box.right + state.start.x);
      const y = Math.min(Math.max(state.start.y + at.clientY - state.y, 8 - state.box.top + state.start.y), window.innerHeight - 40 - state.box.top + state.start.y);
      position.current = { x, y };
      if (panel.current) panel.current.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    const stop = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
  };
  return <PagePeekView phase={phase} page={current} total={total} zoom={zoom} figure={figure} busy={busy} message={message} mismatch={mismatch} issue={status}
    panelRef={panel} canvasRef={canvas} scrollRef={scroller} onClose={onClose} onPrev={() => go(-1)} onNext={() => go(1)} onZoom={zoomBy} onFit={fit}
    onAttach={onAttach} onRetry={() => { setPhase('ready'); setTries(count => count + 1); }} onDragStart={onDragStart} onKeyDown={onKeyDown} />;
}
