import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { audioUsageFetch, flushAudioUsage, keyId } from '../lib/audio-dashboard.js';
import { audioDashboard } from '../lib/audio-dashboard.js';
import { readAudioSettings } from '../lib/audio-settings.js';
import { settleJob } from './helpers/wait.mjs';

/* WP-AU #209: every request that really goes to a transcription or text provider is in the usage ledger, whatever started
   it (batch, single, retry, resume), and a request the wrapper cannot classify is recorded as "other" instead of vanishing. */

const PAID = 'AIzaLedgerPaid_000000000000001', FREE = 'AIzaLedgerFree_000000000000001';
const SF = 'sk-ledgersiliconflow00000000001', GROQ = 'gsk_ledgergroq000000000000000001';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const gemini = (text, usage = { promptTokenCount: 100, candidatesTokenCount: 10 }) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage });
function wav(fill, seconds = 5, rate = 8000) {
  const data = Buffer.alloc(seconds * rate * 2, fill), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const lecture = 'Today we discuss database indexes and transactions. ';

/** A library with fake providers; `calls` lists every HTTP request in order, as the network would see it. */
async function fixture(t, { keys = { paidKey: PAID }, host = true, failFirstTranscribe = false, brokenLedger = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-ledger-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  // A ledger folder that cannot be created (a file sits where it should be): every write fails.
  if (brokenLedger) { await mkdir(join(dir, 'home', 'study'), { recursive: true }); await writeFile(join(dir, 'home', 'study', 'audio-usage'), 'not a folder'); }
  const calls = [], flags = { breakText: false, stages: [] };
  let transcribed = 0;
  const fetch = async (url, init = {}) => {
    url = String(url);
    calls.push(url);
    if (url.includes('api.siliconflow.cn') && url.includes('/audio/transcriptions')) return json({ text: lecture });
    if (url.includes('api.groq.com') && url.includes('/audio/transcriptions')) return json({ text: lecture });
    if (url.includes('api.groq.com') && url.includes('/chat/completions')) return json({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    if (url.includes('upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session' } });
    if (init.method === 'DELETE') return json({});
    const body = JSON.parse(init.body);
    if (url.includes('transcribe:')) {
      if (failFirstTranscribe && transcribed++ === 0) return json({ error: { message: 'Internal' } }, 500);
      return gemini(lecture);
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    if (system.startsWith('You proofread')) return gemini('{"corrections":[]}');
    if (system.startsWith('You translate')) return gemini(JSON.stringify({ titleZh: '标题', titleEn: 'Title', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '译文。' })) }));
    return gemini('{"titleEn":"Lecture"}');
  };
  const complete = host ? async (system, prompt, options = {}) => {
    flags.stages.push(options.stage);
    if (flags.breakText) throw Object.assign(new Error('the model is unreachable'), { fatal: true });
    if (system.startsWith('You proofread')) return '{"corrections":[]}';
    if (system.startsWith('You translate')) return JSON.stringify({ titleZh: '标题', titleEn: 'Title', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '译文。' })) });
    return '{"titleEn":"Lecture"}';
  } : undefined;
  const service = new StudyService(join(dir, 'library'), { fetch, ...(complete ? { complete } : {}) });
  await service.call('audio.settings.set', { ...keys, textProvider: host ? 'host' : 'gemini' });
  t.after(async () => { await service.call('job.cancel', { all: true }); await flushAudioUsage(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const file = async (name, fill) => { const path = join(dir, name); await writeFile(path, wav(fill)); return path; };
  const usage = async () => audioDashboard(await readAudioSettings());
  return { service, calls, file, usage, dir, flags };
}
const today = (usage, tier) => usage.providers.find(provider => provider.tier === tier).today;

test('a batch of three recordings records one request per transcription, with the audio minutes', async t => {
  const f = await fixture(t);
  const paths = [await f.file('a.wav', 1), await f.file('b.wav', 2), await f.file('c.wav', 3)];
  const started = await f.service.call('audio.import', { files: paths.map(path => ({ path })) });
  const job = await settleJob(f.service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const usage = await f.usage(), paid = today(usage, 'paid');
  assert.equal(paid.requests, 3, 'one transcription request per recording');
  assert.equal(Math.round(paid.audioSeconds), 15, 'minutes of audio transcribed');
  assert.equal(paid.inputTokens, 300);
});

test('a single import, a retry after a failed request and a resume are each recorded', async t => {
  const f = await fixture(t, { failFirstTranscribe: true });
  const path = await f.file('one.wav', 4);
  const first = await f.service.call('audio.import', { path });
  const failed = await settleJob(f.service, first.jobId);
  const afterFailure = today(await f.usage(), 'paid');
  assert.ok(afterFailure.requests >= 1, 'the attempt that failed is still a request');
  assert.ok(afterFailure.failures >= 1);
  if (failed.status !== 'complete') await settleJob(f.service, (await f.service.call('audio.retry', { jobId: first.jobId })).jobId);
  const afterRetry = today(await f.usage(), 'paid');
  assert.ok(afterRetry.success >= 1, 'the retry that worked is recorded');
  const before = afterRetry.requests;
  // The same recording again finds its saved result: no request goes out, and the ledger agrees with the network.
  const callsBefore = f.calls.length;
  await settleJob(f.service, (await f.service.call('audio.import', { path })).jobId);
  assert.equal(f.calls.length, callsBefore, 'nothing was sent');
  assert.equal(today(await f.usage(), 'paid').requests, before);
});

for (const [name, keys, tier] of [['SiliconFlow', { siliconflowKey: SF }, 'siliconflow'], ['Groq', { groqKey: GROQ }, 'groq'], ['Gemini free', { freeKey: FREE }, 'free']]) {
  test(`${name} transcription of a batch is recorded under ${tier}`, async t => {
    const f = await fixture(t, { keys });
    const paths = [await f.file('a.wav', 1), await f.file('b.wav', 2)];
    const job = await settleJob(f.service, (await f.service.call('audio.import', { files: paths.map(path => ({ path })) })).jobId);
    assert.equal(job.status, 'complete', job.stage);
    assert.equal(today(await f.usage(), tier).requests, 2);
  });
}

test('text requests of the Gemini text model are recorded too (the DSH model is not a provider request)', async t => {
  const f = await fixture(t, { host: false });
  const job = await settleJob(f.service, (await f.service.call('audio.import', { path: await f.file('t.wav', 5) })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  const paid = today(await f.usage(), 'paid');
  const modelCalls = f.calls.filter(url => /:generateContent$/.test(new URL(url).pathname)).length;
  assert.ok(modelCalls >= 4);
  assert.equal(paid.requests, modelCalls, 'every generateContent call is in the ledger');
});

test('a request the classifier does not know is recorded as "other", never dropped', async t => {
  const f = await fixture(t);
  const wrapped = audioUsageFetch({ ...(await readAudioSettings()) }, async () => json({ ok: true }));
  // A Gemini endpoint that is not generateContent (known key), a new provider host, and a key that is not any configured key.
  await wrapped('https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent', { headers: { 'x-goog-api-key': PAID } });
  await wrapped('https://api.newprovider.example/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer something-else-entirely' } });
  await wrapped('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', { headers: { 'x-goog-api-key': 'AIzaNotConfigured_00000000000000' } });
  const usage = await f.usage();
  assert.equal(usage.other?.today?.requests, 2, 'the usage summary carries an "other" bucket');
  assert.equal(usage.providers.find(provider => provider.tier === 'paid').today.requests, 1, 'the one with a configured key stays with its provider');
});

test('a recording whose requests cannot be written to the ledger says so in the log and the job diagnostics', async t => {
  const f = await fixture(t, { brokenLedger: true });
  const logged = [], original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const job = await settleJob(f.service, (await f.service.call('audio.import', { path: await f.file('x.wav', 6) })).jobId);
    assert.equal(job.status, 'complete', 'the import itself is not stopped by a ledger problem');
    assert.ok(job.diagnostics?.some(text => /could not be written to the usage ledger|none was recorded/.test(text)), JSON.stringify(job.diagnostics));
    assert.ok(logged.some(line => /\[study\] audio usage:/.test(line)));
  } finally { console.error = original; }
});

test('a healthy ledger leaves the job without diagnostics', async t => {
  const f = await fixture(t);
  const job = await settleJob(f.service, (await f.service.call('audio.import', { path: await f.file('ok.wav', 7) })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.diagnostics, undefined);
});

test('a resumed recording labels the transcript it reused, and sends no transcription request for it', async t => {
  const f = await fixture(t);
  const path = await f.file('resume.wav', 8);
  f.flags.breakText = true;
  const first = await settleJob(f.service, (await f.service.call('audio.import', { path })).jobId);
  assert.equal(first.status, 'failed');
  assert.deepEqual([first.steps.transcribe.done, first.steps.transcribe.reused ?? 0], [1, 0], 'the first run paid for the audio');
  const transcriptions = f.calls.filter(url => url.includes('transcribe:')).length;
  f.flags.breakText = false;
  const resumed = await settleJob(f.service, (await f.service.call('audio.retry', { jobId: first.id })).jobId);
  assert.equal(resumed.status, 'complete', resumed.stage);
  assert.deepEqual([resumed.steps.transcribe.done, resumed.steps.transcribe.total, resumed.steps.transcribe.reused], [1, 1, 1], 'the saved transcript was reused');
  assert.equal(f.calls.filter(url => url.includes('transcribe:')).length, transcriptions, 'nothing was sent to the transcription provider');
});

test('the console reads the ledger incrementally: finished days are not read again, appended lines are picked up', async t => {
  const f = await fixture(t);
  const directory = join(f.dir, 'home', 'study', 'audio-usage');
  await mkdir(directory, { recursive: true });
  const settings = await readAudioSettings(), day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const line = (n, extra = {}) => JSON.stringify({ type: 'request', tier: 'paid', keyId: keyId(PAID), model: settings.transcribeModel, status: 200, at: Date.now() - n * 86400000 - 3600000, ...extra }) + '\n';
  const old = join(directory, `${day(3)}.jsonl`);
  await writeFile(old, line(3).repeat(5));
  const total = async () => (await f.usage()).providers.find(provider => provider.tier === 'paid').total.requests;
  assert.equal(await total(), 5);
  // Replace the finished day with a same-sized file and give it back its old modification time: it was not read again.
  const info = await stat(old);
  await writeFile(old, line(3, { status: 500 }).repeat(5).slice(0, info.size).padEnd(info.size, '\n'));
  await utimes(old, info.atime, info.mtime);
  assert.equal((await f.usage()).providers.find(provider => provider.tier === 'paid').total.failures, 0, 'unchanged size and time: the earlier counters are reused');
  // A new line at the end of today's file is read on its own.
  await writeFile(join(directory, `${day(0)}.jsonl`), line(0).repeat(2));
  assert.equal(await total(), 7);
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(directory, `${day(0)}.jsonl`), line(0));
  assert.equal(await total(), 8);
  assert.ok((await readdir(directory)).length >= 2);
});

test('the console does not take seconds on a large ledger (a month of heavy use)', async t => {
  const f = await fixture(t);
  const directory = join(f.dir, 'home', 'study', 'audio-usage');
  await mkdir(directory, { recursive: true });
  const settings = await readAudioSettings();
  for (let d = 0; d < 31; d++) {
    const name = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10), base = Date.now() - d * 86400000 - 7200000;
    const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'request', tier: 'paid', keyId: keyId(PAID), model: i % 3 ? settings.textModel : settings.transcribeModel,
      status: 200, at: base - i * 1000, inputTokens: 1000, outputTokens: 100, audioSeconds: 0 }));
    await writeFile(join(directory, `${name}.jsonl`), lines.join('\n') + '\n');
  }
  const started = performance.now();
  const first = await f.usage();
  const cold = performance.now() - started, again = performance.now();
  await f.usage();
  const warm = performance.now() - again;
  assert.ok(first.providers.find(provider => provider.tier === 'paid').total.requests > 60000);
  assert.ok(cold < 4000, `reading 62000 lines took ${Math.round(cold)} ms`);
  assert.ok(warm < 400, `a refresh with nothing new took ${Math.round(warm)} ms`);
});

test('the DSH sub-agents of an import carry a readable title: step, recording and part (#213)', async t => {
  const f = await fixture(t);
  const job = await settleJob(f.service, (await f.service.call('audio.import', { path: await f.file('Database Lecture.wav', 9) })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(f.flags.stages.some(stage => /^音频校对 · Database Lecture · 1\/\d+$/.test(stage)), f.flags.stages.join(' | '));
  assert.ok(f.flags.stages.some(stage => /^音频翻译 · Database Lecture · 1\/\d+$/.test(stage)), f.flags.stages.join(' | '));
  const { subagentTitle } = await import('../lib/audio-job.js');
  assert.equal(subagentTitle({ filename: 'lesson.mp3', language: 'en' }, { kind: 'proofread', part: 3, parts: 31 }), 'Audio proofreading · lesson · 3/31');
  assert.equal(subagentTitle({ filename: 'lesson.mp3' }, { kind: 'title', stage: '生成标题' }), '音频标题 · lesson');
});
