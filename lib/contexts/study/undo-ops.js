import { get } from '../../util.js';
import { findCard } from '../../prereq.js';
import { isSocraticAttempt } from '../../mastery.js';
import { creditPrerequisites, projection } from '../../study-state.js';
import { activeAttempts, withActiveAttempts } from './active-attempts.js';
import { gradingPending } from './grading-marker.js';

/** Collect the transitive prerequisite cards of `ref` so we only snapshot reviews that `creditPrerequisites` can actually touch. */
function collectPrerequisiteRefs(s, ref) {
  let rootCard;
  try { rootCard = findCard(s, ref).card; } catch { return []; }
  if (!Array.isArray(rootCard?.requires) || !rootCard.requires.length) return [];
  const seen = new Set(), collected = [];
  const stack = [...rootCard.requires];
  while (stack.length) {
    const req = stack.pop();
    if (!req?.deckId || !req?.cardId) continue;
    const key = `${req.deckId}\0${req.cardId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let pre;
    try { pre = findCard(s, req); } catch { continue; }
    collected.push({ key, deck: pre.deck, card: pre.card });
    if (Array.isArray(pre.card?.requires) && pre.card.requires.length) {
      for (const next of pre.card.requires) stack.push(next);
    }
  }
  return collected;
}

/** Credit prerequisites against active attempts only, stamping `reviewSnapshot` on implicit attempts so `review.undo` can roll them back cleanly. */
export function creditPrerequisitesActive(s, ref, runId, timestamp) {
  const prereqs = collectPrerequisiteRefs(s, ref);
  if (!prereqs.length) return 0;
  const beforeReviews = new Map();
  for (const { key, card } of prereqs) {
    beforeReviews.set(key, card.review === undefined ? null : structuredClone(card.review));
  }
  const active = activeAttempts(s.attempts || []).slice();
  const baseLength = active.length;
  const credited = creditPrerequisites({ ...s, attempts: active }, ref, runId, timestamp);
  if (active.length > baseLength) {
    const added = active.slice(baseLength).map((item) => ({
      ...item,
      reviewSnapshot: beforeReviews.has(`${item.deckId}\0${item.quiz_id}`)
        ? beforeReviews.get(`${item.deckId}\0${item.quiz_id}`)
        : structuredClone(item.before ?? null),
    }));
    s.attempts.push(...added);
  }
  return credited;
}

const entryCardId = (entry) => entry?.card?.id ?? entry?.cardId;

/** Latest undoable learner attempt in the open round, or null when nothing can be undone. */
export function undoableForRun(attempts, run) {
  if (!run || run.mode === 'exam' || run.closedAt) return null;
  const list = Array.isArray(attempts) ? attempts : [];
  const latest = list.findLast((item) => item && !item.voidedAt && !item.implicit && !isSocraticAttempt(item) && item.runId === run.id);
  if (!latest) return null;
  let entryIndex = Number.isInteger(latest.entryIndex)
    && entryCardId(run.entries[latest.entryIndex]) === latest.quiz_id
    && !!run.entries[latest.entryIndex]?.feedback
    ? latest.entryIndex
    : -1;
  if (entryIndex < 0) {
    entryIndex = run.entries.findLastIndex((e) => e.feedback && entryCardId(e) === latest.quiz_id
      && (e.deckId ?? run.deckId) === latest.deckId && !!e.retry === !!latest.retry);
  }
  if (entryIndex < 0) return null;
  // Do not undo across another question whose background grading is already in flight.
  if (run.entries.some((e, idx) => idx !== entryIndex && gradingPending(e))) return null;
  return {
    attemptId: latest.id,
    cardId: latest.quiz_id,
    deckId: latest.deckId ?? run.deckId,
    entryIndex,
    grade: latest.grade,
    assessment: latest.assessment || 'self',
  };
}

/** Project a run against active attempts and attach `undoable` metadata when the round's latest answer can be undone. */
export function projectRun(s, run) {
  const projected = projection(withActiveAttempts(s), run);
  const undoable = undoableForRun(s.attempts, run);
  return undoable ? { ...projected, undoable } : projected;
}

export const undoMutations = {
  /* Learner-only undo of the current round's most recent graded answer (#885): restores the card's exact pre-answer FSRS state,
     voids the attempt (and any implicit prerequisite credit it triggered), removes any unpractised tail retry it queued, and
     steps `run.index` back to that card with `revealed: true` and `feedback: null`. */
  'review.undo': (s, a) => {
    const run = get(s.runs, a.runId, 'Review');
    if (run.mode === 'exam') throw new Error('模拟考作答在交卷前可直接改选，交卷后不能撤销');
    if (run.closedAt) throw new Error('这一轮已经结束，不能再撤销评分');
    const target = undoableForRun(s.attempts, run);
    if (!target) throw new Error('当前没有可撤销的评分');
    if (a.attemptId !== undefined && a.attemptId !== null && a.attemptId !== target.attemptId)
      throw new Error('只能撤销当前轮最近一次评分');
    const entry = run.entries[target.entryIndex];
    const attempt = (s.attempts || []).findLast((item) => item && item.id === target.attemptId && !item.voidedAt);
    if (!entry || !attempt) throw new Error('当前没有可撤销的评分');
    const deckId = entry.deckId ?? run.deckId;
    const cardId = entryCardId(entry);
    let live = null;
    try { live = findCard(s, { deckId, cardId }).card; } catch { live = null; }
    const stale = !!entry.feedback?.updatedAfterOpening || !!attempt.updatedAfterOpening;
    if (live && !entry.retry && !stale && live.review && attempt.after && JSON.stringify(live.review) !== JSON.stringify(attempt.after))
      throw new Error('这道题之后又复习过，不能再撤销这次评分');
    if (live && !entry.retry && !stale) {
      const snapshot = 'reviewBefore' in entry
        ? structuredClone(entry.reviewBefore)
        : ('reviewSnapshot' in attempt ? structuredClone(attempt.reviewSnapshot) : structuredClone(attempt.before ?? null));
      if (snapshot === null || snapshot === undefined) delete live.review;
      else live.review = snapshot;
    }
    const voidedAt = new Date().toISOString();
    attempt.voidedAt = voidedAt;
    const creditedAt = entry.creditedAt ?? attempt.timestamp;
    for (const imp of s.attempts || []) {
      if (!imp || imp.voidedAt || !imp.implicit || imp.runId !== run.id || imp.timestamp !== creditedAt) continue;
      if (imp.via?.deckId !== deckId || imp.via?.cardId !== cardId) continue;
      imp.voidedAt = voidedAt;
      try {
        const { card: preCard } = findCard(s, { deckId: imp.deckId, cardId: imp.quiz_id });
        if (JSON.stringify(preCard.review) === JSON.stringify(imp.after)) {
          const preSnap = 'reviewSnapshot' in imp ? structuredClone(imp.reviewSnapshot) : structuredClone(imp.before ?? null);
          if (preSnap === null || preSnap === undefined) delete preCard.review;
          else preCard.review = preSnap;
        }
      } catch { /* prerequisite card was removed */ }
    }
    delete entry.prerequisitesCredited;
    delete entry.creditedAt;
    if (!entry.retry) {
      const retryAt = run.entries.findIndex((item, idx) => idx > target.entryIndex && item.retry && !item.feedback && !gradingPending(item)
        && entryCardId(item) === cardId && (item.deckId ?? run.deckId) === deckId);
      if (retryAt !== -1) {
        run.entries.splice(retryAt, 1);
        run.queueVersion = (run.queueVersion || 0) + 1;
      }
    }
    entry.feedback = null;
    entry.revealed = true;
    delete entry.signature;
    delete entry.lastAttemptId;
    delete entry.answeredAt;
    if (entry.draftBeforeAnswer) {
      entry.draft = entry.draftBeforeAnswer;
      delete entry.draftBeforeAnswer;
    }
    entry.startedAt = Date.now();
    run.index = target.entryIndex;
    return projectRun(s, run);
  },
};
