/* 设置 › 练习 personal defaults: the pure contract, the two actions, how the value is stored, served and backed up. Same shape as 备考补习's (tests/exam-prep-settings.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION, normalizeState } from '../lib/store.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { NEW_CARD_ORDERS, PRACTICE_DEFAULTS, PRACTICE_LIMITS, mergePracticeSettings, normalizePracticeSettings, resolvePracticeSettings, roundLimits,
  validatePracticePatch } from '../lib/practice-settings.js';

const expected = { autopilot: false, roundSize: 20, newCardOrder: 'reading', debrief: true, rereadMarks: true, leechFailures: 4, leechWindow: 5, leechRate: 60 };
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-practice-settings-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, service };
}
const saved = async service => (await service.call('snapshot')).settings.practice;

/* ---------- the pure contract ---------- */

test('defaults and limits are the agreed ones: autopilot off, 20 questions a round, the debrief on; and they cannot be changed by a caller', () => {
  assert.deepEqual(PRACTICE_DEFAULTS, expected);
  assert.deepEqual(NEW_CARD_ORDERS, ['reading', 'focus', 'shuffle']);
  assert.deepEqual(PRACTICE_LIMITS.roundSize, { min: 5, max: 50 });
  assert.throws(() => { 'use strict'; PRACTICE_DEFAULTS.debrief = false; });
  assert.throws(() => { 'use strict'; PRACTICE_LIMITS.roundSize.max = 99; });
});

test('resolve gives the full object whether or not anything was saved', () => {
  assert.deepEqual(resolvePracticeSettings(undefined), expected);
  assert.deepEqual(resolvePracticeSettings(null), expected);
  assert.deepEqual(resolvePracticeSettings({ debrief: false }), { ...expected, debrief: false });
});

test('normalizePracticeSettings falls back invalid autopilot/roundSize/newCardOrder/debrief values to defaults while keeping valid siblings', () => {
  for (const raw of [undefined, null, [], 'x', 7]) assert.deepEqual(normalizePracticeSettings(raw), expected);
  assert.deepEqual(normalizePracticeSettings({ autopilot: 'yes', roundSize: '20', debrief: 0, unknown: 1 }), { ...expected, unknown: 1 });
  assert.deepEqual(normalizePracticeSettings({ autopilot: true, roundSize: 30, debrief: false }), { ...expected, autopilot: true, roundSize: 30, debrief: false });
  for (const roundSize of [4, 51, 12.5, NaN, Infinity, -1, 0]) assert.equal(normalizePracticeSettings({ roundSize, autopilot: true }).roundSize, 20, String(roundSize));
  assert.equal(normalizePracticeSettings({ roundSize: 5 }).roundSize, 5);
  assert.equal(normalizePracticeSettings({ roundSize: 50 }).roundSize, 50);
  assert.equal(normalizePracticeSettings({ roundSize: 7, autopilot: 'x', newCardOrder: 'backwards' }).roundSize, 7, 'a wrong sibling does not cost a good value');
  assert.equal(normalizePracticeSettings({ newCardOrder: 'focus' }).newCardOrder, 'focus');
  assert.equal(normalizePracticeSettings({ newCardOrder: 'shuffle' }).newCardOrder, 'shuffle');
  assert.equal(normalizePracticeSettings({ newCardOrder: 'invalid' }).newCardOrder, 'reading');
});

test('validatePracticePatch rejects unknown keys, out-of-range roundSize, and invalid newCardOrder or boolean types', () => {
  assert.deepEqual(validatePracticePatch({ autopilot: true, roundSize: 10, newCardOrder: 'focus' }), { autopilot: true, roundSize: 10, newCardOrder: 'focus' });
  assert.deepEqual(validatePracticePatch({}), {});
  for (const patch of [null, [], 'fast', 3, { unknown: true }, { autopilot: 'yes' }, { debrief: 1 }, { debrief: null }, { roundSize: '20' }, { roundSize: 4 },
    { roundSize: 51 }, { roundSize: 10.5 }, { roundSize: null }, { newCardOrder: 'random' }, { newCardOrder: null }]) assert.throws(() => validatePracticePatch(patch), /practice/i, JSON.stringify(patch));
});

test('mergePracticeSettings preserves saved roundSize/autopilot siblings when applying a debrief patch', () => {
  assert.deepEqual(mergePracticeSettings(undefined, { debrief: false }), { ...expected, debrief: false });
  assert.deepEqual(mergePracticeSettings({ roundSize: 30, autopilot: true }, { debrief: false }), { ...expected, autopilot: true, roundSize: 30, debrief: false });
  assert.throws(() => mergePracticeSettings({ roundSize: 30 }, { roundSize: 1 }));
});

test('the round size gives the two limits of a daily round: the session holds that many, at most half of them new (20 -> 10, as it always was)', () => {
  assert.deepEqual(roundLimits(20), { limit: 20, newLimit: 10 });
  assert.deepEqual(roundLimits(5), { limit: 5, newLimit: 3 });
  assert.deepEqual(roundLimits(50), { limit: 50, newLimit: 25 });
  assert.deepEqual(roundLimits(undefined), { limit: 20, newLimit: 10 });
  assert.deepEqual(roundLimits(1000), { limit: 20, newLimit: 10 }, 'an out-of-range value is the default, never a huge round');
});

/* ---------- the actions, the snapshot, the stored format ---------- */

