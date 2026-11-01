import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveEffect } from '../use-async.js';

/* The review book of a course as the page shows it (course.book.open), read again on a ticket (a task that ended, a Q&A added), and checked when the page comes
   back into view (the window regains the focus, the tab becomes visible, or the focus comes back into the app from elsewhere, such as the main chat's box):
   course.book.revision is one number, and only when it moved is the whole book read again, in place. Never while an editor is open (`paused`). A rebuilt outline that would move
   the learner's own text answers its preview instead (lib/course-book-files.js); an editor that is open keeps the book it edits. */

const QUIET = 2000;

/** -> { book, error, setBook(next), reload() }. onReplaced(next): the book read again on return (the page keeps the heading being read where it is). */
export function useBookData({ call, course, paused, onReplaced }) {
  const [state, setState] = useState({ book: null, error: null, ticket: 0 });
  const latest = useRef({});
  useLiveEffect(isLive => {
    call('course.book.open', { course }).then(book => {
      if (isLive() && !(book?.status === 'rebuild-pending' && latest.current.paused)) setState(current => ({ ...current, book, error: null }));
    },
      error => { if (isLive()) setState(current => ({ ...current, error })); });
  }, [call, course, state.ticket]);
  const setBook = useCallback(next => setState(current => ({ ...current, book: next })), []);
  const reload = useCallback(() => setState(current => ({ ...current, ticket: current.ticket + 1 })), []);
  latest.current = { paused, onReplaced, revision: state.book?.revision };
  const ok = state.book?.status === 'ok';
  useEffect(() => {
    if (!ok || typeof document === 'undefined') return undefined;
    // One controller ends the listeners and any answer still on its way when the page goes or the book changes.
    const stop = new AbortController(), signal = stop.signal;
    let busy = false, last = 0;
    const check = async () => {
      if (busy || latest.current.paused || document.visibilityState === 'hidden' || Date.now() - last < QUIET) return;
      busy = true;
      last = Date.now();
      try {
        const { revision } = await call('course.book.revision', { course });
        if (signal.aborted || revision === null || revision === latest.current.revision) return;
        const next = await call('course.book.open', { course });
        if (!signal.aborted && !latest.current.paused && next?.status === 'ok') { latest.current.onReplaced?.(next); setBook(next); }
      } catch { /* the next return asks again */ } finally { busy = false; }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    // Back into the app from outside it (the host's chat box sits in the same window, so the window's focus does not change).
    const onFocusIn = event => { const app = event.target?.closest?.('.study-app, .study-seat'); if (app && !app.contains(event.relatedTarget)) check(); };
    document.addEventListener('visibilitychange', onVisible, { signal });
    window.addEventListener('focus', check, { signal });
    document.addEventListener('focusin', onFocusIn, { signal });
    return () => stop.abort();
  }, [call, course, ok, setBook]);
  return { book: state.book, error: state.error, setBook, reload };
}
