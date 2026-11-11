/** Mastery levels derived from FSRS-6 state and the latest attempt; no extra storage. */
import { retrievabilityAt } from "./sm2.js";
import { createReadingOrder, sortCardsByReadingOrder } from "./reading-order/card-reading-order.js";

export const LEVELS = ["new", "weak", "learning", "familiar", "mastered"];
const WEIGHT = { new: 0, weak: 0.15, learning: 0.45, familiar: 0.75, mastered: 1 };
const MASTERED = 80;
/** The weights and the "done" line of the dashboard, shared so a material's mastery (lib/material-mastery.js) is the same number. */
export const LEVEL_WEIGHT = WEIGHT;
export const DONE_MASTERY = MASTERED;
/** Only answers that applied to the current question contribute to its learning state. */
export const isMasteryAttempt = (attempt) => !attempt.retry && !attempt.updatedAfterOpening;
/** Unverified hands-on task self-report (`写完了（自报）`, #778): enters FSRS-6 spaced scheduling, never counts as a verified pass. */
export const isUnverifiedSelfReport = (attempt) =>
  !!(attempt?.selfReported || attempt?.unverified || attempt?.assessment === "self-report");

// The committed attempts are one deep-frozen array until a commit adds to them; the snapshot asks for the outcomes five times
// (map, focus, course route, deck progress ...), and each used to stringify a key per attempt and per lookup. A frozen
// array's outcomes are built once and remembered; a plain array (a draft being worked on) is always read afresh.
const outcomesOfFrozen = new WeakMap();
export function latestOutcomes(attempts) {
  const frozen = Object.isFrozen(attempts);
  if (frozen && outcomesOfFrozen.has(attempts)) return outcomesOfFrozen.get(attempts);
  // deck -> card -> grade. A missing id counts as null, as it did when the key was JSON text.
  const byDeck = new Map();
  for (const attempt of attempts) {
    if (!isMasteryAttempt(attempt)) continue;
    const deck = attempt.deckId ?? null;
    let cards = byDeck.get(deck);
    if (!cards) byDeck.set(deck, cards = new Map());
    cards.set(attempt.quiz_id ?? null, attempt.grade);
  }
  const outcome = (deckId, cardId) => byDeck.get(deckId ?? null)?.get(cardId ?? null);
  if (frozen) outcomesOfFrozen.set(attempts, outcome);
  return outcome;
}
const verifiedOutcomesOfFrozen = new WeakMap();
/** Latest verified outcome per question: an unverified self-report never counts as answered/passed and clears prior credit until re-verified (#778). */
export function latestVerifiedOutcomes(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const frozen = Object.isFrozen(list);
  if (frozen && verifiedOutcomesOfFrozen.has(list)) return verifiedOutcomesOfFrozen.get(list);
  const byDeck = new Map();
  for (const attempt of list) {
    if (!isMasteryAttempt(attempt)) continue;
    const deck = attempt.deckId ?? null;
    if (isUnverifiedSelfReport(attempt)) {
      byDeck.get(deck)?.delete(attempt.quiz_id ?? null);
      continue;
    }
    let cards = byDeck.get(deck);
    if (!cards) byDeck.set(deck, cards = new Map());
    cards.set(attempt.quiz_id ?? null, attempt.grade);
  }
  const outcome = (deckId, cardId) => byDeck.get(deckId ?? null)?.get(cardId ?? null);
  if (frozen) verifiedOutcomesOfFrozen.set(list, outcome);
  return outcome;
}
/** The interval lines of 熟悉 and 已掌握, in days. */
export const FAMILIAR_DAYS = 6, MASTERED_DAYS = 21;
/** 已掌握 also takes this many right answers in a row: no scheduler setting (a low target recall gives a first gap of
    3 weeks) makes one answer "mastered". */
export const MASTERED_STREAK = 2;
export function cardLevel(card, lastGrade) {
  if (lastGrade === undefined && !(card.review?.repetitions > 0)) return "new";
  if (lastGrade !== undefined && lastGrade < 3) return "weak";
  // 轻松掌握 (a self-graded 5) is the learner's own call: show it as mastered at
  // once. Only self-grading gives 5 (a correct choice or cloze answer is 4, or 3 when the hint was used), and
  // the schedule still brings the card back on its interval. (Unchanged since SM-2.)
  if (lastGrade === 5) return "mastered";
  const days = Number(card.review?.interval_days) || 0, streak = Number(card.review?.repetitions) || 0;
  // A review scheduled under a maximum below a line (lib/sm2.js keeps that maximum on it) can never reach the line:
  // the line comes down to the maximum, so the level means the same whatever the settings.
  const cap = Number(card.review?.maximum_interval);
  const line = (value) => (Number.isFinite(cap) && cap >= 1 ? Math.min(value, cap) : value);
  if (days >= line(MASTERED_DAYS) && streak >= MASTERED_STREAK) return "mastered";
  return days >= line(FAMILIAR_DAYS) ? "familiar" : "learning";
}
export const isDue = (card, now) =>
  !!card.review?.due_at && Date.parse(card.review.due_at) <= now;

