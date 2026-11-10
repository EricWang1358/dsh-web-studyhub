import { resolvePracticeSettings } from './practice-settings.js';
import { cardRef, isMasteryAttempt, isUnverifiedSelfReport } from './mastery.js';

/* 顽固题 (#884): a question the learner keeps failing, told from the attempt log alone (no model call). The scheduler's `lapses` is not read: it only counts
   wrong answers on cards that were not new, and starts at 0 for a record migrated from the older format. The numbers are practice settings
   (lib/practice-settings.js), so the wrong book, the round end and the Settings pane say the same thing.

   A question is a leech when
   - it was failed `failures` times in all, or
   - the misses among its latest `window` attempts reach `rate` per cent of the window size (with the defaults: 3 misses in the latest 5 attempts, whether
     or not there are 5 yet; a question with only 3 attempts, all missed, is one).
   It recovers: once the latest `window` attempts are all there and all right, the question is no leech any more, however often it was failed before
   (otherwise the total rule would mark it for ever). One short of that, it still is one.
   Answering right never makes a question a leech: appending a right answer cannot raise the total or the misses in the window, and the recovery only
   ever clears (tests/leech.test.mjs checks every sequence up to length 9).
   Counted are the attempts mastery counts (lib/mastery.js: no retry, nothing answered after the question was opened up again), never an unverified
   self-report and never an implicit credit (a prerequisite passed on the way to a dependent question, `implicit`: the learner did not answer it).
   An attempt failed is a grade under 3, the passing line of the whole app. */

const PASS_GRADE = 3;

/** The three numbers from the library's practice settings (`settings.practice`, absent until the learner saved); the defaults when there are none. */
export function leechLimits(practice) {
  const { leechFailures, leechWindow, leechRate } = resolvePracticeSettings(practice);
  return { failures: leechFailures, window: leechWindow, rate: leechRate };
}

/** How many misses in the latest window make a question a leech (3 with the defaults), for the words that say the rule. */
export const leechMisses = ({ window, rate }) => Math.ceil((window * rate) / 100);

const countedAttempt = attempt => isMasteryAttempt(attempt) && !isUnverifiedSelfReport(attempt) && !attempt.implicit;
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
  return failedLatest * 100 >= limits.rate * limits.window;
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
