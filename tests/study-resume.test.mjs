import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeStudySession, studySessionReadout } from '../lib/study-resume.js';

test('resumeStudySession restores session state without any private chat dependency (UC-09)', () => {
  const session = {
    id: 's-resume-1',
    courseId: 'CS101',
    status: 'paused',
    scope: [{ kind: 'source', id: 'src-1', revision: 1 }],
    focus: { kind: 'card', id: 'c1', runId: 'r1' },
    goal: { checkItems: [{ id: 'item-1', title: 'Trees', targetCardIds: ['c1'] }] },
    returnPath: [{ kind: 'card', cardId: 'c0', runId: 'r0' }],
  };

  const runs = [
    {
      id: 'r1',
      index: 0,
      entries: [
        {
          card: { id: 'c1', prompt: 'Tree height' },
          draft: { text: 'Draft response' },
          assistance: { hintUsed: true },
        },
      ],
    },
  ];

  const viewState = {
    studySessions: [session],
    sources: [{ id: 'src-1', revision: 1 }],
    decks: [{ id: 'd1', cards: [{ id: 'c1' }, { id: 'c0' }] }],
    runs,
    attempts: [],
  };

  const resumed = resumeStudySession(viewState, { sessionId: 's-resume-1' });

  assert.equal(resumed.found, true);
  assert.equal(resumed.session.id, 's-resume-1');
  assert.equal(resumed.currentCard.id, 'c1');
  assert.equal(resumed.draft.text, 'Draft response');
  assert.equal(resumed.returnPath.length, 1);
  assert.equal(resumed.staleWarnings.length, 0);
  assert.equal(resumed.progress.totalCount, 1);
});

test('resumeStudySession flags source revisions and removed cards as staleWarnings', () => {
  const session = {
    id: 's-stale',
    courseId: 'CS101',
    scope: [{ kind: 'source', id: 'src-revised', revision: 1 }],
    focus: { kind: 'card', id: 'c-removed', runId: 'r1' },
    returnPath: [{ kind: 'card', cardId: 'c-also-removed' }],
  };

  const viewState = {
    studySessions: [session],
    sources: [{ id: 'src-revised', revision: 2 }], // Revised from 1 -> 2
    decks: [{ id: 'd1', cards: [] }],              // Both cards removed
    runs: [],
    attempts: [],
  };

  const resumed = resumeStudySession(viewState, { sessionId: 's-stale' });

  assert.equal(resumed.found, true);
  assert.equal(resumed.staleWarnings.length, 3);

  const kinds = resumed.staleWarnings.map((w) => w.kind);
  assert.ok(kinds.includes('source_revised'));
  assert.ok(kinds.includes('card_removed'));
});

test('temporary Q&A or reading retains zero study side effects (UC-11)', () => {
  // A library state where only temporary reads happened
  const viewState = {
    studySessions: [],
    sources: [{ id: 'src-1', text: 'Normal lecture note' }],
    decks: [],
    runs: [],
    attempts: [],
  };

  const resumed = resumeStudySession(viewState);
  assert.equal(resumed.found, false);
  assert.equal(resumed.session, null);
});

test('resumeStudySession flags card modifications when revision or digest changes', () => {
  const session = {
    id: 's-modified',
    courseId: 'CS101',
    focus: { kind: 'card', id: 'c-rev', revision: 1 },
    returnPath: [{ kind: 'card', cardId: 'c-dig', digest: 'dig-v1' }],
    goal: {
      checkItems: [
        {
          id: 'item-1',
          title: 'Tree traversals',
          targetCards: [{ id: 'c-item', revision: 2 }],
        },
      ],
    },
  };

  const viewState = {
    studySessions: [session],
    sources: [],
    decks: [
      {
        id: 'd1',
        cards: [
          { id: 'c-rev', revision: 2 },
          { id: 'c-dig', digest: 'dig-v2' },
          { id: 'c-item', revision: 3 },
        ],
      },
    ],
    runs: [],
    attempts: [],
  };

  const resumed = resumeStudySession(viewState, { sessionId: 's-modified' });

  assert.equal(resumed.found, true);
  assert.equal(resumed.staleWarnings.length, 3);
  assert.ok(resumed.staleWarnings.every((w) => w.kind === 'card_modified'));
  assert.deepEqual(resumed.staleWarnings.map((w) => w.id), ['c-rev', 'c-dig', 'c-item']);
});


