import React from 'react';
import { reviewEntryKey } from '../async.js';
import { setItemMuted } from '../guidance/budget.js';
import { clearCount } from '../guidance/cleared.js';
import { PRACTICE_OFFER, chapterHintFor, freshTermsDeeper, markChapterHintSeen, practiceOfferAllowed, practiceOfferFor } from '../guidance/practice-offers.js';

function dedupeTerms(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const clean = String(raw ?? '').trim();
    if (clean && !seen.has(clean)) { seen.add(clean); out.push(clean); }
  }
  return out;
}

/**
 * Manages the proactive chapter-basics hint (#1193, #1216) below TermChips in QuestionRun:
 * triggers when a `kind: 'terms'` fill completes during the current question visit (`at >= enteredAt`)
 * with non-empty `deeper` prerequisites, or on a second "补齐" fill on a card that already has
 * `kind: 'terms'`, yielding to first-use practice tips, exam mode, tourRunning, opt-out switches,
 * and once-per-chapter per round.
 */
export function useChapterHint({ run, cardPlace, allFollowups = [], currentTerms = [], tipShown = null, tourRunning = false }) {
  const runId = run?.id || '';
  const entryKey = reviewEntryKey(run);
  const exam = run?.mode === 'exam';
  const chapterKey = cardPlace?.chapter?.key
    || (cardPlace?.chapter?.title ? `${cardPlace.document?.sourceId || cardPlace.document?.key || ''}:${cardPlace.chapter.title}` : '')
    || run?.deckId
    || '';

  // Record entry timestamp synchronously on entryKey change so historical followups never flash for one frame.
  const enteredAtRef = React.useRef({ key: '', at: 0 });
  if (enteredAtRef.current.key !== entryKey) {
    enteredAtRef.current = { key: entryKey, at: entryKey ? Date.now() : 0 };
  }
  const enteredAt = enteredAtRef.current.at;

  const latestTerms = React.useMemo(() => {
    for (let i = (allFollowups?.length ?? 0) - 1; i >= 0; i -= 1) {
      if (allFollowups[i]?.kind === 'terms') return allFollowups[i];
    }
    return null;
  }, [allFollowups]);

  const deeper = Array.isArray(latestTerms?.deeper) ? latestTerms.deeper : [];
  const triggerDeeper = freshTermsDeeper(latestTerms, enteredAt);
  const hasExistingTerms = Boolean(latestTerms);
  const handOffTerms = React.useMemo(() => dedupeTerms([...(latestTerms?.terms || []), ...(currentTerms || [])]), [latestTerms, currentTerms]);

  const resetEpoch = `${runId}:${clearCount(PRACTICE_OFFER.chapterBasics)}`;
  const [seenState, setSeenState] = React.useState(() => ({ epoch: resetEpoch, set: new Set() }));
  const [refillState, setRefillState] = React.useState({ epoch: '', key: '' });
  const [, bump] = React.useReducer((n) => n + 1, 0);
  const shownHereRef = React.useRef({ epoch: '', entryKey: '', chapterKey: '', visible: false });

  const activeSeen = seenState.epoch === resetEpoch ? seenState.set : new Set();

  // Leaving a question where the hint was already shown marks that chapter seen for the rest of the round.
  React.useEffect(() => {
    const prev = shownHereRef.current;
    if (prev.epoch === resetEpoch && prev.entryKey && prev.entryKey !== entryKey && prev.visible && prev.chapterKey) {
      setSeenState((state) => {
        const base = state.epoch === resetEpoch ? state.set : new Set();
        if (base.has(prev.chapterKey)) return state;
        const next = new Set(base);
        next.add(prev.chapterKey);
        return { epoch: resetEpoch, set: next };
      });
    }
  }, [entryKey, resetEpoch]);

  const allowed = !exam && !tourRunning && practiceOfferAllowed(PRACTICE_OFFER.chapterBasics);
  const moment = chapterHintFor({
    deeper: triggerDeeper,
    refill: Boolean(entryKey && refillState.epoch === resetEpoch && refillState.key === entryKey),
    exam,
    tourRunning,
    allowed,
    seenChapters: activeSeen,
    chapterKey,
  });
  const offer = practiceOfferFor({
    tip: tipShown,
    exam,
    tourRunning,
    allowed: allowed ? [PRACTICE_OFFER.chapterBasics] : [],
    moments: { [PRACTICE_OFFER.chapterBasics]: moment },
  });
  const visible = offer === PRACTICE_OFFER.chapterBasics;

  React.useEffect(() => {
    shownHereRef.current = { epoch: resetEpoch, entryKey, chapterKey, visible };
    if (visible) markChapterHintSeen();
  }, [resetEpoch, entryKey, chapterKey, visible]);

  const noteFillTerms = React.useCallback(() => {
    if (hasExistingTerms && entryKey) setRefillState({ epoch: resetEpoch, key: entryKey });
  }, [hasExistingTerms, entryKey, resetEpoch]);

  const dismiss = React.useCallback(() => {
    markChapterHintSeen();
    if (chapterKey) {
      setSeenState((state) => {
        const base = state.epoch === resetEpoch ? state.set : new Set();
        if (base.has(chapterKey)) return state;
        const next = new Set(base);
        next.add(chapterKey);
        return { epoch: resetEpoch, set: next };
      });
    } else {
      setRefillState({ epoch: '', key: '' });
    }
  }, [chapterKey, resetEpoch]);

  const mute = React.useCallback(() => {
    setItemMuted(PRACTICE_OFFER.chapterBasics, true);
    markChapterHintSeen();
    if (chapterKey) {
      setSeenState((state) => {
        const base = state.epoch === resetEpoch ? state.set : new Set();
        const next = new Set(base);
        next.add(chapterKey);
        return { epoch: resetEpoch, set: next };
      });
    }
    bump();
  }, [chapterKey, resetEpoch]);

  return {
    visible,
    deeper,
    terms: handOffTerms,
    noteFillTerms,
    dismiss,
    mute,
  };
}
