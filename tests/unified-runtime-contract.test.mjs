import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Schema from 'schemastery';
import { CONTRACT_VERSION, STATUSES, jobContract } from '../lib/job-contract.js';
import { archiveRecordOf } from '../lib/job-archive.js';
import {
  PROPOSED_CONTRACT_VERSION, JobSchema, AttemptSchema, StepSchema, CallSchema, validateRuntimeContract, goldenRuntimeContracts,
} from './fixtures/unified-runtime-contract.mjs';

const copy = name => structuredClone(goldenRuntimeContracts[name]);
const without = (input, path) => {
  const value = structuredClone(input), keys = path.split('.'), last = keys.pop();
  delete keys.reduce((part, key) => part[key], value)[last];
  return value;
};
const reject = (name, change, code) => {
  const value = copy(name);
  change(value);
  assert.throws(() => validateRuntimeContract(value), { code });
};

test('v2 review fixtures retain the nine-state vocabulary while production still publishes v1', () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.equal(PROPOSED_CONTRACT_VERSION, 2);
  assert.deepEqual(STATUSES, ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'complete', 'failed', 'interrupted']);
  for (const [name, fixture] of Object.entries(goldenRuntimeContracts)) {
    const value = structuredClone(fixture), before = structuredClone(value);
    assert.deepEqual(validateRuntimeContract(value), before, name);
    assert.deepEqual(value, before, `${name}: validation does not manufacture data`);
  }
});

test('schemastery requires the published read fields and physical identity metadata', () => {
  const value = copy('running');
  for (const field of ['contractVersion', 'jobId', 'kind', 'title', 'status', 'stage', 'progress', 'actions', 'result', 'error', 'usage', 'execution',
    'detail', 'startedAt', 'calls', 'events', 'capabilities', 'runtime', 'progress.total', 'progress.percent', 'usage.tokens', 'usage.tokenUsage', 'usage.calls',
    'runtime.activeAttemptId', 'runtime.scopeId', 'runtime.definitionVersion', 'runtime.schemaVersion']) {
    assert.throws(() => JobSchema(without(value, field)), /required/, field);
  }
  for (const field of ['jobId', 'attemptId', 'definitionVersion', 'status', 'executor', 'policySnapshot']) {
    assert.throws(() => AttemptSchema(without(value.runtime.attempts[0], field)), /required/, `Attempt.${field}`);
  }
  for (const field of ['jobId', 'attemptId', 'stepKey', 'stepRunId', 'status']) {
    assert.throws(() => StepSchema(without(value.runtime.steps[0], field)), /required/, `Step.${field}`);
  }
  for (const field of ['callId', 'jobId', 'attemptId', 'stepKey', 'kind', 'status', 'observation', 'observation.requestCount']) {
    assert.throws(() => CallSchema(without(value.calls[0], field)), /required/, `Call.${field}`);
  }
});

test('versions are explicit and old or unknown contract versions are not promoted implicitly', () => {
  for (const version of [0, 1, 3, '2', null]) {
    reject('queued', value => { value.contractVersion = version; }, 'unsupported-contract-version');
  }
  for (const version of [0, 2, '1', null]) {
    const value = copy('queued'); value.runtime.schemaVersion = version;
    assert.throws(() => validateRuntimeContract(value), { code: 'unsupported-runtime-schema-version' });
  }
  for (const version of [0, -1, 1.5, '1']) {
    const value = copy('running'); value.runtime.attempts[0].definitionVersion = version;
    assert.throws(() => validateRuntimeContract(value), /definitionVersion/);
  }
});

