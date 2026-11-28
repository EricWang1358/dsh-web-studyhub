import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../lib/store.js';
import { StudyService } from '../lib/service.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { settlePrerequisiteCredit } from '../lib/rubric-grading.js';
import { shortcutAction } from '../ui/review/session-logic.js';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewElement } from './helpers/review-render.mjs';

const uiMods = await loadUi(`
  export { default as Review } from './ui/Review.jsx';
  export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

async function makeTempStudy(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-review-undo-'));
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, service };
}

test('Issue #885 Store ATTEMPT_CHUNK = 1000: mutating, revoking, or voiding attempts in full earlier chunks persists across reload', async (t) => {
  const { root, service } = await makeTempStudy(t);
  const creditedTs = '2026-10-01T00:00:12.000Z';
  const prereqAfter = { reps: 1, interval: 3, ease: 2.5, stability: 3, difficulty: 5, lapses: 0, lastReview: creditedTs, due_at: '2026-10-04T00:00:12.000Z' };
  await service.store.update((state) => {
    state.decks.push({
      id: 'd1',
      title: 'Chunk Persistence',
      course: 'Systems',
      cards: [
        { id: 'prereq', kind: 'flashcard', topic: 'Basics', prompt: 'Prereq?', answer: 'Yes', review: structuredClone(prereqAfter) },
        {
          id: 'main',
          kind: 'open',
          topic: 'Advanced',
          prompt: 'Explain consensus.',
          answer: 'Safety + liveness.',
          requires: [{ deckId: 'd1', cardId: 'prereq' }],
          rubricCriteria: [{ id: 'c1', label: 'Safety', points: 2 }],
        },
        { id: 'f1', kind: 'flashcard', topic: 'Undo', prompt: 'Undo me?', answer: 'Done' },
      ],
    });
    state.runs.push({
      id: 'run-rubric',
      mode: 'path',
      deckId: 'd1',
      index: 0,
      complete: false,
      startedAt: '2026-10-01T00:00:00.000Z',
      entries: [{
        deckId: 'd1',
        cardId: 'main',
        card: { id: 'main', kind: 'open', topic: 'Advanced', prompt: 'Explain consensus.' },
        revealed: true,
        prerequisitesCredited: true,
        creditedAt: creditedTs,
        lastAttemptId: 'att-5',
        feedback: { correct: true, grade: 4, gradedAt: creditedTs, rubric: { total: 2, max: 2 } },
      }],
    });
    // Seed 1,050 attempts so chunk 0 (0..999) is completely full (length === 1000) and chunk 1 (1000..1049) is active.
    for (let i = 0; i < 1050; i++) {
      if (i === 5) {
        state.attempts.push({
          id: 'att-5',
          runId: 'run-rubric',
          entryIndex: 0,
          deckId: 'd1',
          quiz_id: 'main',
          timestamp: creditedTs,
          grade: 4,
          correct: true,
          assessment: 'rubric',
          rubric: { total: 2, max: 2, criteria: [{ id: 'c1', score: 2, max: 2 }] },
        });
      } else if (i === 12) {
        state.attempts.push({
          id: 'att-12-implicit',
          runId: 'run-rubric',
          deckId: 'd1',
          quiz_id: 'prereq',
          timestamp: creditedTs,
          grade: 3,
          correct: true,
          implicit: true,
          via: { deckId: 'd1', cardId: 'main' },
          reviewSnapshot: null,
          after: structuredClone(prereqAfter),
        });
      } else {
        state.attempts.push({
          id: `att-${i}`,
          runId: 'seed-run',
          deckId: 'd1',
          quiz_id: 'f1',
          timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
          grade: 4,
          correct: true,
          assessment: 'graded',
        });
      }
    }
  });

  // 1. Mutate attempt #5 inside full chunk 0 via review.grade.adjust AND revoke implicit attempt #12 via settlePrerequisiteCredit
  //    (removing #12 shifts #1000 into chunk 0 so chunk 0 STILL has length === 1000!).
  await service.call('review.grade.adjust', { runId: 'run-rubric', entryIndex: 0, cardId: 'main', grade: 2 });
  await service.store.update((state) => {
    const run = state.runs.find((r) => r.id === 'run-rubric');
    settlePrerequisiteCredit(state, { run, entry: run.entries[0], deckId: 'd1', cardId: 'main', eligible: false, timestamp: creditedTs });
  });

  // 2. Also mark an early chunk-0 attempt voidedAt via review.undo!
  await service.store.update((state) => {
    state.decks[0].cards[2].review = { reps: 2, interval: 6, ease: 2.5, stability: 6, difficulty: 5, lapses: 0, lastReview: '2026-10-02T00:00:00.000Z', nextDue: '2026-10-08T00:00:00.000Z' };
    const idx20 = state.attempts.findIndex((a) => a.id === 'att-20');
    state.attempts[idx20] = {
      ...state.attempts[idx20],
      id: 'att-20',
      runId: 'run-early-undo',
      deckId: 'd1',
      quiz_id: 'f1',
      entryIndex: 0,
      reviewSnapshot: null,
    };
    state.runs.push({
      id: 'run-early-undo',
      mode: 'path',
      deckId: 'd1',
      index: 0,
      complete: true,
      startedAt: '2026-10-02T00:00:00.000Z',
      entries: [{
        deckId: 'd1',
        cardId: 'f1',
        card: { id: 'f1', kind: 'flashcard', topic: 'Undo', prompt: 'Undo me?', answer: 'Done' },
        revealed: true,
        lastAttemptId: 'att-20',
        feedback: { correct: true, grade: 4 },
      }],
    });
  });
  await service.call('review.undo', { runId: 'run-early-undo' });

  // Reload from disk with a fresh Store instance to prove chunk 0 (still length 1000!) was rewritten, never skipped!
  const reloaded = await new Store(root).read();
  const adjusted = reloaded.attempts.find((a) => a.id === 'att-5');
  assert.equal(adjusted.grade, 2, 'grade adjustment in chunk 0 persisted to disk');
  assert.equal(reloaded.attempts.some((a) => a.id === 'att-12-implicit'), false, 'revoked implicit attempt removed from chunk 0 on disk');
  const voided = reloaded.attempts.find((a) => a.id === 'att-20');
  assert.ok(voided?.voidedAt, 'voidedAt in chunk 0 persisted to disk');
  assert.equal(reloaded.decks[0].cards[2].review, undefined, 'brand-new review snapshot restored to undefined on disk');
});

test('review.undo restores brand-new & reviewed FSRS snapshots, removes tail retry, rolls back implicit prerequisite credit, and hides voided attempts from readers', async (t) => {
  const { service } = await makeTempStudy(t);
  const existingReview = {
    reps: 3,
    interval: 9,
    ease: 2.5,
    stability: 9.4,
    difficulty: 4.8,
    lapses: 0,
    lastReview: '2026-10-01T00:00:00.000Z',
    nextDue: '2026-10-10T00:00:00.000Z',
  };
  await service.store.update((state) => {
    state.decks.push(
      {
        id: 'd-pre',
        title: 'Prerequisite Deck',
        course: 'Distributed',
        cards: [
          { id: 'pre1', kind: 'flashcard', topic: 'Clocks', prompt: 'What is Lamport clock?', answer: 'Logical partial order' },
        ],
      },
      {
        id: 'd1',
        title: 'Undo Suite',
        course: 'Distributed',
        cards: [
          {
            id: 'c1',
            kind: 'flashcard',
            topic: 'Consensus',
            prompt: 'What does Raft guarantee?',
            answer: 'Linearizable log',
            flag: true,
            requires: [{ deckId: 'd-pre', cardId: 'pre1' }],
          },
          {
            id: 'c2',
            kind: 'flashcard',
            topic: 'Leases',
            prompt: 'Why bounded clock drift?',
            answer: 'Prevent split-brain',
            review: structuredClone(existingReview),
          },
        ],
      },
    );
  });

  let run = await service.call('review.start', { mode: 'flashcard', deckId: 'd1', fresh: true });
  assert.equal(run.card.id, 'c1');
  assert.equal(run.undoable ?? null, null);

  // Save a scratchpad draft before answering c1 so undo can restore it too.
  await service.call('review.draft.save', { runId: run.id, cardId: 'c1', draft: { text: 'My scratchpad thought' } });
  await service.call('review.reveal', { runId: run.id, cardId: 'c1' });

  // Grade c1 poorly (grade 1) with advanceOnSelfGrade -> queues a tail retry and STAYS on c1 (low grades < 3 do not auto-skip).
  run = await service.call('review.answer', { runId: run.id, cardId: 'c1', grade: 1, advanceOnSelfGrade: true });
  assert.equal(run.card.id, 'c1', 'low grade (< 3) stays on c1 even with advanceOnSelfGrade');
  assert.equal(run.feedback?.grade, 1);
  assert.equal(run.navigation.length, 3, 'wrong grade queued a tail retry');
  assert.equal(run.navigation[2].retry, true);
  assert.equal(run.undoable?.cardId, 'c1');

  // Undo c1! Should remove the unpractised tail retry, delete brand-new card.review, restore scratchpad draft, and step back to c1.
  run = await service.call('review.undo', { runId: run.id });
  assert.equal(run.card.id, 'c1', 'stepped back to c1');
  assert.equal(run.revealed, true, 'kept back face revealed for immediate re-grading');
  assert.equal(run.feedback, null, 'cleared feedback');
  assert.equal(run.navigation.length, 2, 'removed unpractised tail retry');
  assert.equal(run.draft?.text, 'My scratchpad thought', 'restored pre-answer scratchpad draft');
  assert.equal(run.undoable ?? null, null);

  // Active readers ignore the voided attempt completely, while export retains audit history with voidedAt.
  const snapAfterFirstUndo = await service.call('snapshot');
  assert.equal(snapAfterFirstUndo.progress.d1.counts.new, 2, 'c1 still counted as new (zero active attempts) in snapshot progress');
  assert.equal(snapAfterFirstUndo.progress.d1.counts.weak, 0, 'voided wrong attempt excluded from weak count');
  const wrongAfterFirstUndo = await service.call('wrongbook');
  assert.equal((wrongAfterFirstUndo.items || []).length, 0, 'voided wrong attempt excluded from wrongbook');
  const exported1 = await service.call('export');
  assert.equal(exported1.attempts.length, 1);
  assert.ok(exported1.attempts[0].voidedAt, 'raw export keeps voidedAt audit record');
  assert.equal(exported1.decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'c1').review, undefined, 'brand-new card has no leftover review object');

  // Now re-grade c1 with passing grade 4 -> credits prerequisite pre1 implicitly AND advances to c2!
  run = await service.call('review.answer', { runId: run.id, cardId: 'c1', grade: 4, advanceOnSelfGrade: true });
  assert.equal(run.card.id, 'c2');
  assert.ok((await service.call('export')).decks.find((d) => d.id === 'd-pre').cards[0].review, 'pre1 received implicit FSRS credit');

  // Undo c1 again -> rolls back BOTH c1 and pre1's implicit credit!
  run = await service.call('review.undo', { runId: run.id });
  assert.equal(run.card.id, 'c1');
  const afterPrereqRollback = await service.call('export');
  assert.equal(afterPrereqRollback.decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'c1').review, undefined);
  assert.equal(afterPrereqRollback.decks.find((d) => d.id === 'd-pre').cards[0].review, undefined, 'prerequisite implicit credit rolled back cleanly');
  assert.equal(afterPrereqRollback.attempts.filter((a) => !a.voidedAt).length, 0, 'both main and implicit attempts voided');

  // Re-grade c1 (grade 4) -> c2, then reveal & grade c2 (grade 5) -> round completes!
  run = await service.call('review.answer', { runId: run.id, cardId: 'c1', grade: 4, advanceOnSelfGrade: true });
  assert.equal(run.card.id, 'c2');
  await service.call('review.reveal', { runId: run.id, cardId: 'c2' });
  run = await service.call('review.answer', { runId: run.id, cardId: 'c2', grade: 5, advanceOnSelfGrade: true });
  assert.equal(run.complete, true, 'grading final card completed the round');
  assert.equal(run.undoable?.cardId, 'c2', 'final card remains undoable from round summary');

  // Undo from round-end summary! Restores c2's exact pre-existing FSRS review snapshot and reopens c2.
  run = await service.call('review.undo', { runId: run.id });
  assert.equal(run.complete, false, 'round reopened on final card');
  assert.equal(run.card.id, 'c2');
  assert.equal(run.revealed, true);
  assert.equal(run.feedback, null);
  const c2AfterUndo = (await service.call('export')).decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'c2');
  assert.deepEqual(c2AfterUndo.review, existingReview, 'restored exact pre-answer FSRS snapshot on reviewed card');
});

test('HB-1 assistant boundary strictly forbids review.undo for AI agents', () => {
  const refusal = assistantRefusal('review.undo');
  assert.ok(refusal && /review\.undo/.test(refusal) && /HB-1/.test(refusal), `expected HB-1 refusal mentioning review.undo, got: ${refusal}`);
});

test('Z and Ctrl+Z shortcuts trigger undo outside inputs (including on round summary), and English UI renders zero Han', () => {
  const baseCtx = {
    inside: true,
    modalOpen: false,
    page: 'review',
    busy: false,
    shortcutHelp: false,
    endAsked: false,
    choice: false,
    isCloze: false,
    rubricCard: false,
    selected: [],
    clozeValues: {},
    run: { id: 'r1', mode: 'path', index: 1, complete: false, card: { id: 'c2', kind: 'flashcard' }, undoable: { attemptId: 'a1', cardId: 'c1', entryIndex: 0 } },
  };
  const zPress = shortcutAction({ key: 'z', code: 'KeyZ', repeat: false, defaultPrevented: false, inEditable: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, baseCtx);
  assert.deepEqual(zPress?.action, { type: 'undo' });
  assert.equal(zPress?.cancelAuto, true);

  const ctrlZPress = shortcutAction({ key: 'z', code: 'KeyZ', repeat: false, defaultPrevented: false, inEditable: false, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
    { ...baseCtx, run: { ...baseCtx.run, complete: true, card: null } });
  assert.deepEqual(ctrlZPress?.action, { type: 'undo' }, 'Ctrl+Z works on completed round summary too');

  const inInput = shortcutAction({ key: 'z', code: 'KeyZ', repeat: false, defaultPrevented: false, inEditable: true, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, baseCtx);
  assert.equal(inInput, null, 'Ctrl+Z inside editable textarea/input stays native browser undo');

  const inExam = shortcutAction({ key: 'z', code: 'KeyZ', repeat: false, defaultPrevented: false, inEditable: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
    { ...baseCtx, run: { ...baseCtx.run, mode: 'exam' } });
  assert.equal(inExam?.action, null, 'never undoes during a mock exam');

  uiMods.setUiLanguage('en');
  try {
    const noop = () => {};
    const html = renderToStaticMarkup(reviewElement(uiMods.Review, uiMods.StudyServicesContext, {
      run: {
        id: 'r1',
        mode: 'path',
        index: 1,
        total: 2,
        card: { id: 'c2', kind: 'flashcard', topic: 'Consensus', prompt: 'Question?' },
        revealed: false,
        feedback: null,
        undoable: { attemptId: 'a1', cardId: 'c1', entryIndex: 0 },
      },
      data: { sources: [] },
      host: {},
      choice: false,
      isCloze: false,
      selected: [],
      clozeValues: {},
      shellTitle: 'Daily Practice',
      busy: false,
      undoAnswer: noop,
    }));
    assert.match(html, /Undo last grade \(Z\)/);
    assert.doesNotMatch(html.replace(/<[^>]*>/g, ' '), /[\u3400-\u9fff]/, 'zero leaked Han characters in English undo toolbar');
  } finally {
    uiMods.setUiLanguage('zh');
  }
});
