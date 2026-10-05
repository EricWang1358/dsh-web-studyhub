import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperations } from '../lib/contexts/jobs/operations.js';
import { ARCHIVE, archiveRecordOf, createJobArchive } from '../lib/job-archive.js';
import { jobContract, snapshotJob } from '../lib/job-contract.js';

/* 任务 归档 and 批量删除 at the operation level: job.archive, job.unarchive, job.delete and what job.dismiss still does, with the operations closed over
   stand-in ports and a temporary library (a real archive file, real batch folders, a fake clock). No model, no key, nothing outside the temporary folder. */

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const NOW = Date.parse('2026-10-06T00:00:00Z');
const batch = (n) => `batch-${String(n).padStart(8, '0')}`;
const audio = (n, extra = {}) => ({ id: `job-${n}`, type: 'audio-import', batchId: batch(n), filename: `lecture-${n}.mp3`, status: 'complete', sourceIds: [`src-${n}`], warnings: [],
  startedAt: new Date(Date.UTC(2026, 9, 1, 8, n)).toISOString(), finishedAt: new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString(), ...extra });
const gen = (n, extra = {}) => ({ id: `gen-${n}`, status: 'failed', deckTitle: `Deck ${n}`, stage: 'rate limit exceeded', requestedTotal: 10, savedCount: 3,
  startedAt: new Date(Date.UTC(2026, 9, 2, 8, n)).toISOString(), finishedAt: new Date(Date.UTC(2026, 9, 2, 9, n)).toISOString(), ...extra });

async function folder(root, id) {
  const dir = join(root, 'audio-batches', id);
  await mkdir(join(dir, 'inputs'), { recursive: true });
  await writeFile(join(dir, 'inputs', 'lecture.mp3'), Buffer.alloc(512));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id, kind: 'batch', job: { id: `job-${id}`, type: 'audio-import', status: 'complete', batchId: id, filename: 'lecture.mp3' } }));
}
const names = (root) => readdir(join(root, 'audio-batches')).catch(() => []);

async function setup(t, { jobs = [], archive, state = { inbox: [] }, call } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-job-archive-ops-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const map = new Map(jobs.map((job) => [job.id, { root, ...job }]));
  const events = { dropped: [], forgot: [], cleaned: [], recovered: 0 };
  const cleanup = { dismissBatch: async (library, id) => { events.cleaned.push(id); } };
  const store = archive || createJobArchive(root, { now: () => NOW });
  const ports = {
    state: { root, update: async (mutate) => { mutate(state); } },
    work: { jobs: map, settled: new Map(), generationMessengers: new Map(), generationControllers: new Map(), jobControls: new Map(), jobOutputs: {} },
    jobServices: { activeJob: (job) => ACTIVE.has(job.status), publicJob: (job) => job, dropRetry: (id) => { events.dropped.push(id); }, forgetRetry: (id) => { events.forgot.push(id); } },
    call: call ? (name, args) => call(name, args, { map, events, root }) : async (name) => { if (name === 'recover') { events.recovered += 1; return { recovered: true }; } throw new Error(`no ${name}`); },
  };
  const handlers = createOperations(ports, { cleanup, archive: () => store }).handlers;
  return { root, map, handlers, events, archive: store, state };
}
const ids = async (archive) => (await archive.list()).map((record) => record.id);

test('job.archive puts finished jobs away: they leave the list, a read-only record is kept, and no file is touched or released', async (t) => {
  const { root, map, handlers, events, archive } = await setup(t, { jobs: [audio(1), gen(1), gen(2, { status: 'running' })] });
  await folder(root, batch(1));
  const reply = await handlers['job.archive']({ jobIds: [batch(1), 'gen-1'] });
  assert.deepEqual(reply, { archived: [batch(1), 'gen-1'], alreadyArchived: [], skipped: [], missing: [] });
  assert.deepEqual([...map.keys()], ['gen-2'], 'the archived jobs are out of the live list; the running one stays');
  assert.deepEqual((await ids(archive)).sort(), [batch(1), 'gen-1']);
  assert.deepEqual(await names(root), [batch(1)], 'the batch folder is untouched');
  assert.deepEqual(events.cleaned, [], 'nothing is deleted in the background either');
  assert.deepEqual(events.dropped, [], 'and the retry hold is not released with its cleanup');
  assert.deepEqual(events.forgot.sort(), ['gen-1', 'job-1']);
  const record = (await archive.find('gen-1')).job.contract;
  assert.equal(record.status, 'failed');
  assert.equal(record.actions.retry.reason.code, 'archived');
});

