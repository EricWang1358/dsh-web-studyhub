import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { courseStatus, activeDecks, deckIsActive, inactiveSummary } from '../lib/course-active.js';
import { learningScope } from '../lib/learning-scope.js';
import { decksInCourse } from '../lib/focus.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { publishNotebook, listNotebooks } from '../lib/notebooks.js';

/* "有效课程": a course the learner is not studying any more can be parked. Inactive courses stay out of everything that
   pushes review work (due counts, forecast, queue, recommendations, wrong book, exam pool) until they are activated again,
   and nothing about their cards, runs, attempts or schedules ever changes. Courses are paths (lib/course-tree.js): a chapter
   inherits its parent's state unless the learner set the chapter itself. */

const P = 'Cloud Native Solution Design';
const C05 = `${P} / 05 Kubernetes`;
const C07 = `${P} / 07 Microservices`;
const record = (name, active) => ({ id: `course-${Buffer.from(name).toString('hex').slice(0, 12)}`, name, aliases: [], guidanceSourceIds: [], focusTopics: [], ...(active === undefined ? {} : { active }) });
const deck = (id, course) => ({ id, title: id, course, cards: [] });

test('rules: default active, uncategorised always active, an explicit setting wins, children inherit and may override', () => {
  const state = { decks: [deck('p', P), deck('a', C05), deck('b', C07), deck('free', ''), deck('x', 'Other')], courses: [record(P, false), record(C07, true)] };
  assert.deepEqual(courseStatus(state, 'Other'), { active: true, explicit: undefined, by: null }, 'default is active');
  assert.equal(courseStatus(state, '').active, true, 'a deck outside any course is always active');
  assert.deepEqual(courseStatus(state, P), { active: false, explicit: false, by: P });
  assert.deepEqual(courseStatus(state, C05), { active: false, explicit: undefined, by: P }, 'a chapter inherits the parked parent');
  assert.deepEqual(courseStatus(state, C07), { active: true, explicit: true, by: C07 }, 'a chapter set active keeps itself alive');
  assert.deepEqual(activeDecks(state).map(item => item.id), ['b', 'free', 'x']);
  assert.deepEqual(activeDecks(state, { includeInactive: true }).map(item => item.id), ['p', 'a', 'b', 'free', 'x']);
  assert.equal(deckIsActive(state)(state.decks[0]), false);
});

test('rules: a missing courses list or record changes nothing; the nearest setting wins; spelling and aliases do not matter', () => {
  assert.equal(courseStatus({ decks: [deck('a', 'X')] }, 'X').active, true);
  assert.deepEqual(activeDecks({ decks: [deck('a', 'X')] }).map(item => item.id), ['a']);
  const nested = { decks: [], courses: [record('A', false), record('A / B', true), record('A / B / C', false)] };
  assert.equal(courseStatus(nested, 'A / B').active, true);
  assert.equal(courseStatus(nested, 'A / B / C').active, false, 'the nearest explicit setting wins');
  assert.equal(courseStatus(nested, 'A / B / D').active, true, 'a sibling below the active chapter inherits it');
  assert.deepEqual(courseStatus(nested, 'A / B / D'), { active: true, explicit: undefined, by: 'A / B' });
  const spaced = { decks: [deck('a', `${P}/05 Kubernetes`)], courses: [record(P, false), record(`${P}/05 Kubernetes`)] };
  assert.equal(courseStatus(spaced, `${P}/05 Kubernetes`).active, false, 'an unspaced slash after a known course is a child');
  assert.equal(courseStatus({ decks: [], courses: [record('TCP/IP', false)] }, 'TCP/IP').active, false);
  assert.equal(courseStatus({ decks: [], courses: [record('TCP/IP', false)] }, 'TCP').active, true, 'a name that merely starts with another is not a child');
  const renamed = { decks: [{ ...deck('d', 'Old name') }], courses: [{ ...record('New name', false), aliases: ['Old name'] }] };
  assert.equal(deckIsActive(renamed)(renamed.decks[0]), false, 'a deck still filed under an alias follows its course');
  assert.equal(deckIsActive({ decks: [], courses: [record('X', false)] })({ id: 's', systemKind: 'coach', cards: [] }), true, 'system decks belong to no course');
});

