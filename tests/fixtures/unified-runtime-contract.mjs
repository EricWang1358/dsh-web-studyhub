// Synthetic premises only; all validation uses the canonical production schemas.
export { RUNTIME_CONTRACT_VERSION as PROPOSED_CONTRACT_VERSION, JobSchema, AttemptSchema, StepSchema, CallSchema, validateRuntimeContract } from '../../lib/jobs/contract.js';

// All identities, admission, loss, timestamps and checkpoint evidence below are
// explicit synthetic premises. These records do not run or migrate a producer.
const unsupported = { available: false, reason: { code: 'capability-unsupported' } };
const base = {
  contractVersion: 2, jobId: 'synthetic-job', kind: 'audio-import', title: 'Synthetic contract case', status: 'queued',
  stage: { code: 'audio.queued' }, progress: { done: 0, total: null, unit: 'files', percent: null, segments: [] },
  actions: { cancel: { available: true }, pause: { available: true, mode: 'checkpoint' }, resume: { available: false, reason: { code: 'not-paused' } },
    retry: { available: false, reason: { code: 'not-ended' } }, set: unsupported },
  result: { refs: [], completeness: null }, error: null, usage: { tokens: null, tokenUsage: null, calls: null }, execution: { mode: null }, detail: {}, startedAt: null, calls: [], events: [],
  capabilities: { cancel: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', retry: true, set: false, executionModes: ['direct'] },
  runtime: { schemaVersion: 1, definitionVersion: 1, scopeId: 'synthetic-scope', activeAttemptId: null, attempts: [], steps: [] },
};
const attempt = { jobId: base.jobId, attemptId: 'physical-1', definitionVersion: 1, status: 'running', executor: null, policySnapshot: {} };
const step = { jobId: base.jobId, attemptId: attempt.attemptId, stepKey: 'proofread:1', stepRunId: 'step-run-1', status: 'running' };
const running = {
  ...base, attemptId: attempt.attemptId, status: 'running', stage: { code: 'audio.proofread' },
  runtime: { ...base.runtime, legacyId: 'legacy-facade-1', activeAttemptId: attempt.attemptId, attempts: [attempt], steps: [step] },
  calls: [{ callId: 'observed-host-attempt-1', jobId: base.jobId, attemptId: attempt.attemptId, stepKey: step.stepKey, stepRunId: step.stepRunId,
    kind: 'proofread', status: 'running', runner: 'direct', tokens: null, startedAt: null, endedAt: null, observation: { boundary: 'host-attempt', requestCount: null } }],
};
const paused = {
  ...base, attemptId: attempt.attemptId, status: 'paused', stage: { code: 'audio.paused' },
  actions: { ...base.actions, pause: { available: false, mode: 'checkpoint', reason: { code: 'already-paused' } }, resume: { available: true } },
  runtime: { ...base.runtime, legacyId: 'legacy-facade-1', activeAttemptId: null,
    attempts: [{ ...attempt, status: 'complete', endReason: 'checkpoint-pause', checkpointRef: 'synthetic-checkpoint-1' }],
    steps: [{ ...step, status: 'complete', checkpointRef: 'synthetic-step-checkpoint-1' }] },
};
const retry = {
  ...running, attemptId: 'physical-2', runtime: { ...running.runtime, legacyId: 'legacy-facade-2', activeAttemptId: 'physical-2',
    attempts: [{ ...attempt, status: 'failed' }, { ...attempt, attemptId: 'physical-2' }],
    steps: [{ ...step, status: 'failed' }, { ...step, attemptId: 'physical-2', stepRunId: 'step-run-2' }] },
  calls: [
    { ...running.calls[0], status: 'failed', callId: 'observed-wire-request-1', observation: { boundary: 'external-request', requestCount: 1 } },
    { ...running.calls[0], callId: 'observed-host-attempt-2', attemptId: 'physical-2', stepRunId: 'step-run-2' },
  ],
};
export const goldenRuntimeContracts = { queued: base, running, paused, retry };