test('a job is found by what survives a retry (the batch id) or by its own id, and a card with earlier jobs folded into it archives together', async (t) => {
  const { map, handlers, archive } = await setup(t, { jobs: [audio(1), audio(2), gen(1), gen(2)] });
  await handlers['job.archive']({ jobId: 'job-1' });
  await handlers['job.archive']({ jobIds: [batch(2), 'gen-1', 'gen-2'] });
  assert.equal(map.size, 0);
  assert.deepEqual((await ids(archive)).sort(), [batch(1), batch(2), 'gen-1', 'gen-2']);
});

test('archiving twice is harmless: the second says it was already archived; an unknown job is "not found" for one id and "missing" in a list', async (t) => {
  const { handlers } = await setup(t, { jobs: [gen(1), gen(2)] });
  await handlers['job.archive']({ jobId: 'gen-1' });
  assert.deepEqual(await handlers['job.archive']({ jobId: 'gen-1' }), { archived: [], alreadyArchived: ['gen-1'], skipped: [], missing: [] });
  await assert.rejects(handlers['job.archive']({ jobId: 'nothing' }), /not found/i);
  const reply = await handlers['job.archive']({ jobIds: ['gen-2', 'gen-1', 'nothing'] });
  assert.deepEqual(reply, { archived: ['gen-2'], alreadyArchived: ['gen-1'], skipped: [], missing: ['nothing'] });
});

test('a running job is not archived: one id is refused with the same words as dismiss, in a list it is skipped and reported with the reason', async (t) => {
  const { map, handlers } = await setup(t, { jobs: [gen(1), gen(2, { status: 'running' }), gen(3, { status: 'queued' }), audio(4, { status: 'cancelling' })] });
  await assert.rejects(handlers['job.archive']({ jobId: 'gen-2' }), /任务还在进行/);
  const reply = await handlers['job.archive']({ jobIds: ['gen-1', 'gen-2', 'gen-3', batch(4)] });
  assert.deepEqual(reply.archived, ['gen-1']);
  assert.deepEqual(reply.skipped, [{ id: 'gen-2', reason: 'running' }, { id: 'gen-3', reason: 'running' }, { id: batch(4), reason: 'running' }]);
  assert.deepEqual([...map.keys()].sort(), ['gen-2', 'gen-3', 'job-4']);
});

test('job.archive all archives every finished job and nothing running; a request must name jobId, jobIds or all, and at most 100', async (t) => {
  const { map, handlers } = await setup(t, { jobs: [gen(1), gen(2), gen(3, { status: 'running' })] });
  await assert.rejects(handlers['job.archive']({}), /jobId|jobIds|all/);
  await assert.rejects(handlers['job.archive']({ all: true, jobId: 'gen-1' }), /jobId|jobIds|all/);
  assert.equal(ARCHIVE.maxBatch, 100);
  await assert.rejects(handlers['job.archive']({ jobIds: Array.from({ length: 101 }, (_, i) => `gen-${i}`) }), /100/);
  const reply = await handlers['job.archive']({ all: true });
  assert.deepEqual(reply.archived.sort(), ['gen-1', 'gen-2']);
  assert.deepEqual([...map.keys()], ['gen-3']);
});

test('archiving the same jobs at the same moment lands each once', async (t) => {
  const { map, handlers, archive } = await setup(t, { jobs: [gen(1), gen(2), gen(3)] });
  const replies = await Promise.all([handlers['job.archive']({ jobIds: ['gen-1', 'gen-2'] }), handlers['job.archive']({ jobIds: ['gen-2', 'gen-3'] }), handlers['job.archive']({ jobId: 'gen-1' }).catch((error) => error)]);
  assert.equal(map.size, 0);
  assert.deepEqual((await ids(archive)).sort(), ['gen-1', 'gen-2', 'gen-3']);
  assert.ok(replies.every((reply) => !(reply instanceof Error) || /not found/i.test(reply.message)), 'a racer that finds the job already gone says so, nothing worse');
});

