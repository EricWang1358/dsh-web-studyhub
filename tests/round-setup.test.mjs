import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { emptyState } from '../lib/store.js';
import { planPath } from '../lib/mastery.js';
import {
  PRACTICE_LIMITS, ROUND_ONLY, ROUND_SIZE_LIMITS, checkedRoundOnly, checkedRoundSize, freshRoundCount, mergePracticeSettings, normalizePracticeSettings,
  resolvePracticeSettings, roundLimits, validatePracticePatch,
} from '../lib/practice-settings.js';
import { loadUi } from './helpers/ui-module.mjs';
import { chaptersOf, resultTarget, roundArgs, roundChoice, roundDefaults, roundKey, sameRound } from '../ui/review/round-setup.js';

const { dailyPathArgs } = await loadUi("export { dailyPathArgs } from './ui/study-map/home-plan.js';");

/* #1010 本轮设置: one round's size, range (到期 / 新题 / 错题 / 混合) and chapter, chosen where a round starts. The defaults come from resolvePracticeSettings, the bounds are the
   ones the backend validates with (lib/practice-settings.js), and a popover that is never opened starts exactly the round the button always started. */

const PAST = '2026-10-01T00:00:00Z';
const make = (id, state) => ({ id, kind: 'quiz', topic: id.includes('weak') ? 'Weak chapter' : 'T', prompt: `${id}?`, answer: 'a',
  options: [{ id: 'y', text: 'Yes', correct: true }, { id: 'n', text: 'No', correct: false }],
  ...(state === 'due' ? { review: { repetitions: 2, interval_days: 3, ease: 2.5, due_at: PAST } } : {}) });
