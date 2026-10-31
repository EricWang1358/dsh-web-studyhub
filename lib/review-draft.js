/* A question's unsubmitted answer at the library's door (#537): what review.draft.save keeps, and the short copy the compact scene shows. Pure.
   The stored draft is what comes back to the learner, so it is cut only far past anything the library would grade. */

/** Well above the longest answer the library grades (CASE_LIMITS.answerChars, 30000). */
export const MAX_DRAFT_TEXT_CHARS = 100000;
export const MAX_DRAFT_SELECTED = 200;
export const MAX_DRAFT_STEPS = 200;

const invalid = (message) => Object.assign(new Error(`Invalid draft: ${message}`), { code: 'review-draft-invalid' });
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Checks a draft as it comes in. Fields left out stay out; empty values stay in, since writing them is what clears an older draft. Throws on anything else. */
export function parseDraft(raw) {
  if (!isPlainObject(raw)) throw invalid('draft must be an object');
  const { selected, text, stepInputs } = raw;
  if (selected !== undefined && (!Array.isArray(selected) || selected.length > MAX_DRAFT_SELECTED || selected.some((id) => typeof id !== 'string')))
    throw invalid(`selected must be at most ${MAX_DRAFT_SELECTED} option ids`);
  if (text !== undefined && typeof text !== 'string') throw invalid('text must be a string');
  if (stepInputs !== undefined && (!isPlainObject(stepInputs) || Object.keys(stepInputs).length > MAX_DRAFT_STEPS || Object.values(stepInputs).some((value) => typeof value !== 'string')))
    throw invalid(`stepInputs must map at most ${MAX_DRAFT_STEPS} blanks to strings`);
  const cut = (value) => value.slice(0, MAX_DRAFT_TEXT_CHARS);
  const longer = (value) => value.length > MAX_DRAFT_TEXT_CHARS;
  return {
    draft: {
      ...(selected !== undefined ? { selected } : {}),
      ...(text !== undefined ? { text: cut(text) } : {}),
      ...(stepInputs !== undefined ? { stepInputs: Object.fromEntries(Object.entries(stepInputs).map(([key, value]) => [key, cut(value)])) } : {}),
    },
    truncated: (text !== undefined && longer(text)) || (stepInputs !== undefined && Object.values(stepInputs).some(longer)),
  };
}

const SCENE_TEXT_CHARS = 400;
const SCENE_LIST = 12;
const SCENE_STEP_CHARS = 40;

/** The draft as the compact scene shows it: the learner's words start it, and the scene says when there is more. */
export function sceneDraft(draft) {
  if (!draft) return { draft: null, draftTruncated: false };
  const text = typeof draft.text === 'string' ? draft.text : '';
  const selected = Array.isArray(draft.selected) ? draft.selected : [];
  const steps = Object.entries(draft.stepInputs || {});
  const short = {
    ...(draft.text !== undefined ? { text: text.slice(0, SCENE_TEXT_CHARS) } : {}),
    ...(draft.selected !== undefined ? { selected: selected.slice(0, SCENE_LIST) } : {}),
    ...(draft.stepInputs !== undefined ? { stepInputs: Object.fromEntries(steps.slice(0, SCENE_LIST).map(([key, value]) => [key, String(value).slice(0, SCENE_STEP_CHARS)])) } : {}),
    ...(draft.updatedAt !== undefined ? { updatedAt: draft.updatedAt } : {}),
  };
  const draftTruncated = text.length > SCENE_TEXT_CHARS || selected.length > SCENE_LIST || steps.length > SCENE_LIST || steps.some(([, value]) => String(value).length > SCENE_STEP_CHARS);
  return { draft: short, draftTruncated };
}
