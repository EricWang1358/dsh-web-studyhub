import { hasOptions } from './card-kinds.js';
// Keep missing authored text visible as an empty draft field. Publication still
// rejects an empty field, while other sound cards can proceed independently.
export const DRAFT_TEXT_FIELDS = [
  "topic", "objective", "prompt", "answer", "hint", "explanation", "misconception",
];

// Models may use null for absent optional fields. Only omit those fields when
// they do not apply to this kind; never replace an invalid active answer key.
export function omitInapplicableNullFields(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) return card;
  const next = { ...card };
  if (!hasOptions(next.kind) && next.options === null) delete next.options;
  if (next.kind !== "open" && next.kind !== "task" && next.rubric === null) delete next.rubric;
  if (next.rubricCriteria === null) delete next.rubricCriteria;
  if (next.marks === null) delete next.marks;
  if (next.kind !== "cloze" && next.cloze === null) delete next.cloze;
  return next;
}

export function fillMissingDraftText(card) {
  const next = { ...card };
  for (const field of DRAFT_TEXT_FIELDS)
    if (next[field] === undefined || next[field] === null) next[field] = "";
  return next;
}

export function normalizeEditableDraftCard(card) {
  const next = fillMissingDraftText(card);
  // A partially shaped answer cannot be graded safely. Leave this card
  // visibly incomplete for repair instead of guessing an answer key.
  if (next.options !== undefined && (!Array.isArray(next.options) || next.options.some((option) =>
    !option || typeof option !== "object" || Array.isArray(option) ||
    typeof option.id !== "string" || typeof option.text !== "string" ||
    typeof option.explanation !== "string" || typeof option.correct !== "boolean")))
    next.options = [];
  if (next.cloze !== undefined && (!next.cloze || typeof next.cloze !== "object" ||
    typeof next.cloze.text !== "string" || !Array.isArray(next.cloze.answers) ||
    next.cloze.answers.some((answer) => !answer || typeof answer.id !== "string" ||
      typeof answer.value !== "string")))
    next.cloze = { text: typeof next.cloze?.text === "string" ? next.cloze.text : "", answers: [] };
  if (next.rubric !== undefined && typeof next.rubric !== "string") next.rubric = "";
  if (next.marks !== undefined && (typeof next.marks !== "number" || !Number.isFinite(next.marks) || next.marks <= 0)) delete next.marks;
  if (next.rubricCriteria !== undefined && (!Array.isArray(next.rubricCriteria) || next.rubricCriteria.some((c) => !c || typeof c !== "object" || Array.isArray(c)))) delete next.rubricCriteria;
  if (next.focus !== undefined && typeof next.focus !== "boolean") delete next.focus;
  if (next.difficulty !== undefined && !["foundation", "application", "advanced"].includes(next.difficulty)) delete next.difficulty;
  return next;
}
