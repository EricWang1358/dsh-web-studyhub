/**
 * 100% pure function module for StudyHub 4.0 goal checkItem status and progress derivation.
 * Zero I/O, zero model calls, zero side effects.
 */

/**
 * The one definition of "helped": the help recorded on an answer, whole, added up over any number of records (an entry's assistance, what an attempt keeps of it, what a save
 * brings). Evidence is never taken back; nothing recorded means answered alone.
 * Flipping a self-graded card is not in here: it is how that card is answered (review.answer refuses a grade before it), and no other card can be flipped before its answer.
 */
export function assistanceEvidence(...records) {
  const any = (flag) => records.some((recorded) => !!recorded?.[flag]);
  const hintUsed = any('hintUsed'), revealedBeforeAnswer = any('revealedBeforeAnswer'), askedTutorBeforeAnswer = any('askedTutorBeforeAnswer');
  return { used: any('used') || hintUsed || revealedBeforeAnswer || askedTutorBeforeAnswer, hintUsed, revealedBeforeAnswer, askedTutorBeforeAnswer };
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
  const sorted = [...attempts].sort((a, b) => {
    const timeA = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp || 0) || 0;
    const timeB = typeof b.timestamp === 'number' ? b.timestamp : Date.parse(b.timestamp || 0) || 0;
    return timeA - timeB;
  });

  let status = 'pending';
  let everIndependentPassed = false;
  let lastGradingSource;

  for (const att of sorted) {
    const isPass = att.correct === true || (typeof att.grade === 'number' && att.grade >= 3);
    // A tail retry comes after a wrong answer showed the right one: it passes, but not independently.
    const independent = !att.retry && !assistanceEvidence(att.assistance).used;

    if (att.gradingSource) lastGradingSource = att.gradingSource;

    if (isPass) {
      if (independent) {
        everIndependentPassed = true;
        status = 'passed';
      } else if (!everIndependentPassed) {
        status = 'assisted';
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

export function computeSessionProgress(session, attempts = [], runs = []) {
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

  const items = checkItems.map(item => {
    const targetCards = new Set(Array.isArray(item.targetCardIds) ? item.targetCardIds : []);
    const topic = item.topic;

    const matching = (attempts || []).filter(att => {
      if (att.quiz_id && targetCards.has(att.quiz_id)) return true;
      if (topic && att.topic === topic) return true;
      return false;
    });

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

  // Count cards with future review due from runs
  let nextDayDueCount = 0;
  const now = Date.now();
  for (const r of runs || []) {
    for (const e of r.entries || []) {
      const nextDue = e.feedback?.nextDue ? Date.parse(e.feedback.nextDue) : 0;
      if (nextDue > now + 12 * 3600 * 1000) {
        nextDayDueCount++;
      }
    }
  }

  return {
    independentPassedCount,
    assistedCount,
    pendingCount,
    needsReviewCount,
    totalCount,
    independentRatio,
    displayLine,
    lectureCoveredCount,
    nextDayDueCount,
    scopeChangedNote: session?.goal?.scopeNote || null,
    items,
  };
}
