// Verbatim copy of lib/jobs/contract.js at v2.7.1 (47f13281): what the previous release accepts. Do not edit; see README.md.
import Schema from 'schemastery';

// Canonical runtime contract schemas and read validation.
export const RUNTIME_CONTRACT_VERSION = 2;
export const STATUSES = Object.freeze(['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'complete', 'failed', 'interrupted']);
export const ACTIONS = Object.freeze(['cancel', 'pause', 'resume', 'retry', 'set']);
export const PAUSE_MODES = Object.freeze(['unsupported', 'queued-only', 'checkpoint']);

const word = () => Schema.string().min(1);
const finite = value => {
  if (!Number.isFinite(value)) throw new TypeError('number must be finite');
  return value;
};
const finiteNumber = inner => Schema.transform(inner, finite, true);
const integer = (minimum = 0) => finiteNumber(Schema.number().min(minimum).step(1));
const oneOf = values => Schema.union(values.map(value => Schema.const(value)));
const status = () => oneOf(STATUSES);
const physicalStatus = () => oneOf(STATUSES.filter(value => value !== 'paused'));
const timestamp = () => Schema.transform(Schema.string(), value => {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError('invalid observed timestamp');
  return value;
}, true);
const jsonData = Schema.lazy(() => Schema.union([
  Schema.string(), finiteNumber(Schema.number()), Schema.boolean(), Schema.const(null), Schema.array(jsonData), Schema.dict(jsonData),
]));
function rejectActiveJsonValues(value, key = '(root)') {
  if (typeof value === 'function') throw new TypeError(`plainData field ${key} cannot contain a function`);
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('plainData must contain plain JSON objects');
  for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw new TypeError(`plainData field ${field} cannot contain an accessor`);
    rejectActiveJsonValues(descriptor.value, field);
  }
}
const plainData = () => Schema.transform(Schema.any(), value => {
  // Check raw data before projection or stringify can rewrite it. Reject carried
  // functions first: stringify invokes toJSON before it invokes its replacer.
  rejectActiveJsonValues(value);
  JSON.stringify(value, function (key, entry) {
    const raw = this[key];
    if (raw === undefined || ['symbol', 'bigint'].includes(typeof raw)) throw new TypeError(`plainData field ${key || '(root)'} must contain JSON values`);
    if (typeof raw === 'number') finite(raw);
    return entry;
  });
  return Schema.dict(jsonData)(value);
}, true);

// Validate the declared shape, then inspect original keys so projection cannot
// hide unknown metadata or missing fields. Public read extensions are preserved.
function record(fields, { closed = false, requiredKeys = [] } = {}) {
  const shape = Schema.object(fields).required();
  return Schema.transform(Schema.any().required(), value => {
    const parsed = shape(value);
    if (closed) for (const key of Object.keys(value)) {
      if (!Object.hasOwn(fields, key)) throw new TypeError(`unknown metadata field: ${key}`);
    }
    for (const key of requiredKeys) if (!Object.hasOwn(value, key) || value[key] === undefined) throw new TypeError(`missing required field: ${key}`);
    return parsed;
  }, true).required();
}

const executor = record({ service: Schema.const('dsh-jobs').required(), handleId: word().required(), ownerAgentId: word().required() }, { closed: true });
export const AttemptSchema = record({
  jobId: word().required(), attemptId: word().required(), definitionVersion: integer(1).required(),
  status: physicalStatus().required(), executor: Schema.union([Schema.const(null), executor]), policySnapshot: plainData().required(),
  startedAt: timestamp(), finishedAt: timestamp(),
  endReason: oneOf(['checkpoint-pause', 'user-cancel', 'superseded', 'executor-lost']), checkpointRef: word(),
}, { closed: true, requiredKeys: ['executor'] });

export const StepSchema = record({
  jobId: word().required(), attemptId: word().required(), stepKey: word().required(), stepRunId: word().required(),
  status: oneOf(['queued', 'running', 'complete', 'failed', 'cancelled', 'interrupted', 'skipped']).required(), checkpointRef: word(),
}, { closed: true });

const observation = record({
  boundary: oneOf(['external-request', 'host-attempt', 'legacy', 'local-wait']).required(), requestCount: integer(),
}, { closed: true, requiredKeys: ['requestCount'] });
export const CallSchema = record({
  callId: word().required(), jobId: word().required(), attemptId: word().required(), stepKey: word().required(), stepRunId: word(),
  kind: word().required(), stage: word(), slot: integer(1), queuedAt: timestamp(), startedAt: timestamp(), firstOutputAt: timestamp(), endedAt: timestamp(),
  status: oneOf(['running', 'ok', 'failed', 'cancelled', 'skipped', 'waiting']).required(), runner: word(), childId: word(), parentId: word(),
  part: integer(1), parts: integer(1), reasoning: word(), tokens: integer(), file: word(), reason: word(), observation,
});

const capabilities = record({
  cancel: Schema.boolean().required(), pauseMode: oneOf(PAUSE_MODES).required(),
  recoveryMode: oneOf(['none', 'retry-from-start', 'resume-checkpoint']).required(), retry: Schema.boolean().required(), set: Schema.boolean().required(),
  executionModes: Schema.array(oneOf(['direct', 'subagent']).required()).required(),
}, { closed: true });
const runtime = record({
  schemaVersion: Schema.const(1).required(), definitionVersion: integer(1).required(), scopeId: word().required(), legacyId: word(),
  activeAttemptId: word(), attempts: Schema.array(AttemptSchema).required(), steps: Schema.array(StepSchema).required(),
}, { closed: true, requiredKeys: ['activeAttemptId'] });
const actionFields = { available: Schema.boolean().required(), reason: Schema.object({ code: word().required() }).default(null) };
const action = record(actionFields);
const actions = record({
  cancel: action, pause: record({ ...actionFields, mode: oneOf(PAUSE_MODES).required(),
    waiting: Schema.object({ reason: word().required(), count: integer().required() }).default(null) }), resume: action, retry: action,
  set: record({ ...actionFields, settings: Schema.array(plainData().required()).default(null) }),
});

export const JobSchema = record({
  contractVersion: Schema.const(RUNTIME_CONTRACT_VERSION).required(), jobId: word().required(), attemptId: word(), kind: word().required(), title: Schema.string(),
  status: status().required(), endReason: oneOf(['user-cancel', 'superseded']), stage: record({ code: word().required(), args: plainData(), text: Schema.string() }),
  progress: record({ done: integer().required(), total: integer(), unit: word(), percent: finiteNumber(Schema.number().min(0).max(100)),
    segments: Schema.array(record({ stage: word().required(), done: integer().required(), total: integer() }, { requiredKeys: ['total'] })).required(),
  }, { requiredKeys: ['total', 'unit', 'percent'] }),
  actions, result: record({ refs: Schema.array(record({ kind: word().required(), id: word().required() })).required(), completeness: oneOf(['complete', 'partial']) }, { requiredKeys: ['completeness'] }),
  error: Schema.union([Schema.const(null), record({ message: Schema.string().required(), code: word() })]),
  usage: record({ tokens: integer(), tokenUsage: plainData(), calls: integer() }, { requiredKeys: ['tokens', 'tokenUsage', 'calls'] }),
  execution: record({ mode: oneOf(['direct', 'subagent', 'mixed']) }, { requiredKeys: ['mode'] }), detail: plainData().required(),
  startedAt: timestamp(), finishedAt: timestamp(), calls: Schema.array(CallSchema).required(), events: Schema.array(plainData().required()).required(), capabilities, runtime,
}, { requiredKeys: ['title', 'error', 'startedAt'] });

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
    reference(!latest || latest.status === job.status || cancelledAfterPause, 'a terminal logical Job must agree with its latest physical Attempt, except cancellation after checkpoint pause');
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
  if (job.capabilities.pauseMode === 'queued-only') capability(!job.actions.pause.available || (job.status === 'queued' && (!latest || latest.status === 'queued')), 'queued-only pause cannot be offered after execution started');
  return job;
}


/** Read an explicitly versioned public contract without promoting legacy data. */
export function readJobContract(value) {
  if (value?.contractVersion === 1) return structuredClone(value);
  if (value?.contractVersion === RUNTIME_CONTRACT_VERSION) return validateRuntimeContract(value);
  throw Object.assign(new TypeError('contractVersion must explicitly be 1 or 2'), { code: 'unsupported-contract-version' });
}
