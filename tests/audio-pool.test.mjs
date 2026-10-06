import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finishTranscript } from '../lib/audio-import.js';
import { readAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { SWITCH_MODE, audioSwitch } from './helpers/audio-switch.mjs';

/* WP-AU #212: the text steps run on a sliding pool (a finished window is replaced at once), results are collected
   in source order, and the files of a batch overlap: file N+1 is transcribed while file N is proofread and translated. */

const paragraphs = Array.from({ length: 9 }, (_, index) => `Window ${index + 1}: ` + 'lecture evidence '.repeat(260));
const answer = (prompt, options) => options.kind === 'proofread' ? '{"corrections":[]}'
  : options.kind === 'translate' ? JSON.stringify({ titleEn: `Part ${options.part}`, titleZh: `部分 ${options.part}`,
    paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: `Translation ${options.part}` })) }) : '{"titleEn":"Lecture"}';

/** A fake text model whose calls stay open until the test settles them; it records how many calls were open at every start and end. */
function fixture(t, settings = {}, text = paragraphs) {
  const controller = new AbortController(), files = new Map(), pending = new Map(), timeline = [], prompts = [];
  let active = 0, maximum = 0;
  const saved = { get: async name => files.get(name), set: async (name, value) => files.set(name, value) };
  const complete = async (system, prompt, options) => {
    if (!['proofread', 'translate'].includes(options.kind)) return answer(prompt, options);
    const key = `${options.kind}:${options.part}`;
    prompts.push([key, JSON.parse(prompt)]);
    active++; maximum = Math.max(maximum, active); timeline.push({ event: 'start', key, active });
    try {
      await new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        pending.set(key, { resolve: () => { options.signal.removeEventListener('abort', abort); resolve(); },
          reject: error => { options.signal.removeEventListener('abort', abort); reject(error); } });
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
      return answer(prompt, options);
    } finally { pending.delete(key); active--; timeline.push({ event: 'end', key, active }); }
  };
  const run = () => finishTranscript({ paragraphs: text, filename: 'lecture.wav', settings, complete, saved,
    keys: { raw: 'r', text: 't' }, signal: controller.signal });
  t.after(() => controller.abort());
  return { run, controller, files, pending, timeline, prompts, get active() { return active; }, get maximum() { return maximum; } };
}
const open = f => [...f.pending.keys()].sort();
const settle = f => { for (const request of [...f.pending.values()]) request.resolve(); };

test('a slow window never idles the other slots: a finished window is replaced at once', async t => {
  const f = fixture(t), work = f.run();
  work.catch(() => {});
  await until(() => f.pending.size === 3, 'the first three windows');
  assert.deepEqual(open(f), ['proofread:1', 'proofread:2', 'proofread:3']);
  // Window 1 is the slow one; the others finish and each is replaced the moment it ends.
  f.pending.get('proofread:2').resolve();
  await until(() => f.pending.has('proofread:4'), 'window 4 to take the freed slot');
  assert.equal(f.active, 3, 'three windows in flight while window 1 is still running');
  f.pending.get('proofread:3').resolve();
  await until(() => f.pending.has('proofread:5'), 'window 5 to take the freed slot');
  f.pending.get('proofread:5').resolve(); f.pending.get('proofread:4').resolve();
  await until(() => f.pending.has('proofread:7') && f.pending.has('proofread:6'), 'windows 6 and 7');
  assert.equal(f.active, 3);
  f.pending.get('proofread:6').resolve(); f.pending.get('proofread:7').resolve();
  await until(() => f.pending.has('proofread:9') && f.pending.has('proofread:8'), 'windows 8 and 9');
  assert.deepEqual(open(f), ['proofread:1', 'proofread:8', 'proofread:9']);
  assert.ok(!f.timeline.some(item => item.event === 'start' && item.key.startsWith('translate')), 'translation waits for all corrected text');
  assert.equal(f.maximum, 3);
  // Release the rest: translation then runs on the same pool.
  const finish = (async () => { for (let i = 0; i < 200 && f.timeline.filter(x => x.event === 'end').length < 18; i++) { settle(f); await new Promise(r => setTimeout(r, 2)); } })();
  const result = await work; await finish;
  assert.equal(f.maximum, 3);
  assert.equal(f.active, 0);
  const text = result.documents.join('');
  for (let i = 1; i < 9; i++) {
    assert.ok(text.indexOf(`Window ${i}:`) < text.indexOf(`Window ${i + 1}:`), 'source order is kept');
    assert.ok(text.indexOf(`Translation ${i}`) < text.indexOf(`Translation ${i + 1}`), 'translations keep source order');
  }
});

