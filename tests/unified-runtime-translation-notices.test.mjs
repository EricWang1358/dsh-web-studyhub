/* The session notice of a translation (complete, failed, cancelled): one per settled run in every mode, the same words on both sides of the switch. Switch off: the executor announces.
   Switch on: the definition's in-process settlement sink does, and the executor does not (nothing is announced twice, a paused run is not announced until it settles). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { until, settleJob } from './helpers/wait.mjs';
import { gate } from './helpers/model-family-baseline.mjs';
import { model, library } from './helpers/translation-library.mjs';

const counted = () => { const notices = []; return { notices, notify: message => { notices.push(message); } }; };
const settledNotices = async notices => { await new Promise(resolve => setTimeout(resolve, 150)); return notices.length; };

for (const mode of ['legacy', 'runtime']) {
  test(`${mode}: a translation that completes is announced once`, async t => {
    const { notices, notify } = counted(), f = await library(t, model(), mode, { notify }), a = await f.one('Alpha');
    const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
    assert.equal((await settleJob(f.runtime, started.jobId)).status, 'complete');
    await until(() => notices.length >= 1, 'the notice');
    assert.equal(await settledNotices(notices), 1);
    assert.match(notices[0].summary, /9\/9|9 paragraphs|已译 9\/9/, notices[0].summary);
  });

  // The legacy executor lets a queued translation end only at its turn (baseline D8, fixed on the runtime path), so this case is the runtime's.
  if (mode === 'runtime') test('runtime: a translation stopped while it waits for the library is announced once, as cancelled', async t => {
    const { notices, notify } = counted(), fake = model(); fake.gates.set(0, gate());
    const f = await library(t, fake, mode, { notify }), [a, b] = [await f.one('Alpha'), await f.one('Beta')];
    const first = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
    await until(() => fake.calls.length >= 1, 'the first one at the model');
    const queued = await f.runtime.call('generation.translation.start', { documentId: b.documentId, scope: b.scope });
    await f.runtime.call('job.control', { jobId: queued.jobId, action: 'cancel' });
    assert.equal((await settleJob(f.runtime, queued.jobId)).status, 'cancelled');
    await until(() => notices.length >= 1, 'the notice of the stopped one');
    assert.equal(await settledNotices(notices), 1, 'the first one has not settled: only the stopped one is announced');
    assert.match(notices[0].summary, /已停止|stopped/, notices[0].summary);
    fake.gates.get(0).release();
    assert.equal((await settleJob(f.runtime, first.jobId)).status, 'complete');
    await until(() => notices.length >= 2, 'the notice of the first');
    assert.equal(await settledNotices(notices), 2);
  });
}

test('runtime: a paused translation is not announced until it settles after the resume, and then once', async t => {
  const { notices, notify } = counted(), fake = model(); fake.gates.set(0, gate());
  const f = await library(t, fake, 'runtime', { notify }), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope, concurrency: 1 });
  await until(() => fake.calls.length === 1, 'the first wave at the model');
  await f.runtime.call('job.control', { jobId: started.jobId, action: 'pause' });
  fake.gates.get(0).release();
  await until(async () => (await f.runtime.call('snapshot')).jobs.find(job => job.id === started.jobId)?.contract.status === 'paused', 'the pause at the wave boundary');
  assert.equal(await settledNotices(notices), 0, 'a paused run has not settled');
  await f.runtime.call('job.control', { jobId: started.jobId, action: 'resume' });
  assert.equal((await settleJob(f.runtime, started.jobId)).status, 'complete');
  await until(() => notices.length >= 1, 'the notice');
  assert.equal(await settledNotices(notices), 1);
});

test('both sides of the switch say the same thing about the same run', async t => {
  const texts = [];
  for (const mode of ['legacy', 'runtime']) {
    const { notices, notify } = counted(), f = await library(t, model(), mode, { notify }), a = await f.one('Alpha');
    const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
    await settleJob(f.runtime, started.jobId);
    await until(() => notices.length >= 1, 'the notice');
    texts.push(notices[0].text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'));
  }
  assert.equal(texts[1], texts[0]);
});
