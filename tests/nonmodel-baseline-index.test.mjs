import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { INDEX_TOOLS, buildIndex, readManifest, sourceKey } from '../lib/retrieval-index.js';
import { until } from './helpers/wait.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

/* S5-0 baseline of the search-index build (docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md): what a source key and a content hash decide, what the
   build does when the remote write and the local manifest disagree, and that the build is its own background run, not a job of the shared list.
   The search extension is a fake port; nothing is indexed anywhere. */

const page = (n, text = `第 ${n} 页`) => ({ id: `p${n}`, title: `书 · p.${n}`, text, courses: ['OS'], document: { id: 'h', page: n, totalPages: 9, bookTitle: '书' } });
const pages = [page(1), page(2), page(3)], library = pages.map(source => source.id);

function fakePort({ failDelete = false, onIngest, delay = 0 } = {}) {
  const calls = [];
  return { calls, tools: () => Object.values(INDEX_TOOLS).map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
    call: async (name, args, options = {}) => {
      calls.push({ name, args, options });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      options.signal?.throwIfAborted();
      if (name === INDEX_TOOLS.delete && failDelete) throw new Error('index busy');
      if (name === INDEX_TOOLS.ingest) await onIngest?.(args, calls.filter(call => call.name === name).length);
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    } };
}
const keys = port => port.calls.filter(call => call.name === INDEX_TOOLS.ingest).map(call => call.args.metadata.source);

test('the index entry of a source is its key studyhub://source/<id> and the sha-256 of its text; the ingest call is the only write and has the 15 minute limit and the run\'s signal', async () => {
  const port = fakePort(), controller = new AbortController(), manifest = { sources: {} };
  await buildIndex({ port, sources: pages, library, manifest, signal: controller.signal });
  assert.deepEqual(keys(port), pages.map(source => sourceKey(source.id)));
  assert.equal(port.calls[0].options.timeoutMs, 15 * 60 * 1000);
  assert.equal(port.calls[0].options.signal, controller.signal);
  assert.match(manifest.sources.p1.hash, /^[0-9a-f]{64}$/);
  assert.ok(port.calls.every(call => call.name === INDEX_TOOLS.ingest), 'no query or verification call is made');
});

test('DEFECT BASELINE: a delete the extension refused is forgotten locally, so the remote entry is orphaned and never retried', async () => {
  const manifest = { sources: { gone: { hash: 'x', at: 'then' }, p1: { hash: 'y', at: 'then' } } };
  const port = fakePort({ failDelete: true });
  const summary = await buildIndex({ port, sources: [page(1)], library: ['p1'], manifest });
  assert.deepEqual([summary.removed, summary.failed.length], [1, 0]);
  assert.equal(manifest.sources.gone, undefined);
  assert.ok(port.calls.some(call => call.name === INDEX_TOOLS.delete && call.args.source === sourceKey('gone')));
});

test('DEFECT BASELINE: ingests the extension accepted but the manifest never recorded are written again under the same keys, with no check of what the index holds', async () => {
  const first = fakePort();
  const summary = await buildIndex({ port: first, sources: pages, library, manifest: { sources: {} }, save: async () => { throw new Error('disk full'); } });
  assert.equal(summary.added, 3, 'a manifest that cannot be saved does not fail the build');
  const second = fakePort();
  await buildIndex({ port: second, sources: pages, library, manifest: { sources: {} } });
  assert.deepEqual(keys(second), keys(first), 'the same keys are ingested a second time');
  assert.ok(second.calls.every(call => call.name === INDEX_TOOLS.ingest));
});

test('DEFECT BASELINE: a cancel during an ingest leaves that page unrecorded although the extension may have taken it; the next build writes it again and skips the finished ones', async () => {
  const controller = new AbortController(), manifest = { sources: {} };
  const port = fakePort({ onIngest: (_args, index) => { if (index === 2) { controller.abort(); throw controller.signal.reason; } } });
  await assert.rejects(buildIndex({ port, sources: pages, library, manifest, signal: controller.signal }), error => error.name === 'AbortError');
  assert.deepEqual(Object.keys(manifest.sources), ['p1']);
  const next = fakePort();
  await buildIndex({ port: next, sources: pages, library, manifest });
  assert.deepEqual(keys(next), [sourceKey('p2'), sourceKey('p3')]);
});

async function libraryWithPages(t, name, port) {
  const root = await mkdtemp(join(tmpdir(), `nonmodel-index-${name}-`));
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: port, ...switchOptions(SWITCH_MODE, { paths: ['retrievalIndex'] }) });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const book = Array.from({ length: 4 }, (_, index) => `<!-- page: ${index + 1} -->\n${name} 第 ${index + 1} 页讲进程。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: `${name}.md`, courses: [name] });
  return { service, root };
}

test('a build is one background run per library: a second start joins it whatever course it names, other libraries run beside it, and (on the original build) none of it is in the shared job list', async t => {
  const home = await mkdtemp(join(tmpdir(), 'nonmodel-index-home-')), before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true, maxRetries: 5 }); });
  const a = await libraryWithPages(t, 'OS', fakePort({ delay: 30 })), b = await libraryWithPages(t, 'DB', fakePort({ delay: 30 }));
  const idle = await a.service.call('retrieval.index.status', {});
  assert.equal(idle.status, 'idle');
  await a.service.call('retrieval.status', {}); await a.service.call('retrieval.index.plan', { course: 'OS' }); await a.service.call('retrieval.index.coverage', {});
  assert.equal((await a.service.call('retrieval.preview', { query: '进程' })).provider, 'builtin');
  assert.equal((await a.service.call('retrieval.index.status', {})).status, 'idle', 'status, plan, coverage and preview are instant calls: none starts a run');
  const first = await a.service.call('retrieval.index.start', { course: 'OS' });
  const joined = await a.service.call('retrieval.index.start', { course: 'DB' });
  assert.equal(joined.runId, first.runId);
  assert.equal(joined.course, 'OS', 'the course asked for the second time is ignored');
  const other = await b.service.call('retrieval.index.start', { course: 'DB' });
  assert.notEqual(other.runId, first.runId, 'another library has its own run');
  assert.equal((await a.service.call('retrieval.index.status', {})).status, 'running');
  assert.equal((await b.service.call('retrieval.index.status', {})).status, 'running');
  // D-8: the original build is not in the shared list the task console reads; on the runtime (runtime.pilot.retrievalIndex) it is exactly one job there.
  const listed = (await a.service.call('snapshot')).jobs;
  if (SWITCH_MODE === 'runtime') assert.deepEqual(listed.map(job => [job.type, job.id]), [['retrieval-index', first.runId]]);
  else assert.deepEqual(listed, [], 'a build is not a job in the shared list the task console reads');
  for (const { service } of [a, b]) await until(async () => (await service.call('retrieval.index.status', {})).status === 'complete', 'the build');
  assert.equal(Object.keys((await readManifest(a.root)).sources).length, 4);
  assert.equal(Object.keys((await readManifest(b.root)).sources).length, 4);
  assert.notDeepEqual(Object.keys((await readManifest(a.root)).sources), Object.keys((await readManifest(b.root)).sources), 'each library keeps its own manifest');
});
