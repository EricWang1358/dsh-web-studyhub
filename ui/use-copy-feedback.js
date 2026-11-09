import { useEffect, useRef, useState } from 'react';

/* "Copied" feedback, once: write the text to the clipboard, say so for a moment, go back to "copy". A failed write says nothing
   (the caller keeps its field selectable). createCopyFeedback is the logic without React so it is tested on its own. */

const writeText = async (text) => {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('no clipboard');
  await navigator.clipboard.writeText(text);
};

/* The one rule for "the text to copy": a function is called when `copy()` runs, anything else is the text. */
const resolve = value => typeof value === 'function' ? value() : value;

/** `text` is the string to copy, or a function that reads it when `copy()` runs. */
export function createCopyFeedback({ text, resetMs = 2500, write = writeText, onChange = () => {}, onStatus = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  let timer = null, alive = true;
  const read = () => resolve(text);
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    /** Resolves true when the text was written. A second copy restarts the countdown. */
    async copy() {
      try {
        await write(read());
        if (!alive) return true;
        onChange(true);
        onStatus('copied');
        stop();
        timer = setTimer(() => { timer = null; if (alive) { onChange(false); onStatus('idle'); } }, resetMs);
        return true;
      } catch {
        stop();
        if (alive) { onChange(false); onStatus('failed'); }
        return false;
      }
    },
    reset() { stop(); if (alive) { onChange(false); onStatus('idle'); } },
    dispose() { alive = false; stop(); },
  };
}

/**
 * `{ copied, failed, copy, reset }` for a "copy" button: `copied` is true for `resetMs` (2.5 s unless asked) after a successful `copy()`,
 * `failed` is true when the clipboard refused the write, and `text` may be a string or a lazy function evaluated at click time.
 */
export function useCopyFeedback(text, { resetMs = 2500 } = {}) {
  const [status, setStatus] = useState('idle');
  const latest = useRef(text), feedback = useRef(null);
  latest.current = text;
  useEffect(() => {
    feedback.current = createCopyFeedback({ text: () => resolve(latest.current), resetMs, onStatus: setStatus });
    return () => feedback.current.dispose();
  }, [resetMs]);
  return {
    copied: status === 'copied',
    failed: status === 'failed',
    copy: () => feedback.current?.copy() ?? Promise.resolve(false),
    reset: () => feedback.current?.reset(),
  };
}
