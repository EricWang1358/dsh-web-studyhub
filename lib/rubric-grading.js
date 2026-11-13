/* Rubric grading (WP12 + #778): one shared way to mark an open or hands-on task
   answer criterion by criterion, used by background help (assist mode `grade`,
   the learner's 提交批改 in review and exams) and by the runtime action
   `card.grade` (main-chat static evaluation write-backs, agents, imported
   cases). The model call is retried on transient failures and asked again once
   when its reply is unusable; normalizeGrading / normalizeTaskStaticCheck
   decides what is trusted; commitRubricGrade stores the result like every other
   answer: an attempt (`assessment: 'rubric'`) that schedules FSRS-6, the run
   entry's feedback, and an inbox letter that opens at the card. */
import { parseJson } from "./generation.js";
import { createHash } from "node:crypto";
import { withModelRetry } from "./model-retry.js";
import { findCard } from "./prereq.js";
import { initialReview, schedule } from "./domain.js";
import { cardScheduleSettings } from "./card-schedule.js";
import { notify } from "./inbox.js";
import { get, id } from "./util.js";
import { substance } from "./card-content.js";
import { assistanceEvidence } from "./study-progress.js";
import { applyExposureToAssistance } from "./solution-exposure.js";
import { cardLevel } from "./mastery.js";
import { creditPrerequisites } from "./study-state.js";
import { releaseGrading } from "./contexts/study/grading-marker.js";
import { cappedGrade } from "./contexts/study/correction.js";
import {
  caseGradingPrompt, normalizeGrading, gradingShapeOk, isBlank, isCaseDeck, scenarioParagraphs, boundedGuidance,
  smGradeFor, compactRubric, CASE_LIMITS, criteriaForTaskCard, normalizeTaskStaticCheck, taskStaticGradingPrompt, taskCheckShapeOk, isEnglish, criteriaMarks,
} from "./case-study.js";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
export const rubricDigest = card => createHash("sha256").update(JSON.stringify([
  substance(card), card.marks, card.rubric, card.rubricCriteria,
])).digest("hex");

export const normalizeRunId = (runId) => (typeof runId === "string" && runId.trim() ? runId.trim() : undefined);

function gradeDoneMessage(total, max, isTask, language) {
  if (isEnglish(language)) return isTask ? `Static check complete: ${total}/${max} marks` : `Grading complete: ${total}/${max} marks`;
  return isTask ? `静态验收完成：${total}/${max} 分` : `批改完成：${total}/${max} 分`;
}

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

/** Statically evaluate a hands-on task submission via model without running tests. */
export async function gradeTaskStatic(complete, { card, title = "", answer = "", files = [], language = "zh" } = {}, options = {}) {
  const { system, prompt } = taskStaticGradingPrompt({ card, title, answer, files, language });
  const raw = await askJson(complete, system, prompt, { ...options, label: "static-check", valid: taskCheckShapeOk });
  return normalizeTaskStaticCheck(raw, card, { language });
}

/** Everything a grader needs for one rubric or hands-on task card: its case (or its cited sources), the rubric and the guidance. */
export function rubricInput(state, ref, { guidanceSourceIds = [], runId, answer, entryIndex, allowDerive = false, aiGradeFlashcards = false } = {}) {
  const { deck, card: live } = findCard(state, ref);
  const { run, entry } = gradingEntry(state, deck.id, live.id, { runId, answer, entryIndex });
  const card = entry?.card ?? live;
  const written = card.kind === "task" ? criteriaForTaskCard(card, deck.case?.language) : card.kind === "open" ? card.rubricCriteria : null;
  // A plain open question (or a flashcard of a course that asked for AI grading) has no criteria of its own: its first AI grade (background help,
  // `allowDerive`) derives them from the reference answer and keeps them on the card (autoRubric), so every later attempt is marked against the same ones.
  const plainKind = !written?.length && (card.kind === "open" || (card.kind === "flashcard" && aiGradeFlashcards));
  const criteria = written?.length ? written : plainKind ? autoRubricOf(live, card) : null;
  const derive = allowDerive && plainKind && !criteria?.length;
  if ((!Array.isArray(criteria) || !criteria.length) && !derive)
    throw Object.assign(new Error("这道题没有评分标准，不能按评分标准批改"), { code: "RUBRIC_MISSING" });
  const scenarioSource = isCaseDeck(deck) ? state.sources.find((source) => source.id === deck.case.sourceId) : null;
  const cited = new Set((card.citations || []).map((ref) => ref.sourceId));
  const scenario = scenarioSource ? scenarioSource.text
    : state.sources.filter((source) => cited.has(source.id)).map((source) => source.text).join("\n\n").slice(0, 20000);
  return { deck, card, digest: rubricDigest(card), entryIndex: run ? run.entries.indexOf(entry) : undefined, scenario, language: deck.case?.language,
    ...(derive ? { derive: true } : {}),
    guidance: boundedGuidance(state.sources.filter((source) => guidanceSourceIds.includes(source.id))),
    paper: { title: deck.case?.title || deck.title, paragraphs: scenarioParagraphs(scenario), cues: deck.case?.cues || [],
      questions: [{ cardId: card.id, prompt: card.prompt, marks: card.marks || criteriaMarks(criteria || []), answer: card.answer, criteria: criteria || [] }] } };
}

