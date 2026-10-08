/* 设置 › 练习 personal defaults: the pure contract, the two actions, how the value is stored, served and backed up. Same shape as 备考补习's (tests/exam-prep-settings.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION, normalizeState } from '../lib/store.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { PRACTICE_DEFAULTS, PRACTICE_LIMITS, mergePracticeSettings, normalizePracticeSettings, resolvePracticeSettings, roundLimits,
  validatePracticePatch } from '../lib/practice-settings.js';

const expected = { autopilot: false, roundSize: 20, debrief: true };
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
  assert.deepEqual(PRACTICE_LIMITS.roundSize, { min: 5, max: 50 });
  assert.throws(() => { 'use strict'; PRACTICE_DEFAULTS.debrief = false; });
  assert.throws(() => { 'use strict'; PRACTICE_LIMITS.roundSize.max = 99; });
});

test('resolve gives the full object whether or not anything was saved', () => {
  assert.deepEqual(resolvePracticeSettings(undefined), expected);
  assert.deepEqual(resolvePracticeSettings(null), expected);
  assert.deepEqual(resolvePracticeSettings({ debrief: false }), { ...expected, debrief: false });
});

test('normalize is lenient: a wrong value falls back to its default and valid siblings survive', () => {
  for (const raw of [undefined, null, [], 'x', 7]) assert.deepEqual(normalizePracticeSettings(raw), expected);
  assert.deepEqual(normalizePracticeSettings({ autopilot: 'yes', roundSize: '20', debrief: 0, unknown: 1 }), expected);
  assert.deepEqual(normalizePracticeSettings({ autopilot: true, roundSize: 30, debrief: false }), { autopilot: true, roundSize: 30, debrief: false });
  for (const roundSize of [4, 51, 12.5, NaN, Infinity, -1, 0]) assert.equal(normalizePracticeSettings({ roundSize, autopilot: true }).roundSize, 20, String(roundSize));
  assert.equal(normalizePracticeSettings({ roundSize: 5 }).roundSize, 5);
  assert.equal(normalizePracticeSettings({ roundSize: 50 }).roundSize, 50);
  assert.equal(normalizePracticeSettings({ roundSize: 7, autopilot: 'x' }).roundSize, 7, 'a wrong sibling does not cost a good value');
});

test('a patch is strict: it names known keys with valid values, and a refused patch throws', () => {
  assert.deepEqual(validatePracticePatch({ autopilot: true, roundSize: 10 }), { autopilot: true, roundSize: 10 });
  assert.deepEqual(validatePracticePatch({}), {});
  for (const patch of [null, [], 'fast', 3, { unknown: true }, { autopilot: 'yes' }, { debrief: 1 }, { debrief: null }, { roundSize: '20' }, { roundSize: 4 },
    { roundSize: 51 }, { roundSize: 10.5 }, { roundSize: null }]) assert.throws(() => validatePracticePatch(patch), /practice/i, JSON.stringify(patch));
});

test('merge keeps the saved siblings and applies the patch on top', () => {
  assert.deepEqual(mergePracticeSettings(undefined, { debrief: false }), { ...expected, debrief: false });
  assert.deepEqual(mergePracticeSettings({ roundSize: 30, autopilot: true }, { debrief: false }), { autopilot: true, roundSize: 30, debrief: false });
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
  await service.call('settings', { first_interval_days: 3 });
  assert.equal('practice' in (await service.call('snapshot')).settings, false);
  assert.equal('practice' in JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8')).settings, false);
});

test('settings.practice.set merges per field into the saved settings and returns the full object', async t => {
  const { service } = await library(t);
  assert.deepEqual(await service.call('settings.practice.set', { patch: { debrief: false } }), { ...expected, debrief: false });
  assert.deepEqual(await service.call('settings.practice.set', { patch: { roundSize: 30 } }), { ...expected, debrief: false, roundSize: 30 });
  assert.deepEqual(await service.call('settings.practice.set', { patch: { autopilot: true } }), { autopilot: true, roundSize: 30, debrief: false });
  assert.deepEqual(await saved(service), { autopilot: true, roundSize: 30, debrief: false });
  assert.deepEqual(await service.call('settings.practice.set', { patch: {} }), await saved(service), 'an empty patch changes nothing');
});

test('settings.practice.set leaves the other settings alone, and the other settings leave it alone', async t => {
  const { service } = await library(t);
  await service.call('settings', { first_interval_days: 3, generation: { count: 12 } });
  await service.call('settings.practice.set', { patch: { autopilot: true } });
  const settings = (await service.call('snapshot')).settings;
  assert.equal(settings.first_interval_days, 3);
  assert.equal(settings.generation.count, 12);
  await service.call('settings', { second_interval_days: 5 });
  assert.equal((await saved(service)).autopilot, true);
  await service.call('settings', { ...(await service.call('snapshot')).settings, second_interval_days: 4 });
  assert.deepEqual(await saved(service), { ...expected, autopilot: true });
});

test('a refused patch changes nothing', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 15 } });
  const before = await service.call('export');
  for (const args of [{}, { patch: null }, { patch: [] }, { patch: { roundSize: 3 } }, { patch: { autopilot: 'no' } }, { patch: { unknown: true } },
    { patch: { debrief: false, roundSize: 'x' } }, { debrief: false }])
    await assert.rejects(service.call('settings.practice.set', args), /practice/i, JSON.stringify(args));
  assert.deepEqual(await service.call('export'), before);
});

test('settings.practice.reset forgets the saved choices: the defaults come back and the key leaves the library', async t => {
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

test('stored format: one optional key inside the library settings; no version moves and no other field appears', async t => {
  const { root, service } = await library(t);
  await service.call('settings', { first_interval_days: 1 });
  await service.call('settings', { first_interval_days: 1 });
  const before = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  await service.call('settings.practice.set', { patch: { roundSize: 30, debrief: false } });
  const after = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  assert.equal(after.version, LATEST_VERSION);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.settings.practice, { autopilot: false, roundSize: 30, debrief: false });
  const { practice, ...rest } = after.settings;
  assert.deepEqual(rest, before.settings, 'every other setting is as it was');
  assert.deepEqual(Object.keys(after).filter(key => !(key in before)), [], 'no top-level field was added');
});

test('an older release opens a library with the key and a library without it opens here', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 30 } });
  const exported = await service.call('export');
  assert.equal(normalizeState(JSON.parse(JSON.stringify(exported))).settings.practice.roundSize, 30);
  const { practice, ...plain } = exported.settings;
  const legacy = normalizeState({ ...JSON.parse(JSON.stringify(exported)), settings: plain });
  assert.equal(legacy.settings.practice, undefined, 'a library from before has none, and none is invented');
  assert.deepEqual(resolvePracticeSettings(legacy.settings.practice), expected);
});

test('backup and restore carry it like the other settings; a corrupt value falls back without losing valid siblings', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { autopilot: true, roundSize: 25, debrief: false } });
  const backup = await service.call('export');
  assert.deepEqual(backup.settings.practice, { autopilot: true, roundSize: 25, debrief: false });
  await service.call('settings.practice.reset');
  assert.equal(await saved(service), undefined);
  await service.call('restore', { state: backup });
  assert.deepEqual(await saved(service), backup.settings.practice, 'the round trip is exact');
  const corrupt = JSON.parse(JSON.stringify(backup));
  corrupt.settings.practice = { autopilot: 'x', roundSize: 12, debrief: 'y', extra: 1 };
  await service.call('restore', { state: corrupt });
  assert.deepEqual(await saved(service), { autopilot: false, roundSize: 12, debrief: true });
  corrupt.settings.practice = 'garbage';
  await service.call('restore', { state: corrupt });
  assert.deepEqual(await saved(service), expected);
});

test('both actions write the library settings and nothing else', () => {
  assert.deepEqual(writesFor('system', 'settings.practice.set'), ['settings']);
  assert.deepEqual(writesFor('system', 'settings.practice.reset'), ['settings']);
});
