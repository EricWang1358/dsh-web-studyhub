import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { INDEX_TOOLS, MODEL_DOWNLOAD_MB, SOURCE_PREFIX, buildIndex, contentHash, pageDocument, planIndex, sourceIdFromKey } from '../lib/retrieval-index.js';
import { resolveHits, normalizeHits } from '../lib/retrieval.js';

/* WP28b: "为这门课建立检索索引". The sources of a course are handed page by page to the search server's
   ingest tool under their own source id, only the new or changed ones, and the answers map back exactly. */

const repo = fileURLToPath(new URL('../', import.meta.url));
const page = (n, text, extra = {}) => ({ id: `p${n}`, title: `操作系统 · p.${n}`, text, courses: ['OS'], document: { id: 'h', page: n, totalPages: 9, bookTitle: '操作系统' }, ...extra });
const sources = [page(1, '进程是资源分配的单位。'), page(2, '线程是调度的单位。'), page(3, '死锁需要四个必要条件。')];

function fakeServer({ failFirst, failOn = [], delay = 0 } = {}) {
  const calls = [];
  const port = {
    tools: () => Object.values(INDEX_TOOLS).map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
    call: async (name, args, options = {}) => {
      calls.push({ name, args, options });
      if (delay) await new Promise(done => setTimeout(done, delay));
      options.signal?.throwIfAborted();
      if (failFirst && calls.length === 1) throw new Error(failFirst);
      if (name === INDEX_TOOLS.ingest && failOn.includes(sourceIdFromKey(args.metadata.source))) throw new Error('parse failed');
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
  };
  return { port, calls };
}

test('a page is exported under its own source id, with its title and text', () => {
  const [first] = sources;
  assert.equal(pageDocument(first), '# 操作系统 · p.1\n\n进程是资源分配的单位。');
  assert.equal(SOURCE_PREFIX, 'studyhub://source/');
  assert.equal(sourceIdFromKey('studyhub://source/p7'), 'p7');
  assert.equal(sourceIdFromKey('/some/file.md'), undefined);
  assert.equal(MODEL_DOWNLOAD_MB, 90);
});

test('search hits that carry the source id of an exported page map back exactly', () => {
  const hits = normalizeHits([{ text: '线程是调度的单位。', filePath: 'studyhub://source/p2', chunkIndex: 0, score: 0.9 }, { text: '别处', filePath: 'studyhub://source/gone', score: 0.5 }]);
  const { passages, unresolved } = resolveHits(hits, sources);
  assert.deepEqual(passages.map(item => [item.sourceId, item.page, item.matchedBy]), [['p2', 2, 'id']]);
  assert.equal(unresolved, 1);
});

test('the plan is incremental: new or changed pages are added, unchanged ones are skipped, deleted ones are removed', () => {
  const first = planIndex({ sources, library: sources.map(source => source.id), manifest: { sources: {} } });
  assert.deepEqual(first.add.map(source => source.id), ['p1', 'p2', 'p3']);
  assert.equal(first.unchanged, 0);
  const manifest = { sources: Object.fromEntries(sources.map(source => [source.id, { hash: contentHash(source.text) }])) };
  assert.deepEqual(planIndex({ sources, library: ['p1', 'p2', 'p3'], manifest }).add, []);
  const edited = [sources[0], page(2, '线程是 CPU 调度的基本单位。'), sources[2]];
  const next = planIndex({ sources: edited, library: ['p1', 'p2', 'p3'], manifest });
  assert.deepEqual(next.add.map(source => source.id), ['p2']);
  assert.equal(next.unchanged, 2);
  const withGone = planIndex({ sources, library: ['p1', 'p2', 'p3'], manifest: { sources: { ...manifest.sources, ghost: { hash: 'x' } } } });
  assert.deepEqual(withGone.remove, ['ghost'], 'only pages that left the library are removed from the index');
});

test('building ingests each page once, reports progress, and records what it indexed', async () => {
  const { port, calls } = fakeServer();
  const progress = [], saved = [];
  const manifest = { sources: {} };
  const summary = await buildIndex({ port, sources, library: ['p1', 'p2', 'p3'], manifest, firstRun: true, onProgress: event => progress.push(event), save: value => saved.push(structuredClone(value)) });
  assert.deepEqual(summary, { added: 3, removed: 0, unchanged: 0, failed: [] });
  assert.deepEqual(calls.map(call => [call.name, call.args.metadata.source, call.args.metadata.format]),
    [1, 2, 3].map(n => [INDEX_TOOLS.ingest, `studyhub://source/p${n}`, 'markdown']));
  assert.equal(calls[0].args.content, '# 操作系统 · p.1\n\n进程是资源分配的单位。');
  assert.ok(calls[0].options.timeoutMs >= 10 * 60 * 1000, 'the first call may download the model');
  assert.equal(progress[0].stage, 'model', 'the first run says the model is being prepared');
  assert.ok(progress.some(event => event.stage === 'indexing' && event.done === 3 && event.total === 3));
  assert.deepEqual(Object.keys(manifest.sources).sort(), ['p1', 'p2', 'p3']);
  assert.ok(saved.length >= 1);
  // The second run has nothing to do; a changed page and a deleted page are the only work after that.
  const again = fakeServer();
  assert.deepEqual(await buildIndex({ port: again.port, sources, library: ['p1', 'p2', 'p3'], manifest }), { added: 0, removed: 0, unchanged: 3, failed: [] });
  assert.equal(again.calls.length, 0);
  const third = fakeServer();
  const result = await buildIndex({ port: third.port, sources: [sources[0], page(2, '改过的内容很长很长很长')], library: ['p1', 'p2'], manifest });
  assert.deepEqual([result.added, result.removed, result.unchanged], [1, 1, 1]);
  assert.deepEqual(third.calls.map(call => [call.name, call.args.metadata?.source || call.args.source]), [[INDEX_TOOLS.ingest, 'studyhub://source/p2'], [INDEX_TOOLS.delete, 'studyhub://source/p3']]);
  assert.equal(manifest.sources.p3, undefined);
});

test('a first-run download failure is explained in plain words, not as a stack trace', async () => {
  const { port } = fakeServer({ failFirst: 'fetch failed: getaddrinfo ENOTFOUND huggingface.co' });
  await assert.rejects(buildIndex({ port, sources, library: ['p1'], manifest: { sources: {} }, firstRun: true }),
    error => error.code === 'retrieval-model-download' && /检索模型/.test(error.message) && /下载地址/.test(error.message));
});

test('one page that cannot be read does not stop the rest; many in a row do', async () => {
  const { port } = fakeServer({ failOn: ['p2'] });
  const manifest = { sources: {} };
  const summary = await buildIndex({ port, sources, library: ['p1', 'p2', 'p3'], manifest });
  assert.equal(summary.added, 2);
  assert.deepEqual(summary.failed.map(item => item.id), ['p2']);
  assert.equal(manifest.sources.p2, undefined, 'a failed page is retried next time');
  const many = Array.from({ length: 12 }, (_, i) => page(i + 1, `第 ${i + 1} 页内容`));
  const broken = fakeServer({ failOn: many.map(source => source.id) });
  await assert.rejects(buildIndex({ port: broken.port, sources: many, library: many.map(source => source.id), manifest: { sources: {} } }), error => error.code === 'retrieval-index-failed');
  assert.ok(broken.calls.length <= 6, 'it stops after a few failures in a row');
});

test('cancelling stops between pages and keeps what was done', async () => {
  const { port, calls } = fakeServer({ delay: 15 });
  const controller = new AbortController();
  const manifest = { sources: {} };
  const many = Array.from({ length: 20 }, (_, i) => page(i + 1, `第 ${i + 1} 页内容`));
  const running = buildIndex({ port, sources: many, library: many.map(source => source.id), manifest, signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(running, error => error.name === 'AbortError' || /abort/i.test(error.message));
  assert.ok(calls.length < 20);
  assert.ok(Object.keys(manifest.sources).length >= 1, 'finished pages stay recorded');
});

test('without the search extension running there is nothing to build with', async () => {
  await assert.rejects(buildIndex({ port: { tools: () => [], call: async () => ({}) }, sources, library: [], manifest: { sources: {} } }), error => error.code === 'retrieval-index-unavailable');
  await assert.rejects(buildIndex({ port: undefined, sources, library: [], manifest: { sources: {} } }), error => error.code === 'retrieval-index-unavailable');
});

/* ---------- the actions ---------- */

async function setup(t, options) {
  const base = join(repo, 'output', 'test-wp28b');
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, 'home-')), root = await mkdtemp(join(base, 'lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const server = fakeServer(options);
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: server.port });
  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const book = Array.from({ length: 6 }, (_, i) => `<!-- page: ${i + 1} -->\n第 ${i + 1} 页讲进程、线程和内存。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'os.md', courses: ['操作系统'] });
  await service.call('source.add', { title: '别的课', text: '数据库的索引加快查找。', courses: ['数据库'] });
  return { service, server };
}
const until = async check => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 25)); } throw new Error('timed out'); };

test('the plan tells what a build would do, and that the first one downloads the model', async t => {
  const { service } = await setup(t);
  const plan = await service.call('retrieval.index.plan', { course: '操作系统' });
  assert.deepEqual([plan.pages, plan.toIndex, plan.unchanged, plan.toRemove], [6, 6, 0, 0]);
  assert.equal(plan.firstRun, true);
  assert.equal(plan.modelMb, 90);
  assert.equal(plan.canIndex, true);
  assert.equal((await service.call('retrieval.index.plan', { course: '数据库' })).pages, 1);
});

test('starting returns at once; the work runs in the background with progress, and only the course is indexed', async t => {
  const { service, server } = await setup(t, { delay: 10 });
  const started = await service.call('retrieval.index.start', { course: '操作系统' });
  assert.equal(started.status, 'running');
  const running = await service.call('retrieval.index.status', {});
  assert.equal(running.course, '操作系统');
  assert.equal(running.total, 6);
  const done = await until(async () => { const status = await service.call('retrieval.index.status', {}); return status.status === 'complete' ? status : null; });
  assert.deepEqual([done.added, done.done], [6, 6]);
  assert.equal(server.calls.filter(call => call.name === INDEX_TOOLS.ingest).length, 6, 'the other course is left out');
  const plan = await service.call('retrieval.index.plan', { course: '操作系统' });
  assert.deepEqual([plan.toIndex, plan.unchanged], [0, 6]);
  assert.equal(plan.firstRun, true, 'the model folder is the search server\'s: the fake wrote nothing there');
});

test('a second start while one runs joins it; cancel stops it', async t => {
  const { service } = await setup(t, { delay: 60 });
  const first = await service.call('retrieval.index.start', { course: '操作系统' });
  const second = await service.call('retrieval.index.start', { course: '操作系统' });
  assert.equal(second.runId, first.runId);
  await service.call('retrieval.index.cancel', {});
  const stopped = await until(async () => { const status = await service.call('retrieval.index.status', {}); return ['cancelled', 'failed', 'complete'].includes(status.status) ? status : null; });
  assert.equal(stopped.status, 'cancelled');
});

test('a failure is kept for the page to show, in words', async t => {
  const { service } = await setup(t, { failFirst: 'fetch failed: ENOTFOUND' });
  await service.call('retrieval.index.start', { course: '操作系统' });
  const failed = await until(async () => { const status = await service.call('retrieval.index.status', {}); return status.status === 'failed' ? status : null; });
  assert.equal(failed.errorCode, 'retrieval-model-download');
  assert.match(failed.error, /检索模型/);
});
