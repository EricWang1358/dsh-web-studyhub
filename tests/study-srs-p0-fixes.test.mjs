import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { boardAction } from '../lib/board.js';
import { commitRubricGrade } from '../lib/rubric-grading.js';
import { isActiveAttempt, isMasteryAttempt, latestOutcomes, latestVerifiedOutcomes } from '../lib/mastery.js';
import { recommendSimilar } from '../lib/recommend.js';
import { examExpired } from '../lib/exam-timing.js';
import { crunchPlan } from '../lib/crunch-plan.js';
import { createWriteQueue } from '../ui/async.js';
import { createExamRun } from '../ui/exam/exam-run.js';
import { loadUi } from './helpers/ui-module.mjs';

const caseUi = await loadUi(`
  export { caseSubmitResponses, flushCaseBeforeSubmit } from './ui/CaseWorkspace.jsx';
`);

async function makeTempStudy(t, prefix = 'study-srs-p0-') {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = join(home, 'library');
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose?.();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, service };
}

test('P0-1: incomplete hands-on task static check keeps grade <= 2 for FSRS-6, mastery and wrongbook', async (t) => {
  const { service } = await makeTempStudy(t);
  await service.store.update((s) => {
    s.decks.push({
      id: 'd-task',
      title: 'Hands-on Lab',
      course: 'Systems',
      cards: [
        {
          id: 't1',
          kind: 'task',
          topic: 'Atomicity',
          prompt: 'Implement atomic decrement in Lua',
          answer: 'Use a single EVAL script checking cur >= qty before DECRBY.',
          marks: 4,
          rubricCriteria: [
            { id: 'c1', label: 'Atomic script', marks: 2, descriptor: 'Single Lua script' },
            { id: 'c2', label: 'Underflow guard', marks: 2, descriptor: 'Reject qty > stock' },
          ],
        },
        {
          id: 't2',
          kind: 'task',
          topic: 'Atomicity',
          prompt: 'Implement idempotent transfer',
          answer: 'Check key, lock rows, commit atomically.',
          marks: 6,
          rubricCriteria: [
            { id: 'c1', label: 'Idempotency key', marks: 2 },
            { id: 'c2', label: 'Row locking', marks: 2 },
            { id: 'c3', label: 'Negative guard', marks: 2 },
          ],
        },
      ],
    });
  });

  // Case A: 1 satisfied (2/2) + 1 issue (1/2) => 3/4 = 0.75 (raw smGradeFor would be 4, MUST stay capped at 2).
  const run1 = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-task', cardId: 't1' }], fresh: true });
  const graded1 = await service.call('card.grade', {
    deckId: 'd-task',
    cardId: 't1',
    runId: run1.id,
    files: ['stock.lua'],
    summary: 'Atomic script works, but underflow guard still has a bug.',
    checks: [
      { id: 'c1', status: 'satisfied', detail: 'Uses single EVAL script.' },
      { id: 'c2', status: 'issue', line: 14, detail: 'Allows stock to go negative when qty == stock + 1.' },
    ],
  });
  assert.equal(graded1.grade, 2, '1 satisfied + 1 issue (75% marks) must still be capped at grade <= 2');
  const view1 = await service.call('review.get', { runId: run1.id });
  assert.equal(view1.feedback.grade, 2);
  assert.equal(view1.feedback.correct, false);
  assert.equal(view1.feedback.level, 'weak');

  const state1 = await service.store.read();
  const card1 = state1.decks[0].cards.find((c) => c.id === 't1');
  const att1 = state1.attempts.findLast((a) => a.quiz_id === 't1');
  assert.equal(att1.grade, 2);
  assert.equal(att1.correct, false);
  assert.equal(card1.review.repetitions, 0, 'failed task must not accumulate passing repetitions in FSRS-6');

  const wb = await service.call('wrongbook');
  assert.ok((wb.items || []).some((item) => item.cardId === 't1'), 'failed hands-on task must enter wrongbook');

  // Case B: 2 satisfied + 1 missing => 4/6 = 0.667 (raw smGradeFor would be 3, MUST stay capped at 2).
  const run2 = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-task', cardId: 't2' }], fresh: true });
  const graded2 = await service.call('card.grade', {
    deckId: 'd-task',
    cardId: 't2',
    runId: run2.id,
    checks: [
      { id: 'c1', status: 'satisfied' },
      { id: 'c2', status: 'satisfied' },
      { id: 'c3', status: 'missing', detail: 'Missing negative amount check.' },
    ],
  });
  assert.equal(graded2.grade, 2);
  const state2 = await service.store.read();
  const att2 = state2.attempts.findLast((a) => a.quiz_id === 't2');
  assert.equal(att2.grade, 2);
  assert.equal(att2.correct, false);

  // Case C: defensive direct commitRubricGrade without precomputed grading.grade still enforces <= 2 when taskCheck is incomplete.
  const syntheticState = {
    decks: [{ id: 'd', title: 'Lab', cards: [{ id: 't3', kind: 'task', topic: 'T', prompt: 'P', answer: 'A', marks: 4, rubricCriteria: [{ id: 'c1', label: 'A', marks: 2 }, { id: 'c2', label: 'B', marks: 2 }] }] }],
    runs: [],
    attempts: [],
    inbox: [],
    sources: [],
    courses: [],
    settings: {},
  };
  const direct = commitRubricGrade(syntheticState, {
    ref: { deckId: 'd', cardId: 't3' },
    answer: 'work',
    grading: {
      questions: [{ cardId: 't3', total: 3, max: 4, ratio: 0.75, band: 'strong', unanswered: false, criteria: [], unanchored: [], assumptions: [], summary: '' }],
      taskCheck: { mode: 'static', files: [], checks: [], issues: [{ criterionId: 'c2', label: 'B', detail: 'Bug' }], counts: { satisfied: 1, missing: 0, issue: 1 }, summary: '' },
    },
  });
  assert.equal(direct.grade, 2);
  assert.equal(syntheticState.attempts[0].grade, 2);
  assert.equal(syntheticState.attempts[0].correct, false);

  // Case D: all criteria satisfied passes cleanly with grade >= 3 and increments repetitions.
  const passed = await service.call('card.grade', {
    deckId: 'd-task',
    cardId: 't1',
    runId: run1.id,
    checks: [
      { id: 'c1', status: 'satisfied' },
      { id: 'c2', status: 'satisfied' },
    ],
  });
  assert.ok(passed.grade >= 3);
  const card1After = (await service.store.read()).decks[0].cards.find((c) => c.id === 't1');
  assert.equal(card1After.review.repetitions, 1);
});

