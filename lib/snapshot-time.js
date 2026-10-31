import { createHash } from 'node:crypto';

/* The minute's poll of the snapshot (#567). The fingerprint rolls over each minute because some parts of the snapshot move
   with the clock alone, with nothing written. When nothing but the minute moved since the fingerprint a panel holds, and
   it said it can take a partial answer (`snapshot { since, partial: true }`), the answer is `{ partial: true, fingerprint,
   ...those parts }`: only the parts that read the clock, and of those only the ones that came out different from what that
   panel holds. Everything else of the snapshot it holds is still current.

   The parts that read the clock within a day (the code they come from):
     today, next, progress   studyMap: due counts and the plan of the day (lib/insights.js, lib/mastery.js)
     focus                   courseRoute: the course's next batch, by due date (lib/course-route.js)
     inactive                inactiveSummary: due cards of parked courses (lib/course-active.js dueOf)
     materialMastery         materialMasteryOf: due state of the cards linked to each page (lib/material-mastery.js)
     decks                   each deck's `due`
     archivedJobs            records older than the archive keeps drop out (lib/job-archive.js alive)
   What changes with the day (the coach's daily rows in `jobs`, the day buckets) is not answered this way: a poll on another
   calendar day than its fingerprint gets the whole snapshot. */

export const TIME_KEYS = Object.freeze(['today', 'next', 'progress', 'focus', 'inactive', 'materialMastery', 'decks', 'archivedJobs']);

/** The fingerprint's minute sits at this place of its array (lib/contexts/library/operations.js builds it). */
export const MINUTE_AT = 6;

/** The minute a fingerprint was built in, or null for anything that is not one. */
export function minuteOf(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint.startsWith('[')) return null;
  try {
    const value = JSON.parse(fingerprint)?.[MINUTE_AT];
    return Number.isSafeInteger(value) ? value : null;
  } catch { return null; }
}

const dayOf = (minute) => new Date(minute * 60000).toDateString();
/** Did only the clock move from `before` to `now` (minutes), inside one calendar day? */
export const sameDayLater = (before, now) => before !== null && before < now && dayOf(before) === dayOf(now);

const hash = (value) => createHash('sha1').update(JSON.stringify(value) ?? '').digest('base64');
const LIMIT = 8;
/** Per library folder: fingerprint -> { key: hash of what was answered under it }. A few, so several open panels each keep theirs. */
const memo = new Map();

/* Answers under one fingerprint are not all alike: it names a minute, and a card can fall due within it, so a caller that asks at
   :05 and another at :40 (the reader's own snapshot, a second panel) can be handed different due counts. A key answered differently
   under the same fingerprint is not known any more (null), so the next partial answer to whoever holds that fingerprint carries it. */
function remember(root, fingerprint, hashes) {
  let entries = memo.get(root);
  if (!entries) { if (memo.size >= 32) memo.delete(memo.keys().next().value); memo.set(root, entries = new Map()); }
  const known = entries.get(fingerprint);
  if (known) { for (const [key, value] of Object.entries(hashes)) if (known[key] !== value) known[key] = null; return; }
  entries.set(fingerprint, hashes);
  while (entries.size > LIMIT) entries.delete(entries.keys().next().value);
}

/** A whole snapshot was answered under `fingerprint`: remember what its clock parts were. */
export function rememberTimed(root, fingerprint, parts) {
  remember(root, fingerprint, Object.fromEntries(TIME_KEYS.filter((key) => Object.hasOwn(parts, key)).map((key) => [key, hash(parts[key])])));
}

/**
 * The clock parts a panel holding the snapshot of `since` needs to be current under `fingerprint`: those whose value differs
 * from what was answered under `since` (all of them when that is not known any more, e.g. after a restart).
 */
export function timedChanges(root, since, fingerprint, parts) {
  const before = memo.get(root)?.get(since), hashes = {}, changed = {};
  // A key not known for `since` (null, or no record at all) is sent.
  for (const key of TIME_KEYS) {
    hashes[key] = hash(parts[key]);
    if (!before?.[key] || before[key] !== hashes[key]) changed[key] = parts[key];
  }
  remember(root, fingerprint, hashes);
  return changed;
}