/* ---------- criteria derived by the first AI grade (#1031) ---------- */

/** What derived criteria were made from: the card's content. When it is edited, they are derived again. */
const autoRubricBasis = (card) => createHash("sha256").update(JSON.stringify(substance(card))).digest("hex");

/** The criteria a card's first AI grade derived, when they still belong to this content (`basis`: the snapshot being graded). */
export function autoRubricOf(live, basis = live) {
  const stored = live?.autoRubric;
  return stored && stored.basis === autoRubricBasis(basis) && Array.isArray(stored.criteria) && stored.criteria.length ? stored.criteria : null;
}

const plain = (value, max) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : "");
/** The 2–4 criteria a grader derived from the reference answer, strictly read; null when the reply did not give usable ones. */
export function derivedCriteria(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return null;
  const criteria = raw.map((item, index) => {
    const label = plain(item?.label, 80), marks = Number(item?.marks);
    if (!label || !Number.isFinite(marks) || marks < 1 || marks > 10) return null;
    const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints.map((point) => plain(point, 200)).filter(Boolean).slice(0, 6) : [];
    return { id: `c${index + 1}`, label, marks: Math.round(marks * 2) / 2, keyPoints };
  });
  return criteria.every(Boolean) ? criteria : null;
}

/** Keep derived criteria on the live card, once: a card that already has them for this content keeps its own. Returns the criteria in force. */
export function keepAutoRubric(live, basis, criteria, timestamp = new Date().toISOString()) {
  const kept = autoRubricOf(live, basis);
  if (kept) return kept;
  live.autoRubric = { criteria: structuredClone(criteria), basis: autoRubricBasis(basis), at: timestamp };
  return criteria;
}

export function checkedAnswer(answer) {
  if (typeof answer !== "string" || answer.length > CASE_LIMITS.answerChars)
    throw Object.assign(new Error(`答案请控制在 ${CASE_LIMITS.answerChars} 字以内`), { code: "RUBRIC_ANSWER" });
  if (isBlank(answer)) throw Object.assign(new Error("请先写下你的回答，再提交批改"), { code: "RUBRIC_ANSWER" });
  return answer;
}

/** The run entry an answer belongs to: the open entry of this card, a review's current one first. */
export function entryOf(run, deckId, cardId) {
  const matches = (entry) => entry.card.id === cardId && (entry.deckId ?? run.deckId) === deckId;
  const current = run.entries[run.index];
  if (current && matches(current)) return current;
  return run.entries.find((entry) => matches(entry) && !entry.feedback?.rubric && !entry.retry)
    || run.entries.findLast((entry) => matches(entry) && !entry.retry) || null;
}