test('rules: the scope of a learning page leaves inactive decks out unless it names the course on purpose', () => {
  const state = { decks: [deck('p', P), deck('a', C05), deck('b', C07), deck('x', 'Other')], courses: [record(P, false), record(C07, true)], attempts: [] };
  const scope = args => learningScope(state, args);
  assert.deepEqual([...scope({}).excluded].sort(), ['a', 'p'], 'all courses = every active course');
  assert.equal(scope({}).matches('p', { id: 'c' }), false);
  assert.equal(scope({ course: '*' }).all, true);
  assert.deepEqual([...scope({ includeInactive: true }).excluded], [], 'the learner can show them for a page view');
  assert.deepEqual(scope({ course: P }).scope.map(ref => ref.deckId).sort(), ['a', 'b', 'p'], 'choosing the inactive course reads it, and what is inside it');
  assert.deepEqual(scope({ course: C05 }).scope.map(ref => ref.deckId), ['a']);
  assert.deepEqual(scope({ course: 'Other' }).scope.map(ref => ref.deckId), ['x']);
  assert.deepEqual(scope({ scope: [{ deckId: 'p' }] }).scope.map(ref => ref.deckId), ['p'], 'an explicit deck is an explicit choice');
  assert.deepEqual(decksInCourse(state, P).map(item => item.id), ['p', 'a', 'b']);
  const live = { decks: [deck('p', P), deck('a', `${P} / 03 Old`), deck('b', C07)], courses: [record(`${P} / 03 Old`, false)] };
  assert.deepEqual(decksInCourse(live, P).map(item => item.id), ['p', 'b'], 'a chapter parked inside an active course stays out of the parent scope');
  assert.deepEqual(decksInCourse(live, P, { includeInactive: true }).map(item => item.id), ['p', 'a', 'b']);
});

test('the summary counts what is left out, from the same rule', () => {
  const due = Date.now() - 3 * 86400000, review = { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: new Date(due).toISOString() };
  const card = id => ({ id, kind: 'flashcard', topic: 't', prompt: id, answer: 'a', review });
  const state = { decks: [{ ...deck('p', P), cards: [card('1'), card('2'), { ...card('3'), suspended: true }] }, { ...deck('a', C05), cards: [card('4')] }, { ...deck('x', 'Other'), cards: [card('5')] }, { ...deck('gone', C07), archived: true, cards: [card('6')] }],
    courses: [record(P, false)], attempts: [] };
  const summary = inactiveSummary(state);
  assert.deepEqual([summary.courses, summary.decks, summary.due, summary.overdue], [2, 2, 3, 3], 'two inactive courses hold 2 decks; suspended and archived cards do not count');
  assert.deepEqual(inactiveSummary({ decks: [deck('x', 'X')], courses: [] }), { courses: 0, decks: 0, due: 0, overdue: 0 });
});

/* ------------------------------ through the service ------------------------------ */

const day = n => new Date(Date.now() + n * 86400000).toISOString();
const review = (due, repetitions = 2) => ({ repetitions, interval_days: 6, ease_factor: 2.5, due_at: due });
const card = (id, patch = {}) => ({ id, kind: 'quiz', topic: `${id}-topic`, prompt: `${id}?`, answer: 'a', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }], ...patch });
const many = (prefix, n, patch) => Array.from({ length: n }, (_, i) => card(`${prefix}${i + 1}`, patch(i)));

