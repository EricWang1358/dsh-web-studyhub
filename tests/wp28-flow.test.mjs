import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

/* WP28: the guided learning flow picks its material by retrieval when a provider is chosen. */

const TOOL = 'mcp__rag__query_documents';
const quote = text => text;
const cacheQuote = quote('缓存命中要求请求可以使用已保存的结果，且结果没有过期。');
const netQuote = quote('三次握手用于在传输数据前确认双方的收发能力。');

async function setup(t, { complete, port, provider = `mcp:${TOOL}` } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wp28-flow-'));
  const home = await mkdtemp(join(tmpdir(), 'wp28-flow-home-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const service = new StudyService(root, { ...(complete ? { complete } : {}), ...(port ? { retrieval: port } : {}) });
  await service.store.update(s => {
    s.sources.push({ id: 'src-cache', title: '系统设计 · p.12', text: `${cacheQuote}未命中时仍需访问原始服务。` },
      { id: 'src-net', title: '网络 · p.3', text: `${netQuote}之后才开始传输。` });
    const card = (id, topic, sourceId, text) => ({ id, topic, kind: 'flashcard', prompt: `${topic}：说明`, answer: '见原文', explanation: text, citations: [{ sourceId, quote: text }] });
    s.decks.push({ id: 'one', title: '设计笔记', folder: '课程', cards: [card('c1', '结果复用', 'src-cache', cacheQuote)] });
    s.decks.push({ id: 'two', title: '传输笔记', folder: '课程', cards: [card('n1', '连接建立', 'src-net', netQuote)] });
  });
  if (provider && port) await service.call('retrieval.set', { provider });
  return service;
}
const portFor = (sourceId, calls = []) => ({ tools: () => [{ name: TOOL, description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
  call: async (name, args) => { calls.push(args); return { content: [{ type: 'text', text: JSON.stringify([{ sourceId, text: '片段', score: 0.9 }]) }] }; } });

test('without a model, the goal is looked up by retrieval and matched to the topics whose cards cite the found pages', async t => {
  const calls = [];
  const service = await setup(t, { port: portFor('src-net', calls) });
  // No word of this goal appears in a topic or deck name, so name matching alone would find nothing.
  const { session, method } = await service.call('workflow.quickstart', { goal: '为什么传输前要先交换几次报文', requestId: 'go', inCourse: '课程' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /传输前/);
  assert.equal(method, 'match');
  assert.deepEqual(session.scope, [{ deckId: 'two', topic: '连接建立' }]);
});

test('with a model, it chooses only among the retrieved topics', async t => {
  let offered;
  const service = await setup(t, { port: portFor('src-cache'), complete: async (system, prompt) => {
    offered = JSON.parse(prompt).topics.map(topic => topic.topic);
    return JSON.stringify({ keys: JSON.parse(prompt).topics.map(topic => topic.key), title: '结果复用' });
  } });
  const { session, method } = await service.call('workflow.quickstart', { goal: '如何避免重复计算', requestId: 'go', inCourse: '课程' });
  assert.deepEqual(offered, ['结果复用']);
  assert.equal(method, 'ai');
  assert.deepEqual(session.scope.map(ref => ref.deckId), ['one']);
});

test('a provider that finds nothing, or fails, leaves the flow exactly as it was', async t => {
  const empty = await setup(t, { port: { tools: () => portFor('x').tools(), call: async () => ({ content: [] }) } });
  const first = await empty.call('workflow.quickstart', { goal: '连接建立', requestId: 'a', inCourse: '课程' });
  assert.deepEqual(first.session.scope, [{ deckId: 'two', topic: '连接建立' }], 'name matching still works');
  const failing = await setup(t, { port: { tools: () => portFor('x').tools(), call: async () => { throw new Error('connection refused'); } } });
  const second = await failing.call('workflow.quickstart', { goal: '结果复用', requestId: 'b', inCourse: '课程' });
  assert.deepEqual(second.session.scope, [{ deckId: 'one', topic: '结果复用' }]);
});

test('without a provider chosen the registered tools are never called', async t => {
  const calls = [];
  const service = await setup(t, { port: portFor('src-net', calls), provider: null });
  await service.call('workflow.quickstart', { goal: '连接建立', requestId: 'a', inCourse: '课程' });
  assert.equal(calls.length, 0);
});