test('public read extensions survive; introduced metadata rejects unknown fields instead of silently stripping them', () => {
  const value = copy('running');
  value.futureReadField = { observed: 'kept' };
  value.progress.futureProgressField = 'kept'; value.calls[0].futureCallField = 'kept';
  assert.deepEqual(validateRuntimeContract(value).futureReadField, { observed: 'kept' });
  assert.equal(validateRuntimeContract(value).progress.futureProgressField, 'kept');
  assert.equal(validateRuntimeContract(value).calls[0].futureCallField, 'kept');
  for (const path of ['capabilities', 'runtime', 'runtime.attempts.0', 'runtime.steps.0', 'calls.0.observation']) {
    const extra = copy('running'); path.split('.').reduce((part, key) => part[key], extra).typo = true;
    assert.throws(() => validateRuntimeContract(extra), /unknown metadata field: typo/, path);
  }
  const handle = copy('running');
  handle.runtime.attempts[0].executor = { service: 'dsh-jobs', handleId: 'synthetic-handle', ownerAgentId: 'synthetic-live-agent', typo: true };
  assert.throws(() => validateRuntimeContract(handle), /executor/);
});

test('missing observations stay null or absent, including unknown host-internal request counts', () => {
  const result = validateRuntimeContract(copy('running'));
  assert.equal(result.progress.total, null); assert.equal(result.progress.percent, null);
  assert.deepEqual(result.usage, { tokens: null, tokenUsage: null, calls: null });
  assert.equal(result.startedAt, null); assert.equal(result.runtime.attempts[0].executor, null);
  assert.equal(Object.hasOwn(result, 'finishedAt'), false);
  for (const key of ['startedAt', 'finishedAt']) assert.equal(Object.hasOwn(result.runtime.attempts[0], key), false);
  for (const key of ['queuedAt', 'firstOutputAt', 'tokenUsage']) assert.equal(Object.hasOwn(result.calls[0], key), false);
  assert.equal(result.calls[0].observation.requestCount, null);
  const wait = { ...result.calls[0], callId: 'local-wait-1', kind: 'wait', status: 'waiting', reason: 'rate-limit', observation: { boundary: 'local-wait', requestCount: 0 } };
  result.calls = [wait]; assert.deepEqual(validateRuntimeContract(result).calls[0].observation, wait.observation);
  for (const [boundary, count] of [['host-attempt', 1], ['legacy', 1], ['external-request', null], ['external-request', 2], ['local-wait', null]]) {
    reject('running', value => { value.calls[0].observation = { boundary, requestCount: count }; }, 'invalid-call-observation');
  }
});

test('checkpoint pause and explicit retry golden identities are declarations, not a lifecycle implementation', () => {
  const paused = validateRuntimeContract(copy('paused')), retry = validateRuntimeContract(copy('retry'));
  assert.equal(paused.jobId, retry.jobId); assert.notEqual(paused.attemptId, retry.attemptId);
  assert.equal(paused.runtime.activeAttemptId, null);
  assert.equal(paused.runtime.attempts[0].status, 'complete'); assert.equal(paused.runtime.attempts[0].endReason, 'checkpoint-pause');
  assert.notEqual(paused.runtime.legacyId, retry.runtime.legacyId, 'explicit retry has an explicitly supplied new facade');
  assert.equal(retry.runtime.steps[0].stepKey, retry.runtime.steps[1].stepKey);
  assert.notEqual(retry.runtime.steps[0].stepRunId, retry.runtime.steps[1].stepRunId);
  assert.notEqual(retry.calls[0].callId, retry.calls[1].callId);
  assert.equal(retry.calls[0].observation.requestCount, 1); assert.equal(retry.calls[1].observation.requestCount, null);
  const pausedPhysical = { ...paused.runtime.attempts[0], status: 'paused' };
  assert.throws(() => AttemptSchema(pausedPhysical), /status/);
});

