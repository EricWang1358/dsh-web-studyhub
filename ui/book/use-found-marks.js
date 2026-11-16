import { useEffect, useRef } from 'react';
import { findRanges, paintMatches } from '../document-preview/reader/find.js';
import { stickBar } from './BookBar.jsx';
import { scrollerOf } from './use-book-place.js';

/* The words 在书里找 or full-text search went to (#489), marked on the page with the reader's highlight (ui/document-preview/reader/find.js) and paragraph wash
   while their point is drawn: the matched paragraph is smoothly scrolled under the book bar once, opening any enclosing <details> or folded AI blocks first.
   Stepping to another point drops the search's marks (onGone). */

const BLOCK_SELECTOR = '.book-file p, .book-file li, .book-file blockquote, .book-file pre, .book-point__gist';
const CLOSEST_BLOCK = 'p, li, blockquote, pre, tr, .book-card, .book-point__gist';

const rootOf = (page, hid) => page?.querySelector(`[data-book-step="${CSS.escape(hid)}"]`) ?? document.getElementById(`book-${hid}`)?.closest('.book-node, .book-chapter') ?? null;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const cleanSnippetNeedle = snippet => String(snippet ?? '').replace(/^[….…\s]+|[….…\s]+$/g, '').trim();

/** Open every enclosing `<details>` inside `root` around `element` so its bounding box can be measured and scrolled into view. */
export function openEnclosingDetails(root, element) {
  let opened = false;
  for (let fold = element?.closest?.('details'); fold && (!root || root.contains(fold)); fold = fold.parentElement?.closest?.('details')) {
    if (!fold.open) {
      fold.open = true;
      opened = true;
    }
  }
  return opened;
}

/** Resolve the target paragraph element and active text range index for `{ query?, snippet?, paragraphIndex? }` inside `root`. */
export function resolveBookSearchTarget(root, found, ranges = []) {
  if (!root || !found) return { block: null, activeIndex: 0 };
  const paragraphs = [...root.querySelectorAll(BLOCK_SELECTOR)];
  const hasIndex = Number.isInteger(found.paragraphIndex) && found.paragraphIndex >= 0;
  const indexedBlock = hasIndex && paragraphs.length ? paragraphs[Math.min(found.paragraphIndex, paragraphs.length - 1)] : null;
  if (ranges.length) {
    if (indexedBlock) {
      const withinIdx = ranges.findIndex(range => indexedBlock.contains(range.startContainer));
      if (withinIdx >= 0) return { block: indexedBlock, activeIndex: withinIdx };
    }
    const rangeParent = ranges[0].startContainer?.nodeType === 1 ? ranges[0].startContainer : ranges[0].startContainer?.parentElement;
    return { block: rangeParent?.closest?.(CLOSEST_BLOCK) ?? indexedBlock ?? null, activeIndex: 0 };
  }
  return { block: indexedBlock, activeIndex: 0 };
}

/** found: { hid, query?, snippet?, paragraphIndex?, count?, nonce } or null; drawn: changes whenever what the page draws changes; aiFold: the page's fold. */
export function useFoundMarks({ found, drawn, pageRef, aiFold, stopHold, onGone }) {
  const landed = useRef(null);
  useEffect(() => {
    if (!found) return undefined;
    const root = rootOf(pageRef.current, found.hid);
    if (!root) { onGone(); return undefined; }
    const primaryQuery = String(found.query ?? '').trim();
    const fallbackNeedle = cleanSnippetNeedle(found.snippet);
    let ranges = primaryQuery ? findRanges(root, primaryQuery) : [];
    if (!ranges.length && fallbackNeedle) ranges = findRanges(root, fallbackNeedle);
    const expectedCount = Number.isInteger(found.count) ? found.count : (primaryQuery || fallbackNeedle ? 1 : 0);
    if (ranges.length < expectedCount) {
      const folded = [...root.querySelectorAll('[data-ai-block][data-ai-folded]')].map(block => block.dataset.aiBlock);
      if (folded.length && aiFold) { aiFold.foldAll(folded, false); return undefined; }
    }
    const { block, activeIndex } = resolveBookSearchTarget(root, found, ranges);
    const clearRanges = ranges.length ? paintMatches(ranges, activeIndex) : () => {};
    if (block) block.setAttribute('data-book-search-hit', '');
    if (landed.current !== found.nonce && (ranges[activeIndex] || block)) {
      landed.current = found.nonce;
      stopHold?.();
      const anchorNode = ranges[activeIndex]?.startContainer?.parentElement ?? block;
      openEnclosingDetails(root, anchorNode);
      const scroller = scrollerOf(root);
      const scrollerTop = scroller === document.scrollingElement ? 0 : (scroller?.getBoundingClientRect?.().top ?? 0);
      const barBottom = stickBar(pageRef.current)?.getBoundingClientRect?.().bottom;
      const under = barBottom !== undefined ? Math.max(scrollerTop + 12, barBottom + 16) : scrollerTop + 24;
      const targetRect = (ranges[activeIndex] || block)?.getBoundingClientRect?.();
      if (scroller && targetRect) {
        const nextTop = Math.max(0, scroller.scrollTop + targetRect.top - under);
        scroller.scrollTo({ top: nextTop, behavior: reducedMotion() ? 'instant' : 'smooth' });
      }
    }
    return () => {
      clearRanges();
      if (block?.isConnected) block.removeAttribute('data-book-search-hit');
    };
  }, [found, drawn, aiFold, pageRef, stopHold, onGone]);
}
