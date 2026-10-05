import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVE, archiveRecordOf, createJobArchive, jobArchive } from '../lib/job-archive.js';
import { ACTIONS } from '../lib/job-contract.js';

/* 任务 归档: the read-only record of a finished job (lib/job-archive.js). It is one small file next to the library; what it keeps is the job's CONTRACT as the
   console draws it, bounded, with nothing large or secret in it. These tests use a temporary library and a fake clock only. */

const DAY = 86400000, NOW = Date.parse('2026-10-06T00:00:00Z');
const open = (root, extra = {}) => createJobArchive(root, { now: () => NOW, ...extra });
const temp = async (t) => { const root = await mkdtemp(join(tmpdir(), 'study-job-archive-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const audio = (n, extra = {}) => ({ id: `job-${n}`, root: '/somewhere', type: 'audio-import', batchId: `batch-${String(n).padStart(8, '0')}`, filename: `lecture-${n}.mp3`, status: 'complete',
  startedAt: new Date(Date.UTC(2026, 9, 1, 8, n)).toISOString(), finishedAt: new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString(), sourceIds: [`src-${n}`], warnings: [], ...extra });
const gen = (n, extra = {}) => ({ id: `gen-${n}`, root: '/somewhere', status: 'failed', deckTitle: `Deck ${n}`, stage: 'rate limit exceeded', startedAt: new Date(Date.UTC(2026, 9, 2, 8, n)).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 9, 2, 9, n)).toISOString(), requestedTotal: 10, savedCount: 3, ...extra });
const step = (n, extra = {}) => ({ id: `step-${n}`, kind: 'author', status: 'complete', startedAt: new Date(Date.UTC(2026, 9, 2, 8, n)).toISOString(), finishedAt: new Date(Date.UTC(2026, 9, 2, 8, n, 30)).toISOString(), ...extra });

test('a record keeps what the console draws (title, kind, status, times, result refs, progress) and nothing else of the job', () => {
  const record = archiveRecordOf(audio(1), { at: '2026-10-05T10:00:00.000Z' });
  assert.equal(record.id, 'batch-00000001', 'named by what survives a retry, like the contract');
  assert.deepEqual([...record.ids].sort(), ['batch-00000001', 'job-1'], 'and findable by the attempt id too');
  assert.equal(record.archivedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(record.files, 'batch-00000001', 'the working folder of an audio batch is remembered, never touched');
  const { contract } = record.job;
  assert.equal(contract.kind, 'audio-import');
  assert.equal(contract.title, 'lecture-1.mp3');
  assert.equal(contract.status, 'complete');
  assert.deepEqual(contract.result.refs, [{ kind: 'source', id: 'src-1' }]);
  assert.equal(contract.progress.percent, 100);
  assert.equal(contract.startedAt, '2026-10-01T08:01:00.000Z');
  assert.equal(record.job.id, 'job-1');
  assert.deepEqual(record.job.archived, { at: '2026-10-05T10:00:00.000Z' });
  assert.equal(record.job.root, undefined, 'never the library path');
});

test('an archived contract is read-only: every action says it is unavailable because the job is archived, and the settings are gone', () => {
  const { contract } = archiveRecordOf(gen(1, { retryable: true, control: { values: { concurrency: 2, paused: false }, limits: { concurrency: { type: 'int', min: 1, max: 4 } } } }), { at: '2026-10-05T10:00:00.000Z' }).job;
  for (const name of ACTIONS) assert.deepEqual(contract.actions[name].available, false, name);
  for (const name of ACTIONS) assert.equal(contract.actions[name].reason.code, 'archived', name);
  assert.equal(contract.actions.set.settings, undefined);
  assert.equal(contract.archivedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(contract.status, 'failed', 'what the job ended as stays what it was');
});

test('what could be large or secret is not kept: no output previews, no raw output buffers, no keys, calls and events bounded', () => {
  const job = gen(2, { steps: Array.from({ length: 300 }, (_, i) => step(i, { outputPreview: 'SECRET model answer '.repeat(30), inputChars: 99999 })),
    freeKey: 'AIzaVerySecretKey', output: 'x'.repeat(100000), messages: Array.from({ length: 20 }, (_, i) => ({ id: i, text: 'user words '.repeat(50) })) });
  const record = archiveRecordOf(job, { at: '2026-10-05T10:00:00.000Z' });
  const text = JSON.stringify(record);
  assert.ok(!text.includes('SECRET model answer'), 'a call keeps no piece of what the model wrote');
  assert.ok(!text.includes('AIzaVerySecretKey'));
  assert.ok(!text.includes('xxxxxxxxxx'));
  assert.ok(text.length <= ARCHIVE.maxRecordChars, `a record is at most ${ARCHIVE.maxRecordChars} characters, got ${text.length}`);
  assert.ok(record.job.contract.calls.length < 300 && record.job.contract.calls.length >= 1);
  assert.ok(record.job.contract.events.length <= 60);
  assert.equal(record.job.contract.title, 'Deck 2');
});

test('a record that is too large anyway is trimmed (lists first) until it fits; the headline facts always survive', () => {
  const files = Array.from({ length: 400 }, (_, i) => ({ id: `m${i}`, filename: `file-${i}.mp3`, status: 'complete', phase: 'done', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 1 }, translate: { done: 1, total: 1 } },
    warnings: ['a long warning text '.repeat(20)] }));
  const record = archiveRecordOf(audio(3, { members: files, filename: 'big batch' }), { at: '2026-10-05T10:00:00.000Z' });
  assert.ok(JSON.stringify(record).length <= ARCHIVE.maxRecordChars);
  assert.equal(record.job.contract.title, 'big batch');
  assert.equal(record.job.contract.status, 'complete');
  assert.deepEqual(record.job.contract.result.refs, [{ kind: 'source', id: 'src-3' }]);
  assert.ok(record.job.contract.startedAt);
});