test('P0-1b: on-screen low rubric grade queues tail retry and review.grade.adjust syncs retry queue in both directions', async (t) => {
  const { service } = await makeTempStudy(t);
  await service.store.update((s) => {
    s.decks.push({
      id: 'd-open',
      title: 'Distributed',
      course: 'Systems',
      cards: [
        {
          id: 'o1',
          kind: 'open',
          topic: 'Retries',
          prompt: 'Why use an idempotency key?',
          answer: 'To prevent duplicate side effects when retrying timed-out writes.',
          marks: 4,
          rubricCriteria: [{ id: 'c1', label: 'Mechanism', marks: 4 }],
        },
        {
          id: 'o2',
          kind: 'open',
          topic: 'Retries',
          prompt: 'Why jitter backoff?',
          answer: 'To avoid synchronized retry storms.',
          marks: 4,
          rubricCriteria: [{ id: 'c1', label: 'Mechanism', marks: 4 }],
        },
      ],
    });
  });

  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-open' }], fresh: true });
  assert.equal(run.card.id, 'o1');

  // 1. On-screen miss (grade 0) immediately queues a tail retry without correctionPending gate.
  await service.store.update((s) => {
    commitRubricGrade(s, {
      ref: { deckId: 'd-open', cardId: 'o1' },
      runId: run.id,
      answer: 'no idea',
      grading: {
        questions: [{ cardId: 'o1', total: 0, max: 4, ratio: 0, band: 'weak', unanswered: false, criteria: [{ id: 'c1', label: 'Mechanism', score: 0, max: 4, ratio: 0, evidence: [], missing: [], suggestion: '' }], unanchored: [], assumptions: [], summary: 'Missed.' }],
        total: 0,
        max: 4,
        ratio: 0,
        grade: 0,
      },
    });
  });
  let storedRun = (await service.store.read()).runs.find((r) => r.id === run.id);
  assert.equal(storedRun.entries[0].feedback.correctionPending, undefined);
  assert.equal(storedRun.entries[0].feedback.retryQueued, true);
  assert.equal(storedRun.entries.filter((e) => e.retry && e.card.id === 'o1').length, 1, 'on-screen low rubric grade queues tail retry');

  // 2. Adjusting AI grade UP from 0 -> 4 removes the stale unanswered tail retry.
  const versionBefore = storedRun.queueVersion || 0;
  await service.call('review.grade.adjust', { runId: run.id, entryIndex: 0, cardId: 'o1', grade: 4 });
  storedRun = (await service.store.read()).runs.find((r) => r.id === run.id);
  assert.equal(storedRun.entries.filter((e) => e.retry && e.card.id === 'o1').length, 0, 'raising grade removes stale tail retry');
  assert.equal(storedRun.entries[0].feedback.retryQueued, undefined);
  assert.ok((storedRun.queueVersion || 0) > versionBefore, 'removing tail retry bumps queueVersion');

  // 3. Adjusting AI grade DOWN from 4 -> 1 queues a tail retry again.
  await service.call('review.grade.adjust', { runId: run.id, entryIndex: 0, cardId: 'o1', grade: 1 });
  storedRun = (await service.store.read()).runs.find((r) => r.id === run.id);
  assert.equal(storedRun.entries.filter((e) => e.retry && e.card.id === 'o1').length, 1, 'lowering grade to <= 1 queues tail retry');
  assert.equal(storedRun.entries[0].feedback.retryQueued, true);
});

