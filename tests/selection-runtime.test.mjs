import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { authored, qualityPlan, qualityReview } from './helpers/assessment.mjs';

const passage = "Architecture includes the principles guiding a system's design and evolution.";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'selection-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = { id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?',
    answer: 'Original', review: { repetitions: 5, ease_factor: 2.6, due_at: '2030-01-01' }, custom: 'preserved' };
  await new Store(root).update(state => { state.decks.push({ id: 'd', title: 'Old JSON deck', cards: [old] }); });
  let calls = 0;
  const complete = async (system, prompt) => {
    calls++;
    if (system.startsWith('Plan a source-grounded')) return JSON.stringify(qualityPlan(JSON.parse(prompt.split('REQUEST DATA:\n')[1])));
    if (system.startsWith('Act as a strict')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    const data = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
    return JSON.stringify(authored({ title: 'Selection', cards: [{ id: 'q', kind: 'flashcard', topic: 'Architecture decisions',
      objective: 'Explain architectural principles', prompt: 'Why do architectural principles guide design and evolution?',
      answer: 'They constrain design decisions and subsequent changes.', hint: 'Compare a current description with a rule for permitted changes.',
      explanation: 'The evidence includes principles governing both design and evolution, so those principles constrain initial choices and later changes.',
      misconception: 'Architecture only names existing components.', citations: [{ sourceId: data.sources[0].id, quote: passage }] }] }));
  };
  const runtime = createStudyRuntime(root, { contexts: ['bank', 'materials', 'generation'], complete });
  t.after(() => runtime.dispose());
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${passage}`).toString('base64') });
  const selection = (await runtime.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
  return { root, runtime, old, imported, selection, calls: () => calls };
}

test('the real versioned APIs append to an old version-zero deck and return a valid replayable receipt', async t => {
  const f = await fixture(t);
  const args = { selection: f.selection, deckId: 'd', operationId: 'actual-runtime', expectedVersion: 0, count: 1, kind: 'flashcard' };
  const result = await f.runtime.call('generation.selection.supplement', args);
  assert.equal(result.status, 'complete');
  assert.equal(result.receipt.added, 1);
  assert.equal(result.error, null);
  const deck = (await f.runtime.call('bank.get', { deckId: 'd' })).deck;
  assert.deepEqual(deck.cards[0], f.old);
  const links = await f.runtime.call('materials.links.list', { documentId: f.imported.documentId });
  assert.equal(links.links.length, 1);
  assert.equal(links.links[0].cardId, result.receipt.cardIds[0]);
  assert.equal(links.links[0].status, 'resolved');
  const repeat = await f.runtime.call('generation.selection.supplement', args);
  assert.deepEqual(repeat.receipt, result.receipt);
  const disconnected = createStudyRuntime(f.root, { contexts: ['bank', 'materials', 'generation'] });
  t.after(() => disconnected.dispose());
  const replayWithoutModel = await disconnected.call('generation.selection.supplement', args);
  assert.deepEqual(replayWithoutModel.receipt, result.receipt);
  assert.equal((await disconnected.call('generation.selection.supplement', { ...args, operationId: 'new-without-model' })).reason, 'model_unavailable');
  assert.equal(f.calls(), 3);
});

test('a changed material cannot receive fresh additions, but an existing receipt remains replayable', async t => {
  const f = await fixture(t);
  const candidate = { id: 'new', kind: 'flashcard', topic: 'Principles', objective: 'New target', prompt: 'What guides later architectural changes?',
    answer: 'Principles', hint: 'Consider stable constraints.', explanation: 'Principles are part of the architecture and guide later evolution.',
    misconception: 'Only existing components matter.', citations: [{ sourceId: f.selection.sourceId, quote: passage }], selections: [f.selection] };
  const args = { deckId: 'd', cards: [candidate], selection: f.selection, expectedVersion: 0, operationId: 'receipt' };
  const first = await f.runtime.call('bank.append', args);
  await f.runtime.call('materials.document.import', { documentId: f.imported.documentId, filename: 'notes.md', dataBase64: Buffer.from(`${passage}\nChanged context.`).toString('base64') });
  assert.equal((await f.runtime.call('bank.append', args)).replayed, true);
  await assert.rejects(f.runtime.call('bank.append', { ...args, operationId: 'fresh', expectedVersion: first.version, cards: [{ ...candidate, id: 'other', objective: 'Other target', prompt: 'Other question?' }] }), /stale/);
  assert.equal((await f.runtime.call('bank.get', { deckId: 'd' })).deck.cards.length, 2);
});

test('cancelling while append waits for the real library lock prevents fresh publication', async t => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const locked = new Promise(resolve => { entered = resolve; });
  const lock = new Store(f.root).update(async () => { entered(); await waiting; });
  await locked;
  const controller = new AbortController();
  const pending = f.runtime.call('bank.append', { deckId: 'd', operationId: 'cancelled', expectedVersion: 0, selection: f.selection,
    cards: [{ id: 'unused', kind: 'flashcard' }] }, { signal: controller.signal });
  // A timer allows the request to reach lock acquisition; it does not release the
  // held lock, so an implementation missing the atomic cancellation check fails.
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.abort(); release(); await lock;
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await f.runtime.call('bank.get', { deckId: 'd' })).deck.cards.length, 1);
});
