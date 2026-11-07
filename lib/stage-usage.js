import { stageArgsOf, stageCodeForText } from './contexts/jobs/contracts.js';
import { totalTokens } from './token-usage.js';

/* What a generation job's steps used, per stage: the same grouping for the calibration of the estimate (lib/estimate-calibration.js) and for the
   generation details. Pure (the interface imports it too). */

/** The estimate stages, in the order a part runs them. */
export const USAGE_STAGES = Object.freeze(['plan', 'blueprint', 'author', 'review', 'repair']);
const STAGE_BY_CODE = { planning: 'plan', blueprinting: 'blueprint', authoring: 'author', reviewing: 'review', repairing: 'repair' };

/** What one call of each stage wrote on the owner's finished run of a thinking model (deepseek-v4.1-flash, a 513-page book, 2026-11-06; #771 table): the p90
    output per call, the reasoning a provider reports inside `output` included (p50: plan 506, blueprint 9,361, author 8,712, review 11,991). It is an
    ASSUMPTION for a stage this machine has neither a ratio nor a measurement for, and only ever its high end (the estimate has no point to put the p50 on;
    its low end stays the sample estimate): a model that does not think writes far less and still falls inside the range. The estimate has no repair stage,
    so none is assumed. A stage this machine has measured uses its own figure instead (lib/token-estimate.js withThinking). */
export const DEFAULT_OUTPUT_PER_CALL = Object.freeze({ plan: 10_632, blueprint: 13_610, author: 13_531, review: 24_253 });

/** The stage a recorded step belongs to ('author' also covers replacement questions), or undefined. */
export const stageOfStep = (step) => STAGE_BY_CODE[stageCodeForText(step?.stage)];

/** Whether a step is the section-weighing helper on the host's light lane (never run on the task's writing model). */
export const isLightStageStep = (step) => step?.light === true || step?.unit === 'weights' || stageArgsOf(step?.stage)?.stage === 'weighing';

/** Record the model a non-light pipeline step dispatched on (`'provider/model'` or `null` when unkeyed) without changing the step's public JSON keys. */
export function stampStepModel(step, model) {
  if (step && model !== undefined) Object.defineProperty(step, 'model', { value: model, enumerable: false, configurable: true, writable: true });
  return step;
}

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
