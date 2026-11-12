import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { PRACTICE_TIP } from '../guidance/practice-tips.js';
import { tipSpot } from './practice-tip-spot.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/* A first-use tip of the practice page (#948; the rule that picks one is ui/guidance/practice-tips.js, the hook that asks is ui/review/use-practice-tip.js).
   It is a small card in the top layer (a manual popover, like <Tooltip layer>) placed from the rectangle of the control it points at, so it pushes nothing: the toolbar,
   the 目标 panel and the question stay where they are. It never takes focus (the learner's next key still reaches the page: Enter or → for 下一题), 知道了 and Esc close it,
   and it steps aside while a menu or the tag tray is open. It lies over empty space only: where it goes is chosen from the boxes of everything the learner reads or presses
   (practice-tip-spot.js; no free slot, no tip yet), and the control it is about carries a quiet outline while it is open. No motion, so nothing to reduce. */

/** The control each tip points at (the usage name it already carries) and the tip's words (Chinese source text, English in ui/locales/en.practice.json). */
export const PRACTICE_TIP_TARGET = Object.freeze({
  [PRACTICE_TIP.help]: { control: '[data-usage="review.help"]', words: '没懂？点「帮我弄懂」，讲解会直接出现在这道题下面。' },
  [PRACTICE_TIP.fix]: { control: '[data-usage="review.improve"]', words: '觉得题目有问题？点「修题」，助教直接改这张卡，改完在信箱里能一步撤销。' },
  [PRACTICE_TIP.prereq]: { control: '[data-usage="review.derive-prereq"]', words: '基础不牢？点「出成前置题」，在同一题组里补一道更基础的题，练完再回到这道题。' },
});
export const PRACTICE_TIP_YIELD_TO = '.thumb-tray, .sh-menu, .shortcut-sheet';
export const PRACTICE_TIP_DWELL_MS = 1500;
const BAR_HEIGHT = 56; // the top bar: a control under it is not on screen
const NARROW = 300; // the narrower card tried when the wide one cannot pass a button at the side
const RING = 'data-practice-tip-ring'; // the control the open tip is about gets a quiet outline (review.css); the tip may sit a little away from it
const CONTROLS = 'button, a[href], summary, input, textarea, select, [role="button"]';

const visible = element => element.getClientRects().length > 0;
/** Drawn at all: the text inside a closed <details> still has boxes, but is not on screen (checkVisibility knows; a browser without it counts everything as drawn). */
const drawn = element => element.checkVisibility?.() !== false;
const union = rects => rects.reduce((all, r) => ({ left: Math.min(all.left, r.left), top: Math.min(all.top, r.top), right: Math.max(all.right, r.right), bottom: Math.max(all.bottom, r.bottom) }));

/** The row (the buttons of `group`, with the control itself) and the block (`bar`, the whole toolbar, or the group) a tip is placed against. */
function originOf(group, at, bar) {
  const row = union([...group.querySelectorAll('button')].filter(visible).map(button => button.getBoundingClientRect()).concat(at));
  return { row, block: (bar ?? group).getBoundingClientRect() };
}

/** What the learner reads or presses on the question's column right now: every line of text, every button and field, and the divider above the explanation. The tip lies over none of it. */
function keepClear(area, card) {
  const boxes = [], range = document.createRange(), walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim() || card.contains(node) || !drawn(node.parentElement)) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < window.innerHeight) boxes.push(r);
  }
  for (const element of area.querySelectorAll(CONTROLS)) if (!card.contains(element) && visible(element) && drawn(element)) boxes.push(element.getBoundingClientRect());
  const explanation = area.querySelector('.explanation');
  if (explanation && visible(explanation)) { const r = explanation.getBoundingClientRect(); boxes.push({ left: r.left, right: r.right, top: r.top - 1, bottom: r.top + 2 }); }
  return boxes;
}

