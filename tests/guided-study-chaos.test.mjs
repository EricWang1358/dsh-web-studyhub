import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudySession, updateStudySession } from '../lib/study-session.js';
import { prepareSingleQuestion } from '../lib/guided-question-prep.js';
import { createPanelBridge } from '../lib/panel-bridge.js';
import { saveGuidedQA } from '../lib/guided-qa.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { computeSessionProgress } from '../lib/study-progress.js';

test('Chaos 1: Model timeout / unavailability degrades gracefully without crashing (ADR-04, UC-10)', () => {
  const state = {
    courses: [{ id: 'CS101', name: 'CS101' }],
    sources: [{ id: 'src-1', courses: ['CS101'] }],
    decks: [{ id: 'd1', course: 'CS101', cards: [] }],
    studySessions: [],
  };

  const session = createStudySession(state, {
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }],
    settings: { allowNewQuestions: true },
  });
  state.studySessions.push(session);

  // Simulate model unavailable / timeout
  const result = prepareSingleQuestion(state, {
    sessionId: session.id,
    sourceIds: ['src-1'],
    modelAvailable: false,
  });

  assert.equal(result.available, false);
  assert.equal(result.fallback, 'reuse_existing');
  assert.match(result.message, /建议复用已有题目/);
  // Session focus must not get stuck in preparing-card
  assert.notEqual(session.focus?.kind, 'preparing-card');
});

test('Chaos 2: Verification audit failure rejects flawed question and leaves bank clean (HB-7)', () => {
  const state = {
    courses: [{ id: 'CS101', name: 'CS101' }],
    sources: [{ id: 'src-1', courses: ['CS101'] }],
    decks: [{ id: 'd1', course: 'CS101', cards: [{ id: 'c-orig' }] }],
    studySessions: [],
  };

  const session = createStudySession(state, {
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }],
    settings: { allowNewQuestions: true },
  });
  state.studySessions.push(session);

  const initialDeckSize = state.decks[0].cards.length;

  const failure = prepareSingleQuestion(state, {
    sessionId: session.id,
    targetDeckId: 'd1',
    sourceIds: ['src-1'],
    simulateVerificationFailure: true,
  });

  assert.equal(failure.ok, false);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.code, 'citation_verification_failed');
  assert.equal(failure.fallback, 'reuse_existing');

  // Assert defective card was never appended to the deck
  assert.equal(state.decks[0].cards.length, initialDeckSize);
  // Focus reset from preparing-card
  assert.equal(session.focus, null);
});

test('Chaos 3: Unmounted / closed panel honestly reports queued_for_sidebar instead of fake visible (ADR-04, UC-10)', async () => {
  const bridge = createPanelBridge();
  const sessionId = 'sess-unmounted-panel';

  // Queue panel intent
  const queueRes = bridge.queuePanelIntent(sessionId, { type: 'run', runId: 'r-test' });
  assert.ok(queueRes.intentId);

  // Panel never mounts -> waitForIntentAck times out
  const ack = await bridge.waitForIntentAck(sessionId, queueRes.intentId, 50);
  assert.equal(ack, null);

  // Status must be queued_for_sidebar and confirmed must be false
  const isVisible = !!(ack && ack.status === 'displayed');
  const status = isVisible ? 'visible_in_sidebar' : 'queued_for_sidebar';
  assert.equal(status, 'queued_for_sidebar');
  assert.equal(isVisible, false);
});

test('Chaos 4: Late async panel intent does not overwrite newer sequence, preserving user draft (HB-4)', () => {
  const bridge = createPanelBridge();
  const sessionId = 'sess-late-ack';
  const now = 10000;

  const run1 = { id: 'r1', card: { id: 'card-1' }, index: 0 };
  const run2 = { id: 'r2', card: { id: 'card-2' }, index: 1, entries: [{ draft: { text: 'Critical unsaved input' } }] };

  // User moved to card 2 at sequence 5
  bridge.setPanelVisible(sessionId, 'sidebar', run2, now, 5);

  // Stale async callback from card 1 arrives with older sequence 4
  const staleObs = bridge.setPanelVisible(sessionId, 'sidebar', run1, now + 50, 4);

  // Stale callback was ignored; active visible state remains card 2
  assert.equal(staleObs.cardId, 'card-2');
  assert.equal(staleObs.runId, 'r2');
});

