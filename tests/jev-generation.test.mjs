import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { withQualityStages } from './helpers/assessment.mjs';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 出题预审 inside a real generation job: off by default (no Jev call, no trace in the draft), and when switched on a signal per card
   kept with the draft while the independent review still runs over every card. */

const source = { id: 's', title: 'Bridge', text: 'Bridge separates an abstraction from its implementation so the two can vary independently.' };
const card = (id, prompt, objective) => ({ id, kind: 'flashcard', topic: 'Bridge', objective, prompt, answer: 'Separate independent dimensions.',
  hint: 'Think about two independent reasons to change.', explanation: 'Report types and rendering backends vary independently.',
  misconception: 'Adding a subclass for every combination causes a cross product.', citations: [{ sourceId: 's', quote: source.text }] });

async function harness(t, { jev = {}, experimental = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-gen-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-jev-gen-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer: (name, question, state) => ({ type: 'noul', noul: state.question.startsWith('Leaky') && name === 'stemLeaksAnswer' ? 0.97 : name === 'stemLeaksAnswer' || name === 'needsSource' ? 0.05 : 0.95 }), ...jev });
  const models = [];
  const complete = withQualityStages(async (system, prompt) => {
    models.push(system.slice(0, 30));
    if (system.startsWith('Rewrite')) return JSON.stringify({ cards: [card('x2', 'What does Bridge let two dimensions do?', 'Objective two')] });
    return JSON.stringify({ title: 'Bridge', cards: [card('x1', 'Why use Bridge for reports and renderers?', 'Objective one'), card('x2', 'Leaky: Bridge separates abstraction and implementation, true?', 'Objective two')] });
  });
  const service = new StudyService(root, { complete, jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => {
    service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  await service.call('source.add', source);
  // "Show experimental features" (Settings › Advanced) is the one switch that lets any experiment run at all.
  if (experimental) await service.call('experimental.set', { enabled: true });
  return { service, fake, models, call: (action, args) => service.call(action, args) };
}
async function generate(h) {
  const job = await h.call('generate', { sourceIds: ['s'], count: 2, kind: 'flashcard' });
  const done = await h.call('job.wait', { jobId: job.jobId });
  assert.equal(done.status, 'complete', done.stage);
  const drafts = (await h.call('snapshot')).drafts;
  return drafts.at(-1);
}

test('by default no Jev call is made and the draft carries no trace of it', async t => {
  const h = await harness(t);
  const draft = await generate(h);
  assert.equal(draft.cards.length, 2);
  assert.equal(draft.editorial.jev, undefined);
  assert.equal(h.fake.requests.length, 0);
});

test('switched on: one tiny Jev call per card, the flagged card is rewritten once, the review still sees every card, the signals are kept with the draft', async t => {
  const h = await harness(t);
  await h.call('jev.settings.set', { key: h.fake.key, confirm: true, enabled: true, features: { preReview: true } });
  const draft = await generate(h);
  assert.equal(h.fake.requests.length, 2, 'one call per candidate card');
  assert.equal(h.models.filter(system => system.startsWith('Rewrite')).length, 1);
  assert.equal(draft.cards.length, 2);
  assert.ok(draft.cards.some(item => item.prompt === 'What does Bridge let two dimensions do?'), 'the flagged card was rewritten');
  const signals = draft.editorial.jev.signals;
  assert.deepEqual(Object.keys(signals).sort(), draft.cards.map(item => item.id).sort());
  const rewritten = draft.cards.find(item => item.prompt.startsWith('What does Bridge let'));
  assert.equal(signals[rewritten.id].rewritten, true);
  assert.ok(signals[rewritten.id].checks.stemLeaksAnswer.failed);
  assert.equal(Object.values(draft.editorial.reviewedCards).length, 2, 'both cards, the rewritten one included, hold an independent-review receipt');
  // The tokens are counted apart from the study model's.
  const page = await h.call('jev.usage');
  assert.equal(page.usage.byFeature.preReview.calls, 2);
  assert.equal(page.usage.byFeature.test, undefined);
  const model = await h.call('usage.summary', { days: 1 });
  assert.ok(!JSON.stringify(model).includes('preReview'), 'the study model ledger knows nothing of Jev');
});

test('with experimental features hidden nothing runs, whatever the Jev switches say: no call, no trace, no rewrite', async t => {
  const h = await harness(t, { experimental: false });
  await h.call('jev.settings.set', { key: h.fake.key, confirm: true, enabled: true, features: { preReview: true }, replace: { cardReview: true } });
  const draft = await generate(h);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(draft.editorial.jev, undefined);
  assert.equal(draft.editorial.jevDecided, undefined);
  assert.equal(h.models.filter(system => system.startsWith('Rewrite')).length, 0);
  // Turning it on makes the same settings work; turning it off stops them again at once.
  await h.call('experimental.set', { enabled: true });
  assert.ok((await generate(h)).editorial.jev);
  assert.ok(h.fake.requests.length > 0);
  h.fake.requests.length = 0;
  await h.call('experimental.set', { enabled: false });
  assert.equal((await generate(h)).editorial.jev, undefined);
  assert.equal(h.fake.requests.length, 0);
});

test('card review replaced by Jev in a real job: no independent model review call, the draft records who decided, the tokens sit in their own row', async t => {
  const h = await harness(t);
  const reviewCalls = () => h.models.filter(system => system.startsWith('Act as a strict assessment')).length;
  const baseline = await generate(h);
  assert.equal(reviewCalls(), 1, 'today: one independent model review');
  assert.equal(baseline.editorial.jevDecided, undefined);
  h.models.length = 0;
  await h.call('jev.settings.set', { key: h.fake.key, confirm: true, enabled: true, replace: { cardReview: true } });
  const draft = await generate(h);
  assert.equal(reviewCalls(), 0, 'Jev took the review');
  assert.equal(draft.cards.length, 2);
  const jev = draft.editorial.jevDecided;
  assert.deepEqual([jev.site, jev.judged, jev.model, jev.accepted], ['cardReview', 2, 0, 2]);
  assert.deepEqual(Object.keys(jev.cards).sort(), draft.cards.map(item => item.id).sort());
  assert.match(draft.editorial.summary, /experimental decision service/);
  assert.equal(draft.editorial.jev, undefined, 'the extra-signal pre-check stays off');
  const page = await h.call('jev.usage');
  assert.equal(page.usage.byFeature.cardReview.calls, 2);
  // Switch off: the very next job is the model review again.
  await h.call('jev.settings.set', { replace: { cardReview: false } });
  h.models.length = 0; h.fake.requests.length = 0;
  const back = await generate(h);
  assert.equal(reviewCalls(), 1);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(back.editorial.jevDecided, undefined);
});

test('the kill switch and a failing Jev leave generation exactly as it was', async t => {
  const h = await harness(t);
  await h.call('jev.settings.set', { key: h.fake.key, confirm: true, enabled: true, features: { preReview: true } });
  await h.call('jev.settings.set', { enabled: false });
  const off = await generate(h);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(off.editorial.jev, undefined);
  await h.call('jev.settings.set', { enabled: true });
  h.fake.fail(401, 401, 401, 401, 401, 401);
  const failing = await generate(h);
  assert.equal(failing.cards.length, 2, 'the draft is the usual one');
  assert.equal(failing.editorial.jev, undefined);
  assert.equal(h.models.filter(system => system.startsWith('Rewrite')).length, 0, 'no rewrite without a signal');
  assert.equal((await h.call('jev.usage')).failure.reason, 'invalid-key', 'the settings page can say what went wrong');
});
