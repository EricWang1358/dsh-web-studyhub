import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { modelKey } from '../lib/job-model.js';
import { withQualityStages } from './helpers/assessment.mjs';
import { SWITCH_MODES, switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';

/* 「仅本任务生效」 on both executors (the job table, and the unified runtime behind runtime.pilot.generation): a question run started on the host model
   (A) is switched to another model (B) while its first call is in flight. That call finishes on A; every later call of the run is sent on B; the change
   is a line of the run's log; the saved generation defaults and the run queued behind it keep following the host model. */

const B = { provider: 'siliconflow', model: 'Qwen/Qwen3-235B-A22B' };
const source = { id: 'page-a', title: 'Book p.1', text: "Architecture includes the principles guiding a system's design and evolution over time. ".repeat(4) };
const answer = (n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Architecture', objective: `Target ${n}`, prompt: `Question ${n}: what does the passage establish?`,
  answer: `Answer ${n}.`, hint: 'Think about scope.', explanation: 'The passage states it.', misconception: 'Confusing scope.', citations: [{ sourceId: source.id, quote: source.text.trim() }] });
const inner = withQualityStages(async (system, prompt) => {
  if (system.includes('editor')) return JSON.stringify({ issues: [] });
  const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
  return JSON.stringify({ title: 'D', cards: Array.from({ length: request.count }, (_, index) => ({ ...answer(index + 1), id: `n${index + 1}`, objective: `New ${index + 1}` })) });
});

for (const mode of SWITCH_MODES) {
  test(`${mode}: a run switched to another model mid-run sends its next calls on it, finishes the call in flight on the first one, and changes nothing else`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `study-model-choice-${mode}-`));
    const calls = [];
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; }), first = new Promise((resolve) => { entered = resolve; });
    // The model each call was sent on: the legacy executor names the run's choice on the call (the host builds the route from it), the runtime's gateway sends the route itself.
    const complete = async (system, prompt, options = {}) => {
      const call = { jobId: options.jobId, model: options.route?.model ?? options.model?.model ?? 'host', done: false };
      calls.push(call);
      if (calls.length === 1) { entered(); await gate; }
      try { return await inner(system, prompt); } finally { call.done = true; }
    };
    const service = new StudyService(root, { complete, ...switchOptions(mode, { complete, paths: ['generation'] }) });
    t.after(async () => { release(); await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    await service.call('source.add', source);
    await service.call('settings', { generation: { concurrency: 1 } });
    const defaults = (await service.call('snapshot')).settings.generation;
    const started = await service.call('generate', { sourceIds: [source.id], count: 2, kind: 'flashcard' });
    const behind = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard', title: 'Queued behind' });
    await first;
    const host = calls[0].model;

    const reply = await service.call('job.control', { jobId: started.jobId, action: 'set', patch: { model: modelKey(B) } });
    // The job table answers with what is now in force; the runtime with the job's state (its contract carries the values).
    if (mode === 'legacy') assert.deepEqual(reply.applied, { model: modelKey(B) }); else assert.equal(reply.action, 'set');
    assert.equal(calls[0].done, false, 'the call in flight is not interrupted');
    const running = (await service.call('snapshot')).jobs.find((job) => job.id === started.jobId);
    assert.equal(running.contract.actions.set.settings.find((item) => item.key === 'model').value, modelKey(B), 'the run says which model is in force');
    assert.ok(running.contract.events.some((event) => event.code === 'control' && event.args?.changed?.model === modelKey(B)), 'the change is a line of the log');
    const queued = (await service.call('snapshot')).jobs.find((job) => job.id === behind.jobId);
    assert.equal(queued.contract.actions.set.settings.find((item) => item.key === 'model').value, 'follow', 'the other run still follows the host model');
    await assert.rejects(service.call('job.control', { jobId: started.jobId, action: 'set', patch: { model: 'not-a-model' } }), /model/);

    release();
    assert.equal((await settleJob(service, started.jobId)).status, 'complete');
    assert.equal((await settleJob(service, behind.jobId)).status, 'complete');
    // The library runs one question run at a time: the calls of the switched run come first, then those of the run queued behind it.
    const models = calls.map((call) => call.model), seen = models.join(', ');
    assert.equal(models[0], host, `the call that was in flight finished on the model it started with: ${seen}`);
    const split = models.indexOf(host, 1);
    assert.ok(split > 1 && models.slice(1, split).every((model) => model === B.model), `every later call of the switched run went to B: ${seen}`);
    assert.ok(models.slice(split).every((model) => model === host), `the run queued behind it kept the host model: ${seen}`);
    if (mode === 'legacy') {
      assert.ok(calls.slice(1, split).every((call) => call.jobId === started.jobId), 'those are the switched run\'s calls');
      assert.ok(calls.slice(split).every((call) => call.jobId === behind.jobId), 'and these the other run\'s');
    }
    const snapshot = await service.call('snapshot');
    assert.deepEqual(snapshot.settings.generation, defaults, 'the saved generation defaults did not move');
    assert.equal('model' in snapshot.settings.generation, false, 'and hold no model');
  });
}
