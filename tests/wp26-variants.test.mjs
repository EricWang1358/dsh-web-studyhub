import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

// WP26: "生成变式" for chosen wrong-book cards reuses the coach prep queue; the
// recommend / detail reads behind the wrong-book page need no model.
const source = { id: 'src', title: 'Memento notes',
  text: 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots.' };
const quiz = (n, prompt, topic = 'Memento') => ({ id: `q${n}`, kind: 'quiz', topic, objective: `objective ${n}`, prompt, answer: 'Caretaker',
  hint: 'Who keeps the history?', explanation: 'The Caretaker keeps history; the Originator restores state.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It manages history without reading snapshots.' },
    { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot, not its manager.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It creates and restores snapshots.' }] });

async function setup(t, { cards = 10, coach = true, light = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-wp26-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = [], model = createFakeModel({ log });
  const service = new StudyService(root, { ...(light ? { complete: model, completeLight: model } : {}), coach });
  await service.call('source.add', source);
  await service.call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: Array.from({ length: cards }, (_, i) => quiz(i + 1, `第 ${i + 1} 个关于 Memento 的问题：谁管理历史 ${i}？`, i < 3 ? '保护状态' : 'Memento')) } });
  await new StudyService(root).call('draft.publish', { id: 'd' });
  return { root, service, log, model };
}
const wrong = (run) => run.card.options.find((o) => o.text === 'Memento').id;
async function miss(service, count) {
  let run = await service.call('review.start', { deckId: 'd', mode: 'quiz', count });
  const refs = [];
  for (let i = 0; i < count; i++) {
    refs.push({ deckId: 'd', cardId: run.card.id });
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [wrong(run)] });
    if (i < count - 1) run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return refs;
}
const batches = (log) => log.filter((x) => x.prompt.includes('为每个 target')).length;

test('variants need the learner\'s yes first: without consent nothing is queued and no model is called', async (t) => {
  const { service, log } = await setup(t);
  const refs = await miss(service, 2);
  const result = await service.call('coach.variants', { cards: refs });
  assert.equal(result.needsConsent, true);
  assert.equal(result.queued, 0);
  assert.equal(result.status.consent, null);
  await service.call('coach.prepare');
  assert.equal(batches(log), 0);
});

test('"同意并生成" grants the consent and queues exactly the chosen cards, visibly', async (t) => {
  const { service, log } = await setup(t);
  const refs = await miss(service, 3);
  const result = await service.call('coach.variants', { cards: refs.slice(0, 2), consent: true });
  assert.equal(result.queued, 2);
  assert.equal(result.status.consent, true);
  assert.deepEqual([...result.status.preparingCards].sort(), refs.slice(0, 2).map((r) => r.cardId).sort());
  const settled = await service.call('coach.prepare');
  assert.equal(settled.ready, 2, 'one variant per chosen card; the third miss was not prepared');
  assert.equal(batches(log), 1);
  assert.deepEqual(settled.preparingCards, []);
  assert.deepEqual(settled.readyCards.map((r) => r.originCardId).sort(), refs.slice(0, 2).map((r) => r.cardId).sort());
  assert.ok(settled.readyCards.every((r) => r.originDeckId === 'd' && typeof r.prompt === 'string' && r.prompt));
});

test('a batch is capped at eight cards; the rest are reported as deferred', async (t) => {
  const { service } = await setup(t, { cards: 10 });
  const refs = await miss(service, 10);
  const result = await service.call('coach.variants', { cards: refs, consent: true });
  assert.equal(result.queued, 8);
  assert.equal(result.deferred, 2);
  const settled = await service.call('coach.prepare');
  assert.equal(settled.ready, 8);
});

test('asking again never prepares the same card twice, while preparing or once ready', async (t) => {
  const { service, log, model } = await setup(t);
  const refs = await miss(service, 2);
  const release = Promise.withResolvers();
  service.light = async (...args) => { await release.promise; return model(...args); };
  await service.call('coach.variants', { cards: refs, consent: true });
  const during = await service.call('coach.variants', { cards: refs });
  assert.equal(during.queued, 0);
  assert.deepEqual(during.skipped.map((s) => s.reason), ['preparing', 'preparing']);
  release.resolve();
  await service.call('coach.prepare');
  const after = await service.call('coach.variants', { cards: refs });
  assert.equal(after.queued, 0);
  assert.deepEqual(after.skipped.map((s) => s.reason), ['ready', 'ready']);
  await service.call('coach.prepare');
  assert.equal(batches(log), 1);
  const prepared = (await service.call('export')).prepared;
  assert.equal(prepared.length, 2);
  assert.equal(new Set(prepared.map((p) => p.originCardId)).size, 2);
});

