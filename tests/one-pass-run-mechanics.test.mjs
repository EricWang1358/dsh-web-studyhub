import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList } from '../lib/coverage-run.js';
import { leafSectionsFor } from '../lib/coverage-state.js';
import { WRITE_SYSTEM, REVIEW_SYSTEM } from '../lib/one-pass/prompts.js';
import { SAME_FACT_SYSTEM, SAME_FACT_REASON } from '../lib/one-pass/merge.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { settleJob, sleep, until } from './helpers/wait.mjs';
import { pinStaged } from './helpers/staged-strategy.mjs';

/* The run mechanics of a coverage run (pause, cancel, the time limit of a round, a restart, 自动补到完整) under ONE PASS, the default (gate B2). The staged
   pipeline's own tests (coverage-run-exec, failed-continue-exec) pin the staged strategy; these are the same mechanics with the one-pass calls, through the service,
   with the fake model of scripts/fake-model.mjs. Every world here plans rounds of 12 questions written in two portions each. */

const world = mergedTranscript({ recordings: 2, parts: 4, paragraphs: 8, distinct: true });
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };
const untilAbort = signal => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });

async function library(t, { wrap, root, coverage = { roundLimit: 16 }, source = world, seed = true } = {}) {
  const own = !root;
  root ||= await mkdtemp(join(tmpdir(), 'study-one-pass-mechanics-'));
  const log = [], fake = createFakeModel({ log, usage: true }), calls = [];
  const service = new StudyService(root, { coach: false, coverage });
  service.complete = async (system, prompt, context = {}) => { calls.push({ system, stage: context.stage }); return (wrap ? wrap(fake, service) : fake)(system, prompt, context); };
  t.after(async () => { await service.dispose(); if (own) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  if (seed) for (const item of source.sources) await service.call('source.add', { id: item.id, title: item.title, text: item.text, audio: item.audio });
  return { service, root, ids: source.sources.map(item => item.id), calls };
}
const draftOf = async service => (await service.call('export')).drafts[0];
const contractOf = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;
const statuses = draft => roundList(draft.editorial.coverageSpec).map(round => round.status);
const runningRound = async service => (((await draftOf(service))?.editorial.coverageSpec?.rounds) || []).findIndex(round => round.status === 'running') + 1;
const writes = calls => calls.filter(call => call.system.startsWith(WRITE_SYSTEM));
const roundStarts = contract => contract.events.filter(event => event.code === 'round-start').map(event => event.args.round);

/** Holds the first one-pass WRITE call made while round `round` is the one running, until the gate is opened. */
const holdWriteOfRound = (round, hold) => (complete, service) => async (system, prompt, context = {}) => {
  if (!hold.entered && system.startsWith(WRITE_SYSTEM) && await runningRound(service) === round) { hold.entered = true; await hold.promise; }
  return complete(system, prompt, context);
};

test('pause during a portion write: the write in flight finishes, nothing else starts, resume completes the run; no round and no portion runs twice', async t => {
  const hold = gate();
  const { service, ids, calls } = await library(t, { wrap: holdWriteOfRound(2, hold) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' });
  await until(() => hold.entered, 'a write of round 2 to be in flight');
  await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal((await contractOf(service, started.jobId)).status, 'pausing', 'asked, not reached: a write call is running');
  hold.open();
  await until(async () => (await contractOf(service, started.jobId)).status === 'paused', 'the pause to be reached once the write is done');
  const atPause = calls.length;
  await sleep(250);
  assert.equal(calls.length, atPause, 'nothing new starts while paused inside round 2');
  assert.deepEqual(statuses(await draftOf(service)).slice(0, 2), ['done', 'running']);
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service);
  assert.ok(statuses(draft).every(status => status === 'done'), statuses(draft).join());
  assert.equal(draft.editorial.generation.performance.strategy, 'one-pass');
  const contract = await contractOf(service, started.jobId);
  assert.deepEqual(roundStarts(contract), statuses(draft).map((_, index) => index + 1), 'every round started exactly once, in order');
  assert.equal(writes(calls).length, draft.editorial.partPlans.length, 'one write per portion: the portion held by the pause was not written again');
});

test('cancel while paused inside a round keeps the questions that passed and reads as stopped by the learner', async t => {
  const hold = gate();
  const { service, ids } = await library(t, { wrap: holdWriteOfRound(2, hold) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' });
  await until(() => hold.entered, 'a write of round 2 to be in flight');
  const kept = (await draftOf(service)).cards.map(card => card.id);
  assert.ok(kept.length > 0, 'round 1 kept questions');
  await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  hold.open();
  await until(async () => (await contractOf(service, started.jobId)).status === 'paused', 'the pause to be reached');
  await service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  const job = await settleJob(service, started.jobId, { timeoutMs: 20_000 });
  assert.equal(job.status, 'cancelled');
  const draft = await draftOf(service);
  assert.deepEqual(draft.cards.map(card => card.id).slice(0, kept.length), kept, 'what passed review is kept');
  assert.equal(draft.editorial.coverageRun.state, 'stopped');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'learner');
});

test('the time limit of a round strikes during the review of portion 2: portion 1 is kept, the round is marked timed out, and 接着做 goes on from the next round', async t => {
  // The limit of a round is a timer of `roundTimeoutMs`; this one is fired by the test at the moment it means (only that timer), so no machine is too slow for it.
  const ROUND_MS = 987_654, real = globalThis.setTimeout, armed = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { const handle = real(fn, ms, ...rest); if (ms === ROUND_MS) armed.push({ fn, handle }); return handle; };
  t.after(() => { globalThis.setTimeout = real; });
  const state = { hang: true }, hold = gate();
  const wrap = (complete, service) => async (system, prompt, context = {}) => {
    if (state.hang && system.startsWith(REVIEW_SYSTEM) && /^Part 2\//.test(context.stage || '') && context.signal && await runningRound(service) === 2) {
      hold.entered = true;
      await untilAbort(context.signal);
    }
    return complete(system, prompt, context);
  };
  const { service, ids } = await library(t, { wrap, coverage: { roundLimit: 16, roundTimeoutMs: ROUND_MS } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' });
  await until(() => hold.entered, 'the review of portion 2 of round 2 to be in flight');
  const afterRound1 = (await draftOf(service)).editorial.coverageSpec.rounds[0].kept;
  await until(async () => (await draftOf(service)).cards.length > afterRound1, 'portion 1 of round 2 to be reviewed and saved');
  const portion1 = (await draftOf(service)).cards.map(card => card.id);
  // A run that goes on by itself carries on after a round that ran out of time; one that waits for the learner ends there and offers 接着做.
  await service.call('job.control', { jobId: started.jobId, action: 'set', patch: { autoComplete: false } });
  const { fn, handle } = armed.at(-1);
  clearTimeout(handle);
  fn();
  const ended = await settleJob(service, started.jobId, { timeoutMs: 30_000 });
  assert.equal(ended.status, 'failed', ended.stage);
  const timedOut = await draftOf(service), round2 = timedOut.editorial.coverageSpec.rounds[1];
  assert.deepEqual(timedOut.cards.map(card => card.id).slice(0, portion1.length), portion1, 'portion 1 of the round is kept');
  assert.equal(round2.reason, 'timeout', JSON.stringify(round2));
  const contract = await contractOf(service, started.jobId);
  assert.equal(contract.actions.retry.available, true, 'a round that ran out of time is continued');
  state.hang = false;
  const retried = await service.call('job.control', { jobId: started.jobId, action: 'retry' });
  const next = await settleJob(service, retried.jobId);
  assert.equal(next.status, 'complete', next.stage);
  const done = await draftOf(service);
  // As in the staged pipeline (failed-continue-exec), 接着做 goes on from the next round that is not done; the round that ran out of time keeps its record and its sections
  // are left to the fill rounds.
  assert.deepEqual(done.editorial.coverageSpec.rounds.slice(1, 3).map(round => [round.status, round.reason]), [['failed', 'timeout'], ['done', undefined]]);
  assert.deepEqual(done.cards.map(card => card.id).slice(0, portion1.length), portion1);
  assert.equal(done.editorial.generation.performance.strategy, 'one-pass');
});

test('a restart mid-round: a second service on the same folder restores the run, and 接着做 continues it from the draft, still in one pass', async t => {
  const hold = gate();
  const crashed = await library(t, { wrap: holdWriteOfRound(2, hold) });
  const started = await crashed.service.call('generate', { sourceIds: crashed.ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' });
  await until(() => hold.entered, 'a write of round 2 to be in flight');
  const mid = await draftOf(crashed.service);
  assert.deepEqual(statuses(mid).slice(0, 2), ['done', 'running']);
  const copy = await mkdtemp(join(tmpdir(), 'study-one-pass-restart-'));
  t.after(() => rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await cp(crashed.root, copy, { recursive: true });
  const after = await library(t, { root: copy, seed: false });
  // The library now says 逐题精出: the draft was started in one pass, and a continuation goes on the way it was started.
  await pinStaged(after.service);
  const restored = (await after.service.call('snapshot')).jobs.find(job => job.draftId === mid.id);
  assert.equal(restored?.contract.status, 'interrupted');
  const reply = await after.service.call('job.control', { jobId: restored.id, action: 'retry' });
  const job = await settleJob(after.service, reply.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const done = await draftOf(after.service);
  assert.ok(statuses(done).every(status => status === 'done'), statuses(done).join());
  assert.deepEqual(done.cards.map(card => card.id).slice(0, mid.cards.length), mid.cards.map(card => card.id), 'what round 1 kept stays');
  assert.equal(done.editorial.generation.performance.strategy, 'one-pass');
  assert.ok(writes(after.calls).length > 0 && after.calls.every(call => !/^Plan a source-grounded/.test(call.system)), 'the continuation wrote in one pass, never planned');
  hold.open();
  await settleJob(crashed.service, started.jobId);
});

test('the same-fact merge removes a section\'s only question while 自动补到完整 is on: the section counts as covered by the card that stays, and is not asked again', async t => {
  // Short sections: most get one question.
  const small = mergedTranscript({ recordings: 2, parts: 4, paragraphs: 2 }), merged = {};
  const wrap = (complete, service) => async (system, prompt, context = {}) => {
    if (system.startsWith(SAME_FACT_SYSTEM) && !merged.key) {
      // The draft holds the round's cards (saved as each portion settled): group a section's only card with a card of the section before it.
      const state = await service.call('export'), draft = state.drafts[0], leaves = leafSectionsFor(state, state.sources);
      const sectionOf = card => leaves.findIndex(leaf => leaf.sourceId === card.citations?.[0]?.sourceId && card.citations[0].at?.start >= leaf.start && card.citations[0].at.start < leaf.end);
      const asked = JSON.parse(prompt).cards, indexOf = card => asked.findIndex(item => item.objective === card.objective);
      const count = new Map();
      for (const card of draft.cards) count.set(sectionOf(card), (count.get(sectionOf(card)) || 0) + 1);
      for (const card of draft.cards) {
        const at = sectionOf(card), before = draft.cards.find(other => sectionOf(other) === at - 1);
        if (at > 0 && count.get(at) === 1 && before && indexOf(card) >= 0 && indexOf(before) >= 0) {
          Object.assign(merged, { key: leaves[at].key ?? leaves[at].id, objective: card.objective });
          return JSON.stringify({ groups: [[indexOf(before), indexOf(card)]] });
        }
      }
    }
    return complete(system, prompt, context);
  };
  const { service, ids } = await library(t, { wrap, source: small });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English', autoComplete: true });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(merged.key, 'a section with one question was merged away');
  const draft = await draftOf(service);
  assert.ok(!draft.cards.some(card => card.objective === merged.objective), 'the merged card is gone');
  const omitted = (draft.editorial.omitted || []).find(item => item.objective === merged.objective || (item.reasons || item.issues || []).some?.(reason => reason === SAME_FACT_REASON));
  assert.ok(omitted?.coveredBy, `the omission names the card that stays: ${JSON.stringify(omitted)}`);
  const view = await service.call('coverage.get', { draftId: draft.id });
  const section = view.coverage.sections.find(item => (item.key ?? item.id) === merged.key);
  assert.equal(section?.state, 'covered', JSON.stringify(section));
  const rounds = draft.editorial.coverageSpec.rounds;
  const askedAgain = rounds.slice(1).filter(round => (round.askedKeys || round.sectionIds || []).includes(merged.key));
  assert.deepEqual(askedAgain, [], 'no later round asked for the merged section');
  assert.equal(draft.editorial.coverageRun.state, 'complete');
});
