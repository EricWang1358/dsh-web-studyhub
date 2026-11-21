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
/** Minimum top breathing room (px) inside `.reader-scroll` when aligning near top vs centering. */
export const TOP_BREATHING_PX = 16;
export const CENTER_TOP_BREATHING_PX = 24;
/* Far enough above the reading area that every entry scrolled past still counts as passed (a long chapter is tens of thousands of pixels). */
const PASSED_PX = 10_000_000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const activeAnchors = new WeakMap();

/** Cancel any active post-jump re-anchoring on `scroller`. */
export function cancelAnchorScroll(scroller) {
  if (!scroller) return;
  activeAnchors.get(scroller)?.();
}

/** Bounding rect of an Element or Range; for a Range with client rects, skips empty leading rects so tall/multi-line quotes align at their first visible text. */
export function targetRect(node) {
  if (!node) return null;
  if (node.nodeType !== 1 && typeof node.getClientRects === 'function') {
    const rawRects = Array.from(node.getClientRects() || []);
    const rects = rawRects.filter(r => r && r.width > 0 && r.height > 0);
    if (rects.length > 0) {
      const top = Math.min(...rects.map(r => r.top));
      const bottom = Math.max(...rects.map(r => r.bottom));
      const left = Math.min(...rects.map(r => r.left));
      const right = Math.max(...rects.map(r => r.right));
      return { top, bottom, left, right, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }
    const fallback = rawRects.find(r => r && (r.width > 0 || r.height > 0));
    if (fallback) return fallback;
  }
  const rect = node.getBoundingClientRect?.();
  if (!rect) return null;
  if (rect.width === 0 && rect.height === 0 && typeof node.getClientRects === 'function') {
    const fallback = Array.from(node.getClientRects() || []).find(r => r && (r.width > 0 || r.height > 0));
    if (fallback) return fallback;
  }
  return rect;
}

function rectHeight(rect) {
  return rect.height ?? (rect.bottom != null && rect.top != null ? Math.max(0, rect.bottom - rect.top) : 0);
}

/** Visual zoom factor of `scroller` (`getBoundingClientRect()` px per unzoomed CSS px, e.g. `.study-app { zoom }`). */
export function scrollerScale(scroller, box = scroller?.getBoundingClientRect?.()) {
  if (!scroller || !box) return 1;
  const boxH = rectHeight(box);
  if (scroller.offsetHeight > 0 && boxH > 0) return boxH / scroller.offsetHeight;
  const boxW = box.width ?? (box.right != null && box.left != null ? Math.max(0, box.right - box.left) : 0);
  if (scroller.offsetWidth > 0 && boxW > 0) return boxW / scroller.offsetWidth;
  return 1;
}

function targetScrollTop(scroller, node, { center = false, minTop } = {}) {
  if (!scroller || !node) return null;
  const box = scroller.getBoundingClientRect?.(), rect = targetRect(node);
  if (!box || !rect || box.top == null || rect.top == null) return null;
  const scale = scrollerScale(scroller, box) || 1;
  const boxH = rectHeight(box) / scale, nodeH = rectHeight(rect) / scale;
  const floor = minTop ?? (center ? CENTER_TOP_BREATHING_PX : TOP_BREATHING_PX);
  const offset = center ? Math.max(floor, (boxH - nodeH) / 2) : floor;
  const raw = Math.max(0, (scroller.scrollTop || 0) + (rect.top - box.top) / scale - offset);
  if (Number.isFinite(scroller.scrollHeight) && Number.isFinite(scroller.clientHeight) && scroller.scrollHeight > scroller.clientHeight) {
    return Math.min(raw, scroller.scrollHeight - scroller.clientHeight);
  }
  return raw;
}

/** Scroll `node` (Element or Range) to the top of the scroll area (with breathing room), or to its middle. */
export function scrollToNode(scroller, node, { center = false, smooth = true, minTop } = {}) {
  cancelAnchorScroll(scroller);
  const top = targetScrollTop(scroller, node, { center, minTop });
  if (top === null) return false;
  scroller.scrollTo?.({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  return true;
}

const isConnectedTarget = node => (node?.nodeType === 1 ? node.isConnected !== false : node?.startContainer ? node.startContainer.isConnected !== false : !!node);

/**
 * Scroll to `node` (Element or Range) and keep it anchored through brief post-jump layout shifts
 * (async notices, lazy formulas, image loads, bilingual blocks) until settled or the user manually scrolls.
 * Returns a cleanup function that cancels re-anchoring.
 */
export function anchorScroll(scroller, node, { center = false, smooth = false, minTop, settleMs = 700 } = {}) {
  cancelAnchorScroll(scroller);
  if (!scroller || !node) return () => {};
  let active = true, raf1 = 0, raf2 = 0, timer = 0, observer = null, anchoring = false;
  let lastTop = scroller.scrollTop || 0;
  let lastScrollHeight = scroller.scrollHeight, lastClientHeight = scroller.clientHeight;
  let lastBoxTop = scroller.getBoundingClientRect?.().top ?? 0;

  const stop = () => {
    if (!active) return;
    active = false;
    if (activeAnchors.get(scroller) === stop) activeAnchors.delete(scroller);
    if (raf1 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf1);
    if (raf2 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf2);
    if (timer) clearTimeout(timer);
    observer?.disconnect?.();
    scroller.removeEventListener?.('wheel', onUserScroll);
    scroller.removeEventListener?.('touchstart', onUserScroll);
    scroller.removeEventListener?.('pointerdown', onUserScroll);
    scroller.removeEventListener?.('keydown', onKeyDown);
    scroller.removeEventListener?.('scroll', onScroll);
  };

  activeAnchors.set(scroller, stop);

  const apply = () => {
    if (!active) return;
    if (!isConnectedTarget(node)) { stop(); return; }
    const nextTop = targetScrollTop(scroller, node, { center, minTop });
    if (nextTop === null) return;
    const currentTop = scroller.scrollTop || 0;
    if (Math.abs(nextTop - currentTop) > 1) {
      anchoring = true;
      scroller.scrollTo?.({ top: nextTop, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
      anchoring = false;
    }
    lastTop = scroller.scrollTop || 0;
    lastScrollHeight = scroller.scrollHeight;
    lastClientHeight = scroller.clientHeight;
    lastBoxTop = scroller.getBoundingClientRect?.().top ?? 0;
  };

  const onUserScroll = () => stop();
  const onKeyDown = event => { if (SCROLL_KEYS.has(event?.key)) stop(); };
  const onScroll = () => {
    if (!active || anchoring) return;
    const currentTop = scroller.scrollTop || 0;
    if (Math.abs(currentTop - lastTop) <= 2) return;
    const boxTop = scroller.getBoundingClientRect?.().top ?? 0;
    const layoutChanged = scroller.scrollHeight !== lastScrollHeight
      || scroller.clientHeight !== lastClientHeight
      || Math.abs(boxTop - lastBoxTop) > 1;
    if (!layoutChanged) stop();
  };

  apply();

  if (smooth && !reducedMotion()) return stop;

  scroller.addEventListener?.('wheel', onUserScroll, { passive: true });
  scroller.addEventListener?.('touchstart', onUserScroll, { passive: true });
  scroller.addEventListener?.('pointerdown', onUserScroll, { passive: true });
  scroller.addEventListener?.('keydown', onKeyDown);
  scroller.addEventListener?.('scroll', onScroll, { passive: true });

  if (typeof requestAnimationFrame === 'function') {
    raf1 = requestAnimationFrame(() => {
      raf1 = 0;
      apply();
      if (!active) return;
      raf2 = requestAnimationFrame(() => { raf2 = 0; apply(); });
    });
  }

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => { apply(); });
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
  }

  if (settleMs > 0) timer = setTimeout(stop, settleMs);
  return stop;
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
export function useReadingPosition(scroller, items, watch, { onProgress } = {}) {
  const [position, setPosition] = useState({ activeId: items[0]?.id ?? null, progress: 0 });
  const last = useRef(position);
  const lastProgress = useRef(-1);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const publish = useCallback(next => {
    const progressSink = onProgressRef.current;
    if (progressSink) {
      if (lastProgress.current < 0 || Math.abs(lastProgress.current - next.progress) >= 0.002) {
        lastProgress.current = next.progress;
        progressSink(next.progress);
      }
      if (last.current.activeId === next.activeId) return;
      last.current = next;
      setPosition(next);
      return;
    }
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
