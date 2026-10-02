import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { NONE_KEY, buildCourseRequest, courseCandidates, pickCourse, suggestCourses, SAMPLE_TITLES } from '../lib/jev-course-suggest.js';
import { sourcesWithCourses } from '../lib/source-courses.js';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 课程归属建议 (source -> course) with Jev: one `choice` question per source over the learner's course names. The answer is a
   signal: it fills a suggestion in only above the learner's threshold, and nothing is ever applied without the existing apply button. */

const han = /[㐀-鿿]/;
const state = (sources, decks = []) => ({ sources, decks, drafts: [], courses: [] });
const source = (id, title, text, courses = []) => ({ id, title, text, courses });

/** A fake whose probabilities are decided by the title of the source. */
const byTitle = table => (name, question, stateSent) => {
  const keys = Object.keys(question.criteria), wanted = table[stateSent.title] ?? {};
  const rest = keys.filter(key => !(key in wanted)), left = 1 - Object.values(wanted).reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(keys.map(key => [key, key in wanted ? wanted[key] : rest.length ? left / rest.length : 0]));
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { type: 'choice', choice: top[0], confidence: (top[1] - 1 / keys.length) / (1 - 1 / keys.length), probabilities };
};

async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-course-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev(serverOptions);
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  t.after(async () => {
    await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  const open = () => saveJevSettings({ key: fake.key, confirm: true, enabled: true, features: { courseSuggest: true } });
  return { home, fake, runtime, open };
}

test('the options are the learner’s courses, with a few titles already filed under each, plus a way out', () => {
  const s = state([
    source('a', 'Intro to SQL', 'x', ['Databases']), source('b', 'Joins', 'x', ['Databases']), source('c', 'Normal forms', 'x', ['Databases']),
    source('d', 'Fourth', 'x', ['Databases']), source('e', 'Scheduling', 'x', ['Operating Systems']), source('f', 'Loose notes', 'x', []),
  ]);
  const candidates = courseCandidates(s);
  assert.deepEqual(candidates.map(item => item.name).sort(), ['Databases', 'Operating Systems']);
  const databases = candidates.find(item => item.name === 'Databases');
  assert.equal(databases.count, 4);
  assert.equal(databases.titles.length, SAMPLE_TITLES);
  const request = buildCourseRequest(source('z', 'New lecture', 'Transactions and locks. '.repeat(300), []), candidates);
  const question = request.questions.course;
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria).sort(), ['Databases', 'Operating Systems', NONE_KEY].sort());
  assert.match(question.criteria.Databases, /Intro to SQL/);
  assert.ok(!/Fourth/.test(question.criteria.Databases), 'only a few examples');
  assert.match(question.criteria[NONE_KEY], /none|No listed/i);
  assert.match(question.instructions, /course/i);
});

test('a parent nobody filed anything under is still an option, so "sure it is Design, not sure which chapter" has somewhere to land', () => {
  const s = state([source('a', 'k8s', 'x', ['Design / 05 Kubernetes']), source('b', 'istio', 'x', ['Design / 06 Istio'])]);
  const candidates = courseCandidates(s);
  assert.deepEqual(candidates.map(item => item.name).sort(), ['Design', 'Design / 05 Kubernetes', 'Design / 06 Istio']);
  assert.equal(candidates.find(item => item.name === 'Design').count, 0);
  const criteria = buildCourseRequest(source('z', 'Mesh', 'x', []), candidates).questions.course.criteria;
  assert.match(criteria.Design, /parent course/);
});

test('only a title and a short excerpt are sent, never the whole text', () => {
  const long = 'Transactions and locks. '.repeat(500);
  const request = buildCourseRequest(source('z', 'New lecture', long, []), [{ name: 'Databases', count: 1, titles: [] }]);
  assert.equal(request.state.title, 'New lecture');
  assert.ok(request.state.excerpt.length <= 1000, String(request.state.excerpt.length));
  assert.ok(long.length > 10000);
  assert.deepEqual(Object.keys(request.state).sort(), ['excerpt', 'title']);
  assert.ok(!JSON.stringify(request).includes(long.slice(0, 2000)));
});

