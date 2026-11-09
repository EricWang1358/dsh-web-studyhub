import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createBatchRAGServer, BATCH_TOOL } from '../packages/studyhub-retrieval/batch-server.js';

const schema = method => ({ shape: { method: { value: method } } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const item = source => ({ content: `Page ${source}`, metadata: { source, format: 'markdown' } });
const extra = { signal: new AbortController().signal };

class FakeRAGServer {
  constructor() {
    this.handlers = new Map(); this.writes = []; this.maintenance = 0; this.queries = 0; this.held = false;
    this.server = { setRequestHandler: (schema, handler) => this.handlers.set(schema.shape.method.value, handler) };
    this.vectorStore = { optimize: async () => { this.maintenance++; await this.onOptimize?.(); } };
    this.setupHandlers();
  }
  acquireMutation() { if (this.held) return { isError: true, content: [{ type: 'text', text: 'busy' }] }; this.held = true; return null; }
  releaseMutation() { this.held = false; }
  setupHandlers() {
    // Equivalent schemas can come from separate ESM and CommonJS SDK instances.
    this.server.setRequestHandler(schema('tools/list'), async () => ({ tools: [{ name: 'ingest_data' }, { name: 'query_documents' }] }));
    this.server.setRequestHandler(schema('tools/call'), async (request, context) => {
      const { name, arguments: args } = request.params;
      if (name === 'query_documents') { await this.onQuery?.(); this.queries++; return { context, content: [{ type: 'text', text: 'query result' }] }; }
      const overlap = this.acquireMutation();
      if (overlap) return overlap;
      try { return await this.handleIngestData(args); } finally { this.releaseMutation(); }
    });
  }
  async handleIngestData(args) {
    await this.onIngest?.(args);
    this.writes.push(args.metadata.source);
    await this.vectorStore.optimize();
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  call(name, args, context = extra) { return this.handlers.get('tools/call')({ params: { name, arguments: args } }, context); }
}
const Server = createBatchRAGServer(FakeRAGServer, {
  invalidInput: message => new TypeError(message),
  parseIngestDataInput(value) {
    if (!value?.metadata?.source || !value.content) throw new TypeError('invalid page');
    return structuredClone(value);
  },
});

test('the registered batch tool writes at most eight validated pages and maintains once', async () => {
  const server = new Server();
  const listed = await server.handlers.get('tools/list')();
  assert.equal(listed.tools.at(-1).name, BATCH_TOOL.name);
  const sources = Array.from({ length: 8 }, (_, n) => String(n));
  const answer = await server.call(BATCH_TOOL.name, { items: sources.map(item) });
  assert.deepEqual(answer.structuredContent.results, sources.map(source => ({ source, status: 'indexed' })));
  assert.deepEqual(JSON.parse(answer.content[0].text), answer.structuredContent);
  assert.deepEqual(server.writes, sources);
  assert.equal(server.maintenance, 1);
  assert.equal(server.held, false);
});

test('invalid batch size and invalid later pages fail before any write', async () => {
  const server = new Server();
  for (const items of [[], Array.from({ length: 9 }, (_, n) => item(String(n))), [item('ok'), {}]]) {
    await assert.rejects(server.call(BATCH_TOOL.name, { items }));
    assert.equal(server.held, false);
  }
  assert.deepEqual(server.writes, []);
  assert.equal(server.maintenance, 0);
});

test('a partial failure stops the batch, no-chunks is reported separately, and maintenance still runs', async () => {
  const server = new Server();
  server.onIngest = async ({ metadata }) => {
    if (metadata.source === 'blank') throw new Error('No chunks generated from file');
    if (metadata.source === 'bad') throw new Error('disk failed');
  };
  const result = (await server.call(BATCH_TOOL.name, { items: ['good', 'blank', 'bad', 'later'].map(item) })).structuredContent;
  assert.deepEqual(result.results.map(row => [row.source, row.status]), [['good', 'indexed'], ['blank', 'no-chunks'], ['bad', 'failed']]);
  assert.deepEqual(server.writes, ['good']);
  assert.equal(server.maintenance, 1);
  await server.call('ingest_data', item('normal'));
  assert.equal(server.maintenance, 2, 'ordinary writes retain normal maintenance');
});

test('cancel stops between pages and finalizes the accepted page', async () => {
  const server = new Server(), controller = new AbortController();
  server.onIngest = async () => { controller.abort(); };
  const result = (await server.call(BATCH_TOOL.name, { items: ['a', 'b'].map(item) }, { signal: controller.signal })).structuredContent;
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.results, [{ source: 'a', status: 'indexed' }]);
  assert.deepEqual(server.writes, ['a']);
  assert.equal(server.maintenance, 1);
  assert.equal(server.held, false);
});

test('the writer slot spans maintenance and queries wait for refreshed search data', async () => {
  const server = new Server(), entered = deferred(), release = deferred();
  server.onOptimize = async () => { entered.resolve(); await release.promise; };
  const batch = server.call(BATCH_TOOL.name, { items: [item('a')] });
  await entered.promise;
  assert.equal((await server.call('ingest_data', item('overlap'))).isError, true);
  assert.equal((await server.call(BATCH_TOOL.name, { items: [item('overlap')] })).isError, true);
  const query = server.call('query_documents', { query: 'a' });
  await Promise.resolve(); assert.equal(server.queries, 0);
  const cancelled = new AbortController();
  const waiting = server.call('query_documents', { query: 'a' }, { signal: cancelled.signal });
  cancelled.abort(new Error('query cancelled'));
  await assert.rejects(waiting, /query cancelled/);
  release.resolve(); await batch;
  assert.equal((await query).context, extra, 'the original handler receives its context');
  assert.equal(server.queries, 1);
});

test('maintenance failure remains visible alongside committed results and restores ordinary writes', async () => {
  const server = new Server(), entered = deferred(), release = deferred();
  server.onOptimize = async () => { entered.resolve(); await release.promise; throw new Error('maintenance failed'); };
  const batch = server.call(BATCH_TOOL.name, { items: [item('a')] });
  await entered.promise;
  const query = server.call('query_documents', { query: 'a' });
  release.resolve();
  const result = (await batch).structuredContent;
  await assert.rejects(query, /maintenance failed/);
  assert.equal(server.queries, 0);
  assert.deepEqual(result.results, [{ source: 'a', status: 'indexed' }]);
  assert.equal(result.maintenanceError, 'maintenance failed');
  assert.equal(server.held, false);
  await assert.rejects(server.call('query_documents', { query: 'after the failed batch' }), /maintenance failed/);
  assert.equal(server.queries, 0);
  server.onOptimize = null;
  await server.call('ingest_data', item('b'));
  assert.equal(server.maintenance, 2);
  await server.call('query_documents', { query: 'after ordinary maintenance succeeds' });
  assert.equal(server.queries, 1);
});

test('successful batch maintenance reopens queries after an earlier maintenance failure', async () => {
  const server = new Server();
  server.onOptimize = async () => { throw new Error('maintenance failed'); };
  await server.call(BATCH_TOOL.name, { items: [item('a')] });
  await assert.rejects(server.call('query_documents', { query: 'unmaintained index' }), /maintenance failed/);
  server.onOptimize = null;
  await server.call(BATCH_TOOL.name, { items: [item('a')] });
  await server.call('query_documents', { query: 'repaired index' });
  assert.equal(server.queries, 1);
  assert.equal(server.maintenance, 2);
});

test('a batch waits for an earlier query through embedding and database reads', async () => {
  const server = new Server(), entered = deferred(), release = deferred();
  server.onQuery = async () => { entered.resolve(); await release.promise; assert.deepEqual(server.writes, []); };
  const query = server.call('query_documents', { query: 'previous index' });
  await entered.promise;
  const batch = server.call(BATCH_TOOL.name, { items: [item('next')] });
  await setImmediate();
  assert.deepEqual(server.writes, [], 'no batch write overlaps the query handler');
  release.resolve();
  await query;
  await batch;
  assert.deepEqual(server.writes, ['next']);
});
