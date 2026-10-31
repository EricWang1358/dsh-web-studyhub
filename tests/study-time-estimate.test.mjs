import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityFromAttempts,
  estimateRemainingTime,
  MAX_SINGLE_CARD_ACTIVE_MS,
  MIN_PASSES_FOR_PACE,
  filterEffectiveStudyActivity,
  shouldRecordPrediction,
} from '../lib/study-time-estimate.js';

test('estimateRemainingTime returns estimating when zero evidence is available', () => {
  const session = {
    id: 's1',
    returnPath: [],
  };
  const progress = {
    independentPassedCount: 0,
    assistedCount: 0,
    pendingCount: 3,
    needsReviewCount: 0,
    items: [{ id: '1' }, { id: '2' }, { id: '3' }],
  };

  const est = estimateRemainingTime(session, progress, []);

  assert.equal(est.status, 'estimating');
  assert.equal(est.minMinutes, null);
  assert.equal(est.maxMinutes, null);
  assert.match(est.message, /尚在估计，完成首个检验后更新/);
});

test('filterEffectiveStudyActivity counts only the time spent answering', () => {
  assert.deepEqual(filterEffectiveStudyActivity([
    { kind: 'question_answering', durationMs: 120000 },
    { kind: 'question_answering', durationMs: 60000 },
  ]), { activeStudyMs: 180000 });
  assert.deepEqual(filterEffectiveStudyActivity(), { activeStudyMs: 0 });
});

test('estimateRemainingTime calculates reasonable integer intervals based on progress and branch gap', () => {
  const session = {
    id: 's1',
    returnPath: [{ cardId: 'c-branch-1' }], // 1 active branch depth
  };
  const progress = {
    independentPassedCount: 1,
    assistedCount: 1,
    pendingCount: 2,
    needsReviewCount: 0,
  };
  const activityLog = [
    { kind: 'question_answering', durationMs: 150000 }, // 2.5 min active
  ];

  const est = estimateRemainingTime(session, progress, activityLog);

  assert.equal(est.status, 'estimated');
  assert.ok(Number.isInteger(est.minMinutes));
  assert.ok(Number.isInteger(est.maxMinutes));
  assert.ok(est.minMinutes <= est.maxMinutes);
  assert.match(est.display, /^\d+–\d+ 分钟$/);
  assert.match(est.message, /预计达到本次检验目标还需/);
});

test('shouldRecordPrediction records when estimate changes significantly or reason given', () => {
  const prevPrediction = { minMinutes: 8, maxMinutes: 14 };

  // Minor change -> no record
  const minorEstimate = { status: 'estimated', minMinutes: 9, maxMinutes: 15, remainingItems: 2 };
  assert.equal(shouldRecordPrediction(prevPrediction, minorEstimate), null);

  // Significant change -> record
  const majorEstimate = { status: 'estimated', minMinutes: 16, maxMinutes: 24, remainingItems: 4 };
  const record = shouldRecordPrediction(prevPrediction, majorEstimate, '拓展了目标范围');

  assert.ok(record);
  assert.equal(record.minMinutes, 16);
  assert.equal(record.maxMinutes, 24);
  assert.equal(record.reason, '拓展了目标范围');
});

test('activityFromAttempts counts only the answers that back a check item, once each, and caps nothing itself', () => {
  const progress = { items: [{ id: 'i1', evidenceAttemptIds: ['a1', 'a2'] }, { id: 'i2', evidenceAttemptIds: ['a2'] }] };
  const attempts = [
    { id: 'a1', elapsed_ms: 90000 },
    { id: 'a2', elapsed_ms: 30000 },
    { id: 'other-course', elapsed_ms: 999999 },
    { id: 'a3' },
  ];

  const log = activityFromAttempts(progress, attempts);

  assert.deepEqual(log.map((entry) => [entry.kind, entry.durationMs]), [['question_answering', 90000], ['question_answering', 30000]]);
  assert.deepEqual(activityFromAttempts({}, attempts), []);
  assert.deepEqual(activityFromAttempts(progress, undefined), []);
});

test('an idle question is capped, and a long generation wait or pause never speeds up or slows down the pace', () => {
  const session = { id: 's1', returnPath: [] };
  const progress = { independentPassedCount: 2, assistedCount: 0, pendingCount: 2, needsReviewCount: 0 };
  const answering = [{ kind: 'question_answering', durationMs: 60000 }, { kind: 'question_answering', durationMs: 60000 }];
  const plain = estimateRemainingTime(session, progress, answering);
  const noisy = estimateRemainingTime(session, progress, [
    ...answering,
    { kind: 'generation_wait', durationMs: 3 * 60000 },
    { kind: 'paused', durationMs: 30 * 60000 },
  ]);
  assert.deepEqual(noisy, plain);
  assert.equal(filterEffectiveStudyActivity([{ kind: 'question_answering', durationMs: 6 * 3600000 }]).activeStudyMs, MAX_SINGLE_CARD_ACTIVE_MS, 'a question left open for hours counts as the cap');
});

test('an estimate says how firm it is: preliminary until enough independent passes have been seen', () => {
  const session = { id: 's1', returnPath: [] };
  const log = [{ kind: 'question_answering', durationMs: 120000 }];
  const early = estimateRemainingTime(session, { independentPassedCount: 1, assistedCount: 0, pendingCount: 3, needsReviewCount: 0 }, log);
  assert.equal(early.status, 'estimated');
  assert.equal(early.preliminary, true);
  assert.match(early.message, /（初步估计）$/);

  const later = estimateRemainingTime(session, { independentPassedCount: MIN_PASSES_FOR_PACE, assistedCount: 0, pendingCount: 1, needsReviewCount: 0 }, log);
  assert.equal(later.preliminary, false);
  assert.doesNotMatch(later.message, /初步估计/);
  assert.ok(later.maxMinutes > later.minMinutes, 'still a range, never one exact number');
});

test('no check items is not a finished goal: completed needs at least one item', () => {
  const zero = { independentPassedCount: 0, assistedCount: 0, pendingCount: 0, needsReviewCount: 0, totalCount: 0, items: [] };
  const est = estimateRemainingTime({ id: 's1', returnPath: [] }, zero, []);
  assert.equal(est.status, 'no_goal');
  assert.equal(est.minMinutes, null);
  assert.doesNotMatch(est.message, /已完成/);
  const done = estimateRemainingTime({ id: 's1', returnPath: [] }, { independentPassedCount: 2, assistedCount: 0, pendingCount: 0, needsReviewCount: 0, totalCount: 2 }, []);
  assert.equal(done.status, 'completed');
});