test('at most 255 options: the busiest courses are kept and one slot is always left for "none of these"', () => {
  const sources = Array.from({ length: 300 }, (_, index) => source(`s${index}`, `T${index}`, 'x', [`Course ${String(index).padStart(3, '0')}`]));
  sources.push(...Array.from({ length: 5 }, (_, index) => source(`extra${index}`, 'More', 'x', ['Course 299'])));
  const candidates = courseCandidates(state(sources));
  assert.equal(candidates.length, 254);
  assert.ok(candidates.some(item => item.name === 'Course 299'), 'a busy course survives the cut');
  const question = buildCourseRequest(source('z', 'New', 'x', []), candidates).questions.course;
  assert.equal(Object.keys(question.criteria).length, 255);
});

test('picking a course: the most specific one whose subtree holds enough probability, never a mere name prefix', () => {
  const courses = ['Design', 'Design / 05 Kubernetes', 'Design / 06 Istio', 'Designing for people'];
  const pick = (probabilities, threshold = 0.8) => pickCourse(probabilities, courses, { threshold });
  // A clear chapter wins on its own.
  assert.deepEqual(pick({ 'Design / 05 Kubernetes': 0.85, 'Design / 06 Istio': 0.05, Design: 0.05, [NONE_KEY]: 0.05 }), { course: 'Design / 05 Kubernetes', probability: 0.85, own: 0.85, viaParent: false });
  // Unsure between two chapters, but sure it is in "Design": the parent is offered.
  const parent = pick({ 'Design / 05 Kubernetes': 0.45, 'Design / 06 Istio': 0.4, Design: 0.05, [NONE_KEY]: 0.1 });
  assert.equal(parent.course, 'Design');
  assert.equal(parent.viaParent, true);
  assert.ok(Math.abs(parent.probability - 0.9) < 1e-9);
  // "Designing for people" is a different course, not inside "Design".
  assert.equal(pick({ 'Designing for people': 0.6, 'Design / 05 Kubernetes': 0.3, [NONE_KEY]: 0.1 }), null);
  // The boundary counts as enough; just below does not.
  assert.equal(pick({ Design: 0.8, [NONE_KEY]: 0.2 }).course, 'Design');
  assert.equal(pick({ Design: 0.79, [NONE_KEY]: 0.21 }), null);
  // "None of these" is never a pick.
  assert.equal(pick({ [NONE_KEY]: 0.95, Design: 0.05 }), null);
  // The threshold is the learner's to move.
  assert.equal(pick({ Design: 0.7, [NONE_KEY]: 0.3 }, 0.6).course, 'Design');
  assert.equal(pick({ Design: 0.85, [NONE_KEY]: 0.15 }, 0.9), null);
});

test('a name with a slash that is not a hierarchy stays one course', () => {
  const courses = ['TCP/IP', 'Networks'];
  assert.equal(pickCourse({ 'TCP/IP': 0.9, Networks: 0.1 }, courses, { threshold: 0.8 }).course, 'TCP/IP');
  assert.equal(pickCourse({ 'TCP/IP': 0.5, Networks: 0.5 }, courses, { threshold: 0.8 }), null, 'two sibling courses never add up to a parent');
});

test('suggestions: filled above the threshold, left alone below it, with the probabilities shown and nothing saved', async t => {
  const h = await harness(t, { answer: byTitle({
    Confident: { Databases: 0.93, 'Operating Systems': 0.04, [NONE_KEY]: 0.03 },
    Unsure: { Databases: 0.55, 'Operating Systems': 0.4, [NONE_KEY]: 0.05 },
    Edge: { Databases: 0.8, 'Operating Systems': 0.2 },
  }) });
  await h.open();
  const s = state([source('k', 'Confident', 'text', []), source('u', 'Unsure', 'text', ['Operating Systems']), source('e', 'Edge', 'text', []),
    source('x', 'Anchor DB', 'x', ['Databases']), source('y', 'Anchor OS', 'x', ['Operating Systems'])]);
  const before = JSON.stringify(s);
  const result = await suggestCourses({ runtime: h.runtime, state: s, sources: sourcesWithCourses(s).filter(item => ['k', 'u', 'e'].includes(item.id)), threshold: 0.8, language: 'en' });
  assert.equal(result.unavailable, undefined);
  const byId = Object.fromEntries(result.proposals.map(item => [item.id, item]));
  assert.deepEqual(byId.k.courses, ['Databases']);
  assert.equal(byId.k.jev.filled, true);
  assert.equal(byId.k.jev.probability, 0.93);
  assert.deepEqual(byId.k.jev.top.map(item => item.course), ['Databases', 'Operating Systems']);
  assert.deepEqual(byId.k.expectedCourses, []);
  assert.match(byId.k.reason, /Databases/);
  assert.match(byId.k.reason, /93%/);
  // Unsure: nothing changes for that source, the learner decides.
  assert.deepEqual(byId.u.courses, ['Operating Systems'], 'the current courses are kept, not blanked');
  assert.equal(byId.u.jev.filled, false);
  assert.equal(byId.u.jev.probability, 0.55);
  assert.match(byId.u.reason, /not sure/i);
  assert.match(byId.u.reason, /55%/);
  assert.equal(byId.e.jev.filled, true, 'exactly at the threshold counts');
  assert.equal(JSON.stringify(s), before, 'nothing was saved');
  assert.ok(result.usage.inputTokens > 0, 'the tokens it used are reported');
});