test('corrections found by finished windows reach windows that start later, whichever order they finished in', async t => {
  const seen = [], controller = new AbortController(), release = new Map();
  const hold = key => new Promise(resolve => release.set(key, resolve));
  const work = finishTranscript({ paragraphs: paragraphs.slice(0, 5), filename: 'lecture.wav', settings: {}, signal: controller.signal,
    saved: { get: async () => null, set: async () => {} }, keys: { raw: 'r', text: 't' },
    complete: async (system, prompt, options) => {
      if (options.kind !== 'proofread') return answer(prompt, options);
      const input = JSON.parse(prompt), n = options.part;
      seen.push([n, input.knownFixes.map(item => item.right)]);
      if (n === 1) await hold('first');
      return JSON.stringify({ corrections: [{ wrong: `Window ${n}`, right: `Section ${n}`, context: `Window ${n}: lecture evidence`, reason: 'term', confidence: 'high' }] });
    } });
  await until(() => release.has('first') && seen.length >= 5, 'the pool to run past the slow first window');
  assert.deepEqual(seen.slice(0, 3).map(([n]) => n), [1, 2, 3]);
  const four = seen.find(([n]) => n === 4)[1], five = seen.find(([n]) => n === 5)[1];
  assert.ok(four.every(right => ['Section 2', 'Section 3'].includes(right)), 'window 4 never sees the unfinished window 1');
  assert.ok(five.includes('Section 2') && five.includes('Section 3'));
  release.get('first')();
  const result = await work;
  assert.equal(result.corrections.applied.length, 5, 'every window is applied, in source order');
  assert.deepEqual(result.corrections.applied.map(item => item.wrong), [1, 2, 3, 4, 5].map(n => `Window ${n}`));
});

test('cancelling mid-pool aborts every window in flight and starts none after it', async t => {
  const f = fixture(t), work = f.run();
  work.catch(() => {});
  await until(() => f.pending.size === 3, 'first three windows');
  f.pending.get('proofread:2').resolve();
  await until(() => f.pending.has('proofread:4'), 'window 4');
  const started = f.timeline.filter(item => item.event === 'start').length;
  f.controller.abort(new Error('learner stopped'));
  await assert.rejects(work, /learner stopped/);
  assert.equal(f.active, 0);
  assert.equal(f.timeline.filter(item => item.event === 'start').length, started, 'no window starts after the cancel');
});

test('a fatal failure in one slot stops the siblings and keeps finished windows reusable', async t => {
  const f = fixture(t), work = f.run();
  work.catch(() => {});
  await until(() => f.pending.size === 3, 'first three windows');
  f.pending.get('proofread:2').resolve();
  await until(() => f.pending.has('proofread:4'), 'window 4');
  f.pending.get('proofread:1').reject(Object.assign(new Error('invalid key'), { fatal: true }));
  await assert.rejects(work, /校对第 1\/9 段失败：invalid key/);
  assert.equal(f.active, 0);
  assert.ok([...f.files.keys()].some(name => name.includes('-1-')), 'window 2 stays saved');
});

