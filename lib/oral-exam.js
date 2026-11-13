import { randomUUID } from "node:crypto";
import { cardLevel, latestOutcomes } from "./mastery.js";
import { learningScope } from './learning-scope.js';
import { courseOf, currentCourse } from './focus.js';
import { courseIndex } from './courses.js';
import { cappedGrade, gradingCorrection } from './contexts/study/correction.js';

const visible = (deck) => !deck.archived && !deck.systemKind;
const topicOf = (card) => card.topic || "未分类";
const modelBands = new Set(["strong", "developing", "weak"]);

function inferCourseFromScope(state, args = {}) {
  const deckIds = new Set();
  if (typeof args.deckId === "string" && args.deckId) deckIds.add(args.deckId);
  if (Array.isArray(args.scope)) {
    for (const item of args.scope) {
      if (item && typeof item === "object" && typeof item.deckId === "string" && item.deckId) deckIds.add(item.deckId);
      else if (typeof item === "string" && item) {
        const owner = (state.decks || []).find((deck) => (deck.cards || []).some((card) => card.id === item));
        if (owner?.id) deckIds.add(owner.id);
      }
    }
  }
  const courses = new Set();
  let resolved = 0;
  for (const id of deckIds) {
    const deck = (state.decks || []).find((entry) => entry.id === id);
    if (!deck) continue;
    resolved++;
    courses.add(courseOf(deck, state) || "");
  }
  const only = courses.size === 1 ? [...courses][0] : "";
  return { resolved, courses, single: resolved > 0 && courses.size === 1, course: only || null };
}

function singleLibraryCourse(state) {
  const decks = (state.decks || []).filter(visible);
  if (!decks.length) return null;
  const courses = new Set(decks.map((deck) => courseOf(deck, state) || ""));
  if (courses.size !== 1) return null;
  const only = [...courses][0];
  return only || null;
}

/** Resolve the scoped course's interview role, jd, and target topics (#779).
    Uncategorised (`course: ""`) and multi-course (`course: "*"`) scopes never inherit `state.focus.course`. */
export function courseInterviewContext(state, args = {}) {
  const explicit = args.scope !== undefined || Boolean(args.deckId);
  const index = courseIndex(state);
  let courseName = null;
  let allowTargetTopics = false;
  if (typeof args.course === "string" && args.course !== "*") {
    if (args.course !== "") {
      courseName = args.course;
      allowTargetTopics = !explicit;
    }
  } else if (args.course === "*") {
    if (explicit) {
      if (Array.isArray(args.scope) && args.scope.length === 0) {
        courseName = singleLibraryCourse(state);
      } else {
        const inferred = inferCourseFromScope(state, args);
        courseName = inferred.single ? (inferred.course || null) : null;
      }
    } else {
      courseName = singleLibraryCourse(state);
    }
  } else if (explicit) {
    if (Array.isArray(args.scope) && args.scope.length === 0) {
      courseName = singleLibraryCourse(state);
    } else {
      const inferred = inferCourseFromScope(state, args);
      courseName = inferred.single ? (inferred.course || null) : null;
    }
  } else {
    courseName = currentCourse(state);
    allowTargetTopics = true;
  }
  const record = courseName ? index.resolve(courseName) : null;
  const role = (typeof args.role === 'string' && args.role.trim()) ? args.role.trim() : (record?.interview?.role || '');
  const jd = record?.interview?.jd || '';
  const targetTopics = allowTargetTopics && record?.interview ? [...(record.focusTopics || [])] : [];
  return { role, jd, targetTopics };
}

/** One question per topic before repeats; prior weak cards get a modest priority. */
export function selectOralQuestions(state, args = {}) {
  const { count = 5 } = args;
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("口头模拟请选择 1–10 题");
  const selection = learningScope(state, args);
  const targets = new Set(courseInterviewContext(state, args).targetTopics);

  const outcome = latestOutcomes(state.attempts);
  const pool = state.decks.filter(visible)
    .flatMap((deck) => deck.cards.filter((card) => !card.suspended && selection.matches(deck.id, card)).map((card) => ({
      deckId: deck.id, deckTitle: deck.title, card,
      level: cardLevel(card, outcome(deck.id, card.id)),
    })))
    .filter((entry) => !targets.size || targets.has(topicOf(entry.card)));
  if (!pool.length) throw new Error(targets.size
    ? "当前岗位知识点没有可用题目，请调整岗位范围" : "学习库里没有可用于口头模拟的题目");
  const rank = { weak: 0, new: 1, learning: 2, familiar: 3, mastered: 4 };
  const groups = new Map();
  for (const item of pool) {
    const topic = topicOf(item.card);
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(item);
  }
  const buckets = [...groups.values()].map((items) => items.sort((a, b) => rank[a.level] - rank[b.level]))
    .sort((a, b) => rank[a[0].level] - rank[b[0].level]);
  const selected = [];
  while (selected.length < count && buckets.some((items) => items.length)) {
    for (const items of buckets) {
      if (selected.length >= count) break;
      if (items.length) selected.push(items.shift());
    }
  }
  return selected;
}

