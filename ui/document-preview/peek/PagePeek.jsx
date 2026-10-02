import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { Button } from '../../components/index.js';
import { LruCache, MAX_CACHED_PAGES, ZOOMS, createRenderGate, pdfPageFor, peekCanvasSize, peekPlan, stepZoom } from './peek-logic.js';
import css from './peek.css';

/* 看原页: a small floating panel that shows ONE page of the attached original PDF next to the text, on demand. It never loads the
   PDF viewer: pdf.js (renderer.js, loaded on first use) draws that page into one canvas, small first and then sharp; the last six
   page bitmaps are kept for going back and forth; a render is cancelled when the page changes or the panel closes; closing frees
   the bitmaps and destroys the document. Without a usable original it says why in one line and offers 补全原文件 instead of an
   empty frame. The text has no pictures (a converted book keeps none): a figure is shown from the original page. */

/** The panel as markup, for every phase: 'loading' | 'ready' | 'error' | 'none' | 'mismatch'. */
export function PagePeekView({ phase, page, total, zoom = 1, figure = false, busy = false, message = '', mismatch = null, issue = null,
  panelRef, canvasRef, scrollRef, onClose, onPrev, onNext, onZoom, onFit, onAttach, onRetry, onDragStart, onKeyDown }) {
  useInjectCss(css, 'study-page-peek');
  const ready = phase === 'ready';
  return <div className="page-peek" role="dialog" aria-modal="false" aria-label={ui('原页预览')} tabIndex={-1} ref={panelRef} data-phase={phase} onKeyDown={onKeyDown}>
    <header className="page-peek__head" onPointerDown={onDragStart}>
      <strong className="page-peek__title">{ui('看原页')}</strong>
      <span className="page-peek__where" aria-live="polite">{uiFormat('第 {0} / {1} 页', [page, total])}</span>
      <div className="page-peek__tools">
        {ready && <>
          <Button size="sm" variant="quiet" aria-label={ui('上一页')} title={ui('上一页')} disabled={page <= 1} onClick={onPrev}><span aria-hidden="true">‹</span></Button>
          <Button size="sm" variant="quiet" aria-label={ui('下一页')} title={ui('下一页')} disabled={page >= total} onClick={onNext}><span aria-hidden="true">›</span></Button>
          <Button size="sm" variant="quiet" aria-label={ui('缩小')} title={ui('缩小')} disabled={zoom <= ZOOMS[0]} onClick={() => onZoom(-1)}><span aria-hidden="true">−</span></Button>
          <output className="page-peek__zoom" aria-live="polite">{Math.round(zoom * 100)}%</output>
          <Button size="sm" variant="quiet" aria-label={ui('放大')} title={ui('放大')} disabled={zoom >= ZOOMS.at(-1)} onClick={() => onZoom(1)}><span aria-hidden="true">＋</span></Button>
          <Button size="sm" variant="quiet" aria-label={ui('适合宽度')} title={ui('适合宽度')} onClick={onFit}><span aria-hidden="true">⤢</span></Button>
        </>}
        <Button size="sm" variant="quiet" aria-label={ui('关闭')} title={ui('关闭')} onClick={onClose}><span aria-hidden="true">×</span></Button>
      </div>
    </header>
    <div className="page-peek__body">
      {phase === 'loading' && <p className="page-peek__state" role="status"><span className="sh-spinner" aria-hidden="true" />{ui('正在读取原文件…')}</p>}
      {phase === 'none' && <div className="page-peek__state page-peek__state--note">
        <p>{issue?.kind && issue.kind !== 'none' && issue.message ? issue.message : ui('这份资料只保存了提取出的文字，没有原文件，所以看不到原页。')}</p>
        <Button size="sm" variant="secondary" icon="file" onClick={() => onAttach?.(issue?.kind && issue.kind !== 'none' ? 'relink' : 'attach')}>
          {issue?.kind && issue.kind !== 'none' ? ui('重新指定…') : ui('补全原文件…')}</Button>
      </div>}
      {phase === 'mismatch' && <div className="page-peek__state page-peek__state--note" role="alert">
        <p>{uiFormat('文字版共 {0} 页，原文件有 {1} 页：页码对不上，为避免看错页，这里不显示。', [mismatch?.totalPages, mismatch?.pdfPages])}</p>
        <Button size="sm" variant="secondary" onClick={() => onAttach?.('relink')}>{ui('重新指定…')}</Button>
      </div>}
      {phase === 'error' && <div className="page-peek__state page-peek__state--note" role="alert">
        <p>{uiFormat('这一页没能显示：{0}', [message])}</p>
        <Button size="sm" variant="secondary" onClick={onRetry}>{ui('重试')}</Button>
      </div>}
      {ready && <div className="page-peek__scroll" ref={scrollRef} tabIndex={0} role="region" aria-label={ui('原页')}>
        <canvas ref={canvasRef} className="page-peek__canvas" role="img" aria-label={uiFormat('原文件第 {0} 页', [page])} />
      </div>}
      {ready && busy && <p className="page-peek__busy" role="status">{ui('正在绘制…')}</p>}
      {ready && figure && <p className="page-peek__note">{ui('文字版不含图片：这里直接显示原文件的这一页。')}</p>}
    </div>
  </div>;
}

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
        const opened = await (openRenderer || (await import('./renderer.js')).createPeekRenderer)(bytes);
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
