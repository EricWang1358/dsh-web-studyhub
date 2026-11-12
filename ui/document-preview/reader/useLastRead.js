/* global document window */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { forgetLastRead, lastReadOpening, readLastRead, saveLastRead, saveLastView } from './last-read.js';

/** How long after the last scroll the place is kept. */
export const SAVE_MS = 600;
/** While scrolling, the place is measured at most this often (what a close keeps). */
export const MEASURE_MS = 100;
/* The learner's own input in the reader. Until there is some, nothing is kept: the reader's own scrolls (opening at a quote, the way back) are no reading. */
const INPUT = ['wheel', 'touchmove', 'keydown', 'pointerdown'];

/**
 * 上次读到, opening (last-read.js): the kept place when the material was opened plainly (lastReadOpening), decided once per open; the reader
 * resumes it like any stored reading context, silently, as the review book lands at its kept place (ui/book/use-book-place.js). Returns the
 * opening (null when there is none).
 */
export function useLastReadOpening({ key, sourceId, firstSourceId, quote, resume, peekPage, localMode, pickPages = false, back = false }) {
  return useMemo(() => lastReadOpening({ entry: readLastRead(key), sourceId, firstSourceId, quote, resume, peekPage, localMode, pickPages, back }),
    [key, sourceId, firstSourceId, quote, resume, peekPage, localMode, pickPages, back]);
}

/**
 * 上次读到, keeping: once the learner has used the reader (`root`), the place (`here()`, or nothing when `atStart()`: forgotten) is measured
 * at most every MEASURE_MS while `scroller` scrolls and kept SAVE_MS after the last scroll or a change of `watch` (another chapter). Closing the
 * reader, or leaving the text view, keeps the last place measured: by then the drawn text may be gone, so nothing is measured then. The page
 * hidden (another window, the app closing) keeps the place too.
 * `moved`: a value that changes when the learner moved the text by a choice of their own that is not an input in it (back from 原始 PDF, the text lands
 * at the PDF's page, #1001): the scroll that follows is kept like their own.
 * Only while `enabled`.
 */
export function useKeepLastRead({ key, enabled, root, scroller, here, atStart, watch, moved = 0 }) {
  const latest = useRef({}); latest.current = { key, here, atStart, enabled };
  const touched = useRef(false), pending = useRef(null), timers = useRef({ measure: 0, save: 0 });
  const stop = useCallback(() => { clearTimeout(timers.current.measure); clearTimeout(timers.current.save); timers.current = { measure: 0, save: 0 }; }, []);
  const measure = useCallback(() => {
    timers.current.measure = 0;
    const { key: at, here: place, atStart: start, enabled: on } = latest.current;
    if (!on || !at || !touched.current) return;
    if (start?.()) pending.current = { key: at, place: null };
    else { const value = place?.(); if (value) pending.current = { key: at, place: value }; }
  }, []);
  const write = useCallback(() => {
    const kept = pending.current;
    pending.current = null;
    if (!kept) return;
    if (kept.place) saveLastRead(kept.key, kept.place); else forgetLastRead(kept.key);
  }, []);
  const save = useCallback(() => { stop(); measure(); write(); }, [stop, measure, write]);
  useEffect(() => { touched.current = false; }, [key]);
  useEffect(() => { if (moved) touched.current = true; }, [moved]);

  useEffect(() => {
    const area = scroller.current, frame = root.current;
    if (!enabled || !key || !area) return undefined;
    const used = () => { touched.current = true; };
    const scrolled = () => {
      if (!touched.current) return;
      if (!timers.current.measure) timers.current.measure = setTimeout(measure, MEASURE_MS);
      clearTimeout(timers.current.save);
      timers.current.save = setTimeout(save, SAVE_MS);
    };
    const hidden = () => { if (document.visibilityState === 'hidden') save(); };
    const target = frame || area;
    for (const name of INPUT) target.addEventListener(name, used, { passive: true });
    area.addEventListener('scroll', scrolled, { passive: true });
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', write);
    return () => {
      for (const name of INPUT) target.removeEventListener(name, used);
      area.removeEventListener('scroll', scrolled);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', write);
      stop();
      write();
    };
  }, [enabled, key, root, scroller, measure, save, stop, write]);
  // Another chapter is a place of its own, even when the switch did not scroll.
  useEffect(() => {
    if (!touched.current) return undefined;
    const id = setTimeout(save, SAVE_MS);
    return () => clearTimeout(id);
  }, [watch, save]);
}

/**
 * 上次读到, the view (#1001): while `original` (原始 PDF is shown), its `page` is kept in the material's record, with `place.current` (the text place of
 * the moment the learner switched, taken before the text went) the first time; back in the text the view is cleared, and the text lands at the PDF's
 * page, which useKeepLastRead keeps as the new place (its `moved`). A page turn
 * is a press, not a scroll: each one is written at once. It runs after useKeepLastRead's own write on leaving the text, so the view is the last word.
 * Only while `enabled`.
 */
export function useKeepLastView({ key, enabled, original, page, place }) {
  const shown = useRef(false);
  useEffect(() => { shown.current = false; }, [key]);
  useEffect(() => {
    if (!enabled || !key) return;
    if (original) {
      saveLastView(key, { original: true, page, place: shown.current ? null : place.current });
      shown.current = true; place.current = null;
    } else if (shown.current) { shown.current = false; saveLastView(key, { original: false }); }
  }, [enabled, key, original, page, place]);
}
