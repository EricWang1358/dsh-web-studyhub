import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';

// WP-TC step 4 through the audio worker: a proofreading window written by the host model streams its text; the Gemini transcription of the same
// import cannot, and says so.

const KEY = 'AIzaAudioOutputTest_0000000000001';
const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
function wav() {
  const data = Buffer.alloc(16000, 1), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('the transcription cannot stream and says so; the host-model proofreading streams, incrementally, and its text can still be read once it ends (2.6.1)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-output-')), root = join(dir, 'library'), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  let releaseTranscribe, releaseProof;
  const transcribeGate = new Promise((resolve) => { releaseTranscribe = resolve; }), proofGate = new Promise((resolve) => { releaseProof = resolve; });
  t.after(async () => { releaseTranscribe(); releaseProof(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const fetch = async (url) => {
    assert.ok(String(url).includes('transcribe:'), 'only the transcription goes to Gemini');
    await transcribeGate;
    return reply('The lecture describes database transactions and indexes in some detail.');
  };
  const service = new StudyService(root, { fetch });
  await service.call('audio.settings.set', { paidKey: KEY, textProvider: 'host', transcribeConcurrency: 1 });
  service.complete = async (system, prompt, options) => {
    // The host model is told the step in the title of its sub-agent (lib/audio-job.js subagentTitle).
    const kind = /校对/.test(options.stage) ? 'proofread' : /翻译/.test(options.stage) ? 'translate' : 'title';
    if (kind === 'proofread') {
      options.onOutput?.('{"corrections": [');
      await proofGate;
      options.onOutput?.(']}');
      return '{"corrections":[]}';
    }
    if (kind === 'translate') return JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: JSON.parse(prompt).paragraphs.map((item) => ({ n: item.n, zh: '译文。' })) });
    return '{"titleEn":"Database lecture"}';
  };
  const file = join(dir, 'A.wav');
  await writeFile(file, wav());
  const started = await service.call('audio.import', { path: file });
  const jobOf = async () => (await service.call('snapshot')).jobs.find((job) => job.id === started.jobId);
  const running = (job, kind) => (job?.contract.calls || []).find((call) => call.kind === kind && call.status === 'running');

  await until(async () => running(await jobOf(), 'transcribe'), 'the transcription is running');
  const transcribe = running(await jobOf(), 'transcribe');
  const quiet = await service.call('job.output', { jobId: started.jobId, callId: transcribe.callId, cursor: 0 });
  assert.equal(quiet.supported, false, 'a Gemini request offers no text on the way');
  assert.equal(quiet.live, true);
  assert.equal(quiet.text, '');
  assert.equal(quiet.runner, 'gemini');
  releaseTranscribe();

  await until(async () => running(await jobOf(), 'proofread'), 'a proofreading window is running');
  const proofread = running(await jobOf(), 'proofread');
  const first = await service.call('job.output', { jobId: started.jobId, callId: proofread.callId, cursor: 0 });
  assert.equal(first.supported, true);
  assert.equal(first.text, '{"corrections": [');
  assert.equal(first.retention.limit, 8192);
  releaseProof();
  await settleJob(service, started.jobId);
  const after = await service.call('job.output', { jobId: started.jobId, callId: proofread.callId, cursor: first.nextCursor });
  assert.equal(after.ended, true);
  assert.equal(after.text, ']}', 'a reader that stopped at the first text gets the rest, once the call has ended');
  const reread = await service.call('job.output', { jobId: started.jobId, callId: proofread.callId, cursor: 0 });
  assert.equal(reread.ended, true);
  assert.equal(reread.retained, true);
  assert.equal(reread.text, '{"corrections": []}', 'the finished window can be read again from the start');
  const gemini = await service.call('job.output', { jobId: started.jobId, callId: transcribe.callId, cursor: 0 });
  assert.equal(gemini.supported, false, 'the transcription still has nothing to show');
  assert.equal(gemini.ended, true);
  assert.equal(gemini.retained, false);
  assert.equal(gemini.text, '');
});
