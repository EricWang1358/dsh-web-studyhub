import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestionRequest, markPreparing, cancelQuestionPreparation } from '../lib/guided-question-prep.js';

/* The pure rules of 带学「现场出一道新题」 (#547). The question itself is written and reviewed by the supplement job
   (tests/guided-question-supplement.test.mjs drives it end to end). */

const library = (settings = { allowNewQuestions: true }) => {
  const session = { id: 's1', status: 'active', courseId: 'CS101', scope: [{ kind: 'source', id: 'src-1' }], settings };
  return { session, state: {
    studySessions: [session],
    sources: [{ id: 'src-1', text: 'Some verified content', courses: ['CS101'] }, { id: 'src-out', text: 'Outside', courses: ['OtherCourse'] }],
    decks: [{ id: 'd1', course: 'CS101', cards: [{ id: 'c1' }] }, { id: 'sys', course: 'CS101', systemKind: 'coach', cards: [] }, { id: 'old', course: 'CS101', archived: true, cards: [] }],
  } };
};

test('the allowNewQuestions setting, the scope and the deck are checked before anything starts', () => {
  const { state, session } = library({ allowNewQuestions: false });
  assert.throws(() => checkQuestionRequest(state, { sessionId: 's1', deckId: 'd1' }), { code: 'study-setting-disabled' });
  session.settings.allowNewQuestions = true;
  assert.throws(() => checkQuestionRequest(state, { sessionId: 's1', deckId: 'd1', sourceIds: ['src-out'] }), { code: 'study-scope-denied' });
  for (const deckId of [undefined, 'missing', 'sys', 'old'])
    assert.throws(() => checkQuestionRequest(state, { sessionId: 's1', deckId }), { code: 'study-question-deck' }, String(deckId));
  session.status = 'paused';
  assert.throws(() => checkQuestionRequest(state, { sessionId: 's1', deckId: 'd1' }), { code: 'study-session-inactive' });
});

test('the session\'s own sources are the default evidence, and the deck\'s cards are remembered to find the new one', () => {
  const { state } = library();
  const asked = checkQuestionRequest(state, { sessionId: 's1', deckId: 'd1', focus: '  the definition  ' });
  assert.deepEqual(asked.sourceIds, ['src-1']);
  assert.deepEqual(asked.knownCardIds, ['c1']);
  assert.equal(asked.kind, 'quiz');
  assert.equal(asked.focus, 'the definition');
});

test('one question at a time, and 取消准备 hands back the job to cancel', () => {
  const { state, session } = library();
  markPreparing(session, { jobId: 'j1', deckId: 'd1', knownCardIds: ['c1'] });
  assert.throws(() => checkQuestionRequest(state, { sessionId: 's1', deckId: 'd1' }), { code: 'study-question-busy' });
  assert.deepEqual(cancelQuestionPreparation(session), { cancelled: true, jobId: 'j1' });
  assert.equal(session.focus, null);
  assert.deepEqual(cancelQuestionPreparation(session), { cancelled: false });
});
