import { useEffect, useLayoutEffect, useState } from 'react';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Is the text of this element cut by its width (one line, ellipsis)? Measured again when the element is resized or `text` changes. */
export function useCut(ref, text) {
  const [cut, setCut] = useState(false);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!element) { setCut(false); return undefined; }
    const measure = () => setCut(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
  return cut;
}
