import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactScene, MAX_SCENE_PROMPT_CHARS } from '../lib/study-scene.js';

test('buildCompactScene produces bounded compact scene under 4KB', () => {
  const longPrompt = 'Long question '.repeat(100);
  const session = {
    id: 'sess-1',
    courseId: 'Math',
    version: 2,
    status: 'active',
    scope: [{ kind: 'source', id: 's1' }],
    goal: { title: 'Limits and Derivatives', checkItems: [{ id: 'item-1', title: 'Limit Definition' }] },
    settings: { allowNewQuestions: true, autoOrganizeQA: true, allowNoteEdits: false },
    focus: { kind: 'card', id: 'c1', runId: 'r1', deckId: 'd1' },
    returnPath: [],
    artifactRefs: [],
  };

  const runs = [
    {
      id: 'r1',
      deckId: 'd1',
      index: 0,
      queueVersion: 1,
      entries: [
        {
          card: {
            id: 'c1',
            prompt: longPrompt,
            kind: 'quiz',
            topic: 'Calculus',
            options: [
              { id: 'o1', text: 'Opt 1', correct: true },
              { id: 'o2', text: 'Opt 2', correct: false },
            ],
            followups: Array.from({ length: 20 }, (_, i) => ({
              id: `qa-${i}`,
              question: `Question ${i}`,
              at: Date.now() - i * 1000,
            })),
          },
          revealed: false,
          draft: { text: 'my draft answer' },
          assistance: { hintUsed: true },
        },
      ],
    },
  ];

  const attempts = Array.from({ length: 50 }, (_, i) => ({
    id: `att-${i}`,
    quiz_id: 'c1',
    timestamp: 1000 + i * 100,
    correct: i % 2 === 0,
    grade: i % 2 === 0 ? 4 : 1,
    assistance: { used: false },
  }));

  const viewState = {
    studySessions: [session],
    runs,
    attempts,
  };

  const scene = buildCompactScene(viewState, { sessionId: 'sess-1' });

  assert.equal(scene.unchanged, false);
  assert.ok(scene.session);
  assert.equal(scene.session.id, 'sess-1');

  // Assert prompt truncation
  assert.equal(scene.focusObject.truncated, true);
  assert.ok(scene.focusObject.prompt.length <= MAX_SCENE_PROMPT_CHARS + 3);

  // Assert options masking when revealed is false
  assert.equal(scene.focusObject.revealed, false);
  for (const opt of scene.focusObject.options) {
    assert.equal(opt.correct, undefined);
  }

  // Assert recent attempts capped at 5
  assert.equal(scene.recentAttempts.length, 5);

  // Assert related QA references capped
  assert.ok(scene.relatedQARefs.length <= 5);

  // Assert serialized JSON size <= 4096 bytes (4 KB)
  const json = JSON.stringify(scene);
  assert.ok(json.length <= 4096, `Scene payload exceeded 4KB: length is ${json.length}`);
});

test('buildCompactScene short-circuits when sinceFingerprint matches', () => {
  const session = {
    id: 'sess-1',
    version: 1,
    status: 'active',
  };
  const viewState = {
    studySessions: [session],
    runs: [],
    attempts: [],
  };

  const first = buildCompactScene(viewState);
  assert.equal(first.unchanged, false);
  assert.ok(first.fingerprint);

  const second = buildCompactScene(viewState, { sinceFingerprint: first.fingerprint });
  assert.equal(second.unchanged, true);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.focusObject, undefined);
});