export function createOralRun(state, args) {
  const selected = selectOralQuestions(state, args);
  const interview = courseInterviewContext(state, args);
  return {
    id: randomUUID(), startedAt: new Date().toISOString(), index: 0,
    role: interview.role,
    // The course's job description (#1031): the interviewer's follow-up and the assessment read it; the run view does not echo it.
    ...(interview.jd ? { jd: interview.jd } : {}),
    targetTopics: interview.targetTopics,
    scope: learningScope(state, args).scope,
    entries: selected.map(({ deckId, deckTitle, card }) => ({
      deckId, deckTitle, card: structuredClone(card), answer: "", followup: "", followupAnswer: "",
    })),
  };
}

export function oralView(run) {
  const submitted = !!run.submittedAt;
  const entry = !submitted ? run.entries[run.index] : null;
  return {
    id: run.id, role: run.role, scope: run.scope, startedAt: run.startedAt, index: run.index,
    total: run.entries.length, submitted, answered: run.entries.filter((item) => item.answer.trim()).length,
    entry: entry && {
      deckId: entry.deckId, cardId: entry.card.id, topic: topicOf(entry.card),
      prompt: entry.card.prompt, kind: entry.card.kind,
      options: (entry.card.options || []).map(({ id, text }) => ({ id, text })),
      answer: entry.answer, followup: entry.followup, followupAnswer: entry.followupAnswer,
    },
  };
}

const gradeOfBand = { strong: 4, developing: 3, weak: 1 };
const bandOfGrade = (grade) => (grade >= 4 ? "strong" : grade === 3 ? "developing" : "weak");
const ownGrade = (value) => (Number.isInteger(value) && value >= 0 && value <= 5 ? value : null);

/* One assessed answer: the grade the schedule uses (the grader's 0–5 grade, else its band's), the shared correction reader of practice grading
   (lib/contexts/study/correction.js) and its fragments rule, and a band that always follows the grade the learner gets. */
export function normalizedOralAssessment(raw, run) {
  const rows = Array.isArray(raw?.results) ? raw.results : [];
  const byId = new Map(rows.filter((row) => row && typeof row.cardId === "string" && (modelBands.has(row.band) || ownGrade(row.grade) !== null))
    .map((row) => [row.cardId, row]));
  return run.entries.map((entry) => {
    if (!entry.answer.trim()) return null;
    const row = byId.get(entry.card.id);
    if (!row) return null;
    const correction = gradingCorrection(row, entry.answer);
    const grade = cappedGrade(ownGrade(row.grade) ?? gradeOfBand[row.band], correction);
    return { band: bandOfGrade(grade), grade, reason: String(row.reason || "").slice(0, 400), ...(correction ? { correction } : {}) };
  });
}

export function oralReport(run) {
  if (!run.submittedAt) throw new Error("这场口头模拟尚未结束");
  const topicRows = new Map();
  let answered = 0, assessed = 0, strong = 0, developing = 0, weak = 0;
  const entries = run.entries.map((entry) => {
    const hasAnswer = !!entry.answer.trim();
    if (hasAnswer) answered++;
    if (entry.assessment) {
      assessed++;
      if (entry.assessment.band === "strong") strong++;
      if (entry.assessment.band === "developing") developing++;
      if (entry.assessment.band === "weak") weak++;
    }
    const topic = topicOf(entry.card);
    const row = topicRows.get(topic) || { topic, weak: 0, developing: 0, unanswered: 0, scope: [] };
    if (!hasAnswer) row.unanswered++;
    if (entry.assessment?.band === "weak") row.weak++;
    if (entry.assessment?.band === "developing") row.developing++;
    if (!hasAnswer || entry.assessment?.band === "weak" || entry.assessment?.band === "developing")
      row.scope.push({ deckId: entry.deckId, cardId: entry.card.id });
    topicRows.set(topic, row);
    return {
      deckId: entry.deckId, cardId: entry.card.id, topic, prompt: entry.card.prompt,
      answer: entry.answer, followup: entry.followup, followupAnswer: entry.followupAnswer,
      expected: entry.card.answer, assessment: entry.assessment || null,
    };
  });
  const weakTopics = [...topicRows.values()].filter((row) => row.weak || row.developing || row.unanswered)
    .sort((a, b) => (b.weak * 2 + b.developing + b.unanswered) - (a.weak * 2 + a.developing + a.unanswered))
    .slice(0, 3);
  return {
    runId: run.id, role: run.role, startedAt: run.startedAt, submittedAt: run.submittedAt,
    total: entries.length, answered, assessed, strong, developing, weak,
    feedbackStatus: assessed ? "assessed" : "unassessed",
    weakTopics, entries,
    weakScope: [...topicRows.values()].flatMap((row) => row.scope),
  };
}
