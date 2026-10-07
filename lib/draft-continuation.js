/* Continuing a draft that came out short (补题): what is still missing and what
   a continuation asks for. The `generate` action (resumeDraftId), the token
   estimate shown before it and the buttons that offer it all read the same
   rules from here, so the number on the button, the estimate under it and the
   job that runs are the same number. Pure. */

import { ROUND_LIMIT } from './coverage-round.js';
import { requestKinds, splitCount } from './generation-settings.js';

/** Questions the draft was asked for and does not have yet. For a draft made from a coverage plan that is the questions of the round it was asked for (`requested`); the rest of the plan is `editorial.coverageSpec`. */
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
 * density (questions per covered source, kept within half and double) times the sources, inside what one ROUND may ask for (30, lib/coverage-round.js ROUND_LIMIT: a total above that is made in rounds).
 */
export function extraQuestionDefault(draft, uncovered) {
  if (!(uncovered > 0)) return 0;
  const covered = (draft?.editorial?.coverage?.sources || []).filter((source) => source.accepted > 0).length;
  const density = covered > 0 && draft.cards?.length ? Math.min(2, Math.max(0.5, draft.cards.length / covered)) : 1;
  return Math.min(ROUND_LIMIT, Math.max(1, Math.round(uncovered * density)));
}

/**
 * A draft of several kinds (the old mixed, or a chosen combination) is topped up per kind, so it ends with the split it was asked for.
 * @returns `{ [kind]: questions }` over its kinds when the missing questions can restore that split exactly, else undefined
 */
export function continuationKindCounts(previous) {
  const generation = previous?.editorial?.generation, kinds = requestKinds(generation);
  if (kinds.length < 2) return undefined;
  const requested = previous.editorial.requested, missing = missingQuestions(previous);
  const counts = Object.fromEntries(splitCount(kinds, requested).map(([kind, asked]) => [kind, Math.max(0, asked - previous.cards.filter((card) => card.kind === kind).length)]));
  return Object.values(counts).reduce((sum, count) => sum + count, 0) === missing ? counts : undefined;
}