/* #543 / #544: the progress, the estimate and the cost are worked out from the session and the library, never from the view. */

test('studySessionReadout works the estimate out of real answers and the cost out of what the session recorded', () => {
  const session = {
    id: 's', courseId: 'CS101', status: 'active', returnPath: [],
    goal: { checkItems: [
      { id: 'i1', title: 'One', targetCardIds: ['c1'] },
      { id: 'i2', title: 'Two', targetCardIds: ['gen1'] },
      { id: 'i3', title: 'Three', targetCardIds: ['c3'] },
    ] },
    activityLog: [{ kind: 'generation_wait', at: 1, durationMs: 180000 }, { kind: 'paused', at: 2, durationMs: 1800000 }],
    usage: [{ kind: 'generation', at: 5, jobId: 'j1', cardId: 'gen1', tokens: 1800, usage: { uncachedInputTokens: 1000, outputTokens: 300, cacheReadTokens: 500, cacheWriteTokens: 0 } }],
  };
  const attempts = [
    { id: 'a1', quiz_id: 'c1', grade: 4, correct: true, timestamp: 1, elapsed_ms: 90000, assistance: { used: false } },
    { id: 'a2', quiz_id: 'gen1', grade: 4, correct: true, timestamp: 2, elapsed_ms: 150000, assistance: { used: false } },
    { id: 'zz', quiz_id: 'elsewhere', grade: 4, correct: true, timestamp: 3, elapsed_ms: 99999999 },
  ];

  const { progress, estimate, cost } = studySessionReadout({ attempts, runs: [] }, session);

  assert.equal(progress.independentPassedCount, 2);
  assert.equal(estimate.status, 'estimated');
  assert.ok(Number.isInteger(estimate.minMinutes) && estimate.minMinutes < estimate.maxMinutes);
  assert.equal(estimate.preliminary, true);
  assert.equal(cost.breakdown.generation.tokens, 1800);
  assert.equal(cost.breakdown.reusedQuestions.count, 1, 'c1 was a question the library already had; gen1 was written for this session');
  assert.equal(cost.breakdown.tutoring.measured, false);
  assert.equal(cost.independentPassedCount, 2);
  assert.deepEqual(cost.costPerIndependentCheckItem, { tokens: 900, includesTutoring: false });
});

test('studySessionReadout says 尚在估计 when nothing has been answered, and counts a generation whose tokens are unknown as unmeasured', () => {
  const session = { id: 's', goal: { checkItems: [{ id: 'i1', title: 'One', targetCardIds: ['c1'] }] }, usage: [{ kind: 'generation', at: 1, jobId: 'j', cardId: 'c9' }] };
  const { estimate, cost } = studySessionReadout({ attempts: [], runs: [] }, session);
  assert.equal(estimate.status, 'estimating');
  assert.equal(cost.breakdown.generation.measured, false);
  assert.equal(cost.breakdown.generation.tokens, null);
  assert.equal(cost.costPerIndependentCheckItem, 'pending_first_pass');
});

test('resumeStudySession carries the same progress, estimate and cost as the readout', () => {
  const session = { id: 's', courseId: 'CS101', goal: { checkItems: [{ id: 'i1', title: 'One', targetCardIds: ['c1'] }] }, usage: [] };
  const viewState = { studySessions: [session], decks: [{ id: 'd', cards: [{ id: 'c1' }] }], attempts: [], runs: [], sources: [] };
  const resumed = resumeStudySession(viewState, { sessionId: 's' });
  assert.deepEqual({ progress: resumed.progress, estimate: resumed.estimate, cost: resumed.cost }, studySessionReadout(viewState, session));
});
