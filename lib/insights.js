import {
  latestOutcomes,
  deckProgress,
  nextTopic,
  planPath,
  cardLevel,
  cardRef,
} from "./mastery.js";
import { checkScope } from "./prereq.js";

/* Read-only projections over the library: study map, dashboard statistics,
   wrong book and the knowledge-graph data. Nothing here mutates state. */

export function studyMap(s, now = Date.now()) {
  const outcome = latestOutcomes(s.attempts),
    plan = planPath(s.decks, outcome, { now });
  return {
    today: { ...plan.counts, size: plan.size, ahead: plan.ahead },
    next: nextTopic(s.decks, outcome, now),
    decks: s.decks.map((d) => {
      const progress = deckProgress(d, outcome, now);
      return {
        id: d.id,
        title: d.title,
        folder: d.folder || "",
        archived: !!d.archived,
        total: progress.total,
        mastery: progress.mastery,
        counts: progress.counts,
        due: progress.due,
        status: progress.status,
        topics: progress.topics,
      };
    }),
  };
}

const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Dashboard aggregates derived from the attempt log; nothing extra stored. */
export function studyStats(s) {
  const now = new Date();
  const days = new Map();
  for (const a of s.attempts) {
    const k = dayKey(a.timestamp);
    const cur = days.get(k) || { count: 0, sum: 0 };
    cur.count++;
    cur.sum += a.grade;
    days.set(k, cur);
  }
  const heatmap = [];
  for (let i = 181; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    heatmap.push({ date: k, count: days.get(k)?.count || 0 });
  }
  const trend = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({
      date,
      avg: Math.round((v.sum / v.count) * 10) / 10,
      count: v.count,
    }));
  // Consecutive studied days ending today (today may not have started yet).
  let streak = 0;
  for (let i = 0; i <= 3650; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (!days.has(dayKey(d))) {
      if (i === 0) continue;
      break;
    }
    streak++;
  }
  const outcome = latestOutcomes(s.attempts);
  let cards = 0,
    mastered = 0,
    weak = 0,
    due = 0;
  for (const d of s.decks) {
    if (d.archived) continue;
    for (const c of d.cards) {
      if (c.suspended) continue;
      cards++;
      const level = cardLevel(c, outcome(d.id, c.id));
      if (level === "mastered") mastered++;
      if (level === "weak") weak++;
      if (level !== "new" && c.review?.due_at && Date.parse(c.review.due_at) <= +now)
        due++;
    }
  }
  const topics = new Map();
  for (const a of s.attempts) {
    const key = JSON.stringify([a.deckId, a.topic]);
    const t =
      topics.get(key) ||
      {
        deckId: a.deckId,
        deckTitle: s.decks.find((d) => d.id === a.deckId)?.title || "",
        topic: a.topic,
        attempts: 0,
        wrong: 0,
        lastAt: a.timestamp,
      };
    t.attempts++;
    if (a.grade < 3) t.wrong++;
    if (a.timestamp > t.lastAt) t.lastAt = a.timestamp;
    topics.set(key, t);
  }
  const weakTopics = [...topics.values()]
    .filter((t) => t.wrong > 0)
    .sort((x, y) => y.wrong - x.wrong || (x.lastAt < y.lastAt ? 1 : -1))
    .slice(0, 12);
  const attempts = s.attempts.length,
    passed = s.attempts.filter((a) => a.grade >= 3).length;
  return {
    generatedAt: now.toISOString(),
    totals: {
      attempts,
      activeDays: days.size,
      streak,
      correctRate: attempts ? Math.round((passed / attempts) * 100) : 0,
      cards,
      due,
      mastered,
      weak,
    },
    heatmap,
    trend,
    weakTopics,
  };
}

/** Latest wrong answer per card across every active deck. */
export function wrongBook(s) {
  const last = new Map();
  for (const a of s.attempts) {
    const k = cardRef(a.deckId, a.quiz_id),
      prev = last.get(k);
    if (!prev || a.timestamp > prev.timestamp) last.set(k, a);
  }
  const items = [];
  for (const d of s.decks) {
    if (d.archived) continue;
    for (const c of d.cards) {
      const a = last.get(cardRef(d.id, c.id));
      if (!a || a.grade >= 3) continue;
      items.push({
        deckId: d.id,
        deckTitle: d.title,
        cardId: c.id,
        topic: c.topic,
        kind: c.kind,
        prompt: c.prompt,
        lastGrade: a.grade,
        lastAt: a.timestamp,
        suspended: !!c.suspended,
      });
    }
  }
  items.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  return { items: items.slice(0, 100) };
}

