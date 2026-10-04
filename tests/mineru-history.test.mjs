import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY, closeRecord, clearRecords, historyDir, interruptRecords, listRecords, openRecord, plainReason, pruneRecords, removeRecord, updateRecord } from '../lib/mineru-history.js';

/* The durable conversion history: one small record per conversion, written when it starts and updated as it progresses.
   Pure of the service: the library folder and the clock are injected. */

const DAY = 24 * 60 * 60_000;
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const start = (root, id, extra = {}, now = Date.now()) => openRecord(root, { id, filename: 'Book.pdf', bytes: 1234, pages: 450, pieces: 3, route: 'cloud', ...extra }, { now: () => now });

test('a record is written when the conversion starts, and says only what happened, never what the book said', async t => {
  const root = await library(t);
  const record = await start(root, 'job-0001', {}, 1_000_000);
  assert.deepEqual({ ...record }, {
    version: 1, converter: 'mineru', id: 'job-0001', filename: 'Book.pdf', bytes: 1234, pages: 450, pieces: 3, route: 'cloud', status: 'running', phase: 'split',
    pagesDone: 0, attempts: 1, elapsedMs: 0, startedAt: new Date(1_000_000).toISOString(), attemptStartedAt: new Date(1_000_000).toISOString(), updatedAt: new Date(1_000_000).toISOString() });
  const files = await readdir(historyDir(root));
  assert.deepEqual(files, ['job-0001.json'], 'one file per conversion, no temp leftovers');
  assert.deepEqual(await listRecords(root), [record]);
});

test('progress is kept as it happens: the phase, the piece and the pages done', async t => {
  const root = await library(t);
  await start(root, 'job-0001', {}, 1_000_000);
  const updated = await updateRecord(root, 'job-0001', { phase: 'parse', pagesDone: 200, piece: 2 }, { now: () => 1_050_000 });
  assert.equal(updated.phase, 'parse');
  assert.equal(updated.pagesDone, 200);
  assert.equal(updated.piece, 2);
  assert.equal(updated.updatedAt, new Date(1_050_000).toISOString());
  assert.equal(await updateRecord(root, 'job-9999', { phase: 'parse' }), null, 'an unknown record is not invented');
  assert.equal((await listRecords(root)).length, 1);
});

test('a finished conversion keeps its duration, the imported document and the page counts', async t => {
  const root = await library(t);
  await start(root, 'job-0001', { route: 'local', tier: 'basic' }, 1_000_000);
  const done = await closeRecord(root, 'job-0001', { status: 'complete', documentId: 'document-abc-json', title: 'Book', importedPages: 448, skippedPages: 2, pagesDone: 450 }, { now: () => 1_000_000 + 260_000 });
  assert.equal(done.status, 'complete');
  assert.equal(done.tier, 'basic');
  assert.equal(done.finishedAt, new Date(1_260_000).toISOString());
  assert.equal(done.elapsedMs, 260_000, '4 minutes 20 seconds, from the clock the host gave');
  assert.deepEqual([done.documentId, done.importedPages, done.skippedPages, done.pagesDone], ['document-abc-json', 448, 2, 450]);
  assert.equal(done.failure, undefined);
});

test('a failed conversion says at which stage and why, in plain words', async t => {
  const root = await library(t);
  await start(root, 'job-0001', {}, 1_000_000);
  const failed = await closeRecord(root, 'job-0001', { status: 'failed', failure: { stage: 'upload', piece: 2, reason: 'MinerU 服务暂时不可用，请稍后再试。' } }, { now: () => 1_010_000 });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, { stage: 'upload', piece: 2, reason: 'MinerU 服务暂时不可用，请稍后再试。' });
  assert.equal(failed.elapsedMs, 10_000);
  assert.equal(failed.documentId, undefined, 'nothing was imported');
});

test('a cancelled conversion is cancelled, not failed', async t => {
  const root = await library(t);
  await start(root, 'job-0001');
  assert.equal((await closeRecord(root, 'job-0001', { status: 'cancelled' })).status, 'cancelled');
  await assert.rejects(closeRecord(root, 'job-0001', { status: 'complete-ish' }), /status/);
});