/* The learner's old term (Cloud: 22 due, 3 weak) next to the current one (Databases: 9 due, 4 new, 2 weak). */
function fill(state, { old = true } = {}) {
  const attempt = (d, c, grade, extra = {}) => ({ id: `${d}-${c}-${grade}`, deckId: d, quiz_id: c, grade, timestamp: day(-1), assessment: 'graded', ...extra });
  if (old) {
    state.decks.push({ id: 'old1', title: 'Cloud 1', course: 'Cloud', createdAt: '2026-02-01', cards: many('o', 15, i => ({ review: review(day(-10 - i)) })) },
      { id: 'old2', title: 'Cloud 2', course: 'Cloud', createdAt: '2026-02-02', cards: [...many('p', 7, i => ({ review: review(day(-2 - i)) })), ...many('w', 3, () => ({ review: review(day(1)) })), card('later1', { review: review(day(5)) })] });
    for (const c of state.decks.find(d => d.id === 'old1').cards) state.attempts.push(attempt('old1', c.id, 4));
    for (const c of state.decks.find(d => d.id === 'old2').cards) state.attempts.push(attempt('old2', c.id, c.id.startsWith('w') ? 1 : 4));
  }
  state.decks.push({ id: 'cur1', title: 'Databases 1', course: 'Databases', createdAt: '2026-09-20', cards: [...many('d', 9, i => ({ review: review(i < 2 ? day(-3) : day(0.1 + i)) })), ...many('n', 4, () => ({ review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } })), ...many('v', 2, () => ({ review: review(day(2)) }))] },
    { id: 'free', title: 'Loose', course: '', createdAt: '2026-09-21', cards: many('f', 2, () => ({ review: review(day(-1)) })) });
  for (const c of state.decks.find(d => d.id === 'cur1').cards) if (!c.id.startsWith('n')) state.attempts.push(attempt('cur1', c.id, c.id.startsWith('v') ? 1 : 4));
}
const make = async (t, options) => {
  const root = await mkdtemp(join(tmpdir(), 'study-active-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update(state => fill(state, options));
  return service;
};
const cardIds = run => run.navigation.map(item => `${item.deckId}:${item.cardId}`);

test('the course list carries each course\'s state and the due numbers an activation changes', async t => {
  const service = await make(t);
  const before = (await service.call('course.list')).courses.find(course => course.name === 'Cloud');
  assert.equal(before.active, true, 'courses are active by default');
  const result = await service.call('course.deactivate', { name: 'Cloud' });
  assert.deepEqual([result.active, result.changed, result.decks, result.due, result.overdue], [false, true, 2, 22, 22], 'the deactivation says how much it takes out of the review');
  assert.deepEqual(result.subCourses, []);
  const after = (await service.call('course.list')).courses.find(course => course.name === 'Cloud');
  assert.deepEqual([after.active, after.explicit], [false, false]);
  const again = await service.call('course.deactivate', { name: 'Cloud' });
  assert.deepEqual([again.changed, again.decks, again.due], [false, 0, 0], 'deactivating twice changes nothing');
  const back = await service.call('course.activate', { id: after.id });
  assert.deepEqual([back.active, back.changed, back.decks, back.due, back.overdue], [true, true, 2, 22, 22], 'activation reports what is due again');
  assert.equal((await service.call('course.activate', { name: 'Cloud' })).changed, false);
  assert.equal((await service.call('course.setActive', { name: 'Cloud', active: false })).active, false);
  await assert.rejects(() => service.call('course.setActive', { name: 'Cloud', active: 'no' }), /有效|active/i);
  await assert.rejects(() => service.call('course.deactivate', { name: 'Nothing' }), /课程不存在/);
});

test('with the old course parked, due counts, forecast, queue and suggestions equal a library that never had it', async t => {
  const parked = await make(t), twin = await make(t, { old: false });
  const baseline = await twin.call('stats', { course: '*' });
  const all = await parked.call('stats', { course: '*' });
  assert.equal(all.totals.due - baseline.totals.due, 22, 'before parking the old course counts');
  await parked.call('course.deactivate', { name: 'Cloud' });
  const hidden = await parked.call('stats', { course: '*' });
  for (const field of ['cards', 'due', 'mastered', 'weak']) assert.equal(hidden.totals[field], baseline.totals[field], `totals.${field}`);
  assert.deepEqual(hidden.forecast.days.map(day => [day.count, day.overdue]), baseline.forecast.days.map(day => [day.count, day.overdue]), '14-day forecast');
  assert.equal(hidden.forecast.later, baseline.forecast.later);
  assert.deepEqual(hidden.weakTopics.map(item => item.deckId), baseline.weakTopics.map(item => item.deckId), 'weak-topic suggestions');
  assert.ok(hidden.totals.attempts > baseline.totals.attempts, 'what the learner already did stays in the history');
  assert.deepEqual(hidden.inactive, { courses: 1, decks: 2, due: 22, overdue: 22, included: false }, 'the page can say what it leaves out');
  assert.deepEqual(hidden.forecast.hidden, { today: 22, count: 22 + 3 + 1, later: 0 }, 'the forecast card can say what is parked');

  const [mapParked, mapTwin] = [await parked.call('map'), await twin.call('map')];
  assert.deepEqual(mapParked.today, mapTwin.today, 'today\'s plan');
  assert.deepEqual(mapParked.next, mapTwin.next, 'the recommended next topic');
  const wrongParked = await parked.call('wrongbook', { course: '*' }), wrongTwin = await twin.call('wrongbook', { course: '*' });
  assert.deepEqual(wrongParked.items.map(item => item.cardId), wrongTwin.items.map(item => item.cardId), 'wrong book');
  assert.equal(wrongParked.total, 2);
  const recParked = await parked.call('wrongbook.recommend', { course: '*' }), recTwin = await twin.call('wrongbook.recommend', { course: '*' });
  assert.deepEqual(recParked.items.map(item => item.deckId), recTwin.items.map(item => item.deckId), 'recommended similar questions');

  const queueParked = await parked.call('review.start', { mode: 'path', fresh: true }), queueTwin = await twin.call('review.start', { mode: 'path', fresh: true });
  assert.deepEqual(cardIds(queueParked), cardIds(queueTwin), 'the default review queue');
  assert.equal(cardIds(queueParked).some(id => id.startsWith('old')), false);
  const fresh = await parked.call('review.start', { mode: 'path', scope: [], fresh: true });
  assert.deepEqual(cardIds(fresh), cardIds(queueTwin), 'an empty scope still means all active courses');
  const exam = await parked.call('review.start', { mode: 'exam', count: 40, fresh: true });
  const examDecks = (await parked.call('export')).runs.find(run => run.id === exam.id).entries.map(entry => entry.deckId);
  assert.ok(examDecks.length > 0 && examDecks.every(id => !id.startsWith('old')), 'the exam pool leaves the old course out');
  const graph = await parked.call('graph', { mode: 'path' });
  assert.equal(graph.nodes.some(node => node.deckId?.startsWith('old')), false, 'the path graph too');
  const snapshot = await parked.call('snapshot');
  assert.equal(snapshot.today.due, mapTwin.today.due, 'the snapshot desk counts the same');
  assert.equal(snapshot.inactive.due, 22);
  assert.equal(snapshot.inactive.courses, 1);
});

test('choosing the parked course, or showing parked courses for a page view, still works', async t => {
  const service = await make(t);
  await service.call('course.deactivate', { name: 'Cloud' });
  const own = await service.call('stats', { course: 'Cloud' });
  assert.equal(own.totals.due, 22, 'an explicit pick reads the course');
  assert.equal(own.inactive.included, true, 'nothing is left out of a course the learner picked');
  const shown = await service.call('stats', { course: '*', includeInactive: true });
  assert.equal(shown.totals.due, 22 + 4, 'all courses, parked ones included on request');
  assert.equal(shown.inactive.included, true);
  assert.equal((await service.call('wrongbook', { course: 'Cloud' })).total, 3);
  assert.equal((await service.call('wrongbook', { course: '*', includeInactive: true })).total, 5);
  const queue = await service.call('review.start', { mode: 'path', course: 'Cloud', fresh: true });
  assert.ok(queue.total > 0 && cardIds(queue).every(id => id.startsWith('old')), 'an explicit review of the parked course');
  const deck = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'old1' }], fresh: true });
  assert.equal(deck.total, 15);
  const everything = await service.call('review.start', { mode: 'path', includeInactive: true, fresh: true });
  assert.ok(cardIds(everything).some(id => id.startsWith('old')));
  const route = await service.call('course.route', { course: 'Cloud' });
  assert.equal(route.chapters.length, 2, 'the route of the parked course reads');
});

