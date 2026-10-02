import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { reportUsage } from '../lib/usage-scope.js';
import { authored, qualityPlan, qualityReview } from './helpers/assessment.mjs';

/* Selected-passage supplementation is an ordinary background job (the reader's learning panel, "阻塞了"):
   starting answers at once with a job handle, the job shows stage / counts / usage while it runs, can be stopped,
   saves only questions that passed the independent review (commit-after-review, unchanged), is idempotent by
   operationId, and refuses a duplicate for the same passage and deck. */

const passageA = "Architecture includes the principles guiding a system's design and evolution.";
const passageB = 'Quality attributes such as latency and availability shape which architectural tactics a team selects.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function waitFor(check, label = 'condition') {
  for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A model that answers plan / author / review like the real pipeline, with per-stage gates and flags. */
function gatedModel() {
  const control = { calls: [], gates: {}, signals: [], flagged: new Set(), reviewError: null, usage: false, authorCards: null };
  control.complete = async (system, prompt, options = {}) => {
    const stage = system.startsWith('Plan a source-grounded') ? 'plan' : system.startsWith('Act as a strict') ? 'review' : 'author';
    control.calls.push(stage); control.signals.push(options.signal);
    const gate = control.gates[stage];
    if (gate) await new Promise((resolve, reject) => {
      gate.promise.then(resolve);
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    options.signal?.throwIfAborted();
    const report = text => { if (control.usage) reportUsage({ uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }); return text; };
    if (stage === 'plan') return report(JSON.stringify(qualityPlan(JSON.parse(prompt.split('REQUEST DATA:\n')[1]))));
    if (stage === 'review') {
      if (control.reviewError) throw new Error(control.reviewError);
      const candidate = JSON.parse(prompt).candidate;
      return report(JSON.stringify(qualityReview(candidate, candidate.cards.filter(card => control.flagged.has(card.id)).map(card => `${card.id}: answerLeak failed`))));
    }
    const data = JSON.parse(prompt.split('REQUEST DATA:\n')[1]), source = data.sources[0];
    const cards = Array.from({ length: control.authorCards ?? data.count }, (_, index) => ({ id: `q${index + 1}`, kind: 'flashcard',
      topic: `Topic ${index} of ${source.text.slice(0, 12)}`, objective: `Explain angle ${index} of ${source.text.slice(0, 20)}`,
      prompt: `Why does angle ${index} matter for ${source.text.slice(0, 18).toLowerCase()} decisions?`,
      answer: `Angle ${index} constrains later choices.`, hint: 'Compare a description with a rule for permitted changes.',
      explanation: `The evidence ties angle ${index} to design and later change, so it constrains the choices made afterwards.`,
      misconception: 'It only names existing parts.', citations: [{ sourceId: source.id, quote: source.text.slice(0, 40) }] }));
    return report(JSON.stringify(authored({ title: 'Selection', cards })));
  };
  return control;
}

async function fixture(t, { model = gatedModel(), notices = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selection-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = { id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?', answer: 'Original',
    review: { repetitions: 5, ease_factor: 2.6, due_at: '2030-01-01' } };
  await new Store(root).update(state => {
    state.decks.push({ id: 'd', title: 'Architecture basics', cards: [old] });
    state.decks.push({ id: 'e', title: 'Second deck', cards: [] });
  });
  const runtime = createStudyRuntime(root, { complete: model.complete, notify: message => notices.push(message), language: 'zh' });
  t.after(() => runtime.dispose());
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md',
    dataBase64: Buffer.from(`# Notes\n\n${passageA}\n\n${passageB}`).toString('base64') });
  const resolve = async quote => (await runtime.call('materials.selection.resolve',
    { documentId: imported.documentId, revision: imported.revision, quote })).selection;
  const a = await resolve(passageA), b = await resolve(passageB);
  const args = (selection, extra = {}) => ({ selection, deckId: 'd', expectedVersion: 0, count: 1, kind: 'flashcard', operationId: crypto.randomUUID(), ...extra });
  const deck = async (id = 'd') => (await runtime.call('bank.get', { deckId: id })).deck;
  const status = async operationId => (await runtime.call('generation.selection.status', { operationId })).job;
  return { root, runtime, model, notices, imported, a, b, args, deck, status, old };
}
const wait = (f, jobId) => f.runtime.call('job.wait', { jobId, timeoutSeconds: 30 });

test('starting answers at once with a job handle while the model is still working, then the job completes into the deck', async t => {
  const model = gatedModel(); model.gates.plan = deferred();
  const f = await fixture(t, { model });
  const args = f.args(f.a, { operationId: 'start-1' });
  const started = await Promise.race([f.runtime.call('generation.selection.start', args), sleep(2000).then(() => 'blocked')]);
  assert.notEqual(started, 'blocked', 'start must not wait for plan, write and review');
  assert.ok(started.jobId, 'a job id comes back');
  assert.equal(started.operationId, 'start-1');
  assert.ok(['running', 'queued'].includes(started.status));
  assert.equal(started.job.type, 'supplement');
  assert.equal(started.job.origin, 'selection');
  assert.equal(started.job.mergeTargetId, 'd');
  assert.equal(started.job.targetTitle, 'Architecture basics');
  assert.equal((await f.deck()).cards.length, 1, 'nothing is saved before the review passed');
  const running = await f.runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 1 });
  assert.equal(running.status, 'running');
  assert.equal(running.stageCode, 'planning');
  f.model.gates.plan.release();
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.publication.added, 1);
  assert.equal(done.publication.deckId, 'd');
  assert.equal(done.publication.total, 2);
  assert.equal(done.publication.cardIds.length, 1);
  const saved = await f.deck();
  assert.equal(saved.cards.length, 2);
  assert.deepEqual(saved.cards[0], f.old);
  const links = await f.runtime.call('materials.links.list', { documentId: f.imported.documentId });
  assert.equal(links.links.length, 1, 'the new card is linked to the passage');
  assert.equal(links.links[0].cardId, done.publication.cardIds[0]);
});