test('"接着做" on the same job is another attempt of the same record: the start stays, the time adds up, the old failure goes', async t => {
  const root = await library(t);
  await start(root, 'job-0001', {}, 1_000_000);
  await closeRecord(root, 'job-0001', { status: 'failed', failure: { stage: 'parse', reason: 'x' }, pagesDone: 200 }, { now: () => 1_100_000 });
  const again = await start(root, 'job-0001', {}, 5_000_000);
  assert.equal(again.status, 'running');
  assert.equal(again.attempts, 2);
  assert.equal(again.startedAt, new Date(1_000_000).toISOString());
  assert.equal(again.attemptStartedAt, new Date(5_000_000).toISOString());
  assert.equal(again.failure, undefined);
  assert.equal(again.finishedAt, undefined);
  assert.equal(again.pagesDone, 200, 'the finished pieces still count');
  const done = await closeRecord(root, 'job-0001', { status: 'complete', documentId: 'd' }, { now: () => 5_030_000 });
  assert.equal(done.elapsedMs, 100_000 + 30_000, 'only the time spent working is added, never the days in between');
  assert.equal((await listRecords(root)).length, 1);
});

test('a conversion a crash left running becomes interrupted, with no invented end or duration; finished ones and live ones are left alone', async t => {
  const root = await library(t);
  await start(root, 'job-0001', {}, 1_000_000);
  await start(root, 'job-0002', {}, 1_000_000);
  await start(root, 'job-0003', {}, 1_000_000);
  await closeRecord(root, 'job-0003', { status: 'complete', documentId: 'd' }, { now: () => 1_020_000 });
  const changed = await interruptRecords(root, ['job-0002'], { now: () => 9_000_000 });
  assert.deepEqual(changed.map(record => record.id), ['job-0001']);
  const byId = Object.fromEntries((await listRecords(root)).map(record => [record.id, record]));
  assert.equal(byId['job-0001'].status, 'interrupted');
  assert.equal(byId['job-0001'].finishedAt, undefined, 'no end time is made up');
  assert.equal(byId['job-0001'].elapsedMs, 0, 'and no duration');
  assert.equal(byId['job-0002'].status, 'running');
  assert.equal(byId['job-0003'].status, 'complete');
  assert.deepEqual((await interruptRecords(root, [])).map(record => record.id), ['job-0002'], 'a second pass interrupts the other one');
});

test('the list is newest first', async t => {
  const root = await library(t);
  await start(root, 'job-aaaa1', { filename: 'old.pdf' }, 1_000_000);
  await start(root, 'job-bbbb2', { filename: 'new.pdf' }, 3_000_000);
  await start(root, 'job-cccc3', { filename: 'mid.pdf' }, 2_000_000);
  assert.deepEqual((await listRecords(root)).map(record => record.filename), ['new.pdf', 'mid.pdf', 'old.pdf']);
});

test('retention: the latest 50 are kept, and so is everything younger than 90 days, whichever is more; pruning happens on write', async t => {
  assert.deepEqual([HISTORY.keepLatest, HISTORY.keepMs], [50, 90 * DAY]);
  const now = Date.now();
  const seed = async (root, count, age, prefix) => { for (let i = 0; i < count; i++) await start(root, `${prefix}-${String(i).padStart(4, '0')}`, {}, now - age + i * 1000); };
  // 60 records, all a year old, then one new one: only the latest 50 stay.
  const old = await library(t);
  await seed(old, 60, 365 * DAY, 'old');
  assert.equal((await listRecords(old)).length, 60, 'each was young when it was written');
  await start(old, 'new-0001', {}, now);
  const kept = await listRecords(old);
  assert.equal(kept.length, 50);
  assert.ok(kept.some(record => record.id === 'new-0001'), 'the newest is kept');
  assert.ok(!kept.some(record => record.id === 'old-0000'), 'the oldest went');
  assert.ok(kept.some(record => record.id === 'old-0059'), 'the newest of the old ones stayed');
  // 60 records, all a week old: all stay (younger than 90 days beats the count).
  const young = await library(t);
  await seed(young, 60, 7 * DAY, 'young');
  await start(young, 'new-0001', {}, now);
  assert.equal((await listRecords(young)).length, 61);
  // 55 records 200 days old: the 50 newest stay, the rest go.
  const mixed = await library(t);
  await seed(mixed, 55, 200 * DAY, 'mix');
  await closeRecord(mixed, 'mix-0054', { status: 'complete', documentId: 'd' }, { now: () => now });
  assert.equal((await listRecords(mixed)).length, 50);
  // A conversion that must stay (it is running) is not pruned, however old.
  const running = await library(t);
  await seed(running, 60, 300 * DAY, 'run');
  assert.equal((await pruneRecords(running, { now: () => now, keep: ['run-0000'] })).removed, 9);
  const left = await listRecords(running);
  assert.equal(left.length, 51);
  assert.ok(left.some(record => record.id === 'run-0000'));
});

