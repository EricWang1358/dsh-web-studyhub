/* Rubric grading (WP12): one shared way to mark an open answer criterion by
   criterion, used by background help (assist mode `grade`, the learner's
   提交批改 in review and exams) and by the runtime action `card.grade`
   (agents, imported cases). The model call is retried on transient failures
   and asked again once when its reply is unusable; normalizeGrading decides
   what is trusted; commitRubricGrade stores the result like every other
   answer: an attempt (`assessment: 'rubric'`) that schedules SM-2, the run
   entry's feedback, and an inbox letter that opens at the card. */
import { parseJson } from "./generation.js";
import { createHash } from "node:crypto";
import { withModelRetry } from "./model-retry.js";
import { findCard } from "./prereq.js";
import { initialReview, schedule } from "./domain.js";
import { notify } from "./inbox.js";
import { get, id } from "./util.js";
import { substance } from "./card-content.js";
import {
  caseGradingPrompt, normalizeGrading, gradingShapeOk, isBlank, isCaseDeck, scenarioParagraphs, boundedGuidance,
  smGradeFor, compactRubric, CASE_LIMITS,
} from "./case-study.js";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
export const rubricDigest = card => createHash("sha256").update(JSON.stringify([
  substance(card), card.marks, card.rubric, card.rubricCriteria,
])).digest("hex");

/** One JSON call: transient failures retried, an unusable reply asked again once. */
export async function askJson(complete, system, prompt, { valid = object, retryDelays, label = "model" } = {}) {
  const call = (text) => withModelRetry(() => complete(system, text), retryDelays ? { delays: retryDelays } : undefined);
  const read = (reply) => { try { const value = parseJson(String(reply ?? "")); return valid(value) ? value : null; } catch { return null; } };
  const first = read(await call(prompt));
  if (first) return first;
  const second = read(await call(`${prompt}\n\nYour previous reply was not usable JSON in the requested shape. Return only the JSON value, nothing else.`));
  if (second) return second;
  throw Object.assign(new Error(`The ${label} reply could not be read as JSON; please retry`), { code: "CASE_REPLY_UNREADABLE" });
}

/**
 * Grade the answers of one paper (one or more questions).
 * @param paper { title, paragraphs, cues, questions: [{ cardId, prompt, marks, answer, criteria }] }
 */
export async function gradeCase(complete, { paper, answers = {}, scenario = "", guidance = "", language } = {}, options = {}) {
  const { system, prompt } = caseGradingPrompt({ title: paper.title, paragraphs: paper.paragraphs, cues: paper.cues,
    questions: paper.questions, answers, guidance, language });
  const answered = paper.questions.some((question) => !isBlank(answers[question.cardId]));
  const raw = answered ? await askJson(complete, system, prompt, { ...options, label: "grading", valid: gradingShapeOk }) : { questions: [] };
  return normalizeGrading(raw, { questions: paper.questions, answers, scenario });
}

/** Everything a grader needs for one rubric card: its case (or its cited sources), the rubric and the guidance. */
export function rubricInput(state, ref, { guidanceSourceIds = [], runId, answer, entryIndex } = {}) {
  const { deck, card: live } = findCard(state, ref);
  const { run, entry } = gradingEntry(state, deck.id, live.id, { runId, answer, entryIndex });
  const card = entry?.card ?? live;
  if (card.kind !== "open" || !Array.isArray(card.rubricCriteria) || !card.rubricCriteria.length)
    throw Object.assign(new Error("这道题没有评分标准，不能按评分标准批改"), { code: "RUBRIC_MISSING" });
  const scenarioSource = isCaseDeck(deck) ? state.sources.find((source) => source.id === deck.case.sourceId) : null;
  const cited = new Set((card.citations || []).map((ref) => ref.sourceId));
  const scenario = scenarioSource ? scenarioSource.text
    : state.sources.filter((source) => cited.has(source.id)).map((source) => source.text).join("\n\n").slice(0, 20000);
  return { deck, card, digest: rubricDigest(card), entryIndex: run ? run.entries.indexOf(entry) : undefined, scenario, language: deck.case?.language,
    guidance: boundedGuidance(state.sources.filter((source) => guidanceSourceIds.includes(source.id))),
    paper: { title: deck.case?.title || deck.title, paragraphs: scenarioParagraphs(scenario), cues: deck.case?.cues || [],
      questions: [{ cardId: card.id, prompt: card.prompt, marks: card.marks, answer: card.answer, criteria: card.rubricCriteria }] } };
}

export function checkedAnswer(answer) {
  if (typeof answer !== "string" || answer.length > CASE_LIMITS.answerChars)
    throw Object.assign(new Error(`答案请控制在 ${CASE_LIMITS.answerChars} 字以内`), { code: "RUBRIC_ANSWER" });
  if (isBlank(answer)) throw Object.assign(new Error("请先写下你的回答，再提交批改"), { code: "RUBRIC_ANSWER" });
  return answer;
}

