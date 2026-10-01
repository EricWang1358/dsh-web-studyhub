import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../web-demo/store.js';
import { seedDemo } from '../web-demo/seed.js';
import { sampleBoard } from '../web-demo/board-seed.js';
import { StudyService } from '../lib/service.js';

test('demo records populate the real service views and remain actionable', async () => {
  const state = initialState();
  const service = new StudyService('/demo');
  service.store = { root: '/demo', read: async () => structuredClone(state), stamp: async () => String(state.revision),
    update: async fn => { const result = await fn(state); state.revision++; return structuredClone(result); } };
  const stats = await service.call('stats');
  assert.equal(stats.totals.attempts, 44);
  assert.ok(stats.trend.length >= 21);
  assert.equal((await service.call('wrongbook')).total, 2);
  const snapshot = await service.call('snapshot');
  assert.equal(snapshot.inbox.unread, 2);
  assert.equal(snapshot.skeletons.length, 1);
  assert.ok(state.decks[0].cards.some(c => c.requires?.length));
  assert.equal(state.notes.length, 2);
  const { session } = await service.call('workflow.session.get', { id: 'demo-guided-session' });
  assert.match(session.records[session.currentStepId].content, /Three roles/);
  const draft = snapshot.drafts.find(d => d.id === 'demo-draft');
  assert.equal(draft.cards.length, 3);
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'patterns-demo', cardId: 'bridge-render' }], fresh: true });
  const revealed = await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  assert.match(revealed.solution.answer, /rendering backends/);
  await service.call('inbox.read', { all: true });
  assert.equal((await service.call('inbox')).unread, 0);
  await service.call('draft.publish.quick', { id: draft.id });
  assert.ok(state.decks.some(d => d.id === draft.id));
});

test('demo upgrade is idempotent and preserves real answers and edited content', () => {
  const state = initialState();
  delete state.demoSeedVersion;
  for (const field of ['attempts', 'skeletons', 'notes', 'inbox', 'workflowSessions', 'drafts']) state[field] = [];
  const card = state.decks[0].cards[0];
  card.prompt = 'My edited question';
  const review = structuredClone(card.review);
  const answer = { id: 'visitor-answer', quiz_id: card.id, grade: 5, timestamp: new Date().toISOString() };
  state.attempts.push(answer);
  seedDemo(state);
  assert.equal(card.prompt, 'My edited question');
  assert.deepEqual(card.review, review);
  assert.deepEqual(state.attempts.filter(a => a.quiz_id === card.id), [answer]);
  const once = structuredClone(state);
  seedDemo(state);
  assert.deepEqual(state, once);
  const board = sampleBoard();
  assert.equal(Object.keys(board.cards).length, 3);
  assert.equal(board.columns.filter(c => c.cardIds.length).length, 3);
});
