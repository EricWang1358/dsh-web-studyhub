import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

/* WP28: generation over a large textbook. With a retrieval provider only the
   retrieved pages are sent; without one the behaviour is what it was. */

const repo = fileURLToPath(new URL('../', import.meta.url));
const TOOL = 'mcp__rag__query_documents';
const toolSchema = { name: TOOL, description: 'Semantic search over ingested documents', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } };

const filler = n => `第${n}页的普通说明文字，用来填充篇幅并保持原文足够长。`.repeat(95);
const pageText = n => n === 17 ? `死锁需要互斥、持有并等待、不可抢占、循环等待四个必要条件才会出现。${filler(n)}`
  : n === 33 ? `页表把虚拟页映射到物理帧，并由 TLB 缓存最近的映射结果。${filler(n)}` : filler(n);
const book = pages => Array.from({ length: pages }, (_, i) => `<!-- page: ${i + 1} -->\n${i % 20 === 0 ? `# 第 ${i / 20 + 1} 章\n` : ''}${pageText(i + 1)}`).join('\n\n');

async function setup(t, { pages = 80, port, provider } = {}) {
  const home = await mkdtemp(join(await ensure(join(repo, 'output', 'test-wp28')), 'home-'));
  const root = await mkdtemp(join(await ensure(join(repo, 'output', 'test-wp28')), 'lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const sent = [];
  const fake = createFakeModel();
  const model = async (system, prompt, ...rest) => { sent.push(String(prompt)); return fake(system, prompt, ...rest); };
  const service = new StudyService(root, { complete: model, completeLight: model, coach: false, ...(port ? { retrieval: port } : {}) });
  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const imported = await service.call('materials.document.import', { dataBase64: Buffer.from(book(pages), 'utf8').toString('base64'), filename: 'os-book.md', courses: ['OS'] });
  if (provider) await service.call('retrieval.set', { provider });
  return { service, sent, ids: imported.sourceIds };
}
const ensure = async path => { await mkdir(path, { recursive: true }); return path; };
const hit = (id, text, score) => ({ sourceId: id, text, score });
const portReturning = (hits, calls = []) => ({ tools: () => [toolSchema], call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: JSON.stringify(hits()) }] }; } });
async function run(service, args) {
  const { jobId } = await service.call('generate', { title: 'OS', count: 3, kind: 'quiz', ...args });
  return service.call('job.wait', { jobId, timeoutSeconds: 120 });
}

test('with a provider, a large selection sends only the retrieved pages and the job says which', async t => {
  const calls = [];
  const ids = [];
  const port = portReturning(() => [hit(ids[16], '死锁', 0.95), hit(ids[32], '页表', 0.6)], calls);
  const ctx = await setup(t, { port, provider: `mcp:${TOOL}` });
  ids.push(...ctx.ids);
  const job = await run(ctx.service, { sourceIds: ctx.ids, focus: '死锁的四个必要条件' });
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, TOOL);
  assert.match(calls[0].args.query, /死锁/);
  assert.deepEqual(job.sourceIds, [ctx.ids[16], ctx.ids[32]]);
  assert.equal(job.retrieval.provider, `mcp:${TOOL}`);
  assert.deepEqual(job.retrieval.used.map(page => page.page), [17, 33]);
  assert.equal(job.retrieval.selected, 80);
  const prompts = ctx.sent.join('\n');
  assert.match(prompts, /死锁需要互斥/);
  assert.doesNotMatch(prompts, /第50页的普通说明/, 'pages that were not retrieved are not sent');
  assert.doesNotMatch(prompts, /第2页的普通说明/);
});

test('without a provider the behaviour is unchanged: every selected page goes to the model', async t => {
  const ctx = await setup(t, { pages: 80 });
  const job = await run(ctx.service, { sourceIds: ctx.ids, focus: '死锁', count: 3 });
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.sourceIds.length, 80);
  assert.equal(job.retrieval, undefined);
  assert.match(ctx.sent.join('\n'), /第50页的普通说明/);
});

test('a selection under the retrieval threshold is not narrowed even when a provider is chosen', async t => {
  const calls = [];
  const ctx = await setup(t, { pages: 12, port: portReturning(() => [], calls), provider: `mcp:${TOOL}` });
  const job = await run(ctx.service, { sourceIds: ctx.ids, focus: '死锁' });
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(calls.length, 0);
  assert.equal(job.sourceIds.length, 12);
});

