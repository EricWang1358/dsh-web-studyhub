import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localizeAppMessage } from '../lib/application-messages.js';
import { RetrievalError, argsForTool, retrieveFromPort } from '../lib/retrieval.js';
import { retrievalPort } from '../lib/retrieval-host.js';
import { saveRetrievalSettings } from '../lib/retrieval-settings.js';
import { narrowSelection } from '../lib/contexts/generation/retrieval-operations.js';
import { ToolCatalogLabels } from './helpers/wp28-labels.mjs';

/* WP28: every sentence the retrieval code can send to a learner has an English form. */

const han = /[㐀-鿿]/;
const english = text => localizeAppMessage(text, 'en');

async function messages() {
  const found = [];
  const note = async run => { try { await run(); } catch (error) { found.push(error.message); } };
  const home = await mkdtemp(join(tmpdir(), 'wp28-msg-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await note(() => retrieveFromPort({ tools: () => [], call: async () => ({}) }, { provider: 'mcp:mcp__gone__search' }, { query: 'q', sources: [] }));
    await note(() => retrieveFromPort({ tools: () => [], call: async () => ({}), service: () => undefined }, { provider: 'service' }, { query: 'q', sources: [] }));
    await note(() => argsForTool({ type: 'object', properties: { query: { type: 'string' }, index: { type: 'string' } }, required: ['query', 'index'] }, { query: 'q', limit: 3 }));
    await note(() => argsForTool({ type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } } }, { query: 'q', limit: 3 }));
    await note(() => retrievalPort({}).call('mcp__x__y', {}));
    await note(() => retrievalPort({ tools: { schemas: () => [], execute: async () => ({ isError: true, error: {}, content: [] }) } }).call('mcp__x__y', {}));
    for (const bad of [null, { provider: 'mcp:' }, { provider: 'builtin', queryArg: 'a b' }]) await note(() => saveRetrievalSettings(bad));
    await saveRetrievalSettings({ provider: 'mcp:mcp__rag__q' });
    const port = { tools: () => [{ name: 'mcp__rag__q', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }], call: async () => ({ content: [] }) };
    const sources = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, title: `t${i}`, text: 'x'.repeat(2500) }));
    await note(() => narrowSelection({ port, sources, request: { focus: '' } }));
    await note(() => narrowSelection({ port, sources, request: { focus: '主题' } }));
  } finally { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); }
  return found;
}

test('every retrieval message a learner can see is translated, with its details kept', async () => {
  const found = await messages();
  assert.ok(found.length >= 10, `collected ${found.length} messages`);
  for (const message of found) assert.doesNotMatch(english(message), han, message);
  assert.match(english(new RetrievalError('retrieval-missing', '已选择的检索工具「mcp__gone__search」现在找不到。请确认它在 DSH 里已启用，或到设置里换一个。').message), /mcp__gone__search/);
  assert.match(english(found.find(message => /「index」/.test(message))), /index/);
  assert.match(english(found.find(message => /写下主题/.test(message))), /[\d,]{7}/, 'the size is kept');
});

test('the catalogue labels all have an English form', () => {
  assert.ok(ToolCatalogLabels.length >= 10);
  for (const { zh, en } of ToolCatalogLabels) assert.doesNotMatch(en, han, zh);
});

test('the search extension\'s install and index messages are translated too', async () => {
  const { installExtension, uninstallExtension, extensionAssetName } = await import('../lib/retrieval-extension.js');
  const { buildIndex, INDEX_TOOLS } = await import('../lib/retrieval-index.js');
  const found = [];
  const note = async run => { try { await run(); } catch (error) { found.push(error.message); } };
  const bytes = Buffer.from('x'), sum = createHash('sha256').update(bytes).digest('hex');
  const body = buffer => ({ ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) });
  const dir = await mkdtemp(join(tmpdir(), 'wp28b-msg-'));
  const good = async url => body(url.endsWith('.tgz') ? bytes : Buffer.from(`${sum}  ${extensionAssetName('2.1.1')}\n`));
  const result = value => ({ installBundle: async () => value });
  try {
    await note(() => installExtension({ manager: {}, version: '2.1.1', fetch: good, dir }));
    await note(() => installExtension({ manager: result({}), version: '2.1.1', fetch: async () => { throw new Error('offline'); }, dir }));
    await note(() => installExtension({ manager: result({}), version: '2.1.1', fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }), dir }));
    await note(() => installExtension({ manager: result({}), version: '2.1.1', fetch: async url => url.endsWith('.tgz') ? body(Buffer.from('bad')) : good(url), dir }));
    await note(() => installExtension({ manager: result({}), version: '2.1.1', fetch: async url => url.endsWith('.tgz') ? good(url) : body(Buffer.from('')), dir }));
    for (const kind of ['network', 'no-matching-version', 'disk-full', 'permission', 'pnpm-missing', 'build-blocked', 'timeout', 'integrity', 'mystery'])
      await note(() => installExtension({ manager: result({ application: 'failed', packageResult: { kind } }), version: '2.1.1', fetch: good, dir }));
    await note(() => installExtension({ manager: result({ application: 'failed', error: { code: 'incompatible-version' } }), version: '2.1.1', fetch: good, dir }));
    await note(() => installExtension({ manager: { installBundle: async () => { throw new Error('boom'); } }, version: '2.1.1', fetch: good, dir }));
    await note(() => uninstallExtension({ manager: {} }));
    await note(() => uninstallExtension({ manager: { removeBundle: async () => ({ application: 'failed' }) } }));
    const sources = [{ id: 'a', title: 't', text: 'x' }];
    await note(() => buildIndex({ port: { tools: () => [], call: async () => ({}) }, sources, library: ['a'], manifest: { sources: {} } }));
    const tools = () => [{ name: INDEX_TOOLS.ingest, parameters: {} }];
    await note(() => buildIndex({ port: { tools, call: async () => { throw new Error('getaddrinfo ENOTFOUND huggingface.co'); } }, sources, library: ['a'], manifest: { sources: {} } }));
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: 't', text: `x${i}` }));
    await note(() => buildIndex({ port: { tools, call: async () => { throw new Error('parse failed'); } }, sources: many, library: many.map(s => s.id), manifest: { sources: {} } }));
    await note(() => saveRetrievalSettings({ provider: 'builtin', hfEndpoint: 'http://insecure' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.ok(found.length >= 20, `collected ${found.length} messages`);
  for (const message of found) assert.doesNotMatch(english(message), han, message);
  assert.match(english(found.find(message => /连续/.test(message))), /parse failed/, 'the detail of a failure is kept');
});
