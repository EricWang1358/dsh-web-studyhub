import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { jobContract, snapshotJob, checkAction } from '../lib/job-contract.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

const compatibility = JSON.parse(await readFile(new URL('./fixtures/unified-runtime-compatibility.json', import.meta.url), 'utf8'));
const interrupted = compatibility.cases.find(entry => entry.id === 'audio-confirmed-interrupted');
const copy = value => structuredClone(value);
const readers = { jobContract, snapshotJob: job => snapshotJob(job).contract };
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
};
const restoredRecord = stored => ({
  id: stored.runtime?.legacyId ?? stored.attemptId ?? stored.jobId, type: stored.kind, status: stored.status,
  startedAt: stored.startedAt, ...(Object.hasOwn(stored, 'finishedAt') ? { finishedAt: stored.finishedAt } : {}), restoredContract: stored,
});
const restoredExpected = (stored, actions = interrupted.expectedRestoredV1.actions) => {
  const { archivedAt: _archivedAt, ...rest } = copy(stored);
  return { ...rest, actions: copy(actions) };
};
const assertRead = (read, record, expected, label) => {
  const input = freeze(copy(record)), before = copy(input);
  const result = read(input);
  assert.deepEqual(result, expected, label);
  assert.deepEqual(input, before, `${label}: reading does not change the source`);
  return result;
};
const assertRejected = (read, stored, code, label) => {
  const input = freeze(restoredRecord(stored)), before = copy(input);
  assert.throws(() => read(input), { code }, label);
  assert.deepEqual(input, before, `${label}: rejection preserves the stored source`);
};
const remove = (value, path) => {
  const keys = path.split('.'), last = keys.pop();
  delete keys.reduce((part, key) => part[key], value)[last];
};

// These stored-read cases declare ended physical Attempts explicitly. They do
// not restore a live executor or prove a v2 archive writer, pause or recovery.
const storedTerminalV2 = () => ({ ...copy(interrupted.proposedV2), archivedAt: interrupted.archivedAt });
const terminalWithCall = () => {
  const value = copy(goldenRuntimeContracts.running);
  value.status = 'failed'; value.stage = { code: 'finished', args: { status: 'failed' } };
  value.runtime.activeAttemptId = null; value.runtime.attempts[0].status = 'failed';
  value.runtime.steps[0].status = 'failed'; value.calls[0].status = 'failed';
  value.actions = copy(interrupted.expectedRestoredV1.actions);
  return value;
};

