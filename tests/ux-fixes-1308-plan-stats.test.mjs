import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { boardAction } from '../lib/board.js';
import { studyStats } from '../lib/insights.js';

async function withIsolatedPlan(t, fn) {
  const oldHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'studyhub-1308-home-'));
  const root = mkdtempSync(join(tmpdir(), 'studyhub-1308-lib-'));
  process.env.DSH_HOME = home;
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose().catch(() => {});
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return fn(service, root);
}

test('#1308-1: daily plan excludes example/sample courses, historical revisions, parked-course legacy materials, and deleted unfinished tasks', async t => {
  await withIsolatedPlan(t, async service => {
    const date = '2026-10-08';

    // 1) Empty library yields empty proposal cleanly
    const emptyPlan = await service.call('daily.plan.suggest', { date, local: true });
    assert.deepEqual(emptyPlan.proposal.items, []);
    assert.equal(emptyPlan.proposal.emptyReason, 'nothing-due');

    // 2) Populate sample/example course, historical source revision, parked-course legacy source, archived source, and ONE real active course
    await service.store.update(state => {
      state.sample = { loaded: true, course: '示例课：计算机基础', deckId: 'deck-sample', sourceId: 'src-sample' };
      state.courses = [
        { id: 'c-sample', name: '示例课：计算机基础', sample: true, active: true },
        { id: 'c-parked', name: 'ParkedCourse', active: false },
        { id: 'c-real', name: 'RealCourse', active: true },
      ];
      state.documents = [
        {
          id: 'doc-real',
          title: 'Real Notes',
          currentRevision: 2,
          versions: [
            { revision: 1, sourceIds: ['src-real-v1'] },
            { revision: 2, sourceIds: ['src-real-v2'] },
          ],
        },
      ];
      state.decks = [
        {
          id: 'deck-sample',
          title: '示例课题目',
          course: '示例课：计算机基础',
          sample: true,
          cards: [{ id: 'c-sample-1', kind: 'quiz', prompt: 'Sample Q?', answer: 'A' }],
        },
        {
          id: 'deck-example-flag',
          title: 'Example Flagged Deck',
          course: 'RealCourse',
          example: true,
          cards: [{ id: 'c-ex-1', kind: 'quiz', prompt: 'Example Q?', answer: 'A' }],
        },
        {
          id: 'deck-real',
          title: 'Real Course Deck',
          course: 'RealCourse',
          cards: [{ id: 'c-real-1', kind: 'quiz', prompt: 'Real Q?', answer: 'A' }],
        },
      ];
      state.sources = [
        { id: 'src-sample', title: 'Sample Reading', text: 'Sample intro text', courses: ['示例课：计算机基础'], sample: true },
        { id: 'src-parked-legacy', title: 'Parked Legacy Note', text: 'Legacy parked course note', course: 'ParkedCourse' },
        { id: 'src-archived', title: 'Archived Note', text: 'Archived text', courses: ['RealCourse'], archived: true },
        { id: 'src-real-v1', title: 'Real Notes v1', text: 'Obsolete v1 content', courses: ['RealCourse'] },
        { id: 'src-real-v2', title: 'Real Notes v2', text: 'Current v2 content', courses: ['RealCourse'] },
      ];
    });

    const suggested = await service.call('daily.plan.suggest', { date, minutes: 60, local: true });
    const items = suggested.proposal.items;
    const studyIds = items.map(item => item.studyRef?.id);
    assert.ok(studyIds.includes('deck-real'), 'real active deck is proposed');
    assert.ok(studyIds.includes('src-real-v2'), 'current revision of real active source is proposed');
    assert.ok(!studyIds.includes('deck-sample'), 'sample deck must not enter daily plan');
    assert.ok(!studyIds.includes('deck-example-flag'), 'example deck must not enter daily plan');
    assert.ok(!studyIds.includes('src-sample'), 'sample source must not enter daily plan');
    assert.ok(!studyIds.includes('src-parked-legacy'), 'parked-course legacy source must not enter daily plan');
    assert.ok(!studyIds.includes('src-archived'), 'archived source must not enter daily plan');
    assert.ok(!studyIds.includes('src-real-v1'), 'historical source revision must not enter daily plan');

    // 3) Accept plan, then delete an unfinished task from the board -> must not linger as dead task in plan.taskIds or dto.tasks
    const accepted = await service.call('daily.plan.accept', { date, proposalId: suggested.proposal.id });
    assert.ok(accepted.tasks.length >= 1);
    const removedTaskId = accepted.tasks[0].id;
    const boardBefore = await boardAction('board.get');
    await boardAction('board.card.remove', { revision: boardBefore.revision, id: removedTaskId });

    const afterDelete = await service.call('daily.plan.get', { date });
    assert.ok(!afterDelete.tasks.some(task => task.id === removedTaskId), 'deleted unfinished task must not appear in daily plan tasks');
    const boardAfter = await boardAction('board.get');
    const planEntries = Object.values(boardAfter.dailyPlanner?.plans || {});
    assert.ok(planEntries.length >= 1 && planEntries.every(plan => !(plan.taskIds || []).includes(removedTaskId)), 'deleted unfinished taskId is pruned from dailyPlanner.plans[*].taskIds');
  });
});

