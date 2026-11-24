import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  INDEX_KEY_VERSION,
  INDEX_TOOLS,
  MAX_CACHE_FILENAME_LENGTH,
  buildIndex,
  cacheFilenameLength,
  legacySourceKey,
  parseSourceKey,
  planIndex,
  scopedSourcePrefix,
  sourceKey,
} from '../lib/retrieval-index.js';
import { normalizeHits, resolveHits, retrieveFromPort } from '../lib/retrieval.js';
import {
  BATCH_TOOL,
  MAX_CACHE_FILENAME_BYTES,
  assertSafeCacheFilename,
  createBatchRAGServer,
  rawDataFilenameLength,
  shortCacheKey,
} from '../packages/studyhub-retrieval/batch-server.js';

const NTFS_MAX_FILENAME = 255;
const HEX64_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX64_B = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
const LIB_A = '0123456789abcdef';
const LIB_B = 'fedcba9876543210';

const longDocumentSourceId = (page) => `document-${HEX64_A}-pdf-${HEX64_B}-pdf-conv1-p${page}`;
const legacyPdfSourceId = (page) => `pdf-${HEX64_A}-text2-p${page}`;

const encodeBase64Url = (value) => Buffer.from(String(value), 'utf8').toString('base64url');
const decodeBase64Url = (value) => Buffer.from(String(value), 'base64url').toString('utf8');
const schema = (method) => ({ shape: { method: { value: method } } });
const extra = { signal: new AbortController().signal };

/**
 * Simulates mcp-local-rag@0.20.0's exact raw-data Base64URL cache behavior plus Windows NTFS's
 * 255-character single-filename hard cap (throws ENOENT when basename > 255, matching issue #1451).
 */
class NtfsLikeRAGServer {
  constructor(config = {}) {
    this.dbPath = config.dbPath;
    this.handlers = new Map();
    this.held = false;
    this.chunksByFilePath = new Map();
    this.vectorStore = {
      optimize: async () => {},
      deleteChunks: async (targetPath) => {
        const existed = this.chunksByFilePath.delete(targetPath);
        return existed ? 1 : 0;
      },
    };
    this.server = {
      setRequestHandler: (reqSchema, handler) => this.handlers.set(reqSchema.shape.method.value, handler),
    };
    this.setupHandlers();
  }

  rawDataDir() {
    return join(this.dbPath, 'raw-data');
  }

  rawDataPathFor(source) {
    return join(this.rawDataDir(), `${encodeBase64Url(source)}.md`);
  }

  metaPathFor(mdPath) {
    return mdPath.replace(/\.md$/, '.meta.json');
  }

