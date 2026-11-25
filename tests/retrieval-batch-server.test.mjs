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

test('maintenance failure remains visible on the failed write batch without deadlocking read-only queries, and auto-recovers after cooldown', async () => {
  let clock = 1_000;
  const TimedServer = createBatchRAGServer(FakeRAGServer, {
    invalidInput: message => new TypeError(message),
    parseIngestDataInput(value) {
      if (!value?.metadata?.source || !value.content) throw new TypeError('invalid page');
      return structuredClone(value);
    },
    maintenanceRetryCooldownMs: 5_000,
    now: () => clock,
  });
  const server = new TimedServer(), entered = deferred(), release = deferred();
  server.onOptimize = async () => { entered.resolve(); await release.promise; throw new Error('maintenance failed'); };
  const batch = server.call(BATCH_TOOL.name, { items: [item('a')] });
  await entered.promise;
  const query = server.call('query_documents', { query: 'a' });
  release.resolve();
  const result = (await batch).structuredContent;
  assert.deepEqual(result.results, [{ source: 'a', status: 'indexed' }]);
  assert.equal(result.maintenanceError, 'maintenance failed');
  assert.equal(server.held, false);
  assert.equal(server.getMaintenanceStatus().healthy, false);

  // Read-only queries are NOT deadlocked by a write-side maintenance failure.
  assert.equal((await query).content[0].text, 'query result');
  assert.equal(server.queries, 1);

  // During the cooldown window, read-only queries run without spamming optimize() retries.
  clock += 2_000;
  await server.call('query_documents', { query: 'during cooldown' });
  assert.equal(server.queries, 2);
  assert.equal(server.maintenance, 1, 'no premature optimize retry during cooldown');

  // Once cooldown elapses and storage is healthy again, the next query auto-recovers maintenance state.
  server.onOptimize = null;
  clock += 4_000;
  await server.call('query_documents', { query: 'after cooldown recovery' });
  assert.equal(server.queries, 3);
  assert.equal(server.maintenance, 2, 'optimize retried once cooldown elapsed');
  assert.equal(server.getMaintenanceStatus().healthy, true);
  assert.equal(server.maintenanceFailure, null);
});

test('failed maintenance recovery backs off exponentially while keeping read-only queries unblocked, and successful write clears it immediately', async () => {
  let clock = 10_000;
  const TimedServer = createBatchRAGServer(FakeRAGServer, {
    invalidInput: message => new TypeError(message),
    parseIngestDataInput(value) {
      if (!value?.metadata?.source || !value.content) throw new TypeError('invalid page');
      return structuredClone(value);
    },
    maintenanceRetryCooldownMs: 1_000,
    maxMaintenanceCooldownMs: 8_000,
    now: () => clock,
  });
  const server = new TimedServer();
  server.onOptimize = async () => { throw new Error('transient lock'); };
  const failedBatch = (await server.call(BATCH_TOOL.name, { items: [item('a')] })).structuredContent;
  assert.equal(failedBatch.maintenanceError, 'transient lock');
  assert.equal(server.maintenance, 1);
  assert.equal(server.getMaintenanceStatus().attempts, 1);

  // Cooldown 1 (1s) elapses -> retry still fails -> backs off to 2s, query STILL succeeds!
  clock += 1_000;
  await server.call('query_documents', { query: 'retry 1' });
  assert.equal(server.maintenance, 2);
  assert.equal(server.queries, 1);
  assert.equal(server.getMaintenanceStatus().attempts, 2);

  // After 1.5s (< 2s backoff), no retry occurs; query still succeeds.
  clock += 1_500;
  await server.call('query_documents', { query: 'within backed-off cooldown' });
  assert.equal(server.maintenance, 2);
  assert.equal(server.queries, 2);

  // A subsequent successful write immediately clears maintenance failure regardless of cooldown.
  server.onOptimize = null;
  await server.call('ingest_data', item('b'));
  assert.equal(server.maintenance, 3);
  assert.equal(server.getMaintenanceStatus().healthy, true);
  await server.call('query_documents', { query: 'after ordinary maintenance succeeds' });
  assert.equal(server.queries, 3);
});