test('record relationships reject dangling or duplicate physical identities', () => {
  reject('running', value => { value.attemptId = 'missing-attempt'; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.activeAttemptId = 'missing-attempt'; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.attempts[0].jobId = 'another-job'; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.attempts.push({ ...value.runtime.attempts[0] }); }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.steps[0].jobId = 'another-job'; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.steps[0].attemptId = 'missing-attempt'; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.steps.push({ ...value.runtime.steps[0] }); }, 'invalid-contract-reference');
  reject('running', value => { value.calls[0].jobId = 'another-job'; }, 'invalid-contract-reference');
  reject('running', value => { value.calls[0].attemptId = 'missing-attempt'; }, 'invalid-contract-reference');
  reject('running', value => { value.calls[0].stepRunId = 'missing-step-run'; }, 'invalid-contract-reference');
  reject('running', value => { value.calls[0].stepKey = 'another-step'; }, 'invalid-contract-reference');
  reject('running', value => { value.calls.push({ ...value.calls[0] }); }, 'invalid-contract-reference');
  reject('retry', value => { value.runtime.attempts[0].status = 'running'; }, 'invalid-contract-reference');
  reject('paused', value => { value.runtime.activeAttemptId = value.attemptId; }, 'invalid-contract-reference');
  reject('paused', value => { delete value.runtime.attempts[0].checkpointRef; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.attempts[0].endReason = 'executor-lost'; }, 'invalid-contract-reference');
});

test('running Jobs require an active physical Attempt, including after a prior Attempt ended', () => {
  reject('queued', value => { value.status = 'running'; }, 'invalid-contract-reference');
  reject('running', value => { value.runtime.activeAttemptId = null; value.runtime.attempts[0].status = 'failed'; }, 'invalid-contract-reference');
});

test('queued Jobs cannot claim a physical Attempt is already running', () => {
  reject('running', value => { value.status = 'queued'; }, 'invalid-contract-reference');
});

test('current definition matches the latest Attempt while historical definitions remain factual', () => {
  const value = copy('retry');
  value.runtime.definitionVersion = 2; value.runtime.attempts[1].definitionVersion = 2;
  assert.equal(validateRuntimeContract(value).runtime.attempts[0].definitionVersion, 1);
  value.runtime.attempts[1].definitionVersion = 1;
  assert.throws(() => validateRuntimeContract(value), { code: 'invalid-contract-reference' });
});

test('terminal Jobs and checkpoint-paused Jobs cannot contradict their physical Attempt metadata', () => {
  for (const status of ['complete', 'failed', 'cancelled', 'interrupted']) {
    reject('running', value => { value.status = status; }, 'invalid-contract-reference');
  }
  reject('paused', value => { delete value.runtime.attempts[0].endReason; }, 'invalid-contract-reference');
  reject('paused', value => { value.runtime.attempts[0].status = 'failed'; delete value.runtime.attempts[0].endReason; }, 'invalid-contract-reference');
  const held = copy('queued'); held.status = 'paused'; held.capabilities.pauseMode = 'queued-only';
  held.actions.pause = { available: false, mode: 'queued-only', reason: { code: 'already-paused' } }; held.actions.resume = { available: true };
  assert.equal(validateRuntimeContract(held).runtime.attempts.length, 0, 'queued-only hold may precede admission entirely');
});

test('checkpoint-paused Jobs require a saved physical Attempt even before admission', () => {
  reject('queued', value => {
    value.status = 'paused';
    value.actions.pause = { available: false, mode: 'checkpoint', reason: { code: 'already-paused' } };
    value.actions.resume = { available: true };
  }, 'invalid-contract-reference');
});

test('terminal Jobs agree with their latest Attempt, preserving cancellation after a checkpoint pause', () => {
  for (const status of ['complete', 'failed', 'cancelled', 'interrupted']) {
    const ended = copy('running'); ended.status = status; ended.runtime.activeAttemptId = null; ended.runtime.attempts[0].status = status;
    assert.equal(validateRuntimeContract(ended).status, status, 'matching terminal states are valid');
    ended.runtime.attempts[0].status = status === 'complete' ? 'failed' : 'complete';
    assert.throws(() => validateRuntimeContract(ended), { code: 'invalid-contract-reference' }, 'ended state disagreement is invalid');
  }
  const cancelled = copy('paused'); cancelled.status = 'cancelled'; cancelled.endReason = 'user-cancel';
  assert.equal(validateRuntimeContract(cancelled).runtime.attempts[0].status, 'complete', 'logical cancellation preserves ended checkpoint history');
  const unadmitted = copy('queued'); unadmitted.status = 'cancelled';
  assert.equal(validateRuntimeContract(unadmitted).runtime.attempts.length, 0, 'queued cancellation need not run an executor');
});

