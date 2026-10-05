/* WP-TC step 3 for a translation job: it takes its wave size from the live concurrency and stops between waves when paused. Fake model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { settleJob, until, sleep } from './helpers/wait.mjs';

const lines = Array.from({ length: 40 }, (_, index) => `Paragraph number ${index} explains one more consequence of the architecture in some detail.`);
const markdown = `# Notes\n\n${lines.join('\n\n')}\n`;

test('a translation job: the next wave is sized by the concurrency in force, and a paused job starts no new wave', async (t) => {
  const calls = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const complete = async (system, prompt) => {
    const data = JSON.parse(prompt);
    calls.push(data.passages.length);
    if (calls.length === 1) await first;
    return JSON.stringify({ translations: data.passages.map((passage) => ({ id: passage.id, text: `译文：${passage.text.length}` })) });
  };
  const root = await mkdtemp(join(tmpdir(), 'translation-control-'));
  const runtime = createStudyRuntime(root, { complete, notify: () => {}, language: 'zh' });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(markdown).toString('base64') });
  const scope = { sourceIds: [imported.document.sources[0].id] };
  const started = await runtime.call('generation.translation.start', { documentId: imported.documentId, scope, concurrency: 1 });
  await until(() => calls.length === 1, 'the first batch is with the model');
  const job = (await runtime.call('snapshot')).jobs.find((item) => item.id === started.jobId);
  assert.equal(job.control.values.concurrency, 1);
  assert.equal(job.control.limits.concurrency.max, 3);
  // Both changes are made while the first wave is in flight: the pause holds the second wave back, the concurrency sizes it.
  await runtime.call('job.control', { jobId: started.jobId, patch: { concurrency: 3, paused: true } });
  release();
  await until(async () => (await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 1 })).done >= 6, 'the first wave is kept');
  const frozen = calls.length;
  await sleep(120);
  assert.equal(calls.length, frozen, 'no new wave starts while paused');
  await runtime.call('job.control', { jobId: started.jobId, patch: { paused: false } });
  const done = await settleJob(runtime, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.done, done.total);
  assert.ok(calls.length > frozen, 'the rest was translated after the resume');
  const finished = (await runtime.call('snapshot')).jobs.find((item) => item.id === started.jobId);
  assert.equal('control' in finished, false);
});
