/* 备考补习 personal defaults (S-1, S-2): the pure contract, the two actions, how the value is stored, served and backed up. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION, normalizeState } from '../lib/store.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { EXAM_PREP_DEFAULTS, EXAM_PREP_LIMITS, EXAM_PREP_LANGUAGES, checkPaperWord, mergeExamPrepSettings,
  normalizeExamPrepSettings, resolveExamPrepSettings, validateExamPrepPatch } from '../lib/exam-prep-settings.js';

const expected = { autoRoles: true, paperWords: [], language: 'auto', showOtherCourses: false };
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-exam-prep-settings-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, service };
}
const saved = async service => (await service.call('snapshot')).settings.examPrep;

/* ---------- S-1: the pure contract ---------- */

test('defaults and limits are the agreed ones, and the defaults cannot be changed by a caller', () => {
  assert.deepEqual(EXAM_PREP_DEFAULTS, expected);
  assert.deepEqual(EXAM_PREP_LIMITS.paperWords, { max: 20, wordMax: 20 });
  assert.deepEqual(EXAM_PREP_LANGUAGES, ['auto', 'zh', 'en']);
  assert.throws(() => { 'use strict'; EXAM_PREP_DEFAULTS.autoRoles = false; });
  assert.throws(() => { 'use strict'; EXAM_PREP_DEFAULTS.paperWords.push('x'); });
});

test('resolve gives the full object whether or not anything was saved, as a fresh copy', () => {
  assert.deepEqual(resolveExamPrepSettings(undefined), expected);
  assert.deepEqual(resolveExamPrepSettings(null), expected);
  assert.deepEqual(resolveExamPrepSettings({ language: 'en' }), { ...expected, language: 'en' });
  const one = resolveExamPrepSettings(), two = resolveExamPrepSettings();
  one.paperWords.push('x');
  assert.deepEqual(two.paperWords, [], 'one caller never changes what another reads');
});

test('normalize is lenient: a wrong value falls back to its default and valid siblings survive', () => {
  for (const raw of [undefined, null, [], 'x', 7]) assert.deepEqual(normalizeExamPrepSettings(raw), expected);
  assert.deepEqual(normalizeExamPrepSettings({ autoRoles: 'yes', language: 'fr', showOtherCourses: 1, paperWords: 'mock', unknown: 1 }), expected);
  assert.deepEqual(normalizeExamPrepSettings({ autoRoles: false, language: 'zh', showOtherCourses: true, paperWords: ['mock'] }),
    { autoRoles: false, paperWords: ['mock'], language: 'zh', showOtherCourses: true });
  assert.deepEqual(normalizeExamPrepSettings({ autoRoles: false, language: 'klingon' }), { ...expected, autoRoles: false });
});

test('paper words: trimmed, unique (letter case aside), no empty or too long entry, at most twenty; lenient reads keep the good ones', () => {
  const words = normalizeExamPrepSettings({ paperWords: ['  Mock  ', 'mock', 'MOCK', '', '   ', 7, null, 'x'.repeat(21), '练习卷', 'x'.repeat(20)] }).paperWords;
  assert.deepEqual(words, ['Mock', '练习卷', 'x'.repeat(20)]);
  const many = Array.from({ length: 30 }, (_, at) => `word${at}`);
  assert.deepEqual(normalizeExamPrepSettings({ paperWords: many }).paperWords, many.slice(0, 20));
});

test('a patch is strict: it names known keys with valid values, and a refused patch throws', () => {
  assert.deepEqual(validateExamPrepPatch({ language: 'en', autoRoles: false }), { language: 'en', autoRoles: false });
  assert.deepEqual(validateExamPrepPatch({ paperWords: [' a ', 'b', 'A'] }), { paperWords: ['a', 'b'] }, 'trimmed and de-duplicated');
  assert.deepEqual(validateExamPrepPatch({}), {});
  for (const patch of [null, [], 'fast', 3, { unknown: true }, { autoRoles: 'yes' }, { autoRoles: 1 }, { showOtherCourses: null }, { language: 'fr' }, { language: '中文' },
    { paperWords: 'mock' }, { paperWords: [7] }, { paperWords: [''] }, { paperWords: ['  '] }, { paperWords: ['x'.repeat(21)] },
    { paperWords: Array.from({ length: 21 }, (_, at) => `w${at}`) }]) assert.throws(() => validateExamPrepPatch(patch), /exam prep/i, JSON.stringify(patch));
  assert.deepEqual(validateExamPrepPatch({ paperWords: Array.from({ length: 20 }, (_, at) => `w${at}`) }).paperWords.length, 20, 'twenty is allowed');
});