test('the reason is in the learner’s language', async t => {
  const h = await harness(t, { answer: byTitle({ A: { Databases: 0.9, [NONE_KEY]: 0.1 }, B: { Databases: 0.4, [NONE_KEY]: 0.6 } }) });
  await h.open();
  const s = state([source('a', 'A', 'x', []), source('b', 'B', 'x', []), source('d', 'Anchor', 'x', ['Databases'])]);
  const pick = sourcesWithCourses(s).filter(item => ['a', 'b'].includes(item.id));
  const zh = await suggestCourses({ runtime: h.runtime, state: s, sources: pick, threshold: 0.8, language: 'zh' });
  const en = await suggestCourses({ runtime: h.runtime, state: s, sources: pick, threshold: 0.8, language: 'en' });
  for (const item of zh.proposals) assert.ok(han.test(item.reason), item.reason);
  for (const item of en.proposals) assert.ok(!han.test(item.reason), item.reason);
});

test('a hierarchy: unsure between chapters but sure about the course, the parent is suggested', async t => {
  const h = await harness(t, { answer: byTitle({ Mesh: { 'Design / 05 Kubernetes': 0.45, 'Design / 06 Istio': 0.4, Design: 0.05, [NONE_KEY]: 0.1 } }) });
  await h.open();
  const s = state([source('m', 'Mesh', 'x', []), source('a', 'k8s', 'x', ['Design / 05 Kubernetes']), source('b', 'istio', 'x', ['Design / 06 Istio']), source('c', 'intro', 'x', ['Design'])]);
  const result = await suggestCourses({ runtime: h.runtime, state: s, sources: sourcesWithCourses(s).filter(item => item.id === 'm'), threshold: 0.8, language: 'en' });
  assert.deepEqual(result.proposals[0].courses, ['Design']);
  assert.equal(result.proposals[0].jev.viaParent, true);
  const sent = h.fake.requests[0].payload.questions.course.criteria;
  assert.match(sent['Design / 05 Kubernetes'], /chapter of "Design"/i);
  assert.match(sent.Design, /parent/i);
});

test('many sources are asked with bounded concurrency', async t => {
  let active = 0, peak = 0;
  const h = await harness(t, { delayMs: 15, onRequest: () => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; }, 15); } });
  await h.open();
  const s = state([...Array.from({ length: 12 }, (_, index) => source(`n${index}`, `N${index}`, 'x', [])), source('d', 'Anchor', 'x', ['Databases'])]);
  const result = await suggestCourses({ runtime: h.runtime, state: s, sources: sourcesWithCourses(s).filter(item => item.id.startsWith('n')), threshold: 0.8, language: 'en', concurrency: 3 });
  assert.equal(result.proposals.length, 12);
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.ok(peak >= 2, 'it did run in parallel');
});

test('the gate: without the switches nothing is sent and the result says why', async t => {
  const h = await harness(t);
  const s = state([source('a', 'A', 'x', []), source('d', 'Anchor', 'x', ['Databases'])]);
  const result = await suggestCourses({ runtime: h.runtime, state: s, sources: sourcesWithCourses(s).filter(item => item.id === 'a'), threshold: 0.8, language: 'en' });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.unavailable.reason, 'off');
  assert.equal(h.fake.requests.length, 0);
});

