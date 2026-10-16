import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { findRanges, foldWithMap, paintMatches } from '../document-preview/reader/find.js';
import { bookCorpus, codeJump, findInBook } from './book-find.js';
import { scrollerOf } from './use-book-place.js';
import { stickBar } from './BookBar.jsx';

/* 在书里找 on the review book page (ui/book/BookFind.jsx in the 目录; docs/review-book.md "Find in the book"): the query, the matches of the whole book
   (ui/book/book-find.js), the one being shown, and the keys the reader uses: Ctrl+F while the book has the focus, and `/`; Enter / Shift+Enter step through
   the matches, Esc ends the search. Showing a match opens its point (and its AI block when it is folded), paints every match of that point with the reader's
   highlight (the Custom Highlight API: the page is never changed) and brings the one chosen into view under the book bar. */

// `/` is a key of whatever has the focus when it is a field or an editor (as ← / → are, ui/book/reading.js).
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor, dialog';

/** The folded text before `range` inside `scope`, spaces off: what the page shows just before a match (to find the one chosen in the list). */
const leadOf = (scope, range) => {
  const before = scope.ownerDocument.createRange();
  before.setStart(scope, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return foldWithMap(before.toString()).folded.replace(/ /g, '');
};

/** book, toc (ui/book/model.js tocEntries), goTo(id) (ui/book/use-book-place.js), aiFold (ui/book/ai-fold.js), pageRef; reveal(): makes the 目录 show (the column
    at wide widths, the slide-over on a narrow page) so its search field can take the focus.
    -> { query, setQuery, searching, total, hits, index, jump, step(delta), pick(index), goJump(), close(), open(), inputRef } */
export function useBookFind({ book, toc, goTo, aiFold, pageRef, reveal }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(-1);
  const deferred = useDeferredValue(query), searching = !!deferred.trim();
  const inputRef = useRef(null), clear = useRef(() => {}), pending = useRef(null);
  // The words of the book are gathered once per book, the first time something is looked for.
  const corpus = useRef({ book: null, list: null });
  const found = useMemo(() => {
    if (!searching || book?.status !== 'ok') return { total: 0, hits: [] };
    if (corpus.current.book !== book) corpus.current = { book, list: bookCorpus(book) };
    return findInBook(corpus.current.list, deferred);
  }, [book, deferred, searching]);
  const jump = useMemo(() => codeJump(toc, deferred), [toc, deferred]);
  const unpaint = useCallback(() => { clear.current(); clear.current = () => {}; }, []);
  useEffect(() => { setIndex(-1); unpaint(); }, [deferred, unpaint]);
  useEffect(() => unpaint, [unpaint]);

  // A match shown: its point opened (and its AI block, when folded), then painted once the page has drawn it.
  const show = useCallback(hit => {
    if (!hit) return;
    unpaint();
    if (hit.block && aiFold?.folded(hit.block, true)) flushSync(() => aiFold.fold(hit.block, false));
    pending.current = { ...hit, query: deferred, tries: 0 };
    goTo(hit.hid);
  }, [aiFold, deferred, goTo, unpaint]);
  useEffect(() => {
    if (!pending.current) return undefined;
    let frame = 0;
    const attempt = () => {
      const want = pending.current, page = pageRef.current;
      if (!want || !page) return;
      const point = page.querySelector(`[data-book-point="${CSS.escape(want.hid)}"]`);
      const scope = want.block ? point?.querySelector(`[data-ai-block="${CSS.escape(want.block)}"]:not([data-ai-folded])`) : point;
      if (!scope) { if (want.tries++ < 30) frame = requestAnimationFrame(attempt); else pending.current = null; return; }
      pending.current = null;
      // The point's matches (an AI block's own when the match is in one; the rest of the point's otherwise), the one whose words before it are the list's.
      const ranges = findRanges(scope, want.query).filter(range => want.block || !range.startContainer.parentElement?.closest('[data-ai-block]'));
      if (!ranges.length) return;
      const at = Math.max(0, ranges.findIndex(range => leadOf(scope, range).endsWith(want.lead)));
      for (let fold = ranges[at].startContainer.parentElement?.closest('details'); fold; fold = fold.parentElement?.closest('details')) fold.open = true;
      clear.current = paintMatches(ranges, at);
      // Into view a third of the way down the window, under the book bar (one jump, not smooth).
      const rect = ranges[at].getBoundingClientRect(), under = stickBar(page)?.getBoundingClientRect().bottom ?? 0;
      if (rect.top < under + 8 || rect.bottom > window.innerHeight - 24) {
        const scroller = scrollerOf(point);
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - under - (window.innerHeight - under) / 3, behavior: 'instant' });
      }
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  });

  const pick = useCallback(at => { setIndex(at); show(found.hits[at]); }, [found, show]);
  const goJump = useCallback(() => { if (!jump) return; unpaint(); goTo(jump.id); }, [jump, goTo, unpaint]);
  // Enter: a typed code jumps first; then the matches one by one (Shift+Enter back), round the book.
  // -> whether it went somewhere (a narrow page then closes the slide-over, so the match is seen).
  const step = useCallback(delta => {
    if (jump && index < 0 && delta > 0) { goJump(); return true; }
    if (!found.total) return false;
    pick(index < 0 ? (delta > 0 ? 0 : found.total - 1) : (index + delta + found.total) % found.total);
    return true;
  }, [jump, index, found, goJump, pick]);
  const close = useCallback(() => { setQuery(''); unpaint(); }, [unpaint]);
  const open = useCallback(() => {
    const selected = window.getSelection?.()?.toString().trim();
    if (selected && selected.length <= 80 && !selected.includes('\n')) setQuery(selected);
    reveal();
    // After the 目录 is drawn (and after the slide-over took the focus itself).
    requestAnimationFrame(() => requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); }));
  }, [reveal]);

  // Ctrl+F while the book has the focus (nothing else focused, or something in the page), and `/` outside a field.
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (book?.status !== 'ok' || !book.notes) return undefined;
    const press = event => {
      const inPage = event.target === document.body || !!pageRef.current?.contains(event.target);
      const find = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target?.closest?.(TYPING);
      if (!inPage || event.defaultPrevented || !(find || slash) || event.target?.closest?.('dialog, [role="menu"]')) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [book?.status, book?.notes, pageRef]);

  return { query, setQuery, searching, total: found.total, hits: found.hits, index, jump, step, pick, goJump, close, open, inputRef };
}
