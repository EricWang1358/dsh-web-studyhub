import { useCallback, useRef, useState } from 'react';
import { ANCHOR_WAIT_MS, findAnchor, locateAnchor } from '../tour/anchor.js';
import { opensFinder } from './keys.js';
import { planTrip, tripNotice } from './trip.js';

/* 找功能 (#653): opening the finder and what 「带我去」 does. The sheet (FinderSheet.jsx) only asks; this hook moves.

   The keys are read on the app's own root element (ui/App.jsx passes `onKeyDown`), never on window or document, so the keys of the DSH host stay the host's;
   the rules are ui/finder/keys.js (Ctrl K / ⌘K anywhere in the app, / outside a text field). Nothing opens while another dialog is up (the finder would sit on
   top of work in progress) or while the feature tour is running.

   A trip, step by step (ui/finder/trip.js decides where to stand and what to say):
     1. the control is on this page already: light it;
     2. otherwise go to the page: a settings anchor is a settings link (it selects the category), any other page is nav.navigate, as the tour does it;
     3. wait for the anchor (the tour's ANCHOR_WAIT_MS), opening the <details> around it (ui/tour/anchor.js locateAnchor);
     4. scroll it to the middle of the view, put the focus on it (or its first focusable part) and draw the one-shot ring (FinderRing.jsx);
     5. say in a toast where the control is when it could not simply be lit. */

/** A fold that was opened draws its content over the length of --dur-slow: the control is scrolled to after that, not while it is still moving. */
const FOLD_SETTLE_MS = 350;
const frames = (count) => new Promise((resolve) => { const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1))); step(count); });
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const TEXT_TARGET = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/** The element itself when it can take the focus, else its first part that can; a plain block takes it for the moment (tabindex -1). */
export function focusTarget(element) {
  const part = element.matches(FOCUSABLE) ? element : element.querySelector(FOCUSABLE);
  if (part) { part.focus({ preventScroll: true }); return part; }
  element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: true });
  return element;
}

/** Poll `look()` until it gives something, `timeout` ms pass or `aborted()` (a newer trip started). */
const waitFor = (look, timeout, aborted) => new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    if (aborted()) { resolve(null); return; }
    const hit = look();
    if (hit || Date.now() - started >= timeout) { resolve(hit || null); return; }
    setTimeout(tick, 80);
  };
  tick();
});

export function useFinder({ nav, settingsEntry, core, tour, rootRef }) {
  const [open, setOpen] = useState(false), [ring, setRing] = useState(null);
  const trip = useRef(0), latest = useRef({});
  latest.current = { page: nav.page, touring: !!tour.tourStep, open };
  const { notify } = core, { navigate } = nav, { openSettings } = settingsEntry, { startTour } = tour;

  const openFinder = useCallback(() => {
    if (latest.current.touring) return;
    setRing(null);
    setOpen(true);
  }, []);
  const closeFinder = useCallback(() => setOpen(false), []);
  const clearRing = useCallback(() => setRing(null), []);

  /** The root's key handler. */
  const onKeyDown = useCallback((event) => {
    if (event.defaultPrevented) return;
    if (!opensFinder(event.nativeEvent || event, { typing: !!event.target.closest?.(TEXT_TARGET) })) return;
    // Open already: Ctrl K must not reach the browser, and nothing else opens. Another dialog: the keys are that dialog's.
    if (latest.current.open) { event.preventDefault(); return; }
    if (latest.current.touring || rootRef.current?.querySelector('dialog[open]')) return;
    event.preventDefault();
    openFinder();
  }, [openFinder, rootRef]);

  /** 带我去. */
  const go = useCallback(async (entry) => {
    setOpen(false);
    setRing(null);
    const mine = ++trip.current, aborted = () => trip.current !== mine;
    const root = rootRef.current, plan = planTrip(entry, { page: latest.current.page });
    let hit = plan.here ? locateAnchor(root, entry.anchors) : null, linked = false;
    if (!hit) {
      if (plan.settings) { openSettings(plan.settings); linked = true; }
      else if (plan.land) navigate(plan.land, { keepTrail: false, enter: 'tour', scroll: true });
      hit = await waitFor(() => locateAnchor(root, entry.anchors), ANCHOR_WAIT_MS, aborted);
    }
    if (aborted()) return;
    const notice = tripNotice(entry, hit ? hit.index : -1);
    if (hit) {
      // The fold we opened has told its page by now (its toggle event); the page draws what it holds. Settings scrolls to its own anchor (unless the control sat in a fold we opened).
      await frames(2);
      if (hit.opened && !reducedMotion()) await new Promise((resolve) => setTimeout(resolve, FOLD_SETTLE_MS));
      if (aborted()) return;
      const element = hit.element.isConnected ? hit.element : findAnchor(root, entry.anchors);
      if (element) {
        // Settings scrolls to the anchor of its own link, but not when the page was already there (no link) and not to a control inside a fold it could not see yet (hit.opened).
        if (!linked || hit.opened) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
        focusTarget(element);
        setRing({ key: mine, resolve: () => (element.isConnected ? element : findAnchor(root, entry.anchors)) });
      }
    }
    if (notice) notify(notice);
  }, [rootRef, navigate, openSettings, notify]);

  /** The empty state's way on: the feature tour. */
  const startFinderTour = useCallback(() => { setOpen(false); startTour(); }, [startTour]);

  return { open, ring, openFinder, closeFinder, clearRing, onKeyDown, go, startTour: startFinderTour };
}
