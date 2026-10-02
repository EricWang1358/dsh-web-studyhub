import { issueOf } from '../original-file.js';

/* 看原页 (page peek): the pure parts. Which PDF page a text page is, how big a page may be drawn, the progressive plan (small first,
   then sharp), the six-bitmap LRU, the gate that lets only the latest render draw, what the popover says when the original is not
   there, and which paragraph is a figure placeholder. No DOM, no pdf.js: PagePeek.jsx and renderer.js use them, and they are tested. */

/** A page is never drawn larger than this on its long edge (pixels). */
export const MAX_EDGE = 2000;
/** How many page bitmaps are kept for going back and forth. */
export const MAX_CACHED_PAGES = 6;
/** Zoom as a factor of "fit to the width of the panel". */
export const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];

/** The next zoom step up (+1) or down (-1); an odd value moves to the neighbouring step, and the ends stay. */
export function stepZoom(zoom, direction) {
  if (direction > 0) return ZOOMS.find(step => step > zoom + 1e-9) ?? ZOOMS.at(-1);
  return [...ZOOMS].reverse().find(step => step < zoom - 1e-9) ?? ZOOMS[0];
}

/**
 * Which PDF page the text page `page` is. The same number when both have the same number of pages; a document that declares it is a
 * window of a longer file (`window`, with its `offset`) maps through the offset. Page counts that disagree are reported, never
 * guessed: showing the wrong page is worse than showing none.
 * -> { ok: true, pdfPage } | { ok: false, reason: 'no-page' | 'count-mismatch' | 'out-of-range', ... }
 */
export function pdfPageFor({ page, totalPages = 0, pdfPages, offset = 0, window: isWindow = false }) {
  if (!Number.isInteger(page) || page < 1) return { ok: false, reason: 'no-page' };
  if (!isWindow && totalPages > 0 && totalPages !== pdfPages) return { ok: false, reason: 'count-mismatch', totalPages, pdfPages };
  const pdfPage = page + (isWindow ? offset : 0);
  if ((totalPages > 0 && page > totalPages) || pdfPage > pdfPages) return { ok: false, reason: 'out-of-range', pdfPages };
  return { ok: true, pdfPage };
}

/** The pixel size of a page of `width` x `height` (PDF units) at `scale`, with its long edge held to MAX_EDGE: { width, height, scale, capped }. */
export function peekCanvasSize({ width, height, scale }) {
  const wanted = Math.max(scale || 0, 0.01), longest = Math.max(width, height) * wanted;
  const factor = longest > MAX_EDGE ? MAX_EDGE / longest : 1, effective = wanted * factor;
  return { width: Math.max(1, Math.round(width * effective)), height: Math.max(1, Math.round(height * effective)), scale: effective, capped: factor < 1 };
}

const LOW_FACTOR = 0.35, LOW_UNTIL = 0.8;
/**
 * What to draw for the page now: a cheap small pass first (shown stretched at once), then the pass sharp for the zoom and the
 * screen (fit x zoom x device pixel ratio). A page already cached sharp needs nothing; a small page is drawn once.
 * -> [{ quality: 'low' | 'sharp', scale }]
 */
export function peekPlan({ fitScale, zoom, dpr = 1, cached = {} }) {
  if (cached.sharp) return [];
  const sharp = Math.max(fitScale * zoom * dpr, 0.05);
  return cached.low || sharp <= LOW_UNTIL ? [{ quality: 'sharp', scale: sharp }] : [{ quality: 'low', scale: sharp * LOW_FACTOR }, { quality: 'sharp', scale: sharp }];
}

/** A least-recently-used map of at most `capacity` entries; `release(value, key)` runs when one leaves (a bitmap is closed there). */
export class LruCache {
  #map = new Map();
  constructor(capacity, release = () => {}) { this.capacity = Math.max(0, Math.floor(capacity)); this.release = release; }
  get size() { return this.#map.size; }
  has(key) { return this.#map.has(key); }
  keys() { return this.#map.keys(); }
  /** The value without making it the most recently used. */
  peek(key) { return this.#map.get(key); }
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key); this.#map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.capacity === 0) { this.release(value, key); return undefined; }
    if (this.#map.has(key)) this.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.capacity) this.delete(this.#map.keys().next().value);
    return value;
  }
  delete(key) {
    if (!this.#map.has(key)) return false;
    const value = this.#map.get(key);
    this.#map.delete(key); this.release(value, key);
    return true;
  }
  clear() { for (const key of [...this.#map.keys()]) this.delete(key); }
}

/** Only the latest render may draw: begin() cancels the one before it; cancelAll() (closing) cancels whatever is running. */
export function createRenderGate() {
  let active = null;
  const gate = {
    begin() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      return { signal: controller.signal, current: () => active === controller && !controller.signal.aborted };
    },
    cancelAll() { active?.abort(); active = null; },
  };
  return gate;
}

/** What the popover says about the original: { kind: 'ok' | 'none' | 'missing' | 'unreadable' | 'redirected' | 'changed', message, canAttach }. */
export function peekStatus(document) {
  const issue = document?.available ? null : issueOf(document?.original);
  if (!issue) return document?.available ? { kind: 'ok', message: '', canAttach: false } : { kind: 'none', message: '', canAttach: true };
  return { kind: issue.kind, message: issue.message || '', canAttach: true };
}

const PLACEHOLDER = /^(?:\[(?:Figure|图|图片)\]|!\[[^\]]*\]\(doc:[^)\s]*\))$/;
/** A lone figure marker of the text (the converter's [Figure], or the doc: image block it names): the text has no picture there. */
export const isFigurePlaceholder = value => typeof value === 'string' && PLACEHOLDER.test(value.trim());
