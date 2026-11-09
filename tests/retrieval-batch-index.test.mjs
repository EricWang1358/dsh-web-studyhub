import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, contentHash, INDEX_TOOLS, sourceKey } from '../lib/retrieval-index.js';

const BATCH = 'mcp__studyhub__ingest_data_batch';
const pages = count => Array.from({ length: count }, (_, i) => ({ id: `page-${i}`, title: `Page ${i}`, text: `Source text for page ${i}.` }));

function harness({ batch = true, fail = new Set(), empty = new Set(), respond } = {}) {
  const calls = [], stored = new Set();
  const port = {
    tools: () => [...Object.values(INDEX_TOOLS), ...(batch ? [BATCH] : [])].map(name => ({ name })),
    async call(name, args, options) {
      calls.push({ name, args });
      if (name === INDEX_TOOLS.delete) { stored.delete(args.source); return {}; }
      if (name === INDEX_TOOLS.ingest) { stored.add(args.metadata.source); return {}; }
      if (respond) return respond(args, options, calls);
      const results = [];
      for (const item of args.items) {
        const source = item.metadata.source;
        if (fail.has(source)) { results.push({ source, status: 'failed', message: 'parse failed' }); break; }
        if (empty.has(source)) results.push({ source, status: 'no-chunks', message: 'No chunks generated' });
        else { stored.add(source); results.push({ source, status: 'indexed' }); }
      }
      return { structuredContent: { results } };
    },
  };
  const run = (sources, extra = {}) => buildIndex({ port, sources, library: sources.map(page => page.id), manifest: { sources: {} }, ...extra });
  return { calls, stored, port, run, batches: () => calls.filter(call => call.name === BATCH) };
}

test('index batching grows with pending pages, caps at eight, and keeps a short final batch', async () => {
  for (const [count, size] of [[0, 0], [1, 1], [8, 1], [9, 2], [16, 2], [17, 3], [32, 4], [48, 6], [64, 8], [73, 8]]) {
    const h = harness(), sources = pages(count), manifest = { sources: {} };
    const summary = await h.run(sources, { manifest });
    assert.equal(summary.added, count);
    assert.equal(h.batches().length, count ? Math.ceil(count / size) : 0, `batch count for ${count} pages`);
    assert.deepEqual(h.batches().map(call => call.args.items.length), Array.from({ length: count ? Math.ceil(count / size) : 0 }, (_, i) => Math.min(size, count - i * size)));
    assert.deepEqual([...h.stored], sources.map(page => sourceKey(page.id)));
    assert.equal(Object.keys(manifest.sources).length, count);
  }
});

test('batch sizing counts changed pages and checkpoints every completed batch', async () => {
  const h = harness(), sources = pages(100), manifest = { sources: Object.fromEntries(sources.slice(0, 98).map(page => [page.id, { hash: contentHash(page.text) }])) };
  await h.run(sources, { manifest });
  assert.deepEqual(h.batches().map(call => call.args.items.length), [1, 1]);
  const fresh = harness(), snapshots = [];
  await fresh.run(pages(20), { save: value => { snapshots.push(Object.keys(value.sources).length); } });
  assert.deepEqual(snapshots, [3, 6, 9, 12, 15, 18, 20, 20]);
});

test('a short failed batch continues from the next page, preserving the consecutive-failure limit', async () => {
  const h = harness({ fail: new Set([sourceKey('page-1')]) });
  const summary = await h.run(pages(20));
  assert.equal(summary.added, 19);
  assert.deepEqual(summary.failed.map(item => item.id), ['page-1']);
  assert.equal(h.batches()[1].args.items[0].metadata.source, sourceKey('page-2'));
  const broken = harness({ fail: new Set(pages(20).map(page => sourceKey(page.id))) });
  await assert.rejects(broken.run(pages(20)), error => error.code === 'retrieval-index-failed' && error.summary.failed.length === 5);
  assert.equal(broken.batches().length, 5);
});

test('no-chunks pages remove stale content and remain resumable as skipped entries', async () => {
  const h = harness({ empty: new Set([sourceKey('page-0')]) }), sources = pages(10);
  const manifest = { sources: { 'page-0': { hash: 'old' } } };
  const result = await h.run(sources, { manifest });
  assert.equal(result.skipped, 1);
  assert.equal(manifest.sources['page-0'].skipped, 'no-chunks');
  assert.ok(h.calls.some(call => call.name === INDEX_TOOLS.delete && call.args.source === sourceKey('page-0')));
});

test('an unconfirmed batch leaves the prior checkpoint intact and names every page in flight', async () => {
  const controller = new AbortController(), inFlight = [], manifest = { sources: {} };
  const h = harness({ respond: async (args, { signal }, calls) => {
    if (calls.length === 2) { controller.abort(); signal.throwIfAborted(); }
    return { structuredContent: { results: args.items.map(item => ({ source: item.metadata.source, status: 'indexed' })) } };
  } });
  await assert.rejects(h.run(pages(20), { manifest, signal: controller.signal, onItem: item => inFlight.push(item) }), { name: 'AbortError' });
  assert.deepEqual(Object.keys(manifest.sources), ['page-0', 'page-1', 'page-2']);
  assert.deepEqual(inFlight.at(-1).ids, ['page-3', 'page-4', 'page-5']);
});

test('maintenance errors and invalid batch receipts never mark unconfirmed pages as indexed', async () => {
  for (const receipt of [
    { results: [], maintenanceError: 'index maintenance failed' },
    { results: [] },
    { results: [{ source: 'another-source', status: 'indexed' }] },
    { results: [{ source: sourceKey('page-0'), status: 'indexed' }] },
  ]) {
    const h = harness({ respond: async () => ({ structuredContent: receipt }) }), manifest = { sources: {} };
    await assert.rejects(h.run(pages(20), { manifest }));
    assert.deepEqual(manifest.sources, {});
  }
});

test('older extensions keep the original single-page ingestion path', async () => {
  const h = harness({ batch: false });
  assert.equal((await h.run(pages(20))).added, 20);
  assert.equal(h.batches().length, 0);
  assert.equal(h.calls.filter(call => call.name === INDEX_TOOLS.ingest).length, 20);
});