test('P0-2: expired case paper submits atomically with final responses and client flush never deadlocks on expired review.answer', async (t) => {
  const { service } = await makeTempStudy(t);
  await service.store.update((s) => {
    s.sources.push({ id: 'src-case', title: 'Orchard Case', text: 'Paragraph one about warehouse sensors.\n\nParagraph two about overnight power outage.' });
    s.decks.push({
      id: 'case-1',
      title: 'Orchard Paper',
      course: 'Cloud',
      format: 'case-study',
      case: { sourceId: 'src-case', title: 'Orchard Paper', language: 'en', cues: [] },
      cards: [
        { id: 'q1', kind: 'open', topic: 'Architecture', prompt: 'Recommend an architecture.', answer: 'Event-driven.', marks: 6, rubricCriteria: [{ id: 'c1', label: 'Choice', marks: 6 }] },
        { id: 'q2', kind: 'open', topic: 'Storage', prompt: 'Choose storage.', answer: 'Time-series DB.', marks: 4, rubricCriteria: [{ id: 'c1', label: 'Store', marks: 4 }] },
      ],
    });
  });

  const run = await service.call('review.start', {
    mode: 'exam',
    examKinds: 'case',
    scope: [{ deckId: 'case-1' }],
    fresh: true,
    paper: { minutesPerMark: 1, readingMinutes: 1, handwriting: false },
  });

  // Push startedAt 2 hours into the past so server examExpired(run) is definitively true.
  await service.store.update((s) => {
    const stored = s.runs.find((r) => r.id === run.id);
    stored.startedAt = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    assert.equal(examExpired(stored), true);
  });

  // Server still enforces examExpired on standalone review.answer.
  await assert.rejects(
    service.call('review.answer', { runId: run.id, cardId: 'q1', response: 'Too late draft' }),
    /考试时间已到/,
  );

  // Client submit path: an already-queued review.answer rejected with examExpired MUST NOT block exam.submit.
  const writes = createWriteQueue();
  writes.enqueue(() => service.call('review.answer', { runId: run.id, cardId: 'q1', response: 'Stale draft' })).catch(() => {});
  const pendingTimer = setTimeout(() => { throw new Error('autosave timer should have been cleared before submit'); }, 60_000);
  const saveTimers = { q1: pendingTimer };

  const finalAnswers = { q1: 'Use event-driven alerts for warehouse power outages.', q2: '   ' };
  const paperCards = [{ id: 'q1' }, { id: 'q2' }];
  const finalResponses = caseUi.caseSubmitResponses(paperCards, finalAnswers);

  const controller = createExamRun(() => ({
    kind: 'case',
    call: (action, args) => service.call(action, args),
    retryMs: 5000,
  }));
  controller.enter(run);

  const submitted = await controller.submit({
    before: () => caseUi.flushCaseBeforeSubmit({ saveTimers, writes }),
    args: () => ({ timings: { readingMs: 60000, writingMs: 600000, perQuestion: { q1: 600000 } }, responses: finalResponses }),
  });
  assert.equal(submitted, true, 'expired case paper submission must succeed without deadlock');
  assert.equal(Object.keys(saveTimers).length, 0, 'pending autosave timers cleared');

  const { phase, report } = controller.getState();
  assert.equal(phase, 'report');
  assert.equal(report.case.pending, 1);
  assert.equal(report.case.questions[0].status, 'pending');
  assert.equal(report.case.questions[0].response, finalAnswers.q1);
  assert.equal(report.case.questions[1].status, 'unanswered');
  assert.equal(report.case.questions[1].response, '');

  // Post-submit grading matches the atomically persisted final response.
  const graded = await service.store.update((s) => commitRubricGrade(s, {
    ref: { deckId: 'case-1', cardId: 'q1' },
    runId: run.id,
    answer: finalAnswers.q1,
    grading: {
      questions: [{ cardId: 'q1', total: 5, max: 6, ratio: 5 / 6, band: 'strong', unanswered: false, criteria: [{ id: 'c1', label: 'Choice', score: 5, max: 6, ratio: 5 / 6, evidence: [], missing: [], suggestion: '' }], unanchored: [], assumptions: [], summary: 'Solid.' }],
      total: 5,
      max: 6,
      ratio: 5 / 6,
      grade: 4,
    },
  }));
  assert.equal(graded.grade, 4);
});