test('nothing is saved until the learner saves: the snapshot has no practice key and the stored library has none', async t => {
  const { root, service } = await library(t);
  assert.equal(await saved(service), undefined);
  await service.call('settings', { maximum_interval: 3 });
  assert.equal('practice' in (await service.call('snapshot')).settings, false);
  assert.equal('practice' in JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8')).settings, false);
});

test('settings.practice.set merges debrief, roundSize, and autopilot patches incrementally and returns the resolved practice config', async t => {
  const { service } = await library(t);
  assert.deepEqual(await service.call('settings.practice.set', { patch: { debrief: false } }), { ...expected, debrief: false });
  assert.deepEqual(await service.call('settings.practice.set', { patch: { roundSize: 30 } }), { ...expected, debrief: false, roundSize: 30 });
  assert.deepEqual(await service.call('settings.practice.set', { patch: { autopilot: true } }), { ...expected, autopilot: true, roundSize: 30, debrief: false });
  assert.deepEqual(await saved(service), { ...expected, autopilot: true, roundSize: 30, debrief: false });
  assert.deepEqual(await service.call('settings.practice.set', { patch: {} }), await saved(service), 'an empty patch changes nothing');
});

test('settings.practice.set leaves the other settings alone, and the other settings leave it alone', async t => {
  const { service } = await library(t);
  await service.call('settings', { maximum_interval: 3, generation: { count: 12 } });
  await service.call('settings.practice.set', { patch: { autopilot: true } });
  const settings = (await service.call('snapshot')).settings;
  assert.equal(settings.maximum_interval, 3);
  assert.equal(settings.generation.count, 12);
  await service.call('settings', { request_retention: 0.85 });
  assert.equal((await saved(service)).autopilot, true);
  await service.call('settings', { ...(await service.call('snapshot')).settings, request_retention: 0.84 });
  assert.deepEqual(await saved(service), { ...expected, autopilot: true });
});

test('settings.practice.set leaves exported workspace unchanged when a practice patch is refused', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 15 } });
  const before = await service.call('export');
  for (const args of [{}, { patch: null }, { patch: [] }, { patch: { roundSize: 3 } }, { patch: { autopilot: 'no' } }, { patch: { unknown: true } },
    { patch: { debrief: false, roundSize: 'x' } }, { debrief: false }])
    await assert.rejects(service.call('settings.practice.set', args), /practice/i, JSON.stringify(args));
  assert.deepEqual(await service.call('export'), before);
});

test('settings.practice.reset restores PRACTICE_DEFAULTS and removes settings.practice from study-workspace.json', async t => {
  const { root, service } = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 40, autopilot: true, debrief: false } });
  assert.deepEqual(await service.call('settings.practice.reset'), expected);
  assert.equal(await saved(service), undefined);
  assert.equal('practice' in JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8')).settings, false);
  assert.deepEqual(await service.call('settings.practice.reset'), expected, 'resetting twice is fine');
  assert.deepEqual(await service.call('settings.practice.set', { patch: { roundSize: 10 } }), { ...expected, roundSize: 10 }, 'and the next save starts from the defaults');
});

test('the generic settings action also merges a practice patch through the same checks', async t => {
  const { service } = await library(t);
  assert.equal((await service.call('settings', { practice: { autopilot: true } })).practice.autopilot, true);
  await assert.rejects(service.call('settings', { practice: { roundSize: 1 } }), /practice/i);
  assert.equal((await saved(service)).autopilot, true);
});

test('study-workspace.json stores settings.practice as one optional key without bumping LATEST_VERSION or adding top-level fields', async t => {
  const { root, service } = await library(t);
  await service.call('settings', { maximum_interval: 1 });
  await service.call('settings', { maximum_interval: 1 });
  const before = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  await service.call('settings.practice.set', { patch: { roundSize: 30, debrief: false } });
  const after = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  assert.equal(after.version, LATEST_VERSION);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.settings.practice, { ...expected, autopilot: false, roundSize: 30, debrief: false });
  const { practice, ...rest } = after.settings;
  assert.deepEqual(rest, before.settings, 'every other setting is as it was');
  assert.deepEqual(Object.keys(after).filter(key => !(key in before)), [], 'no top-level field was added');
});

test('normalizeState preserves settings.practice for newer libraries and resolves defaults when older libraries omit practice', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 30 } });
  const exported = await service.call('export');
  assert.equal(normalizeState(JSON.parse(JSON.stringify(exported))).settings.practice.roundSize, 30);
  const { practice, ...plain } = exported.settings;
  const legacy = normalizeState({ ...JSON.parse(JSON.stringify(exported)), settings: plain });
  assert.equal(legacy.settings.practice, undefined, 'a library from before has none, and none is invented');
  assert.deepEqual(resolvePracticeSettings(legacy.settings.practice), expected);
});

test('export/restore round-trips settings.practice and heals corrupt practice fields without losing valid roundSize', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { autopilot: true, roundSize: 25, debrief: false } });
  const backup = await service.call('export');
  assert.deepEqual(backup.settings.practice, { ...expected, autopilot: true, roundSize: 25, debrief: false });
  await service.call('settings.practice.reset');
  assert.equal(await saved(service), undefined);
  await service.call('restore', { state: backup });
  assert.deepEqual(await saved(service), backup.settings.practice, 'the round trip is exact');
  const corrupt = JSON.parse(JSON.stringify(backup));
  corrupt.settings.practice = { autopilot: 'x', roundSize: 12, debrief: 'y', extra: 1 };
  await service.call('restore', { state: corrupt });
  assert.deepEqual(await saved(service), { ...expected, autopilot: false, roundSize: 12, debrief: true, extra: 1 });
  corrupt.settings.practice = 'garbage';
  await service.call('restore', { state: corrupt });
  assert.deepEqual(await saved(service), expected);
});

test('domain contract: settings.practice.set and settings.practice.reset only declare writes to settings', () => {
  assert.deepEqual(writesFor('system', 'settings.practice.set'), ['settings']);
  assert.deepEqual(writesFor('system', 'settings.practice.reset'), ['settings']);
});