test('without a usable model the action is refused in plain words instead of silently queueing', async (t) => {
  const { service } = await setup(t, { light: false });
  const refs = await miss(service, 1).catch(() => [{ deckId: 'd', cardId: 'q1' }]);
  await assert.rejects(service.call('coach.variants', { cards: refs, consent: true }), /模型/);
  const { service: off } = await setup(t, { coach: false });
  await assert.rejects(off.call('coach.variants', { cards: [{ deckId: 'd', cardId: 'q1' }], consent: true }), /模型/);
});

test('unknown cards are ignored and an empty request is an error', async (t) => {
  const { service } = await setup(t);
  await assert.rejects(service.call('coach.variants', { cards: [], consent: true }), /题/);
  const result = await service.call('coach.variants', { cards: [{ deckId: 'd', cardId: 'missing' }, { deckId: 'd', cardId: 'q1' }], consent: true });
  assert.equal(result.queued, 1);
  await service.call('coach.prepare');
});

test('a failed batch is reported per card with a plain message and can be retried', async (t) => {
  const { service, model } = await setup(t);
  const refs = await miss(service, 2);
  service.light = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9'); };
  await service.call('coach.variants', { cards: refs, consent: true });
  const failed = await service.call('coach.prepare');
  assert.equal(failed.ready, 0);
  assert.deepEqual(failed.failedCards.map((f) => f.cardId).sort(), refs.map((r) => r.cardId).sort());
  assert.ok(failed.failedCards.every((f) => f.message && !/ECONNREFUSED/.test(f.message)), 'no raw socket text');
  service.light = model;
  const retry = await service.call('coach.variants', { cards: refs });
  assert.equal(retry.queued, 2, 'a failed card is not "skipped"');
  const ok = await service.call('coach.prepare');
  assert.equal(ok.ready, 2);
  assert.deepEqual(ok.failedCards, []);
});

test('a batch the validator rejects shows up as failed for those cards, not as silence', async (t) => {
  const { service } = await setup(t);
  const refs = await miss(service, 1);
  service.light = async () => JSON.stringify({ cards: [] });
  await service.call('coach.variants', { cards: refs, consent: true });
  const settled = await service.call('coach.prepare');
  assert.equal(settled.failedCards[0].cardId, refs[0].cardId);
  assert.match(settled.failedCards[0].message, /校验/);
});

test('practising prepared variants can be limited to chosen mistakes and can include them', async (t) => {
  const { service } = await setup(t);
  const refs = await miss(service, 3);
  await service.call('coach.variants', { cards: refs.slice(0, 2), consent: true });
  await service.call('coach.prepare');
  const only = await service.call('coach.practice', { originCardIds: [refs[0].cardId] });
  assert.equal(only.total, 1);
  assert.equal((await service.call('coach.status')).ready, 1, 'the other variant stays ready');
  const withMistakes = await service.call('coach.practice', { scope: [refs[2]] });
  assert.equal(withMistakes.total, 2, 'the remaining variant plus the mistake itself');
});

test('wrongbook.recommend lists similar questions from the bank and wrongbook.detail explains one mistake', async (t) => {
  const { service } = await setup(t, { cards: 6 });
  const refs = await miss(service, 1);
  const rec = await service.call('wrongbook.recommend', { course: '*', limit: 10 });
  assert.ok(rec.items.length > 0 && rec.items.length <= 10);
  assert.ok(rec.items.every((item) => item.cardId !== refs[0].cardId));
  assert.ok(rec.items.every((item) => item.reasons.length && item.forCardIds.includes(refs[0].cardId)));
  const detail = await service.call('wrongbook.detail', refs[0]);
  assert.equal(detail.yourAnswer, 'Memento');
  assert.equal(detail.correctAnswer, 'Caretaker');
  assert.match(detail.explanation, /Caretaker keeps history/);
  await assert.rejects(service.call('wrongbook.detail', { deckId: 'd', cardId: 'missing' }), /题/);
});