const CARD_NODE_CAP = 400;

/** Structure tree (deck › topic › card with prereq edges) or ordered path. */
export function graphData(s, a = {}) {
  const mode = a.mode === "path" ? "path" : "structure",
    scope = checkScope(s, a.scope),
    outcome = latestOutcomes(s.attempts),
    wanted = (deck, card) =>
      !scope.length ||
      scope.some(
        (x) =>
          x.deckId === deck.id &&
          (x.cardId
            ? x.cardId === card.id
            : !x.topic || x.topic === (card.topic || "未分类")),
      );
  const nodes = [],
    edges = [],
    cardNodes = new Map();
  const cardNode = (deck, card) => {
    const node = {
      id: "card:" + JSON.stringify([deck.id, card.id]),
      kind: "card",
      label: String(card.objective || card.prompt || "").slice(0, 48),
      deckId: deck.id,
      deckTitle: deck.title,
      topic: card.topic || "未分类",
      cardId: card.id,
      level: cardLevel(card, outcome(deck.id, card.id)),
      cardKind: card.kind,
    };
    cardNodes.set(cardRef(deck.id, card.id), node);
    return node;
  };
  const prereqEdges = () => {
    for (const d of s.decks) {
      if (d.archived) continue;
      for (const c of d.cards) {
        const from = cardNodes.get(cardRef(d.id, c.id));
        if (!from) continue;
        for (const r of c.requires || []) {
          const to = cardNodes.get(cardRef(r.deckId, r.cardId));
          if (to) edges.push({ from: from.id, to: to.id, type: "prereq" });
        }
      }
    }
  };
  let truncated = false;
  if (mode === "path") {
    const entries = planPath(s.decks, outcome, { scope }).entries;
    for (const { deckId, card } of entries) {
      const deck = s.decks.find((d) => d.id === deckId);
      if (deck) nodes.push(cardNode(deck, card));
    }
    nodes.forEach((n, i) => {
      if (i + 1 < nodes.length)
        edges.push({ from: n.id, to: nodes[i + 1].id, type: "order", seq: i });
    });
    prereqEdges();
  } else {
    const decks = s.decks.filter(
      (d) =>
        !d.archived && (!scope.length || scope.some((x) => x.deckId === d.id)),
    );
    outer: for (const deck of decks) {
      const progress = deckProgress(deck, outcome);
      const deckNode = {
        id: "deck:" + deck.id,
        kind: "deck",
        label: deck.title,
        deckId: deck.id,
        mastery: progress.mastery,
        due: progress.due,
        total: progress.total,
      };
      nodes.push(deckNode);
      for (const [ti, topic] of progress.topics.entries()) {
        if (
          scope.length &&
          !scope.some(
            (x) => x.deckId === deck.id && (!x.topic || x.topic === topic.name),
          )
        )
          continue;
        const topicId = "topic:" + JSON.stringify([deck.id, topic.name]);
        nodes.push({
          id: topicId,
          kind: "topic",
          label: topic.name,
          deckId: deck.id,
          topic: topic.name,
          mastery: topic.mastery,
          due: topic.due,
          total: topic.total,
        });
        edges.push({ from: deckNode.id, to: topicId, type: "tree", seq: ti });
        for (const card of deck.cards) {
          if (card.suspended) continue;
          if ((card.topic || "未分类") !== topic.name || !wanted(deck, card))
            continue;
          if (cardNodes.size >= CARD_NODE_CAP) {
            truncated = true;
            break outer;
          }
          const node = cardNode(deck, card);
          nodes.push(node);
          edges.push({ from: topicId, to: node.id, type: "tree" });
        }
      }
    }
    prereqEdges();
  }
  return {
    mode,
    scope,
    nodes,
    edges,
    ...(truncated ? { truncated: true } : {}),
  };
}
