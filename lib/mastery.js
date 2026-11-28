/** Mastery levels derived from FSRS-6 state and the latest attempt; no extra storage. */
import { createReadingOrder, sortCardsByReadingOrder } from "./reading-order/card-reading-order.js";
import { isPassedToday, retrievabilityAt, spacedRepsOf } from "./sm2.js";
import { isCourseBookDocSource } from "./exam-point-list.js";
import { bookLinks, parseBookLink } from "./course-book-links.js";

/** Rank due cards: normally focus first then earliest due date; when an unscoped backlog exceeds the round limit (#881 Direction B), keep recall === 0 (unknown last_review) first to avoid starvation, then descending predicted recall so still-remembered cards are rescued before decaying further. */
function orderDuePool(rawDue, { scope, limit, now, settings }) {
  if (scope.length || rawDue.length <= limit) {
    return rawDue.sort(
      (a, b) =>
        Number(b.focus) - Number(a.focus) ||
        Date.parse(a.card.review.due_at) - Date.parse(b.card.review.due_at),
    );
  }
  const recallOf = retrievabilityAt(settings);
  return rawDue
    .map((x) => ({ x, recall: recallOf(x.card.review, now), dueAt: Date.parse(x.card.review.due_at) }))
    .sort(
      (a, b) =>
        Number(b.x.focus) - Number(a.x.focus) ||
        Number(b.recall === 0) - Number(a.recall === 0) ||
        b.recall - a.recall ||
        a.dueAt - b.dueAt,
    )
    .map((entry) => entry.x);
}

export const LEVELS = ["new", "weak", "learning", "familiar", "mastered"];
const WEIGHT = { new: 0, weak: 0.15, learning: 0.45, familiar: 0.75, mastered: 1 };
const MASTERED = 80;
/** The weights and the "done" line of the dashboard, shared so a material's mastery (lib/material-mastery.js) is the same number. */
export const LEVEL_WEIGHT = WEIGHT;
export const DONE_MASTERY = MASTERED;
/** Active (non-voided) learner attempt: soft-voided attempts (`review.undo`, #885) stay on disk for audit but never count as live progress. */
export const isActiveAttempt = (attempt) => Boolean(attempt && typeof attempt === "object" && !attempt.voidedAt);
/** Synthetic mistake records written by `ingest` (`imported: "mistake"`): keep in WrongBook & weak queue, exclude from pace/stats/recap (#1323-5). */
export const isImportedAttempt = (attempt) => Boolean(attempt && attempt.imported);
/** Only active answers that applied to the current question contribute to its learning state. */
export const isMasteryAttempt = (attempt) => isActiveAttempt(attempt) && !attempt.retry && !attempt.updatedAfterOpening;
/** Unverified hands-on task self-report (`写完了（自报）`, #778): enters FSRS-6 spaced scheduling, never counts as a verified pass. */
export const isUnverifiedSelfReport = (attempt) =>
  !!(attempt?.selfReported || attempt?.unverified || attempt?.assessment === "self-report");
/** Direct, verified attempts that update WrongBook (待巩固 / 已订正), wrongDetail, and openLeeches.
    Excludes retries, post-open edits, unverified self-reports (#778), and implicit prerequisite credits. */
