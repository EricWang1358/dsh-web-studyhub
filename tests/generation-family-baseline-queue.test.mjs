import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { gate, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-0 baseline, the ONE per-library queue: generate, supplement, selection fill, draft.repair and draft.publish.start all chain on `work.queues.get(root)` (a promise chain, one entry
   per library root) and `queuedBehind` counts the ACTIVE jobs of the library. A job that waits is `queued`, its executor has not started (no model call), and the jobs then run one at
   a time in the order they were accepted. The queue is a plain promise chain in lib/contexts/generation/operations.js, selection-jobs.js (and nowhere else): S3-1 delegates it. */

const text = 'Architecture sets principles that guide how a system is designed and changed.';
const passage = "Architecture includes the principles guiding a system's design and evolution.";
const card = (id, n) => ({ id, kind: 'flashcard', topic: 'Architecture', objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?`, answer: 'Principles.', hint: 'Constraints.',
  explanation: 'The notes say principles guide design and change.', misconception: 'Only parts matter.', citations: [{ sourceId: 's', quote: text }] });

test('five entry points share one library queue: the first runs, the others wait without a model call, then run one at a time in the order they were accepted', async t => {
  const hold = gate(), staged = stagedModel({ holdAt: 'plan', hold });
  const complete = async (system, prompt, options = {}) => {
    if (!system.startsWith('Repair one draft card')) return staged.complete(system, prompt, options);
    staged.jobs.includes(options.jobId) || staged.jobs.push(options.jobId);
    const input = JSON.parse(prompt);
    return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } });
  };
  const root = await mkdtemp(join(tmpdir(), 'study-s30-queue-'));
  const runtime = createStudyRuntime(root, { complete });
  t.after(async () => { hold.open(); await runtime.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await new Store(root).update(state => { state.decks.push({ id: 'd', title: 'Architecture basics', cards: [{ id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?', answer: 'Original' }] }); });
  await runtime.call('source.add', { id: 's', title: 'Notes', text });
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${passage}`).toString('base64') });
  const selection = (await runtime.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
  const publishable = await runtime.call('draft.save', { deck: { id: 'pub', title: 'To publish', cards: [card('p1', 1)] } });
  const broken = await runtime.call('draft.save', { deck: { id: 'fix', title: 'To repair', cards: [card('r1', 2)],
    editorial: { generation: { sourceIds: ['s'], kind: 'flashcard' }, rejectedIssues: { r1: ['explanationQuality failed'] } } } });

  const first = await runtime.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the first job to be at the model');
  const entries = [
    ['draft.publish.start', await runtime.call('draft.publish.start', { id: 'pub', draftVersion: publishable.draftVersion })],
    ['draft.repair', await runtime.call('draft.repair', { id: 'fix', draftVersion: broken.draftVersion })],
    ['generation.selection.start', await runtime.call('generation.selection.start', { selection, deckId: 'd', expectedVersion: 0, count: 1, kind: 'flashcard', operationId: 'op' })],
    ['supplement', await runtime.call('supplement', { sourceIds: ['s'], deckId: 'd', count: 1, kind: 'flashcard' })],
  ];
  assert.equal(first.queuedBehind, 0);
  assert.deepEqual(entries.map(([, reply]) => reply.status), ['queued', 'queued', 'queued', 'queued']);
  assert.deepEqual(entries.slice(1).map(([, reply]) => reply.queuedBehind), [2, 3, 4], 'queuedBehind counts the active jobs of the library, whatever their kind (publish.start reports none)');
  assert.equal(runtime.work.queues.size, 1, 'one chain per library root, not one per entry point');
  const states = await runtime.call('snapshot');
  assert.equal(states.jobs.filter(job => job.status === 'queued').length, 4);
  assert.deepEqual(staged.jobs, [first.jobId], 'a queued job has not touched the model');
  hold.open();
  for (const [, reply] of entries) assert.equal((await runtime.call('job.wait', { jobId: reply.jobId, timeoutSeconds: 30 })).status, 'complete');
  assert.deepEqual(staged.jobs, [first.jobId, entries[0][1].jobId, entries[1][1].jobId, entries[2][1].jobId, entries[3][1].jobId],
    'they ran one at a time, in the order they were accepted (publish, repair, selection, supplement)');
});
