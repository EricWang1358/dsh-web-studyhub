import { caseGenerationArgs, resolveCourseProfile } from '../../../case-study.js';
import { continuationKindCounts, nextContinuation } from '../../../draft-continuation.js';
import { draftPart, nextPartOf } from '../../../deck-parts.js';
import { currentCourse } from '../../../focus.js';
import { cleanFocusTopics, courseFocusTopics, mergeFocusTopics } from '../../../focus-points.js';
import { runModuleOverrides } from '../../../courses.js';
import { prioritizeFocusTopics } from '../../../focus-progress.js';
import { allocateKindShares, requestKinds, resolveGenerationRequest } from '../../../generation-settings.js';
import { resolveCourse } from '../../../source-courses.js';
import { documentTopUp } from '../../../coverage-state.js';
import { get } from '../../../util.js';
import { refuse } from './args.js';
import { CASE, NOT_FOUND_LABEL, PART, TARGET } from './messages.js';

/* What a run is asked, as far as the library can say before its sections are chosen: the deck it is the next part of, the request with its settings resolved, the deck
    it merges into, and a case paper's shape. */

/** Another job of this library, alive, that `holds` says is in the way (`mine`: the logical job preparing is not its own rival). */
export const someoneElse = ({ jobs, root, activeJob, mine }, holds) => [...jobs.values()].some(job => job.root === root && holds(job) && activeJob(job) && !mine(job));

/** A top-up of a PUBLISHED deck's material: the document, the deck the new draft is for (its next part). Refused while another top-up of the same document is starting
    (its draft is not saved yet). */
export function partOfDocument({ a, s, roundLimit, say }, busy) {
  const found = documentTopUp(s, { documentId: a.documentId }, { partOf: a.partOf, limit: roundLimit });
  if (!found) refuse(say, PART.notFound);
  if (!found.candidates.length) refuse(say, PART.unpublished);
  if (!found.chosen || (a.partOf === undefined && found.candidates.length > 1)) refuse(say, PART.several(found.candidates));
  if (busy(job => job.part?.documentKey === found.item.key)) refuse(say, PART.busy);
  const deck = get(s.decks, found.chosen.id, NOT_FOUND_LABEL.deck);
  return { found, deck, n: found.chosen.nextPart, documentKey: found.item.key, sourceIds: found.draft.editorial.generation.sourceIds };
}

/** A draft that already is a part (its next round, the continue action after a restart) keeps saying whose part it is. */
export function previousPartOf(s, previous) {
  const deck = previous && draftPart(previous) ? s.decks.find(item => item.id === draftPart(previous).deckId && !item.archived) : null;
  return deck ? { deckId: deck.id, deckTitle: deck.title, n: nextPartOf(deck) } : null;
}

const PART_ONLY_ARGS = ['documentId', 'partOf', 'coverage', 'sourceIds', 'mergeTargetId'];

const continuedRequest = ({ a, s, previous, extraIds }) => {
  const { kindCounts: requestedKindCounts, ...savedGeneration } = previous.editorial.generation || {};
  return {
    ...savedGeneration,
    ...(a.kindCounts !== undefined ? { kindCounts: a.kindCounts } : requestedKindCounts ? { requestedKindCounts } : {}),
    ...(a.moduleOverrides !== undefined ? { moduleOverrides: a.moduleOverrides } : {}),
    count: extraIds ? a.count : nextContinuation(previous),
    ...(extraIds ? { sourceIds: extraIds } : {}),
    title: previous.title,
    folder: previous.folder,
    course: resolveCourse(s, {}, { course: previous.course ?? previous.editorial.generation.course ?? previous.folder ?? '', preferred: currentCourse(s) }),
  };
};
/** A part keeps the settings its deck was written with and the deck's course; it is named after the material until the learner publishes it. */
const partRequest = ({ a, part }) => ({
  ...Object.fromEntries(Object.entries(a).filter(([key]) => !PART_ONLY_ARGS.includes(key))),
  sourceIds: part.sourceIds, title: typeof a.title === 'string' && a.title.trim() ? a.title : part.found.item.title, course: part.deck.course ?? part.deck.folder ?? '',
});
const newRequest = ({ a, s }) => ({ ...a, course: resolveCourse(s, a, { preferred: currentCourse(s) }) });

export function requestOf(asked) {
  const { a, s, previous, part, language } = asked;
  const request = previous ? continuedRequest(asked) : part ? partRequest(asked) : newRequest(asked);
  const resolved = Object.assign(request, resolveGenerationRequest(s.settings?.generation, { ...request, performance: a.performance },
    { language, continuation: previous?.editorial.generation ?? part?.deck.editorial?.generation }));
  // What the learner is willing to spend on THIS run, in tokens (#761): the settings resolver keeps only its own keys, so the ceiling is carried here. Absent
  // means no ceiling, as before; a coverage run keeps its own budget (coverage.tokenBudget, lib/coverage-run.js).
  if (Number.isInteger(a.tokenBudget)) resolved.tokenBudget = a.tokenBudget;
  return resolved;
}

