/* Continuing a draft that came out short (补题): what is still missing and what
   a continuation asks for. The `generate` action (resumeDraftId), the token
   estimate shown before it and the buttons that offer it all read the same
   rules from here, so the number on the button, the estimate under it and the
   job that runs are the same number. Pure. */

/** Questions the draft was asked for and does not have yet. */
export function missingQuestions(draft) {
  const requested = draft?.editorial?.requested;
  return Number.isInteger(requested) ? Math.max(0, requested - (draft.cards?.length ?? 0)) : 0;
}

/** Whether the draft can be topped up from its original materials (the same test the action applies, plus what is not worth offering). */
export function canContinueDraft(draft) {
  const rejected = Object.keys(draft?.editorial?.rejectedIssues || {}).filter((id) => draft.cards?.some((card) => card.id === id)).length;
  return missingQuestions(draft) > 0 && !!draft.editorial?.generation?.sourceIds?.length && draft.editorial.generation.kind !== 'case' &&
    !draft.editingDeckId && !rejected && !draft.editorial?.repairOfDeckId;
}

/** Whether questions can be added to this draft from some of its sources (the same test the action applies): it was generated, is not a case paper or an edit of a published deck. */
export function canAddFromSources(draft) {
  return Number.isInteger(draft?.editorial?.requested) && !!draft.editorial.generation?.sourceIds?.length && draft.editorial.generation.kind !== 'case' &&
    !draft.editingDeckId && !draft.editorial.repairOfDeckId;
}

/**
 * How many questions to offer when adding from `uncovered` sources the draft has not cited (the 用未覆盖的资料补题 button): the deck's own
 * density (questions per covered source, kept within half and double) times the sources, inside the generation limit of 1–30.
 */
export function extraQuestionDefault(draft, uncovered) {
  if (!(uncovered > 0)) return 0;
  const covered = (draft?.editorial?.coverage?.sources || []).filter((source) => source.accepted > 0).length;
  const density = covered > 0 && draft.cards?.length ? Math.min(2, Math.max(0.5, draft.cards.length / covered)) : 1;
  return Math.min(30, Math.max(1, Math.round(uncovered * density)));
}

/**
 * A mixed draft is topped up per kind, so it ends with the quiz/flashcard split it was asked for.
 * @returns `{ quiz, flashcard }` when the missing questions can restore that split exactly, else undefined
 */
export function continuationKindCounts(previous) {
  if (previous?.editorial?.generation?.kind !== 'mixed') return undefined;
  const requested = previous.editorial.requested, missing = missingQuestions(previous);
  const quiz = Math.max(0, Math.ceil(requested / 2) - previous.cards.filter((card) => card.kind === 'quiz').length);
  const flashcard = Math.max(0, Math.floor(requested / 2) - previous.cards.filter((card) => card.kind === 'flashcard').length);
  return quiz + flashcard === missing ? { quiz, flashcard } : undefined;
}
