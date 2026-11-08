import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

/* WP28 / S5: workflow.quickstart is retired and never invokes retrieval tools or models when refused. */

const TOOL = 'mcp__rag__query_documents';
const cacheQuote = '缓存命中要求请求可以使用已保存的结果，且结果没有过期。';
const netQuote = '三次握手用于在传输数据前确认双方的收发能力。';

async function setup(t, { complete, port, provider = `mcp:${TOOL}` } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wp28-flow-'));
  const home = await mkdtemp(join(tmpdir(), 'wp28-flow-home-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const service = new StudyService(root, { ...(complete ? { complete } : {}), ...(port ? { retrieval: port } : {}) });
  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
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
  call: async (_name, args) => { calls.push(args); return { content: [{ type: 'text', text: JSON.stringify([{ sourceId, text: '片段', score: 0.9 }]) }] }; } });

test('retired workflow.quickstart refuses before calling retrieval tools or models', async t => {
  const calls = [];
  let modelCalls = 0;
  const service = await setup(t, { port: portFor('src-net', calls), complete: async () => { modelCalls++; return '{}'; } });
  await assert.rejects(() => service.call('workflow.quickstart', { goal: '为什么传输前要先交换几次报文', requestId: 'go', inCourse: '课程' }), { code: 'WORKFLOW_RETIRED' });
  assert.equal(calls.length, 0);
  assert.equal(modelCalls, 0);
});
