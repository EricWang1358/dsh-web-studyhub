// #1436 Batch 4 Item 10:
// Oral exam resilience & per-question timing:
// 1) Failed or partial assessment preserves concise `assessmentError`, never locks out recovery, and `oral.assess` incrementally evaluates only missing answered entries idempotently
// 2) `oral.assess` is registered in builtins.js + assistant-boundary.js (HB-1)
// 3) Per-question timing never copies total exam duration into every card; forecast/today-pace/trap-projection/exam-coach exclude or distinguish `assessment === 'oral'`
// 4) UI OralExam tightens `allAssessedTopicsClear` (`assessed === answered`), includes unassessed answered items in `needWorkEntries`, and shows non-primary reassess button
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { extractLearnerPace } from '../lib/pace/forecast.js';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { computeTodayPace } from './ui/review/today-pace.js';
`);

async function seedOralService(t, completeFn) {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item10-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir, { ...(completeFn ? { complete: completeFn } : {}) });
  t.after(() => service.dispose());
  await service.store.update((s) => {
    s.courses = [{ id: 'c1', name: '系统设计', active: true }];
    s.decks = [
      {
        id: 'd1',
        title: '分布式系统',
        course: '系统设计',
        cards: [
          { id: 'oral-a', kind: 'open', topic: '一致性', prompt: '解释 Raft 选举流程', answer: '任期递增+多数派投票' },
          { id: 'oral-b', kind: 'open', topic: '缓存', prompt: '如何防止缓存击穿', answer: '互斥锁或逻辑过期' },
        ],
      },
    ];
  });
  return service;
}

test('#1436 Item 10a: assessment failure surfaces reason and idempotent oral.assess incrementally fills missing assessments without duplicates', async (t) => {
  let mode = 'fail';
  const service = await seedOralService(t, async () => {
    if (mode === 'fail') throw new Error('upstream timeout 504');
    if (mode === 'partial') {
      return JSON.stringify({
        results: [{ cardId: 'oral-a', band: 'strong', grade: 4, reason: '讲清了选举机制' }],
      });
    }
    return JSON.stringify({
      results: [{ cardId: 'oral-b', band: 'developing', grade: 3, reason: '漏了逻辑过期方案' }],
    });
  });

  const run = await service.call('oral.start', { count: 2 });
  await service.call('oral.answer', { runId: run.id, cardId: run.entry.cardId, answer: '回答第一题' });
  await service.call('oral.next', { runId: run.id });
  await service.call('oral.answer', { runId: run.id, cardId: 'oral-b', answer: '回答第二题' });

  // 1) Initial submit hits transient timeout -> saves unassessed with concise assessmentError
  const failedReport = await service.call('oral.submit', { runId: run.id });
  assert.equal(failedReport.feedbackStatus, 'unassessed');
  assert.equal(failedReport.answered, 2);
  assert.equal(failedReport.assessed, 0);
  assert.ok(failedReport.assessmentError, 'failed submit must surface concise assessmentError');

  // 2) Re-assess returns partial (only oral-a assessed)
  mode = 'partial';
  const partialReport = await service.call('oral.assess', { runId: run.id });
  assert.equal(partialReport.assessed, 1);
  assert.equal(partialReport.unassessedAnswered, 1);

  // 3) Second oral.assess incrementally fills ONLY oral-b (idempotent, zero duplicate attempts!)
  mode = 'rest';
  const fullReport = await service.call('oral.assess', { runId: run.id });
  assert.equal(fullReport.assessed, 2);
  assert.equal(fullReport.unassessedAnswered, 0);
  assert.equal(fullReport.assessmentError, '');

  const state = await service.store.read();
  const oralAttempts = state.attempts.filter((a) => a.runId === run.id && a.assessment === 'oral');
  assert.equal(oralAttempts.length, 2, 'incremental oral.assess must write exactly 1 attempt per card');

  // Calling oral.assess again when already fully assessed is a clean no-op
  const noopReport = await service.call('oral.assess', { runId: run.id });
  assert.equal(noopReport.assessed, 2);
  const stateAfter = await service.store.read();
  assert.equal(stateAfter.attempts.filter((a) => a.runId === run.id).length, 2);

  // HB-1 boundary: oral.assess must be refused for assistant calls
  assert.match(assistantRefusal('oral.assess') || '', /HB-1/);
});

test('#1436 Item 10b: oral attempts do not pollute written pacing or 60s slow-correct traps, and UI tightens allAssessedTopicsClear + offers reassess button', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const attempts = [
    { id: 'w1', deckId: 'd1', quiz_id: 'c1', timestamp: '2026-11-24T10:00:00.000Z', grade: 4, elapsed_ms: 20_000 },
    { id: 'o1', deckId: 'd1', quiz_id: 'c2', timestamp: '2026-11-24T10:05:00.000Z', grade: 4, assessment: 'oral', elapsed_ms: 180_000 },
    { id: 'o2', deckId: 'd1', quiz_id: 'c3', timestamp: '2026-11-24T10:06:00.000Z', grade: 4, assessment: 'oral', elapsed_ms: 180_000 },
    { id: 'o3', deckId: 'd1', quiz_id: 'c4', timestamp: '2026-11-24T10:07:00.000Z', grade: 4, assessment: 'oral', elapsed_ms: 180_000 },
  ];

  // Forecast & today-pace must exclude oral elapsed_ms so oral interviews never skew written card median to 180s!
  const pace = extractLearnerPace(attempts, { now });
  assert.ok(pace.medianCardSec < 60, `oral attempts must not skew medianCardSec (got ${pace.medianCardSec})`);

  const today = uiMod.computeTodayPace({ attempts, now });
  assert.equal(today.todaySampleCount, 1, 'today-pace elapsed samples must exclude oral attempts');
  assert.ok(today.medianElapsedMs < 60_000, `oral attempts must not skew today medianElapsedMs (got ${today.medianElapsedMs})`);

  // OralExam.jsx UI contracts
  const oralUiSrc = readFileSync(new URL('../ui/OralExam.jsx', import.meta.url), 'utf8');
  assert.match(oralUiSrc, /report\.assessed\s*===\s*report\.answered/, 'allAssessedTopicsClear must require assessed === answered');
  assert.match(oralUiSrc, /oral\.assess/, 'OralExam UI must wire incremental oral.assess button');
});
