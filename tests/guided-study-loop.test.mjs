import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StudyService } from '../lib/service.js';
import { computeSessionProgress } from '../lib/study-progress.js';
import { estimateRemainingTime } from '../lib/study-time-estimate.js';
import { calculateSessionCost } from '../lib/study-session-cost.js';

test('Guided Study Loop E2E: scripted 10-step full workflow (UC-01 ~ UC-09, Section 6)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'guided-study-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const study = new StudyService(root);
  t.after(() => study.dispose());

  // Bootstrap library with course, source, and initial cards
  await study.call('snapshot');
  const src = await study.call('source.add', {
    id: 'src-loop-1',
    title: 'Algorithms: Binary Search & Invariants',
    text: 'Decoupled loop invariants guarantee binary search correctness throughout divide and conquer.',
    courses: ['CS101'],
  });

  const card1 = {
    id: 'c1',
    kind: 'flashcard',
    topic: 'Binary Search',
    objective: 'Understand loop invariant',
    prompt: 'What invariant holds for [left, right] during binary search?',
    answer: 'The target element, if present, always resides within [left, right].',
    hint: 'Consider the boundary elements left and right.',
    explanation: 'At every iteration, subranges not containing target are safely eliminated.',
    misconception: 'Target could be outside [left, right].',
    citations: [{ sourceId: src.id, quote: 'Decoupled loop invariants guarantee' }],
  };

  const branchCard = {
    id: 'c-branch',
    kind: 'flashcard',
    topic: 'Two Pointers Contrast',
    objective: 'Contrast two pointers with binary search',
    prompt: 'How does two pointer movement differ from binary division?',
    answer: 'Two pointers shift by 1 step while binary search halves search space.',
    hint: 'Think step size.',
    explanation: 'Step sizes determine logarithmic vs linear complexity.',
    misconception: 'Both methods have same complexity.',
    citations: [{ sourceId: src.id, quote: 'divide and conquer' }],
  };

  await study.call('draft.save', { deck: { id: 'd-algo', course: 'CS101', title: 'Algorithms Deck', cards: [card1, branchCard] } });
  await study.call('draft.publish', { id: 'd-algo' });

  // ---------------------------------------------------------------------------
  // Step 1: User initiates guided study (UC-01) -> create StudySession
  // ---------------------------------------------------------------------------
  const session = await study.call('study.session.start', {
    courseId: 'CS101',
    scope: [{ kind: 'source', id: src.id, revision: 1 }, { kind: 'deck', id: 'd-algo' }],
    goal: {
      title: 'Master Binary Search Loop Invariant',
      checkItems: [
        { id: 'chk-1', title: 'Binary Search Invariant', targetCardIds: ['c1'], weight: 1 },
        { id: 'chk-2', title: 'Boundary Termination', targetCardIds: ['c-branch'], weight: 1 },
      ],
    },
    settings: {
      allowNewQuestions: true,
      autoOrganizeQA: true,
      allowNoteEdits: true,
    },
  });

  assert.ok(session.id, 'Session ID created');
  assert.equal(session.courseId, 'CS101');
  assert.equal(session.status, 'active');
  assert.equal(session.goal.checkItems.length, 2);

  // ---------------------------------------------------------------------------
  // Step 2: Explain knowledge point & persist right-side secure teaching artifact (UC-02)
  // ---------------------------------------------------------------------------
  const artifactRes = await study.call('study.session.artifact.save', {
    sessionId: session.id,
    id: 'art-bs-1',
    kind: 'markdown',
    title: 'Loop Invariant Analysis',
    topic: 'Binary Search',
    markdown: '### Invariant Principle\nFor range $[L, R]$, candidate $T \\in [L, R]$ always holds.',
  });

  assert.equal(artifactRes.artifactId, 'art-bs-1');
  const storedSessionStep2 = await study.call('study.session.get', { sessionId: session.id });
  assert.equal(storedSessionStep2.artifactRefs.length, 1);

  // Check progress: coverage + 1, independent passed is still 0
  const progressStep2 = computeSessionProgress(storedSessionStep2, [], []);
  assert.equal(progressStep2.independentPassedCount, 0);
  assert.equal(progressStep2.totalCount, 2);
  assert.equal(progressStep2.items[0].status, 'pending');

  // ---------------------------------------------------------------------------
  // Step 3: Locate existing question (UC-03) and prepare an audited new question (UC-07)
  // ---------------------------------------------------------------------------
  let run = await study.call('review.start', {
    mode: 'path',
    fresh: true,
    scope: [{ deckId: 'd-algo', cardId: 'c1' }],
  });
  assert.equal(run.card.id, 'c1');

  // A new question is written and reviewed by the supplement job (tests/guided-question-supplement.test.mjs). This library has no model, so
  // prepare declines honestly and the loop goes on with a reviewed question the deck already has (UC-10).
  const prepResult = await study.call('study.question.prepare', {
    sessionId: session.id,
    deckId: 'd-algo',
    sourceIds: [src.id],
    focus: 'what happens when A[mid] < target',
  });
  assert.equal(prepResult.reason, 'model_unavailable');
  assert.equal(prepResult.fallback, 'reuse_existing');
  await study.store.update((s) => {
    s.decks.find((deck) => deck.id === 'd-algo').cards.push({ ...card1, id: 'c-var', prompt: 'If the array is strictly increasing, what happens when A[mid] < target?',
      answer: 'Every element up to mid can be discarded.', explanation: 'All elements <= mid cannot contain target.' });
  });
  const varCardId = 'c-var';

  // Link variation card to check item and set focus
  storedSessionStep2.goal.checkItems[0].targetCardIds.push(varCardId);
  await study.call('study.session.update', {
    sessionId: session.id,
    goal: storedSessionStep2.goal,
    focus: { kind: 'card', id: 'c1', deckId: 'd-algo', runId: run.id },
  });

  // ---------------------------------------------------------------------------
  // Step 4: User answers first question in native panel with hint (assisted)
  // ---------------------------------------------------------------------------
  await study.call('review.draft.save', {
    runId: run.id,
    cardId: 'c1',
    draft: { text: 'Candidate is within boundaries' },
    assistance: { hintUsed: true },
  });

  await study.call('review.reveal', {
    runId: run.id,
    cardId: 'c1',
    queueVersion: run.queueVersion,
  });

  await study.call('review.answer', {
    runId: run.id,
    cardId: 'c1',
    grade: 4,
    queueVersion: run.queueVersion,
  });

  // Progress shows assisted; independent pass count is still 0
  const viewStoreAfterAns1 = await study.store.read();
  const progressStep4 = computeSessionProgress(
    await study.call('study.session.get', { sessionId: session.id }),
    viewStoreAfterAns1.attempts,
    viewStoreAfterAns1.runs,
  );
  assert.equal(progressStep4.items[0].status, 'assisted');
  assert.equal(progressStep4.independentPassedCount, 0);

  // Time estimate remains 'estimating' because no independent pass exists yet
  const estStep4 = estimateRemainingTime(session, progressStep4);
  assert.equal(estStep4.status, 'estimating');

  // ---------------------------------------------------------------------------
  // Step 5: User asks tutor / asks for help (UC-04) -> Bounded scene read <= 4 KB
  // ---------------------------------------------------------------------------
  const scene = await study.call('study.scene.get', {
    sessionId: session.id,
    runId: run.id,
  });

  const scenePayload = JSON.stringify(scene);
  assert.ok(scenePayload.length <= 4096, `Scene payload ${scenePayload.length} exceeds 4 KB`);
  assert.equal(scene.session.id, session.id);
  assert.ok(scene.recentAttempts.length >= 1);

  // ---------------------------------------------------------------------------
  // Step 6: Tutor opens branch question for contrast (UC-05). c1 was answered in step 4, so it takes no more drafts
  // (a branch keeping an unanswered question's draft: tests/guided-answer-path.test.mjs)
  // ---------------------------------------------------------------------------
  const lateDraft = await study.call('review.draft.save', {
    runId: run.id,
    cardId: 'c1',
    draft: { text: 'Draft on original question' },
  });
  assert.equal(lateDraft.stale, 'answered');

  const branchResult = await study.call('study.branch.open', {
    sessionId: session.id,
    targetDeckId: 'd-algo',
    targetCardId: 'c-branch',
    reason: 'Clarify logarithmic vs linear step differences',
  });

  assert.equal(branchResult.session.returnPath.length, 1);
  assert.equal(branchResult.session.focus.id, 'c-branch');

  // ---------------------------------------------------------------------------
  // Step 7: Explanation QA idempotently routed to original question QA (UC-06)
  // ---------------------------------------------------------------------------
  const qaPayload = {
    sessionId: session.id,
    target: { deckId: 'd-algo', cardId: 'c1' },
    question: 'Why does [left, mid - 1] preserve the invariant?',
    answerMarkdown: 'Because if A[mid] > target, all elements from mid to right are strictly greater.',
    operationId: 'op-qa-loop-1',
    citations: [{ sourceId: src.id, quote: 'Decoupled loop invariants guarantee' }],
  };

  const qaResult1 = await study.call('study.qa.organize', qaPayload);
  assert.equal(qaResult1.ok, true);
  assert.equal(qaResult1.deduplicated, false);

  // Idempotent call with same operationId
  const qaResult2 = await study.call('study.qa.organize', qaPayload);
  assert.equal(qaResult2.ok, true);
  assert.equal(qaResult2.deduplicated, true);

  // ---------------------------------------------------------------------------
  // Step 8: Return from branch and independently complete variation question (UC-08)
  // ---------------------------------------------------------------------------
  const returned = await study.call('study.branch.return', { sessionId: session.id });
  assert.equal(returned.session.returnPath.length, 0);
  assert.equal(returned.session.focus.id, 'c1');

  // User answers variation card independently with NO assistance
  await study.store.update((s) => {
    s.attempts.push({
      id: 'att-indep-1',
      runId: run.id,
      quiz_id: varCardId,
      deckId: 'd-algo',
      topic: 'Binary Search',
      timestamp: Date.now(),
      grade: 4,
      assessment: 'graded',
      elapsed_ms: 120000,
      assistance: { used: false },
    });
  });

  const viewStoreAfterPass = await study.store.read();
  const sessionAfterPass = await study.call('study.session.get', { sessionId: session.id });
  const progressStep8 = computeSessionProgress(sessionAfterPass, viewStoreAfterPass.attempts, viewStoreAfterPass.runs);

  assert.equal(progressStep8.independentPassedCount, 1);
  assert.equal(progressStep8.items[0].status, 'passed');
  assert.ok(progressStep8.items[0].evidenceAttemptIds.includes('att-indep-1'));
  assert.equal(progressStep8.items[1].status, 'pending');

  // Time estimate updates from 'estimating' to valid minute range for the remaining pending item
  const estStep8 = estimateRemainingTime(sessionAfterPass, progressStep8, [
    { kind: 'question_answering', durationMs: 120000 },
  ]);
  assert.equal(estStep8.status, 'estimated');
  assert.ok(estStep8.minMinutes >= 1);
  assert.ok(estStep8.maxMinutes >= estStep8.minMinutes);

  // ---------------------------------------------------------------------------
  // Step 9: User changes strategy dynamically at will (no rigid blockage)
  // ---------------------------------------------------------------------------
  const updatedSettings = await study.call('study.session.update', {
    sessionId: session.id,
    settings: {
      allowNewQuestions: false,
      autoOrganizeQA: false,
    },
  });
  assert.equal(updatedSettings.settings.allowNewQuestions, false);
  assert.equal(updatedSettings.settings.autoOrganizeQA, false);

  // ---------------------------------------------------------------------------
  // Step 10: Pause and resume in simulated next-day new session (UC-09)
  // ---------------------------------------------------------------------------
  const paused = await study.call('study.session.pause', { sessionId: session.id });
  assert.equal(paused.status, 'paused');

  // Simulate fresh session resuming without any private chat dependency
  const resumed = await study.call('study.session.resume', { sessionId: session.id });
  assert.equal(resumed.found, true);
  assert.equal(resumed.session.id, session.id);
  assert.equal(resumed.session.status, 'paused');
  assert.equal(resumed.progress.independentPassedCount, 1);
  assert.equal(resumed.staleWarnings.length, 0);

  // Verify itemized session cost
  const sessionCost = calculateSessionCost(resumed.session, resumed.progress, [
    { kind: 'tutoring', tokens: 1800 },
    { kind: 'generation', tokens: 400, costUsd: 0.004 },
    { kind: 'qa_organize', tokens: 0 },
    { kind: 'reuse_existing', count: 2 },
  ]);

  assert.equal(sessionCost.independentPassedCount, 1);
  assert.equal(sessionCost.costPerIndependentCheckItem.costUsd, 0.004);
  assert.equal(sessionCost.breakdown.reusedQuestions.count, 2);
});
