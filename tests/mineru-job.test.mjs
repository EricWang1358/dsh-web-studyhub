import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertHome, convertPdf, discardJob, listManifests, planFile, prepareJob } from '../lib/mineru-job.js';
import { PdfChunkError } from '../lib/pdf-chunker.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { makeEncryptedPdf, makePdf } from './helpers/pdf.mjs';

/* One conversion of one PDF on this computer, with a stand-in for the window runner: prepare (pages, the first windows), convert window by window, merge,
   import, discard. (The cloud route and its pieces, uploads and polls were removed in 3.6; the local route has its own deeper tests in
   tests/mineru-local*.test.mjs and tests/mineru-adaptive-*.test.mjs.) */

async function setup(t, { pages = 3, pdf } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-convert-home-'));
  const library = await mkdtemp(join(tmpdir(), 'study-convert-lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(home, { recursive: true, force: true }); await rm(library, { recursive: true, force: true });
  });
  const source = join(library, 'Book.pdf');
  await writeFile(source, pdf ?? await makePdf({ pages }));
  const windows = [];
  const local = { cli: { file: 'stand-in', prefix: [], env: {} }, liveness: false,
    parseWindow: async ({ startPage, endPage }) => { windows.push([startPage, endPage]); return { content: Array.from({ length: endPage - startPage + 1 }, (_, offset) => ({ type: 'text', text: `page ${startPage + offset}`, page_idx: offset })), markers: endPage - startPage + 1, warnings: [] }; } };
  const h = { home, library, source, windows, imports: [] };
  h.prepare = (extra = {}) => prepareJob({ root: library, source, filename: 'Book.pdf', courses: ['Databases'], tier: 'basic', ...extra });
  h.run = (prepared, extra = {}) => convertPdf({ dir: prepared.dir, manifest: prepared.manifest, root: library, local, limits: { livenessMs: 0 },
    importMerged: async input => { h.imports.push(input); return { sourceIds: ['s1'] }; }, ...extra });
  return h;
}

test('a job is local by default: windows of pages, no pieces to cut, nothing uploaded', async t => {
  const h = await setup(t, { pages: 120 });
  const prepared = await h.prepare();
  assert.equal(prepared.manifest.route, 'local');
  assert.equal(prepared.manifest.plan.kind, 'adaptive');
  assert.equal(prepared.manifest.splitDone, true);
  assert.deepEqual(prepared.manifest.outline, []);
  const fixed = await h.prepare({ limits: { windowPages: 50 } });
  assert.deepEqual(fixed.manifest.chunks.map(chunk => [chunk.startPage, chunk.endPage]), [[1, 50], [51, 100], [101, 120]]);
  await h.run(fixed);
  assert.deepEqual(h.windows, [[1, 50], [51, 100], [101, 120]]);
  assert.equal(parseConvertedDocument(h.imports[0].bytes.toString('utf8')).totalPages, 120);
});

test('discarding after success removes everything, the finished windows too', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  await h.run(prepared);
  await discardJob(h.library, prepared.manifest.id, { sourceHash: prepared.manifest.sourceHash });
  assert.deepEqual(await readdir(join(convertHome(h.library), 'jobs')).catch(() => []), []);
  assert.deepEqual(await readdir(join(convertHome(h.library), 'results')).catch(() => []), []);
});

test('a PDF that cannot be read is refused with a plain message before any folder exists', async t => {
  const h = await setup(t, { pdf: await makeEncryptedPdf() });
  await assert.rejects(h.prepare(), error => error instanceof PdfChunkError && error.code === 'encrypted');
  assert.deepEqual(await readdir(join(convertHome(h.library), 'jobs')).catch(() => []), []);
  await writeFile(h.source, Buffer.from('not a pdf'));
  await assert.rejects(h.prepare(), error => error.code === 'not-pdf');
});

test('planFile shows the first windows without keeping anything', async t => {
  const h = await setup(t, { pages: 450 });
  const plan = await planFile({ source: h.source });
  assert.equal(plan.pages, 450);
  assert.ok(plan.adaptive);
  assert.equal(plan.plan, undefined, 'no cloud pieces');
  assert.deepEqual(plan.windows.map(piece => [piece.startPage, piece.endPage]), [[1, plan.adaptive.firstPages]]);
  assert.deepEqual((await planFile({ source: h.source, limits: { windowPages: 200 } })).windows.map(piece => piece.pages), [200, 200, 50]);
  assert.deepEqual(await readdir(convertHome(h.library)).catch(() => []), []);
});

test('listManifests finds the unfinished conversions of a library, for recovery after a restart', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  const found = await listManifests(h.library);
  assert.deepEqual(found.map(item => item.manifest.id), [prepared.manifest.id]);
  assert.equal((await listManifests(await mkdtemp(join(tmpdir(), 'study-other-lib-')))).length, 0);
});
