import { buildEffectivePreview } from '../../../generation-modules.js';
import { partsFor, planGoalOf } from './job-seed.js';
import { applyNotation, applyReferences, checkSelectionSize, checkSourcesLeft, countOf, raisedCount, selectedSources } from './materials.js';
import { argsJudged, requestSettled, roundSettled } from './operation.js';
import { newCoverageRun, planOf } from './plan-seed.js';

/** Zero-call pre-run effective requirements & stage rules preview (#852): resolves defaults, course inheritance,
    quotas, and references without model calls, retrieval calls, or job creation. */
export async function previewGeneration(host, a = {}) {
  const prep = await argsJudged({ ...host, activeJob: () => false }, a, Boolean(a?.publishTarget), () => false, undefined);
  requestSettled(prep);
  await roundSettled(prep);
  prep.count = countOf(prep);
  applyReferences(prep);
  prep.sources = selectedSources(prep);
  prep.count = raisedCount(prep);
  checkSourcesLeft(prep);
  prep.fullSources = prep.sources;
  if (prep.covering) prep.sources = prep.covering.request.sources;
  prep.reuse = prep.covering?.request.reuse || [];
  prep.planCount = prep.covering ? prep.covering.request.count : prep.count;
  prep.coverageRun = null;
  prep.assignments = prep.covering ? prep.covering.request.assignments : undefined;
  if (prep.wantsCoverage) {
    Object.assign(prep, newCoverageRun(prep));
    prep.planCount = prep.count;
  }
  applyNotation(prep.request, prep.sources);
  checkSelectionSize(prep);
  prep.plan = planOf(prep);
  prep.planned = prep.request.case ? null : partsFor(prep.request, {
    sources: prep.sources,
    count: prep.planCount,
    reuse: prep.reuse,
    assignments: prep.assignments,
  });
  prep.planGoal = planGoalOf(prep);
  return buildEffectivePreview({
    a,
    s: prep.s,
    request: prep.request,
    sources: prep.sources,
    count: prep.planCount,
    planGoal: prep.planGoal,
    planned: prep.planned,
    wantsCoverage: prep.wantsCoverage,
    language: prep.request.language || host.language,
  });
}
