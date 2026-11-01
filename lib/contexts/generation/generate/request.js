import { caseGenerationArgs, resolveCourseProfile } from '../../../case-study.js';
import { continuationKindCounts, nextContinuation } from '../../../draft-continuation.js';
import { draftPart, nextPartOf } from '../../../deck-parts.js';
import { currentCourse } from '../../../focus.js';
import { requestKinds, resolveGenerationRequest } from '../../../generation-settings.js';
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

const continuedRequest = ({ a, s, previous, extraIds }) => ({
  ...previous.editorial.generation,
  count: extraIds ? a.count : nextContinuation(previous),
  ...(extraIds ? { sourceIds: extraIds } : {}),
  title: previous.title,
  folder: previous.folder,
  course: resolveCourse(s, {}, { course: previous.course ?? previous.editorial.generation.course ?? previous.folder ?? '', preferred: currentCourse(s) }),
});
/** A part keeps the settings its deck was written with and the deck's course; it is named after the material until the learner publishes it. */
const partRequest = ({ a, part }) => ({
  ...Object.fromEntries(Object.entries(a).filter(([key]) => !PART_ONLY_ARGS.includes(key))),
  sourceIds: part.sourceIds, title: typeof a.title === 'string' && a.title.trim() ? a.title : part.found.item.title, course: part.deck.course ?? part.deck.folder ?? '',
});
const newRequest = ({ a, s }) => ({ ...a, course: resolveCourse(s, a, { preferred: currentCourse(s) }) });

export function requestOf(asked) {
  const { a, s, previous, part, language } = asked;
  const request = previous ? continuedRequest(asked) : part ? partRequest(asked) : newRequest(asked);
  return Object.assign(request, resolveGenerationRequest(s.settings?.generation, { ...request, performance: a.performance },
    { language, continuation: previous?.editorial.generation ?? part?.deck.editorial?.generation }));
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

/** A draft of several kinds goes on with the kinds it still owes, unless a round's sections decide. */
export function applyKindCounts({ previous, extraIds, covering, request }) {
  if (!previous || extraIds || covering || requestKinds(request).length <= 1) return;
  const kindCounts = continuationKindCounts(previous);
  if (kindCounts) request.kindCounts = kindCounts;
}

const FOLLOWED = ['sourceIds', 'language', 'styleText', 'referenceSourceIds', 'referenceLimits', 'referenceFormat'];
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
