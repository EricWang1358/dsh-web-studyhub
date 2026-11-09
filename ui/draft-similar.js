import { useState } from 'react';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';

/* Which questions of a saved draft are near-duplicates of another one (`draft.similar`, #890). Asked when the draft page opens and again when the library
   or the draft changes (`version`); never on a timer. The last answer per (draft, version) is kept in a small memo, so the page shows it at once when it is
   opened again; a test hands an answer in with seedSimilar. */
const remembered = new Map(), LIMIT = 20;
const keyOf = (draftId, version) => JSON.stringify([draftId, version]);
const remember = (key, view) => { remembered.delete(key); remembered.set(key, view); if (remembered.size > LIMIT) remembered.delete(remembered.keys().next().value); };

export const seedSimilar = (draftId, version, view) => remember(keyOf(draftId, version), view);
export const forgetSimilar = () => remembered.clear();

/** The flagged questions of draft `draftId` as a Map from card id to { similarity, other }; empty until an answer for this draft is here. */
export function useSimilarQuestions(draftId, { version = '', enabled = true } = {}) {
  const { call } = useStudy();
  const key = keyOf(draftId, version);
  const [view, setView] = useState(() => remembered.get(key) ?? null);
  useLiveEffect((live) => {
    if (!enabled || !draftId || typeof call !== 'function') return;
    Promise.resolve().then(() => call('draft.similar', { id: draftId })).then((answer) => {
      if (answer?.status !== 'ok') return;
      remember(key, answer);
      if (live()) setView(answer);
    }, () => {});
  }, [key, enabled, call]);
  // The last answer stays until the next one arrives (no blink), but only for the draft it is about.
  const current = remembered.get(key) ?? view;
  return new Map(current?.draftId === draftId ? current.similar.map((item) => [item.cardId, item]) : []);
}