test('merge keeps the saved siblings and applies the patch on top', () => {
  assert.deepEqual(mergeExamPrepSettings(undefined, { language: 'zh' }), { ...expected, language: 'zh' });
  assert.deepEqual(mergeExamPrepSettings({ language: 'en', paperWords: ['mock'] }, { autoRoles: false }),
    { autoRoles: false, paperWords: ['mock'], language: 'en', showOtherCourses: false });
  assert.throws(() => mergeExamPrepSettings({ language: 'en' }, { language: 'x' }));
});

test('checkPaperWord says why a word cannot be added, and gives the trimmed word when it can', () => {
  assert.deepEqual(checkPaperWord([], '  mock  '), { word: 'mock' });
  assert.deepEqual(checkPaperWord([], ''), { problem: 'empty' });
  assert.deepEqual(checkPaperWord([], '   '), { problem: 'empty' });
  assert.deepEqual(checkPaperWord([], undefined), { problem: 'empty' });
  assert.deepEqual(checkPaperWord([], 'x'.repeat(21)), { problem: 'long' });
  assert.deepEqual(checkPaperWord(['Mock'], ' mock '), { problem: 'duplicate' });
  assert.deepEqual(checkPaperWord(Array.from({ length: 20 }, (_, at) => `w${at}`), 'new'), { problem: 'full' });
  assert.deepEqual(checkPaperWord(Array.from({ length: 19 }, (_, at) => `w${at}`), 'new'), { word: 'new' });
});

/* ---------- S-2: the actions, the snapshot, the stored format ---------- */

