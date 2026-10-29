import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRemainingTime,
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

test('filterEffectiveStudyActivity excludes generation wait and paused idle time', () => {
  const log = [
    { kind: 'question_answering', durationMs: 120000 }, // 2 min active
    { kind: 'generation_wait', durationMs: 180000 },    // 3 min waiting for model
    { kind: 'paused', durationMs: 1800000 },             // 30 min coffee break
    { kind: 'reading', durationMs: 60000 },              // 1 min reading
  ];

  const filtered = filterEffectiveStudyActivity(log);

  assert.equal(filtered.activeStudyMs, 120000);
  assert.equal(filtered.generationWaitMs, 180000);
  assert.equal(filtered.pausedMs, 1800000);
  assert.equal(filtered.readingMs, 60000);
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
