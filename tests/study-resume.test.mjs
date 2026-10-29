import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeStudySession } from '../lib/study-resume.js';

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