test('nothing is saved until the learner saves: the snapshot has no examPrep and the stored library has no key', async t => {
  const { root, service } = await library(t);
  assert.equal(await saved(service), undefined);
  await service.call('settings', { first_interval_days: 3 });
  assert.equal('examPrep' in (await service.call('snapshot')).settings, false);
  assert.equal('examPrep' in JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8')).settings, false);
});

test('settings.examPrep.set merges per field into the saved settings and returns the full object', async t => {
  const { service } = await library(t);
  assert.deepEqual(await service.call('settings.examPrep.set', { patch: { language: 'en' } }), { ...expected, language: 'en' });
  assert.deepEqual(await service.call('settings.examPrep.set', { patch: { paperWords: [' mock ', 'Mock'] } }), { ...expected, language: 'en', paperWords: ['mock'] });
  assert.deepEqual(await service.call('settings.examPrep.set', { patch: { showOtherCourses: true, autoRoles: false } }),
    { autoRoles: false, paperWords: ['mock'], language: 'en', showOtherCourses: true });
  assert.deepEqual(await saved(service), { autoRoles: false, paperWords: ['mock'], language: 'en', showOtherCourses: true });
  assert.deepEqual(await service.call('settings.examPrep.set', { patch: {} }), await saved(service), 'an empty patch changes nothing');
});

test('settings.examPrep.set leaves the other settings alone, and the other settings leave it alone', async t => {
  const { service } = await library(t);
  await service.call('settings', { first_interval_days: 3, generation: { count: 12 } });
  await service.call('settings.examPrep.set', { patch: { language: 'zh' } });
  const settings = (await service.call('snapshot')).settings;
  assert.equal(settings.first_interval_days, 3);
  assert.equal(settings.generation.count, 12);
  await service.call('settings', { second_interval_days: 5 });
  assert.equal((await saved(service)).language, 'zh');
  // A form that writes the whole settings object back (as a release that does not know the key does) keeps it intact.
  await service.call('settings', { ...(await service.call('snapshot')).settings, second_interval_days: 4 });
  assert.deepEqual(await saved(service), { ...expected, language: 'zh' });
});

test('a refused patch changes nothing', async t => {
  const { service } = await library(t);
  await service.call('settings.examPrep.set', { patch: { language: 'en' } });
  const before = await service.call('export');
  for (const args of [{}, { patch: null }, { patch: [] }, { patch: { language: 'fr' } }, { patch: { autoRoles: 'no' } }, { patch: { paperWords: [''] } },
    { patch: { paperWords: ['x'.repeat(21)] } }, { patch: { unknown: true } }, { patch: { language: 'zh', autoRoles: 'no' } }, { language: 'zh' }])
    await assert.rejects(service.call('settings.examPrep.set', args), /exam prep/i, JSON.stringify(args));
  assert.deepEqual(await service.call('export'), before);
});

test('settings.examPrep.reset forgets the saved choices: the defaults come back and the key leaves the library', async t => {
  const { root, service } = await library(t);
  await service.call('settings.examPrep.set', { patch: { language: 'en', paperWords: ['mock'], autoRoles: false } });
  assert.deepEqual(await service.call('settings.examPrep.reset'), expected);
  assert.equal(await saved(service), undefined);
  assert.equal('examPrep' in JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8')).settings, false);
  assert.deepEqual(await service.call('settings.examPrep.reset'), expected, 'resetting twice is fine');
  assert.deepEqual(await service.call('settings.examPrep.set', { patch: { language: 'zh' } }), { ...expected, language: 'zh' }, 'and the next save starts from the defaults');
});

test('the generic settings action also merges an examPrep patch through the same checks', async t => {
  const { service } = await library(t);
  assert.equal((await service.call('settings', { examPrep: { language: 'en' } })).examPrep.language, 'en');
  await assert.rejects(service.call('settings', { examPrep: { language: 'fr' } }), /exam prep/i);
  assert.equal((await saved(service)).language, 'en');
});

test('stored format: one optional key inside the library settings; no version moves and no other field appears', async t => {
  const { root, service } = await library(t);
  await service.call('settings', { first_interval_days: 1 });
  await service.call('settings', { first_interval_days: 1 }); // the first write adds the library's own bookkeeping fields
  const before = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  await service.call('settings.examPrep.set', { patch: { language: 'en', paperWords: ['mock'] } });
  const after = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  assert.equal(after.version, LATEST_VERSION);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.settings.examPrep, { autoRoles: true, paperWords: ['mock'], language: 'en', showOtherCourses: false });
  const { examPrep, ...rest } = after.settings;
  assert.deepEqual(rest, before.settings, 'every other setting is as it was');
  assert.deepEqual(Object.keys(after).filter(key => !(key in before)), [], 'no top-level field was added');
});

test('an older release opens a library with the key and a library without it opens here', async t => {
  const { service } = await library(t);
  await service.call('settings.examPrep.set', { patch: { language: 'zh' } });
  const exported = await service.call('export');
  // A release without the key normalizes settings as `{ ...defaults, ...stored, generation, dailyRecap }` (lib/store.js): the unknown key rides along.
  assert.equal(normalizeState(JSON.parse(JSON.stringify(exported))).settings.examPrep.language, 'zh');
  const { examPrep, ...plain } = exported.settings;
  const legacy = normalizeState({ ...JSON.parse(JSON.stringify(exported)), settings: plain });
  assert.equal(legacy.settings.examPrep, undefined, 'a library from before has none, and none is invented');
  assert.deepEqual(resolveExamPrepSettings(legacy.settings.examPrep), expected);
});

test('backup and restore carry it like the other settings; a corrupt value falls back without losing valid siblings', async t => {
  const { service } = await library(t);
  await service.call('settings.examPrep.set', { patch: { language: 'en', paperWords: ['mock'], showOtherCourses: true } });
  const backup = await service.call('export');
  assert.deepEqual(backup.settings.examPrep, { autoRoles: true, paperWords: ['mock'], language: 'en', showOtherCourses: true });
  await service.call('settings.examPrep.reset');
  assert.equal(await saved(service), undefined);
  await service.call('restore', { state: backup });
  assert.deepEqual(await saved(service), backup.settings.examPrep, 'the round trip is exact');
  const corrupt = JSON.parse(JSON.stringify(backup));
  corrupt.settings.examPrep = { autoRoles: 'x', language: 'zh', paperWords: ['ok', '', 5], showOtherCourses: 'y', extra: 1 };
  await service.call('restore', { state: corrupt });
  assert.deepEqual(await saved(service), { autoRoles: true, paperWords: ['ok'], language: 'zh', showOtherCourses: false });
  corrupt.settings.examPrep = 'garbage';
  await service.call('restore', { state: corrupt });
  assert.deepEqual(await saved(service), expected);
});

test('both actions write the library settings and nothing else', () => {
  assert.deepEqual(writesFor('system', 'settings.examPrep.set'), ['settings']);
  assert.deepEqual(writesFor('system', 'settings.examPrep.reset'), ['settings']);
});