/** Counts, mastery % and status (todo / active / done) of some `{ card, level }` items; deck, topic and focus-topic progress all use it. */
export function summarize(items, now) {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  let weight = 0,
    due = 0;
  for (const { card, level } of items) {
    counts[level]++;
    weight += WEIGHT[level];
    if (level !== "new" && isDue(card, now)) due++;
  }
  const total = items.length,
    mastery = total ? Math.round((weight / total) * 100) : 0;
  return {
    total,
    counts,
    mastery,
    due,
    status:
      !total || counts.new === total
        ? "todo"
        : mastery >= MASTERED && !counts.weak
          ? "done"
          : "active",
  };
}
/** Per-deck and per-topic progress; topics keep their first-appearance (syllabus) order. */
export function deckProgress(deck, outcome, now = Date.now()) {
  const items = deck.cards
    .filter((card) => !card.suspended)
    .map((card) => ({ card, level: cardLevel(card, outcome(deck.id, card.id)) }));
  const topics = new Map();
  for (const item of items) {
    const name = item.card.topic || "未分类";
    if (!topics.has(name)) topics.set(name, []);
    topics.get(name).push(item);
  }
  return {
    ...summarize(items, now),
    topics: [...topics].map(([name, list]) => ({
      name,
      ...summarize(list, now),
    })),
  };
}
/** The next topic in reading/syllabus order that is not yet mastered (focus topics first only when `newCardOrder === 'focus'`). */
export function nextTopic(decks, outcome, now = Date.now(), { isFocus, sources, newCardOrder = "reading" } = {}) {
  const focusFn = typeof isFocus === "function" ? isFocus : (_deck, card) => card?.focus === true;
  const focusFirst = newCardOrder === "focus";
  let fallback = null;
  for (const deck of decks) {
    if (deck.archived) continue;
    const orderedDeck = sources?.length ? { ...deck, cards: sortCardsByReadingOrder(deck.cards, sources) } : deck;
    const focusTopics = new Set();
    for (const card of orderedDeck.cards) {
      if (!card.suspended && focusFn(deck, card)) focusTopics.add(card.topic || "未分类");
    }
    for (const topic of deckProgress(orderedDeck, outcome, now).topics) {
      if (topic.status === "done") continue;
      const candidate = {
        deckId: deck.id,
        deckTitle: deck.title,
        topic: topic.name,
        mastery: topic.mastery,
        ...(focusTopics.has(topic.name) ? { focus: true } : {}),
      };
      if (focusFirst && candidate.focus) return candidate;
      if (!focusFirst) return candidate;
      fallback ||= candidate;
    }
  }
  return fallback;
}
export const scopeKey = (mode, scope = []) =>
  JSON.stringify([
    mode,
    [...scope]
      .map((x) => (x.cardId ? [x.deckId, "", x.cardId] : [x.deckId, x.topic || ""]))
      .sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : 1)),
  ]);
export const cardRef = (deckId, cardId) => JSON.stringify([deckId, cardId]);
/** Every active, unsuspended card by reference, with its current level. */
export function cardIndex(decks, outcome) {
  const index = new Map();
  for (const deck of decks) {
    if (deck.archived) continue;
    for (const card of deck.cards)
      if (!card.suspended)
        index.set(cardRef(deck.id, card.id), {
          deckId: deck.id,
          card,
          level: cardLevel(card, outcome(deck.id, card.id)),
        });
  }
  return index;
}
/**
 * Put prerequisites before the cards that require them. Unlearned (new or
 * weak) prerequisites outside the list are pulled in when `pull` is set;
 * learned ones are not repeated. Cycles are cut at the first revisit.
 */
export function orderByPrerequisites(items, index, pull = true) {
  const listed = new Set(items.map((x) => cardRef(x.deckId, x.card.id))),
    seen = new Set(),
    out = [];
  const visit = (item) => {
    const ref = cardRef(item.deckId, item.card.id);
    if (seen.has(ref)) return;
    seen.add(ref);
    for (const r of item.card.requires || []) {
      const pre = index.get(cardRef(r.deckId, r.cardId));
      if (!pre) continue;
      const refPre = cardRef(pre.deckId, pre.card.id);
      if (listed.has(refPre) || (pull && ["new", "weak"].includes(pre.level)))
        visit(pre);
    }
    out.push(item);
  };
  items.forEach(visit);
  return out;
}
/**
 * Due cards in the order a round takes them: 重点 first, then the lowest predicted recall at `now` (lib/sm2.js retrievability:
 * the question most likely forgotten by now), then the earlier due date, then the order they came in (the sort is stable). The
 * model is built once for the pass and each card's recall is computed once. It uses the default weights: every FSRS-6 curve
 * falls with elapsed days / stability alone, so a learner's own weights order the same cards the same way
 * (tests/fsrs-parity.test.mjs).
 */