test('a record that falls off the end of the archive hands its audio folder to the background cleanup, and only then', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-job-archive-evict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { handlers, events } = await setup(t, { jobs: [audio(1), audio(2), audio(3)], archive: createJobArchive(root, { now: () => NOW, maxRecords: 2 }) });
  await handlers['job.archive']({ jobId: 'job-1' });
  await handlers['job.archive']({ jobId: 'job-2' });
  assert.deepEqual(events.cleaned, []);
  await handlers['job.archive']({ jobId: 'job-3' });
  assert.deepEqual(events.cleaned, [batch(1)], 'the oldest record fell off: its working copy goes the way a deleted one does');
});

test('job.unarchive takes a record back: an audio batch is restored from its folder like after a restart, anything else from its record, and the archive forgets it', async (t) => {
  const restore = async (name, args, { map, root }) => {
    if (name !== 'recover') throw new Error(`no ${name}`);
    // what recovery does for a folder that is still there
    if ((await names(root)).includes(batch(1)) && ![...map.values()].some((job) => job.batchId === batch(1))) map.set('job-1', { root, ...audio(1), status: 'failed', retryable: true, stage: '上次导入已中断' });
    return { recovered: true };
  };
  const { root, map, handlers, archive } = await setup(t, { jobs: [audio(1, { status: 'failed', retryable: true }), gen(1)], call: restore });
  await folder(root, batch(1));
  await handlers['job.archive']({ jobIds: [batch(1), 'gen-1'] });
  assert.equal(map.size, 0);
  const reply = await handlers['job.unarchive']({ jobIds: [batch(1), 'gen-1', 'nothing'] });
  assert.deepEqual(reply, { unarchived: [batch(1), 'gen-1'], missing: ['nothing'] });
  assert.deepEqual(await ids(archive), []);
  assert.equal(map.get('job-1').retryable, true, 'the audio batch came back from its manifest, ready to continue');
  const back = map.get('gen-1');
  assert.ok(back, 'a job that has no folder comes back from its record');
  assert.ok(!['queued', 'running', 'cancelling'].includes(back.status));
  const contract = snapshotJob(back).contract;
  assert.equal(contract.title, 'Deck 1');
  assert.equal(contract.status, 'failed');
  assert.equal(contract.archivedAt, undefined, 'no longer archived');
  assert.notEqual(contract.actions.retry.reason?.code, 'archived');
  assert.equal(snapshotJob(back).restoredContract, undefined, 'the record is not sent twice');
  assert.deepEqual(await handlers['job.unarchive']({ jobIds: ['gen-1'] }), { unarchived: [], missing: ['gen-1'] }, 'not archived any more');
});

test('job.delete removes records for good: finished jobs and archived records go, the audio working copy is cleaned, a running job is skipped and counted', async (t) => {
  const { root, map, handlers, events, archive } = await setup(t, { jobs: [audio(1), audio(2), gen(1), gen(2, { status: 'running' })] });
  await folder(root, batch(2));
  await handlers['job.archive']({ jobId: 'job-2' });
  const reply = await handlers['job.delete']({ jobIds: ['job-1', batch(2), 'gen-1', 'gen-2', 'nothing'] });
  assert.deepEqual(reply, { deleted: ['job-1', batch(2), 'gen-1'], skipped: [{ id: 'gen-2', reason: 'running' }], missing: ['nothing'] });
  assert.deepEqual([...map.keys()], ['gen-2']);
  assert.deepEqual(await ids(archive), [], 'deleting an archived record takes it out of the archive');
  assert.deepEqual(events.cleaned.sort(), [batch(1), batch(2)], 'both audio working copies go to the background cleanup');
  assert.deepEqual(events.dropped.sort(), ['gen-1', 'job-1'], 'a live job releases its retry hold the way dismiss does');
  assert.deepEqual(await handlers['job.delete']({ jobIds: ['job-1'] }), { deleted: [], skipped: [], missing: ['job-1'] });
});

