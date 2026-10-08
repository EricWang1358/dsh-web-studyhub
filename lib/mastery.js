/** Mastery levels derived from SM-2 state and the latest attempt; no extra storage. */
export const LEVELS = ["new", "weak", "learning", "familiar", "mastered"];
const WEIGHT = { new: 0, weak: 0.15, learning: 0.45, familiar: 0.75, mastered: 1 };
const MASTERED = 80;
/** The weights and the "done" line of the dashboard, shared so a material's mastery (lib/material-mastery.js) is the same number. */
export const LEVEL_WEIGHT = WEIGHT;
export const DONE_MASTERY = MASTERED;
/** Only answers that applied to the current question contribute to its learning state. */
export const isMasteryAttempt = (attempt) => !attempt.retry && !attempt.updatedAfterOpening;

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
export function cardLevel(card, lastGrade) {
  if (lastGrade === undefined && !(card.review?.repetitions > 0)) return "new";
  if (lastGrade !== undefined && lastGrade < 3) return "weak";
  // 轻松掌握 (a self-graded 5) is the learner's own call: show it as mastered at
  // once. Only self-grading gives 5 (a correct choice or cloze answer is 4), and
  // the schedule still brings the card back on its interval.
  if (lastGrade === 5) return "mastered";
  const days = card.review?.interval_days || 0;
  return days >= 21 ? "mastered" : days >= 6 ? "familiar" : "learning";
}
export const isDue = (card, now) =>
  !!card.review?.due_at && Date.parse(card.review.due_at) <= now;

function summarize(items, now) {
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
/** The next topic in syllabus order that is not yet mastered. */
export function nextTopic(decks, outcome, now = Date.now()) {
  for (const deck of decks) {
    if (deck.archived) continue;
    for (const topic of deckProgress(deck, outcome, now).topics)
      if (topic.status !== "done")
        return {
          deckId: deck.id,
          deckTitle: deck.title,
          topic: topic.name,
          mastery: topic.mastery,
        };
  }
  return null;
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
 * Learning path for a scope (empty = every active deck): due reviews, then
 * weak cards, then new cards in syllabus order, with unlearned prerequisites
 * placed before the cards that need them. When nothing is pending the
 * weakest cards are offered so a session can always start.
 */
export function planPath(decks, outcome, options = {}) {
  const { scope = [], now = Date.now(), newLimit = 10, limit = 20 } = options;
  const wanted = (deck, card) =>
    !scope.length ||
    scope.some(
      (x) =>
        x.deckId === deck.id &&
        (x.cardId
          ? x.cardId === card.id
          : !x.topic || x.topic === (card.topic || "未分类")),
    );
  const pool = [];
  for (const deck of decks) {
    if (deck.archived) continue;
    const order = new Map();
    for (const card of deck.cards)
      if (!order.has(card.topic)) order.set(card.topic, order.size);
    deck.cards.forEach((card, index) => {
      if (card.suspended || !wanted(deck, card)) return;
      pool.push({
        deckId: deck.id,
        card,
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
  const due = pool
      .filter((x) => !["new", "weak"].includes(x.level) && isDue(x.card, now))
      .filter((x) => !covered.has(cardRef(x.deckId, x.card.id)))
      .sort(
        (a, b) =>
          Date.parse(a.card.review.due_at) - Date.parse(b.card.review.due_at),
      ),
    weak = pool.filter((x) => x.level === "weak"),
    fresh = pool.filter((x) => x.level === "new");
  let entries = [...due, ...weak, ...fresh.slice(0, newLimit)].slice(0, limit),
    ahead = false;
  // An explicit deck/topic selection means studying the whole selection.
  // Daily study alone uses the new-card and session limits.
  if (scope.length) {
    entries = [...due, ...weak, ...fresh];
    const selected = new Set(entries);
    entries.push(...pool.filter((x) => !selected.has(x)));
  }
  else if (!entries.length && pool.length) {
    ahead = true;
    entries = [...pool]
      .sort((a, b) => WEIGHT[a.level] - WEIGHT[b.level])
      .slice(0, limit);
  }
  entries = orderByPrerequisites(entries, cardIndex(decks, outcome)).slice(
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
