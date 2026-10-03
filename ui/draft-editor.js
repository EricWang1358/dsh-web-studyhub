import { fillMissingDraftText, omitInapplicableNullFields } from "../lib/draft-fields.js";
import { ui } from "./i18n.js";

export function hasUnsavedDraft({ draft, draftText, jsonMode, draftLoaded } = {}) {
  if (!draft) return false;
  if (!draft.draftVersion || !draftLoaded) return true;
  return JSON.stringify(draft) !== draftLoaded ||
    (jsonMode && draftText !== JSON.stringify(draft, null, 2));
}

export function parseDraft(raw) {
  const d = JSON.parse(raw);
  if (
    !d ||
    typeof d !== "object" ||
    typeof d.title !== "string" ||
    !Array.isArray(d.cards) ||
    !d.cards.length
  )
    throw new Error(ui("题组需要 title 和非空 cards 数组"));
  d.cards = d.cards.map(card => fillMissingDraftText(omitInapplicableNullFields(card)));
  for (const q of d.cards) {
    if (!q || typeof q !== "object") throw new Error(ui("每道题必须是一个对象"));
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
      if (typeof q[key] !== "string")
        throw new Error(ui("每道题需要文本字段：") + key);
    if (q.rubric !== undefined && typeof q.rubric !== "string")
      throw new Error(ui("rubric 必须是文本"));
    if (q.cloze !== undefined) {
      if (
        !q.cloze ||
        typeof q.cloze.text !== "string" ||
        !Array.isArray(q.cloze.answers)
      )
        throw new Error(ui("cloze 需要 text 和 answers 数组"));
      if (q.cloze.answers.some((a) => !a || typeof a.id !== "string" || typeof a.value !== "string"))
        throw new Error(ui("cloze answers 每项需要 id 和 value"));
    }
    if (
      !Array.isArray(q.citations) ||
      q.citations.some(
        (c) =>
          !c || typeof c.quote !== "string" || typeof c.sourceId !== "string",
      )
    )
      throw new Error(ui("citations 需要 sourceId 和 quote"));
    if (
      q.options !== undefined &&
      (!Array.isArray(q.options) ||
        q.options.some(
          (o) =>
            !o ||
            typeof o.id !== "string" ||
            typeof o.text !== "string" ||
            typeof o.explanation !== "string" ||
            typeof o.correct !== "boolean",
        ))
    )
      throw new Error(ui("选项结构不完整"));
  }
  return d;
}
