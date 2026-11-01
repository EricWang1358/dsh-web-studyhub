import { planGeneration } from '../../../batch.js';
import { GENERATION_TIMEOUT_MS } from '../../../generation-limits.js';
import { requestKinds } from '../../../generation-settings.js';
import { levelOf } from '../../../coverage-strength.js';
import { partPlanOf, partPlanText } from '../../../part-plan.js';
import { sectionsOf } from '../../../sections.js';
import { coverCounts, listOf } from '../coverage-runs.js';

/* The card of a new job as the run is about to start: what it is asked and what the console shows until the executor says more. `newId` and `now` are handed in; what
    follows is plain arithmetic over what was prepared. */

/** The sections of the run's sources name what each part of the run is said to cover. A label is a convenience: a source that cannot be divided keeps its title. */
const safeSections = sources => { try { return sectionsOf(sources); } catch { return []; } };
export const partPlanFor = (planned, language, fullSources) => partPlanOf(planned, partPlanText(language), { sections: safeSections(fullSources) });

/** How the request is cut into parts for `sizes`: { sources, count, reuse, assignments }. */
export const partsFor = (request, sizes) => planGeneration({ ...sizes, kind: request.kind, kinds: request.kinds, kindCounts: request.kindCounts, performance: request.performance });

/** What a run that goes on by itself is working towards: the whole plan; every other job asks for the questions of its own round. */
export const planGoalOf = ({ plan, coverageRun, plannedSpec, count }) => plan ? coverageRun?.goal ?? plannedSpec?.goal ?? count : 0;

function requestedTotalOf({ previous, covering, plan, extraIds, count }, planGoal) {
  if (!previous) return plan?.auto ? planGoal : count;
  if (!covering) return previous.editorial.requested + (extraIds ? count : 0);
  const reached = previous.cards.length + count;
  return plan?.auto ? Math.max(planGoal, reached) : reached;
}

/** What the learner chose beyond what the card already carries, so setting the request again from a failed job can put the whole of it back on the form
    (ui/app/retry-generation.js). */
function askedOf({ a, request, wantsCoverage }) {
  const goal = wantsCoverage ? { coverageLevel: levelOf(a.coverageLevel), ...(Number.isInteger(a.count) ? { count: a.count } : {}) } : {};
  const all = { focus: request.focus, difficulty: request.difficulty, language: request.language, notation: request.notation, ...goal };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined));
}

function coveragePlanField({ coverageRun, plan, plannedSpec, runStart }) {
  if (coverageRun) return { coveragePlan: { level: coverageRun.level, goal: coverageRun.goal, round: 1, rounds: coverageRun.rounds, sections: coverageRun.covered,
    weights: 'length' } };
  if (!plan) return {};
  const round = runStart?.index !== undefined ? plannedSpec.rounds[runStart.index].round : plannedSpec.rounds.length;
  return { coveragePlan: { level: plannedSpec.level, goal: plannedSpec.goal, round, rounds: plannedSpec.rounds.length, sections: plannedSpec.mustCover,
    weights: plannedSpec.weightSource } };
}

function coverageRunField({ plan, previous }, now) {
  if (!plan) return {};
  return { coverageRun: { autoComplete: plan.auto, state: 'running', list: plan.spec ? listOf(plan.spec, plan.due) : [], percent: plan.percent,
    ...coverCounts(plan.cover), tokensUsed: plan.tokensBase, tokensBase: plan.tokensBase,
    startedAt: now(), ...(plan.tokenBudget ? { tokenBudget: plan.tokenBudget } : {}), ...(previous ? { draftId: previous.id } : {}) } };
}

/** `askedQuestions`: what this job itself is asked to write (its first round, plus, when it goes on by itself, what the rounds after it still have to make:
    `plan.ahead`; else its one round or request): its own
    progress is counted against it. While it runs the live copy keeps it true (what the rounds it started really make, once their planner has answered). The progress
    card names the requested deck before its first draft is saved (P28). */
function continuedField({ previous, count, plan, extraIds, sources, request }) {
  if (previous) return { draftId: previous.id, deckTitle: previous.title, savedCount: previous.cards.length, savedAtStart: previous.cards.length, continued: true,
    askedQuestions: count + (plan?.ahead || 0),
    ...(extraIds ? { extraSources: sources.length } : {}) };
  return typeof request.title === 'string' && request.title.trim() ? { deckTitle: request.title.trim() } : {};
}

/** A new draft that will be the next part of a deck (lib/deck-parts.js): the console says whose part it is, and a second top-up of the same document waits for it. */
function partField({ part, previousPart }) {
  if (part) return { part: { deckId: part.deck.id, deckTitle: part.deck.title, n: part.n, documentKey: part.documentKey } };
  return previousPart ? { part: previousPart } : {};
}

function sourceIdsOf({ plan, fullSources, sources, reuse }) {
  return [...new Set([...(plan ? fullSources : sources), ...reuse.flatMap(group => group.sources)].map(source => source.id))];
}

const coverageField = ({ round }) => ({ coverage: { sections: round.sections, questions: round.questions, reused: round.reused, left: round.left } });

/** `running` or, behind other jobs of the library, `queued`. */
const statusOf = ahead => ahead ? { status: 'queued', stage: 'Waiting for the previous generation' } : { status: 'running', stage: 'Writing source-grounded questions' };

const targetFields = ({ target, publishTarget }) => ({ ...(target ? { mergeTargetId: target.id } : {}), ...(publishTarget ? { type: 'supplement',
  targetTitle: target.title } : {}) });
const selectionFields = ({ narrowing, request }) => ({ ...(narrowing?.retrieval ? { retrieval: narrowing.retrieval } : {}),
  ...(request.missingSources ? { missingSources: request.missingSources } : {}), ...(request.countRaised ? { countRaised: request.countRaised } : {}) });
const kindFields = request => ({ kind: request.kind || 'quiz', ...(requestKinds(request).length > 1 ? { kinds: requestKinds(request) } : {}) });
/** What each part covers (its source ids and a short range), known from the start so a waiting part can be followed to its material (the console). */
const partsFields = ({ planned, parts, fullSources, covering }, language) => ({ parts, ...(planned ? { partPlan: partPlanFor(planned, language, fullSources) } : {}),
  ...(covering ? coverageField(covering) : {}) });
const workFields = ({ request, count }) => ({ steps: [], concurrency: request.case ? 1 : request.performance.concurrency,
  batchSize: request.case ? count : request.performance.batchSize,
  generationTimeoutSeconds: GENERATION_TIMEOUT_MS / 1000, totalTimeoutSeconds: request.performance.jobTimeoutMinutes * 60, messages: [] });

export function seedJob(prep, { newId, now, language }) {
  const { root, request, count, ahead, planGoal } = prep;
  return {
    id: newId(),
    root,
    ...targetFields(prep),
    ...partField(prep),
    sourceIds: sourceIdsOf(prep),
    ...selectionFields(prep),
    ...statusOf(ahead),
    ...kindFields(request),
    course: request.course,
    asked: askedOf(prep),
    count,
    requestedTotal: requestedTotalOf(prep, planGoal),
    ...coveragePlanField(prep),
    ...coverageRunField(prep, now),
    ...continuedField(prep),
    ...partsFields(prep, language),
    ...workFields(prep),
    startedAt: now(),
    language,
  };
}
