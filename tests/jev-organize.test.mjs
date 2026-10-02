import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { NONE_KEY } from '../lib/jev-course-suggest.js';
import { jevOrganizeHook } from '../lib/jev-hooks.js';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 请 AI 建议 (source.organize.suggest) with Jev as an optional replacement (site `courseOrganize`): Jev picks among the learner's existing
   courses for the sources it is sure about, ONE model call takes the rest. Proposals only: the learner's "确认应用建议" is still what changes
   a course. With the switch off the model call is exactly what it was and the result has the same shape. */

const han = /[㐀-鿿]/;
const byTitle = table => (name, question, stateSent) => {
  const keys = Object.keys(question.criteria), wanted = table[stateSent.title] ?? {};
  const rest = keys.filter(key => !(key in wanted)), left = Math.max(0, 1 - Object.values(wanted).reduce((a, b) => a + b, 0));
  const probabilities = Object.fromEntries(keys.map(key => [key, key in wanted ? wanted[key] : rest.length ? left / rest.length : 0]));
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { type: 'choice', choice: top[0], confidence: (top[1] - 1 / keys.length) / (1 - 1 / keys.length), probabilities };
};
const TABLE = {
  'Locks and transactions': { Databases: 0.95, 'Operating Systems': 0.03, [NONE_KEY]: 0.02 },
  'Page replacement': { 'Operating Systems': 0.9, Databases: 0.06, [NONE_KEY]: 0.04 },
  'Week 9 reading': { Databases: 0.5, 'Operating Systems': 0.4, [NONE_KEY]: 0.1 },
  'Lunch menu': { [NONE_KEY]: 0.93, Databases: 0.07 },
};
const src = (id, title, courses = []) => ({ id, title, text: `${title}. Lecture notes. `.repeat(20), courses });

async function harness(t, { fakeOptions = {}, experimental = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-organize2-home-')), root = await mkdtemp(join(tmpdir(), 'study-jev-organize2-lib-'));
  const before = Object.fromEntries(['DSH_HOME', 'JEV_API_KEY', 'JEV_BASE_URL'].map(name => [name, process.env[name]]));
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer: byTitle(TABLE), ...fakeOptions });
  const modelCalls = [];
  const complete = async (system, prompt) => {
    modelCalls.push({ system, prompt });
    const ids = JSON.parse(prompt).sources.map(entry => entry.id);
    return JSON.stringify({ proposals: ids.map(id => ({ id, courses: ['Model course'], reason: `model reason for ${id}` })) });
  };
  const service = new StudyService(root, { complete, language: 'en', jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => {
    service.dispose(); await fake.close();
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  await service.store.update(state => {
    state.sources.push(src('db', 'Anchor DB', ['Databases']), src('os', 'Anchor OS', ['Operating Systems']),
      src('a', 'Locks and transactions'), src('b', 'Page replacement'), src('c', 'Week 9 reading'), src('d', 'Lunch menu'));
  });
  if (experimental) await service.call('experimental.set', { enabled: true });
  const turnOn = (extra = {}) => service.call('jev.settings.set', { key: fake.key, confirm: true, enabled: true, replace: { courseOrganize: true }, ...extra });
  return { service, fake, modelCalls, turnOn, call: (action, args) => service.call(action, args), courses: async id => (await service.call('source.get', { id })).courses };
}
const askedIds = call => JSON.parse(call.prompt).sources.map(entry => entry.id);

test('off: the model call and the result are exactly what they were; no Jev request, no trace in the answer', async t => {
  const h = await harness(t);
  const baseline = await h.call('source.organize.suggest', { sourceIds: ['a', 'b', 'c', 'd'] });
  const calls = h.modelCalls.map(call => [call.system, call.prompt]);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(baseline), ['proposals']);
  assert.ok(baseline.proposals.every(proposal => proposal.decidedBy === undefined && proposal.jev === undefined));
  // Every way of being off: switches missing, master off, hidden experimental features.
  const hidden = await harness(t, { experimental: false });
  await hidden.turnOn();
  const results = [];
  for (const setup of [async () => {}, async () => hidden.call('jev.settings.set', { replace: { courseOrganize: false } })]) {
    await setup();
    results.push(await hidden.call('source.organize.suggest', { sourceIds: ['a', 'b', 'c', 'd'] }));
  }
  assert.deepEqual(hidden.modelCalls.map(call => [call.system, call.prompt]), [calls[0], calls[0]], 'the same prompt every time');
  assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(baseline)));
  assert.equal(hidden.fake.requests.length, 0);
});

