import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONVERT, convertHome, discardJob, jobDir, readManifest, sweepStale } from '../lib/mineru-job.js';
import { resultsDir } from '../lib/mineru-paths.js';
import { isolatedHome, pdfJob } from './helpers/nonmodel-baseline.mjs';

/* S5-0 baseline of what a finished PDF piece leaves behind and who may delete it (docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md):
   the piece cache is keyed by the file hash, the pages and the route (cloud, local tier, Marker), `discardJob` only deletes its own route's pieces,
   and `sweepStale` forgets by age. Local windows are a stand-in `parseWindow`; no process starts. */

const names = async directory => (await readdir(directory).catch(() => [])).sort();
const SPLIT_PLAN = { windowPages: 50 };

async function localRun(h, { tier, converter = 'mineru' }) {
  const prepared = await h.prepare({ route: 'local', tier, converter, limits: SPLIT_PLAN });
  const parsed = [];
  const parseWindow = async ({ startPage, endPage }) => {
    parsed.push(`${startPage}-${endPage}`);
    return { content: Array.from({ length: endPage - startPage + 1 }, (_, offset) => ({ type: 'text', text: `Page ${startPage + offset}`, page_idx: offset })) };
  };
  const local = { cli: { file: 'never-started' }, parseWindow, ...(converter === 'marker' ? { liveness: false } : {}) };
  await h.run(prepared, { local, limits: { livenessMs: 0 } });
  return { prepared, parsed };
}

test('the piece cache is keyed by file, pages and route: a second run of the same route parses nothing, another tier or Marker parses everything again', async t => {
  const h = await pdfJob(t, { pages: 60 });
  const first = await localRun(h, { tier: 'basic' });
  assert.deepEqual(first.parsed, ['1-50', '51-60']);
  const folder = resultsDir(h.library, first.prepared.manifest.sourceHash);
  assert.deepEqual(await names(folder), ['local-basic-1-50.json', 'local-basic-51-60.json']);
  assert.deepEqual((await localRun(h, { tier: 'basic' })).parsed, [], 'the same file and tier are restored from the cache');
  assert.deepEqual((await localRun(h, { tier: 'standard' })).parsed, ['1-50', '51-60'], 'a tier never reuses another tier\'s pieces');
  assert.deepEqual((await localRun(h, { tier: 'basic', converter: 'marker' })).parsed, ['1-50', '51-60'], 'Marker never reuses MinerU pieces');
  assert.deepEqual(await names(folder), ['local-basic-1-50.json', 'local-basic-51-60.json', 'local-standard-1-50.json', 'local-standard-51-60.json', 'marker-1-50.json', 'marker-51-60.json']);
  assert.equal(h.imports.length, 4);
  assert.equal(h.imports.at(-1).format, 'markdown', 'a Marker run imports Markdown, the others the JSON content list');
});

test('discarding is partitioned by converter: Marker deletes only marker- pieces, the others delete everything but those; keepResults deletes none', async t => {
  const h = await pdfJob(t, { pages: 60 });
  const { prepared } = await localRun(h, { tier: 'basic' });
  await localRun(h, { tier: 'basic', converter: 'marker' });
  const { sourceHash, id } = prepared.manifest, folder = resultsDir(h.library, sourceHash);
  assert.ok((await names(join(convertHome(h.library), 'jobs'))).includes(id), 'jobs are not deleted by running them');
  await discardJob(h.library, id, { keepResults: true, sourceHash });
  assert.equal((await names(folder)).length, 4, 'cancel and failure keep every finished piece');
  assert.equal((await names(join(convertHome(h.library), 'jobs'))).includes(id), false, 'the job folder itself is gone');
  await discardJob(h.library, 'another-job-id', { sourceHash, converter: 'marker' });
  assert.deepEqual(await names(folder), ['local-basic-1-50.json', 'local-basic-51-60.json']);
  await discardJob(h.library, 'another-job-id', { sourceHash });
  await assert.rejects(stat(folder), { code: 'ENOENT' }, 'an emptied cache folder is removed');
});

test('the cloud piece cache has no prefix, and a discard by a local or Marker job leaves it alone only because its name differs', async t => {
  const h = await pdfJob(t, { pages: 3 });
  const prepared = await h.prepare();
  const folder = resultsDir(h.library, prepared.manifest.sourceHash);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '1-3.json'), '{}');
  await writeFile(join(folder, 'marker-1-3.json'), '{}');
  await discardJob(h.library, prepared.manifest.id, { sourceHash: prepared.manifest.sourceHash, converter: 'marker' });
  assert.deepEqual(await names(folder), ['1-3.json']);
  await discardJob(h.library, prepared.manifest.id, { sourceHash: prepared.manifest.sourceHash });
  assert.deepEqual(await names(folder), [], 'the unprefixed (cloud) piece is removed by any non-Marker discard');
});

test('sweepStale forgets unfinished jobs and cached pieces older than CONVERT.staleMs, by modification time, and keeps the rest', async t => {
  const { library } = await isolatedHome(t);
  const old = new Date(Date.now() - CONVERT.staleMs - 60_000), fresh = new Date();
  const base = convertHome(library);
  for (const [folder, name, date] of [['jobs', 'old-job-0001', old], ['jobs', 'new-job-0001', fresh], ['results', 'oldhash', old], ['results', 'newhash', fresh]]) {
    await mkdir(join(base, folder, name), { recursive: true });
    await utimes(join(base, folder, name), date, date);
  }
  await mkdir(join(base, 'uploads'), { recursive: true });
  await sweepStale(library);
  assert.deepEqual(await names(join(base, 'jobs')), ['new-job-0001']);
  assert.deepEqual(await names(join(base, 'results')), ['newhash']);
  assert.deepEqual(await names(base), ['jobs', 'results', 'uploads'], 'uploads are not part of the sweep');
});

test('a job folder is named by its own id inside the DSH home, never the library; an unreadable id is refused before any path exists', async t => {
  const h = await pdfJob(t, { pages: 3 });
  const prepared = await h.prepare();
  assert.equal(prepared.dir, jobDir(h.library, prepared.manifest.id));
  assert.ok(prepared.dir.startsWith(h.home), 'under DSH_HOME');
  assert.deepEqual((await readManifest(prepared.dir)).chunks.map(chunk => chunk.state), ['planned']);
  assert.throws(() => jobDir(h.library, '../escape'), /无效的转换任务/);
});
