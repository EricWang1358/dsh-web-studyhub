/* 有效课程 (owner request, 2.3.2): a course the learner no longer studies can be parked. Pure, no I/O; the backend and
   the UI read the same rule, so a due count, the forecast, the queue and a recommendation can never disagree about
   which decks count.

   State lives on the course record (lib/courses.js): `active: false` parks the course, `active: true` keeps it alive
   inside a parked parent, and no field at all means "follow the parent, default active" - so an old library, and a
   course nobody ever touched, are unchanged. Courses are paths (lib/course-tree.js): the nearest setting on the way up
   decides ("Cloud Native Solution Design" parked, "... / 07 Microservices" explicitly active: chapter 07 stays alive).
   A deck outside any course, and a system deck, are always active.

   Parking only decides what is PUSHED at the learner: due counts, the forecast, the default queue, suggestions, the
   wrong book and the exam pool. It never edits a card, a run, an attempt or a schedule, and choosing a parked course
   (or "show parked courses" for a page view) reads it like any other. */
import { courseKnown, coursePath, courseAncestors } from './course-tree.js';
import { knownCourseNames } from './source-courses.js';
import { cardLevel, latestOutcomes } from './mastery.js';

const key = name => typeof name === 'string' ? name.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
const active = () => ({ active: true, explicit: undefined, by: null });

/** The course name a deck or draft is filed under (legacy `folder`, or only a `courseId`), aliases resolved to the course's name. */
function nameOfDeck(deck, byId, byKey) {
  const stated = deck?.course ?? deck?.folder;
  if (stated === undefined) return byId.get(deck?.courseId)?.name ?? '';
  return byKey.get(key(stated))?.name ?? (typeof stated === 'string' ? stated : '');
}

/**
 * The rule prepared once for a loop: `status(name)` -> `{ active, explicit, by }` (`explicit`: the course's own setting, `by`: the
 * course whose setting decides), `deckActive(deck)`, and `none` when no course states anything (everything is active, cheaply).
 */
export function courseActivityRules(state) {
  const records = (Array.isArray(state?.courses) ? state.courses : []).filter(record => record && typeof record.name === 'string' && key(record.name));
  const stated = records.filter(record => typeof record.active === 'boolean');
  if (!stated.length) return Object.freeze({ none: true, status: active, deckActive: () => true, nameOfDeck: deck => deck?.course ?? deck?.folder ?? '' });
  const known = courseKnown(knownCourseNames(state));
  const explicit = new Map(), names = new Map();
  for (const record of stated) {
    const path = coursePath(record.name, known);
    if (!path) continue;
    explicit.set(path, record.active);
    names.set(path, record.name.trim());
  }
  const byId = new Map(records.filter(record => typeof record.id === 'string').map(record => [record.id, record])), byKey = new Map();
  for (const record of records) if (!byKey.has(key(record.name))) byKey.set(key(record.name), record);
  for (const record of records) for (const alias of Array.isArray(record.aliases) ? record.aliases : []) if (key(alias) && !byKey.has(key(alias))) byKey.set(key(alias), record);
  const status = name => {
    const text = typeof name === 'string' ? (byKey.get(key(name))?.name ?? name) : '';
    if (!key(text)) return active();
    const chain = courseAncestors(text, known), self = chain[chain.length - 1];
    for (let i = chain.length - 1; i >= 0; i--) if (explicit.has(chain[i]))
      return { active: explicit.get(chain[i]), explicit: chain[i] === self ? explicit.get(self) : undefined, by: names.get(chain[i]) };
    return active();
  };
  const cache = new Map();
  const deckActive = deck => {
    if (!deck || deck.systemKind) return true;
    const name = nameOfDeck(deck, byId, byKey);
    if (!cache.has(name)) cache.set(name, status(name).active);
    return cache.get(name);
  };
  return Object.freeze({ none: false, status, deckActive, nameOfDeck: deck => nameOfDeck(deck, byId, byKey) });
}

/** `{ active, explicit, by }` of one course name (see courseActivityRules). */
export const courseStatus = (state, name) => courseActivityRules(state).status(name);

/** `deck => boolean`: does this deck count (its course, or an ancestor, is not parked)? */
export const deckIsActive = state => courseActivityRules(state).deckActive;

/** The decks that count; `includeInactive` is the learner's "show parked courses" for a page view. */
export function activeDecks(state, { includeInactive = false } = {}) {
  const decks = Array.isArray(state?.decks) ? state.decks : [];
  if (includeInactive) return decks;
  const test = deckIsActive(state);
  return decks.filter(test);
}

/** Ids of the decks that do not count (every parked deck, archived ones included: they never count anyway). */
export function inactiveDeckIds(state) {
  const rules = courseActivityRules(state);
  return rules.none ? new Set() : new Set((state.decks || []).filter(deck => !rules.deckActive(deck)).map(deck => deck.id));
}

/** What the course list and the snapshot say about one course: `{ active, explicit?, inactiveBy? }`. */
export function activityFields(rules, name) {
  const status = rules.status(name);
  return { active: status.active, ...(status.explicit !== undefined ? { explicit: status.explicit } : {}),
    ...(!status.active && status.explicit === undefined && status.by ? { inactiveBy: status.by } : {}) };
}

const dueNow = (card, outcome, deckId, now) => !card.suspended && !!card.review?.due_at && Date.parse(card.review.due_at) <= now &&
  cardLevel(card, outcome(deckId, card.id)) !== 'new';

/** Due cards of some decks, the way the dashboard counts them: scheduled, not new, due now; `overdue` is due before today began. */
export function dueOf(decks, outcome, now = Date.now()) {
  const stamp = typeof now === 'number' ? now : +now, startOfToday = new Date(stamp).setHours(0, 0, 0, 0);
  let due = 0, overdue = 0;
  for (const deck of decks) for (const card of deck.cards || []) if (dueNow(card, outcome, deck.id, stamp)) {
    due++;
    if (Date.parse(card.review.due_at) < startOfToday) overdue++;
  }
  return { due, overdue };
}

/**
 * What parked courses leave out of the learner's view, for "不含 N 门未激活的课程": courses holding decks, those decks, their
 * due cards. `only` (a Set of deck ids) narrows it to what one page view actually left out.
 */
export function inactiveSummary(state, now = Date.now(), only = null) {
  const rules = courseActivityRules(state);
  if (rules.none || (only && !only.size)) return { courses: 0, decks: 0, due: 0, overdue: 0 };
  const left = (state.decks || []).filter(deck => !deck.archived && !deck.systemKind && !rules.deckActive(deck) && (!only || only.has(deck.id)));
  const outcome = latestOutcomes(state.attempts || []);
  return { courses: new Set(left.map(deck => rules.nameOfDeck(deck))).size, decks: left.length, ...dueOf(left, outcome, now) };
}
