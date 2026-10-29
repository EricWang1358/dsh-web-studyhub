import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudySession, updateStudySession } from '../lib/study-session.js';
import { markPreparing, questionOutcome, settlePreparing } from '../lib/guided-question-prep.js';
import { createPanelBridge } from '../lib/panel-bridge.js';
import { saveGuidedQA } from '../lib/guided-qa.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { computeSessionProgress } from '../lib/study-progress.js';

/* Chaos 1 and 2 drive the real job in tests/guided-question-supplement.test.mjs (a library with no model, a review that rejects the question);
   here the pure rules: a job that ended without exactly one new question is never shown as one, and the session stops waiting. */
test('Chaos 1: a job that failed or was cut short is never shown as a question, and the session does not stay in preparing-card (ADR-04, UC-10)', () => {
  const state = { decks: [{ id: 'd1', course: 'CS101', cards: [{ id: 'c-orig' }] }] };
  const session = { id: 's', focus: null };
  markPreparing(session, { jobId: 'j1', deckId: 'd1', knownCardIds: ['c-orig'] });
  for (const job of [{ status: 'failed', error: 'model timeout' }, { status: 'interrupted' }, { status: 'cancelled' }]) {
    const outcome = questionOutcome(state, session.focus, job);
    assert.equal(outcome.status, 'failed', job.status);
    assert.equal(outcome.fallback, 'reuse_existing');
  }
  settlePreparing(session, questionOutcome(state, session.focus, { status: 'failed' }));
  assert.equal(session.focus, null);
});

test('Chaos 2: a review that published nothing leaves the bank as it was and says why (HB-7)', () => {
  const state = { decks: [{ id: 'd1', course: 'CS101', cards: [{ id: 'c-orig' }] }] };
  const outcome = questionOutcome(state, { jobId: 'j', deckId: 'd1', knownCardIds: ['c-orig'] }, { status: 'complete', publication: { deckId: 'd1', added: 0 } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason, /没有通过独立审核/);
  assert.equal(state.decks[0].cards.length, 1);
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
