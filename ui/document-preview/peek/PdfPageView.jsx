import React, { useEffect, useRef, useState } from 'react';
import { ui, errorMessage } from '../../i18n.js';
import { useLiveEffect } from '../../use-async.js';
import { LoadingState } from '../../components/index.js';
import { createPeekRenderer, isCancelled } from './renderer.js';
import { LruCache, MAX_CACHED_PAGES, createRenderGate, pdfPageFor, peekCanvasSize, peekPlan } from './peek-logic.js';

const closeBitmap = bitmap => { try { bitmap.close?.(); } catch { /* already closed */ } };
const keyOf = (page, quality, scale) => (quality === 'low' ? `${page}:low` : `${page}:s${Math.round(scale * 100)}`);

/*
 * 原始 PDF, one page at a time (#488, item 3). The browser's PDF viewer ignores a later change of #page= (checked again in Chromium), so turning the page there meant a new
 * frame: the file read again, its zoom and place lost. Here the file is opened once with the peek's pdf.js (the same lazy chunk, loaded when this view is first opened, never
 * with the reader) and only the page changes: the zoom is the viewer's (`zoom`, 1 = fit to the width), the sideways place stays, a new page starts at its top, and the page
 * shown is always the page the panel asks about. The text layer keeps the words selectable. What cannot be drawn truly (a page count that disagrees with the text, images that
 * did not decode, a failure of pdf.js) is not guessed at: onFail(), and the caller shows the browser's viewer.
 */
export default function PdfPageView({ loadBytes, page, totalPages = 0, zoom = 1, onPage, onFail }) {
  const [ready, setReady] = useState(false), [fitKey, setFitKey] = useState(0);
  const area = useRef(null), canvas = useRef(null), textLayer = useRef(null), renderer = useRef(null), failed = useRef(onFail);
  failed.current = onFail;
  const gate = useRef(null), cache = useRef(null), lastPage = useRef(page);
  gate.current ||= createRenderGate();
  cache.current ||= new LruCache(MAX_CACHED_PAGES, closeBitmap);

  // The file is opened once and let go with the view.
  useLiveEffect((isLive) => {
    const bitmaps = cache.current, run = gate.current;
    (async () => {
      try {
        const bytes = await loadBytes();
        if (!isLive()) return;
        if (!bytes) { failed.current?.(); return; }
        const opened = await createPeekRenderer(bytes);
        if (!isLive()) { opened.destroy(); return; }
        renderer.current = opened;
        if (!pdfPageFor({ page: 1, totalPages, pdfPages: opened.numPages }).ok) { failed.current?.(); return; }
        setReady(true);
      } catch (failure) { if (isLive()) { console.warn('PDF page view:', errorMessage(failure)); failed.current?.(); } }
    })();
    return () => { run.cancelAll(); bitmaps.clear(); renderer.current?.destroy(); renderer.current = null; };
  }, []); // one file per view; the caller keys it by the file

  // Draw the page: from the cache, else small first and then sharp; a newer page, zoom or width cancels this one. The old page stays until the new one has something to show.
  useEffect(() => {
    const scroller = area.current, target = canvas.current, words = textLayer.current;
    if (!ready || !renderer.current || !scroller || !target || !words) return undefined;
    if (!pdfPageFor({ page, totalPages, pdfPages: renderer.current.numPages }).ok) { failed.current?.(); return undefined; }
    const turn = gate.current.begin();
    let layer = null;
    (async () => {
      try {
        const unit = await renderer.current.pageSize(page);
        if (!turn.current()) return;
        const fit = Math.max(0.1, (scroller.clientWidth - 2) / unit.width), dpr = Math.min(window.devicePixelRatio || 1, 2), css = fit * zoom;
        const sharp = peekCanvasSize({ width: unit.width, height: unit.height, scale: css * dpr });
        const sharpKey = keyOf(page, 'sharp', sharp.scale), lowKey = keyOf(page, 'low');
        const place = () => {
          target.style.width = `${Math.round(unit.width * css)}px`; target.style.height = `${Math.round(unit.height * css)}px`;
          const box = target.parentElement; box.style.width = target.style.width; box.style.height = target.style.height;
          if (lastPage.current !== page) { scroller.scrollTop = 0; lastPage.current = page; scroller.dataset.pdfPage = page; }
        };
        const show = bitmap => { if (!bitmap || !turn.current()) return; place(); target.width = bitmap.width; target.height = bitmap.height; target.getContext('2d').drawImage(bitmap, 0, 0); };
        show(cache.current.get(sharpKey) || cache.current.get(lowKey));
        // The words are a help, not the page: without them the picture still shows, and no words of another page stay over it.
        layer = await renderer.current.textLayer(page, { scale: css, container: words, current: turn.current }).catch(failure => { if (turn.current()) words.replaceChildren(); if (isCancelled(failure)) throw failure; return null; });
        for (const step of peekPlan({ fitScale: fit, zoom, dpr, cached: { low: cache.current.has(lowKey), sharp: cache.current.has(sharpKey) } })) {
          let undecoded = 0;
          const bitmap = await renderer.current.render(page, { scale: step.scale, signal: turn.signal, onReport: report => { undecoded = report.undecoded; } });
          if (!turn.current()) { closeBitmap(bitmap); return; }
          if (undecoded) { closeBitmap(bitmap); failed.current?.(); return; } // a scan whose decoder did not load would look like a blank page
          cache.current.set(step.quality === 'low' ? lowKey : sharpKey, bitmap);
          show(bitmap);
        }
      } catch (failure) {
        if (turn.current() && !isCancelled(failure)) { console.warn('PDF page view:', errorMessage(failure)); failed.current?.(); }
      }
    })();
    return () => { gate.current?.cancelAll(); layer?.cancel?.(); };
  }, [ready, page, zoom, fitKey, totalPages]);

  // The reader's width changed (the panel opened, the window moved): draw again once it settles.
  useEffect(() => {
    const scroller = area.current;
    if (!ready || !scroller || typeof ResizeObserver === 'undefined') return undefined;
    let timer = 0, width = scroller.clientWidth;
    const watch = new ResizeObserver(() => { if (Math.abs(scroller.clientWidth - width) < 24) return; width = scroller.clientWidth; clearTimeout(timer); timer = setTimeout(() => setFitKey(key => key + 1), 200); });
    watch.observe(scroller);
    return () => { clearTimeout(timer); watch.disconnect(); };
  }, [ready]);

  const onKeyDown = event => {
    if (event.key === 'PageUp') { event.preventDefault(); onPage?.(page - 1); }
    else if (event.key === 'PageDown') { event.preventDefault(); onPage?.(page + 1); }
  };
  return <div className="reader-pdf-view" ref={area} tabIndex={0} role="region" aria-label={ui('原始 PDF')} data-pdf-page={lastPage.current} onKeyDown={onKeyDown}>
    {!ready && <LoadingState label={ui('正在打开资料…')} />}
    <div className="reader-pdf-sheet" hidden={!ready}>
      <canvas ref={canvas} aria-hidden="true" />
      <div className="reader-pdf-text" ref={textLayer} />
    </div>
  </div>;
}
