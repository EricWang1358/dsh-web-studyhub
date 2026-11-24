/* Pure, zero-i18n slice mastery estimate helper so Node-direct logic modules
   (such as ui/review/round-setup.js) can compute slice pace without importing
   ui/i18n.js or JSON locale bundles. */

const DEFAULT_CARD_SEC = 50;
const DEFAULT_FOCUS_MIN = 25;
const DEFAULT_REWORK = 1.25;
const DEFAULT_FLOOR = 17;

/** Round pomodoro count cleanly (matches lib/pace/forecast.js roundPomodoros). */
export function roundPomodoros(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw < 0.5) return 0.5;
  if (raw < 10) return Math.round(raw * 2) / 2;
  return Math.round(raw);
}

/**
 * Lightweight slice mastery estimate from compact `paceForecast` (used by RoundSetup & Review summary).
 * Never scans raw cards or constructs FSRS engines on the client.
 */
export function buildSliceForecast({
  count = 0,
  range = 'mixed',
  passedCount = null,
  paceForecast = null,
  deckId = null,
  course = null,
  focusMinutes = null,
} = {}) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (n <= 0) return null;
  const pace = paceForecast?.pace || null;
  const cardSec = Number(pace?.medianCardSec) || DEFAULT_CARD_SEC;
  const customFocus = Number(focusMinutes);
  const focusMin = (Number.isFinite(customFocus) && customFocus > 0 ? customFocus : Number(pace?.focusMinutes)) || DEFAULT_FOCUS_MIN;
  const rework = Number(pace?.reworkFactor) || DEFAULT_REWORK;
  const normalFloor = Number(paceForecast?.spacing?.normal) || DEFAULT_FLOOR;
  const focusFloor = Number(paceForecast?.spacing?.focus) || 10;

  let avgPassesLeft = 2.0;
  let floor = normalFloor;
  if (passedCount != null && Number.isFinite(Number(passedCount))) {
    // Round-complete summary: passed cards need ~2 more cross-day passes (~14d), missed cards need 3 (~17d).
    const passed = Math.max(0, Math.min(n, Math.round(Number(passedCount))));
    const missed = n - passed;
    avgPassesLeft = (passed * 2 + missed * 3) / n;
    floor = missed > 0 ? normalFloor : Math.max(focusFloor, Math.round(normalFloor * 0.8));
  } else if (range === 'new' || range === 'wrong') {
    avgPassesLeft = 3.0;
    floor = normalFloor;
  } else if (range === 'due') {
    avgPassesLeft = 1.5;
    floor = Math.max(focusFloor, Math.round(normalFloor * 0.75));
  } else {
    // Mixed round: scale by the scoped deck or course remaining-passes ratio when available.
    const scoped = (deckId && paceForecast?.decks?.[deckId])
      || (course != null && course !== '*' ? paceForecast?.courses?.[course] : paceForecast?.library);
    if (scoped?.remaining > 0 && scoped?.passes > 0) {
      avgPassesLeft = Math.min(3, Math.max(1, scoped.passes / scoped.remaining));
      if (scoped.floor > 0) floor = scoped.floor;
    }
  }

  const rawPasses = Math.round(n * avgPassesLeft);
  const effectiveAttempts = Math.ceil(rawPasses * rework);
  const remainingMinutes = (effectiveAttempts * cardSec) / 60;
  const pomodoros = roundPomodoros(remainingMinutes / focusMin);
  const hours = Math.max(0.1, Math.round((remainingMinutes / 60) * 10) / 10);
  const daily = Number(pace?.dailyAttempts) || 0;
  const days = daily > 0 ? Math.max(Math.ceil(effectiveAttempts / daily), floor) : floor;

  return {
    status: daily > 0 ? 'active' : 'cold-start',
    total: n,
    remaining: n,
    passes: rawPasses,
    pomodoros,
    hours,
    days,
    floor,
    isSlice: true,
  };
}
