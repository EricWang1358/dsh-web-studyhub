import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStudySession,
  updateStudySession,
  upsertTeachingArtifact,
  assertScopeAllowed,
  sanitizeTeachingMarkdown,
} from '../lib/study-session.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';

test('createStudySession validates course and scope and initializes with clean state', () => {
  const state = {
    courses: [{ id: 'c-intro', name: 'Intro' }],
    sources: [{ id: 's1', courses: ['Intro'] }],
    decks: [{ id: 'd1', course: 'Intro', cards: [{ id: 'q1' }] }],
  };

  const session = createStudySession(state, {
    courseId: 'Intro',
    scope: [{ kind: 'source', id: 's1' }, { kind: 'deck', id: 'd1' }],
    goal: {
      title: 'Master Topic 1',
      checkItems: [{ id: 'item-1', title: 'Check 1', targetCardIds: ['q1'] }],
    },
    settings: {
      allowNewQuestions: false,
      autoOrganizeQA: true,
      allowNoteEdits: false,
    },
  });

  assert.equal(session.courseId, 'Intro');
  assert.equal(session.version, 1);
  assert.equal(session.status, 'active');
  assert.equal(session.goal.checkItems.length, 1);
  assert.equal(session.goal.checkItems[0].weight, 1);
  assert.deepEqual(session.returnPath, []);
  assert.deepEqual(session.artifactRefs, []);
  assert.deepEqual(session.predictions, []);
  assert.deepEqual(session.receipts, []);
});

test('createStudySession rejects unauthorized or non-existent course (HB-3)', () => {
  const state = {
    courses: [{ id: 'c-intro', name: 'Intro' }],
  };

  assert.throws(
    () => createStudySession(state, { courseId: 'Hacking101' }),
    { code: 'study-scope-denied' },
  );
});

test('assertScopeAllowed rejects target outside course/scope', () => {
  const state = {
    courses: [{ id: 'c-intro', name: 'Intro' }, { id: 'c-adv', name: 'Adv' }],
    sources: [
      { id: 's1', courses: ['Intro'] },
      { id: 's2', courses: ['Adv'] },
    ],
    decks: [
      { id: 'd1', course: 'Intro', cards: [{ id: 'q1' }] },
      { id: 'd2', course: 'Adv', cards: [{ id: 'q2' }] },
    ],
  };

  const session = {
    courseId: 'Intro',
    scope: [{ kind: 'source', id: 's1' }, { kind: 'deck', id: 'd1' }],
  };

  assert.doesNotThrow(() => assertScopeAllowed(session, { kind: 'source', id: 's1' }, state));
  assert.doesNotThrow(() => assertScopeAllowed(session, { kind: 'deck', id: 'd1' }, state));
  assert.doesNotThrow(() => assertScopeAllowed(session, { kind: 'card', deckId: 'd1', cardId: 'q1' }, state));

  assert.throws(
    () => assertScopeAllowed(session, { kind: 'source', id: 's2' }, state),
    { code: 'study-scope-denied' },
  );
  assert.throws(
    () => assertScopeAllowed(session, { kind: 'card', deckId: 'd2', cardId: 'q2' }, state),
    { code: 'study-scope-denied' },
  );
});

test('updateStudySession rejects version conflicts (expectedVersion)', () => {
  const session = {
    id: 's-1',
    courseId: 'Intro',
    version: 3,
    status: 'active',
  };

  assert.throws(
    () => updateStudySession(session, { expectedVersion: 2, status: 'paused' }),
    { code: 'study-session-version-conflict' },
  );

  const updated = updateStudySession(session, { expectedVersion: 3, status: 'paused' });
  assert.equal(updated.version, 4);
  assert.equal(updated.status, 'paused');
});

test('updateStudySession requires explicit authorization to widen settings (HB-6)', () => {
  const session = {
    id: 's-1',
    courseId: 'Intro',
    version: 1,
    settings: { allowNoteEdits: false },
  };

  assert.throws(
    () => updateStudySession(session, { settings: { allowNoteEdits: true } }),
    { code: 'study-setting-disabled' },
  );

  const authorized = updateStudySession(session, {
    settings: { allowNoteEdits: true },
    explicitUserAuthorization: true,
  });
  assert.equal(authorized.settings.allowNoteEdits, true);
});

test('updateStudySession requires scopeNote when changing checkItems denominator', () => {
  const session = {
    id: 's-1',
    courseId: 'Intro',
    version: 1,
    goal: {
      title: 'Goal',
      checkItems: [{ id: '1', title: 'Item 1' }],
      scopeNote: '',
    },
  };

  assert.throws(
    () => updateStudySession(session, {
      goal: {
        title: 'Goal',
        checkItems: [{ id: '1', title: 'Item 1' }, { id: '2', title: 'Item 2' }],
      },
    }),
    { code: 'study-goal-scope-note-required' },
  );

  const ok = updateStudySession(session, {
    goal: {
      title: 'Goal',
      checkItems: [{ id: '1', title: 'Item 1' }, { id: '2', title: 'Item 2' }],
      scopeNote: 'Added item 2 because user asked for advanced exercises',
    },
  });
  assert.equal(ok.goal.checkItems.length, 2);
  assert.equal(ok.goal.scopeNote, 'Added item 2 because user asked for advanced exercises');
});

test('upsertTeachingArtifact supports operationId idempotency (HB-5)', () => {
  const session = {
    id: 's-1',
    version: 1,
    artifactRefs: [],
    receipts: [],
  };

  const res1 = upsertTeachingArtifact(session, {
    operationId: 'op-art-100',
    id: 'art-1',
    kind: 'derivation',
    title: 'Formula Derivation',
    markdown: 'E = mc^2',
  });

  assert.equal(res1.deduplicated, false);
  assert.equal(session.artifactRefs.length, 1);
  assert.equal(session.artifactRefs[0].id, 'art-1');
  assert.equal(session.receipts.length, 1);

  // Replay identical operationId
  const res2 = upsertTeachingArtifact(session, {
    operationId: 'op-art-100',
    id: 'art-1',
    markdown: 'E = mc^2',
  });

  assert.equal(res2.deduplicated, true);
  assert.equal(session.artifactRefs.length, 1);
  assert.equal(res2.artifactId, 'art-1');
});

test('sanitizeTeachingMarkdown strips scripts and inline event handlers (HB-8)', () => {
  const dangerous = 'Normal text <script>alert("hack")</script> <img src="x" onerror="steal()" /> <a href="javascript:alert(1)">link</a>';
  const clean = sanitizeTeachingMarkdown(dangerous);

  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /onerror/i);
  assert.doesNotMatch(clean, /javascript:/i);
  assert.match(clean, /Normal text/);
});

test('assistantRefusal enforces HB-1 by rejecting answering and submission actions from assistant', () => {
  for (const action of ['review.answer', 'exam.submit', 'oral.answer', 'oral.submit']) {
    const refusal = assistantRefusal(action);
    assert.ok(refusal, `Expected ${action} to be refused`);
    assert.match(refusal, /HB-1/);
  }

  // Reads and safe operations must not be refused
  assert.equal(assistantRefusal('panel.open'), null);
  assert.equal(assistantRefusal('panel.current'), null);
  assert.equal(assistantRefusal('study.session.start'), null);
});
