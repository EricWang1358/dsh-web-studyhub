import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepBook, keptBook, rowOf } from './model.js';
import { stepIndexOf } from './reading.js';
import { stickBar } from './BookBar.jsx';

/* Where the learner is in the review book (docs/review-book.md "Where you were"): the point shown (逐节读), the chapters open (整章连着读), the heading being
   read, and the place kept for the next visit. Landing: an entry's target (总纲, home, the way back from practice) > the place kept in this browser (ui/book/model.js
   keepBook: heading and offset per library and course) > the first point. The place is measured on every scroll frame and written when the point changes, at
   most every 500 ms while the page scrolls, when the page is hidden, and (that last measure) when the page goes away. The focus goes to a heading only on a real return from practice (`back`, set by the way back), never on a plain open.
   A landing is measured from the heading, never from a stored scrollTop: the height above the heading is not the same from one draw to the next (holdPlace below). */

const SAVE_EVERY = 500;
const HOLD_FOR = 10000, HOLD_WITHIN = 2;
const LEARNER_MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
const instant = (scroller, top) => scroller.scrollTo({ top, behavior: 'instant' });

/** The element that scrolls the page (the app's own scroller in the browser). */
export const scrollerOf = element => {
  const getStyle = typeof getComputedStyle === 'function' ? getComputedStyle : typeof window !== 'undefined' ? window.getComputedStyle : null;
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = getStyle?.(node);
    if (style && /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return typeof document !== 'undefined' ? document.scrollingElement : null;
};

/** CSS zoom scale between `getBoundingClientRect()` (screen px) and `scrollTop` / layout px on `node` (1 in unzoomed or mock DOMs). */
function zoomScale(node) {
  if (!node) return 1;
  const rect = node.getBoundingClientRect?.();
  if (node.offsetHeight > 0 && rect?.height > 0) return rect.height / node.offsetHeight;
  if (node.offsetWidth > 0 && rect?.width > 0) return rect.width / node.offsetWidth;
  return 1;
}

/** Measure `target` (Element or Range), skipping zero-size leading rects on multi-line Ranges. */
export function targetBox(target) {
  if (!target) return null;
  if (typeof target.getClientRects === 'function') {
    const rects = [...target.getClientRects()].filter(r => r && (r.width > 0 || r.height > 0));
    if (rects.length) {
      const top = Math.min(...rects.map(r => r.top));
      const bottom = Math.max(...rects.map(r => r.bottom));
      return { top, bottom, height: bottom - top };
    }
  }
  const rect = target.getBoundingClientRect?.();
  if (!rect) return null;
  const height = rect.height ?? ((rect.bottom ?? rect.top) - rect.top);
  return { top: rect.top, bottom: rect.bottom ?? (rect.top + height), height };
}

/** Model `.topbar`'s height and bottom offset (in unzoomed scroller CSS px) at any `scrollTop`. */
function topbarModel(app, scroller, scrollerTopScreen, isDoc, scale) {
  const topbar = app?.querySelector?.('.topbar') ?? null;
  const hasTopbar = Boolean(topbar && (isDoc || !scroller.contains || scroller.contains(topbar)));
  if (!hasTopbar) return { max: 0, at: () => 0 };
  const topbarRect = topbar.getBoundingClientRect?.();
  if (!topbarRect) return { max: 0, at: () => 0 };
  const appRect = app?.getBoundingClientRect?.();
  const appTopScreen = (appRect?.top ?? scrollerTopScreen) + (app?.clientTop || 0) * scale;
  const topbarH = Math.max(0, Math.round((topbarRect.height ?? (topbarRect.bottom - topbarRect.top)) / scale));
  const pos = (typeof getComputedStyle === 'function' ? getComputedStyle(topbar)?.position : null) || 'sticky';
  const scrollNow = scroller.scrollTop || 0;
  if (pos === 'fixed') {
    const cur = Math.max(0, Math.round((topbarRect.bottom - appTopScreen) / scale));
    return { max: Math.max(topbarH, cur), at: () => cur };
  }
  if (pos === 'sticky') {
    const parentRect = topbar.parentElement?.getBoundingClientRect?.();
    if (parentRect && Number.isFinite(parentRect.bottom)) {
      const parentBottomAt0 = scrollNow + (parentRect.bottom - appTopScreen) / scale;
      return { max: topbarH, at: scrollTop => Math.max(0, Math.min(topbarH, Math.round(parentBottomAt0 - scrollTop))) };
    }
    const cur = Math.max(0, Math.round((topbarRect.bottom - appTopScreen) / scale));
    return { max: Math.max(topbarH, cur), at: () => cur };
  }
  const bottomAt0 = scrollNow + (topbarRect.bottom - appTopScreen) / scale;
  return { max: topbarH, at: scrollTop => Math.max(0, Math.min(topbarH, Math.round(bottomAt0 - scrollTop))) };
}

/**
 * Compute the target `scrollTop` for `target` (Element or Range) so it lands cleanly below `.topbar` + `.book-bar`
 * at the destination scroll position (never using an unstuck `.book-bar` rect from `scrollTop === 0`, never
 * ignoring `.topbar` re-appearing when scrolling up, and converting zoomed `getBoundingClientRect()` coordinates
 * back to `scroller.scrollTop` CSS px). When `center` is true, centers within the remaining viewport below the
 * sticky bar, clamped so a tall target's top never hides behind the sticky bar.
 */
export function scrollTargetTop({ target, scroller, page = null, margin = 16, center = false } = {}) {
  const targetRect = targetBox(target);
  if (!scroller || !targetRect) return null;
  const isDoc = typeof document !== 'undefined' && scroller === document.scrollingElement;
  const scale = isDoc ? 1 : zoomScale(scroller);
  const scrollerRect = isDoc ? null : scroller.getBoundingClientRect?.();
  const scrollerTopScreen = (scrollerRect?.top ?? 0) + (scroller.clientTop || 0) * scale;
  const scrollerHeight = isDoc ? (typeof window !== 'undefined' ? window.innerHeight : 0)
    : (scroller.clientHeight || (scrollerRect ? scrollerRect.height / scale : 0) || 0);
  const scrollNow = scroller.scrollTop || 0;
  const targetTopAt0 = scrollNow + (targetRect.top - scrollerTopScreen) / scale;
  const targetHeight = targetRect.height / scale;
  const bar = page ? stickBar(page) : null;
  const hasBar = Boolean(bar && (isDoc || !scroller.contains || scroller.contains(bar)));
  const barRect = hasBar ? bar.getBoundingClientRect?.() : null;
  const rawBarH = barRect ? (barRect.height ?? (barRect.top !== undefined ? barRect.bottom - barRect.top : undefined)) : undefined;
  const barH = rawBarH !== undefined && Number.isFinite(rawBarH) ? rawBarH / scale : undefined;
  const app = (hasBar ? bar : page)?.closest?.('.study-app, .study-seat')
    ?? (scroller?.matches?.('.study-app, .study-seat') ? scroller : null);
  const topbar = topbarModel(app, scroller, scrollerTopScreen, isDoc, scale);

  const landingFor = stickTop => {
    let underOffset;
    if (hasBar && barRect) {
      const barBottom = barH !== undefined ? stickTop + barH : Math.max(0, (barRect.bottom - scrollerTopScreen) / scale);
      underOffset = Math.max(12, barBottom + margin);
    } else if (topbar.max > 0) {
      underOffset = Math.max(24, stickTop + margin);
    } else {
      underOffset = Math.max(24, margin);
    }
    if (center && scrollerHeight > 0) {
      const avail = Math.max(0, scrollerHeight - underOffset);
      return underOffset + Math.max(0, (avail - targetHeight) / 2);
    }
    return underOffset;
  };

  const withoutTopbar = Math.max(0, targetTopAt0 - landingFor(0));
  if (topbar.max === 0 || topbar.at(withoutTopbar) === 0) return withoutTopbar;
  return Math.max(0, targetTopAt0 - landingFor(topbar.max));
}

/** Scroll `element` into view cleanly below `.topbar` + `.book-bar` (centering within the usable viewport when `center` is true). */
export function scrollUnderBar(element, { center = true, margin = 16, behavior = 'instant' } = {}) {
  if (!element) return false;
  const page = element.closest?.('.book-page') ?? null;
  const scroller = scrollerOf(element);
  const nextTop = scrollTargetTop({ target: element, scroller, page, margin, center });
  if (nextTop !== null && typeof scroller?.scrollTo === 'function') {
    scroller.scrollTo({ top: nextTop, behavior });
    if (page) stickBar(page);
    return true;
  }
  element.scrollIntoView?.({ block: center ? 'center' : 'start', behavior });
  return true;
}

/** The place written for the next visit, from what was last measured: measure() reads the heading being read and where it is on screen (null when it is not
    drawn: keeps the last one), write() writes that last measure without touching the page, save() does both, keep(place) writes a place found another way
    (the way back to practice) and makes it the last one, so a write on leaving does not put an older measure back; until resume() (the learner scrolls again) nothing
    is measured over it: a save already on its way while the page leaves reads another heading, and in 整章连着读 that one lands with the point left folded. */
export function placeKeeper(read, write) {
  let last = null, kept = false;
  return {
    measure() { const next = kept ? null : read(); if (next) last = next; return last; },
    write() { if (last) write(last); },
    save() { this.measure(); this.write(); },
    keep(place) { last = place; kept = true; write(place); },
    resume() { kept = false; },
  };
}

/** The folds (本节的题, 要点清单...) open in a point, by their place in it: the page is only as long as they make it, so the way back opens them again before it lands. */
const foldsOpen = point => (point ? [...point.querySelectorAll('details')].flatMap((fold, at) => (fold.open ? [at] : [])) : []);

/** A landing stays put while the page around it is still arriving: what is drawn late above the heading (备考计划 and the page-limit line wait for their answers, the
    page's first frame may still move) pushes it down without a scroll. The page's size is watched, not the page, and only until the learner moves or HOLD_FOR has
    passed. Each move is put right before it is painted. `at`: the heading's distance from the top of the window; a page not yet long enough for it gets there when it
    grows. -> stop(). */
export function holdPlace(element, page, at) {
  const check = () => {
    if (!element.isConnected) { stop(); return; }
    const scroller = scrollerOf(element);
    if (!scroller) return;
    const isDoc = typeof document !== 'undefined' && scroller === document.scrollingElement;
    const scale = isDoc ? 1 : zoomScale(scroller);
    const off = element.getBoundingClientRect().top - at;
    if (Math.abs(off) > HOLD_WITHIN * scale) instant(scroller, Math.max(0, scroller.scrollTop + off / scale));
  };
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
  const frame = requestAnimationFrame(check), timer = setTimeout(() => stop(), HOLD_FOR);
  function stop() {
    cancelAnimationFrame(frame); clearTimeout(timer); sizes?.disconnect();
    for (const type of LEARNER_MOVES) window.removeEventListener(type, stop, { capture: true });
  }
  sizes?.observe(page);
  for (const type of LEARNER_MOVES) window.addEventListener(type, stop, { capture: true, passive: true });
  return stop;
}

/** -> { kept (what the page was handed at mount), open, toggleChapter, here, stepAt, current, goTo(id), go(delta), switchReading(mode), remember(hid, from), hold() }. */
export function useBookPlace({ root, course, book, rows, toc, steps, chapters, reading, pageRef, active }) {
  const [open, setOpen] = useState(() => new Set());
  const [here, setHere] = useState(null);
  const [stepHid, setStepHid] = useState(null);
  const [kept] = useState(() => keptBook(root, course));
  const restore = useRef(null), first = useRef(kept), placed = useRef(false), holding = useRef(null);
  const stepAt = Math.max(0, steps.findIndex(step => step.hid === stepHid));
  // The point the bar counts: the one shown, or in 整章连着读 the one the heading being read is in.
  const current = reading.mode === 'step' ? stepAt : Math.max(0, stepIndexOf(steps, toc, rows, here ?? ''));

  useEffect(() => {
    // Once: a book read again later (a save, a Q&A added, a write of the main chat) keeps the chapters open and the point shown.
    if (book?.status !== 'ok' || placed.current) return;
    placed.current = true;
    const given = first.current, wanted = given?.target ?? given?.heading, row = wanted ? rowOf(rows, wanted) : null;
    // A heading the learner typed is not in the manifest: its chapter is the one the way back kept with it, else the 目录's.
    const listed = !row && wanted ? toc.find(entry => entry.id === wanted) : null;
    const typed = listed ? given?.chapter ?? listed.chapter ?? null : null;
    // A heading that is gone (deleted while the learner practised): the point the way back kept, else its chapter, from its top; the start of the book only when those are gone too.
    const refuge = wanted && !row && !listed ? [given?.point, given?.chapter].map(id => id && rowOf(rows, id)).find(Boolean) ?? null : null;
    const landing = row ?? refuge;
    const chapter = landing ? chapters[landing.chapter]?.hid : typed ?? chapters[0]?.hid;
    setOpen(new Set(chapter ? [chapter] : []));
    const step = steps[Math.max(0, stepIndexOf(steps, toc, rows, landing?.hid ?? wanted ?? ''))];
    setStepHid(step?.hid ?? null);
    reading.only(step?.hid ?? null);
    // 逐节读 draws no chapter or section heading: their first point is shown instead.
    const shown = landing ? (reading.mode === 'step' && !landing.leaf ? step?.hid : landing.hid) : typed && wanted;
    setHere(shown ?? step?.hid ?? chapter ?? null);
    const back = !!given?.back && !given.target, same = back && !refuge;
    const hasSearchTarget = Boolean(given?.query || given?.snippet || Number.isInteger(given?.paragraphIndex));
    restore.current = shown ? { hid: shown, offset: given?.target || refuge ? null : given?.offset ?? null, point: same ? given.point : null, folds: same ? given.folds : null, focus: back, land: !hasSearchTarget } : null;
    first.current = null;
    keepBook(root, course, { target: null, back: false, point: null, chapter: null, folds: null, paragraphIndex: null, query: '', snippet: '' });
  }, [book]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    // 逐节读's new point shows from its top (its path); in 翻看 a point is its row (`flip-<id>`); else its heading.
    const wanted = restore.current, page = pageRef.current, element = wanted && ((wanted.step && page?.querySelector(`[data-book-step="${CSS.escape(wanted.hid)}"]`))
      || document.getElementById(`book-${wanted.hid}`) || (!wanted.read && document.getElementById(`flip-${wanted.hid}`)));
    if (!element) return;
    restore.current = null;
    holding.current?.();
    holding.current = null;
    if (wanted.folds?.length) {
      const folds = [...(page?.querySelector(`[data-book-point="${CSS.escape(wanted.point)}"]`)?.querySelectorAll('details') ?? [])];
      for (const at of wanted.folds) if (folds[at]) folds[at].open = true;
    }
    // The page is still rising into place (shell.css page-in: a few pixels of translateY), which moves every rectangle measured below by what is left of it.
    element.closest('.page')?.getAnimations?.().forEach(animation => animation.finish());
    const scroller = scrollerOf(element);
    const isDoc = typeof document !== 'undefined' && scroller === document.scrollingElement;
    const scale = isDoc ? 1 : zoomScale(scroller);
    if (wanted.offset !== null && wanted.offset !== undefined) {
      instant(scroller, Math.max(0, scroller.scrollTop + (element.getBoundingClientRect().top - wanted.offset) / scale));
      stickBar(page);
    } else {
      // A jump: land the point cleanly under the sticky book bar at the destination scroll position (accounting for `.topbar` returning when scrolling up),
      // then sync the sticky bar and verify clearance before `holdPlace` captures the target `top`. One jump, not smooth.
      const nextTop = scrollTargetTop({ target: element, scroller, page, margin: 12 });
      if (nextTop !== null) instant(scroller, nextTop);
      const under = stickBar(page)?.getBoundingClientRect().bottom;
      const covered = under === undefined ? 0 : (under + 12 * scale - element.getBoundingClientRect().top) / scale;
      if (covered > 0) {
        instant(scroller, Math.max(0, scroller.scrollTop - covered));
        stickBar(page);
      }
    }
    if (wanted.focus) {
      // The app puts the focus on a page's heading after an arrival (ui/app/use-learning-navigation.js); this one is named so it is the one, and nothing scrolls.
      const heading = (wanted.point && document.getElementById(`book-${wanted.point}`)) || element;
      heading.setAttribute('data-return-focus', '');
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      setTimeout(() => heading.removeAttribute('data-return-focus'), 1500);
    }
    if (wanted.land && page) holding.current = holdPlace(element, page, wanted.offset ?? element.getBoundingClientRect().top);
  });
  useEffect(() => () => holding.current?.(), []);

  // 整章连着读: the heading being read is the highest one on screen of the open chapters (逐节读: the point shown, set where it changes).
  useEffect(() => {
    const scope = pageRef.current;
    if (!scope || reading.mode !== 'scroll' || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) seen.set(entry.target.dataset.bookHeading, entry.isIntersecting ? entry.boundingClientRect.top : null);
      const top = [...seen].filter(([, at]) => at !== null).sort((a, b) => a[1] - b[1])[0];
      if (top) setHere(top[0]);
    });
    scope.querySelectorAll('[data-book-heading]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [open, book, reading.mode, reading.expanded, pageRef]);

  // The place for the next visit: the heading being read and where it is on screen (above the window when the learner is deep in a long point).
  const live = useRef({});
  live.current = { id: reading.mode === 'step' ? stepHid : here, active };
  const keeper = useMemo(() => placeKeeper(() => {
    const { id, active: on } = live.current, element = on && placed.current && id ? document.getElementById(`book-${id}`) : null;
    return element ? { heading: id, offset: element.getBoundingClientRect().top } : null;
  }, place => keepBook(root, course, place)), [root, course]);
  useEffect(() => { keeper.save(); }, [stepHid, here, reading.mode, keeper]);
  useEffect(() => {
    let last = 0, timer = 0, frame = 0;
    const measure = () => { frame = 0; keeper.measure(); };
    const onScroll = () => {
      keeper.resume();
      if (!frame) frame = requestAnimationFrame(measure);
      const wait = last + SAVE_EVERY - Date.now();
      if (wait <= 0) { last = Date.now(); keeper.save(); } else if (!timer) timer = setTimeout(() => { timer = 0; last = Date.now(); keeper.save(); }, wait);
    };
    const onHide = () => { if (document.visibilityState === 'hidden') keeper.save(); };
    // Leaving (pagehide, or the page taken away: the sidebar) writes what the last scroll frame measured; React has removed the page by the time this runs.
    const onLeave = () => keeper.write();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onLeave);
    return () => {
      clearTimeout(timer); cancelAnimationFrame(frame); keeper.write();
      document.removeEventListener('scroll', onScroll, { capture: true }); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onLeave);
    };
  }, [keeper]);

  // The way back after practice: the heading just above the link (a typed heading too), where it was on screen, and the chapter that holds it.
  // Returns where the way back leads, as the practice page says it: the number and title of the point left ("1.2.2 Title"; '' when it is not in the 总纲).
  const remember = useCallback((hid, from) => {
    const placeOf = id => { const found = rowOf(rows, id); return found ? [found.number, found.title].filter(Boolean).join(' ') : ''; };
    // From 翻看: its row of the point, where it was on screen.
    const flipPoint = from?.closest?.('[data-flip-point]');
    if (flipPoint) {
      const id = flipPoint.dataset.flipPoint, row = rowOf(rows, id);
      keeper.keep({ heading: id, offset: flipPoint.querySelector(`#flip-${CSS.escape(id)}`)?.getBoundingClientRect().top ?? 0, target: null,
        chapter: row ? chapters[row.chapter]?.hid ?? null : null, point: id });
      return placeOf(id);
    }
    const headings = from && pageRef.current ? [...pageRef.current.querySelectorAll('[data-book-heading]')].filter(item => item.compareDocumentPosition(from) & 4) : [];
    const element = headings.at(-1) || document.getElementById(`book-${hid}`), row = rowOf(rows, hid);
    // The point is the one the link is in, which a heading the learner typed inside its text does not change.
    const point = from?.closest?.('[data-book-point]')?.dataset.bookPoint || hid;
    const body = pageRef.current?.querySelector(`[data-book-point="${CSS.escape(point)}"]`);
    keeper.keep({ heading: element?.dataset.bookHeading || hid, offset: element ? element.getBoundingClientRect().top : 0, target: null,
      chapter: row ? chapters[row.chapter]?.hid ?? null : null, point, folds: foldsOpen(body) });
    return placeOf(point) || placeOf(hid);
  }, [keeper, rows, chapters, pageRef]);

  // A heading of the 目录 (or of 速查页, 翻看, 今天读哪几节): its chapter opens and its point with it; 逐节读 shows that point (a chapter or section: its first).
  const goTo = useCallback((id, options = {}) => {
    const entry = toc.find(item => item.id === id), step = steps[stepIndexOf(steps, toc, rows, id)], row = rowOf(rows, id);
    if (entry?.chapter) setOpen(current => new Set([...current, entry.chapter]));
    if (step) { setStepHid(step.hid); reading.only(step.hid); }
    // 逐节读 draws no chapter or section heading: their first point is shown instead.
    const shown = reading.mode === 'step' && step && row && !row.leaf ? step.hid : id;
    restore.current = { hid: shown, offset: null, land: options.hold !== false };
    setHere(shown);
  }, [toc, steps, rows, reading]);
  // ‹ › and ← →: the point before or after the one being read, shown from its top (整章连着读: opened in its chapter).
  const go = useCallback(delta => {
    const next = steps[current + delta];
    if (!next) return;
    if (reading.mode !== 'step') { goTo(next.hid); return; }
    setStepHid(next.hid);
    setHere(next.hid);
    restore.current = { hid: next.hid, offset: null, step: true };
  }, [steps, current, reading.mode, goTo]);
  // Switching how to read keeps the point being read: shown alone, or open in its chapter.
  const switchReading = useCallback(value => {
    const step = steps[current];
    if (step) {
      const row = rowOf(rows, step.hid), chapter = row ? chapters[row.chapter]?.hid : step.hid;
      setStepHid(step.hid);
      reading.only(step.hid);
      if (chapter) setOpen(c => new Set([...c, chapter]));
      restore.current = { hid: step.hid, offset: null, step: value === 'step' };
    }
    reading.setMode(value);
  }, [steps, current, rows, chapters, reading]);
  const toggleChapter = useCallback((hid, value) => setOpen(c => { const next = new Set(c); if (value) next.add(hid); else next.delete(hid); return next; }), []);
  // A book read again in place (what the main chat wrote), or the reading surface drawn again after the editor or 翻看: the heading being read stays (or
  // comes back) where it was on screen.
  const hold = useCallback(() => {
    const id = live.current.id, element = id && document.getElementById(`book-${id}`);
    // `read`: for the reading surface only (not a row of 翻看, which may be what is drawn until then).
    if (element) restore.current = { hid: id, offset: element.getBoundingClientRect().top, read: true };
  }, []);
  const stopHold = useCallback(() => {
    holding.current?.();
    holding.current = null;
  }, []);
  return { kept, open, toggleChapter, here, stepAt, current, goTo, go, switchReading, remember, hold, stopHold };
}
