import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createSelectionOperations } from '../lib/contexts/generation/selection.js';
import { authored, qualityPlan, qualityReview } from './helpers/assessment.mjs';

const quote = "Architecture includes the principles guiding a system's design and evolution.";
const selection = { sourceId: 's', documentId: 'doc', revision: 'rev1', start: 0, end: quote.length, quote, prefix: '', suffix: '' };
const card = { id: 'q', kind: 'flashcard', topic: 'Architecture decisions', objective: 'Recognize architectural constraints',
  prompt: 'Why does architecture contain principles guiding design and evolution?', answer: 'Principles guide subsequent design choices and changes.',
  hint: 'Compare a description with a constraint on permitted changes.', explanation: 'The definition includes principles governing how designs may evolve, so they constrain subsequent choices.',
  misconception: 'Architecture only describes current components.', citations: [{ sourceId: 's', quote }] };

async function fixture(t, { reviewFails = false, conflict = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.registerCollection('selectionJobs');
  const old = { id: 'old', review: { repetitions: 4, due_at: '2030-01-01' }, future: 7 };
  await store.update(s => { s.decks.push({ id: 'd', title: 'Existing', contentVersion: 3, cards: [old] }); });
  let calls = 0, appends = 0;
  const complete = async (system, prompt) => {
    calls++;
    if (system.startsWith('Plan a source-grounded')) return JSON.stringify(qualityPlan(JSON.parse(prompt.split('REQUEST DATA:\n')[1])));
    if (system.startsWith('Act as a strict')) {
      if (reviewFails) throw new Error('Reviewer unavailable');
      return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    }
    return JSON.stringify(authored({ title: 'Selection', cards: [structuredClone(card)] }));
  };
  const bank = {
    get: async () => ({ deck: structuredClone((await store.read()).decks[0]), version: (await store.read()).decks[0].contentVersion }),
    append: async args => {
      if (conflict) throw Object.assign(new Error('Deck changed'), { code: 'VERSION_CONFLICT' });
      return store.update(s => {
        const deck = s.decks[0];
        const receipt = deck.receipts?.[args.operationId];
        if (receipt) return receipt;
        if (args.expectedVersion !== deck.contentVersion) throw new Error('Deck changed');
        appends++;
        deck.cards.push(...structuredClone(args.cards));
        deck.contentVersion++;
        const result = { operationId: args.operationId, deckId: 'd', added: args.cards.length, cardIds: args.cards.map(c => c.id), total: deck.cards.length, version: deck.contentVersion };
        (deck.receipts ||= {})[args.operationId] = result;
        return result;
      });
    },
  };
  const materials = async action => action === 'materials.selection.resolve'
    ? { status: 'resolved', currentRevision: 'rev1', selection: structuredClone(selection) }
    : { documentId: 'doc', revision: 'rev1', sources: [{ id: 's', title: 'Notes', text: quote }] };
  const operations = createSelectionOperations({ root, ...store.scoped(['selectionJobs']), bank, materials, complete });
  return { store, operations, old, bank, materials, complete, metrics: () => ({ calls, appends }) };
}

test('selected evidence generates, independently reviews and appends once while preserving old progress', async t => {
  const f = await fixture(t);
  const args = { selection, deckId: 'd', operationId: 'op1', expectedVersion: 3, count: 1, kind: 'flashcard' };
  const result = await f.operations['generation.selection.supplement'](args, {});
  assert.equal(result.status, 'complete');
  assert.equal(result.receipt.added, 1);
  assert.deepEqual((await f.store.read()).decks[0].cards[0], f.old);
  assert.deepEqual((await f.store.read()).decks[0].cards[1].selections, [selection]);
  const again = await f.operations['generation.selection.supplement'](args, {});
  assert.deepEqual(again.receipt, result.receipt);
  assert.deepEqual(f.metrics(), { calls: 3, appends: 1 });
  await assert.rejects(f.operations['generation.selection.supplement']({ ...args, count: 2 }, {}), /operation|Operation/);
});

test('review failure retains authored candidates and never appends unchecked cards', async t => {
  const f = await fixture(t, { reviewFails: true });
  const result = await f.operations['generation.selection.supplement']({ selection, deckId: 'd', operationId: 'reviewfail', count: 1, kind: 'flashcard' }, {});
  assert.equal(result.status, 'review-failed');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.accepted.length, 0);
  assert.equal((await f.store.read()).decks[0].cards.length, 1);
  assert.equal((await f.operations['generation.selection.get']({ operationId: 'reviewfail' })).candidates.length, 1);
});

test('destination conflict preserves reviewed candidates for commit retry without model regeneration', async t => {
  const f = await fixture(t, { conflict: true });
  const result = await f.operations['generation.selection.supplement']({ selection, deckId: 'd', operationId: 'conflict', count: 1, kind: 'flashcard' }, {});
  assert.equal(result.status, 'conflict');
  assert.equal(result.accepted.length, 1);
  assert.equal((await f.store.read()).decks[0].cards.length, 1);
});

test('missing model is a capability error and leaves existing deck intact', async t => {
  const f = await fixture(t);
  const noModel = createSelectionOperations({ root: f.store.root, ...f.store.scoped(['selectionJobs']), bank: {}, materials: async () => {}, complete: undefined });
  await assert.rejects(noModel['generation.selection.supplement']({ selection, deckId: 'd', operationId: 'nomodel', count: 1, kind: 'flashcard' }), /model|Model/);
  assert.equal((await f.store.read()).decks[0].cards.length, 1);
});

test('concurrent changed requests cannot share an operation identity before its record is saved', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const operations = createSelectionOperations({ root: f.store.root, ...f.store.scoped(['selectionJobs']), bank: f.bank, complete: f.complete,
    materials: async (...args) => { if (args[0] === 'materials.selection.resolve') { entered(); await gate; } return f.materials(...args); } });
  const args = { selection, deckId: 'd', operationId: 'concurrent', count: 1, kind: 'flashcard' };
  const first = operations['generation.selection.supplement'](args);
  await ready;
  const second = operations['generation.selection.supplement']({ ...args, count: 2 });
  // Release in a microtask, so a broken implementation cannot deadlock this test.
  const rejected = assert.rejects(second, /Operation ID|Operation identity/);
  release();
  await rejected;
  assert.equal((await first).receipt.added, 1);
});

test('a reviewed retry recovers a committed bank receipt after its material changed', async t => {
  const f = await fixture(t);
  const args = { selection, deckId: 'd', operationId: 'lost-receipt', count: 1, kind: 'flashcard' };
  const committed = await f.operations['generation.selection.supplement'](args);
  await f.store.scoped(['selectionJobs']).update(state => { const job = state.selectionJobs[0]; job.status = 'reviewed'; delete job.receipt; });
  const recovery = createSelectionOperations({ root: f.store.root, ...f.store.scoped(['selectionJobs']), bank: f.bank,
    materials: async () => ({ status: 'stale' }) });
  const result = await recovery['generation.selection.commit']({ operationId: args.operationId });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.receipt, committed.receipt);
  assert.equal(f.metrics().appends, 1);
});
