/* 我的修题语句: the learner's own reusable phrases for the 修题 box. The pure contract (lib/fix-phrases.js), how it is saved (settings.practice.fixPhrases through
   the existing settings.practice.set), and that 恢复默认 does not throw personal phrases away. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { normalizeState } from '../lib/store.js';
import { FIX_PHRASE_LIMITS, addFixPhrase, canAddFixPhrase, normalizeFixPhrases, removeFixPhrase, validateFixPhrases } from '../lib/fix-phrases.js';
import { mergePracticeSettings, normalizePracticeSettings, resolvePracticeSettings, validatePracticePatch } from '../lib/practice-settings.js';

const OWN = '请采用代码块格式改写题目的原有口述代码形式';
const defaults = { autopilot: false, roundSize: 20, newCardOrder: 'reading', debrief: true, leechFailures: 4, leechWindow: 5, leechRate: 60 };
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-fix-phrases-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, service };
}
const saved = async service => (await service.call('snapshot')).settings.practice;

test('the limits are small and fixed: 12 phrases of at most 200 characters', () => {
  assert.deepEqual(FIX_PHRASE_LIMITS, { count: 12, length: 200 });
  assert.throws(() => { 'use strict'; FIX_PHRASE_LIMITS.count = 99; });
});

test('normalize is lenient: trims, drops what is empty, too long or not text, removes duplicates, keeps the first 12', () => {
  assert.deepEqual(normalizeFixPhrases([`  ${OWN}  `, '', '   ', 7, null, { a: 1 }, OWN, 'x'.repeat(201), 'b']), [OWN, 'b']);
  for (const raw of [undefined, null, 'x', 5, {}, []]) assert.deepEqual(normalizeFixPhrases(raw), []);
  assert.equal(normalizeFixPhrases(['y'.repeat(200)])[0].length, 200, 'exactly 200 is fine');
  const many = Array.from({ length: 20 }, (_, i) => `phrase ${i}`);
  assert.deepEqual(normalizeFixPhrases(many), many.slice(0, 12));
});

test('a strict check refuses a wrong shape, a phrase over 200 characters and more than 12 phrases; it trims and de-duplicates what it accepts', () => {
  assert.deepEqual(validateFixPhrases([`  ${OWN} `, OWN, '', 'b']), [OWN, 'b']);
  assert.deepEqual(validateFixPhrases([]), []);
  for (const bad of ['x', 5, {}, [1], [null], ['a', ['b']], ['z'.repeat(201)], Array.from({ length: 13 }, (_, i) => `p${i}`)])
    assert.throws(() => validateFixPhrases(bad), /fix phrase/i, JSON.stringify(bad).slice(0, 40));
  assert.equal(validateFixPhrases(Array.from({ length: 12 }, (_, i) => `p${i}`)).length, 12);
  assert.equal(validateFixPhrases([...Array.from({ length: 12 }, (_, i) => `p${i}`), 'p0']).length, 12, 'a repeat is not a 13th phrase');
});

test('adding and removing are pure and idempotent', () => {
  const one = addFixPhrase([], `  ${OWN}  `);
  assert.deepEqual(one, [OWN]);
  assert.deepEqual(addFixPhrase(one, OWN), one, 'adding it twice ends in the same list');
  assert.deepEqual(addFixPhrase(one, 'b'), [OWN, 'b']);
  assert.deepEqual(addFixPhrase(one, '   '), one, 'blank text adds nothing');
  assert.deepEqual(removeFixPhrase([OWN, 'b'], OWN), ['b']);
  assert.deepEqual(removeFixPhrase(['b'], 'zzz'), ['b'], 'removing what is not there changes nothing');
  const full = Array.from({ length: 12 }, (_, i) => `p${i}`);
  assert.deepEqual(addFixPhrase(full, 'new'), full, 'a full list takes no 13th');
});

test('the panel asks first whether the text can be saved, and gets a reason in a word', () => {
  assert.deepEqual(canAddFixPhrase([], OWN), { ok: true });
  assert.deepEqual(canAddFixPhrase([], '  '), { ok: false, reason: 'empty' });
  assert.deepEqual(canAddFixPhrase([OWN], ` ${OWN} `), { ok: false, reason: 'saved' });
  assert.deepEqual(canAddFixPhrase([], 'x'.repeat(201)), { ok: false, reason: 'long' });
  assert.deepEqual(canAddFixPhrase(Array.from({ length: 12 }, (_, i) => `p${i}`), 'new'), { ok: false, reason: 'full' });
});

test('practice settings keep the phrases as one optional key: absent until saved, the three defaults untouched', () => {
  assert.deepEqual(resolvePracticeSettings(undefined), defaults, 'no key for the learner who saved none');
  assert.deepEqual(normalizePracticeSettings({ fixPhrases: [] }), defaults, 'an empty list is no key');
  assert.deepEqual(normalizePracticeSettings({ roundSize: 30, fixPhrases: [` ${OWN} `, OWN, 3] }), { ...defaults, roundSize: 30, fixPhrases: [OWN] });
  assert.deepEqual(normalizePracticeSettings({ fixPhrases: 'x' }), defaults, 'a corrupt value is dropped');
  assert.deepEqual(validatePracticePatch({ fixPhrases: [OWN] }), { fixPhrases: [OWN] });
  assert.deepEqual(validatePracticePatch({ fixPhrases: null }), { fixPhrases: null });
  assert.throws(() => validatePracticePatch({ fixPhrases: 'x' }), /practice/i);
  assert.throws(() => validatePracticePatch({ fixPhrases: ['z'.repeat(201)] }), /practice/i);
  assert.deepEqual(mergePracticeSettings({ roundSize: 30 }, { fixPhrases: [OWN] }), { ...defaults, roundSize: 30, fixPhrases: [OWN] });
  assert.deepEqual(mergePracticeSettings({ fixPhrases: [OWN] }, { debrief: false }), { ...defaults, debrief: false, fixPhrases: [OWN] }, 'another patch keeps them');
  assert.deepEqual(mergePracticeSettings({ fixPhrases: [OWN] }, { fixPhrases: null }), defaults, 'null takes them away');
  assert.deepEqual(mergePracticeSettings({ fixPhrases: [OWN] }, { fixPhrases: [] }), defaults, 'so does an empty list');
});

test('settings.practice.set saves and removes phrases in the library settings, and they survive a reload and a backup', async t => {
  const { root, service } = await library(t);
  assert.deepEqual(await service.call('settings.practice.set', { patch: { fixPhrases: [OWN] } }), { ...defaults, fixPhrases: [OWN] });
  assert.deepEqual((await saved(service)).fixPhrases, [OWN]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8')).settings.practice.fixPhrases, [OWN], 'on disk, in the library, not in the browser');
  const backup = await service.call('export');
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(backup))).settings.practice.fixPhrases, [OWN]);
  await service.call('settings.practice.set', { patch: { roundSize: 10 } });
  assert.deepEqual((await saved(service)).fixPhrases, [OWN], 'a round-size change keeps them');
  await service.call('settings.practice.set', { patch: { fixPhrases: [OWN, 'b'] } });
  await service.call('settings.practice.set', { patch: { fixPhrases: ['b'] } });
  assert.deepEqual((await saved(service)).fixPhrases, ['b']);
  await service.call('settings.practice.set', { patch: { fixPhrases: [] } });
  assert.equal('fixPhrases' in (await saved(service)), false);
  await assert.rejects(service.call('settings.practice.set', { patch: { fixPhrases: ['z'.repeat(201)] } }), /practice/i);
  await assert.rejects(service.call('settings.practice.set', { patch: { fixPhrases: Array.from({ length: 13 }, (_, i) => `p${i}`) } }), /practice/i);
});

test('恢复默认 forgets the practice defaults but not the learner\'s own phrases', async t => {
  const { service } = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 40, fixPhrases: [OWN] } });
  assert.deepEqual(await service.call('settings.practice.reset'), { ...defaults, fixPhrases: [OWN] });
  assert.deepEqual(await saved(service), { ...defaults, fixPhrases: [OWN] });
  await service.call('settings.practice.set', { patch: { fixPhrases: null } });
  assert.deepEqual(await service.call('settings.practice.reset'), defaults);
  assert.equal(await saved(service), undefined, 'with no phrases the key leaves the library, as before');
});
