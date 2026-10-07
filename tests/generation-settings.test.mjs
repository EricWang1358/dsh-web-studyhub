import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { normalizeGenerationSettings, normalizeGenerationPerformance, resolveGenerationRequest,
  validateGenerationPatch, validateGenerationPerformance } from '../lib/generation-settings.js';

const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const expected = { concurrency: 4, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 2, ...EFFORTS,
  kind: 'quiz', count: 10, language: 'auto', difficulty: 'mixed', focus: '', notation: 'auto' };
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-generation-settings-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  return service;
}

test('old libraries expose complete generation defaults through settings and snapshot', async t => {
  const service = await library(t);
  const before = await service.call('export');
  await service.call('restore', { state: { ...before, settings: { first_interval_days: 2, initial_ease_factor: 2.5,
    minimum_ease_factor: 1.3, second_interval_days: 6 } } });
  const snapshot = await service.call('snapshot');
  assert.deepEqual(snapshot.settings.generation, expected);
  assert.equal(snapshot.settings.first_interval_days, 2);
  assert.deepEqual((await service.call('export')).settings, snapshot.settings);
});

test('generation settings merge per field and preserve scheduling and sibling preferences', async t => {
  const service = await library(t);
  await service.call('settings', { first_interval_days: 3, generation: { concurrency: 1, language: 'English', focus: '  Explain mechanisms  ' } });
  const saved = await service.call('settings', { generation: { batchSize: 2 } });
  assert.deepEqual(saved.generation, { ...expected, concurrency: 1, language: 'English', focus: 'Explain mechanisms', batchSize: 2 });
  assert.equal(saved.first_interval_days, 3);
  const roundtrip = await service.call('export');
  await service.call('restore', { state: roundtrip });
  assert.deepEqual((await service.call('snapshot')).settings.generation, saved.generation);
});

test('invalid generation setting patches are refused without a partial write', async t => {
  const service = await library(t);
  const before = await service.call('export');
  for (const generation of [null, [], 'fast', { concurrency: 0 }, { concurrency: 9 }, { concurrency: '3' },
    { batchSize: 6 }, { batchSize: 2.5 }, { jobTimeoutMinutes: 4 }, { jobTimeoutMinutes: 181 },
    { count: 0 }, { count: 501 }, { kind: 'case' }, { language: 'Klingon' }, { difficulty: 'hard' },
    { focus: 4 }, { focus: 'x'.repeat(2001) }, { phaseTimeoutMinutes: 30 }]) {
    await assert.rejects(service.call('settings', { first_interval_days: 4, generation }), /generation/i);
    assert.deepEqual(await service.call('export'), before);
  }
});

test('corrupt persisted generation values fall back without replacing valid siblings', async t => {
  const service = await library(t);
  const backup = await service.call('export');
  backup.settings.generation = { concurrency: -4, batchSize: 2, language: 'English', count: '20' };
  await service.call('restore', { state: backup });
  assert.deepEqual((await service.call('snapshot')).settings.generation, { ...expected, batchSize: 2, language: 'English' });
});

test('new requests use defaults and explicit one-off choices without mutating the saved settings', () => {
  const saved = { ...expected, concurrency: 6, batchSize: 2, count: 20, language: 'English', difficulty: 'advanced', focus: 'Explain trade-offs' };
  const before = structuredClone(saved);
  assert.deepEqual(resolveGenerationRequest(saved), { kind: 'quiz', count: 20, language: 'English', difficulty: 'advanced', focus: 'Explain trade-offs', notation: 'auto',
    performance: { concurrency: 6, batchSize: 2, jobTimeoutMinutes: 20, fillRounds: 2, ...EFFORTS } });
  assert.deepEqual(resolveGenerationRequest(saved, { kind: 'case', count: 2, language: 'Français', difficulty: 'Expert', focus: '', performance: { concurrency: 1 } }),
    { kind: 'case', count: 2, language: 'Français', difficulty: 'Expert', focus: '', notation: 'auto', performance: { concurrency: 1, batchSize: 2, jobTimeoutMinutes: 20, fillRounds: 2, ...EFFORTS } });
  assert.deepEqual(saved, before);
});