test('a running job reports its stage, the counts and the model steps in place', async t => {
  const model = gatedModel(); model.gates.author = deferred(); model.gates.review = deferred();
  const f = await fixture(t, { model });
  const started = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'progress', count: 2 }));
  const planning = await waitFor(async () => { const job = await f.status('progress'); return job.steps?.length >= 2 && job; }, 'author step');
  assert.equal(planning.requestedTotal, 2);
  assert.equal(planning.count, 2);
  assert.equal(planning.stageCode, 'authoring');
  assert.equal(planning.steps[0].status, 'complete');
  f.model.gates.author.release();
  const reviewing = await waitFor(async () => { const job = await f.status('progress'); return job.stageCode === 'reviewing' && job; }, 'review stage');
  assert.equal(reviewing.written, 2, 'written candidates are counted before the review verdict');
  assert.equal(reviewing.savedCount, 0, 'nothing counts as saved before the review');
  assert.equal(reviewing.steps.length, 3);
  f.model.gates.review.release();
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.savedCount, 2);
  assert.equal(done.requestedTotal, 2);
  assert.equal(done.stageCode, 'done');
  assert.ok(done.finishedAt);
});

test('stopping the job aborts the model, saves nothing and leaves the deck as it was', async t => {
  const model = gatedModel(); model.gates.author = deferred();
  const f = await fixture(t, { model });
  const started = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'stop-me' }));
  await waitFor(() => model.calls.includes('author'), 'author call');
  const cancelled = await f.runtime.call('job.cancel', { jobId: started.jobId });
  assert.equal(cancelled.jobs[0].status, 'cancelling');
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.stageCode, 'cancelled');
  assert.equal(model.signals.at(-1).aborted, true, 'the model call was told to stop');
  assert.equal((await f.deck()).cards.length, 1);
  assert.equal(model.calls.includes('review'), false);
  const record = await f.runtime.call('generation.selection.get', { operationId: 'stop-me' });
  assert.equal(record.status, 'cancelled');
  assert.equal((await f.runtime.call('materials.links.list', { documentId: f.imported.documentId })).links.length, 0);
});

test('only questions that pass the independent review are saved; the rest are listed with plain reasons', async t => {
  const model = gatedModel(); model.flagged.add('q2');
  const f = await fixture(t, { model });
  const started = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'partial', count: 2 }));
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.publication.added, 1);
  assert.equal(done.savedCount, 1);
  assert.equal(done.requestedTotal, 2);
  assert.equal(done.stageCode, 'partial', 'saved 1 of 2 reads as partial, never as full success');
  assert.equal(done.rejected.length, 1);
  assert.match(done.rejected[0].prompt, /angle 1/);
  assert.match(done.rejected[0].reasons.join(' '), /answerLeak/);
  assert.equal((await f.deck()).cards.length, 2);
});