test('removing one record and clearing the history touch nothing else', async t => {
  const root = await library(t);
  await start(root, 'job-0001'); await start(root, 'job-0002'); await start(root, 'job-0003');
  await closeRecord(root, 'job-0002', { status: 'failed', failure: { stage: 'parse', reason: 'x' } });
  assert.equal(await removeRecord(root, 'job-0001'), true);
  assert.equal(await removeRecord(root, 'job-0001'), false, 'already gone');
  await assert.rejects(removeRecord(root, '../escape'), /无效/);
  assert.deepEqual((await listRecords(root)).map(record => record.id).sort(), ['job-0002', 'job-0003']);
  const cleared = await clearRecords(root, { keep: ['job-0003'] });
  assert.equal(cleared.removed, 1);
  assert.deepEqual((await listRecords(root)).map(record => record.id), ['job-0003'], 'a conversion that is running stays');
  assert.equal((await clearRecords(root)).removed, 1);
  assert.deepEqual(await listRecords(root), []);
});

test('a damaged or foreign file in the folder is skipped, never a crash', async t => {
  const root = await library(t);
  await start(root, 'job-0001');
  await writeFile(join(historyDir(root), 'job-0002.json'), '{ not json');
  await writeFile(join(historyDir(root), 'notes.txt'), 'hello');
  await writeFile(join(historyDir(root), 'job-0003.json'), JSON.stringify({ id: 'other-0003', status: 'running' }));
  await writeFile(join(historyDir(root), 'job-0004.json'), JSON.stringify({ id: 'job-0004', version: 99, status: 'weird' }));
  assert.deepEqual((await listRecords(root)).map(record => record.id), ['job-0001']);
});

test('a missing folder is an empty history', async t => {
  const root = await library(t);
  assert.deepEqual(await listRecords(root), []);
  assert.equal((await clearRecords(root)).removed, 0);
});

test('a failure reason carries no file path, no token and no long secret-looking text', async t => {
  const token = 'eyJ0eXBlIjoiSldUIn0.fake_MINERU_token_0000000000000001.sig-test';
  const text = plainReason(`ENOENT: no such file C:\\Users\\Eric\\.dsh\\study\\tmp\\pdf-convert\\abcd\\jobs\\x\\source.pdf and /home/eric/.dsh/study/tmp/pdf-convert/a/b.pdf; Authorization: Bearer ${token}; token=${token}`, { secrets: [token] });
  assert.doesNotMatch(text, /Users|\.dsh|\/home|eyJ|fake_MINERU|Bearer ey/);
  assert.match(text, /ENOENT/);
  assert.ok(text.length <= HISTORY.maxReason);
  assert.equal(plainReason('MinerU 服务暂时不可用，请稍后再试。'), 'MinerU 服务暂时不可用，请稍后再试。', 'ordinary sentences pass unchanged');
  assert.equal(plainReason('x'.repeat(1000)).length, HISTORY.maxReason);
  assert.equal(plainReason(undefined), '');
  assert.equal(plainReason('a  \n  b'), 'a b');
});

test('what is written is exactly the whitelisted fields, whatever is passed in', async t => {
  const root = await library(t);
  await openRecord(root, { id: 'job-0001', filename: 'C:\\temp\\Book.pdf', bytes: 5, pages: 2, pieces: 1, route: 'cloud', text: 'THE BOOK SAYS SECRET', token: 'T', tempPath: 'C:\\x', source: '/tmp/y' });
  await closeRecord(root, 'job-0001', { status: 'complete', documentId: 'd', text: 'MORE TEXT', sourceIds: ['a', 'b'], path: 'C:\\z' });
  const raw = await readFile(join(historyDir(root), 'job-0001.json'), 'utf8');
  assert.doesNotMatch(raw, /SECRET|MORE TEXT|"token"|tempPath|C:\\\\x|\/tmp\/y|C:\\\\z|sourceIds/);
  assert.equal(JSON.parse(raw).filename, 'Book.pdf', 'only the file name, never its folder');
});
