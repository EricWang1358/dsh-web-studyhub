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

  const running = await jobOf(started.jobId);
  assert.deepEqual(running.control.values, { textConcurrency: 3, transcribeConcurrency: 1, proofreadReasoning: 'default', translateReasoning: 'low', autoBackoff: true, paused: false });
  assert.equal(running.control.limits.textConcurrency.max, 6);
  assert.equal(running.control.limits.transcribeConcurrency.max, 3);

  const reply1 = await service.call('job.control', { jobId: started.jobId, patch: { transcribeConcurrency: 2, textConcurrency: 4, proofreadReasoning: 'high' } });
  assert.deepEqual(reply1.applied, { transcribeConcurrency: 2, textConcurrency: 4, proofreadReasoning: 'high' });
  await until(() => held.has('A'), 'A starts transcribing while B is still being transcribed');
  const after = await jobOf(started.jobId);
  assert.equal(after.parallel.transcribe.limit, 2);
  assert.equal(after.parallel.text.limit, 4);
  assert.equal(after.control.values.proofreadReasoning, 'high');
  assert.ok(after.events.some((event) => event.code === 'control'));

  await service.call('job.control', { jobId: started.jobId, patch: { paused: true } });
  assert.equal((await jobOf(started.jobId)).paused, true);
  held.get('B')();
  await until(async () => (await jobOf(started.jobId)).members[0].steps?.transcribe?.done === 1, 'B is transcribed');
  await sleep(150);
  assert.ok(!calls.some((call) => call === 'proofread:B'), `no text step starts while paused: ${calls}`);
  await service.call('job.control', { jobId: started.jobId, patch: { paused: false } });
  await until(() => calls.includes('proofread:B'), 'B is proofread after the resume');
  held.get('A')();
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const finished = await jobOf(started.jobId);
  assert.equal('control' in finished, false);
  assert.equal('paused' in finished, false);
  assert.ok(finished.calls.some((call) => call.kind === 'proofread' && Number.isInteger(call.slot)), 'text calls carry the slot they ran in');
  assert.ok(finished.calls.some((call) => call.kind === 'transcribe' && call.file === 'B.wav'));
  await assert.rejects(service.call('job.control', { jobId: started.jobId, patch: { paused: true } }), /结束/);
});
