import { jobContract } from '../../../job-contract.js';
import { addUsage } from '../../../token-usage.js';

/** Card fields the existing readers (the task console, tools, the delete/replace guards) keep reading from a generation job.
 * `messages` and `continuedBy` are not here: other operations write them onto the record, and a read-only field would refuse that. */
export const GENERATION_FIELDS = Object.freeze(['mergeTargetId', 'targetTitle', 'part', 'sourceIds', 'retrieval', 'kind', 'course', 'count', 'requestedTotal',
  'coveragePlan', 'coverageRun', 'draftId', 'deckId', 'deckTitle', 'savedCount', 'continued', 'extraSources', 'parts', 'partPlan', 'coverage', 'steps',
  'concurrency', 'batchSize', 'generationTimeoutSeconds', 'totalTimeoutSeconds', 'language', 'estimate', 'tokenUsage', 'publication', 'partReport',
  'fills', 'throttle', 'retryable', 'graded', 'control', 'paused', 'pausedAt', 'errorCode']);

const plain = value => JSON.parse(JSON.stringify(value ?? null));
const STEP_STATUS = { ok: 'complete' };

/** One recorded call of the runtime in the step shape the card and the usage summaries have always read. */
export function stepOfCall(call) {
  const step = { id: call.callId, kind: call.kind, stage: call.stage, part: call.part, round: call.round, retry: call.retry, slot: call.slot,
    queuedMs: call.queuedMs, status: STEP_STATUS[call.status] || call.status, startedAt: call.startedAt, finishedAt: call.endedAt,
    runtime: call.runner, childId: call.childId, parentId: call.parentId, reasoningEffort: call.appliedEffort ?? call.selectedEffort,
    reasoningReason: call.fallbackReason, tokenUsage: call.tokenUsage && { ...call.tokenUsage, calls: 1 }, firstOutputAt: call.firstOutputAt, ...(call.status === 'failed' ? { error: call.reason } : {}) };
  return Object.fromEntries(Object.entries(step).filter(([, value]) => value !== undefined && value !== null));
}

const usageOf = calls => calls.filter(call => call.tokenUsage).reduce((sum, call) => addUsage(sum, { ...call.tokenUsage, calls: 1 }), undefined);

/** What the card shows is what the runtime recorded: its identity, lifecycle and calls replace the executor's own bookkeeping of them. */
function adopt(view, observed) {
  view.id = observed.legacyId;
  // The executor reports how its work ended; the runtime decides when a job is queued, being stopped or over.
  if (observed.status !== 'running' || view.status === 'queued') view.status = observed.status === 'interrupted' ? 'failed' : observed.status;
  if (observed.startedAt) view.startedAt = observed.startedAt;
  if (observed.finishedAt) view.finishedAt = observed.finishedAt;
  view.steps = observed.calls.map(stepOfCall);
  const tokenUsage = usageOf(observed.calls);
  if (tokenUsage) view.tokenUsage = tokenUsage;
}

/** Presentation reader for the kernel: observed lifecycle and calls + the executor's working card → the public view. */
export function presentGeneration(view) {
  return observed => {
    adopt(view, observed);
    const projected = jobContract(view);
    return { ...(projected.title ? { title: projected.title } : {}), stage: plain(projected.stage), progress: plain(projected.progress),
      detail: plain(projected.detail), events: plain(projected.events),
      legacy: Object.fromEntries(GENERATION_FIELDS.filter(key => view[key] !== undefined).map(key => [key, plain(view[key])])) };
  };
}