test('a completed checkpoint pause cannot claim successful logical Job completion', () => {
  reject('paused', value => { value.status = 'complete'; }, 'invalid-contract-reference');
});

test('queued-only pause cannot be offered after the latest physical Attempt has ended', () => {
  reject('running', value => {
    value.status = 'queued'; value.runtime.activeAttemptId = null; value.runtime.attempts[0].status = 'failed';
    value.capabilities.pauseMode = 'queued-only'; value.actions.pause.mode = 'queued-only';
  }, 'inconsistent-capability');
});

test('unsupported action, pause and recovery declarations fail clearly rather than advertising fake controls', () => {
  for (const name of ['cancel', 'retry', 'set']) {
    reject('running', value => { value.capabilities[name] = false; value.actions[name] = { available: true }; }, 'inconsistent-capability');
  }
  reject('running', value => { value.capabilities.pauseMode = 'unsupported'; value.actions.pause.mode = 'unsupported'; }, 'inconsistent-capability');
  reject('paused', value => { value.capabilities.pauseMode = 'unsupported'; value.actions.pause.mode = 'unsupported'; }, 'inconsistent-capability');
  reject('running', value => { value.actions.pause.mode = 'queued-only'; }, 'inconsistent-capability');
  reject('running', value => { value.capabilities.pauseMode = 'queued-only'; value.actions.pause.mode = 'queued-only'; }, 'inconsistent-capability');
  const badRecovery = copy('queued'); badRecovery.capabilities.recoveryMode = 'automatic-everything';
  assert.throws(() => validateRuntimeContract(badRecovery), /recoveryMode/);
  const badAction = copy('queued'); badAction.actions.pause.available = 'yes';
  assert.throws(() => validateRuntimeContract(badAction), /available/);
  const missingReason = copy('queued'); missingReason.actions.retry = { available: false };
  assert.throws(() => validateRuntimeContract(missingReason), { code: 'inconsistent-capability' });
});

test('the selected validator is the installed direct schemastery implementation, with no alternate runtime', () => {
  assert.equal(JobSchema['~standard'].vendor, Schema.object({})['~standard'].vendor);
  assert.equal(JobSchema['~standard'].vendor, 'schemastery');
  assert.throws(() => JobSchema({ contractVersion: 2, jobId: 7 }), /jobId/);
  assert.throws(() => AttemptSchema({ ...copy('running').runtime.attempts[0], policySnapshot: { callback() {} } }), /callback/);
});