test('over the limit without a provider: the old message plus a code the page uses to recommend tools', async t => {
  const ctx = await setup(t, { pages: 300 });
  await assert.rejects(ctx.service.call('generate', { sourceIds: ctx.ids, count: 3, kind: 'quiz', title: 'big' }),
    error => /limit is 600000/.test(error.message) && error.code === 'selection-too-large');
});

test('over the limit with a provider but no topic: asks for a topic instead of guessing', async t => {
  const ctx = await setup(t, { pages: 300, port: portReturning(() => []), provider: `mcp:${TOOL}` });
  await assert.rejects(ctx.service.call('generate', { sourceIds: ctx.ids, count: 3, kind: 'quiz', title: 'big' }),
    error => error.code === 'retrieval-needs-topic' && /主题/.test(error.message));
});

test('over the limit with a provider and a topic: narrowed and generated', async t => {
  const ids = [];
  const ctx = await setup(t, { pages: 300, port: portReturning(() => [hit(ids[16], '死锁', 0.9)]), provider: `mcp:${TOOL}` });
  ids.push(...ctx.ids);
  const job = await run(ctx.service, { sourceIds: ctx.ids, focus: '死锁', count: 2 });
  assert.equal(job.status, 'complete', job.stage);
  assert.deepEqual(job.sourceIds, [ctx.ids[16]]);
});

test('a provider that fails does not block a selection that fits: generation continues and the job records why', async t => {
  const port = { tools: () => [toolSchema], call: async () => { throw new Error('connection refused'); } };
  const ctx = await setup(t, { pages: 80, port, provider: `mcp:${TOOL}` });
  const job = await run(ctx.service, { sourceIds: ctx.ids, focus: '死锁' });
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.sourceIds.length, 80);
  assert.match(job.retrieval.error, /connection refused/);
});

test('a provider that fails over the limit stops with its own words', async t => {
  const port = { tools: () => [toolSchema], call: async () => { throw new Error('connection refused'); } };
  const ctx = await setup(t, { pages: 300, port, provider: `mcp:${TOOL}` });
  await assert.rejects(ctx.service.call('generate', { sourceIds: ctx.ids, focus: '死锁', count: 3, kind: 'quiz' }), /connection refused/);
});

test('retrieval.status lists what the host exposes and never claims a tool that is not there', async t => {
  const none = await setup(t, { pages: 3 });
  const empty = await none.service.call('retrieval.status', {});
  assert.equal(empty.selected, 'builtin');
  assert.equal(empty.effective, 'builtin');
  assert.equal(empty.hostCanSearch, false);
  assert.deepEqual(empty.providers, []);
  assert.deepEqual(empty.otherTools, []);
  const calls = [];
  const ids = [];
  const found = await setup(t, { pages: 3, port: portReturning(() => [hit(ids[0], '内容', 0.5)], calls) });
  ids.push(...found.ids);
  const before = await found.service.call('retrieval.status', {});
  assert.equal(before.effective, 'builtin');
  assert.deepEqual(before.providers.map(provider => provider.id), [`mcp:${TOOL}`]);
  const after = await found.service.call('retrieval.set', { provider: `mcp:${TOOL}` });
  assert.equal(after.effective, `mcp:${TOOL}`);
  await assert.rejects(found.service.call('retrieval.set', { provider: 'mcp:mcp__ghost__search' }), /找不到|not found/i);
});

test('retrieval.preview shows which pages would be used, and retrieval.test proves the tool answers', async t => {
  const ids = [];
  const ctx = await setup(t, { pages: 40, port: portReturning(() => [hit(ids[16], '死锁', 0.9), hit(ids[3], '进程', 0.4), { text: '别的书里的内容很长很长很长很长很长', score: 0.3 }]), provider: `mcp:${TOOL}` });
  ids.push(...ctx.ids);
  const preview = await ctx.service.call('retrieval.preview', { sourceIds: ctx.ids, query: '死锁', limit: 5 });
  assert.equal(preview.provider, `mcp:${TOOL}`);
  assert.deepEqual(preview.pages.map(page => page.page), [4, 17]);
  assert.equal(preview.unresolved, 1);
  assert.ok(preview.pages.every(page => page.snippet && page.sourceId));
  const probe = await ctx.service.call('retrieval.test', {});
  assert.equal(probe.ok, true);
  assert.equal(probe.matched, 2);
  const builtin = await setup(t, { pages: 3 });
  assert.deepEqual(await builtin.service.call('retrieval.preview', { sourceIds: builtin.ids, query: 'x' }), { provider: 'builtin', pages: [], unresolved: 0, hits: 0 });
});
