import { stageCodeForText } from './contexts/jobs/contracts.js';
import { totalTokens } from './token-usage.js';

/* What a generation job's steps used, per stage: the same grouping for the calibration of the estimate (lib/estimate-calibration.js) and for the
   generation details. Pure (the interface imports it too). */

/** The estimate stages, in the order a part runs them. */
export const USAGE_STAGES = Object.freeze(['plan', 'blueprint', 'author', 'review', 'repair']);
const STAGE_BY_CODE = { planning: 'plan', blueprinting: 'blueprint', authoring: 'author', reviewing: 'review', repairing: 'repair' };

/** What one call of each stage wrote on the owner's finished run of a thinking model (deepseek-v4.1-flash, a 513-page book, 2026-11-06; #771): the mean output
    per call, the reasoning a provider reports inside `output` included. It is an ASSUMPTION for a machine that has measured nothing yet, and only ever the high end
    of a stage: a model that does not think writes far less and still falls inside the range. Plan is bimodal (median 506, p90 10.6k), so its mean is a top, not a
    typical call. A stage this machine has measured uses its own figure instead. */
export const DEFAULT_OUTPUT_PER_CALL = Object.freeze({ plan: 3568, blueprint: 9437, author: 8662, review: 12973, repair: 2288 });

/** The stage a recorded step belongs to ('author' also covers replacement questions), or undefined. */
export const stageOfStep = (step) => STAGE_BY_CODE[stageCodeForText(step?.stage)];

/** Per stage: tokens used, model calls, the seconds the model calls took and the seconds they waited for a free slot, from the job's steps. A step that cannot be assigned to a stage is not counted. */
export function stageUsage(job) {
  const rows = {};
  for (const step of job?.steps || []) {
    const stage = stageOfStep(step);
    if (!stage) continue;
    const row = rows[stage] ||= { tokens: 0, calls: 0, steps: 0, seconds: 0, waited: 0 };
    row.steps += 1;
    if (step.tokenUsage) { row.tokens += totalTokens(step.tokenUsage); row.calls += step.tokenUsage.calls || 0; }
    if (Number.isFinite(step.queuedMs)) row.waited += step.queuedMs / 1000;
    if (step.startedAt && step.finishedAt) row.seconds += Math.max(0, (Date.parse(step.finishedAt) - Date.parse(step.startedAt)) / 1000);
  }
  return rows;
}

/** Tokens a job used per stage (only stages that used some). */
export const observedByStage = (job) => Object.fromEntries(Object.entries(stageUsage(job)).filter(([, row]) => row.tokens > 0).map(([stage, row]) => [stage, row.tokens]));

/** What each stage WROTE per call (#771): the output a provider reports, the model's thinking included, beside the calls it came from. The estimate
    sizes output from sample cards, and a thinking model writes several times what they say; this is the measurement that lets it say so. */
export function outputByStage(job) {
  const rows = {};
  for (const step of job?.steps || []) {
    const stage = stageOfStep(step);
    const usage = step.tokenUsage;
    if (!stage || !usage) continue;
    const row = rows[stage] ||= { calls: 0, output: 0 };
    row.calls += Number(usage.calls) || 1;
    row.output += Number(usage.outputTokens) || 0;
  }
  return Object.fromEntries(Object.entries(rows).filter(([, row]) => row.calls > 0 && row.output > 0));
}