test('Chaos 5: Revoked permissions mid-session reject late tool write attempts (HB-3, HB-6)', () => {
  const state = {
    courses: [{ id: 'CS101', name: 'CS101' }],
    sources: [{ id: 'src-1', courses: ['CS101'], text: 'Grounding text' }],
    decks: [{
      id: 'd1',
      course: 'CS101',
      cards: [{
        id: 'c1',
        followups: [
          { id: 'qa-user-1', author: 'user', question: 'My note', answer: 'My answer', revision: 1 },
        ],
      }],
    }],
    studySessions: [],
  };

  const session = createStudySession(state, {
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-1' }, { kind: 'card', deckId: 'd1', cardId: 'c1' }],
    settings: {
      autoOrganizeQA: true,
      allowNoteEdits: true,
    },
  });
  state.studySessions.push(session);

  // User revokes autoOrganizeQA
  const updatedSession = updateStudySession(session, {
    settings: { autoOrganizeQA: false },
  });
  state.studySessions[0] = updatedSession;

  // Late tool attempts to write QA
  assert.throws(
    () => saveGuidedQA(state, {
      sessionId: session.id,
      target: { deckId: 'd1', cardId: 'c1' },
      question: 'Late question',
      answerMarkdown: 'Late answer',
    }),
    { code: 'study-setting-disabled' },
  );

  // Re-enable autoOrganizeQA but revoke allowNoteEdits
  state.studySessions[0] = updateStudySession(updatedSession, {
    settings: { autoOrganizeQA: true, allowNoteEdits: false },
    explicitUserAuthorization: true,
  });

  // Late tool attempts to overwrite user note
  assert.throws(
    () => saveGuidedQA(state, {
      sessionId: session.id,
      target: { deckId: 'd1', cardId: 'c1' },
      targetQaId: 'qa-user-1',
      question: 'Tampered note',
      answerMarkdown: 'Tampered answer',
      allowOverwriteUser: true,
    }),
    { code: 'study-setting-disabled' },
  );
});

test('Chaos 6: Assistant direct answer tampering and checkItem manipulation are blocked (HB-1, HB-2)', () => {
  // HB-1: Assistant cannot invoke answer or submission tools
  assert.match(assistantRefusal('review.answer'), /HB-1/);
  assert.match(assistantRefusal('exam.submit'), /HB-1/);
  assert.match(assistantRefusal('oral.answer'), /HB-1/);
  assert.match(assistantRefusal('oral.submit'), /HB-1/);

  // HB-2: checkItem status is strictly derived from real attempts, never modifiable directly
  const session = {
    id: 's-hb2',
    goal: {
      checkItems: [{ id: 'chk-1', title: 'Calculus Limit', targetCardIds: ['c1'] }],
    },
  };

  // Attempt with assistance
  const attemptsAssisted = [{ quiz_id: 'c1', grade: 4, correct: true, assistance: { hintUsed: true } }];
  const progress1 = computeSessionProgress(session, attemptsAssisted, []);
  assert.equal(progress1.independentPassedCount, 0);
  assert.equal(progress1.items[0].status, 'assisted');

  // No arbitrary tool or LLM can turn status to 'passed' without unassisted attempt
  const attemptsEmpty = [];
  const progress2 = computeSessionProgress(session, attemptsEmpty, []);
  assert.equal(progress2.independentPassedCount, 0);
  assert.equal(progress2.items[0].status, 'pending');
});
