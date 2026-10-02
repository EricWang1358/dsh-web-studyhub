import { useCallback, useEffect, useRef, useState } from 'react';
import { pickActive, readingProgress } from './outline.js';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const outlineNode = (root, id) => root.querySelector(`[data-outline-id="${String(id).replace(/["\\]/g, '\\$&')}"]`);

/** Scroll `node` to the top of the scroll area (a little below it), or to its middle. */
export function scrollToNode(scroller, node, { center = false, smooth = true } = {}) {
  if (!scroller || !node) return;
  const box = scroller.getBoundingClientRect(), rect = node.getBoundingClientRect();
  const offset = center ? (box.height - rect.height) / 2 : 12;
  scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + rect.top - box.top - offset), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

/**
 * Where the reader is in its scroll area: the current outline entry and the 0..1 progress.
 * It measures on scroll and resize, and when the outline or `watch` changes; never after
 * every render, and it only sets state when the position really changed.
 * Returns [{ activeId, progress }, jump(id)].
 */
export function useReadingPosition(scroller, items, watch) {
  const [position, setPosition] = useState({ activeId: items[0]?.id ?? null, progress: 0 });
  const last = useRef(position);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top, entries = [];
    for (const item of items) {
      const node = outlineNode(element, item.id);
      if (node) entries.push({ id: item.id, top: node.getBoundingClientRect().top - top });
    }
    const next = { activeId: pickActive(entries), progress: readingProgress(element) };
    if (last.current.activeId === next.activeId && Math.abs(last.current.progress - next.progress) < 0.004) return;
    last.current = next;
    setPosition(next);
  }, [scroller, items]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (observer) { observer.observe(element); if (element.firstElementChild) observer.observe(element.firstElementChild); }
    return () => { element.removeEventListener('scroll', schedule); observer?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [scroller, measure, watch]);
  const jump = useCallback(id => { const element = scroller.current; if (element) scrollToNode(element, outlineNode(element, id)); }, [scroller]);
  return [position, jump];
}
