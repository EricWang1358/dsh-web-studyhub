import { resolvePracticeSettings } from './practice-settings.js';
import { cardRef, isMasteryAttempt, isUnverifiedSelfReport } from './mastery.js';

/* 顽固题 (#884): a question the learner keeps failing, told from the attempt log alone (no model call). The scheduler's `lapses` is not read: it only counts
   wrong answers on cards that were not new, and starts at 0 for a record migrated from the older format. The numbers are practice settings
   (lib/practice-settings.js), so the wrong book, the round end and the Settings pane say the same thing.

   A question is a leech when
   - it was failed `failures` times in all, or
   - its latest `window` attempts are all there and at least `rate` per cent of them failed.
   It recovers: once the latest `window` attempts are all right, the question is no leech any more, however often it was failed before (otherwise the
   total rule would mark it for ever, and the latest-attempts rule would have nothing to say). One short of that, it still is one.
   Counted are the attempts mastery counts (lib/mastery.js: no retry, nothing answered after the question was opened up again) and never an unverified
   self-report. An attempt failed is a grade under 3, the passing line of the whole app. */

const PASS_GRADE = 3;

/** The three numbers from the library's practice settings (`settings.practice`, absent until the learner saved); the defaults when there are none. */
export function leechLimits(practice) {
  const { leechFailures, leechWindow, leechRate } = resolvePracticeSettings(practice);
  return { failures: leechFailures, window: leechWindow, rate: leechRate };
}

const countedAttempt = attempt => isMasteryAttempt(attempt) && !isUnverifiedSelfReport(attempt);
const byTime = (a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
const latestOf = list => list.reduce((latest, attempt) => (byTime(attempt, latest) > 0 ? attempt : latest));

/** Is the question with these attempts (any order, any kind: the ones that do not count are left out here) a leech? `limits`: leechLimits(). */
export function leechOf(attempts, limits = leechLimits()) {
  const counted = (attempts || []).filter(countedAttempt).sort(byTime);
  const latest = counted.slice(-limits.window);
  const failedLatest = latest.filter(attempt => attempt.grade < PASS_GRADE).length;
  const full = latest.length === limits.window;
  if (full && failedLatest === 0) return false;
  if (counted.filter(attempt => attempt.grade < PASS_GRADE).length >= limits.failures) return true;
  return full && failedLatest * 100 >= limits.rate * limits.window;
}

/** Of these questions (`refs`: [{ deckId, cardId }]), the ones that are a leech and still failed at their latest counted answer, which is where the wrong book's
    待巩固 list has them. One pass over the log, whatever the number of questions. */
export function openLeeches(attempts, refs, limits = leechLimits()) {
  const wanted = new Map(refs.map(ref => [cardRef(ref.deckId, ref.cardId), ref]));
  const own = new Map();
  for (const attempt of attempts || []) {
    const key = cardRef(attempt.deckId, attempt.quiz_id);
    if (!wanted.has(key) || !isMasteryAttempt(attempt)) continue; // the wrong book's own rule for the latest answer; leechOf leaves out what does not count
    const list = own.get(key);
    if (list) list.push(attempt); else own.set(key, [attempt]);
  }
  return [...own].filter(([, list]) => latestOf(list).grade < PASS_GRADE && leechOf(list, limits)).map(([key]) => wanted.get(key));
}