export const isCountedWrongBookAttempt = (attempt) =>
  isMasteryAttempt(attempt) && !isUnverifiedSelfReport(attempt) && !attempt.implicit;

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
  const streak = spacedRepsOf(card.review);
  if (lastGrade === undefined && !(streak > 0) && !(card.review?.repetitions > 0)) return "new";
  if (lastGrade !== undefined && lastGrade < 3) return "weak";
  // 轻松掌握 (a self-graded 5) is the learner's own call: show it as mastered at
  // once. Only self-grading gives 5 (a correct choice or cloze answer is 4, or 3 when the hint was used), and
  // the schedule still brings the card back on its interval. (Unchanged since SM-2.)
  // Preserve mastered tier across same-day passing reviews (e.g. Easy(5) -> same-day Good(4)) via card.review.last_grade.
  if (lastGrade === 5 || (card.review?.last_grade === 5 && streak > 0)) return "mastered";
  const days = Number(card.review?.interval_days) || 0;
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
 * Learning path for a scope (empty = every active deck): due reviews, then
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
    settings,
    only, // 'due' | 'weak' | 'new': a round of that kind alone (本轮设置, #1010); the day's mix when absent
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
  let deckIdx = 0;
  for (const deck of decks) {
    if (deck.archived) continue;
    const currentDeckIdx = deckIdx++;
    const orderedCards = sortCardsByReadingOrder(deck.cards, sources);
    const order = new Map();
    for (const card of orderedCards)
      if (!order.has(card.topic)) order.set(card.topic, order.size);
    orderedCards.forEach((card, index) => {
      if (card.suspended || !wanted(deck, card)) return;
      pool.push({
        deckId: deck.id,
        deckIdx: currentDeckIdx,
        cardIdx: index,
        card,
        focus: !!focusFn(deck, card),
        level: cardLevel(card, outcome(deck.id, card.id)),
        passedToday: isPassedToday(card.review, now),
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
  const due = orderDuePool(
      pool
        .filter((x) => !["new", "weak"].includes(x.level) && isDue(x.card, now))
        .filter((x) => !covered.has(cardRef(x.deckId, x.card.id))),
      { scope, limit, now, settings },
    ),
    weak = pool
      .filter((x) => x.level === "weak")
      .sort((a, b) => Number(b.focus) - Number(a.focus) || compareReading(a.card, b.card)),
    rawFresh = pool.filter((x) => x.level === "new" && (!allowNew || allowNew(x.deckId, x.card))),
    // Chapter/deck order first, then within-deck reading order (aligned with freshCardsForDecks & courseBatch, #1296).
    compareChapterReading = (a, b) => a.deckIdx - b.deckIdx || a.cardIdx - b.cardIdx,
    fresh =
      newCardOrder === "focus"
        ? [...rawFresh].sort(
            (a, b) => Number(b.focus) - Number(a.focus) || compareChapterReading(a, b),
          )
        : newCardOrder === "shuffle" && typeof shuffle === "function"
          ? shuffle(rawFresh)
          : [...rawFresh].sort(compareChapterReading),
    aheadPool = allowNew ? pool.filter((x) => allowNew(x.deckId, x.card)) : pool;
  const kinds = { due, weak, new: fresh };
  let entries = only ? kinds[only].slice(0, limit) : [...due, ...weak, ...fresh.slice(0, newLimit)].slice(0, limit),
    ahead = false;
  // An explicit deck/topic selection means studying the whole selection.
  // Daily study alone uses the new-card and session limits.
  if (scope.length) {
    entries = only ? [...kinds[only]] : [...due, ...weak, ...fresh];
    const selected = new Set(entries);
    if (!only) entries.push(
      ...pool
        .filter((x) => !selected.has(x))
        .sort(
          (a, b) =>
            Number(a.passedToday) - Number(b.passedToday) ||
            Number(b.focus) - Number(a.focus) ||
            compareReading(a.card, b.card),
        ),
    );
  }
  else if (!only && !entries.length && aheadPool.length) {
    ahead = true;
    entries = [...aheadPool]
      .sort(
        (a, b) =>
          Number(a.passedToday) - Number(b.passedToday) ||
          Number(b.focus) - Number(a.focus) ||
          WEIGHT[a.level] - WEIGHT[b.level] ||
          compareReading(a.card, b.card),
      )
      .slice(0, limit);
  }
  // A round of one kind (本轮设置 only) holds that kind alone: unlearned prerequisites are not pulled in, or they would push its own questions out.
  entries = orderByPrerequisites(entries, cardIndex(decks, outcome), !focusOnly && !only).slice(
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

/** Rewrite every stored location paired with moved card IDs (pure, browser-safe). */
export function relocateReferences(state, moved, fromId, toId, wholeDeck = false, movedTopics = new Set()) {
  const workflowScope = (scope) => scope.flatMap((ref) => {
    if (ref.deckId !== fromId && ref.deckId !== toId) return [ref];
    const deck = (state.decks || []).find((d) => d.id === ref.deckId);
    if (!deck) throw new Error("题组不存在");
    return (deck.cards || [])
      .filter((card) => ref.cardId ? card.id === ref.cardId : !ref.topic || (card.topic || "未分类") === ref.topic)
      .map((card) => ({ deckId: ref.deckId, cardId: card.id }));
  });
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const cardId = value.cardId || value.quiz_id || value.card?.id;
    if (value.deckId === fromId && (moved.has(cardId) || (wholeDeck && !cardId) || (!cardId && movedTopics.has(value.topic))))
      value.deckId = toId;
    if (value.originDeckId === fromId && moved.has(value.originCardId)) value.originDeckId = toId;
    if (wholeDeck && value.slain?.deckId === fromId) value.slain.deckId = toId;
    for (const child of Object.values(value)) visit(child);
  };
  for (const session of state.workflowSessions || []) {
    const before = JSON.stringify(session.scope);
    session.scope = workflowScope(session.scope);
    visit(session.scope);
    if (JSON.stringify(session.scope) !== before) {
      session.version++;
      session.updatedAt = new Date().toISOString();
    }
  }
  for (const run of state.runs || []) if (run.workflowSessionId && run.scope)
    run.scope = workflowScope(run.scope);
  for (const field of ["decks", "drafts", "attempts", "runs", "oralRuns", "teaching", "coach", "feedback", "prepared", "inbox", "skeletons", "topicGroups", "notes"])
    visit(state[field]);
  if (state.ingest) visit(state.ingest);

  // Rewrite `studyhub://card/<fromId>/<cardId>` links inside 复习全书 documents (files & suggestions, #1323-9).
  const BOOK_CARD_LINK = /studyhub:\/\/card\/[^)\s]+/g;
  const rewriteCardLinks = (text) => {
    if (typeof text !== "string" || !text.includes("studyhub://card/")) return text;
    return text.replace(BOOK_CARD_LINK, (href) => {
      const link = parseBookLink(href);
      if (link && link.kind === "card" && link.deckId === fromId && moved.has(link.cardId)) {
        return bookLinks.card(toId, link.cardId);
      }
      return href;
    });
  };
  for (const source of state.sources || []) {
    if (!isCourseBookDocSource(source) || !source.bookDoc?.files) continue;
    let docChanged = false;
    for (const file of Object.values(source.bookDoc.files)) {
      if (!file || typeof file !== "object") continue;
      let fileChanged = false;
      for (const key of ["text", "generated"]) {
        const next = rewriteCardLinks(file[key]);
        if (next !== file[key]) { file[key] = next; fileChanged = true; }
      }
      if (Array.isArray(file.suggestions)) {
        for (const sug of file.suggestions) {
          if (!sug || typeof sug.text !== "string") continue;
          const next = rewriteCardLinks(sug.text);
          if (next !== sug.text) { sug.text = next; fileChanged = true; }
        }
      }
      if (fileChanged) {
        if (Number.isInteger(file.version)) file.version += 1;
        docChanged = true;
      }
    }
    if (docChanged) {
      source.bookDoc.revision = (source.bookDoc.revision || 0) + 1;
      source.bookDoc.updatedAt = new Date().toISOString();
    }
  }

  // Relocate StudySession scopes & focus references (#1323-9).
  for (const session of state.studySessions || []) {
    if (!session || typeof session !== "object") continue;
    let changed = false;
    if (Array.isArray(session.scope)) {
      const nextScope = [];
      let hasToDeck = session.scope.some((item) => item?.kind === "deck" && item.id === toId);
      for (const item of session.scope) {
        if (!item || typeof item !== "object") { nextScope.push(item); continue; }
        if (item.kind === "card" && item.deckId === fromId && moved.has(item.cardId)) {
          nextScope.push({ ...item, deckId: toId });
          changed = true;
        } else if (item.kind === "deck" && item.id === fromId) {
          if (wholeDeck) {
            if (!hasToDeck) { nextScope.push({ ...item, id: toId }); hasToDeck = true; }
            changed = true;
          } else {
            nextScope.push(item);
            if (!hasToDeck) { nextScope.push({ kind: "deck", id: toId }); hasToDeck = true; changed = true; }
          }
        } else {
          nextScope.push(item);
        }
      }
      if (changed) session.scope = nextScope;
    }
    if (session.focus && typeof session.focus === "object" && session.focus.deckId === fromId) {
      if ((session.focus.cardId && moved.has(session.focus.cardId)) || (wholeDeck && !session.focus.cardId)) {
        session.focus = { ...session.focus, deckId: toId };
        changed = true;
      }
    }
    if (changed) {
      session.version = (session.version || 1) + 1;
      session.updatedAt = Date.now();
    }
  }
  for (const run of state.runs || []) {
    if (run.workflowSessionId) {
      const deckIds = new Set(run.entries.map((entry) => entry.deckId ?? run.deckId));
      run.deckId = deckIds.size === 1 ? [...deckIds][0] : null;
      continue;
    }
    if (!run.closedAt && run.entries?.some((e) => moved.has(e.card?.id))) run.closedAt = new Date().toISOString();
    if (run.scope) run.key = scopeKey(run.mode, run.scope);
  }
}

/** Transfer per-card editorial review marks from `from` deck to `to` deck. */
export function transferMarks(from, to, cards) {
  const marks = from.editorial?.reviewedCards;
  if (!marks) return;
  to.editorial ||= {};
  to.editorial.reviewedCards ||= {};
  for (const card of cards) if (marks[card.id]) {
    to.editorial.reviewedCards[card.id] = marks[card.id];
    delete marks[card.id];
  }
}
