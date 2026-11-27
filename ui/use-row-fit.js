import { useEffect, useLayoutEffect, useState } from 'react';
import { drawnScale } from './drawn-scale.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Whether the full set of a header's actions fits on its title row (#1083): decided by the words in this language, not by a width written down for one of them.
 * The row is `rowSelector` inside `ref` (the title row of ui/components/PageHeader.jsx with `actionsOnTitleRow`, the title its first child); the full set is
 * measured on `probeSelector`, a copy of it that the page draws out of the flow and hides (aria-hidden, inert, invisible). It fits when the title, the row's
 * gap and that copy are no wider than the row.
 * The set the learner sees is never drawn only to be measured, so a menu choice that renames an action (全部展开 → 全部收起) does not swap the header
 * out from under the focus (#1083, round 5). Measured before the paint, and again whenever the row, the title or the copy changes size.
 */
export function useRowFit(ref, rowSelector, probeSelector) {
  const [fits, setFits] = useState(true);
  useIsoLayoutEffect(() => {
    const row = ref.current?.querySelector(rowSelector), probe = ref.current?.querySelector(probeSelector), title = row?.firstElementChild;
    if (!row || !probe || !title) return undefined;
    const width = el => el.getBoundingClientRect().width;
    // The widths are drawn (through the interface zoom), the gap is the row's own style: drawn too before it is added.
    const check = () => {
      const box = row.getBoundingClientRect(), gap = (parseFloat(getComputedStyle(row).columnGap) || 0) * drawnScale(row, box);
      setFits(width(title) + gap + width(probe) <= box.width + 0.5);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    for (const el of [row, title, probe]) observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rowSelector, probeSelector]);
  return fits;
}
