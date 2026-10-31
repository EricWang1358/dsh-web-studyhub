import { computeSessionProgress } from './study-progress.js';
import { activityFromAttempts, estimateRemainingTime } from './study-time-estimate.js';
import { calculateSessionCost } from './study-session-cost.js';

/**
 * What the right panel and the main chat read about a session, from the library as it is now: the progress of its check items, the
 * remaining-time range and the itemized cost. One place, so every surface shows the same numbers (resume and study.session.get share it).
 * The answering time comes from the attempts that back a check item.
 * The cost holds what the session recorded (the question jobs it waited for) and the questions it reused; the main chat's own reasoning is not
 * visible to the plugin and is reported as not measured.
 */
export function studySessionReadout(viewState = {}, session = {}) {
  const attempts = viewState.attempts || [];
  const progress = computeSessionProgress(session, attempts);
  const estimate = estimateRemainingTime(session, progress, activityFromAttempts(progress, attempts));
  const written = new Set((session.usage || []).filter((record) => record.kind === 'generation' && record.cardId).map((record) => record.cardId));
  const backing = new Set(progress.items.flatMap((item) => item.evidenceAttemptIds || []));
  const reused = new Set(attempts.filter((att) => backing.has(att.id) && !written.has(att.quiz_id)).map((att) => att.quiz_id));
  const cost = calculateSessionCost(session, progress, [...(session.usage || []), ...(reused.size ? [{ kind: 'reuse_existing', count: reused.size }] : [])]);
  return { progress, estimate, cost };
}

/**
 * Resumes a study session across days or new chat threads without private chat history dependencies (UC-09).
 * Detects source/card revisions and stale dependencies honestly.
 */
export function resumeStudySession(viewState = {}, options = {}) {
  const sessions = viewState.studySessions || [];
  if (sessions.length === 0) {
    return { found: false, session: null, staleWarnings: [] };
  }

  let session = null;
  if (options.sessionId) {
    session = sessions.find((s) => s.id === options.sessionId) || null;
  } else if (options.courseId) {
    session = sessions.filter((s) => s.courseId === options.courseId).at(-1) || null;
  } else {
    session = sessions.at(-1) || null;
  }

  if (!session) {
    return { found: false, session: null, staleWarnings: [] };
  }

  // Stale revision and removed entity detection
  const staleWarnings = [];
  const sources = viewState.sources || [];
  const decks = viewState.decks || [];

  // 1. Check sources in scope
  for (const item of session.scope || []) {
    if (item.kind === 'source') {
      const src = sources.find((s) => s.id === item.id);
      if (!src) {
        staleWarnings.push({ kind: 'source_removed', id: item.id, detail: `引用的资料 '${item.id}' 已被删除` });
      } else if (item.revision && src.revision && src.revision !== item.revision) {
        staleWarnings.push({ kind: 'source_revised', id: item.id, detail: `引用的资料 '${item.id}' 已更新至修订版 ${src.revision}（原记录版本 ${item.revision}）` });
      }
    }
  }

  // 2. Check focus card, returnPath cards, checkItems target cards, and scope cards
  const allCards = new Map();
  for (const d of decks) {
    for (const c of d.cards || []) {
      allCards.set(c.id, { card: c, deckId: d.id });
    }
  }

  function checkCard(item, label) {
    if (!item || !item.id) return;
    const found = allCards.get(item.id);
    if (!found) {
      staleWarnings.push({ kind: 'card_removed', id: item.id, detail: `${label} '${item.id}' 已被删除` });
      return;
    }
    const currentCard = found.card;
    const curRev = currentCard.revision ?? (currentCard.revisions?.length || null);
    const curDigest = currentCard.digest ?? null;

    const recordedRev = item.revision ?? null;
    const recordedDigest = item.digest ?? null;

    if (
      (recordedRev !== null && curRev !== null && recordedRev !== curRev) ||
      (recordedDigest !== null && curDigest !== null && recordedDigest !== curDigest)
    ) {
      staleWarnings.push({
        kind: 'card_modified',
        id: item.id,
        detail: `${label} '${item.id}' 已被修改（原版本: ${recordedRev ?? recordedDigest}，当前版本: ${curRev ?? curDigest}）`,
      });
    }
  }

  if (session.focus?.kind === 'card' && session.focus.id) {
    checkCard(
      {
        id: session.focus.id,
        revision: session.focus.revision,
        digest: session.focus.digest,
      },
      '当前聚焦题目'
    );
  }

  for (const ret of session.returnPath || []) {
    if (ret.cardId) {
      checkCard(
        {
          id: ret.cardId,
          revision: ret.revision,
          digest: ret.digest,
        },
        '支线返回链中的题目'
      );
    }
  }

  for (const item of session.goal?.checkItems || []) {
    if (Array.isArray(item.targetCards)) {
      for (const cardRef of item.targetCards) {
        checkCard(cardRef, `检验项 '${item.title}' 关联题目`);
      }
    }
    if (Array.isArray(item.targetCardRevisions)) {
      for (const cardRef of item.targetCardRevisions) {
        checkCard(cardRef, `检验项 '${item.title}' 关联题目`);
      }
    }
  }

  if (session.cardRevisions) {
    for (const [cardId, rev] of Object.entries(session.cardRevisions)) {
      checkCard({ id: cardId, revision: rev }, '目标关联题目');
    }
  }
  if (session.cardDigests) {
    for (const [cardId, dig] of Object.entries(session.cardDigests)) {
      checkCard({ id: cardId, digest: dig }, '目标关联题目');
    }
  }

  for (const item of session.scope || []) {
    if (item.kind === 'card') {
      checkCard({ id: item.id, revision: item.revision, digest: item.digest }, '学习范围中的题目');
    }
  }

  // 3. Locate active run and draft
  const runs = viewState.runs || [];
  const activeRun = session.focus?.runId
    ? runs.find((r) => r.id === session.focus.runId) || null
    : runs.filter((r) => !r.closedAt).at(-1) || runs.at(-1) || null;

  const currentEntry = activeRun && activeRun.entries ? activeRun.entries[activeRun.index] : null;
  const currentCard = currentEntry?.card || (session.focus?.id ? allCards.get(session.focus.id)?.card : null) || null;
  const draft = currentEntry?.draft || null;

  // 4. Reconstruct progress, estimate and cost
  const { progress, estimate, cost } = studySessionReadout(viewState, session);

  return {
    found: true,
    session,
    activeRun,
    currentCard,
    draft,
    returnPath: session.returnPath || [],
    progress,
    estimate,
    cost,
    staleWarnings,
  };
}
