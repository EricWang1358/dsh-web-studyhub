import { useCallback, useEffect, useState } from 'react';
import { browserStorage, readText, removeKey, writeText } from '../storage.js';
import { localDay } from '../guidance/budget.js';
import { clearCount } from '../guidance/cleared.js';

/* 「今天先不」 on the home's 下一步 card (ui/study-map/NextStepCard.jsx): the card is hidden for the rest of the LOCAL calendar day, in this browser, in this
   library, and is back the next day. One key per library holds the day it was put off (study-next-card:<root> = "2026-10-28"); 设置 › 引导 lists it as `home.next`
   (ui/guidance/registry.js, which imports the prefix from here) and 再显示一次 removes the key. A mark of an earlier day means nothing: it is shown as if there
   were none and removed, so Settings does not call the card seen on the strength of yesterday. A browser that cannot store keeps the dismissal for the visit only,
   and gives it up when 再显示一次 is used in this tab (ui/guidance/cleared.js), as the first-run line's 以后再说 does. Nothing here throws. */

export const NEXT_CARD_ID = 'home.next';
/** The key prefix, one key per library; 设置 › 引导 reads it (ui/guidance/registry.js). */
export const NEXT_CARD_PREFIX = 'study-next-card:';
export const nextCardKey = (root) => `${NEXT_CARD_PREFIX}${root || 'local'}`;

// What this visit holds for a library whose browser would not store the mark: { day, clears } per root.
const visit = new Map();

/** Remember in memory only, for this visit, that the card was put off today. */
export function rememberForVisit(root, { now = Date.now(), id = NEXT_CARD_ID } = {}) {
  visit.set(nextCardKey(root), { day: localDay(now), clears: clearCount(id) });
}

const heldForVisit = (key, day, id) => { const held = visit.get(key); return !!held && held.day === day && held.clears === clearCount(id); };

/** Was the card put off today (the local day of `now`)? */
export function dismissedToday(root, { now = Date.now(), storage = browserStorage(), id = NEXT_CARD_ID } = {}) {
  const key = nextCardKey(root), day = localDay(now);
  return readText(key, '', storage) === day || heldForVisit(key, day, id);
}

/** Put the card off for today; true when the browser stored it (otherwise the visit holds it). */
export function dismissToday(root, { now = Date.now(), storage = browserStorage(), id = NEXT_CARD_ID } = {}) {
  const stored = writeText(nextCardKey(root), localDay(now), storage);
  if (!stored) rememberForVisit(root, { now, id });
  return stored;
}

/** Remove a mark of an earlier day, so the key only ever means "put off today". */
export function forgetStale(root, { now = Date.now(), storage = browserStorage() } = {}) {
  const key = nextCardKey(root), stored = readText(key, '', storage);
  if (stored && stored !== localDay(now)) removeKey(key, storage);
}

/**
 * [dismissed, dismiss] for a library: read when the home opens, so the card's slot is decided on the first render (nothing arrives late).
 */
export function useNextCardDismissal(root) {
  const [dismissed, setDismissed] = useState(() => dismissedToday(root));
  useEffect(() => { forgetStale(root); setDismissed(dismissedToday(root)); }, [root]);
  const dismiss = useCallback(() => { dismissToday(root); setDismissed(true); }, [root]);
  return [dismissed, dismiss];
}