test('adding persists the record in one file next to the library and a fresh reader sees the same records (a restart keeps them)', async (t) => {
  const root = await temp(t);
  const archive = open(root);
  const first = archiveRecordOf(audio(1), { at: '2026-10-05T10:00:00.000Z' }), second = archiveRecordOf(gen(1), { at: '2026-10-05T11:00:00.000Z' });
  const { added, evicted } = await archive.add([first, second]);
  assert.deepEqual(added.sort(), ['batch-00000001', 'gen-1']);
  assert.deepEqual(evicted, []);
  assert.deepEqual(await readdir(root), [ARCHIVE.file], 'one file, and no temporary file left behind');
  const fresh = open(root);
  const listed = await fresh.list();
  assert.deepEqual(listed.map((record) => record.id), ['gen-1', 'batch-00000001'], 'newest archived first');
  assert.deepEqual((await fresh.jobs()).map((job) => job.id), ['gen-1', 'job-1']);
  assert.ok(await fresh.has('job-1') && await fresh.has('batch-00000001') && await fresh.has('gen-1'), 'found by the contract id or the attempt id');
  assert.equal(await fresh.has('nothing'), false);
  assert.equal((await fresh.find('job-1')).id, 'batch-00000001');
  const raw = JSON.parse(await readFile(join(root, ARCHIVE.file), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.records.length, 2);
});

test('adding the same job twice is one record (idempotent), and two adds at the same moment both land', async (t) => {
  const root = await temp(t);
  const archive = open(root);
  const record = archiveRecordOf(audio(1), { at: '2026-10-05T10:00:00.000Z' });
  await Promise.all([archive.add([record]), archive.add([record]), archive.add([archiveRecordOf(gen(1), { at: '2026-10-05T10:01:00.000Z' })]), archive.add([archiveRecordOf(gen(2), { at: '2026-10-05T10:02:00.000Z' })])]);
  const ids = (await open(root).list()).map((item) => item.id).sort();
  assert.deepEqual(ids, ['batch-00000001', 'gen-1', 'gen-2']);
  assert.deepEqual(await readdir(root), [ARCHIVE.file]);
});

test('remove drops records by either id, tells which were removed and is harmless for ids it does not have', async (t) => {
  const root = await temp(t);
  const archive = open(root);
  await archive.add([archiveRecordOf(audio(1), { at: '2026-10-05T10:00:00.000Z' }), archiveRecordOf(gen(1), { at: '2026-10-05T10:01:00.000Z' })]);
  const { removed } = await archive.remove(['job-1', 'nope']);
  assert.deepEqual(removed.map((record) => record.id), ['batch-00000001']);
  assert.deepEqual((await open(root).list()).map((record) => record.id), ['gen-1']);
  assert.deepEqual((await archive.remove(['job-1'])).removed, []);
});

test('the archive keeps the newest 200 records: the oldest fall off and are handed back so their working folders can be cleaned', async (t) => {
  const root = await temp(t);
  let now = Date.UTC(2026, 9, 5);
  const archive = createJobArchive(root, { now: () => now, maxRecords: 5 });
  for (let n = 1; n <= 5; n++) await archive.add([archiveRecordOf(audio(n), { at: new Date(now + n * 1000).toISOString() })]);
  const result = await archive.add([archiveRecordOf(audio(6), { at: new Date(now + 6000).toISOString() }), archiveRecordOf(audio(7), { at: new Date(now + 7000).toISOString() })]);
  assert.deepEqual(result.evicted.map((record) => record.id), ['batch-00000001', 'batch-00000002']);
  assert.deepEqual(result.evicted.map((record) => record.files), ['batch-00000001', 'batch-00000002']);
  assert.deepEqual((await open(root, { maxRecords: 5 }).list()).map((record) => record.id), [7, 6, 5, 4, 3].map((n) => `batch-0000000${n}`));
  assert.equal(ARCHIVE.maxRecords, 200);
});

test('records older than 90 days fall off (by when they were archived), never shown and handed back by trim()', async (t) => {
  const root = await temp(t);
  let now = Date.UTC(2026, 9, 5);
  const archive = createJobArchive(root, { now: () => now });
  await archive.add([archiveRecordOf(audio(1), { at: new Date(now - 91 * DAY).toISOString() }), archiveRecordOf(audio(2), { at: new Date(now - 89 * DAY).toISOString() })]);
  // the first add already trims by the same clock
  assert.deepEqual((await archive.list()).map((record) => record.id), ['batch-00000002']);
  now += 2 * DAY;
  assert.deepEqual((await archive.list()).map((record) => record.id), [], 'two days later the other one is older than 90 days: not shown');
  const { evicted } = await archive.trim();
  assert.deepEqual(evicted.map((record) => record.id), ['batch-00000002']);
  assert.deepEqual((await archive.trim()).evicted, [], 'nothing left to hand back the second time');
  assert.equal(ARCHIVE.maxDays, 90);
});

test('a missing, empty or damaged file is an empty archive, and a damaged record does not take the others with it', async (t) => {
  const root = await temp(t);
  assert.deepEqual(await open(root).list(), []);
  await writeFile(join(root, ARCHIVE.file), '{not json', 'utf8');
  assert.deepEqual(await open(root).list(), []);
  const good = archiveRecordOf(gen(1), { at: '2026-10-05T10:00:00.000Z' });
  await writeFile(join(root, ARCHIVE.file), JSON.stringify({ version: 1, records: [null, { id: 5 }, { id: 'x', job: {} }, good, { ...good, id: 'y', job: { id: 'y', contract: 'not an object' } }] }), 'utf8');
  assert.deepEqual((await open(root).list()).map((record) => record.id), ['gen-1']);
});

test('the revision moves with every change (the snapshot fingerprint reads it) and reload() reads the file again', async (t) => {
  const root = await temp(t);
  const archive = open(root), other = open(root);
  const before = archive.revision();
  await archive.add([archiveRecordOf(gen(1), { at: '2026-10-05T10:00:00.000Z' })]);
  assert.notEqual(archive.revision(), before);
  const mid = archive.revision();
  await archive.remove(['gen-1']);
  assert.notEqual(archive.revision(), mid);
  await other.list();
  await archive.add([archiveRecordOf(gen(2), { at: '2026-10-05T10:00:00.000Z' })]);
  other.reload();
  assert.deepEqual((await other.list()).map((record) => record.id), ['gen-2']);
});

test('one archive per library is shared by every runtime of it', async (t) => {
  const root = await temp(t);
  assert.equal(jobArchive(root), jobArchive(root));
  assert.notEqual(jobArchive(root), jobArchive(`${root}-other`));
});

test('asking to remove what the archive does not hold writes nothing (no file appears)', async (t) => {
  const root = await temp(t);
  const archive = open(root);
  assert.deepEqual((await archive.remove(['nothing'])).removed, []);
  assert.deepEqual(await readdir(root), []);
  const record = archiveRecordOf(gen(1), { at: '2026-10-05T10:00:00.000Z' });
  await archive.add([record]);
  const before = await readFile(join(root, ARCHIVE.file), 'utf8');
  await archive.remove(['nothing']);
  assert.equal(await readFile(join(root, ARCHIVE.file), 'utf8'), before);
});

test('two records archived in the same millisecond keep their order: the later one is the newer', async (t) => {
  const root = await temp(t);
  const archive = open(root), at = '2026-10-05T10:00:00.000Z';
  await archive.add([archiveRecordOf(gen(1), { at })]);
  await archive.add([archiveRecordOf(gen(2), { at })]);
  await archive.add([archiveRecordOf(gen(3), { at })]);
  assert.deepEqual((await archive.list()).map((record) => record.id), ['gen-3', 'gen-2', 'gen-1']);
  assert.deepEqual((await open(root).list()).map((record) => record.id), ['gen-3', 'gen-2', 'gen-1'], 'and a fresh reader agrees');
});
