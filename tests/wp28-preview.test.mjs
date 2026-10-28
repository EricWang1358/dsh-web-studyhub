import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer, previewOptions } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { FAKE_RETRIEVAL_TOOL } from '../scripts/fake-retrieval.mjs';
import { startFakeReleaseHost } from '../scripts/fake-extension.mjs';
import { EXTENSION_BUILD } from '../lib/retrieval-extension.js';

/* WP28: the preview can play a DSH that exposes a search tool, so the card, Settings and Generate can be seen and tested. */

const repo = fileURLToPath(new URL('../', import.meta.url));
const savedHome = process.env.DSH_HOME;
test.after(() => { if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome; });
async function dir(t, prefix) {
  const base = join(repo, 'output', 'test-wp28');
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, prefix));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 3 }));
  return path;
}
async function start(t, options = {}) {
  const server = await createPreviewServer({ libraryRoot: await dir(t, 'lib-'), home: await dir(t, 'home-'), port: 0, model: createFakeModel(), ...options });
  t.after(() => server.close());
  const call = async (action, args = {}) => {
    const res = await fetch(`${server.url}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': server.token }, body: JSON.stringify({ action, args }) });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.value;
  };
  return { server, call };
}

test('STUDY_FAKE_RETRIEVAL turns the option on', () => {
  assert.equal(previewOptions(['node', 'dev.mjs'], { STUDY_FAKE_RETRIEVAL: '1' }).retrieval, 'fake');
  assert.equal(previewOptions(['node', 'dev.mjs'], { STUDY_FAKE_RETRIEVAL: 'extension' }).retrieval, 'extension');
  assert.equal(previewOptions(['node', 'dev.mjs'], { STUDY_FAKE_RETRIEVAL: 'extension@3.6.3' }).retrieval, 'extension@3.6.3', 'an extension an earlier StudyHub installed');
  assert.equal(previewOptions(['node', 'dev.mjs'], {}).retrieval, null);
});

test('the preview can start with the extension an earlier StudyHub installed: only one older than the extension this StudyHub ships asks for an update', async t => {
  const status = async version => (await (await start(t, { retrieval: `extension@${version}` })).call('retrieval.status')).extension;
  const old = await status('3.6.3');
  assert.deepEqual([old.installed, old.version, old.outdated], [true, '3.6.3', true]);
  const repacked = await status(EXTENSION_BUILD.since);
  assert.deepEqual([repacked.installed, repacked.version, repacked.outdated], [true, EXTENSION_BUILD.since, undefined], 'the same extension, packed by an earlier release');
});

test('a preview without the fake sees no retrieval tool', async t => {
  const { call } = await start(t);
  const status = await call('retrieval.status');
  assert.equal(status.hostCanSearch, false);
  assert.deepEqual(status.providers, []);
});

test('the fake search tool finds pages of an imported converted book, through the whole host path', async t => {
  const { call } = await start(t, { retrieval: 'fake' });
  const pages = Array.from({ length: 6 }, (_, i) => `<!-- page: ${i + 1} -->\n${i === 3 ? '死锁需要互斥、持有并等待、不可抢占、循环等待四个必要条件。' : `第 ${i + 1} 页讲进程、线程和内存。`}`).join('\n\n');
  const imported = await call('materials.document.import', { dataBase64: Buffer.from(pages, 'utf8').toString('base64'), filename: 'os-book.md' });
  assert.equal(imported.sourceIds.length, 6);
  const before = await call('retrieval.status');
  assert.deepEqual(before.providers.map(provider => provider.id), [`mcp:${FAKE_RETRIEVAL_TOOL}`]);
  await call('retrieval.set', { provider: `mcp:${FAKE_RETRIEVAL_TOOL}` });
  const preview = await call('retrieval.preview', { sourceIds: imported.sourceIds, query: '死锁的必要条件' });
  assert.equal(preview.pages[0].page, 4);
  assert.match(preview.pages[0].snippet, /死锁/);
  const test = await call('retrieval.test');
  assert.equal(test.ok, true);
});

const until = async check => { for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 25)); } throw new Error('timed out'); };

test('the one-click path end to end through the host: install, approve build scripts, build the index, search it exactly', async t => {
  const release = await startFakeReleaseHost();
  const feed = process.env.STUDYHUB_QA_UPDATE_FEED;
  process.env.STUDYHUB_QA_UPDATE_FEED = release.origin;
  t.after(async () => { if (feed === undefined) delete process.env.STUDYHUB_QA_UPDATE_FEED; else process.env.STUDYHUB_QA_UPDATE_FEED = feed; await release.close(); });
  const { call } = await start(t, { retrieval: 'extension' });
  const pages = Array.from({ length: 6 }, (_, i) => `<!-- page: ${i + 1} -->\n${i === 3 ? '死锁需要互斥、持有并等待、不可抢占、循环等待这四个必要条件同时成立，只要破坏其中任何一个，系统就不会发生死锁，这是预防死锁的基本思路。' : `第 ${i + 1} 页讲进程、线程和内存，进程是资源分配的基本单位，线程是处理器调度的基本单位，二者的区别和联系是操作系统课程的重点内容。`}`).join('\n\n');
  const imported = await call('materials.document.import', { dataBase64: Buffer.from(pages, 'utf8').toString('base64'), filename: 'os-book.md', courses: ['操作系统'] });
  const before = await call('retrieval.status');
  assert.deepEqual([before.extension.canInstall, before.extension.installed, before.companion.running, before.hostCanSearch], [true, false, false, false]);
  const first = await call('retrieval.extension.install');
  assert.deepEqual(first, { status: 'needs-approval', pending: ['onnxruntime-node', 'sharp'] });
  const second = await call('retrieval.extension.install', { approvedBuilds: first.pending });
  assert.equal(second.status, 'installed');
  const after = await call('retrieval.status');
  assert.deepEqual([after.extension.installed, after.companion.running], [true, true]);
  assert.equal(after.extension.outdated, undefined, 'the extension of this release is never asked to update');
  assert.equal(after.effective, 'builtin', 'nothing is searched before an index exists');
  const plan = await call('retrieval.index.plan', { course: '操作系统' });
  assert.deepEqual([plan.pages, plan.toIndex, plan.canIndex, plan.firstRun], [6, 6, true, true]);
  await call('retrieval.index.start', { course: '操作系统' });
  const done = await until(async () => { const run = await call('retrieval.index.status'); return run.status === 'complete' ? run : null; });
  assert.equal(done.added, 6);
  const searching = await call('retrieval.status');
  assert.equal(searching.effective, 'mcp:mcp__studyhub__query_documents', 'the extension becomes the provider once it holds an index');
  const preview = await call('retrieval.preview', { sourceIds: imported.sourceIds, query: '死锁的必要条件' });
  assert.equal(preview.pages[0].page, 4);
  assert.equal(preview.unresolved, 0, 'every hit names its page exactly');
  const again = await call('retrieval.index.plan', { course: '操作系统' });
  assert.deepEqual([again.toIndex, again.unchanged], [0, 6]);
  const removed = await call('retrieval.extension.uninstall');
  assert.equal(removed.status, 'removed');
  const gone = await call('retrieval.status');
  assert.deepEqual([gone.extension.installed, gone.effective], [false, 'builtin']);
});

test('the preview search extension refuses a page with no line of 50 characters like the real server, and the build records it as skipped (#521)', async t => {
  const release = await startFakeReleaseHost();
  const feed = process.env.STUDYHUB_QA_UPDATE_FEED;
  process.env.STUDYHUB_QA_UPDATE_FEED = release.origin;
  t.after(async () => { if (feed === undefined) delete process.env.STUDYHUB_QA_UPDATE_FEED; else process.env.STUDYHUB_QA_UPDATE_FEED = feed; await release.close(); });
  const { call } = await start(t, { retrieval: 'extension' });
  const long = n => `<!-- page: ${n} -->\n进程是资源分配的基本单位，线程是处理器调度的基本单位，第 ${n} 页把二者的区别和联系讲清楚，并举例说明它们在调度时各自的开销。`;
  const slide = n => `<!-- page: ${n} -->\n进程与线程 ${n}\n- 资源分配\n- 处理器调度\n[Figure]`;
  const pages = [long(1), slide(2), slide(3), long(4), slide(5), slide(6), long(7)].join('\n\n');
  const imported = await call('materials.document.import', { dataBase64: Buffer.from(pages, 'utf8').toString('base64'), filename: 'os-slides.md', courses: ['操作系统'] });
  assert.equal(imported.sourceIds.length, 7);
  const first = await call('retrieval.extension.install');
  await call('retrieval.extension.install', { approvedBuilds: first.pending });
  await call('retrieval.index.start', { course: '操作系统' });
  const done = await until(async () => { const run = await call('retrieval.index.status'); return run.status === 'complete' || run.status === 'failed' ? run : null; });
  assert.equal(done.status, 'complete', JSON.stringify(done));
  assert.deepEqual([done.added, done.skipped, done.failedCount ?? 0], [3, 4, 0]);
  const coverage = await call('retrieval.index.coverage');
  assert.deepEqual(coverage.indexed, [0, 3, 6].map(i => imported.sourceIds[i]));
  assert.deepEqual(coverage.skipped, [1, 2, 4, 5].map(i => imported.sourceIds[i]));
  assert.deepEqual(coverage.missing, []);
  assert.deepEqual(coverage.stale, []);
  const again = await call('retrieval.index.plan', { course: '操作系统' });
  assert.deepEqual([again.toIndex, again.unchanged, again.skipped], [0, 3, 4]);
  await call('retrieval.index.start', { course: '操作系统' });
  const second = await until(async () => { const run = await call('retrieval.index.status'); return run.status === 'complete' && run.startedAt !== done.startedAt ? run : null; });
  assert.deepEqual([second.added, second.skipped], [0, 4], 'a second build sends nothing');
});