test('on: Jev picks for the sources it is sure about, ONE model call takes the rest, every proposal says who decided, nothing is saved', async t => {
  const h = await harness(t);
  await h.turnOn();
  const result = await h.call('source.organize.suggest', { sourceIds: ['a', 'b', 'c', 'd'] });
  assert.equal(h.modelCalls.length, 1);
  assert.deepEqual(askedIds(h.modelCalls[0]), ['c', 'd'], 'the unsure one and the "none fits" one (the model may propose a new course)');
  const by = Object.fromEntries(result.proposals.map(proposal => [proposal.id, proposal]));
  assert.deepEqual(result.proposals.map(proposal => proposal.id), ['a', 'b', 'c', 'd'], 'the order of the request');
  assert.deepEqual([by.a.decidedBy, by.b.decidedBy, by.c.decidedBy, by.d.decidedBy], ['jev', 'jev', 'model', 'model']);
  assert.deepEqual([by.a.courses, by.b.courses], [['Databases'], ['Operating Systems']]);
  assert.deepEqual(by.c.courses, ['Model course']);
  assert.ok(by.a.expectedCourses && by.a.reason && by.a.title === 'Locks and transactions', 'the same fields as a model proposal');
  assert.equal(by.a.jev.filled, true, 'Jev’s own probabilities ride along');
  assert.deepEqual([result.jev.enabled, result.jev.jev, result.jev.model], [true, 2, 2]);
  assert.deepEqual([result.jev.fallback.reason, result.jev.fallback.count], ['low-confidence', 2], 'one notice for the run');
  assert.ok(!han.test(result.jev.fallback.message));
  assert.deepEqual(await h.courses('a'), [], 'suggesting saved nothing');
  // The learner’s existing apply step is what changes a course.
  await h.call('source.courses.set', { assignments: [{ id: 'a', courses: by.a.courses, expectedCourses: by.a.expectedCourses }] });
  assert.deepEqual(await h.courses('a'), ['Databases']);
});

test('on, all sources confident: the model is not called at all (and is still required to be set up, as today)', async t => {
  const h = await harness(t);
  await h.turnOn();
  const result = await h.call('source.organize.suggest', { sourceIds: ['a', 'b'] });
  assert.equal(h.modelCalls.length, 0);
  assert.deepEqual(result.proposals.map(proposal => proposal.decidedBy), ['jev', 'jev']);
  assert.equal(result.jev.fallback, null);
  assert.ok(result.jev.usage.calls === 2 && result.jev.usage.inputTokens > 0);
  const page = await h.call('jev.usage');
  assert.equal(page.usage.byFeature.courseOrganize.calls, 2, 'tokens in their own row');
});

test('on, Jev failing (bad key, outage): the model call is exactly the baseline one, over every source, and the run says so once', async t => {
  const plain = await harness(t);
  await plain.call('source.organize.suggest', { sourceIds: ['a', 'b', 'c', 'd'] });
  const baseline = plain.modelCalls.map(call => [call.system, call.prompt]);
  for (const status of [401, 503]) {
    const h = await harness(t);
    await h.turnOn();
    h.fake.fail(...Array(40).fill(status));
    const result = await h.call('source.organize.suggest', { sourceIds: ['a', 'b', 'c', 'd'] });
    assert.deepEqual(h.modelCalls.map(call => [call.system, call.prompt]), baseline, String(status));
    assert.ok(result.proposals.every(proposal => proposal.decidedBy === 'model'));
    assert.deepEqual([result.jev.jev, result.jev.model, result.jev.fallback.count], [0, 4, 4]);
    assert.equal(result.jev.fallback.reason, status === 401 ? 'invalid-key' : 'unavailable');
  }
});

test('the learner’s line decides: at 99% nothing is confident enough and the model sees all four', async t => {
  const h = await harness(t);
  await h.turnOn({ threshold: 0.99 });
  const result = await h.call('source.organize.suggest', { sourceIds: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(askedIds(h.modelCalls[0]), ['a', 'b', 'c', 'd']);
  assert.equal(result.jev.jev, 0);
});

test('a library with no courses yet has nothing for Jev to choose among: the model takes everything', async t => {
  const h = await harness(t);
  await h.service.store.update(state => { for (const item of state.sources) item.courses = []; });
  await h.turnOn();
  const result = await h.call('source.organize.suggest', { sourceIds: ['a', 'b'] });
  assert.deepEqual(askedIds(h.modelCalls[0]), ['a', 'b']);
  assert.equal(result.jev.fallback.reason, 'unsupported');
  assert.equal(h.fake.requests.length, 0);
});

test('hidden experimental features: the Jev button operation is refused, and no switch makes anything run', async t => {
  const h = await harness(t, { experimental: false });
  await h.turnOn({ features: { courseSuggest: true } });
  await assert.rejects(h.call('source.organize.jev', { sourceIds: ['a'] }), /Experimental features are not shown/);
  assert.equal(h.fake.requests.length, 0);
  await h.call('experimental.set', { enabled: true });
  assert.equal((await h.call('source.organize.jev', { sourceIds: ['a'] })).proposals.length, 1);
});

test('the pipeline hook is undefined unless the features are shown and the site is on', async t => {
  const h = await harness(t, { experimental: false });
  const seam = { baseUrl: h.fake.baseUrl, sleep: async () => {} };
  await h.turnOn();
  assert.equal(await jevOrganizeHook({ seam, language: 'en', experimental: false }), undefined);
  assert.equal(typeof await jevOrganizeHook({ seam, language: 'en', experimental: true }), 'function');
  await h.call('jev.settings.set', { replace: { courseOrganize: false } });
  assert.equal(await jevOrganizeHook({ seam, language: 'en', experimental: true }), undefined);
});
