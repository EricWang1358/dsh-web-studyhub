import { useCallback, useRef, useState } from 'react';

/* One height rule for the practice page (#1678): below SHORT_VIEW px of the app's own height, the window is short, and the flipped flashcard's
   0–5 grade row is one line per button (ui/review/question.css .grading--short). 界面大小 is a CSS zoom on the app, so this is the window's height
   divided by it: a 1440×900 window at 150% is 600, 1280×720 at 150% is 480; at 100% only a window under 640 px tall is short, so the laptop sizes
   (1280×720 and up, 420×860) keep the full row. It is the app's height, not that of the box the question scrolls in: a question answered in a side panel
   (the reader's 本节题目, 592 px tall in a 1280×720 window) is short only when the window is. */
export const SHORT_VIEW = 640;

/**
 * Whether the app around the element that the returned ref is put on (.study-app, else the DSH seat, else the page) is shorter than `height` of its own px
 * (clientHeight: a zoom on the app is already divided out), measured as the element mounts and again when the app is resized.
 * Returns [short, ref]; state is set only when it changes.
 */
export function useShortView(height = SHORT_VIEW) {
  const [short, setShort] = useState(false);
  const stop = useRef(null);
  const ref = useCallback((element) => {
    stop.current?.();
    stop.current = null;
    if (!element) return;
    const app = element.closest('.study-app') ?? element.closest('.study-seat') ?? element.ownerDocument.scrollingElement;
    if (!app) return;
    const measure = () => { const tall = app.clientHeight; setShort(tall > 0 && tall < height); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(app);
    stop.current = () => observer.disconnect();
  }, [height]);
  return [short, ref];
}
