import { stageCodeForText } from './contexts/jobs/contracts.js';
import { totalTokens } from './token-usage.js';

/* What a generation job's steps used, per stage: the same grouping for the calibration of the estimate (lib/estimate-calibration.js) and for the
   generation details. Pure (the interface imports it too). */

/** The estimate stages, in the order a part runs them. */
export const USAGE_STAGES = Object.freeze(['plan', 'blueprint', 'author', 'review', 'repair']);
const STAGE_BY_CODE = { planning: 'plan', blueprinting: 'blueprint', authoring: 'author', reviewing: 'review', repairing: 'repair' };

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
