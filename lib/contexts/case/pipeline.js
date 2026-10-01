/* The model calls of case-study practice: write a paper, review it
   independently, write criteria for imported questions, and grade answers.
   Each call is retried on transient model failures (withModelRetry) and asked
   again once when the reply is not usable JSON; everything the model returns
   passes the normalisers of lib/case-study.js before the app trusts it. */
import { parseJson } from "../../generation.js";
import { withModelRetry } from "../../model-retry.js";
import {
  caseAuthorPrompt, caseReviewPrompt, caseGradingPrompt, caseCriteriaPrompt, normalizeAuthoredCase, normalizeCaseReview,
  normalizeImportedCriteria, normalizeGrading, gradingShapeOk, isBlank,
} from "../../case-study.js";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);

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

/** Write a paper (or revise one with `request.repair`); returns { paper, issues }. */
export async function authorCase(complete, request, options = {}) {
  const { system, prompt } = caseAuthorPrompt(request);
  const raw = await askJson(complete, system, prompt, { ...options, label: "case author",
    valid: (value) => object(value) && (Array.isArray(value.questions) || Array.isArray(value.paper?.questions)) });
  if (typeof raw.error === "string" && raw.error.trim()) throw Object.assign(new Error(raw.error.trim().slice(0, 300)), { code: "CASE_AUTHOR_DECLINED" });
  return normalizeAuthoredCase(raw, request);
}

/** The independent review of a paper; returns { approved, checks, failed, issues, summary }. */
export async function reviewCase(complete, paper, { styleText, language } = {}, options = {}) {
  const { system, prompt } = caseReviewPrompt(paper, { styleText, language });
  return normalizeCaseReview(await askJson(complete, system, prompt, { ...options, label: "case review",
    valid: (value) => object(value) && object(value.checks) }));
}

/** Criteria and model answers for imported questions; returns { paper, issues }. */
export async function writeCriteria(complete, input, options = {}) {
  const { system, prompt } = caseCriteriaPrompt(input);
  const raw = await askJson(complete, system, prompt, { ...options, label: "criteria",
    valid: (value) => object(value) && Array.isArray(value.questions) });
  return normalizeImportedCriteria(raw, input);
}

/**
 * Grade the answers of one paper.
 * @param paper { title, paragraphs, cues, questions: [{ cardId, prompt, marks, answer, criteria }] }
 */
export async function gradeCase(complete, { paper, answers = {}, scenario = "", guidance = "", language } = {}, options = {}) {
  const { system, prompt } = caseGradingPrompt({ title: paper.title, paragraphs: paper.paragraphs, cues: paper.cues,
    questions: paper.questions, answers, guidance, language });
  const answered = paper.questions.some((question) => !isBlank(answers[question.cardId]));
  const raw = answered ? await askJson(complete, system, prompt, { ...options, label: "grading", valid: gradingShapeOk }) : { questions: [] };
  return normalizeGrading(raw, { questions: paper.questions, answers, scenario });
}
