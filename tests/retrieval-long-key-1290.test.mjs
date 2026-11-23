import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_KEY_VERSION,
  INDEX_TOOLS,
  buildIndex,
  contentHash,
  manifestNeedsMigration,
  sourceKey,
} from '../lib/retrieval-index.js';
import {
  MAX_PLAIN_SOURCE_KEY_BYTES,
  SOURCE_KEY_HASH_PREFIX,
  normalizeHits,
  resolveHits,
} from '../lib/retrieval.js';

const base64UrlFilenameLength = (source, ext = '.meta.json') =>
  Buffer.from(source, 'utf8').toString('base64url').length + ext.length;

function filenameCappedServer({ maxFilenameChars = 255, realRagShape = false } = {}) {
  const store = new Map();
  const calls = [];
  const port = {
    tools: () => [
      { name: INDEX_TOOLS.ingest, parameters: { type: 'object', properties: {} } },
      { name: INDEX_TOOLS.delete, parameters: { type: 'object', properties: {} } },
      { name: INDEX_TOOLS.query, parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
    ],
    async call(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === INDEX_TOOLS.ingest) {
        const key = args.metadata.source;
        const metaLen = base64UrlFilenameLength(key, '.meta.json');
        if (metaLen > maxFilenameChars) {
          throw new Error(`ENOENT: no such file or directory, open '.../raw-data/${Buffer.from(key).toString('base64url')}.meta.json' (len=${metaLen})`);
        }
        store.set(key, args.content);
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      }
      if (name === INDEX_TOOLS.delete) {
        store.delete(args.source);
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      }
      if (name === INDEX_TOOLS.query) {
        const hits = [...store.entries()].map(([key, text], i) =>
          realRagShape
            ? { filePath: `/tmp/rag/raw-data/${Buffer.from(key).toString('base64url')}.md`, source: key, text, score: 1 / (1 + i) }
            : { filePath: key, text, score: 1 / (1 + i) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { store, calls, port };
}

test('#1290: long sourceIds hash under 255-char filename limit while short & normal PDF ids stay identical', () => {
  const lib = '0123456789abcdef';
  const shortId = 'p1';
  const pdfId = `pdf-${'a'.repeat(64)}-text2-p12`;
  const longId = `document-${'b'.repeat(64)}-mineru-${'c'.repeat(64)}-mineru-r1-p12`; // 159 chars

  // Short & normal PDF IDs stay plain and unchanged
  assert.equal(sourceKey(shortId, lib), `studyhub://lib/${lib}/source/${shortId}`);
  assert.equal(sourceKey(pdfId, lib), `studyhub://lib/${lib}/source/${pdfId}`);
  assert.ok(base64UrlFilenameLength(sourceKey(pdfId, lib)) <= 255);

  // 159-char ID is hashed to a fixed-length key safely under 255-char base64url + .meta.json limit
  const longKey = sourceKey(longId, lib);
  assert.ok(longKey.startsWith(`studyhub://lib/${lib}/source/${SOURCE_KEY_HASH_PREFIX}`));
  assert.ok(Buffer.byteLength(longKey, 'utf8') <= MAX_PLAIN_SOURCE_KEY_BYTES);
  assert.ok(base64UrlFilenameLength(longKey, '.meta.json') <= 255, `meta filename must fit in 255 chars, got ${base64UrlFilenameLength(longKey)}`);
  assert.ok(base64UrlFilenameLength(longKey, '.md') <= 255);
});

test('#1290: mixed library with 159-char MinerU ids migrates from v1 in one pass under 255-char cap, resolves real mcp-local-rag hits, and deletes cleanly', async () => {
  const lib = 'fedcba9876543210';
  const shortSource = { id: `pdf-${'a'.repeat(64)}-text2-p1`, title: 'Short PDF p1', text: 'Short PDF page content about virtual memory.' };
  const longSources = Array.from({ length: 8 }, (_, idx) => ({
    id: `document-${'b'.repeat(64)}-mineru-${'c'.repeat(64)}-mineru-r1-p${idx + 1}`,
    title: `Converted Book p${idx + 1}`,
    text: `Converted book page ${idx + 1} content about distributed consensus and Raft.`,
  }));
  const allSources = [shortSource, ...longSources];

  // Start with a v1 manifest (simulating upgrade from keyVersion 1)
  const manifest = {
    keyVersion: 1,
    libraryId: lib,
    sources: Object.fromEntries(allSources.map(s => [s.id, { hash: contentHash(s.text), at: '2026-11-01T00:00:00.000Z' }])),
  };

  const { store, calls, port } = filenameCappedServer({ maxFilenameChars: 255, realRagShape: true });
  const summary = await buildIndex({
    port,
    sources: allSources,
    library: allSources.map(s => s.id),
    manifest,
    libraryId: lib,
  });

  // 1. All 9 pages succeed with 0 failures (would previously stop after 5 consecutive ENOENTs!)
  assert.equal(summary.failed.length, 0);
  assert.equal(summary.added, 9);
  assert.equal(manifest.keyVersion, INDEX_KEY_VERSION);
  assert.equal(manifestNeedsMigration(manifest), false);
  assert.ok(store.has(`studyhub://lib/${lib}/source/${shortSource.id}`), 'short id keeps plain key');
  assert.ok(manifest.sources[longSources[0].id].key.includes(SOURCE_KEY_HASH_PREFIX), 'manifest records hashed key for long id');

  // 2. Re-running buildIndex does NOT rebuild short or long ids
  const second = await buildIndex({
    port,
    sources: allSources,
    library: allSources.map(s => s.id),
    manifest,
    libraryId: lib,
  });
  assert.equal(second.added, 0);
  assert.equal(second.unchanged, 9);

  // 3. Query hits with real mcp-local-rag shape ({ filePath: '/tmp/...b64.md', source: 'studyhub://lib/.../sha256:...' }) resolve back to exact sourceId
  const rawReply = await port.call(INDEX_TOOLS.query, { query: 'Raft', limit: 20 });
  const hits = normalizeHits(JSON.parse(rawReply.content[0].text));
  const resolved = resolveHits(hits, allSources, { libraryId: lib });
  assert.equal(resolved.unresolved, 0);
  assert.equal(resolved.passages.length, 9);
  assert.ok(resolved.passages.some(p => p.sourceId === longSources[0].id && p.matchedBy === 'id'));
  assert.ok(resolved.passages.some(p => p.sourceId === shortSource.id && p.matchedBy === 'id'));

  // 4. Removing a long-id page deletes its exact hashed key from the server
  calls.length = 0;
  const targetDrop = longSources[0];
  const remaining = allSources.filter(s => s.id !== targetDrop.id);
  const delSummary = await buildIndex({
    port,
    sources: remaining,
    library: remaining.map(s => s.id),
    manifest,
    libraryId: lib,
  });
  assert.equal(delSummary.removed, 1);
  assert.equal(store.has(sourceKey(targetDrop.id, lib)), false);
  assert.deepEqual(calls.filter(c => c.name === INDEX_TOOLS.delete).map(c => c.args.source), [sourceKey(targetDrop.id, lib)]);
});
