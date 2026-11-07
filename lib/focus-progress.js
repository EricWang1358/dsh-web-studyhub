import { cardLevel, latestOutcomes, summarize, LEVELS } from "./mastery.js";
import { decksInCourse } from "./focus.js";
import { cleanFocusTopics, courseFocusTopics, focusMatcher } from "./focus-points.js";
import { PRACTICE_LIMITS } from "./practice-settings.js";

/* 重点 × 掌握度 (#690): the course's saved focus topics (course.focusTopics, a chapter inherits its parent's) read against what the
   learner has answered. For each topic: how many questions it has, how they split over the mastery levels, and which ones are weak.
   Pure and deterministic: the state and a clock in, a plain object out; no model call, nothing stored (the answers stay the only source).
   A question belongs to every topic its topic / objective / prompt matches, the same fields and the same matcher the scheduler, the
   queue and the generator use (lib/focus-points.js cardFocusSource). The questions are those of the course's active decks, as the
   course route counts them (lib/focus.js decksInCourse, no suspended card). */

/** One practice round at its largest: what 「练还不会的重点」 starts at most. */
export const FOCUS_PRACTICE_LIMIT = PRACTICE_LIMITS.roundSize.max;

// A topic with a weak question comes first, one with no question next (nothing to practise yet), done topics last.
const URGENCY = { weak: 0, none: 1, todo: 2, active: 2, done: 3 };

/** Generation urgency order (#690 S2): empty focus topics (`none`) first, then `weak`, then `todo` / `active`, and `done` last. */
export const GENERATION_FOCUS_PRIORITY = Object.freeze({ none: 0, weak: 1, todo: 2, active: 2, done: 3 });

const emptyReadout = (course) => ({ course, topics: [], total: 0, done: 0, weak: 0, none: 0, weakScope: [] });

/** The status of one topic: `none` (no question), `weak` (a weak question), else the mastery summary's todo / active / done. */
function topicStatus(summary) {
  if (!summary.total) return "none";
  return summary.counts.weak ? "weak" : summary.status;
}

/**
 * `{ course, topics: [{ topic, cards, counts, mastery, status, weakCards }], total, done, weak, none, weakScope }` for `course`
 * (a chapter course reads its parent's topics; the whole course also reads its chapters'). `topics` is empty when the course has
 * no focus topics, which is the cheap case: nothing is read but the course records.
 */
export function focusProgress(state, course, { now = Date.now() } = {}) {
  const matcher = focusMatcher(courseFocusTopics(state, course, { includeDescendants: true }));
  if (matcher.empty) return emptyReadout(course);
  const outcome = latestOutcomes(state.attempts);
  const items = new Map(matcher.topics.map((topic) => [topic, []]));
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards) {
      if (card.suspended) continue;
      const hit = matcher.matchingTopics(card.topic, card.objective, card.prompt);
      if (!hit.length) continue;
      const item = { card, deckId: deck.id, level: cardLevel(card, outcome(deck.id, card.id)) };
      for (const topic of hit) items.get(topic).push(item);
    }
  }
  const topics = [...items].map(([topic, list]) => {
    const summary = summarize(list, now);
    return {
      topic, cards: summary.total, counts: Object.fromEntries(LEVELS.map((level) => [level, summary.counts[level]])),
      mastery: summary.mastery, status: topicStatus(summary),
      weakCards: list.filter((item) => item.level === "weak").map((item) => ({ deckId: item.deckId, cardId: item.card.id })),
    };
  }).sort((a, b) => URGENCY[a.status] - URGENCY[b.status]);
  const weakScope = [...new Map(topics.flatMap((topic) => topic.weakCards).map((ref) => [`${ref.deckId}\0${ref.cardId}`, ref])).values()]
    .slice(0, FOCUS_PRACTICE_LIMIT);
  const count = (status) => topics.filter((topic) => topic.status === status).length;
  return { course, topics, total: topics.length, done: count("done"), weak: count("weak"), none: count("none"), weakScope };
}

/**
 * Stably order `topics` for question generation (`none` -> `weak` -> `todo` / `active` -> `done`, ties kept in input order),
 * counting the course's active deck questions plus any unpublished `extraCards` (e.g. a draft being continued).
 * -> `{ topics: string[], statusByTopic: Record<string, 'none' | 'weak' | 'todo' | 'active' | 'done'> }`.
 */
export function prioritizeFocusTopics(state, course, topics, { extraCards = [], now = Date.now() } = {}) {
  const cleaned = cleanFocusTopics(topics, { limit: 200 });
  if (!cleaned.length) return { topics: [], statusByTopic: {} };
  const matcher = focusMatcher(cleaned);
  if (matcher.empty) return { topics: cleaned, statusByTopic: Object.fromEntries(cleaned.map((topic) => [topic, "none"])) };
  const outcome = latestOutcomes(state?.attempts);
  const items = new Map(matcher.topics.map((topic) => [topic, []]));
  if (state && typeof course === "string" && course.trim() && course !== "*") {
    for (const deck of decksInCourse(state, course)) {
      for (const card of deck.cards || []) {
        if (!card || card.suspended) continue;
        const hit = matcher.matchingTopics(card.topic, card.objective, card.prompt);
        if (!hit.length) continue;
        const item = { card, deckId: deck.id, level: cardLevel(card, outcome(deck.id, card.id)) };
        for (const topic of hit) items.get(topic).push(item);
      }
    }
  }
  for (const card of Array.isArray(extraCards) ? extraCards : []) {
    if (!card || card.suspended) continue;
    const hit = matcher.matchingTopics(card.topic, card.objective, card.prompt);
    if (!hit.length) continue;
    const item = { card, deckId: "", level: cardLevel(card, null) };
    for (const topic of hit) items.get(topic).push(item);
  }
  const statusByTopic = {};
  for (const topic of matcher.topics) {
    statusByTopic[topic] = topicStatus(summarize(items.get(topic) || [], now));
  }
  const ordered = matcher.topics
    .map((topic, index) => ({ topic, index, tier: GENERATION_FOCUS_PRIORITY[statusByTopic[topic]] ?? 2 }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.topic);
  return { topics: ordered, statusByTopic };
}

/**
 * How many of `course`'s saved focus topics (`courseFocusTopics` with descendants) have at least one active question in `cards`:
 * `{ total, covered, uncovered }` (`uncovered`: focus topic strings without a matching question), or `null` when the course has no focus topics.
 */
export function focusCoverageOf(state, { course, cards = [] } = {}) {
  const topics = courseFocusTopics(state, course, { includeDescendants: true });
  if (!topics.length) return null;
  const active = (Array.isArray(cards) ? cards : []).filter((card) => card && !card.suspended);
  const uncovered = topics.filter((topic) => {
    const matcher = focusMatcher([topic]);
    return matcher.empty || !active.some((card) => matcher.matchesText(card.topic) || matcher.matchesText(card.objective) || matcher.matchesText(card.prompt));
  });
  return { total: topics.length, covered: topics.length - uncovered.length, uncovered };
}
