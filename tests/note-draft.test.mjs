import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { blogGenerationSystem } from '../lib/blog-generation.js';

/* 写笔记 from a question: asking again for the same question opens the note that is already there instead of adding another with the same title; and the AI draft
   says what it is expected to use before it is started (usage.estimate, feature note). */

async function library(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-note-draft-'));
  const service = new StudyService(root, options);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(state => {
    state.decks.push({ id: 'deck', title: 'Deck', cards: [
      { id: 'c1', prompt: 'What does a bridge decouple?', answer: 'Abstraction from implementation', topic: 'Bridge', explanation: 'It lets both vary independently.' },
      { id: 'c2', prompt: 'What does a memento hold?', answer: 'A snapshot', topic: 'Memento', explanation: 'It keeps state without exposing it.' }] });
  });
  return service;
}

test('写笔记 on a question that already has a draft opens that draft, and the note list does not grow', async t => {
  const service = await library(t);
  const first = await service.call('note.create', { title: '学习笔记 · 2026-10-08', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true });
  assert.equal(first.reused, undefined, 'the first time it is new');
  const again = await service.call('note.create', { title: '学习笔记 · 2026-10-09', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true });
  assert.equal(again.id, first.id);
  assert.equal(again.reused, true, 'and says so');
  assert.equal(again.title, '学习笔记 · 2026-10-08', 'the draft keeps its own title');
  assert.equal((await service.call('note.list')).notes.length, 1);
});

test('another question, a note with more cards, a published note and a call without `reuse` each make a new note', async t => {
  const service = await library(t);
  const one = await service.call('note.create', { title: 'A', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true });
  const other = await service.call('note.create', { title: 'B', cards: [{ deckId: 'deck', cardId: 'c2' }], reuse: true });
  assert.notEqual(other.id, one.id, 'another question');
  const both = await service.call('note.create', { title: 'C', cards: [{ deckId: 'deck', cardId: 'c1' }, { deckId: 'deck', cardId: 'c2' }] });
  const single = await service.call('note.create', { title: 'D', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true });
  assert.equal(single.id, one.id, 'a note that also holds other cards is not the one for this card');
  assert.notEqual(both.id, one.id);
  const plain = await service.call('note.create', { title: 'E', cards: [{ deckId: 'deck', cardId: 'c1' }] });
  assert.notEqual(plain.id, one.id, 'picking questions by hand (挑题成文) always makes the note that was asked for');
  await service.call('note.home', { home: 'https://blog.csdn.net/example' });
  await service.call('note.link', { id: one.id, url: 'https://blog.csdn.net/example/article/details/1' });
  const after = await service.call('note.create', { title: 'F', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true });
  assert.notEqual(after.id, one.id, 'a published note is finished and is never the one reused');
  assert.equal(after.id, plain.id, 'the open draft of exactly this card is');
});

test('the AI draft has an estimate of its own, from the same prompt the draft sends, with no model call', async t => {
  let calls = 0;
  const service = await library(t, { complete: async () => { calls++; return '{}'; } });
  const note = await service.call('note.create', { title: 'Bridge and memento', cards: [{ deckId: 'deck', cardId: 'c1' }] });
  const estimate = await service.call('usage.estimate', { feature: 'note', id: note.id });
  assert.equal(calls, 0);
  assert.equal(estimate.feature, 'note');
  assert.deepEqual(estimate.calls, { low: 1, high: 1 }, 'one call');
  assert.ok(estimate.totalTokens.low > 0 && estimate.totalTokens.low <= estimate.totalTokens.high);
  assert.ok(estimate.inputTokens.low >= blogGenerationSystem.length / 6, 'the instructions are part of the input');
  assert.ok(estimate.outputTokens.high > estimate.outputTokens.low, 'the length of an article is a range');
  assert.deepEqual(estimate.stages.map(stage => stage.id), ['article']);
  const bigger = await service.call('note.create', { title: 'Both', cards: [{ deckId: 'deck', cardId: 'c1' }, { deckId: 'deck', cardId: 'c2' }] });
  const two = await service.call('usage.estimate', { feature: 'note', id: bigger.id });
  assert.ok(two.totalTokens.high > estimate.totalTokens.high, 'more questions, a longer article');
  await assert.rejects(service.call('usage.estimate', { feature: 'note', id: 'gone' }), /note/i);
});
