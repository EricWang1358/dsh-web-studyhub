import { useMemo, useRef, useState } from 'react';
import { useLiveEffect } from '../../use-async.js';
import { readWrongBook } from '../reader/wrong-rows.js';
import { cardKey, refsOf } from './practice-range.js';
import { followupsOf, rangeKey, sectionStats } from './section-practice.js';

/* The reads behind the 本节题目 line (#1013), through the existing operations and never while scrolling:
   - 错题: the 错题与待巩固 page's rows of this material (reader/wrong-rows.js readWrongBook), read once per set of the material's questions (the reading loop
     reads that set again when the library changes) and counted per range here;
   - 追问: course.outline.qa for the range's questions (at most its 200), kept per library version and range; a change of section asks at most once, after
     the reading position has rested a moment;
   - 批注: placed by the reading loop with the questions (no request).
   Only while the panel is on screen (`enabled`). */

const SETTLE_MS = 250, KEPT = 24, QA_MAX = 200, NONE = Object.freeze([]);

/** -> { wrong, followups, notes, items } (items: the 追问 of the range, for the list under 追问 n). */
export function useSectionStats({ call, enabled, version, allCards, cards, ids, noteAssigned }) {
  const keys = useMemo(() => new Set((allCards || []).map(cardKey)), [allCards]);
  const [wrongKeys, setWrongKeys] = useState(null);
  useLiveEffect(live => {
    if (!enabled || !call || !keys.size) return;
    readWrongBook({ call, keys }).then(items => { if (live()) setWrongKeys(new Set(items.map(cardKey))); }, () => { if (live()) setWrongKeys(null); });
  }, [call, enabled, keys]);

  const kept = useRef(new Map());
  const range = rangeKey(cards), wanted = `${version ?? ''}|${range}`;
  // Until a new version's answer is in, the range's last one stays on screen (no flash of 追问 0 after each answer elsewhere).
  const [items, setItems] = useState({ range: '', list: NONE });
  useLiveEffect(live => {
    if (!enabled || !call || !cards?.length) return undefined;
    if (kept.current.has(wanted)) { setItems({ range, list: kept.current.get(wanted) }); return undefined; }
    const timer = setTimeout(() => {
      call('course.outline.qa', { course: '*', cards: refsOf(cards.slice(0, QA_MAX)) }).then(answer => {
        const list = followupsOf(answer?.items);
        kept.current.set(wanted, list);
        if (kept.current.size > KEPT) kept.current.delete(kept.current.keys().next().value);
        if (live()) setItems({ range, list });
      }, () => {});
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [call, enabled, wanted]); // `wanted` names the range's questions and the version (`range` is part of it)
  const followups = cards?.length && items.range === range ? items.list : NONE;
  const counts = useMemo(() => sectionStats({ cards, wrongKeys, followups, ids, noteAssigned }), [cards, wrongKeys, followups, ids, noteAssigned]);
  return { ...counts, items: followups };
}
