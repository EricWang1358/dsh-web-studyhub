import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { PRACTICE_TIP } from '../guidance/practice-tips.js';
import { tipSpot } from './practice-tip-spot.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/* A first-use tip of the practice page (#948; the rule that picks one is ui/guidance/practice-tips.js, the hook that asks is ui/review/use-practice-tip.js).
   It is a small card in the top layer (a manual popover, like <Tooltip layer>) placed from the rectangle of the control it points at, so it pushes nothing: the toolbar,
   the 目标 panel and the question stay where they are. It never takes focus (the learner's next key still reaches the page: Enter or → for 下一题), 知道了 and Esc close it,
   and it steps aside while a menu or the tag tray is open and never lies on 更多 / 上一题 / 下一题 (practice-tip-spot.js). No motion, so nothing to reduce. */

/** The control each tip points at (the usage name it already carries) and the tip's words (Chinese source text, English in ui/locales/en.practice.json). */
export const PRACTICE_TIP_TARGET = Object.freeze({
  [PRACTICE_TIP.help]: { control: '[data-usage="review.help"]', words: '没懂？点「帮我弄懂」，讲解会直接出现在这道题下面。' },
  [PRACTICE_TIP.fix]: { control: '[data-usage="review.improve"]', words: '觉得题目本身有问题？点「修题」，助教会直接改这张卡；改完在信箱里一步就能撤销。' },
  [PRACTICE_TIP.prereq]: { control: '[data-usage="review.derive-prereq"]', words: '这一点基础不牢？点「出成前置题」，它会在同一题组里变成一道更基础的题，练完再回到这道题。' },
});
const AVOID = '.question-navigation button';
const YIELD_TO = '.thumb-tray, .sh-menu';
const BAR_HEIGHT = 56; // the top bar: a control under it is not on screen
const MESSAGE = '.action-feedback-slot > *'; // the page's own message of what the learner just did (a vote, a saved note): the tip goes under it, not over it

const visible = element => element.getClientRects().length > 0;

export default function PracticeTip({ id, onClose, onShown }) {
  const element = useRef(null);
  const latest = useRef({});
  latest.current = { onClose, onShown };
  const { control, words } = PRACTICE_TIP_TARGET[id];
  useIsoLayoutEffect(() => {
    const card = element.current;
    if (!card) return undefined;
    let frame = 0, reported = false;
    const open = () => card.matches?.(':popover-open');
    const hide = () => { if (open()) card.hidePopover(); };
    const place = () => {
      frame = 0;
      const target = [...document.querySelectorAll(control)].find(visible), at = target?.getBoundingClientRect();
      // Only next to a control that is on screen (a link far down the page waits until the learner scrolls to it), and not on top of an open menu or the tray.
      if (!at || at.top < BAR_HEIGHT || at.bottom > window.innerHeight || document.querySelector(YIELD_TO)) { hide(); return; }
      const message = [...document.querySelectorAll(MESSAGE)].find(visible)?.getBoundingClientRect();
      const anchor = message && message.top >= at.bottom - 2 && message.top < at.bottom + 40 ? { left: at.left, right: at.right, top: at.top, bottom: message.bottom } : at;
      card.style.visibility = 'hidden';
      if (card.showPopover && !open()) card.showPopover();
      // Top-layer coordinates are the window's, through the interface zoom (the way <Tooltip layer> measures).
      const box = card.getBoundingClientRect(), scale = card.offsetWidth ? box.width / card.offsetWidth : 1;
      const spot = tipSpot({ anchor, size: { width: box.width, height: box.height },
        bounds: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
        avoid: [...document.querySelectorAll(AVOID)].filter(visible).map(button => button.getBoundingClientRect()), gap: 4 * scale, margin: 8 * scale });
      card.style.left = `${spot.left / scale}px`;
      card.style.top = `${spot.top / scale}px`;
      card.style.visibility = '';
      if (!reported) { reported = true; latest.current.onShown?.(); }
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    // The question moves while it is answered (the options open one after another), when the page scrolls or the window changes, and a menu or the tray comes and goes.
    window.addEventListener('scroll', soon, true);
    window.addEventListener('resize', soon);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    observer?.observe(document.querySelector('.question-area') || document.body);
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    changes?.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon, true);
      window.removeEventListener('resize', soon);
      observer?.disconnect();
      changes?.disconnect();
      hide();
    };
  }, [control]);
  // Esc closes it from anywhere (it never has the focus); a menu or the tray that Esc closes first stops the event before it gets here.
  useEffect(() => {
    const key = event => { if (event.key === 'Escape' && !event.defaultPrevented) latest.current.onClose?.(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return (
    <div ref={element} popover="manual" role="status" className="practice-tip" data-practice-tip={id}>
      <p className="practice-tip__words">{ui(words)}</p>
      <Button size="sm" className="practice-tip__ok" onClick={event => {
        // A click leaves the keyboard on the page, not on a button that is about to go: Enter still means 下一题.
        if (event.detail > 0) event.currentTarget.closest('.study-app')?.focus({ preventScroll: true });
        onClose?.();
      }}>{ui('知道了')}</Button>
    </div>
  );
}
