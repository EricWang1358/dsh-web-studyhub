import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INDEX_KEY_VERSION,
  INDEX_TOOLS,
  buildIndex,
  contentHash,
  manifestPath,
  parseSourceKey,
  planIndex,
  readManifest,
  scopedSourcePrefix,
  sourceIdFromKey,
  sourceKey,
  writeManifest,
} from '../lib/retrieval-index.js';
import { normalizeHits, resolveHits, retrieveFromPort } from '../lib/retrieval.js';
import { retrievalRootId } from '../lib/retrieval-settings.js';

const page = (id, text) => ({ id, title: `Page ${id}`, text, courses: ['OS'] });

function sharedIndexServer() {
  const store = new Map();
  const calls = [];
  const port = {
    tools: () => [
      { name: INDEX_TOOLS.ingest, parameters: { type: 'object', properties: {} } },
      { name: INDEX_TOOLS.delete, parameters: { type: 'object', properties: {} } },
      {
        name: INDEX_TOOLS.query,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['query'],
        },
      },
    ],
    async call(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === INDEX_TOOLS.ingest) {
        store.set(args.metadata.source, args.content);
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      }
      if (name === INDEX_TOOLS.delete) {
        store.delete(args.source);
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      }
      if (name === INDEX_TOOLS.query) {
        const limit = args.limit || 10;
        const hits = [...store.entries()]
          .slice(0, limit)
          .map(([filePath, text], i) => ({ filePath, text, score: 1 / (1 + i) }));
        return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { store, calls, port };
}

test('sourceKey and parseSourceKey isolate libraries while remaining backward compatible with legacy keys', () => {
  assert.equal(sourceKey('p1'), 'studyhub://source/p1');
  assert.equal(sourceKey('p1', 'libA001'), 'studyhub://lib/libA001/source/p1');
  // Array.prototype.map passes numeric index as 2nd arg; must ignore non-strings
  assert.deepEqual(['p1', 'p2'].map(sourceKey), ['studyhub://source/p1', 'studyhub://source/p2']);

  assert.deepEqual(parseSourceKey('studyhub://lib/libA001/source/p1'), { libraryId: 'libA001', sourceId: 'p1', scoped: true });
  assert.deepEqual(parseSourceKey('studyhub://source/p1'), { libraryId: null, sourceId: 'p1', scoped: false });
  assert.equal(parseSourceKey('/tmp/book.md'), null);

  assert.equal(sourceIdFromKey('studyhub://lib/libA001/source/p1', 'libA001'), 'p1');
  assert.equal(sourceIdFromKey('studyhub://lib/libA001/source/p1', 'libB002'), undefined, 'foreign library key must be rejected');
  assert.equal(sourceIdFromKey('studyhub://source/p1', 'libA001'), 'p1', 'legacy key remains readable during migration');
  assert.equal(scopedSourcePrefix('libA001'), 'studyhub://lib/libA001/source/');
});

test('two libraries with colliding sourceIds never overwrite or cross-delete each other in a shared index', async () => {
  const { store, calls, port } = sharedIndexServer();
  const libA = 'aaaa1111bbbb2222';
  const libB = 'cccc3333dddd4444';
  const manifestA = { sources: {}, libraryId: libA, keyVersion: INDEX_KEY_VERSION };
  const manifestB = { sources: {}, libraryId: libB, keyVersion: INDEX_KEY_VERSION };

  const sourcesA = [page('p1', 'Library A: Operating systems virtual memory and page tables.'), page('p2', 'Library A: Deadlock conditions.')];
  const sourcesB = [page('p1', 'Library B: Organic chemistry benzene ring resonance.'), page('p2', 'Library B: Acid-base titration.')];

  await buildIndex({ port, sources: sourcesA, library: ['p1', 'p2'], manifest: manifestA, libraryId: libA });
  await buildIndex({ port, sources: sourcesB, library: ['p1', 'p2'], manifest: manifestB, libraryId: libB });

  assert.equal(store.size, 4, 'both libraries keep independent keys despite identical sourceIds');
  assert.ok(store.has(`studyhub://lib/${libA}/source/p1`));
  assert.ok(store.has(`studyhub://lib/${libB}/source/p1`));

  // Deleting p1 from Library A MUST only delete Library A's scoped key, leaving Library B's p1 untouched!
  calls.length = 0;
  const delSummary = await buildIndex({ port, sources: [sourcesA[1]], library: ['p2'], manifest: manifestA, libraryId: libA });
  assert.equal(delSummary.removed, 1);
  assert.deepEqual(calls.filter(c => c.name === INDEX_TOOLS.delete).map(c => c.args.source), [`studyhub://lib/${libA}/source/p1`]);
  assert.equal(store.has(`studyhub://lib/${libA}/source/p1`), false);
  assert.equal(store.has(`studyhub://lib/${libB}/source/p1`), true, 'Library B p1 must survive Library A deletion');
});

test('resolveHits strictly isolates colliding sourceIds and text across libraries and reports foreignLibrary count', () => {
  const libA = 'aaaa1111bbbb2222';
  const libB = 'cccc3333dddd4444';
  const sourcesA = [page('p1', 'Virtual memory maps virtual pages to physical frames.')];
  const hits = normalizeHits([
    // Foreign library hit with IDENTICAL sourceId AND identical text must still be rejected!
    { filePath: `studyhub://lib/${libB}/source/p1`, sourceId: 'p1', text: 'Virtual memory maps virtual pages to physical frames.', score: 0.99 },
    // Target library hit
    { filePath: `studyhub://lib/${libA}/source/p1`, text: 'Virtual memory maps virtual pages to physical frames.', score: 0.80 },
  ]);
  const resolved = resolveHits(hits, sourcesA, { libraryId: libA });
  assert.equal(resolved.foreignLibrary, 1);
  assert.equal(resolved.unresolved, 1);
  assert.equal(resolved.passages.length, 1);
  assert.equal(resolved.passages[0].score, 0.80, 'only Library A hit is accepted, never Library B hit');
});

test('retrieveFromPort adaptively oversamples when foreign library chunks crowd out top-k recall, and emits clear diagnostics', async () => {
  const libA = 'aaaa1111bbbb2222';
  const libB = 'cccc3333dddd4444';
  const sourcesA = [
    page('p1', 'Target library page 1 on paging.'),
    page('p2', 'Target library page 2 on TLB.'),
    page('p3', 'Target library page 3 on thrashing.'),
  ];
  const allRows = [
    ...Array.from({ length: 18 }, (_, i) => ({ filePath: `studyhub://lib/${libB}/source/f${i}`, text: `Foreign chunk ${i}`, score: 0.99 - i * 0.01 })),
    { filePath: `studyhub://lib/${libA}/source/p1`, text: 'Target library page 1 on paging.', score: 0.75 },
    { filePath: `studyhub://lib/${libA}/source/p2`, text: 'Target library page 2 on TLB.', score: 0.70 },
    { filePath: `studyhub://lib/${libA}/source/p3`, text: 'Target library page 3 on thrashing.', score: 0.65 },
  ];
  const limitsAsked = [];
  const port = {
    tools: () => [{
      name: INDEX_TOOLS.query,
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    }],
    async call(_name, args) {
      limitsAsked.push(args.limit);
      return { content: [{ type: 'text', text: JSON.stringify(allRows.slice(0, args.limit)) }] };
    },
  };

  const result = await retrieveFromPort(
    port,
    { provider: `mcp:${INDEX_TOOLS.query}` },
    { query: 'paging and TLB', sources: sourcesA, libraryId: libA, limit: 10 },
  );

  // First pass limit=10 saw 10 foreign hits and 0 target hits -> oversampled to 30 -> recovered all 3 target pages!
  assert.deepEqual(limitsAsked, [10, 30]);
  assert.deepEqual(result.passages.map(p => p.sourceId), ['p1', 'p2', 'p3']);
  assert.equal(result.diagnostics.libraryId, libA);
  assert.equal(result.diagnostics.oversampled, true);
  assert.equal(result.diagnostics.attempts, 2);
  assert.equal(result.diagnostics.fetchedLimit, 30);
  assert.equal(result.diagnostics.foreignLibraryHits, 18);
  assert.equal(result.diagnostics.matchedPassages, 3);
  assert.equal(result.diagnostics.recallShortfall, false);
});

test('retrieveFromPort forwards sourcePrefix when the MCP tool advertises it (server-side isolation)', async () => {
  const libA = 'aaaa1111bbbb2222';
  const sourcesA = [page('p1', 'Paging content')];
  const seen = [];
  const port = {
    tools: () => [{
      name: INDEX_TOOLS.query,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' }, sourcePrefix: { type: 'string' } },
        required: ['query'],
      },
    }],
    async call(_name, args) {
      seen.push(args);
      return { content: [{ type: 'text', text: JSON.stringify([{ filePath: `studyhub://lib/${libA}/source/p1`, text: 'Paging content', score: 0.9 }]) }] };
    },
  };
  const result = await retrieveFromPort(port, { provider: `mcp:${INDEX_TOOLS.query}` }, { query: 'paging', sources: sourcesA, libraryId: libA, limit: 5 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sourcePrefix, `studyhub://lib/${libA}/source/`);
  assert.equal(result.diagnostics.serverFiltered, true);
  assert.equal(result.diagnostics.oversampled, false);
});

test('legacy v1 manifests are automatically detected, scheduled for safe v2 migration, and never delete shared legacy keys', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-rag-migrate-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-rag-migrate-lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const libId = retrievalRootId(root);
  const s1 = page('p1', 'Already hashed page 1');
  const legacyRemoved = 'legacy-gone';
  // Write a legacy v1 manifest on disk (no keyVersion, no libraryId).
  const target = manifestPath(root);
  await mkdir(join(home, 'study', 'retrieval', 'manifests'), { recursive: true });
  await writeFile(target, JSON.stringify({
    sources: {
      p1: { hash: contentHash(s1.text), at: '2026-10-01T00:00:00.000Z' },
      [legacyRemoved]: { hash: 'oldhash', at: '2026-10-01T00:00:00.000Z' },
    },
  }), 'utf8');

  const manifest = await readManifest(root);
  assert.equal(manifest.libraryId, libId);
  assert.equal(manifest.keyVersion, 1);
  assert.equal(manifest.legacyMigration, true);
  assert.equal(manifest.legacyCount, 2);

  // planIndex schedules p1 for migration even though its contentHash is unchanged!
  const plan = planIndex({ sources: [s1], library: ['p1'], manifest, libraryId: libId });
  assert.deepEqual(plan.add.map(s => s.id), ['p1']);
  assert.deepEqual(plan.remove, [legacyRemoved]);

  const { store, calls, port } = sharedIndexServer();
  // Seed legacy key owned by another library to prove migration removal never deletes shared legacy keys.
  store.set(`studyhub://source/${legacyRemoved}`, 'other library legacy data');

  await buildIndex({
    port,
    sources: [s1],
    library: ['p1'],
    manifest,
    libraryId: libId,
    save: value => writeManifest(root, value),
  });

  // p1 is migrated to v2 scoped key; legacyRemoved was removed from manifest WITHOUT deleting shared legacy URI!
  assert.ok(store.has(`studyhub://lib/${libId}/source/p1`));
  assert.ok(store.has(`studyhub://source/${legacyRemoved}`), 'shared legacy key must never be cross-deleted during migration');
  assert.equal(calls.filter(c => c.name === INDEX_TOOLS.delete).length, 0);

  // Re-reading persisted manifest confirms v2 migration completed cleanly!
  const migrated = await readManifest(root);
  assert.equal(migrated.keyVersion, INDEX_KEY_VERSION);
  assert.equal(migrated.legacyMigration, undefined);
  assert.deepEqual(planIndex({ sources: [s1], library: ['p1'], manifest: migrated, libraryId: libId }).add, []);
});