test('decks outside any course are never parked; parking every course says so instead of an empty queue', async t => {
  const service = await make(t);
  for (const name of ['Cloud', 'Databases']) await service.call('course.deactivate', { name });
  const queue = await service.call('review.start', { mode: 'path', fresh: true });
  assert.deepEqual([...new Set(cardIds(queue).map(id => id.split(':')[0]))], ['free'], 'the loose deck still has its due cards');
  const only = await make(t, { old: false });
  await only.store.update(state => { state.decks = state.decks.filter(deck => deck.id !== 'free'); });
  await only.call('course.deactivate', { name: 'Databases' });
  await assert.rejects(() => only.call('review.start', { mode: 'path', fresh: true }), /未激活|inactive/i);
});

test('a parent takes its chapters with it unless the learner keeps some', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-active-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const old = id => ({ repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: day(-4), id });
  await service.store.update(state => state.decks.push(
    { id: 'p', title: 'p', course: P, cards: [card('p1', { review: old() })] }, { id: 'a', title: 'a', course: C05, cards: [card('a1', { review: old() }), card('a2', { review: old() })] },
    { id: 'b', title: 'b', course: C07, cards: [card('b1', { review: old() })] }, { id: 'o', title: 'o', course: 'Other', cards: [card('o1', { review: old() })] }));
  const result = await service.call('course.deactivate', { name: P });
  assert.deepEqual([result.decks, result.due, result.subCourses.sort()], [3, 4, [C05, C07].sort()], 'it says how many sub-courses it takes with it');
  const state = async name => (await service.call('course.list')).courses.find(course => course.name === name);
  assert.equal((await state(C05)).active, false, 'a chapter is inactive through its parent');
  assert.equal((await state(C05)).explicit, undefined);
  assert.equal((await state(C05)).inactiveBy, P, 'and the list says which parent parks it');
  const keep = await service.call('course.activate', { name: C07 });
  assert.deepEqual([keep.changed, keep.decks, keep.due], [true, 1, 1], 'chapter 07 stays alive inside a parked parent');
  assert.equal((await service.call('stats', { course: '*' })).totals.due, 2, 'Other + chapter 07');
  await service.call('course.activate', { name: P });
  assert.equal((await service.call('stats', { course: '*' })).totals.due, 5);
  assert.equal((await state(P)).explicit, undefined);
  const spare = await service.call('course.deactivate', { name: P, withSubCourses: false });
  assert.deepEqual([spare.decks, spare.due, spare.subCourses], [1, 1, []], 'parking only the parent keeps the chapters going');
  assert.equal((await service.call('stats', { course: '*' })).totals.due, 4);
  const after = (await service.call('course.list')).courses;
  assert.equal(after.find(course => course.name === C05).active, true);
  assert.equal(after.find(course => course.name === P).active, false);
  const implicit = await service.call('course.deactivate', { name: 'Lone / ch 1' }).catch(error => error);
  assert.match(String(implicit.message || ''), /课程不存在|Course not found/, 'a name no deck, source or record has is not a course');
});