function dueOrder(items, now) {
  const recall = retrievabilityAt();
  const key = new Map(items.map((x) => [x, { recall: recall(x.card.review, now), due: Date.parse(x.card.review.due_at) }]));
  return items.sort((a, b) => {
    const ka = key.get(a), kb = key.get(b);
    return Number(b.focus) - Number(a.focus) || ka.recall - kb.recall || ka.due - kb.due;
  });
}
/**
 * Learning path for a scope (empty = every active deck): due reviews (see dueOrder), then
 * weak cards, then new cards in syllabus order, with unlearned prerequisites
 * placed before the cards that need them. When nothing is pending the
 * weakest cards are offered so a session can always start.
 */
export function planPath(decks, outcome, options = {}) {
  const {
    scope = [],
    now = Date.now(),
    newLimit = 10,
    limit = 20,
    isFocus,
    focusOnly = false,
    newFilter,
    sources = [],
    newCardOrder = "reading",
    shuffle,
  } = options;
  const allowNew = typeof newFilter === "function" ? newFilter : null;
  const focusFn = typeof isFocus === "function" ? isFocus : (_deck, card) => card?.focus === true;
  const compareReading = createReadingOrder(sources);
  const wanted = (deck, card) =>
    (!focusOnly || focusFn(deck, card)) &&
    (!scope.length ||
      scope.some(
        (x) =>
          x.deckId === deck.id &&
          (x.cardId
            ? x.cardId === card.id
            : !x.topic || x.topic === (card.topic || "未分类")),
      ));
  const pool = [];
  for (const deck of decks) {
    if (deck.archived) continue;
    const orderedCards = sortCardsByReadingOrder(deck.cards, sources);
    const order = new Map();
    for (const card of orderedCards)
      if (!order.has(card.topic)) order.set(card.topic, order.size);
    orderedCards.forEach((card, index) => {
      if (card.suspended || !wanted(deck, card)) return;
      pool.push({
        deckId: deck.id,
        card,
        focus: !!focusFn(deck, card),
        level: cardLevel(card, outcome(deck.id, card.id)),
        rank: [order.get(card.topic), index],
      });
    });
  }
  // A due prerequisite is covered when a card that builds on it is also due:
  // answering that card correctly credits the prerequisite (see review.answer).
  const covered = new Set(
    pool
      .filter((x) => !["new", "weak"].includes(x.level) && isDue(x.card, now))
      .flatMap((x) => (x.card.requires || []).map((r) => cardRef(r.deckId, r.cardId))),
  );
  const due = dueOrder(
      pool
        .filter((x) => !["new", "weak"].includes(x.level) && isDue(x.card, now))
        .filter((x) => !covered.has(cardRef(x.deckId, x.card.id))),
      now,
    ),
    weak = pool
      .filter((x) => x.level === "weak")
      .sort((a, b) => Number(b.focus) - Number(a.focus) || compareReading(a.card, b.card)),
    rawFresh = pool.filter((x) => x.level === "new" && (!allowNew || allowNew(x.deckId, x.card))),
    fresh =
      newCardOrder === "focus"
        ? [...rawFresh].sort(
            (a, b) => Number(b.focus) - Number(a.focus) || compareReading(a.card, b.card),
          )
        : newCardOrder === "shuffle" && typeof shuffle === "function"
          ? shuffle(rawFresh)
          : [...rawFresh].sort((a, b) => compareReading(a.card, b.card)),
    aheadPool = allowNew ? pool.filter((x) => allowNew(x.deckId, x.card)) : pool;
  let entries = [...due, ...weak, ...fresh.slice(0, newLimit)].slice(0, limit),
    ahead = false;
  // An explicit deck/topic selection means studying the whole selection.
  // Daily study alone uses the new-card and session limits.
  if (scope.length) {
    entries = [...due, ...weak, ...fresh];
    const selected = new Set(entries);
    entries.push(
      ...pool
        .filter((x) => !selected.has(x))
        .sort((a, b) => Number(b.focus) - Number(a.focus) || compareReading(a.card, b.card)),
    );
  }
  else if (!entries.length && aheadPool.length) {
    ahead = true;
    entries = [...aheadPool]
      .sort(
        (a, b) =>
          Number(b.focus) - Number(a.focus) ||
          WEIGHT[a.level] - WEIGHT[b.level] ||
          compareReading(a.card, b.card),
      )
      .slice(0, limit);
  }
  entries = orderByPrerequisites(entries, cardIndex(decks, outcome), !focusOnly).slice(
    0,
    Math.max(limit, entries.length) + 10,
  );
  /* What the round holds, counted over its own cards (so a breakdown always adds up to `size`), and how many pending cards wait
     behind it: `counts` is the whole pool, `round` the part this round takes. A round of "weakest cards" (nothing pending) has no breakdown. */
  const round = { due: 0, weak: 0, new: 0 };
  if (!ahead && !scope.length)
    for (const x of entries) round[x.level === "new" ? "new" : x.level === "weak" ? "weak" : "due"]++;
  const pending = due.length + weak.length + fresh.length;
  return {
    entries,
    ahead,
    counts: { due: due.length, weak: weak.length, new: fresh.length },
    round,
    more: scope.length ? 0 : Math.max(0, pending - (round.due + round.weak + round.new)),
    size: entries.length,
  };
}
