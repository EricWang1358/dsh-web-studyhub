import {
  latestOutcomes,
  deckProgress,
  nextTopic,
  planPath,
  cardLevel,
  cardRef,
} from "./mastery.js";
import { courseOf, currentCourse } from "./focus.js";
import { courseScope } from "./course-tree.js";
import { knownCourseNames } from "./source-courses.js";
import { learningScope, learningState } from './learning-scope.js';
import { cognitiveLevel } from './coach.js';

/* Read-only projections over the library: study map, dashboard statistics,
   wrong book and the knowledge-graph data. Nothing here mutates state. */

/** Card-weighted mastery: the current course first, the whole library as context. */
function masterySummary(s, rows) {
  const measure = (list) => {
    const total = list.reduce((n, r) => n + r.total, 0);
    return total ? { value: Math.round(list.reduce((n, r) => n + r.mastery * r.total, 0) / total), cards: total } : null;
  };
  const live = rows.filter((r) => !r.deck.archived);
  const name = s.focus?.mode === "interview" ? null : currentCourse(s);
  const within = name != null ? courseScope(name, knownCourseNames(s)) : null;
  const inCourse = within ? live.filter((r) => !r.deck.systemKind && within(courseOf(r.deck))) : [];
  return { course: inCourse.length ? { name, ...measure(inCourse) } : null, library: measure(live) };
}