test('#1308-2: studyStats counts rubric, task-static, and voice/coach-sync attempts while preserving empty, oral, and self-report boundaries', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  const tsToday = '2026-10-08T09:00:00.000Z';
  const tsYesterday = '2026-10-07T09:00:00.000Z';

  // 1) Empty attempts
  const emptyState = { courses: [{ id: 'c1', name: 'CS' }], decks: [], runs: [], attempts: [], sources: [] };
  const emptyStats = studyStats(emptyState, {}, now);
  assert.equal(emptyStats.totals.attempts, 0);
  assert.equal(emptyStats.totals.correctRate, null);
  assert.equal(emptyStats.totals.recentRate, null);
  assert.equal(emptyStats.totals.gradedAttempts, 0);

  // 2) Mixed sources: rubric (case/open), task-static, coach-sync (voice guided), standard graded, oral, self-report
  const state = {
    courses: [{ id: 'c1', name: 'CS', active: true }],
    decks: [
      {
        id: 'd1',
        title: 'CS Mixed',
        course: 'CS',
        cards: [
          { id: 'c-quiz', kind: 'quiz', topic: 'Net', prompt: 'TCP?', answer: 'Yes' },
          { id: 'c-open', kind: 'open', topic: 'OS', prompt: 'Explain deadlock.', answer: '4 conditions' },
          { id: 'c-case', kind: 'case', topic: 'Arch', prompt: 'Design cache.', answer: 'LRU + TTL' },
          { id: 'c-task', kind: 'task', topic: 'Lab', prompt: 'Write Dockerfile.', answer: 'Multi-stage' },
          { id: 'c-voice', kind: 'open', topic: 'DB', prompt: 'Explain MVCC.', answer: 'Snapshot isolation' },
        ],
      },
    ],
    runs: [],
    sources: [],
    attempts: [
      // Standard graded quiz: pass (grade 5)
      { id: 'a1', deckId: 'd1', quiz_id: 'c-quiz', timestamp: tsYesterday, grade: 5, assessment: 'graded' },
      // AI rubric open question: pass (grade 4)
      { id: 'a2', deckId: 'd1', quiz_id: 'c-open', timestamp: tsYesterday, grade: 4, assessment: 'rubric' },
      // AI rubric case question: fail (grade 1)
      { id: 'a3', deckId: 'd1', quiz_id: 'c-case', timestamp: tsToday, grade: 1, assessment: 'rubric' },
      // Hands-on task static check: pass (grade 4)
      { id: 'a4', deckId: 'd1', quiz_id: 'c-task', timestamp: tsToday, grade: 4, assessment: 'task-static', taskCheck: { mode: 'static' } },
      // Voice guided handoff (coach-sync): pass (grade 5)
      { id: 'a5', deckId: 'd1', quiz_id: 'c-voice', timestamp: tsToday, grade: 5, assessment: 'coach-sync', via: 'coach-sync' },
      // Oral exam attempt: tracked in oralAttempts only, NOT graded or mastery
      { id: 'a6', deckId: 'd1', quiz_id: 'c-open', timestamp: tsToday, grade: 5, assessment: 'oral' },
      // Unverified self-report: MUST NOT inflate graded/verified pass rate
      { id: 'a7', deckId: 'd1', quiz_id: 'c-task', timestamp: tsToday, grade: 5, assessment: 'self-report', selfReported: true },
    ],
  };

  const stats = studyStats(state, {}, now);

  // 5 graded-family attempts: a1(5), a2(4), a3(1), a4(4), a5(5) -> 4/5 passed = 80%
  assert.equal(stats.totals.gradedAttempts, 5, 'rubric, task-static, and coach-sync count in gradedAttempts');
  assert.equal(stats.totals.recentAttempts, 5);
  assert.equal(stats.totals.gradedRate, 80);
  assert.equal(stats.totals.recentRate, 80);
  assert.equal(stats.totals.correctRate, 80);
  assert.equal(stats.totals.oralAttempts, 1, 'oral remains tracked separately');

  // Daily trend includes rubric, task-static, and coach-sync in gradedCount & gradedAvg
  const byDate = Object.fromEntries(stats.trend.map(row => [row.date, row]));
  const yDay = byDate['2026-10-07'];
  const tDay = byDate['2026-10-08'];
  assert.equal(yDay.gradedCount, 2, 'yesterday includes graded + rubric');
  assert.equal(yDay.gradedAvg, 4.5);
  assert.equal(tDay.gradedCount, 3, 'today includes rubric + task-static + coach-sync');
  assert.equal(tDay.gradedAvg, 3.3);
  assert.equal(tDay.oralCount, 1);

  // Mastery breakdown includes open, case, task kinds (and excludes oral & self-report)
  const kinds = Object.fromEntries(stats.mastery.kinds.map(k => [k.id, k]));
  assert.equal(kinds.open.n, 2, 'open counts rubric + coach-sync, excludes oral');
  assert.equal(kinds.case.n, 1, 'case counts rubric');
  assert.equal(kinds.task.n, 1, 'task counts task-static, excludes self-report');
});
