import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperations } from '../lib/contexts/study/operations.js';
import { projection } from '../lib/study-state.js';

test('review.draft.save persists draft text, options and assistance onto run entry', async () => {
  const run = {
    id: 'run-test-1',
    mode: 'path',
    deckId: 'deck-1',
    index: 0,
    entries: [
      {
        card: { id: 'c1', prompt: 'Explain gravity', kind: 'essay', topic: 'Physics' },
        deckId: 'deck-1',
        startedAt: Date.now(),
      },
    ],
  };

  const state = {
    runs: [run],
    decks: [{ id: 'deck-1', cards: [run.entries[0].card] }],
    sources: [],
    attempts: [],
    teaching: [],
  };

  const ports = {
    state: {
      read: async () => state,
      update: async (fn) => fn(state),
    },
    work: { translateInflight: new Map() },
  };

  const { mutations } = createOperations(ports);

  // Save partial text draft and assistance marker
  const saveRes = mutations['review.draft.save'](state, {
    runId: 'run-test-1',
    cardId: 'c1',
    draft: { text: 'Gravity is the curvature of spacetime...' },
    assistance: { hintUsed: true, askedTutorBeforeAnswer: true },
  });

  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.cardId, 'c1');
  assert.equal(saveRes.draft.text, 'Gravity is the curvature of spacetime...');
  assert.equal(saveRes.assistance.hintUsed, true);
  assert.equal(saveRes.assistance.askedTutorBeforeAnswer, true);
  assert.equal(saveRes.assistance.used, true);

  // Projection reflects saved draft and assistance
  const projected = projection(state, run);
  assert.equal(projected.draft.text, 'Gravity is the curvature of spacetime...');
  assert.equal(projected.assistance.hintUsed, true);
  assert.equal(projected.assistance.used, true);

  // Simulate process restart by cloning state
  const reloadedState = structuredClone(state);
  const reloadedRun = reloadedState.runs[0];
  const reloadedProjected = projection(reloadedState, reloadedRun);

  assert.equal(reloadedProjected.draft.text, 'Gravity is the curvature of spacetime...');
  assert.equal(reloadedProjected.assistance.askedTutorBeforeAnswer, true);
});