export function studyMap(s, now = Date.now()) {
  const outcome = latestOutcomes(s.attempts),
    plan = planPath(s.decks, outcome, { now });
  const rows = s.decks.map((deck) => ({ deck, ...deckProgress(deck, outcome, now) }));
  return {
    today: { ...plan.counts, size: plan.size, ahead: plan.ahead },
    next: nextTopic(s.decks, outcome, now),
    mastery: masterySummary(s, rows),
    decks: rows.map(({ deck: d, ...progress }) => {
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

function assessmentOf(s) {
  const byRun = new Map();
  for (const run of s.runs) for (const entry of run.entries || [])
    byRun.set(JSON.stringify([run.id, entry.deckId ?? run.deckId, entry.card.id]),
      run.mode === "flashcard" || !["quiz", "multi", "cloze"].includes(entry.card.kind) ? "self" : "graded");
  const byCard = new Map(s.decks.flatMap((deck) => deck.cards.map((card) =>
    [cardRef(deck.id, card.id), ["quiz", "multi", "cloze"].includes(card.kind) ? "graded" : "self"])));
  return (attempt) => attempt.assessment ||
    byRun.get(JSON.stringify([attempt.runId, attempt.deckId, attempt.quiz_id])) ||
    byCard.get(cardRef(attempt.deckId, attempt.quiz_id));
}

const FORECAST_DAYS = 14, FORECAST_CARD_CAP = 300, MASTERY_WINDOW_DAYS = 30, MASTERY_MIN_ANSWERS = 3;
const KIND_ORDER = ["quiz", "multi", "cloze", "flashcard", "open", "case"];
const LEVEL_ORDER = ["recall", "concept", "apply"];

/** Cards due on each of the next 14 local days; overdue folds into today, so a bar is "what you would review that day". */
function dueForecast(s, now, outcome) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = [], index = new Map();
  for (let i = 0; i < FORECAST_DAYS; i++) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() + i);
    const date = dayKey(d);
    index.set(date, i);
    days.push({ date, count: 0, ...(i === 0 ? { overdue: 0 } : {}), cards: [] });
  }
  const scheduled = [];
  for (const deck of s.decks) {
    if (deck.archived) continue;
    for (const card of deck.cards) {
      if (card.suspended || !card.review?.due_at) continue;
      if (cardLevel(card, outcome(deck.id, card.id)) === "new") continue;
      const at = Date.parse(card.review.due_at);
      if (Number.isFinite(at)) scheduled.push({ at, deckId: deck.id, cardId: card.id });
    }
  }
  scheduled.sort((a, b) => a.at - b.at);
  let later = 0;
  for (const item of scheduled) {
    const overdue = item.at < +startOfToday;
    const i = overdue ? 0 : index.get(dayKey(new Date(item.at)));
    if (i === undefined) { later++; continue; }
    const bucket = days[i];
    bucket.count++;
    if (overdue) bucket.overdue++;
    if (bucket.cards.length < FORECAST_CARD_CAP) bucket.cards.push({ deckId: item.deckId, cardId: item.cardId });
    else bucket.truncated = true;
  }
  return { days, later };
}

/** Pass / self-met rate of the last 30 days per cognitive level and per question kind; thin groups report no rate. */
function masteryBreakdown(s, answers) {
  const cards = new Map(s.decks.flatMap((deck) => deck.cards.map((card) => [cardRef(deck.id, card.id), card])));
  const groups = (key, order, onlyAnswered) => {
    const rows = new Map(order.map((id) => [id, { id, n: 0, met: 0 }]));
    for (const a of answers) {
      const card = cards.get(cardRef(a.deckId, a.quiz_id));
      if (!card) continue;
      const row = rows.get(key(card));
      if (!row) continue;
      row.n++;
      if (a.grade >= 3) row.met++;
    }
    return order.map((id) => rows.get(id)).filter((r) => !onlyAnswered || r.n > 0).map((r) => {
      const enough = r.n >= MASTERY_MIN_ANSWERS;
      return { ...r, rate: enough ? Math.round((r.met / r.n) * 100) : null, enough };
    });
  };
  return {
    windowDays: MASTERY_WINDOW_DAYS,
    minAnswers: MASTERY_MIN_ANSWERS,
    levels: groups((card) => cognitiveLevel(card, s.learner?.levels?.[card.id]), LEVEL_ORDER, false),
    kinds: groups((card) => card.kind, KIND_ORDER, true),
  };
}

/** Dashboard aggregates derived from the attempt log; nothing extra stored. */
export function studyStats(s, args = {}, now = new Date()) {
  s = learningState(s, args);
  const primary = s.attempts.filter((a) => !a.retry);
  const assessment = assessmentOf(s);
  const days = new Map();
  for (const a of primary) {
    const k = dayKey(a.timestamp);
    const cur = days.get(k) || { count: 0, gradedCount: 0, gradedSum: 0, selfCount: 0, selfSum: 0, oralCount: 0 };
    cur.count++;
    const mode = assessment(a);
    if (mode === "graded" || mode === "self") {
      cur[`${mode}Count`]++;
      cur[`${mode}Sum`] += a.grade;
    }
    if (mode === 'oral') cur.oralCount++;
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
      avg: v.gradedCount ? Math.round((v.gradedSum / v.gradedCount) * 10) / 10 : null,
      count: v.gradedCount,
      gradedAvg: v.gradedCount ? Math.round((v.gradedSum / v.gradedCount) * 10) / 10 : null,
      gradedCount: v.gradedCount,
      selfAvg: v.selfCount ? Math.round((v.selfSum / v.selfCount) * 10) / 10 : null,
      selfCount: v.selfCount,
      oralCount: v.oralCount,
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
  const recentCutoff = +now - 30 * 24 * 60 * 60 * 1000;
  const recent = primary.filter((a) => Date.parse(a.timestamp) >= recentCutoff);
  const gradedRecent = recent.filter((a) => assessment(a) === "graded");
  const selfRecent = recent.filter((a) => assessment(a) === "self");
  const oralRecent = recent.filter((a) => assessment(a) === 'oral');
  const rate = (items) => items.length
    ? Math.round((items.filter((a) => a.grade >= 3).length / items.length) * 100) : null;
  const recentRate = rate(gradedRecent);
  const lastAttempt = new Map();
  for (const a of primary) {
    const key = JSON.stringify([a.deckId, a.quiz_id]);
    if (!lastAttempt.has(key) || a.timestamp >= lastAttempt.get(key).timestamp)
      lastAttempt.set(key, a);
  }
  const weakTopics = [];
  for (const deck of s.decks) {
    if (deck.archived) continue;
    const topics = new Map();
    for (const card of deck.cards) {
      if (card.suspended) continue;
      const last = lastAttempt.get(JSON.stringify([deck.id, card.id]));
      if (!last || cardLevel(card, last.grade) !== "weak") continue;
      const name = card.topic || "未分类";
      const row = topics.get(name) || { deckId: deck.id, deckTitle: deck.title, course: courseOf(deck, s), topic: name, wrong: 0, lastAt: "" };
      row.wrong++;
      if (last.timestamp > row.lastAt) row.lastAt = last.timestamp;
      topics.set(name, row);
    }
    weakTopics.push(...topics.values());
  }
  weakTopics.sort((x, y) => y.wrong - x.wrong || y.lastAt.localeCompare(x.lastAt));
  weakTopics.length = Math.min(weakTopics.length, 12);
  const attempts = primary.length,
    gradedPrimary = primary.filter((a) => assessment(a) === "graded");
  return {
    generatedAt: now.toISOString(),
    today: dayKey(now),
    totals: {
      attempts,
      activeDays: days.size,
      streak,
      correctRate: rate(gradedPrimary),
      recentRate,
      recentAttempts: gradedRecent.length,
      gradedRate: rate(gradedRecent),
      gradedAttempts: gradedRecent.length,
      selfRate: rate(selfRecent),
      selfAttempts: selfRecent.length,
      oralAttempts: oralRecent.length,
      oralStrong: oralRecent.filter(a => a.grade >= 4).length,
      cards,
      due,
      mastered,
      weak,
    },
    heatmap,
    trend,
    weakTopics,
    forecast: dueForecast(s, now, outcome),
    mastery: masteryBreakdown(s, recent.filter((a) => ["graded", "self"].includes(assessment(a)))),
  };
}

/** Latest low outcome per available card across every active deck. */
export function wrongBook(s, { offset = 0, limit = 100, ...selection } = {}) {
  s = learningState(s, selection);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Choose a non-negative offset and a page size from 1 to 100");
  const assessment = assessmentOf(s);
  const last = new Map();
  for (const a of s.attempts) {
    if (a.retry) continue;
    const k = cardRef(a.deckId, a.quiz_id),
      prev = last.get(k);
    if (!prev || a.timestamp > prev.timestamp) last.set(k, a);
  }
  const items = [];
  for (const d of s.decks) {
    if (d.archived) continue;
    for (const c of d.cards) {
      if (c.suspended) continue;
      const a = last.get(cardRef(d.id, c.id));
      if (!a || a.grade >= 3) continue;
      items.push({
        deckId: d.id,
        deckTitle: d.title,
        cardId: c.id,
        topic: c.topic,
        kind: c.kind,
        assessment: assessment(a),
        prompt: c.prompt,
        lastGrade: a.grade,
        lastAt: a.timestamp,
        suspended: !!c.suspended,
      });
    }
  }
  items.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  return {
    total: items.length,
    gradedTotal: items.filter((item) => item.assessment === "graded").length,
    selfTotal: items.filter((item) => item.assessment === "self").length,
    oralTotal: items.filter((item) => item.assessment === 'oral').length,
    rubricTotal: items.filter((item) => item.assessment === 'rubric').length,
    items: items.slice(offset, offset + limit),
  };
}

const CARD_NODE_CAP = 400;

/** Structure tree (deck › topic › card with prereq edges) or ordered path. */
export function graphData(s, a = {}) {
  const selection = learningScope(s, a);
  s = learningState(s, a);
  const mode = a.mode === "path" ? "path" : "structure",
    scope = selection.scope,
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