function gradingEntry(state, deckId, cardId, { runId, answer, entryIndex }) {
  const resolvedRunId = normalizeRunId(runId);
  const run = resolvedRunId !== undefined ? get(state.runs, resolvedRunId, "Review") : null;
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
 * Prerequisite credit of one graded entry, the one rule for a commit and for a changed grade (review.grade.adjust): an eligible pass credits the
 * questions it builds on once; an entry that credited and is no longer eligible takes that credit back (the implicit attempts it wrote are removed, and
 * a prerequisite's review goes back when nothing has moved it since). Returns how many were credited now.
 */
export function settlePrerequisiteCredit(state, { run, entry, deckId, cardId, eligible, timestamp }) {
  if (entry?.prerequisitesCredited && !eligible) {
    const at = entry.creditedAt ?? entry.feedback?.gradedAt;
    const gone = state.attempts.filter((item) => item.implicit && item.runId === (run?.id || null) && item.timestamp === at
      && item.via?.deckId === deckId && item.via?.cardId === cardId);
    for (const item of gone) {
      try {
        const { card } = findCard(state, { deckId: item.deckId, cardId: item.quiz_id });
        if (JSON.stringify(card.review) === JSON.stringify(item.after)) card.review = item.before;
      } catch { /* the prerequisite was removed */ }
    }
    state.attempts = state.attempts.filter((item) => !gone.includes(item));
    delete entry.prerequisitesCredited;
    delete entry.creditedAt;
  }
  const credited = eligible && !entry?.prerequisitesCredited ? creditPrerequisites(state, { deckId, cardId }, run?.id || null, timestamp) : 0;
  if (entry && credited > 0) Object.assign(entry, { prerequisitesCredited: true, creditedAt: timestamp });
  if (entry?.feedback) entry.feedback.credited = credited || (entry.prerequisitesCredited ? entry.feedback.credited || 0 : 0);
  return credited;
}

/**
 * Store a graded answer inside one store transaction.
 * @param grading normalizeGrading / normalizeTaskStaticCheck output that contains this card
 */
export function commitRubricGrade(state, { ref, runId, answer, grading, expectedDigest, entryIndex, language, correction = null, timestamp = new Date().toISOString() }) {
  const { deck, card } = findCard(state, ref);
  const result = grading.questions.find((question) => question.cardId === card.id);
  if (!result) throw Object.assign(new Error("批改结果与这道题不符"), { code: "RUBRIC_MISMATCH" });
  const taskCheck = grading.taskCheck || null;
  const { run, entry } = gradingEntry(state, deck.id, card.id, { runId, answer, entryIndex });
  // The job that held the question is over (lib/contexts/study/grading-marker.js).
  releaseGrading(entry);
  const resolvedLang = language ?? deck.case?.language;
  if (entry?.feedback?.rubric) {
    if (!taskCheck) {
      if ((entry.response ?? entry.feedback.answer) !== answer)
        throw new Error("Question already graded with different response; start a new attempt");
      const { grade, rubric } = entry.feedback;
      return { deckId: deck.id, cardId: card.id, runId: run.id, grade, total: rubric.total, max: rubric.max, rubric,
        ...(entry.feedback.updatedAfterOpening ? { updatedAfterOpening: true } : {}),
        message: gradeDoneMessage(rubric.total, rubric.max, false, resolvedLang) };
    }
    const sameTaskCheck = !!(entry.feedback.taskCheck
      && JSON.stringify(entry.feedback.taskCheck.checks) === JSON.stringify(taskCheck.checks)
      && JSON.stringify(entry.feedback.taskCheck.files || []) === JSON.stringify(taskCheck.files || [])
      && (entry.feedback.taskCheck.summary || "") === (taskCheck.summary || "")
      && (entry.response ?? entry.feedback.answer) === answer);
    if (sameTaskCheck) {
      const { grade, rubric } = entry.feedback;
      return { deckId: deck.id, cardId: card.id, runId: run.id, grade, total: rubric.total, max: rubric.max, rubric,
        taskCheck: entry.feedback.taskCheck,
        ...(entry.feedback.updatedAfterOpening ? { updatedAfterOpening: true } : {}),
        message: gradeDoneMessage(rubric.total, rubric.max, true, resolvedLang) };
    }
  }
  const basis = entry?.card ?? card;
  const basisDigest = expectedDigest !== undefined || entry ? rubricDigest(basis) : undefined;
  if (expectedDigest !== undefined && basisDigest !== expectedDigest)
    throw new Error("题目已更新，旧批改结果未保存；请针对新版重新提交");
  const staleSnapshot = !!entry && basisDigest !== rubricDigest(card);
  // Disconnected keywords never pass: when the grader says the answer is fragments only, the grade stays at 2 or below whatever the marks add up to.
  const grade = cappedGrade(smGradeFor(result.total, result.max), correction);
  if (entry && !("reviewBefore" in entry)) entry.reviewBefore = structuredClone(card.review ?? null);
  const before = (entry ? structuredClone(entry.reviewBefore) : structuredClone(card.review ?? null)) ?? initialReview(state.settings);
  const schedSettings = cardScheduleSettings(state, deck, card).settings;
  // A tail retry is practice after feedback, not a second spaced-repetition interval.
  const after = entry?.retry || staleSnapshot ? before : schedule(before, grade, timestamp, schedSettings);
  if (!entry?.retry && !staleSnapshot) card.review = after;
  const rubric = { total: result.total, max: result.max, ratio: result.ratio, band: result.band, unanswered: result.unanswered,
    criteria: result.criteria, unanchored: result.unanchored, assumptions: result.assumptions, summary: result.summary || grading.summary || "" };
  const incompletePriorTask = !!(entry?.feedback?.taskCheck
    && ((entry.feedback.taskCheck.counts?.missing || 0) > 0 || (entry.feedback.taskCheck.counts?.issue || 0) > 0));
  const priorSolutionExposed = !!(taskCheck && entry?.revealed
    && (!entry.feedback || entry.feedback.selfReported || incompletePriorTask));
  const exposedEntryAssistance = applyExposureToAssistance(entry?.assistance, state.learner?.solutionExposures, {
    cardId: card.id,
    deckId: deck.id,
    draftId: deck.id,
    jobId: deck.editorial?.generation?.runId,
    beforeAt: timestamp,
  });
  const assistance = assistanceEvidence(exposedEntryAssistance, priorSolutionExposed ? { revealedBeforeAnswer: true } : {});
  const taskAllSatisfied = !!taskCheck && (taskCheck.counts?.satisfied || 0) > 0 && (taskCheck.counts?.missing || 0) === 0 && (taskCheck.counts?.issue || 0) === 0;
  const passed = taskCheck ? taskAllSatisfied : grade >= 3;
  /* A miss whose grade lands after the learner had left the question (autopilot moved on, or they went on themselves) waits until they have read
     its correction (review.correction.ack) before its tail retry is queued. A miss graded while the question is on screen is as it always was. */
  const left = !!run && !!entry && run.mode !== "exam" && !run.closedAt && !entry.retry && !taskCheck && run.entries[run.index] !== entry;
  const correctionPending = left && grade <= 1;
  if (entry) {
    if (!taskCheck || taskAllSatisfied) entry.revealed = true;
    if (assistance.revealedBeforeAnswer || assistance.blueprintExposed || assistance.sampleExposed || assistance.unseenStatus) entry.assistance = assistance;
    delete entry.draft;
    entry.response = answer;
    entry.signature = "rubric";
    entry.feedback = { correct: passed, grade, rubric, answer, nextDue: after.due_at, gradedAt: timestamp,
      ...(correction ? { correction } : {}),
      ...(correctionPending ? { correctionPending: true } : {}),
      ...(taskCheck ? { taskCheck, level: cardLevel({ ...card, review: after }, grade),
        ...(assistance.revealedBeforeAnswer ? { revealedBeforeAnswer: true } : {}) } : {}),
      ...(staleSnapshot ? { updatedAfterOpening: true } : {}) };
  }
  state.attempts.push({ id: id(), runId: run?.id || null, quiz_id: card.id, deckId: deck.id, topic: card.topic, timestamp, grade, correct: passed,
    assessment: "rubric", learnerAnswer: answer, score: result.total, maxScore: result.max, rubric: compactRubric(result),
    ...(taskCheck ? { taskCheck: { mode: taskCheck.mode, files: taskCheck.files, summary: taskCheck.summary, counts: taskCheck.counts,
      issues: taskCheck.issues, issuesTruncated: taskCheck.issuesTruncated, omittedIssueCount: taskCheck.omittedIssueCount || 0,
      checks: taskCheck.checks.map(({ id, label, status, line, detail, evidence, score, marks }) => ({
        id, label, status, ...(line ? { line } : {}), ...(detail ? { detail, feedback: detail } : {}), ...(evidence ? { evidence } : {}), score, max: marks,
      })) } } : {}),
    elapsed_ms: entry ? Math.max(0, Date.now() - (entry.startedAt || Date.now())) : 0, retry: !!entry?.retry, before, after,
    assistance,
    ...(staleSnapshot ? { updatedAfterOpening: true } : {}) });
  // A similar question (#1015, run.similarFor) credits no prerequisite, as in review.answer.
  const credited = settlePrerequisiteCredit(state, { run, entry, deckId: deck.id, cardId: card.id, timestamp,
    eligible: passed && !assistance.used && assistance.unseenStatus !== "unknown" && !entry?.retry && !staleSnapshot && !run?.similarFor });
  notify(state, { kind: "grade", deckId: deck.id, cardId: card.id, detail: `${result.total}/${result.max}` });
  return { deckId: deck.id, cardId: card.id, runId: run?.id || null, grade, total: result.total, max: result.max, rubric,
    ...(correctionPending ? { correctionPending: true } : {}),
    ...(taskCheck ? { taskCheck } : {}),
    ...(staleSnapshot ? { updatedAfterOpening: true } : {}),
    ...(credited > 0 ? { credited } : {}),
    message: gradeDoneMessage(rubric.total, rubric.max, !!taskCheck, resolvedLang) };
}
