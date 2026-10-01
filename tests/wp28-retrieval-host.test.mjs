import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { retrievalPort } from '../lib/retrieval-host.js';
import { retrieveFromPort } from '../lib/retrieval.js';
import { readRetrievalSettings, retrievalSettingsPath, saveRetrievalSettings } from '../lib/retrieval-settings.js';

/* WP28: the host adapter (DSH ctx.tools / cordis service -> port) and the stored choice. */

test('the port lists only what DSH exposes, executes a tool through ctx.tools and reads the registered service', async () => {
  const executed = [];
  const service = { retrieve: async () => [] };
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mcp__rag__query_documents', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'read_file', description: 'x', parameters: {} }],
      execute: async input => {
        executed.push(input);
        return input.name === 'mcp__rag__fail' ? { isError: true, error: { message: 'index is empty' }, content: [] }
          : { isError: false, value: { content: [{ type: 'text', text: '[]' }] }, content: [] };
      },
    },
    get: name => (name === 'studyRetrieval' ? service : undefined),
  };
  const port = retrievalPort(ctx);
  assert.deepEqual(port.tools().map(tool => tool.name), ['mcp__rag__query_documents', 'read_file']);
  assert.equal(port.service(), service);
  const value = await port.call('mcp__rag__query_documents', { query: 'q' });
  assert.deepEqual(value, { content: [{ type: 'text', text: '[]' }] });
  assert.equal(executed[0].name, 'mcp__rag__query_documents');
  assert.deepEqual(executed[0].arguments, { query: 'q' });
  assert.ok(executed[0].signal instanceof AbortSignal);
  assert.match(String(executed[0].callId), /^study-retrieval-/);
  await assert.rejects(port.call('mcp__rag__fail', {}), /index is empty/);
});

test('a host without tools or services gives an empty, harmless port', async () => {
  const port = retrievalPort({});
  assert.deepEqual(port.tools(), []);
  assert.equal(port.service(), undefined);
  await assert.rejects(port.call('mcp__x__y', {}), /工具|tool/i);
  assert.deepEqual(retrievalPort(undefined).tools(), []);
});

test('a call can be cancelled by the caller', async () => {
  const ctx = { tools: { schemas: () => [], execute: async input => { await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')))); } } };
  const controller = new AbortController();
  const pending = retrievalPort(ctx).call('mcp__a__b', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('the chosen provider is stored in the user DSH home (no secrets, never in the library)', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wp28-home-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); });
  assert.equal(retrievalSettingsPath(), join(home, 'study', 'retrieval.json'));
  assert.deepEqual(await readRetrievalSettings(), { provider: 'builtin' });
  assert.deepEqual(await saveRetrievalSettings({ provider: 'mcp:mcp__rag__query_documents', queryArg: 'question' }), { provider: 'mcp:mcp__rag__query_documents', queryArg: 'question' });
  assert.deepEqual(JSON.parse(await readFile(retrievalSettingsPath(), 'utf8')), { provider: 'mcp:mcp__rag__query_documents', queryArg: 'question' });
  assert.equal((await readRetrievalSettings()).queryArg, 'question');
  assert.deepEqual(await saveRetrievalSettings({ provider: 'service' }), { provider: 'service' });
  assert.deepEqual(await saveRetrievalSettings({ provider: 'builtin' }), { provider: 'builtin' });
  for (const bad of [{ provider: 'mcp:' }, { provider: 'https://evil.example/search' }, { provider: 'mcp:a b' }, { provider: 'service', queryArg: 'a b' }, null, []])
    await assert.rejects(saveRetrievalSettings(bad), /检索|settings|设置/i);
});

test('against the real DSH tool registry: an MCP-shaped tool is listed and runs without an agent', async t => {
  const require = createRequire(import.meta.url);
  let toolsPath;
  try { toolsPath = require.resolve('@deepseek-ai/dsh-tools'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; t.skip('Optional DSH host SDK is not installed'); return; }
  const fromTools = createRequire(toolsPath);
  const load = name => import(pathToFileURL(fromTools.resolve(name)).href);
  const [{ Context }, tools] = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools')]);
  const ctx = new Context();
  ctx.provide('systemPrompt');
  ctx.set('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 });
  const runtime = new tools.default(ctx, { mode: 'native' });
  // The shape dsh-mcp-client registers: canonical value { content: [...] }.
  const mcp = (name, execute) => tools.defineTool({ name, description: 'Semantic search over ingested documents',
    parameters: { query: { type: 'string', required: true }, limit: { type: 'integer' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] }, execute });
  runtime.register(mcp('mcp__rag__query_documents', async args => ({ content: [{ type: 'text', text: JSON.stringify([{ text: `答案：${args.query}`, page: 2, score: 0.9 }]) }] })));
  runtime.register(mcp('mcp__rag__broken', async () => { throw new Error('index is empty'); }));
  const port = retrievalPort({ tools: runtime });
  const listed = port.tools().find(tool => tool.name === 'mcp__rag__query_documents');
  assert.ok(listed, 'listed by ctx.tools.schemas()');
  assert.equal(listed.parameters.properties.query.type, 'string');
  const result = await retrieveFromPort(port, { provider: 'mcp:mcp__rag__query_documents' }, { query: '死锁', limit: 3,
    sources: [{ id: 'p1', title: 'b · p.1', text: '…', document: { id: 'h', page: 1 } }, { id: 'p2', title: 'b · p.2', text: '…', document: { id: 'h', page: 2 } }] });
  assert.deepEqual(result.passages.map(passage => [passage.sourceId, passage.text]), [['p2', '答案：死锁']]);
  await assert.rejects(port.call('mcp__rag__broken', { query: 'q' }), /index is empty/);
  await assert.rejects(port.call('mcp__rag__missing', { query: 'q' }), /./);
});
