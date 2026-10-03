import { randomInt } from "node:crypto";
import { citationCheck, quotePages } from "./quote-match.js";
import { omitInapplicableNullFields } from "./draft-fields.js";

// SM-2 lives in a pure module so the Settings preview runs the same scheduler.
export { defaults, checkSettings, initialReview, schedule } from "./sm2.js";
export const shuffled = (values) => {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
// Verbatim-citation matching lives in lib/quote-match.js (one rule for the plan, the author, the repair and publishing).
export { quoteKey, quoteFound } from "./quote-match.js";

export const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const text = (v) => typeof v === "string" && v.trim().length > 0;
/* Case-study questions (WP12) are open cards with marks and structured rubric
   criteria: [{ id, label, marks, descriptor, keyPoints: string[] }]. The marks
   of the criteria add up to the question's marks, so a grader can award each
   criterion separately. Cards without criteria are unaffected. */
export function rubricCriteriaIssues(card) {
  const criteria = card?.rubricCriteria;
  if (criteria === undefined) return [];
  const issues = [];
  if (card.kind !== "open") issues.push("only open questions take rubric criteria");
  const marks = card.marks;
  if (!Number.isFinite(marks) || marks <= 0) issues.push("rubric criteria need positive question marks");
  if (!Array.isArray(criteria) || !criteria.length) return [...issues, "rubric criteria need at least one criterion"];
  const ids = new Set();
  let sum = 0;
  for (const [index, criterion] of criteria.entries()) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
      issues.push(`criterion ${index + 1} must be an object`);
      continue;
    }
    if (!text(criterion.id)) { issues.push(`criterion ${index + 1} needs an id`); continue; }
    const name = criterion.id.trim();
    if (ids.has(name)) issues.push(`duplicate criterion id ${name}`);
    ids.add(name);
    if (!text(criterion.label)) issues.push(`criterion ${name} needs a label`);
    if (!text(criterion.descriptor)) issues.push(`criterion ${name} needs a descriptor`);
    if (!Number.isFinite(criterion.marks) || criterion.marks <= 0) issues.push(`criterion ${name} needs positive marks`);
    else sum += criterion.marks;
    if (criterion.keyPoints !== undefined && (!Array.isArray(criterion.keyPoints) || criterion.keyPoints.some((point) => !text(point))))
      issues.push(`criterion ${name} key points must be non-empty text`);
  }
  if (Number.isFinite(marks) && marks > 0 && Math.abs(sum - marks) > 1e-9)
    issues.push(`rubric criteria marks add up to ${Math.round(sum * 100) / 100}, not ${marks}`);
  return issues;
}
function optionalCardShapeErrors(card, label) {
  const errors = [];
  if (card.rubric !== undefined && typeof card.rubric !== "string") errors.push(`${label}: rubric must be text`);
  if (card.marks !== undefined && (typeof card.marks !== "number" || !Number.isFinite(card.marks))) errors.push(`${label}: marks must be a number`);
  if (card.rubricCriteria !== undefined && (!Array.isArray(card.rubricCriteria) || card.rubricCriteria.some((criterion) =>
    !criterion || typeof criterion !== "object" || Array.isArray(criterion))))
    errors.push(`${label}: rubricCriteria must be a list of criteria`);
  if (card.options !== undefined && (!Array.isArray(card.options) || card.options.some((option) =>
    !option || typeof option !== "object" || Array.isArray(option) ||
    typeof option.id !== "string" || typeof option.text !== "string" ||
    typeof option.explanation !== "string" || typeof option.correct !== "boolean")))
    errors.push(`${label}: options have an invalid shape`);
  if (card.cloze !== undefined && (!card.cloze || typeof card.cloze !== "object" || Array.isArray(card.cloze) ||
    typeof card.cloze.text !== "string" || !Array.isArray(card.cloze.answers) ||
    card.cloze.answers.some((answer) => !answer || typeof answer !== "object" || Array.isArray(answer) ||
      typeof answer.id !== "string" || typeof answer.value !== "string" ||
      (answer.accept !== undefined && (!Array.isArray(answer.accept) || answer.accept.some(value => typeof value !== "string"))))))
    errors.push(`${label}: cloze has an invalid shape`);
  return errors;
}
/** Drafts may contain unfinished content, but must remain safe to edit and render. */
export function draftShapeErrors(deck) {
  const errors = [];
  if (!text(deck?.title)) errors.push("Deck title is required");
  if (!Array.isArray(deck?.cards) || !deck.cards.length)
    return [...errors, "Deck must contain at least one card"];
  const ids = new Set();
  for (const [index, rawCard] of deck.cards.entries()) {
    const card = omitInapplicableNullFields(rawCard);
    const label = `Card ${index + 1}`;
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      errors.push(`${label}: expected object`);
      continue;
    }
    for (const key of ["id", "kind", "topic", "objective", "prompt", "answer", "hint", "explanation", "misconception"])
      if (typeof card[key] !== "string") errors.push(`${label}: ${key} must be text`);
    if (typeof card.id === "string") {
      if (!card.id.trim() || ids.has(card.id)) errors.push(`${label}: id must be unique and non-empty`);
      ids.add(card.id);
    }
    if (!["flashcard", "quiz", "multi", "open", "cloze"].includes(card.kind))
      errors.push(`${label}: unsupported kind`);
    errors.push(...optionalCardShapeErrors(card, label));
    if (!Array.isArray(card.citations) || card.citations.some((ref) =>
      !ref || typeof ref !== "object" || Array.isArray(ref) ||
      typeof ref.sourceId !== "string" || typeof ref.quote !== "string"))
      errors.push(`${label}: citations need sourceId and quote text`);
  }
  return errors;
}
export function validateDeck(deck, sources) {
  const errors = [],
    warnings = [],
    ids = new Set(),
    targets = new Set(),
    prompts = new Set();
  // Every slice of a long source is one page for the check, and a quote may run over a page boundary.
  const pages = quotePages(sources);
  if (!text(deck?.title)) errors.push("Deck title is required");
  if (
    !Array.isArray(deck?.cards) ||
    !deck.cards.length
  )
    return { errors: [...errors, "Deck must contain at least one card"], warnings };
  for (const [i, rawCard] of deck.cards.entries()) {
    const q = omitInapplicableNullFields(rawCard);
    const label = `Card ${i + 1}`;
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      errors.push(`${label}: expected object`);
      continue;
    }
    for (const key of [
      "id",
      "kind",
      "topic",
      "objective",
      "prompt",
      "answer",
      "hint",
      "explanation",
      "misconception",
    ])
      if (!text(q[key])) errors.push(`${label}: ${key} is required`);
    if (!["flashcard", "quiz", "multi", "open", "cloze"].includes(q.kind))
      errors.push(`${label}: unsupported kind`);
    if (ids.has(q.id)) errors.push(`${label}: duplicate id`);
    ids.add(q.id);
    if (targets.has(norm(q.objective)))
      errors.push(`${label}: duplicate learning objective`);
    targets.add(norm(q.objective));
    if (prompts.has(norm(q.prompt))) errors.push(`${label}: duplicate prompt`);
    prompts.add(norm(q.prompt));
    const shapeErrors = optionalCardShapeErrors(q, label);
    errors.push(...shapeErrors);
    // An invalid answer structure cannot be inspected safely or published.
    if (shapeErrors.length) continue;
    if (!Array.isArray(q.citations) || (!q.citations.length && !q.importedFromJson))
      errors.push(`${label}: source citations required`);
    else
      for (const ref of q.citations) {
        const check = citationCheck(pages, ref, { locate: false });
        if (!check.ok && check.reason === "unknown-source") errors.push(`${label}: unknown source`);
        else if (!check.ok)
          errors.push(
            `${label}: quote must match a source passage (at least 12 characters)`,
          );
      }
    if (q.kind === "open" && !text(q.rubric))
      errors.push(`${label}: open response needs a scoring rubric`);
    for (const issue of rubricCriteriaIssues(q)) errors.push(`${label}: ${issue}`);
    if (["quiz", "multi"].includes(q.kind)) {
      if (
        !Array.isArray(q.options) ||
        q.options.length < 3 ||
        q.options.length > 6
      ) {
        errors.push(`${label}: need 3–6 options`);
        continue;
      }
      const correct = q.options.filter((o) => o.correct === true).length;
      if (
        q.kind === "quiz"
          ? correct !== 1
          : correct < 1 || correct === q.options.length
      )
        errors.push(`${label}: invalid correct option count`);
      if (new Set(q.options.map((o) => o.id)).size !== q.options.length)
        errors.push(`${label}: duplicate option id`);
      if (new Set(q.options.map((o) => norm(o.text))).size !== q.options.length)
        errors.push(`${label}: duplicate option text`);
      for (const o of q.options)
        if (
          !text(o.id) ||
          !text(o.text) ||
          !text(o.explanation) ||
          typeof o.correct !== "boolean"
        )
          errors.push(
            `${label}: each option requires id, text, correct and explanation`,
          );
      const lengths = q.options.map((o) => String(o.text ?? "").length);
      if (Math.max(...lengths) > Math.max(1, Math.min(...lengths)) * 3)
        warnings.push(`${label}: option lengths may cue the answer`);
    }
    if (norm(q.hint) === norm(q.answer))
      errors.push(`${label}: hint reveals the answer`);
    if (q.kind === "cloze") validateCloze(q, label, errors);
  }
  return { errors, warnings };
}
const CLOZE_MARKER = /\{\{([^{}]+)\}\}/g;
function validateCloze(q, label, errors) {
  const bl = q.cloze;
  if (!bl || typeof bl !== "object" || !text(bl.text)) {
    errors.push(`${label}: cloze text is required`);
    return;
  }
  const marks = [...bl.text.matchAll(CLOZE_MARKER)].map((m) => m[1]);
  if (!marks.length) errors.push(`${label}: cloze text needs {{}} markers`);
  if (!Array.isArray(bl.answers) || !bl.answers.length) {
    errors.push(`${label}: cloze answers are required`);
    return;
  }
  const ids = new Set();
  for (const ans of bl.answers) {
    if (!ans || typeof ans !== "object" || !text(ans.id)) {
      errors.push(`${label}: each cloze answer needs an id`);
      continue;
    }
    if (ids.has(ans.id))
      errors.push(`${label}: duplicate cloze answer id ${ans.id}`);
    ids.add(ans.id);
    if (!text(ans.value))
      errors.push(`${label}: cloze answer ${ans.id} needs a value`);
    if (
      ans.accept !== undefined &&
      (!Array.isArray(ans.accept) || ans.accept.some((x) => !text(x)))
    )
      errors.push(
        `${label}: cloze answer ${ans.id} accepts must be non-empty strings`,
      );
  }
  for (const m of marks)
    if (!ids.has(m)) errors.push(`${label}: cloze marker {{${m}}} has no answer`);
  for (const id of ids)
    if (!marks.includes(id))
      errors.push(`${label}: cloze answer ${id} has no marker in the text`);
}
/** Code-graded cloze: normalized comparison per blank; never leaks answers. */
export function gradeCloze(card, answers = {}) {
  const list = card.cloze?.answers || [];
  const details = list.map(({ id, value, accept }) => {
    const given = typeof answers[id] === "string" ? norm(answers[id]) : "";
    const ok =
      !!given && [value, ...(accept || [])].some((x) => norm(x) === given);
    return { id, correct: ok, ...(ok ? {} : { expected: value }) };
  });
  return {
    correct: details.length > 0 && details.every((d) => d.correct),
    details,
  };
}
export function publicCard(card, order) {
  const { id, kind, topic, prompt, hint } = card;
  return {
    id,
    kind,
    topic,
    prompt,
    hint,
    importedFromJson: !!card.importedFromJson,
    sourceQa: !!card.sourceQa,
    publicationIssues: card.publicationIssues || [],
    publicationUngrable: !!card.publicationUngrable,
    // Case questions (WP12): marks and criterion labels before answering; descriptors and key points stay server-side.
    ...(Number.isFinite(card.marks) ? { marks: card.marks } : {}),
    ...(Array.isArray(card.rubricCriteria) ? { rubricCriteria: card.rubricCriteria.map(({ id, label, marks }) => ({ id, label, marks })) } : {}),
    multiple: kind === "multi",
    options: order
      ?.map((id) => card.options.find((o) => o.id === id))
      .filter(Boolean)
      .map(({ id, text }) => ({ id, text })),
    // Cloze blanks are public; the values stay server-side until answered.
    ...(kind === "cloze"
      ? {
          cloze: {
            text: card.cloze?.text || "",
            blanks: (card.cloze?.answers || []).map(({ id }) => ({ id })),
          },
        }
      : {}),
    // The stem side of an EN translation is safe before answering; the answer
    // side travels with the solution and stays server-side until the reveal.
    ...(card.translation && typeof card.translation === "object"
      ? {
          translation: {
            prompt: card.translation.prompt,
            ...(typeof card.translation.clozeText === "string"
              ? { clozeText: card.translation.clozeText }
              : {}),
            ...(Array.isArray(card.translation.options)
              ? {
                  options: card.translation.options.map(({ id, text }) => ({
                    id,
                    text,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}
