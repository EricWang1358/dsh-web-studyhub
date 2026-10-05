import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { settleJob, until, sleep } from './helpers/wait.mjs';

// WP-TC step 3 through the real audio worker: a batch takes a new transcription concurrency while a recording is being transcribed,
// pauses its text steps between calls, and has nothing left to adjust once it is over.

const KEY = 'AIzaAudioControlTest_0000000000001';
const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
function wav(fill) {
  const data = Buffer.alloc(16000, fill), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-control-')), root = join(dir, 'library'), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const calls = [], held = new Map();
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('transcribe:')) {
      const audio = body.contents[0].parts.find((part) => part.inlineData).inlineData.data;
      const name = Buffer.from(audio, 'base64').at(-1) === 1 ? 'A' : 'B';
      calls.push(`transcribe:${name}`);
      await new Promise((resolve, reject) => { held.set(name, resolve); init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
      return reply(`${name} describes database transactions and indexes.`);
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    const name = /B describes|"filename":"B/.test(prompt) ? 'B' : 'A';
    calls.push(`${kind}:${name}`);
    if (kind === 'proofread') return reply('{"corrections":[]}');
    if (kind === 'title') return reply('{"titleEn":"Database lecture"}');
    const payload = JSON.parse(prompt.split('\n\nYour previous')[0]);
    return reply(JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: payload.paragraphs.map((item) => ({ n: item.n, zh: `${name} 的翻译。` })) }));
  };
  const service = new StudyService(root, { fetch });
  await service.call('audio.settings.set', { paidKey: KEY, textProvider: 'gemini', transcribeConcurrency: 1 });
  const a = join(dir, 'A.wav'), b = join(dir, 'B.wav');
  await writeFile(a, wav(1)); await writeFile(b, wav(2));
  t.after(async () => { for (const release of held.values()) release(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const jobOf = async (id) => (await service.call('snapshot')).jobs.find((job) => job.id === id);
  return { service, a, b, calls, held, jobOf };
}

test('a batch: more transcription at once from the next recording on, text steps paused and resumed, nothing to adjust at the end', async (t) => {
  const { service, a, b, calls, held, jobOf } = await fixture(t);
  const started = await service.call('audio.import', { files: [{ path: b }, { path: a }] });
  await until(() => held.has('B'), 'B is being transcribed');
  assert.deepEqual(calls, ['transcribe:B'], 'one transcription at a time to begin with');

  const running = (await jobOf(started.jobId)).contract;
  assert.deepEqual(running.actions.set.settings.map((item) => [item.key, item.value]), [['textConcurrency', 3], ['transcribeConcurrency', 1], ['proofreadReasoning', 'default'], ['translateReasoning', 'low'], ['autoBackoff', true]]);
  assert.equal(running.actions.set.settings[0].max, 6);
  assert.equal(running.actions.set.settings[1].max, 3);
  assert.equal(running.actions.pause.available, true);

  const reply1 = await service.call('job.control', { jobId: started.jobId, action: 'set', patch: { transcribeConcurrency: 2, textConcurrency: 4, proofreadReasoning: 'high' } });
  assert.deepEqual(reply1.applied, { transcribeConcurrency: 2, textConcurrency: 4, proofreadReasoning: 'high' });
  await until(() => held.has('A'), 'A starts transcribing while B is still being transcribed');
  const after = await jobOf(started.jobId);
  assert.equal(after.parallel.transcribe.limit, 2);
  assert.equal(after.parallel.text.limit, 4);
  assert.equal(after.contract.actions.set.settings.find((item) => item.key === 'proofreadReasoning').value, 'high');
  assert.ok(after.contract.events.some((event) => event.code === 'control'));

  const paused = await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal(paused.action, 'pause');
  const pausing = (await jobOf(started.jobId)).contract;
  assert.equal(pausing.status, 'pausing', 'asked, not reached: two transcriptions are still in flight');
  assert.deepEqual(pausing.actions.pause.waiting, { reason: 'calls-in-flight', count: 2 });
  assert.equal(pausing.actions.pause.mode, 'checkpoint');
  assert.equal(pausing.actions.pause.available, false);
  assert.equal(pausing.actions.resume.available, true);
  held.get('B')();
  await until(async () => (await jobOf(started.jobId)).members[0].steps?.transcribe?.done === 1, 'B is transcribed');
  assert.equal((await jobOf(started.jobId)).contract.status, 'pausing', 'A is still being transcribed: the boundary is not reached');
  held.get('A')();
  await until(async () => (await jobOf(started.jobId)).contract.status === 'paused', 'the boundary is reached: nothing in flight');
  await sleep(150);
  assert.ok(!calls.some((call) => call === 'proofread:B'), `no text step starts while paused: ${calls}`);
  await assert.rejects(service.call('job.control', { jobId: started.jobId, action: 'pause' }), (error) => error.code === 'already-paused');
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  assert.equal((await jobOf(started.jobId)).contract.status, 'running');
  await until(() => calls.includes('proofread:B'), 'B is proofread after the resume');
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const finished = await jobOf(started.jobId);
  assert.equal('control' in finished, false);
  assert.equal('paused' in finished, false);
  assert.equal('pausedAt' in finished, false);
  assert.equal(finished.contract.status, 'complete');
  assert.equal(finished.contract.jobId, finished.batchId, 'the contract names the batch, which survives a retry; the attempt is its own id');
  assert.equal(finished.contract.attemptId, finished.id);
  assert.ok(finished.contract.calls.some((call) => call.kind === 'proofread' && Number.isInteger(call.slot)), 'text calls carry the slot they ran in');
  assert.ok(finished.contract.calls.some((call) => call.kind === 'transcribe' && call.file === 'B.wav'));
  await assert.rejects(service.call('job.control', { jobId: started.jobId, action: 'pause' }), (error) => error.code === 'job-ended');
});

test('retry is an action: a cancelled import starts again from what is kept, as a new attempt of the same job', async (t) => {
  const { service, a, held, jobOf } = await fixture(t);
  const started = await service.call('audio.import', { path: a });
  await until(() => held.has('A'), 'the recording is being transcribed');
  const first = (await jobOf(started.jobId)).contract;
  assert.equal(first.actions.retry.reason.code, 'not-ended');
  await service.call('job.control', { jobId: first.jobId, action: 'cancel' });
  await until(async () => (await jobOf(started.jobId)).status === 'cancelled', 'the import is cancelled');
  const cancelled = (await jobOf(started.jobId)).contract;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.endReason, 'user-cancel');
  assert.equal(cancelled.actions.retry.available, true);
  assert.equal(cancelled.actions.cancel.reason.code, 'job-ended');
  held.delete('A');
  const retried = await service.call('job.control', { jobId: cancelled.jobId, action: 'retry' });
  assert.equal(retried.retried, true);
  assert.notEqual(retried.jobId, started.jobId, 'a new attempt has a new record');
  const next = (await service.call('snapshot')).jobs.find((job) => job.id === retried.jobId).contract;
  assert.equal(next.jobId, cancelled.jobId, 'and the same job');
  assert.notEqual(next.attemptId, cancelled.attemptId);
  assert.equal((await service.call('snapshot')).jobs.filter((job) => job.type === 'audio-import').length, 1, 'the old attempt was replaced, not kept beside it');
  await until(() => held.has('A'), 'the second attempt transcribes');
  held.get('A')();
  assert.equal((await settleJob(service, retried.jobId)).status, 'complete');
});
