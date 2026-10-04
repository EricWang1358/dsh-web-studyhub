import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PAN_SLOP, ZOOM_LIMITS, centerOn, fitTransform, keyAction, readableView, zoomAround } from './pan-zoom.js';

const IGNORE = 'button, a, input, select, textarea';

/**
 * Pan and zoom for a drawing of width x height in an element (`viewRef`).
 * Drag pans (a press that moves less than a few pixels stays a click),
 * Ctrl/⌘+wheel zooms around the pointer while a plain wheel keeps scrolling
 * the page, and the focused canvas answers arrows, + / - and 0. The view is
 * refitted when the drawing or the element changes size. Spread `panHandlers`
 * on the element; draw inside it with translate(view.x, view.y) scale(view.k).
 * Options: maxFit, insetRight, minInitial, anchorX/anchorY, vertical (see
 * fitTransform) and zoomMin/zoomMax.
 */
export function usePanZoom(width, height, { maxFit = 1.2, insetRight = 0, minInitial = 0.9, anchorX = 0, anchorY = 0, vertical = false,
  zoomMin = ZOOM_LIMITS.min, zoomMax = ZOOM_LIMITS.max } = {}) {
  const viewRef = useRef(null), drag = useRef(null), swallow = useRef(false);
  const limits = { min: zoomMin, max: zoomMax };
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const box = () => ({ width: viewRef.current?.clientWidth || 0, height: viewRef.current?.clientHeight || 0 });
  const fit = useCallback((initial = false, bounds = { w: width, h: height }) => {
    const el = viewRef.current;
    if (!el || !width || !height) return;
    setView(fitTransform({ box: { width: el.clientWidth, height: el.clientHeight }, bounds, initial: initial === true, maxFit, insetRight, minInitial,
      anchorX, anchorY, vertical, zoomMin, zoomMax }));
  }, [width, height, maxFit, insetRight, minInitial, anchorX, anchorY, vertical, zoomMin, zoomMax]);
  useLayoutEffect(() => {
    fit(true);
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      setViewport(v => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight }));
      if (el.clientWidth && el.clientHeight) fit(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
  const zoomAt = useCallback((factor, clientX, clientY) => {
    const el = viewRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX === undefined ? el.clientWidth / 2 : clientX - rect.left;
    const cy = clientY === undefined ? el.clientHeight / 2 : clientY - rect.top;
    setView(v => zoomAround(v, factor, cx, cy, { min: zoomMin, max: zoomMax }));
  }, [zoomMin, zoomMax]);
  const readable = useCallback(() => setView(v => readableView(v, box())), []);
  const moveTo = useCallback((x, y) => { if (viewRef.current) setView(v => centerOn(v, box(), x, y)); }, []);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    const onWheel = ev => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX, ev.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);
  const panHandlers = {
    onPointerDown: ev => {
      if (ev.button !== 0 || ev.target.closest?.(IGNORE)) return;
      drag.current = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, view, moved: false };
    },
    onPointerMove: ev => {
      const d = drag.current;
      if (!d || d.id !== ev.pointerId) return;
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < PAN_SLOP) return;
        d.moved = true;
        ev.currentTarget.setPointerCapture?.(ev.pointerId);
        ev.currentTarget.classList.add('is-panning');
      }
      setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
    },
    onPointerUp: ev => {
      const d = drag.current;
      if (d?.id !== ev.pointerId) return;
      drag.current = null;
      ev.currentTarget.classList.remove('is-panning');
      if (d.moved) { swallow.current = true; setTimeout(() => { swallow.current = false; }, 0); }
    },
    // The click that ends a drag must not open whatever the pointer is over.
    onClickCapture: ev => {
      if (!swallow.current) return;
      swallow.current = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    onKeyDown: ev => {
      if (ev.target !== ev.currentTarget || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const action = keyAction(ev.key);
      if (!action) return;
      ev.preventDefault();
      if (action.type === 'pan') setView(v => ({ ...v, x: v.x + action.dx, y: v.y + action.dy }));
      else if (action.type === 'zoom') zoomAt(action.factor);
      else fit();
    },
  };
  panHandlers.onPointerCancel = panHandlers.onPointerUp;
  panHandlers.onLostPointerCapture = panHandlers.onPointerUp;
  return { viewRef, view, viewport, fit, zoomAt, readable, moveTo, panHandlers, limits };
}

export default usePanZoom;
