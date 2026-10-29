import test from 'node:test';
import assert from 'node:assert/strict';
import { saveGuidedQA } from '../lib/guided-qa.js';

test('saveGuidedQA creates AI-organized QA with idempotency and scope guard', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'deck', id: 'd1' }],
    settings: { autoOrganizeQA: true, allowNoteEdits: false },
  };

  const card = { id: 'c1', prompt: 'What is recursion?', followups: [] };
  const state = {
    studySessions: [session],
    decks: [{ id: 'd1', cards: [card] }],
    sources: [{ id: 'src-1', text: 'Recursion is a process in which a function calls itself.' }],
  };

  // 1. Initial save
  const res1 = saveGuidedQA(state, {
    sessionId: 's1',
    operationId: 'op-qa-1',
    target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
    question: 'How to understand recursion simply?',
    answerMarkdown: 'Recursion calls itself until base case is hit.',
    citations: [{ sourceId: 'src-1', quote: 'Recursion is a process in which a function calls itself.' }],
    linkToTopic: { course: 'CS101', hid: 'topic-recursion' },
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.deduplicated, false);
  assert.equal(card.followups.length, 1);
  assert.equal(card.followups[0].author, 'ai-organized');
  assert.equal(card.followups[0].revision, 1);
  assert.equal(card.followups[0].citations.length, 1);

  // Topic link pointer created
  assert.equal(state.topicQARefs.length, 1);
  assert.equal(state.topicQARefs[0].kind, 'card-qa-ref');
  assert.equal(state.topicQARefs[0].qaId, res1.qaId);

  // 2. Idempotent replay with same operationId
  const res2 = saveGuidedQA(state, {
    sessionId: 's1',
    operationId: 'op-qa-1',
    target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
    question: 'How to understand recursion simply?',
    answerMarkdown: 'Recursion calls itself until base case is hit.',
  });

  assert.equal(res2.deduplicated, true);
  assert.equal(res2.qaId, res1.qaId);
  assert.equal(card.followups.length, 1);

  // 3. Idempotency conflict with different content
  assert.throws(
    () => saveGuidedQA(state, {
      sessionId: 's1',
      operationId: 'op-qa-1',
      target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
      question: 'A totally different question?',
      answerMarkdown: 'Different answer.',
    }),
    { code: 'qa-idempotency-conflict' },
  );
});

test('saveGuidedQA rejects when autoOrganizeQA is disabled without explicitUserCommand', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'deck', id: 'd1' }],
    settings: { autoOrganizeQA: false },
  };
  const state = {
    studySessions: [session],
    decks: [{ id: 'd1', cards: [{ id: 'c1', followups: [] }] }],
  };

  assert.throws(
    () => saveGuidedQA(state, {
      sessionId: 's1',
      target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
      question: 'Q',
      answerMarkdown: 'A',
    }),
    { code: 'study-setting-disabled' },
  );

  // Explicit user command bypasses disabled auto setting
  const ok = saveGuidedQA(state, {
    sessionId: 's1',
    target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
    question: 'Q',
    answerMarkdown: 'A',
    explicitUserCommand: true,
  });
  assert.equal(ok.ok, true);
});

test('saveGuidedQA protects user-authored notes with history and version checks (HB-6)', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'deck', id: 'd1' }],
    settings: { autoOrganizeQA: true, allowNoteEdits: true },
  };

  const userQa = {
    id: 'qa-user-1',
    author: 'user',
    question: 'My original question',
    answer: 'My hand-written note',
    revision: 1,
  };

  const card = { id: 'c1', followups: [userQa] };
  const state = {
    studySessions: [session],
    decks: [{ id: 'd1', cards: [card] }],
  };

  // 1. Rejects overwrite without allowOverwriteUser
  assert.throws(
    () => saveGuidedQA(state, {
      sessionId: 's1',
      target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
      targetQaId: 'qa-user-1',
      question: 'Revised Q',
      answerMarkdown: 'Revised A',
      allowOverwriteUser: false,
    }),
    { code: 'study-user-content-protected' },
  );

  // 2. Rejects when expectedVersion does not match
  assert.throws(
    () => saveGuidedQA(state, {
      sessionId: 's1',
      target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
      targetQaId: 'qa-user-1',
      question: 'Revised Q',
      answerMarkdown: 'Revised A',
      allowOverwriteUser: true,
      expectedVersion: 99,
    }),
    { code: 'qa-version-conflict' },
  );

  // 3. Overwrites with version match and saves old content into history
  const updatedRes = saveGuidedQA(state, {
    sessionId: 's1',
    target: { kind: 'card', deckId: 'd1', cardId: 'c1' },
    targetQaId: 'qa-user-1',
    question: 'Refined Question',
    answerMarkdown: 'Organized explanation',
    allowOverwriteUser: true,
    expectedVersion: 1,
  });

  assert.equal(updatedRes.ok, true);
  assert.equal(userQa.question, 'Refined Question');
  assert.equal(userQa.revision, 2);
  assert.equal(userQa.history.length, 1);
  assert.equal(userQa.history[0].answer, 'My hand-written note');
});