for (const [boundary, read] of Object.entries(readers)) {
  test(`${boundary}: existing live records retain their exact golden v1 projection`, () => {
    for (const entry of compatibility.cases) {
      const result = assertRead(read, entry.legacyRecord, entry.expectedV1, entry.id);
      assert.equal(result.contractVersion, 1);
      for (const field of ['runtime', 'capabilities']) assert.equal(Object.hasOwn(result, field), false, `${entry.id}: no fabricated ${field}`);
    }
  });

  test(`${boundary}: an actual restored v1 record remains the exact published fallback`, () => {
    const result = assertRead(read, interrupted.restoredLegacyRecord, interrupted.expectedRestoredV1, 'actual stored v1');
    assert.equal(result.contractVersion, 1);
    assert.equal(Object.hasOwn(result, 'runtime'), false);
    assert.equal(Object.hasOwn(result, 'capabilities'), false);
    assert.equal(Object.hasOwn(result, 'archivedAt'), false);
    assert.equal(result.actions.retry.reason.code, 'not-retryable');
  });

  test(`${boundary}: a stored terminal v2 record preserves observed runtime and public extensions`, () => {
    const stored = storedTerminalV2();
    stored.futureReadField = { observed: 'preserved' };
    stored.progress.futureProgressField = 'preserved'; stored.detail.futureDetailField = { observed: null };
    for (const action of Object.values(stored.actions)) {
      action.available = false; action.reason = { code: 'archived' };
    }
    const expected = restoredExpected(stored);
    const result = assertRead(read, restoredRecord(stored), expected, 'stored terminal v2');
    assert.equal(result.contractVersion, 2);
    assert.deepEqual(result.runtime, interrupted.proposedV2.runtime);
    assert.deepEqual(result.capabilities, interrupted.proposedV2.capabilities);
    assert.equal(Object.hasOwn(result, 'archivedAt'), false);
    assert.equal(result.actions.retry.reason.code, 'not-retryable', 'restoration has no executable retry input');
  });

  test(`${boundary}: restored v2 refusals use its declared pause mode and retry capability`, () => {
    const stored = storedTerminalV2();
    stored.capabilities = { ...stored.capabilities, cancel: false, retry: false, set: false, pauseMode: 'unsupported', recoveryMode: 'none' };
    stored.actions.pause.mode = 'unsupported'; stored.actions.retry = { available: false, reason: { code: 'capability-unsupported' } };
    const actions = copy(interrupted.expectedRestoredV1.actions);
    actions.pause.mode = 'unsupported'; actions.retry = { available: false, reason: { code: 'capability-unsupported' } };
    const restored = restoredRecord(stored);
    const result = assertRead(read, restored, restoredExpected(stored, actions), 'declared unsupported capabilities');
    const refusal = checkAction(freeze(copy(restored)), 'retry');
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, result.actions.retry.reason.code);
    assert.equal(refusal.code, 'capability-unsupported');
  });

  test(`${boundary}: stored v2 unknown observations stay null or absent`, () => {
    const stored = terminalWithCall(), result = assertRead(read, restoredRecord(stored), restoredExpected(stored), 'unknown observations');
    assert.equal(result.progress.total, null); assert.equal(result.progress.percent, null);
    assert.deepEqual(result.usage, { tokens: null, tokenUsage: null, calls: null });
    assert.equal(result.startedAt, null); assert.equal(result.runtime.attempts[0].executor, null);
    assert.equal(result.calls[0].observation.requestCount, null);
    assert.equal(Object.hasOwn(result, 'finishedAt'), false);
    for (const field of ['startedAt', 'finishedAt']) assert.equal(Object.hasOwn(result.runtime.attempts[0], field), false);
    for (const field of ['queuedAt', 'firstOutputAt', 'tokenUsage', 'childId', 'parentId']) assert.equal(Object.hasOwn(result.calls[0], field), false);
  });

  test(`${boundary}: missing and unknown stored contract versions reject explicitly`, () => {
    for (const version of [undefined, 0, 3, '2', null]) {
      const stored = storedTerminalV2();
      if (version === undefined) delete stored.contractVersion; else stored.contractVersion = version;
      assertRejected(read, stored, 'unsupported-contract-version', `contractVersion ${String(version)}`);
    }
  });

  test(`${boundary}: unknown stored runtime schema versions reject explicitly`, () => {
    for (const version of [0, 2, '1', null]) {
      const stored = storedTerminalV2(); stored.runtime.schemaVersion = version;
      assertRejected(read, stored, 'unsupported-runtime-schema-version', `runtime.schemaVersion ${String(version)}`);
    }
  });

  test(`${boundary}: stored v2 cannot omit required admission and physical metadata`, () => {
    for (const path of ['capabilities', 'runtime', 'runtime.scopeId', 'runtime.definitionVersion', 'runtime.activeAttemptId',
      'runtime.attempts.0.executor', 'runtime.attempts.0.policySnapshot', 'runtime.steps.0.stepRunId', 'calls.0.observation']) {
      const stored = terminalWithCall(); remove(stored, path);
      assertRejected(read, stored, 'invalid-contract-shape', `missing ${path}`);
    }
  });

  test(`${boundary}: malformed or misspelled stored metadata rejects rather than being discarded`, () => {
    for (const [label, change] of [
      ['scopeId', value => { value.runtime.scopeId = 7; }],
      ['definitionVersion', value => { value.runtime.definitionVersion = 0; }],
      ['capability boolean', value => { value.capabilities.retry = 'yes'; }],
      ['executor owner', value => { delete value.runtime.attempts[0].executor.ownerAgentId; }],
      ['runtime typo', value => { value.runtime.ownerAgentID = 'synthetic-typo'; }],
    ]) {
      const stored = storedTerminalV2(); change(stored);
      assertRejected(read, stored, 'invalid-contract-shape', label);
    }
  });

  test(`${boundary}: stored physical references must agree before restoration`, () => {
    for (const [label, change] of [
      ['latest Attempt', value => { value.attemptId = 'missing-attempt'; }],
      ['active Attempt', value => { value.runtime.activeAttemptId = value.attemptId; }],
      ['Attempt Job', value => { value.runtime.attempts[0].jobId = 'another-job'; }],
      ['Step Attempt', value => { value.runtime.steps[0].attemptId = 'missing-attempt'; }],
      ['Call Step', value => { value.calls[0].stepRunId = 'missing-step-run'; }],
    ]) {
      const stored = terminalWithCall(); change(stored);
      assertRejected(read, stored, 'invalid-contract-reference', label);
    }
  });

  test(`${boundary}: contradictory stored call observations reject explicitly`, () => {
    const stored = terminalWithCall(); stored.calls[0].observation.requestCount = 1;
    assertRejected(read, stored, 'invalid-call-observation', 'host-internal requests were not observed');
  });

  test(`${boundary}: contradictory stored capabilities reject before ended actions are projected`, () => {
    const stored = terminalWithCall(); stored.capabilities.cancel = false; stored.actions.cancel = { available: true };
    assertRejected(read, stored, 'inconsistent-capability', 'an unavailable capability cannot advertise an available action');
  });
}

// Synthetic pre-admission data exercises declaration reads only; it starts no producer or executor.
for (const [boundary, read] of Object.entries(readers)) test(`${boundary}: stored v2 generation declarations do not inherit legacy single-round narrowing`, () => {
  const stored = copy(goldenRuntimeContracts.queued);
  stored.kind = 'generation';
  stored.stage = { code: 'generation.queued' };
  stored.capabilities = { ...stored.capabilities, pauseMode: 'unsupported', retry: false, recoveryMode: 'none' };
  for (const action of ['pause', 'resume', 'retry']) stored.actions[action] = { available: false, reason: { code: 'capability-unsupported' }, ...(action === 'pause' ? { mode: 'unsupported' } : {}) };
  const input = freeze(restoredRecord(stored)), before = copy(input), view = read(input);
  for (const action of ['pause', 'resume', 'retry']) {
    assert.equal(view.actions[action].reason.code, 'capability-unsupported');
    assert.equal(checkAction(input, action).code, view.actions[action].reason.code);
  }
  assert.deepEqual(view.capabilities, stored.capabilities);
  assert.deepEqual(input, before);
});
