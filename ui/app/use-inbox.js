import { useCallback, useEffect, useMemo, useRef } from 'react';
import { markInboxRead } from '../quick-actions.js';
import { openInboxResult } from './inbox-open.js';

/* The mailbox as the shell uses it: open a letter (it jumps to its card, run or material, keeping the way back), and letters
   about the question on screen are read by looking at it. Both go through the quick path of ui/quick-actions.js. */
export function useInbox({ core, lib, nav, session, learn, data }) {
  const { act, quick, refresh } = core;
  const { setDetour } = lib.set;
  const latest = useRef(null);
  latest.current = { page: nav.page, run: session.run };

  const verbs = useMemo(() => ({
    remember: learn.rememberContext, showPage: nav.show.page, openAudioSources: learn.openAudioSources, showNote: nav.show.note,
    enterRun: session.enterRun, explain: session.actions.showExplanation, detour: setDetour,
  }), [learn, nav.show, session, setDetour]);

  /** A letter jumps to its card: the spot in an open run when there is one, otherwise a one-card run that can return to the current question. */
  const openInboxItem = useCallback((item) => {
    const from = learn.captureContext();
    const { page, run } = latest.current;
    const fromReview = page === 'review' && run && !run.complete;
    act('inbox.open', { id: item.id, ...(fromReview ? { runId: from.runId } : {}) }, (result) => openInboxResult({ item, result, from, fromReview }, verbs));
  }, [act, learn, verbs]);

  // Letters about the question already on screen are read by looking at it. 定制题 letters stay: the variants themselves are not on this card.
  const onScreenCardId = nav.page === 'review' && session.run?.card ? session.run.card.id : null;
  const seen = onScreenCardId ? (data?.inbox?.items || []).filter((letter) => !letter.read && letter.cardId === onScreenCardId && letter.kind !== 'variant').map((letter) => letter.id) : [];
  const seenKey = seen.join(',');
  useEffect(() => {
    if (!seen.length) return;
    void markInboxRead(quick, { ids: seen }).then((outcome) => { if (outcome.ok) return refresh().catch(() => {}); return undefined; });
  }, [seenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { openInboxItem };
}
