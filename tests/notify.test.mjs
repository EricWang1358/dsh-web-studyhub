import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { serviceFor, createHostHandler } from '../lib/host.js';
import { createSessionNotifier } from '../lib/session-notice.js';
import { fullContextIds } from '../lib/runtime/builtins.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

const job = (over) => ({ id: "j1", status: "complete", stage: "Draft ready for review", count: 20, ...over });

async function service(t, notify) {
  const root = await mkdtemp(join(tmpdir(), "study-notify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root, { notify });
}

test("a finished generation tells the session what happened, without being asked", async (t) => {
  const sent = [];
  const s = await service(t, (message) => sent.push(message));
  s.announceJob(job({ deckTitle: "Design for Performance", draftId: "d9", savedCount: 18 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].summary, "「Design for Performance」生成完成 · 18 题草稿待发布");
  assert.match(sent[0].text, /草稿 d9 已保存，18\/20 题通过审核/);
  assert.match(sent[0].text, /不要因此重新发起生成，也不要轮询任务状态/);

  s.announceJob(job({ deckTitle: "HA", status: "failed", stage: "Assessment plan is not usable", draftId: undefined }));
  assert.equal(sent[1].summary, "「HA」生成未完成：Assessment plan is not usable");
  assert.match(sent[1].text, /没有产出草稿/);

  s.announceJob(job({ status: "cancelled", stage: "Cancelled by the learner", draftId: undefined }));
  assert.match(sent[2].summary, /「题组」生成已取消/);
});

test('queued generation cancellation reports only to the initiating chat, never the UI session', async t => {
  const base = await service(t);
  const root = base.store.root;
  await base.store.update(state => { state.sources.push({ id: 'src', title: 'Lecture', text: 'Water freezes at zero degrees Celsius.' }); });
  const session = { header: { cwd: root } };
  const core = { contextIds: () => fullContextIds, runtimeForLibrary: () => base.runtime };
  const ctx = { sessions: { get: () => session }, get: name => name === 'studyRuntime' ? core : undefined };
  const turns = [], pending = [];
  const notify = createSessionNotifier({ inject: message => pending.push(message), followup: message => turns.push(message) }, message => message, 'daily-flashcard');
  const config = { libraryRoot: root, provider: 'test', model: 'test' };
  const complete = () => async () => { throw new Error('queued cancellation must not call a model'); };
  const chat = await serviceFor(ctx, config, root, session, complete, 'original-chat', notify);
  let release;
  base.runtime.work.queues.set(root, new Promise(resolve => { release = resolve; }));
  t.after(() => { release?.(); base.runtime.dispose(); });
  const first = await chat.call('generate', { sourceIds: ['src'], count: 1 });
  const panel = createHostHandler(ctx, config, complete);
  const ui = await panel('call', { sessionId: 'original-chat', action: 'generate', args: { sourceIds: ['src'], count: 1 } });
  assert.equal(ui.ok, true, ui.error?.message);
  assert.equal(turns.length, 0, 'queued and intermediate work must not wake the chat');
  for (const id of [first.jobId, ui.value.jobId]) {
    await chat.call('job.cancel', { jobId: id });
  }
  const done = [first.jobId, ui.value.jobId].map(id => base.runtime.work.settled.get(id));
  release(); await Promise.all(done);
  assert.equal(turns.length, 1, 'only the original chat task has a final reporting turn');
  assert.match(turns[0].content[0].text, new RegExp(first.jobId));
  assert.doesNotMatch(turns[0].content[0].text, new RegExp(ui.value.jobId));
  assert.equal(pending.length, 0);
});

test("without a host inbox the plugin stays silent instead of failing", async (t) => {
  const s = await service(t, undefined);
  assert.equal(s.notify, null);
  assert.doesNotThrow(() => s.announceJob(job({})));
  const broken = await service(t, () => {
    throw new Error("session ended");
  });
  // announceJob runs in the job's finally: a dead session must not disturb it.
  assert.doesNotThrow(() => broken.announceJob(job({})));
});

test('multi-batch generation reports once after every review and persisted checkpoint', async t => {
  const turns = [], pending = [];
  const notify = createSessionNotifier({ inject: message => pending.push(message), followup: message => turns.push(message) }, message => message, 'daily-flashcard');
  const s = await service(t, notify);
  const fake = createFakeModel({ latencyMs: 1 });
  let sawCheckpoint = false, calls = 0;
  s.complete = async (system, prompt, context) => {
    calls++;
    assert.equal(turns.length, 0, 'child completion and checkpoints must not report before the parent finishes');
    sawCheckpoint ||= (await s.store.read()).drafts.some(draft => draft.cards.length > 0);
    return fake(system, prompt, context);
  };
  const source = await s.call('source.add', { title: 'Architecture', text:
    'Microservices split a system into independently deployable services that own their data. ' +
    'Event-driven architecture lets services react to events published by others, which decouples producers from consumers. ' +
    'Relational databases give ACID transactions for payments and settlements.' });
  const started = await s.call('generate', { sourceIds: [source.id], count: 3, kind: 'quiz', title: 'Final receipt',
    performance: { batchSize: 1, concurrency: 1 } });
  await s.runtime.work.settled.get(started.jobId);
  const final = s.runtime.work.jobs.get(started.jobId);
  assert.equal(final.status, 'complete', final.stage);
  assert.equal(final.savedCount, 3);
  assert.ok(calls > 3);
  assert.ok(sawCheckpoint, 'exercise intermediate saved drafts while more model work remains');
  assert.equal((await s.store.read()).drafts.find(draft => draft.id === final.draftId).cards.length, 3);
  assert.equal(turns.length, 1);
  assert.match(turns[0].content[0].text, /3\/3/);
  assert.equal(pending.length, 0);
});
