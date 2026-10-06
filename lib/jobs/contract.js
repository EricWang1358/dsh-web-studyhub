import { ACTIONS, JobSchema, RUNTIME_CONTRACT_VERSION, rejectActiveJsonValues } from './contract-schema.js';

// Runtime contract read validation: shape (contract-schema.js) plus cross-field invariants.
export { ACTIONS, AttemptSchema, CallSchema, JobSchema, PAUSE_MODES, RUNTIME_CONTRACT_VERSION, STATUSES, StepSchema } from './contract-schema.js';

export function validateRuntimeContract(value) {
  const check = (condition, code, message) => {
    if (!condition) throw Object.assign(new TypeError(message), { code });
  };
  check(value?.contractVersion === RUNTIME_CONTRACT_VERSION, 'unsupported-contract-version', 'contractVersion must explicitly be 2; v1 records are not promoted');
  if (value?.runtime && typeof value.runtime === 'object') {
    check(value.runtime.schemaVersion === 1, 'unsupported-runtime-schema-version', 'runtime.schemaVersion must explicitly be 1');
  }
  let job;
  try { rejectActiveJsonValues(value); job = JobSchema(structuredClone(value)); }
  catch (error) { throw Object.assign(new TypeError(error.message), { code: 'invalid-contract-shape' }); }
  const reference = (condition, message) => check(condition, 'invalid-contract-reference', message);
  const { attempts, steps, activeAttemptId } = job.runtime;
  const unique = (records, key) => {
    const seen = new Set();
    for (const entry of records) {
      reference(!seen.has(entry[key]), `duplicate ${key}: ${entry[key]}`);
      seen.add(entry[key]);
    }
  };
  unique(attempts, 'attemptId'); unique(steps, 'stepRunId'); unique(job.calls, 'callId');
  for (const entry of attempts) {
    reference(entry.jobId === job.jobId, `Attempt ${entry.attemptId} belongs to another Job`);
    if (entry.endReason === 'checkpoint-pause') {
      reference(entry.status === 'complete' && !!entry.checkpointRef, 'checkpoint-pause requires a completed physical Attempt with a checkpoint reference');
    }
    if (entry.endReason === 'executor-lost') reference(entry.status === 'interrupted', 'executor-lost requires an interrupted physical Attempt');
  }
  const latest = attempts.at(-1);
  reference(latest ? job.attemptId === latest.attemptId : job.attemptId == null, 'root attemptId must select the latest physical Attempt, or be absent before admission');
  if (latest) reference(latest.definitionVersion === job.runtime.definitionVersion, 'latest physical Attempt must match the current admitted definitionVersion');
  const active = attempts.filter(entry => ['queued', 'running', 'pausing', 'cancelling'].includes(entry.status));
  reference(active.length <= 1, 'multiple active physical Attempts belong to one Job');
  reference(active.length ? active[0].attemptId === activeAttemptId : activeAttemptId === null, 'activeAttemptId must select the sole active physical Attempt or be null');
  reference(!active.length || activeAttemptId === job.attemptId, 'active physical Attempt must be the latest physical Attempt');
  if (job.status === 'running') reference(activeAttemptId !== null, 'a running logical Job requires an active physical Attempt');
  if (job.status === 'queued' && active.length) reference(active[0].status === 'queued', 'a queued logical Job cannot have a physical Attempt already executing');
  if (job.status === 'paused') reference(activeAttemptId === null, 'a paused logical Job has no active physical Attempt');
  if (['complete', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
    reference(activeAttemptId === null, 'a terminal logical Job has no active physical Attempt');
    reference(job.status !== 'complete' || latest?.endReason !== 'checkpoint-pause', 'checkpoint pause cannot complete the logical Job');
    const cancelledAfterPause = job.status === 'cancelled' && latest?.status === 'complete' && latest.endReason === 'checkpoint-pause';
    reference(!latest || latest.status === job.status || cancelledAfterPause,
      'a terminal logical Job must agree with its latest physical Attempt, except cancellation after checkpoint pause');
  }
  if (job.status === 'paused' && job.capabilities.pauseMode === 'checkpoint') {
    reference(!!latest && latest.status === 'complete' && latest.endReason === 'checkpoint-pause' && !!latest.checkpointRef,
      'checkpoint-paused logical Job requires its latest physical Attempt to complete at a referenced checkpoint');
  }
  for (const entry of steps) {
    reference(entry.jobId === job.jobId, `Step ${entry.stepRunId} belongs to another Job`);
    reference(attempts.some(attempt => attempt.attemptId === entry.attemptId), `Step ${entry.stepRunId} refers to an unknown Attempt`);
  }
  for (const call of job.calls) {
    reference(call.jobId === job.jobId, `Call ${call.callId} belongs to another Job`);
    reference(attempts.some(attempt => attempt.attemptId === call.attemptId), `Call ${call.callId} refers to an unknown Attempt`);
    if (call.stepRunId != null) reference(steps.some(step => step.stepRunId === call.stepRunId && step.attemptId === call.attemptId && step.stepKey === call.stepKey),
      `Call ${call.callId} refers to an inconsistent physical Step run`);
    const { boundary, requestCount } = call.observation;
    const expected = boundary === 'external-request' ? 1 : boundary === 'local-wait' ? 0 : null;
    check(requestCount === expected && (boundary !== 'local-wait' || call.kind === 'wait') && (boundary !== 'external-request' || call.kind !== 'wait'),
      'invalid-call-observation', `Call ${call.callId}: ${boundary} requires observed requestCount ${expected}`);
  }
  const capability = (condition, message) => check(condition, 'inconsistent-capability', message);
  for (const name of ACTIONS) {
    capability(job.actions[name].available || !!job.actions[name].reason?.code, `${name}: an unavailable action requires a reason code`);
    if (['cancel', 'retry', 'set'].includes(name)) capability(!job.actions[name].available || job.capabilities[name], `${name}: capability is unsupported`);
  }
  capability(job.actions.pause.mode === job.capabilities.pauseMode, 'actions.pause.mode disagrees with capabilities.pauseMode');
  if (job.capabilities.pauseMode === 'unsupported') capability(!job.actions.pause.available && !job.actions.resume.available && !['pausing', 'paused'].includes(job.status),
    'pause/resume or paused state cannot be advertised when pause is unsupported');
  if (job.capabilities.pauseMode === 'queued-only') {
    capability(!job.actions.pause.available || (job.status === 'queued' && (!latest || latest.status === 'queued')),
      'queued-only pause cannot be offered after execution started');
  }
  return job;
}

/** Read an explicitly versioned public contract without promoting legacy data. */
export function readJobContract(value) {
  if (value?.contractVersion === 1) return structuredClone(value);
  if (value?.contractVersion === RUNTIME_CONTRACT_VERSION) return validateRuntimeContract(value);
  throw Object.assign(new TypeError('contractVersion must explicitly be 1 or 2'), { code: 'unsupported-contract-version' });
}