/** The run entry an answer belongs to: the open entry of this card, a review's current one first. */
function entryOf(run, deckId, cardId) {
  const matches = (entry) => entry.card.id === cardId && (entry.deckId ?? run.deckId) === deckId;
  const current = run.entries[run.index];
  if (current && matches(current)) return current;
  return run.entries.find((entry) => matches(entry) && !entry.feedback?.rubric && !entry.retry)
    || run.entries.findLast((entry) => matches(entry) && !entry.retry) || null;
}

function gradingEntry(state, deckId, cardId, { runId, answer, entryIndex }) {
  const run = runId !== undefined ? get(state.runs, runId, "Review") : null;
  const entry = run ? (entryIndex === undefined ? entryOf(run, deckId, cardId) : run.entries[entryIndex]) : null;
  if (run && (!entry || entry.card.id !== cardId || (entry.deckId ?? run.deckId) !== deckId))
    throw new Error("This question does not belong to the specified review");
  if (run?.mode === "exam") {
    if (!run.submittedAt) throw new Error("Submit the exam before grading its answers");
    if (entry.response !== answer) throw new Error("The grading answer must match the submitted answer");
  }
  return { run, entry };
}

/**
 * Store a graded answer inside one store transaction.
 * @param grading normalizeGrading output that contains this card
 */
export function commitRubricGrade(state, { ref, runId, answer, grading, expectedDigest, entryIndex, timestamp = new Date().toISOString() }) {
  const { deck, card } = findCard(state, ref);
  const result = grading.questions.find((question) => question.cardId === card.id);
  if (!result) throw Object.assign(new Error("批改结果与这道题不符"), { code: "RUBRIC_MISMATCH" });
  const { run, entry } = gradingEntry(state, deck.id, card.id, { runId, answer, entryIndex });
  if (entry?.feedback?.rubric) {
    if ((entry.response ?? entry.feedback.answer) !== answer)
      throw new Error("Question already graded with different response; start a new attempt");
    const { grade, rubric } = entry.feedback;
    return { deckId: deck.id, cardId: card.id, runId: run.id, grade, total: rubric.total, max: rubric.max, rubric,
      ...(entry.feedback.updatedAfterOpening ? { updatedAfterOpening: true } : {}),
      message: `批改完成：${rubric.total}/${rubric.max} 分` };
  }
  const basis = entry?.card ?? card;
  const basisDigest = expectedDigest !== undefined || entry ? rubricDigest(basis) : undefined;
  if (expectedDigest !== undefined && basisDigest !== expectedDigest)
    throw new Error("题目已更新，旧批改结果未保存；请针对新版重新提交");
  const staleSnapshot = !!entry && basisDigest !== rubricDigest(card);
  const grade = smGradeFor(result.total, result.max);
  const before = card.review ?? initialReview(state.settings);
  // A tail retry is practice after feedback, not a second spaced-repetition interval.
  const after = entry?.retry || staleSnapshot ? before : schedule(before, grade, timestamp, state.settings);
  if (!entry?.retry && !staleSnapshot) card.review = after;
  const rubric = { total: result.total, max: result.max, ratio: result.ratio, band: result.band, unanswered: result.unanswered,
    criteria: result.criteria, unanchored: result.unanchored, assumptions: result.assumptions, summary: result.summary || grading.summary || "" };
  if (entry) {
    entry.revealed = true;
    entry.response = answer;
    entry.signature = "rubric";
    entry.feedback = { correct: grade >= 3, grade, rubric, answer, nextDue: after.due_at, gradedAt: timestamp,
      ...(staleSnapshot ? { updatedAfterOpening: true } : {}) };
  }
  state.attempts.push({ id: id(), runId: run?.id || null, quiz_id: card.id, deckId: deck.id, topic: card.topic, timestamp, grade,
    assessment: "rubric", learnerAnswer: answer, score: result.total, maxScore: result.max, rubric: compactRubric(result),
    elapsed_ms: entry ? Math.max(0, Date.now() - (entry.startedAt || Date.now())) : 0, retry: !!entry?.retry, before, after,
    ...(staleSnapshot ? { updatedAfterOpening: true } : {}) });
  notify(state, { kind: "grade", deckId: deck.id, cardId: card.id, detail: `${result.total}/${result.max}` });
  return { deckId: deck.id, cardId: card.id, runId: run?.id || null, grade, total: result.total, max: result.max, rubric,
    ...(staleSnapshot ? { updatedAfterOpening: true } : {}),
    message: `批改完成：${result.total}/${result.max} 分` };
}
