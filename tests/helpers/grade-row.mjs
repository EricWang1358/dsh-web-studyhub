/* global document, window, getComputedStyle, CSSContainerRule, CSSSupportsRule -- page.evaluate callbacks run in the browser */

/* A flipped flashcard's 0–5 grade row (ui/review/question.css .flash-follow.is-grading) in a real page: how it is painted where it sits, wherever the
   question is answered (the practice page, the reader's 本节题目). #1678 and its review: while it is stuck over the card it is opaque in the colour of the
   box it scrolls in and reaches that box's bottom edge (no strip of the card under it); where the card fits it paints nothing, so the card's shadow shows. */

const CLEAR = 'rgba(0, 0, 0, 0)';

/**
 * What an engine without scroll-state container queries draws (WebKit, so Safari and a macOS WKWebView; Firefox; Chromium before 133): its
 * `@container scroll-state(…)` rules never apply and its `@supports not (container-type: scroll-state)` ones do. Chromium cannot switch the feature off,
 * so the page's own parsed rules are rewritten that way.
 */
export const withoutScrollState = (page) => page.evaluate(() => {
  const rewrite = (owner) => {
    const rules = owner.cssRules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      const condition = rule.conditionText || '';
      if (rule instanceof CSSContainerRule && /scroll-state/.test(condition)) owner.deleteRule(i);
      else if (rule instanceof CSSSupportsRule && /scroll-state/.test(condition)) {
        const body = [...rule.cssRules].map((inner) => inner.cssText).join('\n');
        owner.deleteRule(i);
        if (/^\s*not\s/.test(condition)) owner.insertRule(`@media all { ${body} }`, i);
      } else if (rule.cssRules) rewrite(rule);
    }
  };
  for (const sheet of document.styleSheets) { try { rewrite(sheet); } catch { /* a sheet of another origin */ } }
});

/**
 * The grade row inside `within` (a selector; the page when left out), as the window shows it: whether it is stuck (it sits on the bottom edge of the box it
 * scrolls in), the colour it paints (its own box or the one inside it; 'none' when it paints nothing), the colour of that box, its height, and whether the
 * window shows the row (not the card) just above that box's bottom edge.
 */
export const gradeRowPaint = (page, within = null) => page.evaluate(([scope, clear]) => {
  const root = scope ? document.querySelector(scope) : document;
  const follow = root.querySelector('.flash-follow.is-grading');
  if (!follow) return null;
  let scroller = follow.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  scroller ||= document.scrollingElement;
  let surface = clear;
  for (let node = scroller; node && surface === clear; node = node.parentElement) surface = getComputedStyle(node).backgroundColor;
  const paints = [follow.firstElementChild, follow].map((node) => getComputedStyle(node).backgroundColor).find((colour) => colour !== clear) || 'none';
  const row = follow.getBoundingClientRect(), box = scroller.getBoundingClientRect();
  const edge = Math.min(box.bottom, window.innerHeight);
  const hit = document.elementFromPoint(row.left + row.width / 2, edge - 3);
  return { stuck: Math.abs(row.bottom - edge) <= 1, paints, surface, rowTop: Math.round(row.top), rowBottom: Math.round(row.bottom), height: Math.round(row.height),
    edge: Math.round(edge), vh: window.innerHeight, rowAtEdge: !!hit && follow.contains(hit) };
}, [within, CLEAR]);
