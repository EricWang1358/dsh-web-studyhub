import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSessionProgress, deriveItemStatus } from '../lib/study-progress.js';

test('computeSessionProgress returns 0 independent passes when only lecture artifacts exist', () => {
  const session = {
    id: 's1',
    goal: {
      title: 'Goal',
      checkItems: [
        { id: 'item-1', title: 'Concept 1', weight: 1, targetCardIds: ['c1'] },
        { id: 'item-2', title: 'Concept 2', weight: 1, targetCardIds: ['c2'] },
      ],
    },
    artifactRefs: [
      { id: 'art-1', title: 'Lecture on Concept 1', topic: 'Concept 1' },
      { id: 'art-2', title: 'Lecture on Concept 2', topic: 'Concept 2' },
    ],
  };

  const progress = computeSessionProgress(session, [], []);

  assert.equal(progress.independentPassedCount, 0);
  assert.equal(progress.assistedCount, 0);
  assert.equal(progress.pendingCount, 2);
  assert.equal(progress.totalCount, 2);
  assert.equal(progress.independentRatio, 0);
  assert.equal(progress.lectureCoveredCount, 2);
  assert.match(progress.displayLine, /独立检验 0\/2（0%）/);
});

test('assisted pass only increments assistedCount and not independentPassedCount', () => {
  const session = {
    id: 's1',
    goal: {
      checkItems: [{ id: 'item-1', title: 'Concept 1', weight: 1, targetCardIds: ['c1'] }],
    },
  };

  const attempts = [
    {
      id: 'att-1',
      quiz_id: 'c1',
      correct: true,
      grade: 4,
      assistance: { used: true, hintUsed: true },
    },
  ];

  const progress = computeSessionProgress(session, attempts, []);

  assert.equal(progress.independentPassedCount, 0);
  assert.equal(progress.assistedCount, 1);
  assert.equal(progress.pendingCount, 0);
  assert.equal(progress.items[0].status, 'assisted');
});

test('multiple passes on the same check item do not duplicate credit', () => {
  const session = {
    id: 's1',
    goal: {
      checkItems: [{ id: 'item-1', title: 'Concept 1', weight: 1, targetCardIds: ['c1', 'c1-var'] }],
    },
  };

  const attempts = [
    { id: 'att-1', quiz_id: 'c1', correct: true, grade: 4, assistance: { used: false } },
    { id: 'att-2', quiz_id: 'c1-var', correct: true, grade: 5, assistance: { used: false } },
    { id: 'att-3', quiz_id: 'c1', correct: true, grade: 4, assistance: { used: false } },
  ];

  const progress = computeSessionProgress(session, attempts, []);

  assert.equal(progress.independentPassedCount, 1);
  assert.equal(progress.totalCount, 1);
  assert.equal(progress.independentRatio, 1);
});

test('subsequent failure degrades previously passed item to needs_review', () => {
  const checkItem = { id: 'item-1', title: 'Concept 1', targetCardIds: ['c1'] };

  const attempts = [
    { id: 'att-1', timestamp: 1000, quiz_id: 'c1', correct: true, grade: 4, assistance: { used: false } },
    { id: 'att-2', timestamp: 2000, quiz_id: 'c1', correct: false, grade: 1, assistance: { used: false } },
  ];

  const derived = deriveItemStatus(checkItem, attempts);
  assert.equal(derived.status, 'needs_review');
  assert.deepEqual(derived.evidenceAttemptIds, ['att-1', 'att-2']);
});

test('evidenceAttemptIds precisely tracks each attempt behind item status', () => {
  const checkItem = { id: 'item-1', title: 'Concept 1', targetCardIds: ['c1'] };

  const attempts = [
    { id: 'a1', timestamp: 10, quiz_id: 'c1', correct: true, grade: 3, assistance: { used: true, hintUsed: true } },
    { id: 'a2', timestamp: 20, quiz_id: 'c1', correct: true, grade: 4, assistance: { used: false } },
  ];

  const derived = deriveItemStatus(checkItem, attempts);
  assert.equal(derived.status, 'passed');
  assert.deepEqual(derived.evidenceAttemptIds, ['a1', 'a2']);
});

test('every flag of the recorded help makes a pass helped, the same way everywhere', () => {
  const pass = (assistance) => [{ id: 'a', correct: true, timestamp: 1, assistance }];
  for (const assistance of [{ used: true }, { hintUsed: true }, { revealedBeforeAnswer: true }, { askedTutorBeforeAnswer: true }])
    assert.equal(deriveItemStatus({}, pass(assistance)).status, 'assisted');
  assert.equal(deriveItemStatus({}, pass({ used: false, hintUsed: false })).status, 'passed');
  assert.equal(deriveItemStatus({}, pass(undefined)).status, 'passed');
  assert.equal(deriveItemStatus({}, [{ id: 'r', correct: true, timestamp: 1, retry: true, assistance: { used: false } }]).status, 'assisted', 'a retry comes after the answer was shown');
});

const dueAttempt = (id, quiz_id, timestamp, dueAfterMs, extra = {}) => ({ id, quiz_id, timestamp: new Date(timestamp).toISOString(), grade: 4, correct: true,
  after: { due_at: new Date(timestamp + dueAfterMs).toISOString() }, ...extra });

test('nextDayDueCount is the cards of this session whose latest answer scheduled them for a later day', () => {
  const DAY = 86400000;
  const createdAt = Date.parse('2026-11-01T00:00:00.000Z');
  const session = { createdAt, goal: { checkItems: [{ id: 'i', title: 'I', targetCardIds: ['a', 'b', 'c', 'd'] }] } };
  const attempts = [
    dueAttempt('before', 'd', createdAt - 1000, 3 * DAY),
    dueAttempt('a1', 'a', createdAt + 1000, DAY),
    dueAttempt('a2', 'a', createdAt + 2000, 2 * DAY),
    dueAttempt('b1', 'b', createdAt + 3000, 2 * DAY),
    dueAttempt('b2', 'b', createdAt + 4000, 10 * 60000, { grade: 1, correct: false }),
    dueAttempt('c1', 'c', createdAt + 5000, DAY),
    dueAttempt('other', 'not-in-goal', createdAt + 6000, 9 * DAY),
  ];
  assert.equal(computeSessionProgress(session, attempts).nextDayDueCount, 2, 'a and c; b came back in ten minutes, d was before this session');
});