const targetIdOf = ({ a, previous, request }) => previous ? previous.mergeTargetId ?? request.mergeTargetId : a.mergeTargetId;

function mergeInto(request, target) {
  if (target.archived || target.systemKind) throw new Error(TARGET.ordinaryOnly);
  request.mergeTargetId = target.id;
  request.course = target.course ?? target.folder ?? '';
}

/** The deck the run merges into, and what the request takes from it. */
export function targetOf(asked) {
  const { a, s, request, publishTarget } = asked;
  const targetId = targetIdOf(asked);
  const target = targetId !== undefined ? get(s.decks, targetId, NOT_FOUND_LABEL.target) : null;
  if (publishTarget && target?.id !== a.deckId) throw new Error(TARGET.otherThanDeck);
  if (target) mergeInto(request, target);
  return target;
}

/** A draft of several kinds goes on with the kinds it still owes, or scales explicit non-uniform quotas to the round's question count. */
export function applyKindCounts({ previous, extraIds, covering, request }) {
  const kinds = requestKinds(request);
  if (kinds.length <= 1) return;
  if (previous && !extraIds && !covering) {
    const kindCounts = continuationKindCounts(previous);
    if (kindCounts) {
      request.kindCounts = kindCounts;
      if (!request.requestedKindCounts) request.ephemeralKindCounts = true;
      return;
    }
  }
  const ratio = request.kindCounts || request.requestedKindCounts;
  const targetCount = covering ? covering.round.questions : request.count;
  if (ratio && Number.isInteger(targetCount) && targetCount > 0) {
    request.kindCounts = Object.fromEntries(allocateKindShares(kinds, targetCount, ratio));
  }
}

const FOLLOWED = ['sourceIds', 'language', 'styleText', 'referenceSourceIds', 'referenceLimits', 'referenceFormat', 'moduleOverrides'];
function earlierCase({ s, request, say }) {
  const from = [...s.decks, ...s.drafts].find(deck => deck.id === request.fromDeckId), earlier = from?.editorial?.generation;
  if (!from || earlier?.kind !== 'case') refuse(say, CASE.noEarlier);
  return { from, earlier };
}

function followShape(request, earlier) {
  if (request.questions === undefined) request.questions = Math.min(5, earlier.questions || 2);
  if (request.totalMarks === undefined) request.totalMarks = earlier.totalMarks;
}

/** The same materials and paper shape as an earlier case set. */
function followEarlierCase(asked) {
  const { a, request } = asked, { from, earlier } = earlierCase(asked);
  for (const key of FOLLOWED) if (a[key] === undefined && earlier[key] !== undefined) request[key] = earlier[key];
  followShape(request, earlier);
  if (a.course === undefined) request.course = from.course ?? from.folder ?? '';
}

/** A case-study paper (WP12): its exam settings, guidance and focus topics default from the course profile. */
export async function applyCase(asked) {
  const { a, previous, target, request, say, call } = asked;
  if (request.kind !== 'case') return;
  // Ordinary question-count defaults do not describe an exam paper.
  if (a.count === undefined) delete request.count;
  if (previous || target) refuse(say, CASE.notIntoDeck);
  if (typeof request.fromDeckId === 'string') followEarlierCase(asked);
  request.case = caseGenerationArgs(request, { say, profile: await resolveCourseProfile(call, request.course) });
  request.count = request.case.questions;
}

/** Ordinary question runs inherit course focusTopics and stably prioritize empty/weak focus topics first (#690 S2); `focusStatus` stays transient in memory. */
export function applyFocusTopics({ a, s, previous, part, request }) {
  if (request.kind === 'case') return;
  const inherited = previous?.editorial?.generation?.focusTopics ?? part?.deck?.editorial?.generation?.focusTopics;
  const raw = a.focusTopics !== undefined
    ? cleanFocusTopics(typeof a.focusTopics === 'string' ? a.focusTopics.split(/[,，、;；\n]/) : a.focusTopics)
    : mergeFocusTopics(inherited, courseFocusTopics(s, request.course, { includeDescendants: true }));
  if (!raw.length) {
    delete request.focusTopics;
    delete request.focusStatus;
    return;
  }
  if (a.prioritizeFocus === false) {
    request.focusTopics = raw;
    delete request.focusStatus;
    return;
  }
  const { topics, statusByTopic } = prioritizeFocusTopics(s, request.course, raw, { extraCards: previous?.cards });
  request.focusTopics = topics;
  request.focusStatus = statusByTopic;
}

/** Course generation rules (#889): a run carries its course's rules as they are NOW, in the requirements every stage is sent; never rules a caller, a retry or an earlier draft
    carried. A case paper's prompts do not take them, so its run carries none. */
export function applyCourseRules({ s, request }) {
  const next = runModuleOverrides(s, request);
  if (next) request.moduleOverrides = next;
  else delete request.moduleOverrides;
}
