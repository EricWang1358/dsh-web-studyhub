/* The plan of a coverage run, from ONE function (README docs/plans/coverage-generation, phase 3). The creation form's consequence line (「标准：约 N 道题，覆盖 M/K 个部分，分 R 轮」), the estimate under
   it, the job that runs and the spec a draft keeps (`editorial.coverageSpec`) are all made from `coveragePlan`, so the number the learner read before pressing the button is the number the run
   is planned with. Pure, no I/O and no Node modules: lib/coverage-strength.js (what a level means), lib/section-weights.js (how much each section matters) and lib/assigned-plan.js (how a planning
   call is bound to what it is assigned) are the parts; this file only puts them together and says what is kept.

   coveragePlan({ leaves, weights, level, goalCount }) -> { plan, assignments, rounds }
     plan: lib/coverage-strength.js strengthPlan; assignments: one per planning call's worth of a section (a stub's range widened, a long section cut into slots); rounds: the assignments grouped into
     rounds of at most 30 questions, heaviest first. Phase 3b runs the rounds; a run of phase 3a makes the first and keeps all of them.
   coverageSpec({ plan, rounds, weights, weightSource, weightReason, custom }) -> the record a draft keeps, bounded (SPEC_LIMITS):
     { version: 1, level, goal, leaves, mustCover, custom?, weightSource, weightReason?, weights: [{ sectionId, importance, kind, reason, source }], quotas: [{ sectionId, quota, reason }],
       rounds: [{ round, questions, sectionIds }], dropped?, capped?, truncated? }
   `sectionId` is the section key of lib/coverage.js (`sourceId#id`). `reason` of a weight is the model's one line; `reason` of a quota is why the section got that many (lib/coverage-strength.js). */
import { strengthPlan, assignmentsOf, roundsOf, isLevel } from './coverage-strength.js';
import { ROUND_LIMIT } from './coverage-round.js';

/** Whether a `generate` request asks for a coverage plan: a coverage level, or a total above one round (an older caller that sends only a count up to ROUND_LIMIT is planned as it always was). */
export const coverageRequested = (args) => isLevel(args?.coverageLevel) || (Number.isInteger(args?.count) && args.count > ROUND_LIMIT);

/**
 * Token cost: whether a coverage run asks the light model how much each section matters (lib/section-weights.js, one call per ~20 sections of the WHOLE material).
 * The importance only decides which sections get the questions, so it pays when the run spreads many questions over the sections (a level, or a large custom total).
 * A SMALL custom total (`goalCount` at most SMALL_TARGET_QUESTIONS, or fewer than a quarter of the sections) goes to the longest sections whatever the ratings say, so the
 * run weighs the sections by length instead (the fallback a run without a light model uses) and the draft says why (`weightReason: 'small-target'`). A level, which has no
 * `goalCount`, is always weighed. The job and the estimate both ask this one function, so what the form prices is what runs.
 */
export const SMALL_TARGET_QUESTIONS = 10;
export const weighsSections = ({ goalCount, sections = 0 } = {}) => !Number.isInteger(goalCount) || sections < 1 || !(goalCount <= SMALL_TARGET_QUESTIONS || goalCount * 4 < sections);

/** The most rows of weights and of quotas a draft keeps (a longer material keeps the first of them and says `truncated`). */
export const SPEC_LIMITS = Object.freeze({ rows: 600, reason: 120 });

/** The plan of `leaves` (the leaf sections in reading order, each with its `key`) at `level`; `goalCount` is a custom total; `limit` the most questions of a round (30; a test makes it smaller). */
export function coveragePlan({ leaves, weights, level, goalCount, limit = ROUND_LIMIT } = {}) {
  const plan = strengthPlan(leaves, weights, level, { goalCount }), assignments = assignmentsOf(plan, leaves, weights);
  return { plan, assignments, rounds: roundsOf(assignments, { limit }) };
}

const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };

/** What a draft keeps of its plan. */
export function coverageSpec({ plan, rounds, weights, weightSource = 'length', weightReason, custom = false }) {
  const rows = SPEC_LIMITS.rows, kept = new Set(plan.quotas.map((item) => item.sectionId));
  // The weights of the sections that have a quota come first (they explain the quotas); the rest follow while there is room.
  const ordered = [...(weights || []).filter((item) => kept.has(item.sectionId)), ...(weights || []).filter((item) => !kept.has(item.sectionId))];
  const rounded = rounds.map((round) => ({ round: round.round, questions: round.questions, sectionIds: [...new Set(round.assignments.map((item) => item.sectionId))] }));
  const truncated = ordered.length > rows || plan.quotas.length > rows;
  return { version: 1, level: plan.level, goal: plan.goal, leaves: plan.leaves, mustCover: plan.mustCover, ...(custom ? { custom: true } : {}), weightSource, ...(weightReason ? { weightReason } : {}),
    weights: ordered.slice(0, rows).map((item) => ({ sectionId: item.sectionId, importance: item.importance, kind: item.kind, reason: clip(item.reason, SPEC_LIMITS.reason), source: item.source })),
    quotas: plan.quotas.slice(0, rows).map((item) => ({ sectionId: item.sectionId, quota: item.quota, reason: item.reason })),
    rounds: rounded,
    ...(plan.dropped.length ? { dropped: plan.dropped.length } : {}), ...(plan.capped.length ? { capped: plan.capped } : {}), ...(truncated ? { truncated: true } : {}) };
}

/** The notes a spec holds, by section key: Map(sectionId -> { importance, kind, reason, source, quota, why }); `why` is the quota's reason, `quota` how many questions the plan gave it. */
export function specNotes(spec) {
  const notes = new Map();
  for (const item of Array.isArray(spec?.weights) ? spec.weights : []) notes.set(item.sectionId, { importance: item.importance, kind: item.kind, reason: item.reason, source: item.source });
  for (const item of Array.isArray(spec?.quotas) ? spec.quotas : []) notes.set(item.sectionId, { ...(notes.get(item.sectionId) || {}), quota: item.quota, why: item.reason });
  return notes;
}
