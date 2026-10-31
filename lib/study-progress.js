/**
 * 100% pure function module for StudyHub 4.0 goal checkItem status and progress derivation.
 * Zero I/O, zero model calls, zero side effects.
 */

/** A time in ms, from either form the library holds: review.answer writes an ISO string, sessions and older records a number. 0 when absent. */
const timeOf = (value) => (typeof value === 'number' ? value : value ? Date.parse(value) || 0 : 0);

/** A review further off than this was scheduled for a later day; a wrong answer's relearning step, minutes away, was not. */
const LATER_DAY_MS = 12 * 3600 * 1000;

/** 隔日巩固: the cards answered in this session whose latest answer scheduled them for a later day. One count per card. */
function cardsDueOnLaterDay(attempts) {
  const latest = new Map();
  for (const att of [...attempts].sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp))) latest.set(att.quiz_id, att);
  return [...latest.values()].filter((att) => timeOf(att.after?.due_at) - timeOf(att.timestamp) > LATER_DAY_MS).length;
}

export function deriveItemStatus(checkItem, attempts = []) {
  if (!attempts || attempts.length === 0) {
    return {
      status: 'pending',
      evidenceAttemptIds: [],
      gradingSource: undefined,
    };
  }

  // Sort chronologically
  const sorted = [...attempts].sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp));

  let status = 'pending';
  let everIndependentPassed = false;
  let lastGradingSource;

  for (const att of sorted) {
    const isPass = att.correct === true || (typeof att.grade === 'number' && att.grade >= 3);
    const assistanceUsed = !!(
      att.assistance?.used ||
      att.assistance?.hintUsed ||
      att.assistance?.revealedBeforeAnswer ||
      att.assistance?.askedTutorBeforeAnswer
    );

    if (att.gradingSource) lastGradingSource = att.gradingSource;

    if (isPass) {
      if (assistanceUsed) {
        if (!everIndependentPassed) {
          status = 'assisted';
        }
      } else {
        everIndependentPassed = true;
        status = 'passed';
      }
    } else {
      if (everIndependentPassed) {
        // Was once passed, but failed a subsequent check on same target -> needs review
        status = 'needs_review';
      } else if (status !== 'assisted') {
        status = 'pending';
      }
    }
  }

  return {
    status,
    evidenceAttemptIds: sorted.map(a => a.id).filter(Boolean),
    ...(lastGradingSource ? { gradingSource: lastGradingSource } : {}),
  };
}

export function computeSessionProgress(session, attempts = []) {
  const checkItems = Array.isArray(session?.goal?.checkItems) ? session.goal.checkItems : [];
  const totalCount = checkItems.length;

  if (totalCount === 0) {
    return {
      independentPassedCount: 0,
      assistedCount: 0,
      pendingCount: 0,
      needsReviewCount: 0,
      totalCount: 0,
      independentRatio: 0,
      displayLine: '未设定检验项',
      lectureCoveredCount: session?.artifactRefs?.length || 0,
      nextDayDueCount: 0,
      scopeChangedNote: session?.goal?.scopeNote || null,
      items: [],
    };
  }

  // Only what was answered in this session counts: the library's older attempts on the same cards are another session's evidence.
  const since = timeOf(session?.createdAt);
  const inSession = (attempts || []).filter((att) => !since || timeOf(att.timestamp) >= since);
  const backing = new Set();

  const items = checkItems.map(item => {
    const targetCards = new Set(Array.isArray(item.targetCardIds) ? item.targetCardIds : []);
    const topic = item.topic;

    const matching = inSession.filter(att => {
      if (att.quiz_id && targetCards.has(att.quiz_id)) return true;
      if (topic && att.topic === topic) return true;
      return false;
    });

    for (const att of matching) backing.add(att);
    const derived = deriveItemStatus(item, matching);
    return {
      id: item.id,
      title: item.title,
      weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
      status: derived.status,
      evidenceAttemptIds: derived.evidenceAttemptIds,
      ...(derived.gradingSource ? { gradingSource: derived.gradingSource } : {}),
    };
  });

  let independentWeight = 0;
  let totalWeight = 0;
  let independentPassedCount = 0;
  let assistedCount = 0;
  let pendingCount = 0;
  let needsReviewCount = 0;

  for (const item of items) {
    const w = item.weight;
    totalWeight += w;
    if (item.status === 'passed') {
      independentPassedCount++;
      independentWeight += w;
    } else if (item.status === 'assisted') {
      assistedCount++;
    } else if (item.status === 'needs_review') {
      needsReviewCount++;
    } else {
      pendingCount++;
    }
  }

  const independentRatio = totalWeight > 0 ? Number((independentWeight / totalWeight).toFixed(3)) : 0;
  const percent = Math.round(independentRatio * 100);

  let displayLine = `独立检验 ${independentPassedCount}/${totalCount}（${percent}%）`;
  const restParts = [];
  if (assistedCount > 0) restParts.push(`另 ${assistedCount} 项借助提示完成`);
  if (needsReviewCount > 0) restParts.push(`${needsReviewCount} 项需复核`);
  if (pendingCount > 0) restParts.push(`${pendingCount} 项待检验`);
  if (restParts.length > 0) {
    displayLine += `；${restParts.join('，')}`;
  }

  const lectureCoveredCount = session?.artifactRefs
    ? new Set(session.artifactRefs.map(a => a.topic || a.title)).size
    : 0;

  return {
    independentPassedCount,
    assistedCount,
    pendingCount,
    needsReviewCount,
    totalCount,
    independentRatio,
    displayLine,
    lectureCoveredCount,
    nextDayDueCount: cardsDueOnLaterDay(backing),
    scopeChangedNote: session?.goal?.scopeNote || null,
    items,
  };
}