test('compatibility vectors keep actual v1 output separate from synthetic admission and loss premises', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/unified-runtime-compatibility.json', import.meta.url), 'utf8'));
  for (const entry of fixture.cases) {
    assert.deepEqual(jobContract(structuredClone(entry.legacyRecord)), entry.expectedV1, `${entry.id}: actual unchanged v1 projector`);
    if (Object.hasOwn(entry, 'proposedV2')) {
      assert.ok(entry.premises, `${entry.id}: extra admission observations must be declared`);
      assert.deepEqual(validateRuntimeContract(structuredClone(entry.proposedV2)), entry.proposedV2, `${entry.id}: proposed data only`);
    } else {
      assert.equal(entry.expectedV1.contractVersion, 1); assert.equal(Object.hasOwn(entry.expectedV1, 'runtime'), false);
    }
  }
  const paused = fixture.cases.find(entry => entry.id === 'audio-checkpoint-paused');
  const resumed = fixture.cases.find(entry => entry.id === 'audio-checkpoint-resumed');
  assert.equal(paused.expectedV1.attemptId, resumed.expectedV1.attemptId, 'legacy pause/resume facade stays stable');
  assert.equal(paused.proposedV2.runtime.legacyId, resumed.proposedV2.runtime.legacyId);
  assert.notEqual(paused.proposedV2.attemptId, resumed.proposedV2.attemptId, 'new physical Attempt is explicit synthetic evidence');
  const interrupted = fixture.cases.find(entry => entry.id === 'audio-confirmed-interrupted');
  assert.equal(interrupted.expectedV1.status, 'failed'); assert.equal(interrupted.proposedV2.status, 'interrupted');
  assert.equal(interrupted.proposedV2.runtime.attempts[0].endReason, 'executor-lost');
  assert.equal(fixture.sourceCommit, 'e61f6debe9436794cafc2bc8c65a0d0164e5ac5e');
  assert.equal(fixture.historicalSourceCommit, 'f091f09f830c226bfebc9af22344896733893a10');
  const archived = archiveRecordOf(structuredClone(interrupted.legacyRecord), { at: interrupted.archivedAt });
  assert.deepEqual(archived, interrupted.expectedArchivedRecord, 'actual 2.6.1 bounded archive projection');
  assert.deepEqual(interrupted.restoredLegacyRecord.restoredContract, archived.job.contract, 'restored input is the actual saved archive contract');
  for (const action of Object.values(archived.job.contract.actions)) {
    assert.equal(action.available, false); assert.equal(action.reason.code, 'archived');
  }
  const restored = jobContract(structuredClone(interrupted.restoredLegacyRecord));
  assert.deepEqual(restored, interrupted.expectedRestoredV1, 'actual stored-contract restoration fallback');
  for (const contract of [archived.job.contract, restored]) {
    assert.equal(contract.contractVersion, 1); assert.equal(Object.hasOwn(contract, 'runtime'), false, 'stored v1 lacks admission evidence');
  }
  assert.equal(restored.actions.retry.reason.code, 'not-retryable', 'fallback restoration does not create an executable retry');
});

for (const [name, bad] of [['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined], ['function', () => {}], ['Date', new Date('2026-10-05T00:00:00Z')]]) {
  test(`plainData rejects nested ${name} without silently rewriting it for JSON`, () => {
    for (const field of ['runtime.attempts.0.policySnapshot', 'detail', 'stage.args', 'usage.tokenUsage']) {
      const value = copy('running'), keys = field.split('.'), last = keys.pop(), owner = keys.reduce((part, key) => part[key], value);
      owner[last] = { nested: { observed: bad } };
      assert.throws(() => validateRuntimeContract(value), { code: 'invalid-contract-shape' }, field);
      assert.equal(Object.hasOwn(owner[last].nested, 'observed'), true, `${field}: do not discard the invalid field`);
      assert.equal(owner[last].nested.observed, bad, `${field}: do not manufacture a replacement observation`);
    }
  });
}

test('progress percent excludes non-finite numbers while normal values and null remain valid', () => {
  for (const percent of [NaN, Infinity, -Infinity]) {
    const value = copy('running'); value.progress.percent = percent;
    assert.throws(() => validateRuntimeContract(value), { code: 'invalid-contract-shape' });
  }
  for (const percent of [null, 0, 25.5, 100]) {
    const value = copy('running'); value.progress.percent = percent;
    assert.equal(validateRuntimeContract(value).progress.percent, percent);
  }
});

test('validation rejects a custom JSON serializer without executing the input function', () => {
  const value = copy('running'); let calls = 0;
  value.detail = { nested: { toJSON() { calls += 1; return { rewritten: true }; } } };
  assert.throws(() => validateRuntimeContract(value), { code: 'invalid-contract-shape' });
  assert.equal(calls, 0);
});
