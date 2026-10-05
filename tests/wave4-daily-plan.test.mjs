import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

// #185: a proposal with no actions says why, so the page can tell "time is used up" from "nothing to schedule".
const date = '2026-10-05';
async function isolated(fn, { content = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wave4-plan-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const service = new StudyService(join(home, 'library'));
  try {
    if (content) await service.store.update((s) => {
      s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: Array.from({ length: 7 }, (_, i) => ({
        id: `q${i}`, kind: 'flashcard', topic: 'Conditional probability', prompt: `Question ${i}`, answer: 'Answer',
        options: [], citations: [], requires: [], review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } })) });
      s.sources.push({ id: 'source', title: 'Lecture', text: 'Probability notes', courses: ['Math'] });
    });
    await fn(service);
  } finally { await service.dispose(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(home, { recursive: true, force: true }); }
}

test('an empty proposal because the time is used up says so: emptyReason budget (#185)', () => isolated(async (service) => {
  const plan = await service.call('daily.plan.suggest', { date, minutes: 1 });
  assert.deepEqual(plan.proposal.items, []);
  assert.equal(plan.proposal.emptyReason, 'budget');
  const rest = await service.call('daily.plan.suggest', { date: '2026-10-06', minutes: 0 });
  assert.equal(rest.proposal.emptyReason, 'budget', 'a rest day has no time to give');
  assert.equal((await service.call('daily.plan.get', { date })).proposal.emptyReason, 'budget', 'it survives a reload');
}));

test('an empty proposal because nothing is due or waiting says so: emptyReason nothing-due (#185)', () => isolated(async (service) => {
  const plan = await service.call('daily.plan.suggest', { date, minutes: 30 });
  assert.deepEqual(plan.proposal.items, []);
  assert.equal(plan.proposal.emptyReason, 'nothing-due');
}, { content: false }));

test('a proposal with actions has no emptyReason (#185)', () => isolated(async (service) => {
  const plan = await service.call('daily.plan.suggest', { date, minutes: 20 });
  assert.ok(plan.proposal.items.length);
  assert.equal(plan.proposal.emptyReason, undefined);
}));