test('auto language resolves once from the request interface language', () => {
  assert.equal(resolveGenerationRequest(undefined, {}, { language: 'en' }).language, 'English');
  assert.equal(resolveGenerationRequest(undefined, {}, { language: 'zh' }).language, '中文');
  assert.equal(resolveGenerationRequest(undefined).language, '中文');
  assert.equal(resolveGenerationRequest({ language: 'English' }, { language: 'auto' }, { language: 'zh' }).language, '中文');
});

test('continued work inherits original choices and performance instead of changed library defaults, except the time limit, which follows the setting', () => {
  const continuation = { kind: 'mixed', count: 29, language: 'English', difficulty: 'application', focus: 'Original scope',
    performance: { concurrency: 1, batchSize: 3, jobTimeoutMinutes: 40 } };
  const before = structuredClone(continuation);
  const actual = resolveGenerationRequest({ ...expected, count: 30, concurrency: 6, batchSize: 1, language: '中文' },
    { count: 4, performance: { concurrency: 2 } }, { language: 'zh', continuation });
  // The time limit is how long the learner will wait, not part of what the draft was written with: raising it in 设置 is how a run that hit its limit is continued (3.0.1).
  assert.deepEqual(actual, { kind: 'mixed', count: 4, language: 'English', difficulty: 'application', focus: 'Original scope', notation: 'auto',
    performance: { concurrency: 2, batchSize: 3, jobTimeoutMinutes: 20, fillRounds: 2, ...EFFORTS } });
  assert.deepEqual(continuation, before);
  const raised = resolveGenerationRequest({ ...expected, jobTimeoutMinutes: 90 }, { count: 4 }, { language: 'zh', continuation });
  assert.deepEqual(raised.performance, { concurrency: 1, batchSize: 3, jobTimeoutMinutes: 90, fillRounds: 2, ...EFFORTS }, 'only the limit follows the setting; the rest stays as the draft was written');
  const oneOff = resolveGenerationRequest({ ...expected, jobTimeoutMinutes: 90 }, { performance: { jobTimeoutMinutes: 7 } }, { language: 'zh', continuation });
  assert.equal(oneOff.performance.jobTimeoutMinutes, 7, 'an explicit one-off limit still wins');
  const legacy = resolveGenerationRequest({ ...expected, concurrency: 6, language: 'English', difficulty: 'advanced', focus: 'New setting' },
    { count: 2 }, { language: 'en', continuation: { kind: 'flashcard' } });
  assert.deepEqual(legacy, { kind: 'flashcard', count: 2, language: '中文', difficulty: 'mixed', focus: '', notation: 'auto',
    performance: { concurrency: 4, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 2, ...EFFORTS } });
});

test('explicit performance accepts only the three bounded fields, while persisted reads remain safe', () => {
  assert.deepEqual(normalizeGenerationPerformance({ concurrency: '3', batchSize: 2, jobTimeoutMinutes: 180 }),
    { concurrency: 4, batchSize: 2, jobTimeoutMinutes: 180, fillRounds: 2, ...EFFORTS });
  assert.deepEqual(normalizeGenerationSettings([]), expected);
  assert.deepEqual(validateGenerationPatch({ focus: '  concise examples  ', count: 30 }), { focus: 'concise examples', count: 30 });
  for (const performance of [null, [], { concurrency: 2.5 }, { concurrency: 9 }, { batchSize: 0 },
    { batchSize: 6 }, { jobTimeoutMinutes: '20' }, { jobTimeoutMinutes: 181 }, { kind: 'quiz' }]) {
    assert.throws(() => validateGenerationPerformance(performance), /generation/i);
    assert.throws(() => resolveGenerationRequest(undefined, { performance }), /generation/i);
  }
});

test('saved generation preferences stay within their own library', async t => {
  const left = await library(t), right = await library(t);
  await left.call('settings', { generation: { concurrency: 1, language: 'English' } });
  assert.equal((await left.call('snapshot')).settings.generation.concurrency, 1);
  assert.deepEqual((await right.call('snapshot')).settings.generation, expected);
});
