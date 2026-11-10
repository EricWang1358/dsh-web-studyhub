/**
 * The time an answer took (#883 S2): from the question opening to the answer, less the time the page was hidden.
 * `hiddenMs` is the panel's report and nothing else reads it: anything that is not a finite number above zero counts as nothing,
 * and no report can take off more than the time that went by, so the result is never negative and never above the whole time.
 * A start time that is missing gives NaN, as it always has.
 */
export function answerElapsedMs(startedAt, now, hiddenMs) {
  const whole = Math.max(0, now - startedAt);
  const away = Number.isFinite(hiddenMs) && hiddenMs > 0 ? Math.min(Math.floor(hiddenMs), whole) : 0;
  return whole - away;
}