test('P1-3: voidedAt undone attempts are excluded from mastery, recommendSimilar, daily-plan completion and restored runs', async (t) => {
  // Pure predicate & mastery checks
  const activeAtt = { deckId: 'd', quiz_id: 'c1', grade: 1, timestamp: '2026-10-01T10:00:00.000Z' };
  const voidedAtt = { deckId: 'd', quiz_id: 'c1', grade: 4, timestamp: '2026-10-02T10:00:00.000Z', voidedAt: '2026-10-02T10:01:00.000Z' };
  const voidedOnly = { deckId: 'd', quiz_id: 'c2', grade: 1, timestamp: '2026-10-02T10:00:00.000Z', voidedAt: '2026-10-02T10:01:00.000Z' };
  assert.equal(isActiveAttempt(activeAtt), true);
  assert.equal(isActiveAttempt(voidedAtt), false);
  assert.equal(isMasteryAttempt(voidedAtt), false);
  const outcomes = latestOutcomes([activeAtt, voidedAtt, voidedOnly]);
  assert.equal(outcomes('d', 'c1'), 1, 'voided pass must not overwrite active weak outcome');
  assert.equal(outcomes('d', 'c2'), undefined, 'voided-only attempt must leave card unseen');
  const verified = latestVerifiedOutcomes([activeAtt, voidedAtt, voidedOnly]);
  assert.equal(verified('d', 'c1'), 1);
  assert.equal(verified('d', 'c2'), undefined);

  // recommendSimilar must not treat a voided wrong attempt as stillWrong
  const rec = recommendSimilar({
    decks: [{
      id: 'd',
      title: 'D',
      cards: [
        { id: 'c1', kind: 'flashcard', topic: 'TCP', prompt: 'Explain TCP congestion window', answer: 'cwnd' },
        { id: 'c2', kind: 'flashcard', topic: 'TCP', prompt: 'Explain TCP slow start threshold', answer: 'ssthresh' },
      ],
    }],
    sources: [],
    attempts: [activeAtt, voidedOnly],
    courses: [],
  }, { mistakes: [{ deckId: 'd', cardId: 'c1' }] });
  assert.deepEqual(rec.items.map((item) => item.cardId), ['c2'], 'card with only a voided wrong attempt stays recommendable');

  // End-to-end daily plan: answering then undoing must NOT complete the task or resurrect ghost feedback
  const { service } = await makeTempStudy(t);
  await service.store.update((s) => {
    s.decks.push({
      id: 'deck',
      title: 'Probability',
      course: 'Math',
      cards: [
        { id: 'q0', kind: 'flashcard', topic: 'Bayes', prompt: 'What is Bayes rule?', answer: 'P(A|B)=...', options: [], citations: [], requires: [], review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } },
      ],
    });
  });

  const date = '2026-10-05';
  const suggested = await service.call('daily.plan.suggest', { date, minutes: 10 });
  const accepted = await service.call('daily.plan.accept', { date, proposalId: suggested.proposal.id });
  const taskId = accepted.tasks[0].id;
  const started = await service.call('daily.plan.start', { date, taskId });

  await service.call('review.reveal', { runId: started.run.id, cardId: 'q0' });
  await service.call('review.answer', { runId: started.run.id, cardId: 'q0', grade: 4 });
  await service.call('review.undo', { runId: started.run.id });

  const planAfterUndo = await service.call('daily.plan.get', { date });
  assert.deepEqual(planAfterUndo.tasks[0].progress, { done: 0, total: 1 }, 'voided attempt must not count toward daily task progress');
  assert.notEqual(planAfterUndo.tasks[0].status, 'done', 'undone answer must not auto-complete the daily task');
  const board = await boardAction('board.get');
  assert.equal(board.cards[taskId].learningTask.completedAt, undefined);
  assert.equal(board.columns.find((col) => col.done).cardIds.includes(taskId), false);

  // Force reconcileQueue -> restoredEntry by removing the entry from run.entries, then resuming daily.plan.start.
  await service.store.update((s) => {
    const run = s.runs.find((r) => r.id === started.run.id);
    run.entries = [];
  });
  const reopened = await service.call('daily.plan.start', { date, taskId });
  assert.equal(reopened.run.feedback, null, 'restoredEntry must never resurrect feedback from a voided attempt');
  assert.equal(reopened.run.revealed, false);
});