test('job.delete takes at most 100 at once and needs a list', async (t) => {
  const { handlers } = await setup(t);
  await assert.rejects(handlers['job.delete']({}), /jobIds/);
  await assert.rejects(handlers['job.delete']({ jobIds: Array.from({ length: 101 }, (_, i) => `gen-${i}`) }), /100/);
  const many = Array.from({ length: 100 }, (_, i) => `gen-${i}`);
  assert.deepEqual((await handlers['job.delete']({ jobIds: many })).missing.length, 100);
});

test('a legacy recovery card that is archived or deleted is not brought back by its inbox letter', async (t) => {
  const state = { inbox: [{ kind: 'audio-failed', jobId: 'L' }, { kind: 'audio-failed', jobId: 'other' }] };
  const { handlers, archive } = await setup(t, { state, jobs: [{ id: 'L', status: 'failed', type: 'audio-import', legacy: true, filename: 'old.mp3', startedAt: '2026-09-01T00:00:00.000Z' }] });
  await handlers['job.archive']({ jobId: 'L' });
  assert.equal((await archive.find('L')).legacy, true);
  assert.equal(state.inbox.length, 2, 'archiving keeps the letter (the record is skipped by recovery instead)');
  await handlers['job.delete']({ jobIds: ['L'] });
  assert.deepEqual(state.inbox.map((item) => item.jobId), ['other'], 'deleting prunes the letter, as dismiss does');
});

test('job.dismiss keeps its meaning (removes the record for good, names what it removed) and also removes an archived record by id', async (t) => {
  const { map, handlers, events, archive } = await setup(t, { jobs: [audio(1), gen(1), gen(2)] });
  assert.deepEqual(await handlers['job.dismiss']({ jobId: 'gen-1' }), { dismissed: ['gen-1'] });
  assert.deepEqual([...map.keys()].sort(), ['gen-2', 'job-1']);
  await handlers['job.archive']({ jobId: 'job-1' });
  assert.deepEqual(await handlers['job.dismiss']({ jobId: batch(1) }), { dismissed: [batch(1)] });
  assert.deepEqual(await ids(archive), []);
  assert.deepEqual(events.cleaned, [batch(1)]);
  await assert.rejects(handlers['job.dismiss']({ jobId: 'gen-1' }), /not found/i);
  await assert.rejects(handlers['job.dismiss']({}), /jobId or all/);
});

test('job.control on an archived job says so with a code instead of "not found"', async (t) => {
  const { handlers } = await setup(t, { jobs: [audio(1, { status: 'failed', retryable: true })] });
  await handlers['job.archive']({ jobId: 'job-1' });
  await assert.rejects(handlers['job.control']({ jobId: batch(1), action: 'retry' }), (error) => error.code === 'archived' && /归档/.test(error.message));
});

test('a day of 为你定制 is not archived (its file keeps fourteen days): it is skipped with that reason', async (t) => {
  const { handlers } = await setup(t, { jobs: [gen(1)] });
  const reply = await handlers['job.archive']({ jobIds: ['coach:2026-10-01', 'gen-1'] });
  assert.deepEqual(reply.archived, ['gen-1']);
  assert.deepEqual(reply.skipped, [{ id: 'coach:2026-10-01', reason: 'not-archivable' }]);
});

test('the archived record is what the console drew: same title, kind and status as the live contract', async (t) => {
  const job = audio(1, { filename: '期中复习.mp3' });
  const { handlers, archive } = await setup(t, { jobs: [job] });
  const live = jobContract({ root: 'x', ...job });
  await handlers['job.archive']({ jobId: 'job-1' });
  const kept = (await archive.find('job-1')).job.contract;
  for (const key of ['kind', 'title', 'status', 'jobId', 'startedAt', 'finishedAt']) assert.deepEqual(kept[key], live[key], key);
  assert.deepEqual(archiveRecordOf({ root: 'x', ...job }, { at: kept.archivedAt }).job.contract, kept);
});