test('a failed review saves nothing; starting again with the same operationId reuses the candidates and saves once', async t => {
  const model = gatedModel(); model.reviewError = 'Reviewer unavailable';
  const f = await fixture(t, { model });
  const args = f.args(f.a, { operationId: 'retry-same' });
  const first = await wait(f, (await f.runtime.call('generation.selection.start', args)).jobId);
  assert.equal(first.status, 'failed');
  assert.match(first.stage, /Reviewer unavailable/);
  assert.equal(first.outcome, 'review-failed');
  assert.equal((await f.deck()).cards.length, 1);
  model.reviewError = null;
  const authorCalls = model.calls.filter(stage => stage === 'author').length;
  const again = await f.runtime.call('generation.selection.start', args);
  assert.equal(again.operationId, 'retry-same');
  const done = await wait(f, again.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(model.calls.filter(stage => stage === 'author').length, authorCalls, 'the saved candidates are reviewed again, not rewritten');
  assert.equal((await f.deck()).cards.length, 2);
});

test('a retry after a failure that saved nothing starts over under the same operationId', async t => {
  const model = gatedModel(); model.gates.plan = deferred();
  const f = await fixture(t, { model });
  const args = f.args(f.a, { operationId: 'restart' });
  const started = await f.runtime.call('generation.selection.start', args);
  await waitFor(() => model.calls.includes('plan'), 'plan call');
  await f.runtime.call('job.cancel', { jobId: started.jobId });
  assert.equal((await wait(f, started.jobId)).status, 'cancelled');
  model.gates.plan = null;
  const again = await f.runtime.call('generation.selection.start', args);
  assert.notEqual(again.jobId, started.jobId, 'a stopped job is a new job');
  const done = await wait(f, again.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.operationId, 'restart');
  assert.equal((await f.deck()).cards.length, 2);
});

test('the same operationId never starts a second job or a second write', async t => {
  const model = gatedModel(); model.gates.plan = deferred();
  const f = await fixture(t, { model });
  const args = f.args(f.a, { operationId: 'idem' });
  const first = await f.runtime.call('generation.selection.start', args);
  const second = await f.runtime.call('generation.selection.start', args);
  assert.equal(second.jobId, first.jobId, 'the running job is returned');
  await assert.rejects(f.runtime.call('generation.selection.start', { ...args, count: 2 }), /different request|已被|operationId/i);
  model.gates.plan.release();
  const done = await wait(f, first.jobId);
  assert.equal(done.status, 'complete');
  const calls = model.calls.length;
  const replay = await f.runtime.call('generation.selection.start', args);
  assert.equal(replay.status, 'complete', 'a finished operation replays');
  assert.deepEqual(replay.job.publication.cardIds, done.publication.cardIds);
  assert.equal(model.calls.length, calls, 'a replay makes no model call');
  assert.equal((await f.deck()).cards.length, 2, 'one write only');
  const jobs = (await f.runtime.call('snapshot')).jobs.filter(job => job.origin === 'selection');
  assert.equal(jobs.length, 1);
});

test('a second supplement for the same passage and deck is refused with a clear message; another passage or deck queues', async t => {
  const model = gatedModel(); model.gates.plan = deferred();
  const f = await fixture(t, { model });
  const first = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'dup-1' }));
  await assert.rejects(f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'dup-2' })),
    error => /已在进行/.test(error.message) && error.code === 'DUPLICATE_SUPPLEMENT');
  const other = await f.runtime.call('generation.selection.start', f.args(f.b, { operationId: 'other-passage' }));
  assert.equal(other.status, 'queued');
  assert.equal(other.queuedBehind, 1);
  const elsewhere = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'other-deck', deckId: 'e' }));
  assert.equal(elsewhere.status, 'queued');
  await waitFor(() => model.calls.length === 1, 'the first job calls the model');
  await sleep(50);
  assert.equal(model.calls.length, 1, 'only the first job has called the model');
  model.gates.plan.release();
  for (const job of [first, other, elsewhere]) assert.equal((await wait(f, job.jobId)).status, 'complete');
  assert.equal((await f.deck('d')).cards.length, 3, 'two passages added to the same deck, neither lost to a version conflict');
  assert.equal((await f.deck('e')).cards.length, 1);
  const after = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'dup-after' }));
  assert.ok(after.jobId, 'once the first one finished, the same passage can be supplemented again');
  await f.runtime.call('job.cancel', { jobId: after.jobId });
  await wait(f, after.jobId);
});

test('a queued job can be stopped and never starts', async t => {
  const model = gatedModel(); model.gates.plan = deferred();
  const f = await fixture(t, { model });
  await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'front' }));
  const queued = await f.runtime.call('generation.selection.start', f.args(f.b, { operationId: 'behind' }));
  assert.equal(queued.status, 'queued');
  await f.runtime.call('job.cancel', { jobId: queued.jobId });
  assert.equal((await f.status('behind')).status, 'cancelled');
  model.gates.plan.release();
  await waitFor(async () => (await f.deck()).cards.length === 2, 'first job saved');
  assert.equal(model.calls.filter(stage => stage === 'plan').length, 1);
  assert.equal((await f.deck()).cards.length, 2);
});

