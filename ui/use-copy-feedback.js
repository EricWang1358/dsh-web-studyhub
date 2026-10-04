import { useEffect, useRef, useState } from 'react';

/* "Copied" feedback, once: write the text to the clipboard, say so for a moment, go back to "copy". A failed write says nothing
   (the caller keeps its field selectable). createCopyFeedback is the logic without React so it is tested on its own. */

const writeText = async (text) => {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('no clipboard');
  await navigator.clipboard.writeText(text);
};

/** `text` is the string to copy, or a function that reads it when `copy()` runs. */
export function createCopyFeedback({ text, resetMs = 2500, write = writeText, onChange = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  let timer = null, alive = true;
  const read = typeof text === 'function' ? text : () => text;
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    /** Resolves true when the text was written. A second copy restarts the countdown. */
    async copy() {
      try {
        await write(read());
        if (!alive) return true;
        onChange(true);
        stop();
        timer = setTimer(() => { timer = null; if (alive) onChange(false); }, resetMs);
        return true;
      } catch {
        if (alive) onChange(false);
        return false;
      }
    },
    dispose() { alive = false; stop(); },
  };
}

/**
 * `{ copied, copy }` for a "copy" button: `copied` is true for `resetMs` (2.5 s unless asked) after a successful `copy()`, which
 * resolves whether it worked. The timer goes with the component.
 */
export function useCopyFeedback(text, { resetMs = 2500 } = {}) {
  const [copied, setCopied] = useState(false);
  const latest = useRef(text), feedback = useRef(null);
  latest.current = text;
  useEffect(() => {
    feedback.current = createCopyFeedback({ text: () => latest.current, resetMs, onChange: setCopied });
    return () => feedback.current.dispose();
  }, [resetMs]);
  return { copied, copy: () => feedback.current?.copy() ?? Promise.resolve(false) };
}