test('parking and re-activating changes nothing else: cards, runs, attempts, schedules and sources stay byte for byte', async t => {
  const service = await make(t);
  await service.call('review.start', { mode: 'path', fresh: true });
  await service.call('review.start', { mode: 'path', course: 'Cloud', fresh: true });
  const keep = async () => { const state = await service.call('export'); return JSON.stringify({ decks: state.decks, attempts: state.attempts, runs: state.runs, sources: state.sources, drafts: state.drafts, focus: state.focus }); };
  const before = await keep();
  await service.call('course.deactivate', { name: 'Cloud' });
  assert.equal(await keep(), before, 'while parked');
  await service.call('course.activate', { name: 'Cloud' });
  assert.equal(await keep(), before, 'after the round trip');
  const stored = (await service.call('export')).courses.find(course => course.name === 'Cloud');
  assert.equal('active' in stored, false, 'the default (active) leaves no trace on the course record');
});

test('old libraries and the current course: no field, no change; the current course may be parked and keeps working', async t => {
  const service = await make(t);
  const snapshot = await service.call('snapshot');
  assert.ok(snapshot.focus.courses.every(course => course.active === true));
  assert.deepEqual(snapshot.inactive, { courses: 0, decks: 0, due: 0, overdue: 0 });
  await service.call('focus.set', { course: 'Cloud' });
  const result = await service.call('course.deactivate', { name: 'Cloud' });
  assert.equal(result.current, true, 'the result says it is the current course');
  const parked = await service.call('snapshot');
  assert.equal(parked.focus.course, 'Cloud', 'the focus is the learner\'s own choice and does not move by itself');
  assert.equal(parked.focus.courses.find(course => course.name === 'Cloud').active, false);
  assert.equal(parked.focus.route.chapters.length, 2, 'its route still reads');
  const course = await service.call('course.activate', { name: 'Cloud' });
  assert.equal(course.current, true);
});