test('query_documents optionally filters by sourcePrefix with oversampling and strips extra args before upstream handler', async () => {
  const seenArgs = [];
  class ScopedFakeRAGServer extends FakeRAGServer {
    setupHandlers() {
      this.server.setRequestHandler(schema('tools/list'), async () => ({
        tools: [
          { name: 'ingest_data', inputSchema: { type: 'object', properties: {} } },
          { name: 'query_documents', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
        ],
      }));
      this.server.setRequestHandler(schema('tools/call'), async (request) => {
        const { name, arguments: args } = request.params;
        if (name === 'query_documents') {
          seenArgs.push(structuredClone(args));
          // Simulate 45 foreign hits followed by 5 hits from target library
          const allHits = [
            ...Array.from({ length: 45 }, (_, i) => ({ text: `foreign ${i}`, filePath: `studyhub://lib/other/source/p${i}`, score: 0.99 - i * 0.001 })),
            ...Array.from({ length: 5 }, (_, i) => ({ text: `mine ${i}`, filePath: `studyhub://lib/libA/source/p${i}`, score: 0.5 - i * 0.01 })),
          ];
          return { content: [{ type: 'text', text: JSON.stringify(allHits.slice(0, args.limit || 10)) }] };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      });
    }
  }
  const ScopedServer = createBatchRAGServer(ScopedFakeRAGServer, {
    invalidInput: message => new TypeError(message),
    parseIngestDataInput: value => value,
  });
  const server = new ScopedServer();
  const listed = await server.handlers.get('tools/list')();
  const queryTool = listed.tools.find(t => t.name === 'query_documents');
  assert.equal(queryTool.inputSchema.properties.sourcePrefix.type, 'string');
  assert.deepEqual(queryTool.inputSchema.required, ['query'], 'sourcePrefix remains optional');

  const reply = await server.call('query_documents', { query: 'deadlock', limit: 3, sourcePrefix: 'studyhub://lib/libA/source/' });
  const hits = JSON.parse(reply.content[0].text);
  assert.equal(hits.length, 3);
  assert.ok(hits.every(h => h.filePath.startsWith('studyhub://lib/libA/source/')));
  assert.equal(seenArgs.length, 2, 'oversampled a second pass when first 40 were all foreign');
  assert.ok(seenArgs.every(a => !('sourcePrefix' in a)), 'sourcePrefix is stripped before upstream handler');
});

test('sourcePrefix matches the page URI in source, not the raw filePath returned by a real reply', async () => {
  // Real query replies carry the indexed page URI in `source`; `filePath` is the local data path.
  const pageUri = 'studyhub://lib/libA/source/page-3.pdf';
  const rawPath = '/home/dev/.studyhub/data/libA/page-3.pdf';
  const hits = [
    { text: 'deadlock page', source: pageUri, filePath: rawPath, score: 0.9 },
    { text: 'foreign page', source: 'studyhub://lib/libB/source/page-1.pdf', filePath: '/home/dev/.studyhub/data/libB/page-1.pdf', score: 0.8 },
  ];
  class RealisticFakeRAGServer extends FakeRAGServer {
    setupHandlers() {
      this.server.setRequestHandler(schema('tools/list'), async () => ({
        tools: [
          { name: 'ingest_data', inputSchema: { type: 'object', properties: {} } },
          { name: 'query_documents', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
        ],
      }));
      this.server.setRequestHandler(schema('tools/call'), async (request) => {
        const { name } = request.params;
        if (name === 'query_documents') return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
        return { content: [{ type: 'text', text: 'ok' }] };
      });
    }
  }
  const RealisticServer = createBatchRAGServer(RealisticFakeRAGServer, {
    invalidInput: message => new TypeError(message),
    parseIngestDataInput: value => value,
  });
  const server = new RealisticServer();
  const reply = await server.call('query_documents', { query: 'deadlock', limit: 10, sourcePrefix: 'studyhub://lib/libA/source/' });
  const filtered = JSON.parse(reply.content[0].text);
  assert.equal(filtered.length, 1, 'page whose source is the requested library URI is kept');
  assert.equal(filtered[0].source, pageUri);
  assert.equal(filtered[0].filePath, rawPath);

  // Same shape through structuredContent.results.
  class RealisticStructuredServer extends RealisticFakeRAGServer {
    setupHandlers() {
      this.server.setRequestHandler(schema('tools/list'), async () => ({
        tools: [
          { name: 'ingest_data', inputSchema: { type: 'object', properties: {} } },
          { name: 'query_documents', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
        ],
      }));
      this.server.setRequestHandler(schema('tools/call'), async (request) => {
        const { name } = request.params;
        if (name === 'query_documents') return { structuredContent: { results: hits }, content: [{ type: 'text', text: JSON.stringify({ results: hits }) }] };
        return { content: [{ type: 'text', text: 'ok' }] };
      });
    }
  }
  const StructuredServer = createBatchRAGServer(RealisticStructuredServer, {
    invalidInput: message => new TypeError(message),
    parseIngestDataInput: value => value,
  });
  const structuredServer = new StructuredServer();
  const structuredReply = await structuredServer.call('query_documents', { query: 'deadlock', limit: 10, sourcePrefix: 'studyhub://lib/libA/source/' });
  assert.deepEqual(structuredReply.structuredContent.results.map(hit => hit.source), [pageUri]);
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
