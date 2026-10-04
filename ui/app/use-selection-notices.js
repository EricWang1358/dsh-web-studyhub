import { useCallback, useEffect, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { finishedNotice, isActive as isSelectionJobActive } from '../document-preview/selection-job.js';

/* A passage supplement runs in the background: when one that was seen running ends, say so, with the jump to its questions.
   track(jobId) marks a job the learner has just started (the reader calls it) so even one that finishes before the next poll is told. */
export function useSelectionNotices({ core, learn, data }) {
  const seen = useRef(new Map());
  const latest = useRef(null);
  latest.current = { notify: core.notify, open: learn.openLearningTarget };
  useEffect(() => {
    for (const job of data?.jobs || []) {
      if (job.origin !== 'selection') continue;
      if (isSelectionJobActive(job)) { seen.current.set(job.id, 'active'); continue; }
      if (seen.current.get(job.id) !== 'active') continue;
      seen.current.set(job.id, 'told');
      const outcome = finishedNotice(job), added = outcome.jump?.cardIds?.length || 0;
      latest.current.notify({ text: outcome.text, tone: outcome.tone, ...(added ? { action: { label: added === 1 ? ui('马上练这 1 张') : uiFormat('马上练这 {0} 张', [added]),
        run: () => latest.current.open({ kind: 'cards', deckId: outcome.jump.deckId, cardIds: outcome.jump.cardIds }) } } : {}) });
    }
  }, [data?.jobs]);
  return { track: useCallback((jobId) => { seen.current.set(jobId, 'active'); }, []) };
}