test('text concurrency is a setting from 1 to 6 (default 3)', async t => {
  const home = await mkdtemp(join(tmpdir(), 'audio-pool-settings-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  await mkdir(join(home, 'study'));
  assert.equal((await readAudioSettings()).textConcurrency, 3);
  for (const count of [1, 2, 3, 4, 5, 6]) assert.equal((await saveAudioSettings({ textConcurrency: count })).textConcurrency, count);
  for (const bad of [0, 7, 2.5, '3x']) await assert.rejects(saveAudioSettings({ textConcurrency: bad }), /1 到 6/);
  // A file written by an older version, or edited by hand, never lets a value outside the limits through.
  await writeFile(join(home, 'study', 'audio.json'), JSON.stringify({ textConcurrency: 99 }));
  assert.equal((await readAudioSettings()).textConcurrency, 3);
});

test('a pool of one window at a time runs windows strictly one after another', async t => {
  const f = fixture(t, { textConcurrency: 1 }, paragraphs.slice(0, 4)), work = f.run();
  work.catch(() => {});
  for (let n = 1; n <= 4; n++) {
    await until(() => f.pending.has(`proofread:${n}`), `window ${n}`);
    assert.equal(f.pending.size, 1);
    f.pending.get(`proofread:${n}`).resolve();
  }
  f.controller.abort(new Error('enough'));
  await assert.rejects(work, /enough/);
  assert.equal(f.maximum, 1);
});

/* ---- batch pipeline ---- */

const KEY = 'AIzaPipelineTest_000000000000001';
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
function wav(fill) {
  const data = Buffer.alloc(16000, fill), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const lecture = Array.from({ length: 700 }, (_, i) => `Sentence ${i} about databases and indexes.`).join(' ');

async function batch(t, { textConcurrency = 3, files = 3, text = lecture } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-pool-batch-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const log = [], text_ = { active: 0, maximum: 0 }, held = new Map();
  let hold = null;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('transcribe:')) {
      const name = Buffer.from(body.contents[0].parts.find(p => p.inlineData).inlineData.data, 'base64').at(-1);
      log.push(`transcribe:${name}`);
      return reply(text);
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    if (kind === 'title') return reply('{"titleEn":"T"}');
    text_.active++; text_.maximum = Math.max(text_.maximum, text_.active);
    log.push(kind);
    try {
      if (hold && kind === 'proofread' && !held.has('first')) {
        await new Promise((resolve, reject) => { held.set('first', resolve); init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
      }
      // On the runtime each call is first saved as an intent, one write after another: the fake model must be slower than that for calls to overlap.
      await new Promise(resolve => setTimeout(resolve, SWITCH_MODE === 'runtime' ? 150 : 3));
      if (kind === 'proofread') return reply('{"corrections":[]}');
      const payload = JSON.parse(prompt);
      return reply(JSON.stringify({ titleZh: '标', titleEn: 'T', paragraphs: payload.paragraphs.map(p => ({ n: p.n, zh: 'x' })) }));
    } finally { text_.active--; }
  };
  const service = new StudyService(join(dir, 'library'), { fetch, ...audioSwitch() });
  await service.call('audio.settings.set', { paidKey: KEY, textProvider: 'gemini', textConcurrency });
  const members = [];
  for (let n = 1; n <= files; n++) { const path = join(dir, `f${n}.wav`); await writeFile(path, wav(n)); members.push({ path }); }
  t.after(async () => { for (const release of held.values()) release(); await service.call('job.cancel', { all: true }); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  return { service, members, log, held, text: text_, holdFirstProofread: () => { hold = true; } };
}

test('file 2 and 3 are transcribed while file 1 is still being proofread', async t => {
  const f = await batch(t);
  f.holdFirstProofread();
  const started = await f.service.call('audio.import', { files: f.members });
  await until(() => f.held.has('first'), 'file 1 proofreading to be open');
  await until(() => f.log.filter(item => item.startsWith('transcribe')).length === 3, 'files 2 and 3 to be transcribed during the proofread of file 1');
  assert.deepEqual(f.log.filter(item => item.startsWith('transcribe')), ['transcribe:1', 'transcribe:2', 'transcribe:3']);
  f.held.get('first')();
  const job = await settleJob(f.service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.equal((await f.service.call('snapshot')).sources.length, 1);
});

test('the DSH/text model is limited by the text pool across all files of a batch', async t => {
  const f = await batch(t, { textConcurrency: 2 });
  const started = await f.service.call('audio.import', { files: f.members });
  const job = await settleJob(f.service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(f.text.maximum >= 2, 'the pool is used');
  assert.ok(f.text.maximum <= 2, `text calls in flight never exceed the setting (saw ${f.text.maximum})`);
});