test('a failing Jev falls back: the breaker stops asking, the note says why, finished suggestions are kept', async t => {
  const h = await harness(t, { answer: byTitle({ A: { Databases: 0.95, [NONE_KEY]: 0.05 } }), failures: [] });
  await h.open();
  const s = state([source('a', 'A', 'x', []), ...Array.from({ length: 8 }, (_, index) => source(`n${index}`, `N${index}`, 'x', [])), source('d', 'Anchor', 'x', ['Databases'])]);
  const picked = sourcesWithCourses(s).filter(item => item.id !== 'd');
  const first = await suggestCourses({ runtime: h.runtime, state: s, sources: picked.slice(0, 1), threshold: 0.8, language: 'en' });
  assert.equal(first.proposals.length, 1);
  h.fake.fail(401);
  h.fake.requests.length = 0;
  const result = await suggestCourses({ runtime: h.runtime, state: s, sources: picked, threshold: 0.8, language: 'en', concurrency: 1 });
  assert.equal(result.unavailable.reason, 'invalid-key');
  assert.equal(h.fake.requests.length, 1, 'no point asking again after an invalid key');
  assert.deepEqual(result.proposals, []);
  // A failure that is only transient: the other sources still get answers.
  const flaky = await harness(t, { failures: [500, 500, 500] });
  await flaky.open();
  const mixed = await suggestCourses({ runtime: flaky.runtime, state: s, sources: picked.slice(0, 3), threshold: 0.8, language: 'en', concurrency: 1 });
  assert.equal(mixed.proposals.length, 2, 'the first source failed after its retries, the others were answered');
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.unavailable, undefined, 'something was answered, so it is not "unavailable"');
  assert.equal(mixed.partial.reason, 'unavailable', 'but the page can still say that one could not be judged');
  assert.equal(mixed.partial.failed, 1);
  assert.match(mixed.partial.message, /Jev/);
});

test('no courses to choose from is a plain note, not a request', async t => {
  const h = await harness(t);
  await h.open();
  const s = state([source('a', 'A', 'x', [])]);
  const result = await suggestCourses({ runtime: h.runtime, state: s, sources: sourcesWithCourses(s), threshold: 0.8, language: 'en' });
  assert.equal(result.unavailable.reason, 'no-courses');
  assert.equal(h.fake.requests.length, 0);
});

test('source.organize.jev through a service: probabilities back, nothing saved, the existing apply button still works with expectedCourses', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-organize-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-jev-organize-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer: byTitle({ 'New lecture': { Databases: 0.9, 'Operating Systems': 0.05, [NONE_KEY]: 0.05 } }) });
  const service = new StudyService(root, { jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => {
    service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  await service.store.update(s => {
    s.sources.push(source('db', 'Anchor DB', 'x', ['Databases']), source('os', 'Anchor OS', 'x', ['Operating Systems']), source('n', 'New lecture', 'Locks and transactions', []));
  });
  // Off by default: a plain note and no call.
  let result = await service.call('source.organize.jev', { sourceIds: ['n'] });
  assert.equal(result.unavailable.reason, 'off');
  assert.equal(fake.requests.length, 0);
  await service.call('jev.settings.set', { key: fake.key, confirm: true, enabled: true, features: { courseSuggest: true } });
  result = await service.call('source.organize.jev', { sourceIds: ['n'] });
  assert.equal(result.proposals[0].courses[0], 'Databases');
  assert.equal(result.proposals[0].jev.filled, true);
  assert.deepEqual(result.proposals[0].expectedCourses, []);
  assert.deepEqual((await service.call('source.get', { id: 'n' })).courses, [], 'suggesting saved nothing');
  // The learner presses the existing apply flow.
  await service.call('source.courses.set', { assignments: [{ id: 'n', courses: result.proposals[0].courses, expectedCourses: result.proposals[0].expectedCourses }] });
  assert.deepEqual((await service.call('source.get', { id: 'n' })).courses, ['Databases']);
  // The same limits as the existing suggestion.
  await assert.rejects(service.call('source.organize.jev', { sourceIds: [] }), /1–100/);
  await assert.rejects(service.call('source.organize.jev', { sourceIds: Array.from({ length: 101 }, (_, index) => `s${index}`) }), /1–100/);
  await service.call('jev.settings.set', { features: { courseSuggest: false } });
  fake.requests.length = 0;
  result = await service.call('source.organize.jev', { sourceIds: ['n'] });
  assert.equal(result.unavailable.reason, 'feature-off');
  assert.equal(fake.requests.length, 0);
});
