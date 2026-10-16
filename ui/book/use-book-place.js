import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepBook, keptBook, rowOf } from './model.js';
import { stepIndexOf } from './reading.js';
import { stickBar } from './BookBar.jsx';

/* Where the learner is in the review book (docs/review-book.md "Where you were"): the point shown (逐节读), the chapters open (整章连着读), the heading being
   read, and the place kept for the next visit. Landing: an entry's target (总纲, home, the way back from practice) > the place kept in this browser (ui/book/model.js
   keepBook: heading and offset per library and course) > the first point. The place is measured on every scroll frame and written when the point changes, at
   most every 500 ms while the page scrolls, when the page is hidden, and (that last measure) when the page goes away. The focus goes to a heading only on a real return from practice (`back`, set by the way back), never on a plain open. */

const SAVE_EVERY = 500;
const instant = (scroller, top) => scroller.scrollTo({ top, behavior: 'instant' });

/** The element that scrolls the page (the app's own scroller in the browser). */
export const scrollerOf = element => {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
};

/** The place written for the next visit, from what was last measured: measure() reads the heading being read and where it is on screen (null when it is not
    drawn: keeps the last one), write() writes that last measure without touching the page, save() does both, keep(place) writes a place found another way
    (the way back to practice) and makes it the last one, so a write on leaving does not put an older measure back. */
export function placeKeeper(read, write) {
  let last = null;
  return {
    measure() { const next = read(); if (next) last = next; return last; },
    write() { if (last) write(last); },
    save() { this.measure(); this.write(); },
    keep(place) { last = place; write(place); },
  };
}

/** -> { kept (what the page was handed at mount), open, toggleChapter, here, stepAt, current, goTo(id), go(delta), goIndex(index), switchReading(mode), remember(hid, from),
    hold() }. */
export function useBookPlace({ root, course, book, rows, toc, steps, chapters, reading, pageRef, active }) {
  const [open, setOpen] = useState(() => new Set());
  const [here, setHere] = useState(null);
  const [stepHid, setStepHid] = useState(null);
  const [kept] = useState(() => keptBook(root, course));
  const restore = useRef(null), first = useRef(kept), placed = useRef(false);
  const stepAt = Math.max(0, steps.findIndex(step => step.hid === stepHid));
  // The point the bar counts: the one shown, or in 整章连着读 the one the heading being read is in.
  const current = reading.mode === 'step' ? stepAt : Math.max(0, stepIndexOf(steps, toc, rows, here ?? ''));

  useEffect(() => {
    // Once: a book read again later (a save, a Q&A added, a write of the main chat) keeps the chapters open and the point shown.
    if (book?.status !== 'ok' || placed.current) return;
    placed.current = true;
    const given = first.current, wanted = given?.target ?? given?.heading, row = wanted ? rowOf(rows, wanted) : null;
    // A heading the learner typed is not in the manifest: its chapter is the one the way back kept with it, else the 目录's.
    const typed = !row && wanted ? given?.chapter ?? toc.find(entry => entry.id === wanted)?.chapter ?? null : null;
    const chapter = row ? chapters[row.chapter]?.hid : typed ?? chapters[0]?.hid;
    setOpen(new Set(chapter ? [chapter] : []));
    const step = steps[Math.max(0, stepIndexOf(steps, toc, rows, row?.hid ?? wanted ?? ''))];
    setStepHid(step?.hid ?? null);
    reading.only(step?.hid ?? null);
    setHere(row?.hid ?? (typed && wanted) ?? step?.hid ?? chapter ?? null);
    const back = !!given?.back && !given.target;
    restore.current = row || typed ? { hid: row?.hid ?? wanted, offset: given?.target ? null : given?.offset ?? null, point: back ? given.point : null, focus: back } : null;
    first.current = null;
    keepBook(root, course, { target: null, back: false, point: null, chapter: null });
  }, [book]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    // 逐节读's new point shows from its top (its path); in 翻看 a point is its row (`flip-<id>`); else its heading.
    const wanted = restore.current, page = pageRef.current, element = wanted && ((wanted.step && page?.querySelector(`[data-book-step="${CSS.escape(wanted.hid)}"]`))
      || document.getElementById(`book-${wanted.hid}`) || (!wanted.read && document.getElementById(`flip-${wanted.hid}`)));
    if (!element) return;
    restore.current = null;
    // The page is still rising into place (shell.css page-in: a few pixels of translateY), which moves every rectangle measured below by what is left of it.
    element.closest('.page')?.getAnimations?.().forEach(animation => animation.finish());
    const scroller = scrollerOf(element), top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    if (wanted.offset !== null && wanted.offset !== undefined) instant(scroller, scroller.scrollTop + element.getBoundingClientRect().top - wanted.offset);
    else {
      // A jump: the point just under the book bar, which sticks once the page has scrolled (put where it sticks now and measured after the first move: the
      // app's top bar may have come back or gone). One jump, not smooth.
      instant(scroller, scroller.scrollTop + element.getBoundingClientRect().top - top);
      const under = stickBar(page)?.getBoundingClientRect().bottom;
      const covered = under === undefined ? 0 : under + 12 - element.getBoundingClientRect().top;
      if (covered > 0) instant(scroller, scroller.scrollTop - covered);
    }
    if (wanted.focus) {
      // The app puts the focus on a page's heading after an arrival (ui/app/use-learning-navigation.js); this one is named so it is the one, and nothing scrolls.
      const heading = (wanted.point && document.getElementById(`book-${wanted.point}`)) || element;
      heading.setAttribute('data-return-focus', '');
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      setTimeout(() => heading.removeAttribute('data-return-focus'), 1500);
    }
  });

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
    keeper.keep({ heading: element?.dataset.bookHeading || hid, offset: element ? element.getBoundingClientRect().top : 0, target: null,
      chapter: row ? chapters[row.chapter]?.hid ?? null : null, point });
    return placeOf(point) || placeOf(hid);
  }, [keeper, rows, chapters, pageRef]);

  // A heading of the 目录 (its 今天 group too, or of 速查页, 翻看, 在书里找): its chapter opens and its point with it; 逐节读 shows that point (a chapter or section: its first).
  const goTo = useCallback(id => {
    const entry = toc.find(item => item.id === id), step = steps[stepIndexOf(steps, toc, rows, id)], row = rowOf(rows, id);
    if (entry?.chapter) setOpen(current => new Set([...current, entry.chapter]));
    if (step) { setStepHid(step.hid); reading.only(step.hid); }
    // 逐节读 draws no chapter or section heading: their first point is shown instead.
    const shown = reading.mode === 'step' && step && row && !row.leaf ? step.hid : id;
    restore.current = { hid: shown, offset: null };
    setHere(shown);
  }, [toc, steps, rows, reading]);
  // ‹ ›, ← → and a point's end button: the point at `index` (the page's order, ui/book/route.js), shown from its top (整章连着读: opened in its chapter).
  const goIndex = useCallback(index => {
    const next = steps[index];
    if (!next) return;
    if (reading.mode !== 'step') { goTo(next.hid); return; }
    setStepHid(next.hid);
    setHere(next.hid);
    restore.current = { hid: next.hid, offset: null, step: true };
  }, [steps, reading.mode, goTo]);
  const go = useCallback(delta => goIndex(current + delta), [goIndex, current]);
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
  return { kept, open, toggleChapter, here, stepAt, current, goTo, go, goIndex, switchReading, remember, hold };
}
