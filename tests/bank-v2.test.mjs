import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';

test('bank appends once, rejects conflicts and preserves the existing card schedule', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-bank-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = 'Bridge separates an abstraction from its implementation so both can vary independently.';
  const old = { id: 'old', kind: 'flashcard', topic: 'Bridge', objective: 'Old target', prompt: 'Old question?',
    answer: 'Two dimensions.', hint: 'Dimensions.', explanation: 'The two dimensions vary independently.', misconception: 'Only one dimension changes.',
    citations: [{ sourceId: 's', quote: evidence }], review: { due: '2030-01-01', interval: 20, repetitions: 8, easeFactor: 2.8 }, custom: 'kept' };
  await new Store(root).update(state => {
    state.sources.push({ id: 's', title: 'Evidence', text: evidence });
    state.decks.push({ id: 'd', title: 'Bank', cards: [old] });
  });
  const runtime = createStudyRuntime(root, { contexts: ['bank', 'materials'] });
  const candidate = { ...old, id: 'new', objective: 'New target', prompt: 'New question?' };
  delete candidate.review;
  const args = { deckId: 'd', operationId: 'op', expectedVersion: 0, cards: [candidate] };
  const receipt = await runtime.call('bank.append', args);
  assert.equal(receipt.added, 1);
  assert.deepEqual(receipt.cardIds, ['new']);
  assert.equal((await runtime.call('bank.append', args)).replayed, true);
  const stored = (await runtime.call('bank.get', { deckId: 'd' })).deck;
  assert.deepEqual(stored.cards[0], old);
  assert.equal(stored.cards.length, 2);
  await assert.rejects(runtime.call('bank.append', { ...args, cards: [{ ...candidate, prompt: 'Changed' }] }), /operation.*conflict/i);
  await assert.rejects(runtime.call('bank.append', { ...args, operationId: 'op2' }), /version/i);
});
