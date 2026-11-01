import { useEffect, useRef } from 'react';
import { findRanges, paintMatches } from '../document-preview/reader/find.js';
import { stickBar } from './BookBar.jsx';
import { scrollerOf } from './use-book-place.js';

/* The words 在书里找 went to (#489), marked on the page with the reader's highlight (ui/document-preview/reader/find.js: the page's text is never changed) while their point is drawn: the
   first one is brought under the book bar once, out of a closed fold if it is in one; a long AI block folded to one line has its text only when open, so this point's folded blocks open
   when the marks come up short. Stepping to another point drops the search's marks (onGone). */

const rootOf = (page, hid) => page?.querySelector(`[data-book-step="${CSS.escape(hid)}"]`) ?? document.getElementById(`book-${hid}`)?.closest('.book-node, .book-chapter') ?? null;

/** found: { hid, query, count, nonce } or null; drawn: changes whenever what the page draws changes (the point shown, the reading mode, the book); aiFold: the page's fold. */
export function useFoundMarks({ found, drawn, pageRef, aiFold, onGone }) {
  const landed = useRef(null);
  useEffect(() => {
    if (!found) return undefined;
    const root = rootOf(pageRef.current, found.hid);
    if (!root) { onGone(); return undefined; }
    const ranges = findRanges(root, found.query);
    if (ranges.length < found.count) {
      const folded = [...root.querySelectorAll('[data-ai-block][data-ai-folded]')].map(block => block.dataset.aiBlock);
      if (folded.length && aiFold) { aiFold.foldAll(folded, false); return undefined; }
    }
    const clear = paintMatches(ranges, 0);
    if (landed.current !== found.nonce && ranges[0]) {
      landed.current = found.nonce;
      const fold = ranges[0].startContainer.parentElement?.closest('details');
      if (fold) fold.open = true;
      const scroller = scrollerOf(root), under = (stickBar(pageRef.current)?.getBoundingClientRect().bottom ?? 0) + 12, top = ranges[0].getBoundingClientRect().top;
      if (top < under || top > window.innerHeight * 0.7) scroller.scrollTo({ top: scroller.scrollTop + top - under, behavior: 'instant' });
    }
    return clear;
  }, [found, drawn, aiFold, pageRef, onGone]);
}