export default function PracticeTip({ id, onClose, onShown }) {
  const element = useRef(null);
  const visibleNow = useRef(false);
  const latest = useRef({});
  latest.current = { onClose, onShown };
  const { control, words } = PRACTICE_TIP_TARGET[id];
  useIsoLayoutEffect(() => {
    const card = element.current;
    if (!card) return undefined;
    let frame = 0, reported = false, ringed = null, dwellTimer = 0;
    // Its own question only: another question may be on the page too (the reader's 本节题目 round over the practice page, #1013).
    const scope = card.closest('.review-body') || document;
    const open = () => card.matches?.(':popover-open');
    const clearDwell = () => { if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = 0; } };
    const ring = target => { if (ringed !== target) { ringed?.removeAttribute(RING); target?.setAttribute(RING, ''); ringed = target; } };
    const hide = () => { visibleNow.current = false; clearDwell(); ring(null); if (open()) card.hidePopover(); };
    const measure = () => { const box = card.getBoundingClientRect(); return { width: box.width, height: box.height }; };
    const place = () => {
      frame = 0;
      const target = [...scope.querySelectorAll(control)].find(visible), at = target?.getBoundingClientRect();
      // Only next to a control that is on screen (a link far down the page waits until the learner scrolls to it), and not on top of an open menu, sheet or tray.
      if (!at || at.top < BAR_HEIGHT || at.bottom > window.innerHeight || document.querySelector(PRACTICE_TIP_YIELD_TO)) { hide(); return; }
      card.style.visibility = 'hidden';
      card.style.maxWidth = '';
      if (card.showPopover && !open()) card.showPopover();
      // Top-layer coordinates are the window's, through the interface zoom (the way <Tooltip layer> measures).
      const wide = measure(), scale = card.offsetWidth ? wide.width / card.offsetWidth : 1;
      card.style.maxWidth = `${NARROW}px`;
      const narrow = measure();
      card.style.maxWidth = '';
      const area = target.closest('.question-area') || document.body, clear = keepClear(area, card);
      const where = { sizes: [wide, narrow], keepClear: clear, bounds: { left: 0, top: BAR_HEIGHT, right: window.innerWidth, bottom: window.innerHeight }, gap: 4 * scale, margin: 8 * scale, pad: 2 * scale };
      // The tip goes next to its control; a link far from the toolbar (出成前置题, down in the answer) may also use the toolbar's free band while both are on screen,
      // the ring on the link says which control it is about.
      let spot = tipSpot({ anchor: at, ...originOf(target.closest('.question-tools, .followup-derive'), at, target.closest('.question-toolbar')), ...where });
      const bar = scope.querySelector('.question-toolbar'), tools = bar?.querySelector('.question-tools');
      if (!spot && bar && tools && !bar.contains(target)) spot = tipSpot({ anchor: tools.getBoundingClientRect(), ...originOf(tools, tools.getBoundingClientRect(), bar), ...where });
      // Nothing free: nothing is drawn now, and the control is not marked; a scroll or a message that goes away asks again.
      if (!spot) { hide(); return; }
      if (spot.size === narrow) card.style.maxWidth = `${NARROW}px`;
      card.style.left = `${spot.left / scale}px`;
      card.style.top = `${spot.top / scale}px`;
      card.style.visibility = '';
      ring(target);
      visibleNow.current = true;
      if (!reported && !dwellTimer) {
        dwellTimer = setTimeout(() => {
          dwellTimer = 0;
          if (visibleNow.current && !reported) { reported = true; latest.current.onShown?.(); }
        }, PRACTICE_TIP_DWELL_MS);
      }
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    // The question moves while it is answered (the options open one after another), when the page scrolls or the window changes, and a menu or the tray comes and goes.
    window.addEventListener('scroll', soon, true);
    window.addEventListener('resize', soon);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    observer?.observe(scope.querySelector('.question-area') || document.body);
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    changes?.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      clearDwell();
      window.removeEventListener('scroll', soon, true);
      window.removeEventListener('resize', soon);
      observer?.disconnect();
      changes?.disconnect();
      hide();
    };
  }, [control]);
  // Esc closes it from anywhere while it is actually visible (it never has the focus); a menu, sheet or tray that Esc closes first prevents default before it gets here.
  useEffect(() => {
    const key = event => {
      if (event.key === 'Escape' && visibleNow.current && !event.defaultPrevented && !document.querySelector(PRACTICE_TIP_YIELD_TO)) {
        event.preventDefault();
        latest.current.onClose?.();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return (
    <div ref={element} popover="manual" role="status" className="practice-tip" data-practice-tip={id}>
      <p className="practice-tip__words">{ui(words)}{' '}
        <Button size="sm" className="practice-tip__ok" onClick={event => {
          // A click leaves the keyboard on the page, not on a button that is about to go: Enter still means 下一题.
          if (event.detail > 0) event.currentTarget.closest('.study-app')?.focus({ preventScroll: true });
          onClose?.();
        }}>{ui('知道了')}</Button>
      </p>
    </div>
  );
}
