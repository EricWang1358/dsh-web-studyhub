/**
 * 100% pure function module for study remaining time interval estimation.
 * The pace is the time a question was open until it was answered, capped per question: a long absence with a question open counts up to the cap.
 */

export const MAX_SINGLE_CARD_ACTIVE_MS = 8 * 60 * 1000; // 8 minutes cap per question to prevent idle inflation
/** Independent passes a learner needs before the estimate stops being called 初步估计: with fewer, the pace is a guess from one or two questions. */
export const MIN_PASSES_FOR_PACE = 3;

/**
 * The answering time of the questions that back a check item, read from the attempts the library already records (`elapsed_ms`),
 * so the same answer is never counted twice and nothing has to be logged beside it.
 */
export function activityFromAttempts(progress, attempts = []) {
  const backing = new Set((progress?.items || []).flatMap((item) => item.evidenceAttemptIds || []));
  return (attempts || [])
    .filter((att) => backing.has(att.id) && Number.isFinite(att.elapsed_ms))
    .map((att) => ({ kind: 'question_answering', durationMs: att.elapsed_ms, attemptId: att.id }));
}

export function filterEffectiveStudyActivity(activityLog = []) {
  let activeStudyMs = 0;
  let generationWaitMs = 0;
  let pausedMs = 0;
  let readingMs = 0;

  for (const act of activityLog || []) {
    const duration = Math.max(0, act.durationMs || 0);
    if (act.kind === 'question_answering') {
      activeStudyMs += Math.min(duration, MAX_SINGLE_CARD_ACTIVE_MS);
    } else if (act.kind === 'generation_wait') {
      generationWaitMs += duration;
    } else if (act.kind === 'paused') {
      pausedMs += duration;
    } else if (act.kind === 'reading') {
      readingMs += duration;
    }
  }

  return { activeStudyMs, generationWaitMs, pausedMs, readingMs };
}

export function estimateRemainingTime(session, progress, activityLog = []) {
  if (!session || !progress) {
    return {
      status: 'estimating',
      minMinutes: null,
      maxMinutes: null,
      remainingItems: 0,
      message: '尚在估计，完成首个检验后更新',
      display: '尚在估计',
    };
  }

  const pendingCount = progress.pendingCount || 0;
  const assistedCount = progress.assistedCount || 0;
  const needsReviewCount = progress.needsReviewCount || 0;
  const passedCount = progress.independentPassedCount || 0;

  const remainingItems = pendingCount + assistedCount + needsReviewCount;
  if (remainingItems === 0) {
    return {
      status: 'completed',
      minMinutes: 0,
      maxMinutes: 0,
      remainingItems: 0,
      message: '已完成本次全部检验目标',
      display: '已完成',
    };
  }

  // If no items have passed yet and no activity sample exists
  const { activeStudyMs } = filterEffectiveStudyActivity(activityLog);
  if (passedCount === 0 && activeStudyMs < 60000) {
    return {
      status: 'estimating',
      minMinutes: null,
      maxMinutes: null,
      remainingItems,
      message: '尚在估计，完成首个检验后更新',
      display: '尚在估计',
    };
  }

  // Base interval calculation:
  // pending: [4, 8] min
  // assisted / needs_review: [3, 6] min
  // prerequisite returnPath depth gap: [3, 5] min per branch
  let minMinutes = pendingCount * 4 + (assistedCount + needsReviewCount) * 3;
  let maxMinutes = pendingCount * 8 + (assistedCount + needsReviewCount) * 6;

  const returnPathDepth = session.returnPath?.length || 0;
  if (returnPathDepth > 0) {
    minMinutes += returnPathDepth * 3;
    maxMinutes += returnPathDepth * 5;
  }

  // If observed active answering speed is fast, adjust gently
  if (passedCount > 0 && activeStudyMs > 0) {
    const avgPassMinutes = (activeStudyMs / 60000) / passedCount;
    if (avgPassMinutes < 3) {
      minMinutes = Math.max(1, Math.round(minMinutes * 0.85));
      maxMinutes = Math.max(minMinutes + 2, Math.round(maxMinutes * 0.9));
    }
  }

  // A pace seen in one or two questions is a guess: say so, so the range is never read as a promise.
  const preliminary = passedCount < MIN_PASSES_FOR_PACE;
  return {
    status: 'estimated',
    minMinutes,
    maxMinutes,
    remainingItems,
    preliminary,
    display: `${minMinutes}–${maxMinutes} 分钟`,
    message: `预计达到本次检验目标还需 ${minMinutes}–${maxMinutes} 分钟${preliminary ? '（初步估计）' : ''}`,
  };
}

export function shouldRecordPrediction(prevPrediction, nextEstimate, reason = '', now = Date.now()) {
  if (!nextEstimate || nextEstimate.status !== 'estimated') return null;

  if (!prevPrediction) {
    return {
      at: now,
      reason: reason || '初次估算',
      minMinutes: nextEstimate.minMinutes,
      maxMinutes: nextEstimate.maxMinutes,
      remainingItems: nextEstimate.remainingItems,
    };
  }

  const minDiff = Math.abs((prevPrediction.minMinutes || 0) - nextEstimate.minMinutes);
  const maxDiff = Math.abs((prevPrediction.maxMinutes || 0) - nextEstimate.maxMinutes);

  // Significant difference (e.g. shift of >= 4 minutes or reason specified)
  if (minDiff >= 4 || maxDiff >= 4 || (reason && reason !== '初次估算')) {
    return {
      at: now,
      reason: reason || '目标范围或前置支线调整',
      minMinutes: nextEstimate.minMinutes,
      maxMinutes: nextEstimate.maxMinutes,
      remainingItems: nextEstimate.remainingItems,
    };
  }

  return null;
}
