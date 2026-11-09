import test from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_TOOLS, readManifest, sourceKey } from '../lib/retrieval-index.js';
import { library } from './helpers/index-library.mjs';
import { untilAborted } from './helpers/index-port.mjs';
import { until } from './helpers/wait.mjs';

const BATCH = 'mcp__studyhub__ingest_data_batch';

function extension(respond) {
  const batches = [], index = new Map();
  const port = {
    tools: () => [...Object.values(INDEX_TOOLS), BATCH].map(name => ({ name })),
    async call(name, args, options) {
      assert.equal(name, BATCH);
      batches.push(args.items);
      for (const item of args.items) index.set(item.metadata.source, item.content);
      // The write may have succeeded even when cancellation loses its receipt.
      await respond?.(args, batches.length, options);
      return { structuredContent: { results: args.items.map(item => ({ source: item.metadata.source, status: 'indexed' })) } };
    },
  };
  return { port, batches, index };
}

async function twentyPages(t, fake) {
  const lib = await library(t, fake);
  const extra = Array.from({ length: 16 }, (_, i) => `<!-- page: ${i + 1} -->\nExtra operating system material for page ${i}.`).join('\n\n');
  await lib.service.call('materials.document.import', { dataBase64: Buffer.from(extra).toString('base64'), filename: 'extra.md', courses: ['OS'] });
  return lib;
}

test('runtime cancellation reports the full uncertain batch and resumes by replacing the same source keys', async t => {
  const fake = extension((args, count, options) => count === 2 ? untilAborted(args, count, options) : undefined);
  const lib = await twentyPages(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => fake.batches.length === 2, 'the second batch');
  assert.deepEqual(fake.batches.map(items => items.length), [3, 3]);
  await lib.service.call('retrieval.index.cancel', {});
  const stopped = await lib.finished('the cancelled batch');
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(stopped.unconfirmed.map(sourceKey), fake.batches[1].map(item => item.metadata.source));
  assert.equal(Object.keys((await readManifest(lib.root)).sources).length, 3);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  const done = await lib.finished('the resumed build');
  assert.equal(done.status, 'complete');
  assert.equal(done.added, 17);
  assert.equal(fake.index.size, 20);
  assert.equal(Object.keys((await readManifest(lib.root)).sources).length, 20);
});

test('a lost batch response records every uncertain page even without cancellation', async t => {
  const fake = extension(() => { throw new Error('connection closed before the batch receipt'); });
  const lib = await twentyPages(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  const failed = await lib.finished('the failed batch');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.unconfirmed.map(sourceKey), fake.batches[0].map(item => item.metadata.source));
  assert.deepEqual((await readManifest(lib.root)).sources, {});
});
