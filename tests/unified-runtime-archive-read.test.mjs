import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperations } from '../lib/contexts/jobs/operations.js';
import { ARCHIVE, archiveRecordOf, createJobArchive } from '../lib/job-archive.js';
import { ACTIONS, archivedContract, jobContract, snapshotJob } from '../lib/job-contract.js';
import { goldenRuntimeContracts, validateRuntimeContract } from './fixtures/unified-runtime-contract.mjs';

// S1-1 archive read boundary. Seed explicit synthetic terminal v2 history through
// the existing disk archive API; neither an archive marker nor a legacy manifest
// supplies runtime admission, host loss, a checkpoint, or an executor.
const NOW = Date.parse('2026-10-06T00:00:00Z');
const AT = '2026-10-05T10:00:00.000Z';
const FINISHED = '2026-10-05T09:00:00.000Z';
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

function terminalV2(kind = 'audio-import') {
  const contract = structuredClone(goldenRuntimeContracts.running);
  contract.jobId = 'synthetic-archived-job';
  contract.attemptId = 'synthetic-ended-attempt';
  contract.kind = kind;
  contract.title = 'Synthetic terminal archive history';
  contract.status = 'complete';
  contract.stage = { code: kind + '.complete' };
  contract.finishedAt = FINISHED;
  contract.actions = Object.fromEntries(ACTIONS.map(name => [name, { available: false, reason: { code: 'job-ended' } }]));
  contract.actions.pause.mode = contract.capabilities.pauseMode;
  contract.runtime.scopeId = 'synthetic-archive-scope';
  contract.runtime.legacyId = 'synthetic-legacy-facade';
  contract.runtime.activeAttemptId = null;
  Object.assign(contract.runtime.attempts[0], {
    jobId: contract.jobId, attemptId: contract.attemptId, status: 'complete',
    finishedAt: FINISHED, policySnapshot: { executionMode: 'direct', limits: { unitConcurrency: 1 } },
  });
  Object.assign(contract.runtime.steps[0], {
    jobId: contract.jobId, attemptId: contract.attemptId, status: 'complete',
    checkpointRef: 'synthetic-saved-step-checkpoint',
  });
  Object.assign(contract.calls[0], {
    jobId: contract.jobId, attemptId: contract.attemptId, status: 'ok',
    futureCallField: { observed: 'kept' },
  });
  contract.futureReadField = { observed: 'public extension survives' };
  contract.progress.futureProgressField = 'kept';
  contract.detail.savedDomainSummary = { sourceIds: ['synthetic-source'] };
  assert.deepEqual(validateRuntimeContract(contract), contract, 'the terminal fixture has explicit, valid runtime premises');
  return contract;
}

function v2Record(kind = 'audio-import') {
  const contract = terminalV2(kind);
  return {
    id: contract.jobId,
    ids: [contract.jobId, contract.runtime.legacyId, 'synthetic-older-facade'],
    archivedAt: AT,
    files: 'synthetic-history-folder',
    job: {
      id: contract.runtime.legacyId, type: kind, status: contract.status,
      startedAt: contract.startedAt, finishedAt: contract.finishedAt,
      archived: { at: AT }, contract: archivedContract(contract, AT),
    },
  };
}

function v1Record() {
  return archiveRecordOf({
    id: 'legacy-audio-job', type: 'audio-import', batchId: 'legacy-audio-batch',
    filename: 'legacy-history.mp3', status: 'failed', retryable: true,
    startedAt: '2026-10-05T08:00:00.000Z', finishedAt: FINISHED, sourceIds: [], warnings: [],
  }, { at: AT });
}

async function seedFolder(root, record) {
  if (!record.files) return;
  const directory = join(root, 'audio-batches', record.files);
  await mkdir(join(directory, 'inputs'), { recursive: true });
  await writeFile(join(directory, 'inputs', 'history.bin'), Buffer.from('synthetic archived input'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    id: record.files, kind: 'batch',
    job: { id: record.job.id, type: record.job.contract.kind, status: 'failed', retryable: true },
  }));
}

async function folderBytes(root, records) {
  return Promise.all(records.filter(record => record.files).sort((a, b) => a.files.localeCompare(b.files)).map(async record => ({
    id: record.files,
    entries: (await readdir(join(root, 'audio-batches', record.files))).sort(),
    manifest: await readFile(join(root, 'audio-batches', record.files, 'manifest.json')),
    input: await readFile(join(root, 'audio-batches', record.files, 'inputs', 'history.bin')),
  })));
}

