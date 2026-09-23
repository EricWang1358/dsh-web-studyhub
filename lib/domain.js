import { randomInt } from "node:crypto";

export const defaults = Object.freeze({
  minimum_ease_factor: 1.3,
  initial_ease_factor: 2.5,
  first_interval_days: 1,
  second_interval_days: 6,
});
export function checkSettings(c) {
  for (const k of Object.keys(defaults))
    if (!Number.isFinite(c[k]) || c[k] <= 0 || c[k] > 365)
      throw new Error(`Invalid scheduling value: ${k}`);
  if (c.initial_ease_factor < c.minimum_ease_factor)
    throw new Error("Initial ease must be at least minimum ease");
  for (const k of ["first_interval_days", "second_interval_days"])
    if (!Number.isInteger(c[k]))
      throw new Error("Intervals must be whole days");
  return c;
}
export const initialReview = (c = defaults) => ({
  repetitions: 0,
  interval_days: 0,
  ease_factor: c.initial_ease_factor,
  due_at: null,
});
export function schedule(before, grade, timestamp, c = defaults) {
  checkSettings(c);
  if (!Number.isInteger(grade) || grade < 0 || grade > 5)
    throw new Error("Grade must be an integer from 0 to 5");
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error("Invalid timestamp");
  const ease_factor =
    Math.round(
      Math.max(
        c.minimum_ease_factor,
        before.ease_factor + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02),
      ) * 100,
    ) / 100;
  const interval_days =
    grade < 3
      ? 1
      : before.repetitions === 0
        ? c.first_interval_days
        : before.repetitions === 1
          ? c.second_interval_days
          : Math.max(1, Math.round(before.interval_days * ease_factor));
  const due = new Date(timestamp);
  due.setUTCDate(due.getUTCDate() + interval_days);
  return {
    repetitions: grade < 3 ? 0 : before.repetitions + 1,
    interval_days,
    ease_factor,
    due_at: due.toISOString(),
  };
}
export const shuffled = (values) => {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
/* Verbatim-citation matching. A quote must come from the source, but models
   reliably drop or alter characters that carry no meaning: emoji and their
   variation selectors (lecture bullets are full of them), zero-width marks,
   soft hyphens, and the line breaks and indentation of a PDF transcription.
   Comparing on a key without those — and without whitespace — keeps the check
   honest about wording while tolerating that noise, so one bullet emoji can no
   longer sink a whole generation. */
const QUOTE_NOISE =
  /(?:\\[ntr]|[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0E\uFE0F\u200B-\u200D\uFEFF\u00AD\u2060\p{Cf}\s])+/gu;
export const quoteKey = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(QUOTE_NOISE, "");
/** Whether a model-supplied quote appears verbatim (modulo that noise) in a source. */
export const quoteFound = (sourceText, quote) => quoteKey(sourceText).includes(quoteKey(quote));

export const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const text = (v) => typeof v === "string" && v.trim().length > 0;
/** Drafts may contain unfinished content, but must remain safe to edit and render. */
export function draftShapeErrors(deck) {
  const errors = [];
  if (!text(deck?.title)) errors.push("Deck title is required");
  if (!Array.isArray(deck?.cards) || !deck.cards.length)
    return [...errors, "Deck must contain at least one card"];
  const ids = new Set();
  for (const [index, card] of deck.cards.entries()) {
    const label = `Card ${index + 1}`;
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      errors.push(`${label}: expected object`);
      continue;
    }
    for (const key of ["id", "kind", "topic", "objective", "prompt", "answer", "hint", "explanation", "misconception"])
      if (typeof card[key] !== "string") errors.push(`${label}: ${key} must be text`);
    if (typeof card.id === "string") {
      if (!card.id || ids.has(card.id)) errors.push(`${label}: id must be unique and non-empty`);
      ids.add(card.id);
    }
    if (!["flashcard", "quiz", "multi", "open", "cloze"].includes(card.kind))
      errors.push(`${label}: unsupported kind`);
    if (card.rubric !== undefined && typeof card.rubric !== "string") errors.push(`${label}: rubric must be text`);
    if (!Array.isArray(card.citations) || card.citations.some((ref) =>
      !ref || typeof ref !== "object" || Array.isArray(ref) ||
      typeof ref.sourceId !== "string" || typeof ref.quote !== "string"))
      errors.push(`${label}: citations need sourceId and quote text`);
    if (card.options !== undefined && (!Array.isArray(card.options) || card.options.some((option) =>
      !option || typeof option !== "object" || Array.isArray(option) ||
      typeof option.id !== "string" || typeof option.text !== "string" ||
      typeof option.explanation !== "string" || typeof option.correct !== "boolean")))
      errors.push(`${label}: options have an invalid shape`);
    if (card.cloze !== undefined && (!card.cloze || typeof card.cloze !== "object" ||
      typeof card.cloze.text !== "string" || !Array.isArray(card.cloze.answers) ||
      card.cloze.answers.some((answer) => !answer || typeof answer.id !== "string" ||
        typeof answer.value !== "string")))
      errors.push(`${label}: cloze has an invalid shape`);
  }
  return errors;
}
export function validateDeck(deck, sources) {
  const errors = [],
    warnings = [],
    ids = new Set(),
    targets = new Set(),
    prompts = new Set();
  const sourceTexts = new Map();
  for (const source of sources)
    if (!sourceTexts.has(source.id))
      sourceTexts.set(source.id, norm(source.text));
  if (!text(deck?.title)) errors.push("Deck title is required");
  if (
    !Array.isArray(deck?.cards) ||
    !deck.cards.length
  )
    return { errors: [...errors, "Deck must contain at least one card"], warnings };
  for (const [i, q] of deck.cards.entries()) {
    const label = `Card ${i + 1}`;
    if (!q || typeof q !== "object") {
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
    if (!Array.isArray(q.citations) || !q.citations.length)
      errors.push(`${label}: source citations required`);
    else
      for (const ref of q.citations) {
        const sourceText = sourceTexts.get(ref.sourceId);
        if (sourceText === undefined) errors.push(`${label}: unknown source`);
        else if (
          !text(ref.quote) ||
          norm(ref.quote).length < 12 ||
          !quoteFound(sourceText, ref.quote)
        )
          errors.push(
            `${label}: quote must match a source passage (at least 12 characters)`,
          );
      }
    if (q.kind === "open" && !text(q.rubric))
      errors.push(`${label}: open response needs a scoring rubric`);
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