test('P1-4: completed practice tasks write back actualMinutes from active attempts and drive habit median inference', async (t) => {
  const { service } = await makeTempStudy(t);
  await service.store.update((s) => {
    s.decks.push({
      id: 'deck',
      title: 'Algorithms',
      course: 'CS',
      cards: Array.from({ length: 12 }, (_, i) => ({
        id: `q${i}`,
        kind: 'flashcard',
        topic: 'Graphs',
        prompt: `Graph question ${i}`,
        answer: `Answer ${i}`,
        options: [],
        citations: [],
        requires: [],
        review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
      })),
    });
  });

  // Complete 5 weekday practice tasks with distinct active elapsed durations: [15, 20, 25, 30, 35] min -> median = 25 min.
  const schedule = [
    ['2026-10-05', 15],
    ['2026-10-06', 20],
    ['2026-10-07', 25],
    ['2026-10-08', 30],
    ['2026-10-09', 35],
  ];
  for (const [day, mins] of schedule) {
    // Make sure at least 2 cards are due/new each day so a practice block is proposed.
    const suggested = await service.call('daily.plan.suggest', { date: day, minutes: 4 });
    const accepted = await service.call('daily.plan.accept', { date: day, proposalId: suggested.proposal.id });
    const task = accepted.tasks.find((item) => item.kind === 'practice');
    assert.ok(task, `practice task proposed on ${day}`);
    const started = await service.call('daily.plan.start', { date: day, taskId: task.id });
    const total = started.run.total;
    for (let i = 0; i < total; i++) {
      const current = await service.call('review.get', { runId: started.run.id });
      await service.call('review.reveal', { runId: current.id, cardId: current.card.id });
      await service.call('review.answer', { runId: current.id, cardId: current.card.id, grade: 4 });
      if (i < total - 1) await service.call('review.move', { runId: current.id, direction: 1 });
    }
    // Stamp deterministic elapsed_ms on this run's active attempts, plus a voided and implicit attempt that MUST be ignored.
    await service.store.update((s) => {
      const mine = s.attempts.filter((a) => !a.voidedAt && !a.implicit && a.runId === started.run.id);
      const perAttemptMs = Math.round((mins * 60000) / mine.length);
      for (const att of mine) att.elapsed_ms = perAttemptMs;
      s.attempts.push(
        { id: `void-${day}`, runId: started.run.id, deckId: 'deck', quiz_id: 'q0', grade: 4, elapsed_ms: 90 * 60000, voidedAt: '2026-10-05T00:00:00.000Z' },
        { id: `imp-${day}`, runId: started.run.id, deckId: 'deck', quiz_id: 'q0', grade: 3, elapsed_ms: 60 * 60000, implicit: true },
      );
      // Reset reviewed cards to due for the next synthetic day's candidate pool.
      for (const card of s.decks[0].cards) {
        if (card.review?.due_at) card.review.due_at = '2026-10-01T00:00:00.000Z';
      }
    });
    const after = await service.call('daily.plan.get', { date: day });
    const doneTask = after.tasks.find((item) => item.id === task.id);
    assert.equal(doneTask.status, 'done');
    assert.equal(doneTask.actualMinutes, mins, `actualMinutes written back from active elapsed_ms on ${day}`);
  }

  const nextWeek = await service.call('daily.plan.get', { date: '2026-10-12' });
  assert.equal(nextWeek.profile.sampleDays, 5);
  assert.equal(nextWeek.profile.observedWeekdayMinutes, 25);
  assert.equal(nextWeek.profile.source, 'inferred');
  assert.equal(nextWeek.budgetBasis, 'habit');
  assert.equal(nextWeek.budgetMinutes, 25);
});

test('P1-4b: crunchPlan reuses shared plan-split bucketing deterministically', () => {
  const points = Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}`, order: i, tested: 6 - i, weakness: 0.8, questions: 5, size: 1800, pitfalls: 1 }));
  const plan = crunchPlan({ points, papers: 2, examDate: '2026-10-10', today: '2026-10-05', reviewDays: 2 });
  assert.equal(plan.status, 'ok');
  const learnDays = plan.days.filter((day) => day.mode === 'learn');
  assert.equal(learnDays.length, 3);
  assert.deepEqual(learnDays.flatMap((day) => day.points).sort(), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.ok(learnDays.every((day) => day.points.length === 2), 'six equal-cost points split evenly across three learn days');
});
