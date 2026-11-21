/* Pure lightweight flow-cadence streak and leech-conquest checks.
   Zero external imports so esbuild keeps it a leaf chunk without extending workspace static load waves. */

const isPassed = (run) => Boolean(run?.feedback && (run.feedback.grade !== undefined ? run.feedback.grade >= 3 : run.feedback.correct));

function navItemPassed(item) {
  if (!item || !item.answered || item.grading) return null;
  if (typeof item.passed === 'boolean') return item.passed;
  if (typeof item.correct === 'boolean') return item.correct;
  return null;
}

/**
 * Compute consecutive correct answers in the active review round.
 * Quietly returns null below 3 or on miss (zero guilt, voice-and-tone Rule 7).
 */
export function computeFlowStreak(run) {
  if (!run || run.mode === 'exam') return null;
  // If the current card was just answered and missed, streak resets silently right away.
  if (run.feedback && !run.feedback.selfReported && run.feedback.assessment !== 'self-report' && !isPassed(run)) {
    return null;
  }

  const outcomes = [];
  const nav = Array.isArray(run.navigation) ? run.navigation : [];
  let sawCurrent = false;
  for (const item of nav) {
    const verdict = navItemPassed(item);
    if (verdict === null) continue;
    if (item.index === run.index) sawCurrent = true;
    outcomes.push(verdict);
  }
  if (!sawCurrent && run.feedback && !run.feedback.selfReported && run.feedback.assessment !== 'self-report') {
    outcomes.push(isPassed(run));
  }

  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    if (outcomes[i]) streak += 1;
    else break;
  }
  if (streak < 3) return null;

  const isMilestone = streak === 3 || streak === 5 || streak === 8 || (streak > 8 && streak % 5 === 0);
  if (streak >= 8) {
    return {
      streak,
      tier: 3,
      labelKey: '连对 {0} · 如鱼得水',
      taglineKey: '如鱼得水',
      isMilestone,
    };
  }
  if (streak >= 5) {
    return {
      streak,
      tier: 2,
      labelKey: '连对 {0} · 渐入佳境',
      taglineKey: '渐入佳境',
      isMilestone,
    };
  }
  return {
    streak,
    tier: 1,
    labelKey: '连对 {0} · 手感渐稳',
    taglineKey: '手感渐稳',
    isMilestone,
  };
}

/**
 * True when the active card was previously a stubborn/leech card and the learner just passed it.
 * Checks both active `isLeech` and `priorMisses >= 2` (so a card that just graduated out of leech
 * status on this passing attempt is still honestly recognized).
 */
export function isLeechConquered(run) {
  if (!run || run.mode === 'exam' || run.complete) return false;
  if (!run.feedback || run.feedback.selfReported || run.feedback.assessment === 'self-report') return false;
  if (!isPassed(run)) return false;
  const stubborn = run.stubborn;
  if (!stubborn || typeof stubborn !== 'object') return false;
  return Boolean(stubborn.isLeech || (Number(stubborn.priorMisses) || 0) >= 2);
}