test('the actions are contracts of the courses context', () => {
  for (const name of ['course.setActive', 'course.activate', 'course.deactivate']) assert.deepEqual(writesFor('courses', name), ['courses'], name);
});

test('the snapshot flags parked decks, their progress rows and a half-done run, so the desk does not offer it as 接着做', async t => {
  const service = await make(t);
  const run = await service.call('review.start', { mode: 'path', course: 'Cloud', fresh: true });
  assert.equal((await service.call('snapshot')).lastRun.inactive, undefined, 'while the course counts, nothing is flagged');
  await service.call('course.deactivate', { name: 'Cloud' });
  const snapshot = await service.call('snapshot');
  assert.deepEqual(snapshot.decks.filter(deck => deck.inactive).map(deck => deck.id).sort(), ['old1', 'old2']);
  assert.equal(snapshot.progress.old1.inactive, true);
  assert.equal(snapshot.progress.cur1.inactive, undefined);
  assert.equal(snapshot.runs.find(item => item.id === run.id).inactive, true);
  assert.equal(snapshot.lastRun.inactive, true);
  assert.equal(snapshot.focus.courses.find(course => course.name === 'Cloud').active, false);
  assert.equal(snapshot.courses.find(course => course.name === 'Cloud').active, false);
  assert.equal(snapshot.focus.courses.find(course => course.name === 'Databases').active, true);
});

test('the course the learner has not chosen yet defaults to the first one that is not parked', async t => {
  const service = await make(t);
  await service.store.update(state => { delete state.focus; });
  const first = (await service.call('snapshot')).focus.course;
  await service.call('course.deactivate', { name: first });
  const next = (await service.call('snapshot')).focus.course;
  assert.notEqual(next, first, 'a parked course is not picked for the learner');
  assert.notEqual(next, null);
});

test('the global notebook list leaves parked courses out of "due today" and marks their decks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-active-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const root = join(home, 'library');
  const service = new StudyService(root);
  await service.store.update(state => fill(state));
  await publishNotebook(root, root);
  const before = (await listNotebooks(root)).notebooks[0];
  await service.call('course.deactivate', { name: 'Cloud' });
  const after = (await listNotebooks(root)).notebooks[0];
  assert.equal(before.dueToday - after.dueToday, 22);
  assert.deepEqual(after.decks.filter(deck => deck.inactive).map(deck => deck.id).sort(), ['old1', 'old2']);
});

test('the oral mock leaves parked courses out of its default pool and still reads a parked course picked on purpose', async t => {
  const service = await make(t);
  await service.call('course.deactivate', { name: 'Cloud' });
  const all = await service.call('oral.start', { count: 10 });
  const stored = (await service.call('export')).oralRuns.find(run => run.id === all.id);
  assert.ok(stored.entries.length > 0 && stored.entries.every(entry => !entry.deckId.startsWith('old')), 'the default pool is the active courses');
  const picked = await service.call('oral.start', { count: 3, course: 'Cloud' });
  const own = (await service.call('export')).oralRuns.find(run => run.id === picked.id);
  assert.ok(own.entries.length > 0 && own.entries.every(entry => entry.deckId.startsWith('old')), 'the parked course read on purpose');
});
