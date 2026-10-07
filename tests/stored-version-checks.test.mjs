/* S6-1 gap B: three single-file formats wrote a `version` and never checked it, so a file of a LATER format would be read as v1 and written over as v1 (losing what v1 does not know).
   Each reader now accepts the versions release 2.7.1 wrote (tests/fixtures/release-2.7.1/stored-versions.json, a file with no `version` is an older v1) and refuses any other: the
   archive reads as empty and every change of it is refused, a PDF conversion manifest is refused by `readManifest`, the Marker install state reads as idle and no install starts;
   and in every case the file's bytes are exactly what the later release wrote. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobArchive } from '../lib/job-archive.js';
import { listManifests, readManifest, saveManifest } from '../lib/mineru-job.js';
import { jobDir } from '../lib/mineru-paths.js';
import { createMarkerInstaller, markerInstallStatePath } from '../lib/marker-install.js';
import { STORED_VERSIONS, knownVersion } from '../lib/stored-version.js';

const known = JSON.parse(await readFile(new URL('./fixtures/release-2.7.1/stored-versions.json', import.meta.url), 'utf8'));
const folder = async t => { const dir = await mkdtemp(join(tmpdir(), 'stored-version-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; };
const record = id => ({ id, ids: [id], archivedAt: new Date().toISOString(), job: { id, contract: { actions: {}, calls: [], events: [], detail: {}, stage: { code: 'done' }, status: 'complete', kind: 'audio-import' } } });
const withHome = async (t, work) => {
  const home = await folder(t), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return await work(home); } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; }
};

test('the versions the readers accept are exactly the ones release 2.7.1 wrote, and nothing else', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STORED_VERSIONS).map(([name, list]) => [name, [...list]])), { jobArchive: known.jobArchive, pdfConvertManifest: known.pdfConvertManifest, markerInstall: known.markerInstall });
  for (const name of Object.keys(known).filter(key => key !== 'note')) {
    assert.ok(knownVersion(name, { version: 1 }) && knownVersion(name, {}) && knownVersion(name, null), `${name}: v1, no version, nothing`);
    for (const unknown of [0, 2, 99, '1', null, true]) assert.equal(knownVersion(name, { version: unknown }), false, `${name}: ${JSON.stringify(unknown)}`);
  }
});

test('the job archive: a later version reads as empty and is never rewritten; version 1 and no version read as before', async t => {
  const root = await folder(t), file = join(root, 'job-archive.json');
  for (const body of [{ version: 1, records: [record('keep-1')] }, { records: [record('keep-1')] }]) {
    await writeFile(file, JSON.stringify(body));
    assert.deepEqual((await createJobArchive(root).list()).map(item => item.id), ['keep-1'], JSON.stringify(Object.keys(body)));
  }
  const later = JSON.stringify({ version: 2, records: [record('later-1')], extra: { note: 'a field v1 does not have' } });
  await writeFile(file, later);
  const archive = createJobArchive(root);
  assert.deepEqual(await archive.list(), [], 'nothing of a later format is shown as if it were v1');
  await assert.rejects(archive.add([record('new-1')]), { code: 'unsupported-store-version' });
  await assert.rejects(archive.remove(['later-1']), { code: 'unsupported-store-version' });
  assert.equal(await readFile(file, 'utf8'), later, 'the later release\'s file is exactly as it was');
});

test('a PDF conversion manifest of a later version is refused, listed as nothing and not touched', async t => {
  await withHome(t, async () => {
    const root = await folder(t), dir = jobDir(root, 'convert-1');
    await mkdir(dir, { recursive: true });
    await saveManifest(dir, { version: 1, kind: 'pdf-convert', id: 'convert-1' });
    assert.equal((await readManifest(dir)).id, 'convert-1');
    assert.deepEqual((await listManifests(root)).map(item => item.manifest.id), ['convert-1']);
    const later = JSON.stringify({ version: 2, kind: 'pdf-convert', id: 'convert-1', pieces: ['a field v1 does not have'] });
    await writeFile(join(dir, 'manifest.json'), later);
    await assert.rejects(readManifest(dir), { code: 'unsupported-store-version' });
    assert.deepEqual(await listManifests(root), [], 'a conversion of a later format is not offered as one of this version');
    assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), later);
  });
});

test('the Marker install state of a later version reads as idle, starts nothing and is left exactly as it was', async t => {
  await withHome(t, async () => {
    const file = markerInstallStatePath(), installer = createMarkerInstaller({ platform: process.platform });
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, status: 'complete', installedFolder: '' }));
    assert.equal((await installer.status()).status, 'complete', 'version 1 is read');
    const later = JSON.stringify({ version: 2, status: 'complete', installedFolder: join(tmpdir(), 'somewhere'), more: 'a field v1 does not have' });
    await writeFile(file, later);
    assert.equal((await installer.status()).status, 'idle', 'a later format is not read as v1');
    await assert.rejects(installer.prepare({ confirm: true }), { code: 'unsupported-store-version' });
    await assert.rejects(installer.uninstall({ confirm: true }), { code: 'unsupported-store-version' });
    assert.equal(await readFile(file, 'utf8'), later, 'the later release\'s file is exactly as it was');
  });
});
