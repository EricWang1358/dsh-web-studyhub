import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSingleQuestion, cancelQuestionPreparation } from '../lib/guided-question-prep.js';

test('prepareSingleQuestion enforces allowNewQuestions setting and scope guards', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }],
    settings: { allowNewQuestions: false },
  };
  const state = {
    studySessions: [session],
    sources: [{ id: 'src-1', text: 'Some verified content', courses: ['CS101'] }, { id: 'src-out', text: 'Outside', courses: ['OtherCourse'] }],
    decks: [{ id: 'd1', cards: [] }],
  };

  // Setting disabled rejection
  assert.throws(
    () => prepareSingleQuestion(state, { sessionId: 's1', sourceIds: ['src-1'] }),
    { code: 'study-setting-disabled' },
  );

  // Enable setting, but test unauthorized source
  session.settings.allowNewQuestions = true;
  assert.throws(
    () => prepareSingleQuestion(state, { sessionId: 's1', sourceIds: ['src-out'] }),
    { code: 'study-scope-denied' },
  );
});

test('prepareSingleQuestion honestly reports model unavailable (ADR-04 & UC-10)', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }],
    settings: { allowNewQuestions: true },
  };
  const state = {
    studySessions: [session],
    sources: [{ id: 'src-1', text: 'Text' }],
    decks: [{ id: 'd1', cards: [] }],
  };

  const res = prepareSingleQuestion(state, {
    sessionId: 's1',
    sourceIds: ['src-1'],
    modelAvailable: false,
  });

  assert.equal(res.available, false);
  assert.equal(res.reason, 'model_unavailable');
  assert.equal(res.fallback, 'reuse_existing');
  assert.match(res.message, /当前模型不可用/);
});

test('prepareSingleQuestion fails gracefully when independent verification fails (HB-7)', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }],
    settings: { allowNewQuestions: true },
  };
  const state = {
    studySessions: [session],
    sources: [{ id: 'src-1', text: 'Text' }],
    decks: [{ id: 'd1', cards: [] }],
  };

  const res = prepareSingleQuestion(state, {
    sessionId: 's1',
    sourceIds: ['src-1'],
    simulateVerificationFailure: true,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.equal(res.fallback, 'reuse_existing');
  assert.match(res.reason, /所选段落未能核对出可作答引文/);
  assert.equal(session.focus, null);
});

test('prepareSingleQuestion successfully creates reviewed question and cancelQuestionPreparation clears focus', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }],
    settings: { allowNewQuestions: true },
    focus: null,
  };
  const state = {
    studySessions: [session],
    sources: [{ id: 'src-1', text: 'Verified facts for questions' }],
    decks: [{ id: 'd1', cards: [] }],
  };

  // 1. Successful generation
  const res = prepareSingleQuestion(state, {
    sessionId: 's1',
    sourceIds: ['src-1'],
    targetDeckId: 'd1',
    prompt: 'What is the output of foo()?',
    topic: 'Functions',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'complete');
  assert.equal(state.decks[0].cards.length, 1);
  assert.equal(state.decks[0].cards[0].editorial.approved, true);
  assert.equal(session.focus.kind, 'card');
  assert.equal(session.focus.id, res.card.id);

  // 2. Cancellation of in-flight prep
  session.focus = { kind: 'preparing-card', jobId: 'j1' };
  const cancelRes = cancelQuestionPreparation(session);
  assert.equal(cancelRes.cancelled, true);
  assert.equal(session.focus, null);
});
