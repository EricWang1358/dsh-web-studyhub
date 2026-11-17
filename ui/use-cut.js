import { useEffect, useLayoutEffect, useState } from 'react';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Is the text of this element cut by its width (one line, ellipsis)? Measured again when the element is resized, `text` changes, or the element itself is
 *  replaced (a row that leaves and comes back from its rename field draws a new one: the old observer would keep watching the detached element). */
export function useCut(ref, text) {
  const [cut, setCut] = useState(false);
  const [element, setElement] = useState(null);
  useIsoLayoutEffect(() => { if (ref.current !== element) setElement(ref.current); });
  useIsoLayoutEffect(() => {
    if (!element) { setCut(false); return undefined; }
    const measure = () => setCut(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text]);
  return cut;
}
