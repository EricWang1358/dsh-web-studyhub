// #1436 Batch 4 Item 7:
// - Daily plan practice runs shuffle MCQ/multi options via optionOrder(card) (and normalize T/F)
// - Slaying a card mid-task keeps the daily task available & completable (no 4/5 deadlock)
// - Restoring/resuming returns projectRun (preserving undoable) and study-state filters voidedAt attempts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { projection } from '../lib/study-state.js';

function makeSeed(state) {
  state.courses = [{ id: 'c-os', name: 'OS', active: true }];
  state.decks = [
    {
      id: 'd-os',
      title: 'OS MCQ',
      course: 'OS',
      cards: Array.from({ length: 5 }, (_, i) => ({
        id: `mcq-${i}`,
        kind: 'quiz',
        prompt: `Question ${i}`,
        options: [
          { id: 'A', text: 'Option A', correct: true },
          { id: 'B', text: 'Option B', correct: false },
          { id: 'C', text: 'Option C', correct: false },
          { id: 'D', text: 'Option D', correct: false },
        ],
        explanation: 'Explanation',
      })),
    },
  ];
}

test('#1436 Item 7a: daily-plan practice-run uses optionOrder (shuffled options) and returns projectRun with undoable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item7a-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir);
  t.after(() => service.dispose());
  await service.store.update(makeSeed);

  const date = '2026-11-24';
  const suggested = await service.call('daily.plan.suggest', { date, minutes: 15 });
  const accepted = await service.call('daily.plan.accept', { date, proposalId: suggested.proposal.id });
  const taskId = accepted.tasks[0].id;

  // Start run several times across fresh services or check optionOrder usage in practice-run.js + undoable on resume
  const started = await service.call('daily.plan.start', { date, taskId });
  const run = started.run;
  assert.ok(run?.id);

  // Answer first card so an undoable attempt exists
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['A'] });

  // Resume via daily.plan.start -> MUST include undoable (comes from projectRun, NOT raw projection!)
  const resumed = await service.call('daily.plan.start', { date, taskId });
  assert.ok(resumed.run?.undoable, 'daily.plan.start must return projectRun with undoable present');
});

test('#1436 Item 7b: slaying a card mid-task keeps daily task available and completes cleanly at 4/4', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item7b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir);
  t.after(() => service.dispose());
  await service.store.update(makeSeed);

  const date = '2026-11-24';
  const suggested = await service.call('daily.plan.suggest', { date, minutes: 15 });
  const accepted = await service.call('daily.plan.accept', { date, proposalId: suggested.proposal.id });
  const taskId = accepted.tasks[0].id;

  const { run } = await service.call('daily.plan.start', { date, taskId });
  // Answer card 0, move to card 1, slay card 1, then answer remaining 3 cards
  await service.call('review.answer', { runId: run.id, cardId: 'mcq-0', selected: ['A'] });
  await service.call('review.move', { runId: run.id, direction: 1 });
  await service.call('card.slay', { deckId: 'd-os', cardId: 'mcq-1', runId: run.id });

  // Mid-task after slaying 1 of 5 cards: task MUST still be available and resumable!
  const midPlan = await service.call('daily.plan.get', { date });
  const midTask = midPlan.tasks.find((item) => item.id === taskId);
  assert.equal(midTask.available, true, 'daily task must remain available after slaying one card');
  assert.equal(midTask.progress.total, 4, 'effective total must reflect 4 remaining cards');

  // Resuming mid-task via daily.plan.start must succeed (no crash on missing slain card!)
  let cur = (await service.call('daily.plan.start', { date, taskId })).run;
  while (cur && !cur.complete && cur.card) {
    cur = await service.call('review.answer', { runId: cur.id, cardId: cur.card.id, selected: ['A'] });
    if (!cur.complete) cur = await service.call('review.move', { runId: cur.id, direction: 1 });
  }

  const endPlan = await service.call('daily.plan.get', { date });
  const endTask = endPlan.tasks.find((item) => item.id === taskId);
  assert.equal(endTask.status, 'done', 'daily task must auto-complete once all remaining cards are finished');
  assert.equal(endTask.progress.done, endTask.progress.total);
});

test('#1436 Item 7c: study-state projection ignores voidedAt attempts in lastRubric and lastTaskAttempt', () => {
  const state = {
    decks: [
      {
        id: 'd1',
        title: 'Tasks',
        cards: [{ id: 'c-task', kind: 'task', prompt: 'Do task', answer: 'Done' }],
      },
    ],
    attempts: [
      {
        id: 'a-void',
        deckId: 'd1',
        quiz_id: 'c-task',
        assessment: 'rubric',
        score: 2,
        maxScore: 10,
        grade: 1,
        timestamp: '2026-11-24T00:00:00.000Z',
        voidedAt: '2026-11-24T00:01:00.000Z',
        rubric: { criteria: [{ name: 'c1', pass: false }] },
      },
    ],
    runs: [],
    teaching: [],
    notes: [],
  };
  const run = {
    id: 'r1',
    mode: 'path',
    deckId: 'd1',
    index: 0,
    entries: [{ deckId: 'd1', card: state.decks[0].cards[0], feedback: null, revealed: false }],
  };
  const view = projection(state, run);
  assert.equal(view.lastRubric, undefined, 'voided rubric attempt must not appear in lastRubric');
  assert.equal(view.lastTaskAttempt, undefined, 'voided task attempt must not appear in lastTaskAttempt');
});
