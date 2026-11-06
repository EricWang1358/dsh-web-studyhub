import { useCallback, useEffect, useRef, useState } from 'react';
import { pickActive, readingProgress } from './outline.js';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const ATTRIBUTES = ['data-outline-id', 'data-ai-outline-id'];
/* An entry's target: the heading or section the reader tagged (data-outline-id) or the block a kept AI outline points at (data-ai-outline-id). */
const outlineNode = (root, id) => {
  const value = String(id).replace(/["\\]/g, '\\$&');
  return root.querySelector(`[data-outline-id="${value}"],[data-ai-outline-id="${value}"]`);
};
/** The pixels below the top of the reading area at which an entry becomes the current one (outline.js pickActive's threshold). */
export const ACTIVE_LINE_PX = 24;
/* Far enough above the reading area that every entry scrolled past still counts as passed (a long chapter is tens of thousands of pixels). */
const PASSED_PX = 10_000_000;

/** Scroll `node` to the top of the scroll area (a little below it), or to its middle. */
export function scrollToNode(scroller, node, { center = false, smooth = true } = {}) {
  if (!scroller || !node) return;
  const box = scroller.getBoundingClientRect(), rect = node.getBoundingClientRect();
  const offset = center ? (box.height - rect.height) / 2 : 12;
  scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + rect.top - box.top - offset), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

/** The drawn targets of the entries, in the entries' order: one query of the reading area, not one per entry. */
function targetsOf(element, items) {
  const byId = new Map();
  for (const node of element.querySelectorAll(ATTRIBUTES.map(name => `[${name}]`).join(','))) {
    for (const name of ATTRIBUTES) { const id = node.getAttribute(name); if (id !== null && !byId.has(id)) byId.set(id, node); }
  }
  return items.map(item => ({ id: item.id, node: byId.get(String(item.id)) })).filter(entry => entry.node);
}

/** The current entry: the last drawn one that has reached the line, else the first drawn one, else the first entry. */
export function activeOf(targets, passed, fallback = null) {
  let active = targets[0]?.id ?? fallback;
  for (const target of targets) {
    if (passed.get(target.node)) active = target.id;
    else break;
  }
  return active;
}

/**
 * Where the reader is in its scroll area: the current outline entry and the 0..1 progress.
 * The current entry is watched with an IntersectionObserver over the drawn targets (only the chapter on screen has any), so a scroll never
 * measures the entries; the progress is the scroll offset. Both are read again when the outline or `watch` changes, and state is only set when
 * the position really changed. Without IntersectionObserver the entries are measured on scroll, as before.
 * Returns [{ activeId, progress }, jump(id)].
 */
export function useReadingPosition(scroller, items, watch) {
  const [position, setPosition] = useState({ activeId: items[0]?.id ?? null, progress: 0 });
  const last = useRef(position);
  const publish = useCallback(next => {
    if (last.current.activeId === next.activeId && Math.abs(last.current.progress - next.progress) < 0.004) return;
    last.current = next;
    setPosition(next);
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const targets = targetsOf(element, items), passed = new Map(), fallback = null;
    let active = activeOf(targets, passed, fallback), frame = 0, observer = null;
    const report = () => publish({ activeId: active, progress: readingProgress(element) });
    const measure = () => {
      // No IntersectionObserver: the entries are measured (outline.js pickActive).
      const top = element.getBoundingClientRect().top;
      active = pickActive(targets.map(target => ({ id: target.id, top: target.node.getBoundingClientRect().top - top })), ACTIVE_LINE_PX) ?? fallback;
    };
    const watchTargets = () => {
      observer?.disconnect();
      if (typeof IntersectionObserver === 'undefined') { measure(); report(); return; }
      // The root reaches from far above the area down to the line, so "intersecting" is "its top has passed the line".
      const bottom = Math.max(0, element.clientHeight - ACTIVE_LINE_PX);
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) passed.set(entry.target, entry.isIntersecting);
        active = activeOf(targets, passed, fallback);
        report();
      }, { root: element, rootMargin: `${PASSED_PX}px 0px -${bottom}px 0px` });
      for (const target of targets) observer.observe(target.node);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (!observer) measure(); report(); }); };
    watchTargets();
    report();
    element.addEventListener('scroll', schedule, { passive: true });
    let height = element.clientHeight;
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (observer && element.clientHeight !== height) { height = element.clientHeight; watchTargets(); }
      schedule();
    });
    if (resized) { resized.observe(element); if (element.firstElementChild) resized.observe(element.firstElementChild); }
    return () => { element.removeEventListener('scroll', schedule); resized?.disconnect(); observer?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [scroller, items, watch, publish]);
  const jump = useCallback(id => { const element = scroller.current; if (element) scrollToNode(element, outlineNode(element, id)); }, [scroller]);
  return [position, jump];
}