function deckOf(id, course, { due = 0, weak = 0, fresh = 0 }, attempts) {
  const cards = [];
  for (let at = 0; at < due; at++) { const card = make(`${id}-due${at}`, 'due'); cards.push(card); attempts.push({ deckId: id, quiz_id: card.id, grade: 4, timestamp: PAST }); }
  for (let at = 0; at < weak; at++) { const card = make(`${id}-weak${at}`); cards.push(card); attempts.push({ deckId: id, quiz_id: card.id, grade: 1, timestamp: PAST }); }
  for (let at = 0; at < fresh; at++) cards.push(make(`${id}-new${at}`));
  return { id, title: id, course, cards };
}
async function library(t, { a = { due: 6, weak: 4, fresh: 40 }, b = { due: 4 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-round-setup-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const attempts = [], state = emptyState();
  state.decks = [deckOf('a', 'A', a, attempts), deckOf('b', 'B', b, attempts)];
  await service.store.update((s) => { Object.assign(s, { decks: state.decks, attempts, focus: { mode: 'class', course: 'A' } }); });
  return service;
}
const ids = (run) => run.entries?.map((entry) => entry.card.id) ?? [];
const started = async (service, args) => { const run = await service.call('review.start', { mode: 'path', fresh: true, ...args }); return service.store.read().then((s) => s.runs.find((r) => r.id === run.id)); };

/* ── the one source of the bounds ── */

test('the bounds of a round are the settings\' own, and the backend refuses what they refuse', async (t) => {
  assert.equal(ROUND_SIZE_LIMITS, PRACTICE_LIMITS.roundSize, 'one object, not a copy');
  assert.deepEqual({ ...ROUND_SIZE_LIMITS }, { min: 5, max: 50 });
  for (const size of [ROUND_SIZE_LIMITS.min, 20, ROUND_SIZE_LIMITS.max]) assert.equal(checkedRoundSize(size), size);
  for (const size of [ROUND_SIZE_LIMITS.min - 1, ROUND_SIZE_LIMITS.max + 1, 12.5, '10', null, NaN, 0, -3]) assert.throws(() => checkedRoundSize(size), new RegExp(`${ROUND_SIZE_LIMITS.min}–${ROUND_SIZE_LIMITS.max}`), String(size));
  assert.deepEqual([...ROUND_ONLY], ['due', 'new', 'wrong']);
  assert.equal(checkedRoundOnly(undefined), undefined);
  for (const only of ROUND_ONLY) assert.equal(checkedRoundOnly(only), only);
  for (const only of ['mixed', 'weak', '', null, 3]) assert.throws(() => checkedRoundOnly(only), /due|到期/, String(only));
  // The same refusal where the round starts, and where the default is saved: nothing can be chosen in one place and refused in the other.
  const service = await library(t);
  for (const size of [ROUND_SIZE_LIMITS.min - 1, ROUND_SIZE_LIMITS.max + 1, 12.5, '10']) {
    await assert.rejects(service.call('review.start', { mode: 'path', course: 'A', daily: true, size }), new RegExp(`${ROUND_SIZE_LIMITS.min}–${ROUND_SIZE_LIMITS.max}`), `review.start size ${size}`);
    assert.throws(() => validatePracticePatch({ roundSize: size }), /roundSize/, `settings size ${size}`);
  }
  for (const size of [ROUND_SIZE_LIMITS.min, ROUND_SIZE_LIMITS.max]) {
    assert.doesNotThrow(() => validatePracticePatch({ roundSize: size }));
    assert.ok((await service.call('review.start', { mode: 'path', course: 'A', daily: true, size, fresh: true })).total > 0);
  }
  await assert.rejects(service.call('review.start', { mode: 'path', course: 'A', daily: true, only: 'mixed' }), /due|到期/);
  await assert.rejects(service.call('review.start', { mode: 'due', deckId: 'a', size: 10 }), /本轮设置/, 'size and only belong to the path round');
  await assert.rejects(service.call('review.start', { mode: 'new', deckId: 'a', only: 'new' }), /本轮设置/);
  // The older `count` of a round of new questions shares the ceiling (it was 1–100 beside the settings' 5–50); a few at a time stays possible.
  for (const count of [0, ROUND_SIZE_LIMITS.max + 1, 100, 2.5]) {
    await assert.rejects(service.call('review.start', { mode: 'new', currentCourse: true, count, fresh: true }), new RegExp(`1–${ROUND_SIZE_LIMITS.max}`), `count ${count}`);
    await assert.rejects(service.call('review.start', { mode: 'new', deckId: 'a', count, fresh: true }), new RegExp(`1–${ROUND_SIZE_LIMITS.max}`), `deck count ${count}`);
  }
  for (const count of [1, 30]) assert.equal((await service.call('review.start', { mode: 'new', currentCourse: true, count, fresh: true })).total, count);
  assert.equal((await service.call('review.start', { mode: 'new', currentCourse: true, count: ROUND_SIZE_LIMITS.max, fresh: true })).total, 40, 'the ceiling is allowed; the course holds 40 new ones');
});

/* ── review.start: the range and the size of one round ── */

test('only: 错题 / 到期 / 新题 take that kind alone, up to the size asked for', async (t) => {
  const service = await library(t);
  const wrong = await started(service, { course: 'A', daily: true, only: 'wrong', size: 10 });
  assert.deepEqual(ids(wrong).sort(), ['a-weak0', 'a-weak1', 'a-weak2', 'a-weak3'], 'the four wrong ones, nothing else');
  const due = await started(service, { course: 'A', daily: true, only: 'due', size: 5 });
  assert.equal(ids(due).length, 5, 'five of the six due ones');
  assert.ok(ids(due).every((id) => id.startsWith('a-due')));
  const fresh = await started(service, { course: 'A', daily: true, only: 'new', size: 10 });
  assert.equal(ids(fresh).length, 10, 'ten new ones: the size, not half of it');
  assert.ok(ids(fresh).every((id) => id.startsWith('a-new')));
  const big = await started(service, { course: 'A', daily: true, only: 'new', size: 30 });
  assert.equal(ids(big).length, 30, 'a round of 30 new questions is 30 new questions');
});

test('a size alone changes the cap of the round and nothing else: due, then wrong, then new', async (t) => {
  const service = await library(t);
  const ten = await started(service, { course: 'A', daily: true, size: 10 });
  assert.equal(ids(ten).length, 10);
  assert.deepEqual(ids(ten).map((id) => id.split(/\d/)[0]), [...Array(6).fill('a-due'), ...Array(4).fill('a-weak')], 'the six due, then the four wrong');
  const thirty = await started(service, { course: 'A', daily: true, size: 30 });
  assert.equal(ids(thirty).length, 25, '6 due + 4 wrong + 15 new (half of 30): the size moves the cap and the new share together');
  const plain = await started(service, { course: 'A', daily: true });
  assert.equal(ids(plain).length, 20, 'without a size: the setting (20)');
});

test('a chapter (a scope of the course) is capped by the size too, and the range applies inside it', async (t) => {
  const service = await library(t);
  const chapter = await started(service, { scope: [{ deckId: 'a', topic: 'T' }], size: 5 });
  assert.equal(ids(chapter).length, 5);
  assert.ok(ids(chapter).every((id) => !id.includes('weak')), 'the topic T holds no wrong ones');
  const wrongInside = await started(service, { scope: [{ deckId: 'a', topic: 'Weak chapter' }], only: 'wrong', size: 10 });
  assert.equal(ids(wrongInside).length, 4);
  const all = await started(service, { only: 'due', size: 5 });
  assert.equal(ids(all).length, 5, 'every active course: due questions of both courses');
});

test('an empty range says which one, and a settings-only request never resumes the old round', async (t) => {
  const service = await library(t);
  await assert.rejects(service.call('review.start', { mode: 'path', course: 'B', daily: true, only: 'wrong', size: 10 }), /错题/);
  await assert.rejects(service.call('review.start', { mode: 'path', course: 'B', daily: true, only: 'new', size: 10 }), /新题/);
  const first = await service.call('review.start', { mode: 'path', course: 'A', daily: true });
  const second = await service.call('review.start', { mode: 'path', course: 'A', daily: true, size: 10 });
  assert.notEqual(second.id, first.id, 'a size asked for starts a round of that size');
  assert.equal(second.total, 10);
  assert.equal((await service.call('review.start', { mode: 'path', course: 'A', daily: true })).id, second.id, 'and without one, the open round is resumed as ever');
});

test('planPath: only keeps one kind, and never falls back to "ahead"', () => {
  const state = emptyState(), attempts = [];
  state.decks = [deckOf('a', 'A', { due: 3, weak: 2, fresh: 6 }, attempts)];
  const outcome = (deckId, cardId) => attempts.findLast((x) => x.deckId === deckId && x.quiz_id === cardId)?.grade;
  const now = Date.parse('2026-10-08T08:00:00Z');
  const by = (only, extra = {}) => planPath(state.decks, outcome, { now, only, ...extra });
  assert.equal(by('due').size, 3);
  assert.equal(by('weak').size, 2, 'weak is the level of a wrong answer');
  assert.equal(by('new', { limit: 4 }).size, 4, 'new is capped by the limit, not by the new share');
  assert.equal(by(undefined).size, 3 + 2 + 6, 'no only: the day as before');
  const empty = planPath([deckOf('z', 'Z', { due: 2 }, [])], () => undefined, { now, only: 'weak' });
  assert.equal(empty.size, 0);
  assert.equal(empty.ahead, false, 'an empty range is empty, not "ahead"');
});

/* ── what is remembered per course, and what 设为默认 writes ── */

test('lastRounds: a validated, per-course optional key of the practice settings; null takes a course away', () => {
  const choice = { size: 10, range: 'wrong', chapter: { deckId: 'a', topic: 'T' } };
  const merged = mergePracticeSettings(undefined, { lastRounds: { A: choice } });
  assert.deepEqual(merged.lastRounds, { A: choice });
  const more = mergePracticeSettings(merged, { lastRounds: { '': { size: 30, range: 'mixed' } } });
  assert.deepEqual(more.lastRounds, { A: choice, '': { size: 30, range: 'mixed' } }, 'a second course does not replace the first');
  assert.deepEqual(mergePracticeSettings(more, { lastRounds: { A: null } }).lastRounds, { '': { size: 30, range: 'mixed' } });
  assert.equal('lastRounds' in mergePracticeSettings(merged, { lastRounds: { A: null } }), false, 'the last one gone: the key is gone');
  assert.equal('lastRounds' in mergePracticeSettings(merged, { lastRounds: null }), false);
  assert.deepEqual(mergePracticeSettings(merged, { roundSize: 30 }).lastRounds, { A: choice }, 'another setting keeps them');
  for (const bad of [{ A: { size: 4, range: 'mixed' } }, { A: { size: 10, range: 'ahead' } }, { A: { size: 10, range: 'due', chapter: { deckId: 3 } } }, { A: 'x' }, [], 'x'])
    assert.throws(() => validatePracticePatch({ lastRounds: bad }), /lastRounds/, JSON.stringify(bad));
  assert.deepEqual(normalizePracticeSettings({ lastRounds: { A: { size: 4, range: 'due' }, B: { size: 15, range: 'new' } } }).lastRounds, { B: { size: 15, range: 'new' } }, 'a corrupt entry costs only itself');
  assert.equal('lastRounds' in normalizePracticeSettings({ roundSize: 20 }), false);
  assert.equal(resolvePracticeSettings(undefined).roundSize, 20, 'the defaults are untouched');
});

test('设为默认 is settings.practice.set {roundSize}: the settings, the home and the next round read the same number', async (t) => {
  const service = await library(t);
  await service.call('settings.practice.set', { patch: { roundSize: 10 } });
  const saved = (await service.store.read()).settings.practice;
  assert.equal(resolvePracticeSettings(saved).roundSize, 10, 'what 设置 › 练习 shows');
  assert.equal(freshRoundCount(saved), roundLimits(10).newLimit, 'and what a round of new questions takes');
  await service.call('settings.practice.set', { patch: { lastRounds: { A: { size: 10, range: 'wrong' } } } });
  const kept = (await service.store.read()).settings.practice;
  assert.equal(kept.roundSize, 10, 'remembering a choice does not touch the default');
  assert.deepEqual(kept.lastRounds, { A: { size: 10, range: 'wrong' } });
  await service.call('settings.practice.reset', {});
  assert.equal('lastRounds' in resolvePracticeSettings((await service.store.read()).settings.practice), false, '恢复默认 forgets the remembered rounds too');
  const plain = await service.call('review.start', { mode: 'path', course: 'A', daily: true, fresh: true });
  assert.equal(plain.total, 20, 'and the round is the default again');
});

/* ── the popover's pure side (ui/review/round-setup.js) ── */

const today = { course: 'A', scope: [{ deckId: 'a' }], due: 6, weak: 4, new: 10, size: 20 };
const data = { settings: { practice: { roundSize: 20 } }, decks: [
  { id: 'a', title: 'Deck A', topics: [{ name: 'T' }, { name: 'Weak chapter' }] }, { id: 'b', title: 'Deck B', topics: [{ name: 'Other' }] }] };

test('never opened: the choice is the default and the args are exactly the ones the start button always sent', () => {
  const context = { course: today.course, scope: undefined, base: dailyPathArgs(today) };
  const defaults = roundDefaults(data.settings.practice, context);
  assert.deepEqual(defaults, { size: 20, range: 'mixed', chapter: null });
  assert.deepEqual(roundArgs(defaults, context, defaults), dailyPathArgs(today), 'the same review.start args');
  assert.deepEqual(roundArgs({ ...defaults }, context, defaults), dailyPathArgs(today), 'a choice put back to the defaults changes nothing either');
  const saved = { size: 10, range: 'wrong', chapter: null };
  assert.equal(sameRound(saved, defaults), false);
  assert.equal(sameRound({ ...defaults, chapter: null }, defaults), true);
  assert.deepEqual(roundChoice(data.settings.practice, context), defaults, 'nothing remembered: the defaults');
});

test('a changed choice adds only what changed (size, only) and starts fresh; a chapter always carries its size', () => {
  const context = { course: 'A', scope: undefined, base: dailyPathArgs(today) };
  const defaults = roundDefaults({}, context);
  assert.deepEqual(roundArgs({ ...defaults, size: 10, range: 'wrong' }, context, defaults), { mode: 'path', course: 'A', daily: true, fresh: true, size: 10, only: 'wrong' });
  assert.deepEqual(roundArgs({ ...defaults, range: 'due' }, context, defaults), { mode: 'path', course: 'A', daily: true, fresh: true, only: 'due' }, 'the size stays the setting\'s');
  assert.deepEqual(roundArgs({ ...defaults, size: 30 }, context, defaults), { mode: 'path', course: 'A', daily: true, fresh: true, size: 30 });
  assert.deepEqual(roundArgs({ ...defaults, chapter: { deckId: 'a', topic: 'T' } }, context, defaults),
    { mode: 'path', scope: [{ deckId: 'a', topic: 'T' }], fresh: true, size: 20 }, 'a chapter replaces the daily course round and names its size');
  const scoped = { course: undefined, scope: [{ deckId: 'a', cardId: 'c1' }], base: { mode: 'path', scope: [{ deckId: 'a', cardId: 'c1' }], fresh: true } };
  assert.deepEqual(roundArgs({ ...defaults, size: 10 }, scoped, defaults), { mode: 'path', scope: [{ deckId: 'a', cardId: 'c1' }], fresh: true, size: 10 });
  // Whatever the popover builds, review.start takes: the size is inside the bounds.
  for (const size of [ROUND_SIZE_LIMITS.min, ROUND_SIZE_LIMITS.max]) assert.equal(roundArgs({ ...defaults, size }, context, defaults).size, size);
});

test('what was chosen last in a course prefills the popover; other courses and corrupt entries do not', () => {
  const lastRounds = { A: { size: 10, range: 'wrong', chapter: { deckId: 'a', topic: 'T' } }, B: { size: 3, range: 'due' } };
  const practice = { roundSize: 25, lastRounds };
  const context = { course: 'A', scope: undefined, base: {} };
  assert.deepEqual(roundChoice(practice, context, data), { size: 10, range: 'wrong', chapter: { deckId: 'a', topic: 'T' } });
  assert.deepEqual(roundDefaults(practice, context), { size: 25, range: 'mixed', chapter: null }, 'the defaults stay the settings\'');
  assert.deepEqual(roundChoice(practice, { course: 'B', scope: undefined, base: {} }, data), { size: 25, range: 'mixed', chapter: null }, 'B\'s entry is corrupt (size 3): the defaults');
  assert.deepEqual(roundChoice(practice, { course: 'C', scope: undefined, base: {} }, data), { size: 25, range: 'mixed', chapter: null });
  // A chapter that is gone (the deck was deleted, the topic renamed) is dropped, the rest stays.
  assert.deepEqual(roundChoice({ lastRounds: { A: { size: 10, range: 'due', chapter: { deckId: 'a', topic: 'Gone' } } } }, context, data), { size: 10, range: 'due', chapter: null });
  assert.equal(roundKey('A'), 'A');
  assert.equal(roundKey(undefined), '', 'every active course is one entry too');
});

test('the chapters offered are the topics of the decks in the round\'s scope', () => {
  assert.deepEqual(chaptersOf(data, [{ deckId: 'a' }]).map((item) => item.label), ['T', 'Weak chapter']);
  assert.deepEqual(chaptersOf(data, [{ deckId: 'a' }, { deckId: 'b' }]).map((item) => item.label), ['Deck A · T', 'Deck A · Weak chapter', 'Deck B · Other'], 'several decks: the deck is named');
  assert.deepEqual(chaptersOf(data, []), [], 'every active course: no chapter list');
  assert.deepEqual(chaptersOf(data, [{ deckId: 'a', cardId: 'c1' }]).map((item) => item.label), ['T', 'Weak chapter']);
  assert.deepEqual(chaptersOf(data, [{ deckId: 'gone' }]), []);
});

test('the result page offers the popover where the next-round button starts a round of the course or of the scope, and nowhere else', () => {
  const run = (extra) => ({ complete: true, mode: 'path', scope: [{ deckId: 'a' }], ...extra });
  assert.deepEqual(resultTarget(run({ dailyCourse: 'A' }), { kind: 'path', course: 'A' }), { course: 'A', scope: undefined, range: undefined });
  assert.deepEqual(resultTarget(run({}), { kind: 'scope', scope: [{ deckId: 'a' }] }), { course: undefined, scope: [{ deckId: 'a' }], range: undefined });
  assert.deepEqual(resultTarget(run({ mode: 'new' }), { kind: 'scope', scope: [{ deckId: 'a' }] }), { course: undefined, scope: [{ deckId: 'a' }], range: 'new' }, 'after a round of new ones the range starts on 新题');
  assert.deepEqual(resultTarget(run({}), { kind: 'path', reason: 'scope-done' }), { course: undefined, scope: undefined, range: undefined }, 'every active course');
  for (const [name, r, destination] of [
    ['an exam', run({ mode: 'exam' }), { kind: 'scope', scope: [] }],
    ['a round from the reader', run({ reading: { sourceId: 's' } }), { kind: 'scope', scope: [] }],
    ['a detour back to the question', run({ returnTo: 'r0' }), { kind: 'original', runId: 'r0' }],
    ['the original question', run({}), { kind: 'original', runId: 'r0' }],
    ['a plan task', run({}), { kind: 'plan', taskId: 't' }],
    ['a learning flow', run({ workflow: { sessionId: 'w' } }), { kind: 'scope', scope: [] }],
    ['an open round', { ...run({}), complete: false }, { kind: 'scope', scope: [] }],
    ['a course batch', run({ mode: 'course' }), { kind: 'path' }],
    ['no destination', run({}), undefined],
  ]) assert.equal(resultTarget(r, destination), null, name);
});
