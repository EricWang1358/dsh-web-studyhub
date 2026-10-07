/* S6-6: reading what the alpha left, from the fixed older release (v2.7.1), and going forward again. The matrix of docs/plans/unified-job-runtime/s6-6-rollback.md has a line for every
   migration switch with the three results kept apart (the older release starts and reads the library / finished artifacts are readable / unfinished new work can go on); the four phase
   drills named the same release; and three properties the drills do not pin directly are checked here with the release's own validators (tests/fixtures/release-2.7.1): a read and write
   by the older release leaves an in-flight job's identity as it was, an unknown schema is refused and not rewritten, and the runtime leaves one new kind of file. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIGRATION_SWITCHES } from '../lib/runtime-config.js';
import { createManifestJobStore as currentStore } from '../lib/jobs/store.js';
import { createManifestJobStore as olderStore, validateStoredJob as olderValidates } from './fixtures/release-2.7.1/store.js';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';
import { until } from './helpers/wait.mjs';

const DIR = new URL('../docs/plans/unified-job-runtime/', import.meta.url);
const doc = await readFile(new URL('s6-6-rollback.md', DIR), 'utf8');
const EVIDENCE = ['s2-7-evidence.json', 's3-7-evidence.json', 's4-9-rollback-evidence.json', 's5-7-evidence.json'];
const evidence = Object.fromEntries(await Promise.all(EVIDENCE.map(async name => [name, JSON.parse(await readFile(new URL(name, DIR), 'utf8'))])));
const RESULT = /^(✓|△|无|未演练)/;

test('the matrix has one line for every migration switch and none for a switch that does not exist, each with its three results', () => {
  const rows = doc.split('\n').filter(line => /^\| `[A-Za-z]+` /.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  assert.deepEqual(rows.map(row => row[0].replaceAll('`', '').split(' ')[0]).sort(), Object.keys(MIGRATION_SWITCHES).sort(), 'a new switch needs a line in the rollback matrix');
  for (const row of rows) {
    assert.equal(row.length, 5, row[0]);
    for (const cell of row.slice(1, 4)) assert.match(cell, RESULT, `${row[0]}: "${cell}" is one of ✓ △ 无 未演练`);
    // A limit, or a gap, says what it is: it is never a bare symbol.
    for (const cell of row.slice(1, 4)) if (/^(△|未演练)/.test(cell)) assert.ok(cell.replace(RESULT, '').trim().length >= 8, `${row[0]}: the limit is written down`);
    assert.ok(row[4].length > 0, `${row[0]}: names its evidence`);
  }
});

test('the four phase drills name the one fixed release, and so does the document', () => {
  const shas = new Set(Object.values(evidence).map(item => item.rollbackSha)), tags = new Set(Object.values(evidence).map(item => item.rollbackTag));
  assert.deepEqual([[...tags], [...shas].length], [['v2.7.1'], 1]);
  const [sha] = shas;
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.ok(doc.includes(sha) && doc.includes('v2.7.1'));
  for (const name of EVIDENCE) assert.ok(doc.includes(name), `${name} is cited`);
  assert.ok(!/[A-Z]:[\\/]|Users/.test(JSON.stringify(evidence)), 'no local path in a committed evidence file');
});

test('the runtime leaves one new kind of file, generation-runs/; nothing else it writes is a job, runtime, attempt or step file', () => {
  const kinds = Object.values(evidence).flatMap(item => [...(item.fileKinds || []), ...(item.olderFileKinds || [])]);
  const suspicious = kinds.filter(kind => /generation-runs|runtime|kernel|(^|\/)jobs?[./]|job-?store|runtime-?job/i.test(kind));
  assert.ok(suspicious.length > 0 && suspicious.every(kind => /generation-runs\//.test(kind)), JSON.stringify(suspicious));
});

/** A durable Job held in flight, and the same Job settled, each as the manifest the current runtime wrote. */
async function manifests(t) {
  const hold = Promise.withResolvers(), sink = { channel: 'session', idempotent: false, deliver() {} };
  let midway;
  const f = await durableFixture(t, async () => { midway = await readFile(file(), 'utf8'); await hold.promise; return { refs: [{ kind: 'note', id: 'n1' }], completeness: 'complete' }; },
    { declared: [sink], notifications: [sink], waitForDelivery: true });
  const file = () => join(f.root, 'audio-batches', 'single-fixture-1', 'manifest.json');
  const job = await f.port.submit('persist', {});
  await until(() => midway, 'the job to be in flight');
  const inFlight = await readFile(file(), 'utf8');
  hold.resolve();
  await f.port.wait(job.jobId);
  return { file: file(), inFlight, settled: await readFile(file(), 'utf8') };
}

const withoutRevision = value => { const { revision: _revision, ...rest } = value; return rest; };

test('the older release reads and writes the manifest of an in-flight job and of a settled one: the current code reads it back with every identity as it was', async t => {
  const { file, inFlight, settled } = await manifests(t);
  for (const [name, text] of [['in flight', inFlight], ['settled', settled]]) {
    await writeFile(file, text, 'utf8');
    const before = await currentStore(file).load(), older = olderStore(file), seen = await older.load();
    assert.doesNotThrow(() => olderValidates(structuredClone(seen)), `${name}: the older validator accepts it`);
    await older.save(seen, { expectedRevision: seen.revision }); // what the older release does whenever it touches the file
    const back = await currentStore(file).load();
    assert.deepEqual(withoutRevision(back), withoutRevision(before), `${name}: nothing the runtime wrote was changed by the older release`);
    const [was, now] = [before, back].map(value => value.contract.runtime.attempts.at(-1));
    assert.deepEqual([back.contract.jobId, back.contract.runtime.definitionVersion, now.attemptId, now.executor, now.policySnapshot],
      [before.contract.jobId, before.contract.runtime.definitionVersion, was.attemptId, was.executor, was.policySnapshot], `${name}: the Attempt keeps its identity, executor and policy`);
  }
  assert.equal(JSON.parse(inFlight).runtimeJob.contract.status, 'running', 'the first manifest really is one of a running job');
  const { deliveries } = JSON.parse(settled).runtimeJob;
  assert.ok(deliveries.length > 0 && deliveries.every(item => Object.keys(item).sort().join() === 'channel,eventId,status'), 'delivery records carry no key the older release does not know');
});

test('a manifest of an unknown schema is refused by both and not rewritten by either', async t => {
  const { file, settled } = await manifests(t), wrapper = JSON.parse(settled);
  const future = JSON.stringify({ ...wrapper, runtimeJob: { ...wrapper.runtimeJob, schemaVersion: 2, future: { note: 'a field a later release adds' } } });
  await writeFile(file, future, 'utf8');
  assert.throws(() => olderValidates(JSON.parse(future).runtimeJob), { code: 'unsupported-store-version' });
  for (const open of [olderStore, currentStore]) await assert.rejects(Promise.resolve().then(() => open(file).load()), { code: 'unsupported-store-version' });
  assert.equal(await readFile(file, 'utf8'), future, 'the bytes on disk are exactly what a later release wrote');
  await copyFile(file, `${file}.keep`);
  assert.equal(await readFile(`${file}.keep`, 'utf8'), future);
});
