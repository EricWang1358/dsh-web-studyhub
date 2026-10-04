import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { planFailure } from '../lib/daily-plan/proposal.js';

// #174: a failed AI planning call keeps its reason. The local proposal stays, and carries failure: { kind, message }.
async function isolated(fn) {
  const home = await mkdtemp(join(tmpdir(), 'daily-plan-failure-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const service = new StudyService(join(home, 'library'));
  try {
    await service.store.update(s => {
      s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i}`, kind: 'flashcard', topic: 'Conditional probability', prompt: `Question ${i}`, answer: 'Answer',
        options: [], citations: [], requires: [], review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
      })) });
    });
    await fn(service);
  } finally { await service.dispose(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(home, { recursive: true, force: true }); }
}
const date = '2026-10-05';
const failing = error => async () => { throw error; };
const coded = (message, props) => Object.assign(new Error(message), props);

test('the classifier names the kinds the model-error table knows, and keeps the raw text', () => {
  const cases = [
    [coded('429 Too Many Requests', { code: 'RATE_LIMIT' }), 'rate-limit'],
    [new Error('rate limit exceeded, retry later'), 'rate-limit'],
    [new Error('Incorrect API key provided'), 'credential'],
    [coded('Unauthorized', { status: 401 }), 'credential'],
    [new Error('insufficient_quota: You exceeded your current quota'), 'quota'],
    [Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }), 'timeout'],
    [new Error('request timeout after 60s'), 'timeout'],
    [new Error('fetch failed: ECONNRESET'), 'network'],
    [new Error('upstream overloaded'), 'unavailable'],
    [new Error('something odd happened'), 'unknown'],
  ];
  for (const [error, kind] of cases) {
    const failure = planFailure(error);
    assert.equal(failure.kind, kind, error.message);
    assert.equal(failure.message, error.message, 'the provider text is kept verbatim');
  }
  assert.equal(planFailure(new Error('Invalid planner response')).kind, 'invalid-response');
  assert.equal(planFailure(new Error('Planner selected unavailable content')).kind, 'invalid-response');
  assert.equal(planFailure('plain text 429').kind, 'rate-limit');
  assert.equal(planFailure(undefined).kind, 'unknown');
});

for (const [name, error, kind] of [
  ['rate limit', coded('429 Too Many Requests', { code: 'RATE_LIMIT', status: 429 }), 'rate-limit'],
  ['key', new Error('Incorrect API key provided: sk-***'), 'credential'],
  ['timeout', Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }), 'timeout'],
]) {
  test(`a ${name} failure is on the proposal; the local suggestion is still given`, () => isolated(async service => {
    service.light = failing(error);
    const plan = await service.call('daily.plan.suggest', { date, minutes: 20 });
    assert.equal(plan.proposal.method, 'local');
    assert.ok(plan.proposal.items.length, 'the local proposal remains');
    assert.deepEqual(plan.proposal.failure, { kind, message: error.message });
    assert.ok(plan.proposal.warnings.length, 'the old warning stays for older readers');
  }));
}

test('a reply that is not a valid plan is invalid-response, not a model failure', () => isolated(async service => {
  service.light = async () => JSON.stringify({ items: 'not a list' });
  const plan = await service.call('daily.plan.suggest', { date, minutes: 20 });
  assert.equal(plan.proposal.method, 'local');
  assert.equal(plan.proposal.failure.kind, 'invalid-response');
  assert.equal(plan.proposal.failure.message, 'Invalid planner response');
  service.light = async () => JSON.stringify({ items: [{ candidateId: 'made-up' }] });
  const second = await service.call('daily.plan.suggest', { date, minutes: 20 });
  assert.equal(second.proposal.failure.kind, 'invalid-response');
  assert.equal(second.proposal.failure.message, 'Planner selected unavailable content');
}));

test('a working AI call and a missing model carry no failure', () => isolated(async service => {
  service.light = async (_s, prompt) => JSON.stringify({ items: [{ candidateId: JSON.parse(prompt).candidates[0].candidateId, reason: 'r' }], summary: 's' });
  assert.equal((await service.call('daily.plan.suggest', { date, minutes: 20 })).proposal.failure, undefined);
}));

test('the failure survives a reload of the saved proposal', () => isolated(async service => {
  service.light = failing(new Error('Incorrect API key provided'));
  await service.call('daily.plan.suggest', { date, minutes: 20 });
  assert.equal((await service.call('daily.plan.get', { date })).proposal.failure.kind, 'credential');
}));