async function setup(t, records) {
  const root = await mkdtemp(join(tmpdir(), 'study-runtime-archive-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = createJobArchive(root, { now: () => NOW });
  await writer.add(records);
  for (const record of records) await seedFolder(root, record);
  // A fresh reader exercises persisted records, rather than the writer's cache.
  const archive = createJobArchive(root, { now: () => NOW });
  const jobs = new Map();
  const calls = [], cleaned = [];
  const state = { inbox: [] };
  const ports = {
    state: { root, update: async mutate => { mutate(state); } },
    work: { jobs, settled: new Map(), generationMessengers: new Map(), generationControllers: new Map(), jobControls: new Map(), jobOutputs: {} },
    jobServices: { activeJob: job => ACTIVE.has(job.status), publicJob: job => job, dropRetry() {}, forgetRetry() {} },
    call: async (name, args) => { calls.push({ name, args }); return { recovered: true }; },
  };
  const remove = t.mock.method(archive, 'remove');
  const insert = t.mock.method(jobs, 'set');
  const handlers = createOperations(ports, {
    archive: () => archive,
    cleanup: { dismissBatch: async (library, id) => { cleaned.push({ library, id }); } },
  }).handlers;
  const before = {
    bytes: await readFile(join(root, ARCHIVE.file)), records: await archive.list(),
    folders: await folderBytes(root, records),
  };
  return { root, archive, jobs, calls, cleaned, remove, insert, handlers, before };
}

async function assertUntouched(context) {
  const { root, archive, jobs, calls, cleaned, remove, insert, before } = context;
  assert.equal(remove.mock.callCount(), 0, 'refusal happens before archive.remove');
  assert.equal(insert.mock.callCount(), 0, 'refusal happens before job insertion');
  assert.equal(jobs.size, 0, 'no restored job was admitted');
  assert.deepEqual(calls, [], 'refusal makes no recovery or execution call');
  assert.deepEqual(cleaned, [], 'refusal releases no folder');
  assert.deepEqual(await readFile(join(root, ARCHIVE.file)), before.bytes, 'original archive bytes survive');
  const fresh = createJobArchive(root, { now: () => NOW });
  assert.deepEqual(await fresh.list(), before.records, 'a fresh disk reader retains every record');
  for (const record of before.records) for (const alias of record.ids) {
    assert.deepEqual(await fresh.find(alias), record, 'saved alias still resolves: ' + alias);
    assert.deepEqual(await archive.find(alias), record, 'cached alias still resolves: ' + alias);
  }
  assert.deepEqual(await folderBytes(root, before.records), before.folders, 'manifest and input bytes survive');
}

const versionCases = [
  ['missing', contract => { delete contract.contractVersion; }],
  ['zero', contract => { contract.contractVersion = 0; }],
  ['unknown', contract => { contract.contractVersion = 3; }],
  ['string v1', contract => { contract.contractVersion = '1'; }],
  ['string v2', contract => { contract.contractVersion = '2'; }],
  ['null', contract => { contract.contractVersion = null; }],
];

for (const [name, change] of versionCases) {
  test('unarchive rejects a ' + name + ' saved contractVersion before any mutation', async t => {
    const record = v1Record();
    change(record.job.contract);
    const context = await setup(t, [record]);
    await assert.rejects(context.handlers['job.unarchive']({ jobId: record.job.id }), { code: 'unsupported-contract-version' });
    await assertUntouched(context);
  });
}

for (const version of [0, 2, '1', null]) {
  test('unarchive rejects saved v2 runtime.schemaVersion ' + JSON.stringify(version) + ' before any mutation', async t => {
    const record = v2Record();
    record.job.contract.runtime.schemaVersion = version;
    const context = await setup(t, [record]);
    await assert.rejects(context.handlers['job.unarchive']({ jobId: 'synthetic-older-facade' }), { code: 'unsupported-runtime-schema-version' });
    await assertUntouched(context);
  });
}

const malformedCases = [
  ['missing runtime', contract => { delete contract.runtime; }],
  ['missing capabilities', contract => { delete contract.capabilities; }],
  ['missing scopeId', contract => { delete contract.runtime.scopeId; }],
  ['missing activeAttemptId', contract => { delete contract.runtime.activeAttemptId; }],
  ['missing Attempts', contract => { delete contract.runtime.attempts; }],
  ['missing Attempt policySnapshot', contract => { delete contract.runtime.attempts[0].policySnapshot; }],
  ['missing Attempt executor', contract => { delete contract.runtime.attempts[0].executor; }],
  ['misspelled capability', contract => { contract.capabilities.resumeMode = 'checkpoint'; }],
];

for (const [name, change] of malformedCases) {
  test('unarchive rejects corrupt v2 metadata: ' + name, async t => {
    const record = v2Record();
    change(record.job.contract);
    const context = await setup(t, [record]);
    await assert.rejects(context.handlers['job.unarchive']({ jobId: record.id }), { code: 'invalid-contract-shape' });
    await assertUntouched(context);
  });
}

const referenceCases = [
  ['foreign Attempt Job', contract => { contract.runtime.attempts[0].jobId = 'foreign-job'; }],
  ['foreign Step Job', contract => { contract.runtime.steps[0].jobId = 'foreign-job'; }],
  ['unknown Step Attempt', contract => { contract.runtime.steps[0].attemptId = 'foreign-attempt'; }],
  ['unknown Call Attempt', contract => { contract.calls[0].attemptId = 'foreign-attempt'; }],
  ['contradictory Call Step run', contract => { contract.calls[0].stepKey = 'other-logical-step'; }],
  ['root selects a different Attempt', contract => { contract.attemptId = 'foreign-attempt'; }],
  ['terminal Job disagrees with ended Attempt', contract => { contract.runtime.attempts[0].status = 'failed'; }],
  ['terminal Job claims an active Attempt', contract => {
    contract.runtime.attempts[0].status = 'running';
    contract.runtime.activeAttemptId = contract.attemptId;
  }],
];

for (const [name, change] of referenceCases) {
  test('unarchive rejects incompatible v2 physical references: ' + name, async t => {
    const record = v2Record();
    change(record.job.contract);
    const context = await setup(t, [record]);
    await assert.rejects(context.handlers['job.unarchive']({ jobId: record.job.id }), { code: 'invalid-contract-reference' });
    await assertUntouched(context);
  });
}

for (const [name, incompatible, code] of [
  ['unknown v2 runtime schema', () => { const record = v2Record(); record.job.contract.runtime.schemaVersion = 2; return record; }, 'unsupported-runtime-schema-version'],
  ['missing v1 contract version', () => { const record = v1Record(); delete record.job.contract.contractVersion; return record; }, 'unsupported-contract-version'],
]) {
  test('mixed unarchive preflights the whole batch when one record has ' + name, async t => {
    const invalid = incompatible();
    const valid = invalid.job.contract.contractVersion === 2 ? v1Record() : v2Record();
    const context = await setup(t, [valid, invalid]);
    await assert.rejects(context.handlers['job.unarchive']({ jobIds: [valid.job.id, invalid.job.id] }), { code });
    await assertUntouched(context);
  });
}

for (const kind of ['audio-import', 'pdf-convert']) {
  test('valid terminal v2 ' + kind + ' archive restores public history without legacy recovery', async t => {
    const record = v2Record(kind);
    const context = await setup(t, [record]);
    const { archive, handlers, jobs, calls, cleaned, remove, insert, root, before } = context;
    const [savedJob] = await archive.jobs();
    assert.deepEqual(savedJob.contract, record.job.contract, 'the existing disk archive retains required v2 fields together');
    assert.deepEqual(jobContract(savedJob), record.job.contract, 'saved archive reads retain the declared v2 version');
    assert.deepEqual(snapshotJob(savedJob).contract, record.job.contract, 'the archived snapshot carries the same read contract');
    const savedBefore = structuredClone(savedJob);
    assert.deepEqual(await handlers['job.unarchive']({ jobId: 'synthetic-older-facade' }), { unarchived: ['synthetic-older-facade'], missing: [] });
    assert.deepEqual(calls, [], 'v2 history does not ask a legacy manifest to recover or execute');
    assert.deepEqual(cleaned, []);
    assert.equal(remove.mock.callCount(), 1, 'unarchive delegates removal to the existing archive');
    assert.equal(insert.mock.callCount(), 1, 'one restored history record is inserted');
    assert.equal(jobs.size, 1);
    const restored = jobs.get(record.job.id);
    assert.ok(restored, 'the observed legacy facade id is preserved');
    assert.deepEqual(restored.restoredContract, record.job.contract, 'the saved contract is the fallback history source');
    const direct = jobContract(restored), snapshot = snapshotJob(restored);
    const { archivedAt: _archivedAt, actions: _savedActions, ...savedRead } = record.job.contract;
    const { actions: _restoredActions, ...restoredRead } = direct;
    assert.deepEqual(restoredRead, savedRead, 'version, runtime, capabilities and every public read extension survive');
    assert.deepEqual(snapshot.contract, direct);
    assert.deepEqual(jobContract(snapshot), direct, 'reading an already projected snapshot keeps its declared v2 identity');
    assert.equal(snapshot.restoredContract, undefined, 'the internal fallback is not sent twice');
    for (const action of ACTIONS) {
      assert.equal(direct.actions[action].available, false, action + ' remains unavailable on restored history');
      assert.notEqual(direct.actions[action].reason?.code, 'archived', action + ' is no longer archived');
    }
    assert.equal(direct.actions.pause.mode, direct.capabilities.pauseMode);
    assert.deepEqual(validateRuntimeContract(direct), direct, 'the restored read remains a valid v2 contract');
    assert.deepEqual(savedJob, savedBefore, 'restoring does not rewrite the saved input object');
    assert.deepEqual(await archive.list(), []);
    const fresh = createJobArchive(root, { now: () => NOW });
    for (const alias of record.ids) assert.equal(await fresh.has(alias), false, 'the existing writer removes alias ' + alias);
    assert.deepEqual(await folderBytes(root, [record]), before.folders, 'restoring history leaves the working copy intact');
  });
}
