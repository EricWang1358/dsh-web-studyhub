/* How long the page was hidden while one question was open (#883 S2), without React or the DOM. useReviewSession keeps one clock for the question
   on screen, feeds it the page's visibility changes and sends what it counted with the answer; the host takes it off the recorded time (lib/answer-time.js).
   The clock is the panel's memory only: a reload starts a new one, and so does every other question, tail retries included. */

/** A clock for the question named `key`, opened at `at` (ms); `hidden`: the page is hidden right now. */
export const openClock = (key, at, hidden) => ({ key, ms: 0, since: hidden ? at : null });

/** The page became hidden or visible at `at`. A change to what it already was changes nothing. */
export function noteVisibility(clock, hidden, at) {
  if (!clock) return clock;
  if (hidden) return clock.since === null ? { ...clock, since: at } : clock;
  return clock.since === null ? clock : { ...clock, ms: clock.ms + Math.max(0, at - clock.since), since: null };
}

/** The hidden time of question `key` up to `at`, counting a stretch still going. 0 for any other question than the one the clock was opened for. */
export function hiddenMsOf(clock, key, at) {
  if (!clock || clock.key !== key) return 0;
  return clock.ms + (clock.since === null ? 0 : Math.max(0, at - clock.since));
}
