import test from 'node:test';
import assert from 'node:assert/strict';
import { openBranchCard, returnFromBranch } from '../lib/study-branch.js';

test('openBranchCard and returnFromBranch manage returnPath and isolate runs (UC-05)', () => {
  const session = {
    id: 'sess-1',
    courseId: 'CS101',
    status: 'active',
    version: 1,
    focus: { kind: 'card', id: 'parent-card-1', deckId: 'deck-main', runId: 'run-main' },
    returnPath: [],
  };

  const state = {
    studySessions: [session],
    decks: [
      { id: 'deck-main', cards: [{ id: 'parent-card-1', prompt: 'Complex problem' }] },
      { id: 'deck-prereq', cards: [{ id: 'prereq-card-1', prompt: 'Basic concept' }] },
    ],
    runs: [
      {
        id: 'run-main',
        deckId: 'deck-main',
        index: 0,
        entries: [
          {
            card: { id: 'parent-card-1' },
            draft: { text: 'half-written draft' },
            revealed: false,
          },
        ],
      },
    ],
  };

  // 1. Open prerequisite branch
  const { branchRun } = openBranchCard(state, {
    sessionId: 'sess-1',
    targetDeckId: 'deck-prereq',
    targetCardId: 'prereq-card-1',
    reason: 'Review foundation before answering complex question',
    branchKind: 'prerequisite',
  });

  assert.equal(session.returnPath.length, 1);
  assert.equal(session.returnPath[0].cardId, 'parent-card-1');
  assert.equal(session.returnPath[0].runId, 'run-main');
  assert.equal(session.focus.id, 'prereq-card-1');
  assert.equal(session.focus.runId, branchRun.id);

  // Original run and draft remain untouched
  assert.equal(state.runs[0].entries[0].draft.text, 'half-written draft');
  assert.equal(branchRun.branchOf.parentRunId, 'run-main');
  assert.equal(branchRun.branchOf.branchKind, 'prerequisite');

  // 2. Return from branch
  const { returnedTo } = returnFromBranch(state, { sessionId: 'sess-1' });

  assert.equal(session.returnPath.length, 0);
  assert.equal(session.focus.id, 'parent-card-1');
  assert.equal(session.focus.runId, 'run-main');
  assert.equal(returnedTo.cardId, 'parent-card-1');

  // Original run is still 100% intact
  assert.equal(state.runs[0].entries[0].draft.text, 'half-written draft');
});

test('openBranchCard rejects when returnPath exceeds MAX_RETURN_DEPTH (5)', () => {
  const session = {
    id: 'sess-overflow',
    focus: { kind: 'card', id: 'c0', deckId: 'd1', runId: 'r0' },
    returnPath: [
      { kind: 'card', cardId: 'c1' },
      { kind: 'card', cardId: 'c2' },
      { kind: 'card', cardId: 'c3' },
      { kind: 'card', cardId: 'c4' },
      { kind: 'card', cardId: 'c5' },
    ],
  };

  const state = {
    studySessions: [session],
    decks: [{ id: 'd1', cards: [{ id: 'c-next' }] }],
    runs: [],
  };

  assert.throws(
    () => openBranchCard(state, {
      sessionId: 'sess-overflow',
      targetDeckId: 'd1',
      targetCardId: 'c-next',
    }),
    { code: 'study-return-path-overflow' },
  );
});

test('returnFromBranch throws when returnPath is empty', () => {
  const session = {
    id: 'sess-empty',
    returnPath: [],
  };
  const state = { studySessions: [session] };

  assert.throws(
    () => returnFromBranch(state, { sessionId: 'sess-empty' }),
    { code: 'study-return-path-empty' },
  );
});