test('the job is in the global job list, tallies usage, keeps its estimate and files an inbox letter and a notice', async t => {
  const model = gatedModel(); model.usage = true;
  const notices = [];
  const f = await fixture(t, { model, notices });
  const started = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'visible', count: 2 }));
  assert.ok((await f.runtime.call('snapshot')).jobs.some(job => job.id === started.jobId && job.origin === 'selection'), 'listed like other generation jobs');
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.tokenUsage.calls, 3);
  assert.equal(done.tokenUsage.uncachedInputTokens, 300);
  assert.ok(done.estimate.totalTokens.low > 0 && done.estimate.calls.low === 3);
  assert.equal(notices.length, 1);
  assert.match(notices[0].summary, /Architecture basics/);
  const inbox = (await f.runtime.call('snapshot')).inbox;
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].kind, 'passage-added');
  assert.equal(inbox.items[0].deckId, 'd');
  assert.equal(inbox.items[0].cardId, done.publication.firstCardId);
  assert.equal(inbox.items[0].missing, false);
  const opened = await f.runtime.call('inbox.open', { id: inbox.items[0].id });
  assert.equal(opened.card.id, done.publication.firstCardId, 'the letter opens at the first new card');
});

test('usage.estimate prices a passage supplement before it starts, in the same format as other generation', async t => {
  const f = await fixture(t);
  const estimate = await f.runtime.call('usage.estimate', { feature: 'selection', selection: f.a, deckId: 'd', count: 4, kind: 'flashcard', language: 'English' });
  assert.equal(estimate.feature, 'generate');
  assert.equal(estimate.calls.low, 3, 'plan, write and review: one call each');
  assert.ok(estimate.totalTokens.low > 0 && estimate.totalTokens.high >= estimate.totalTokens.low);
  const started = await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'est', count: 4 }));
  assert.deepEqual(started.job.estimate.calls, estimate.calls);
  await f.runtime.call('job.cancel', { jobId: started.jobId });
  await wait(f, started.jobId);
  await assert.rejects(f.runtime.call('usage.estimate', { feature: 'selection', deckId: 'd' }), /selection/);
});

test('a stale or unknown target is refused when starting, not minutes later', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.call('generation.selection.start', f.args(f.a, { deckId: 'missing' })), /deck|题组/i);
  await assert.rejects(f.runtime.call('generation.selection.start', f.args({ ...f.a, quote: 'Something the document never said at all.' })), /stale|select|重新/i);
  await assert.rejects(f.runtime.call('generation.selection.start', f.args(f.a, { count: 0 })), /between 1 and 20/);
  assert.equal(f.model.calls.length, 0);
});

test('without a model a finished operation still replays, and a new one says why it cannot start', async t => {
  const f = await fixture(t);
  const args = f.args(f.a, { operationId: 'offline' });
  await wait(f, (await f.runtime.call('generation.selection.start', args)).jobId);
  const offline = createStudyRuntime(f.root, {});
  t.after(() => offline.dispose());
  const replay = await offline.call('generation.selection.start', args);
  assert.equal(replay.status, 'complete');
  assert.equal((await offline.call('generation.selection.start', f.args(f.b))).reason, 'model_unavailable');
});

test('the status of a finished operation survives a restart even though the in-memory job is gone', async t => {
  const f = await fixture(t);
  const done = await wait(f, (await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'persisted' }))).jobId);
  const restarted = createStudyRuntime(f.root, { complete: f.model.complete });
  t.after(() => restarted.dispose());
  const status = (await restarted.call('generation.selection.status', { operationId: 'persisted' })).job;
  assert.equal(status.status, 'complete');
  assert.equal(status.origin, 'selection');
  assert.equal(status.publication.added, 1);
  assert.deepEqual(status.publication.cardIds, done.publication.cardIds);
  await assert.rejects(restarted.call('generation.selection.status', { operationId: 'never-started' }), /does not exist|不存在/);
});

test('the job list of one document names its running and recent supplements', async t => {
  const model = gatedModel(); model.gates.plan = deferred();
  const f = await fixture(t, { model });
  await f.runtime.call('generation.selection.start', f.args(f.a, { operationId: 'listed' }));
  const listing = await f.runtime.call('generation.selection.jobs', { documentId: f.imported.documentId });
  assert.deepEqual(listing.jobs.map(job => job.operationId), ['listed']);
  assert.equal((await f.runtime.call('generation.selection.jobs', { documentId: 'another-document' })).jobs.length, 0);
  model.gates.plan.release();
});