  assertNtfsLimit(filePath) {
    const name = basename(filePath);
    if (name.length > NTFS_MAX_FILENAME) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' });
    }
  }

  acquireMutation() {
    if (this.held) return { isError: true, content: [{ type: 'text', text: 'busy' }] };
    this.held = true;
    return null;
  }

  releaseMutation() {
    this.held = false;
  }

  setupHandlers() {
    this.server.setRequestHandler(schema('tools/list'), async () => ({
      tools: [
        { name: 'ingest_data', inputSchema: { type: 'object', properties: {} } },
        { name: 'delete_file', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'query_documents',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(schema('tools/call'), async (request) => {
      const { name, arguments: args } = request.params;
      if (name === 'query_documents') {
        const limit = Number(args?.limit) || 10;
        const results = [...this.chunksByFilePath.entries()].slice(0, limit).map(([filePath, text], index) => {
          const base = basename(filePath);
          const encoded = base.slice(0, base.lastIndexOf('.'));
          return {
            filePath,
            source: decodeBase64Url(encoded),
            text,
            score: 0.99 - index * 0.01,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      }
      if (name === 'delete_file') {
        const overlap = this.acquireMutation();
        if (overlap) return overlap;
        try {
          return await this.handleDeleteFile(args);
        } finally {
          this.releaseMutation();
        }
      }
      if (name === 'ingest_data') {
        const overlap = this.acquireMutation();
        if (overlap) return overlap;
        try {
          return await this.handleIngestData(args);
        } finally {
          this.releaseMutation();
        }
      }
      throw new Error(`unexpected tool ${name}`);
    });
  }

  async handleIngestData(args) {
    const mdPath = this.rawDataPathFor(args.metadata.source);
    const metaPath = this.metaPathFor(mdPath);
    this.assertNtfsLimit(mdPath);
    this.assertNtfsLimit(metaPath);
    await mkdir(this.rawDataDir(), { recursive: true });
    await writeFile(mdPath, args.content, 'utf8');
    await writeFile(metaPath, JSON.stringify({ source: args.metadata.source, format: args.metadata.format }), 'utf8');
    this.chunksByFilePath.set(mdPath, args.content);
    await this.vectorStore.optimize();
    return { content: [{ type: 'text', text: JSON.stringify({ filePath: mdPath, ok: true }) }] };
  }

  async handleDeleteFile(args) {
    const mdPath = this.rawDataPathFor(args.source);
    const metaPath = this.metaPathFor(mdPath);
    const removedChunks = await this.vectorStore.deleteChunks(mdPath);
    await this.vectorStore.optimize();
    await unlink(mdPath).catch(() => {});
    await unlink(metaPath).catch(() => {});
    return { content: [{ type: 'text', text: JSON.stringify({ filePath: mdPath, deleted: true, removedChunks, existed: removedChunks > 0 }) }] };
  }

  call(name, args, context = extra) {
    return this.handlers.get('tools/call')({ params: { name, arguments: args } }, context);
  }
}

const WrappedServer = createBatchRAGServer(NtfsLikeRAGServer, {
  invalidInput: (message) => new TypeError(message),
  parseIngestDataInput(value) {
    if (!value?.metadata?.source || !value.content) throw new TypeError('invalid page');
    return structuredClone(value);
  },
});

test('#1451: sourceKey keeps cache filenames well under NTFS 255 for long document sourceIds while preserving library isolation', () => {
  const longId = longDocumentSourceId(1);
  const rawLegacy = legacySourceKey(longId, LIB_A);
  assert.ok(cacheFilenameLength(rawLegacy) > NTFS_MAX_FILENAME, 'repro precondition: raw Base64 cache filename exceeds NTFS 255');

  const keyA = sourceKey(longId, LIB_A);
  const keyB = sourceKey(longId, LIB_B);
  assert.ok(keyA.startsWith(scopedSourcePrefix(LIB_A)), 'hashed key preserves library URI prefix');
  assert.ok(keyB.startsWith(scopedSourcePrefix(LIB_B)), 'hashed key preserves foreign library URI prefix');
  assert.notEqual(keyA, keyB);
  assert.ok(cacheFilenameLength(keyA) <= MAX_CACHE_FILENAME_LENGTH, `cache filename length ${cacheFilenameLength(keyA)} must stay <= ${MAX_CACHE_FILENAME_LENGTH}`);

  // Even an arbitrarily huge 800-character sourceId produces the exact same fixed-length hashed key.
  const hugeKey = sourceKey(`document-${'z'.repeat(800)}-p999`, LIB_A);
  assert.equal(hugeKey.length, keyA.length, 'hashed sourceKey must be fixed-length');
  assert.ok(cacheFilenameLength(hugeKey) <= MAX_CACHE_FILENAME_LENGTH);

  // Short legacy sourceIds stay unchanged so existing short indexes do not unnecessarily churn.
  const shortId = legacyPdfSourceId(1);
  assert.equal(sourceKey(shortId, LIB_A), `studyhub://lib/${LIB_A}/source/${shortId}`);

  // parseSourceKey and resolveHits round-trip hashed keys and strictly reject foreign libraries.
  const parsed = parseSourceKey(keyA);
  assert.equal(parsed?.scoped, true);
  assert.equal(parsed?.libraryId, LIB_A);
  assert.equal(parsed?.hashed, true);

  const sources = [{ id: longId, title: 'Ch1 p.1', text: 'Virtual memory maps virtual pages to physical frames.' }];
  const hits = normalizeHits([
    { filePath: `C:\\Users\\x\\.dsh\\study\\retrieval\\lancedb\\raw-data\\${encodeBase64Url(keyB)}.md`, source: keyB, text: 'Foreign copy', score: 0.99 },
    { filePath: `C:\\Users\\x\\.dsh\\study\\retrieval\\lancedb\\raw-data\\${encodeBase64Url(keyA)}.md`, source: keyA, text: 'Target copy', score: 0.80 },
  ]);
  const resolved = resolveHits(hits, sources, { libraryId: LIB_A });
  assert.equal(resolved.foreignLibrary, 1);
  assert.equal(resolved.passages.length, 1);
  assert.equal(resolved.passages[0].sourceId, longId);
  assert.equal(resolved.passages[0].matchedBy, 'id');
});

test('#1451: batch-server writes fixed-length hashed cache filenames under raw-data/, persists source-map across restarts, and guards >240 length', async (t) => {
  const dbPath = await mkdtemp(join(tmpdir(), 'studyhub-1451-db-'));
  t.after(() => rm(dbPath, { recursive: true, force: true }));

  const rawLongUris = Array.from({ length: 5 }, (_, i) => `studyhub://lib/${LIB_A}/source/${longDocumentSourceId(i + 1)}`);
  for (const uri of rawLongUris) {
    assert.ok(rawDataFilenameLength(uri) > NTFS_MAX_FILENAME, 'raw URI would fail NTFS 255');
    assert.ok(rawDataFilenameLength(shortCacheKey(uri)) <= 64, 'short hash cache filename is fixed-length and short');
  }

  assert.throws(
    () => assertSafeCacheFilename(rawLongUris[0], rawLongUris[0]),
    /cache file name too long/i,
    'pre-write guard must throw explicit length error instead of ENOENT',
  );
  assert.equal(MAX_CACHE_FILENAME_BYTES, 240);

  const server1 = new WrappedServer({ dbPath });
  const batchReply = await server1.call(BATCH_TOOL.name, {
    items: rawLongUris.map((uri, i) => ({
      content: `# Page ${i + 1}\n\nContent for page ${i + 1} discussing page tables.`,
      metadata: { source: uri, format: 'markdown' },
    })),
  });
  assert.deepEqual(
    batchReply.structuredContent.results,
    rawLongUris.map((source) => ({ source, status: 'indexed' })),
    'batch receipt preserves original URIs and succeeds for all 5 long-URI pages under NTFS 255 cap',
  );

  // Every physical file under raw-data/ must stay far below 240 chars.
  const rawFiles = await readdir(join(dbPath, 'raw-data'));
  assert.equal(rawFiles.length, 10, '5 .md + 5 .meta.json files');
  for (const name of rawFiles) {
    assert.ok(name.length <= 64, `expected short fixed-length cache filename, got ${name.length}: ${name}`);
  }

  // Simulate process restart: a brand-new server instance loads persisted source-map.json and restores original URIs.
  const server2 = new WrappedServer({ dbPath });
  for (const [filePath, text] of server1.chunksByFilePath.entries()) {
    server2.chunksByFilePath.set(filePath, text);
  }
  const queryReply = await server2.call('query_documents', {
    query: 'page tables',
    limit: 5,
    sourcePrefix: `studyhub://lib/${LIB_A}/source/`,
  });
  const hits = JSON.parse(queryReply.content[0].text);
  assert.equal(hits.length, 5);
  assert.deepEqual(
    hits.map((h) => h.source).sort(),
    [...rawLongUris].sort(),
    'restarted server restores original long URIs from persisted source-map and honors sourcePrefix',
  );
});

test('#1451: batch-server remains backward compatible with legacy Base64 raw-data cache and migrates/deletes legacy entries cleanly', async (t) => {
  const dbPath = await mkdtemp(join(tmpdir(), 'studyhub-1451-legacy-'));
  t.after(() => rm(dbPath, { recursive: true, force: true }));

  const legacyUriA = `studyhub://lib/${LIB_A}/source/${legacyPdfSourceId(1)}`;
  const legacyUriB = `studyhub://lib/${LIB_A}/source/${legacyPdfSourceId(2)}`;
  const server = new WrappedServer({ dbPath });

  // Seed legacy Base64 cache files directly via base class (simulating index built before #1451 fix).
  await NtfsLikeRAGServer.prototype.handleIngestData.call(server, {
    content: '# Legacy Page 1\n\nLegacy cached content A.',
    metadata: { source: legacyUriA, format: 'markdown' },
  });
  await NtfsLikeRAGServer.prototype.handleIngestData.call(server, {
    content: '# Legacy Page 2\n\nLegacy cached content B.',
    metadata: { source: legacyUriB, format: 'markdown' },
  });
  const legacyPathA = server.rawDataPathFor(legacyUriA);
  const legacyPathB = server.rawDataPathFor(legacyUriB);
  assert.equal(server.chunksByFilePath.size, 2);

  // 1) Before any re-ingest, legacy Base64 cached entries remain immediately queryable with sourcePrefix.
  const beforeReply = await server.call('query_documents', {
    query: 'Legacy cached',
    limit: 10,
    sourcePrefix: `studyhub://lib/${LIB_A}/source/`,
  });
  const beforeHits = JSON.parse(beforeReply.content[0].text);
  assert.deepEqual(beforeHits.map((h) => h.source).sort(), [legacyUriA, legacyUriB].sort());

  // 2) Re-ingesting legacyUriA writes the new short hash cache file AND removes the old Base64 cache/chunks (no duplicates!).
  await server.call('ingest_data', {
    content: '# Legacy Page 1\n\nUpdated content A migrated to short hash.',
    metadata: { source: legacyUriA, format: 'markdown' },
  });
  assert.equal(server.chunksByFilePath.has(legacyPathA), false, 'legacy Base64 chunks must be removed on migration');
  assert.equal(server.chunksByFilePath.size, 2, 'must not duplicate chunks for migrated page');
  const rawAfterMigrate = await readdir(join(dbPath, 'raw-data'));
  assert.equal(rawAfterMigrate.includes(basename(legacyPathA)), false, 'legacy Base64 .md must be cleaned up on migration');
  assert.equal(rawAfterMigrate.includes(basename(server.metaPathFor(legacyPathA))), false, 'legacy Base64 .meta.json must be cleaned up on migration');

  const afterMigrateReply = await server.call('query_documents', {
    query: 'Updated content',
    limit: 10,
    sourcePrefix: `studyhub://lib/${LIB_A}/source/`,
  });
  const afterMigrateHits = JSON.parse(afterMigrateReply.content[0].text);
  assert.deepEqual(afterMigrateHits.map((h) => h.source).sort(), [legacyUriA, legacyUriB].sort());
  assert.match(afterMigrateHits.find((h) => h.source === legacyUriA).text, /migrated to short hash/);

  // 3) Deleting legacy-only legacyUriB cleans up its old Base64 chunks and files even though it was never re-ingested.
  await server.call('delete_file', { source: legacyUriB });
  assert.equal(server.chunksByFilePath.has(legacyPathB), false, 'legacy Base64 chunks must be deleted via delete_file');
  const rawAfterDelete = await readdir(join(dbPath, 'raw-data'));
  assert.equal(rawAfterDelete.includes(basename(legacyPathB)), false, 'legacy Base64 .md must be removed on delete_file');
  assert.equal(server.chunksByFilePath.size, 1);

  // Verify source-map.json on disk is clean JSON and contains only the migrated entry.
  const persisted = JSON.parse(await readFile(join(dbPath, 'source-map.json'), 'utf8'));
  assert.equal(persisted.byKey[shortCacheKey(legacyUriA)], legacyUriA);
  assert.equal(persisted.byKey[shortCacheKey(legacyUriB)], undefined);
});

test('#1451: end-to-end buildIndex + retrieveFromPort succeeds for long document sourceIds against NTFS-255 server', async (t) => {
  const dbPath = await mkdtemp(join(tmpdir(), 'studyhub-1451-e2e-'));
  t.after(() => rm(dbPath, { recursive: true, force: true }));

  const server = new WrappedServer({ dbPath });
  const tools = (await server.handlers.get('tools/list')()).tools.map((tool) => ({
    name: `mcp__studyhub__${tool.name}`,
    parameters: tool.inputSchema,
  }));
  const port = {
    tools: () => tools,
    call: (name, args) => server.call(name.replace(/^mcp__studyhub__/, ''), args),
  };

  const sources = Array.from({ length: 5 }, (_, i) => ({
    id: longDocumentSourceId(i + 1),
    title: `Operating Systems · p.${i + 1}`,
    text: `Chapter ${i + 1}: Virtual memory paging and TLB shootdown mechanism in multiprocessor kernels.`,
    courses: ['OS'],
  }));
  const manifest = { sources: {}, libraryId: LIB_A, keyVersion: INDEX_KEY_VERSION };

  const summary = await buildIndex({
    port,
    sources,
    library: sources.map((s) => s.id),
    manifest,
    libraryId: LIB_A,
  });
  assert.equal(summary.added, 5);
  assert.deepEqual(summary.failed, []);

  // Re-planning immediately reports all 5 pages unchanged (incremental index preserved).
  const replan = planIndex({ sources, library: sources.map((s) => s.id), manifest, libraryId: LIB_A });
  assert.equal(replan.add.length, 0);
  assert.equal(replan.unchanged, 5);

  // Retrieval resolves all 5 pages back to their exact long document sourceIds.
  const retrieved = await retrieveFromPort(
    port,
    { provider: `mcp:${INDEX_TOOLS.query}` },
    { query: 'TLB shootdown', sources, libraryId: LIB_A, limit: 5 },
  );
  assert.equal(retrieved.passages.length, 5);
  assert.deepEqual(retrieved.passages.map((p) => p.sourceId).sort(), sources.map((s) => s.id).sort());
});
