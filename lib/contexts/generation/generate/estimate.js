import { boundedGuidance } from '../../../case-study.js';
import { calibrateEstimate, compactEstimate, createTextMeasure, estimateFromState, estimateRun } from '../../../token-estimate.js';
import { calibrationFor } from '../../../estimate-calibration.js';
import { get } from '../../../util.js';
import { NOT_FOUND_LABEL } from './messages.js';

/* What a run is expected to use, kept to set beside what it did use (WP27); never a reason to refuse or fail. */

const objectivesOf = decks => decks.flatMap(deck => (deck?.cards || []).map(card => card.objective));

/** The objectives a generation is told not to repeat. Adding to a deck (or continuing a draft) names that deck and draft alone; a new draft is told about the whole
    library, which lib/batch.js narrows to what its materials could repeat. */
export function existingFor(state, target, draft) {
  const own = objectivesOf([...(target ? [get(state.decks, target.id, NOT_FOUND_LABEL.target)] : []), ...(draft ? [get(state.drafts, draft.id, NOT_FOUND_LABEL.draft)] : [])]);
  return target ? { existing: own, pinnedExisting: own } : { existing: objectivesOf([...state.decks, ...state.drafts]), pinnedExisting: own };
}

function rawEstimate({ s, request, sources, planCount, assignments, plannedSpec, reuse, covering, target, previous }, measure) {
  if (request.case) return estimateRun('case', { language: request.language, ...request.case, sources, questionReferences: request.questionReferences,
    referenceFormat: request.referenceFormat,
    guidance: boundedGuidance(s.sources.filter(source => request.case.guidanceSourceIds.includes(source.id))) }, { measure });
  return estimateRun('generate', { sources, count: planCount, assignments, planned: !!plannedSpec?.rounds?.length, reuse, coverageSections: covering?.request.titles,
    kind: request.kind, kinds: request.kinds, kindCounts: request.kindCounts,
    difficulty: request.difficulty, language: request.language, questionReferences: request.questionReferences, referenceFormat: request.referenceFormat,
      focus: request.focus, role: request.role, constraints: request.constraints,
    course: request.course, title: request.title, performance: request.performance, ...existingFor(s, target, previous) }, { measure });
}

/** The estimator's number for what the run still has to do (the console says it, labelled as expected, until the rounds done give a better one): a new run is priced
    like the form priced it, whole. */
function planEstimate({ a, s, sources, count, plan, wantsCoverage, roundLimit }, job, factors, { tokenMeter, language }) {
  if (wantsCoverage) {
    const whole = estimateFromState('generate', { sourceIds: sources.map(source => source.id), coverageLevel: a.coverageLevel,
      ...(Number.isInteger(a.count) ? { count: a.count } : {}), kind: a.kind, kinds: a.kinds, language: a.language, performance: a.performance },
      s, { tokenMeter, language, roundLimit });
    return whole.totalTokens?.high > 0 ? { tokens: calibrateEstimate(whole, factors).totalTokens } : null;
  }
  if (!(job.estimate.totalTokens?.high > 0 && count > 0)) return null;
  const scale = (count + plan.ahead) / count;
  return { tokens: { low: Math.round(job.estimate.totalTokens.low * scale), high: Math.round(job.estimate.totalTokens.high * scale) } };
}

export async function estimateInto(job, prep, host) {
  try {
    const raw = rawEstimate(prep, createTextMeasure({ tokenMeter: host.tokenMeter }));
    // This library's own earlier runs correct the range (lib/estimate-calibration.js); the job keeps the uncalibrated stage totals the next ratio is read against.
    const factors = await calibrationFor(prep.root).factors().catch(() => null);
    job.estimate = compactEstimate(calibrateEstimate(raw, factors), raw);
    if (!prep.plan) return;
    const priced = planEstimate(prep, job, factors, host);
    if (priced) prep.plan.estimate = priced;
    if (prep.plan.estimate) job.coverageRun.estimate = prep.plan.estimate;
  } catch { /* an estimate is a convenience */ }
}
