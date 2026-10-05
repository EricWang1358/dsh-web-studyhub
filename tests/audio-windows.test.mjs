import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finishTranscript } from '../lib/audio-import.js';
import { readAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';

const paragraphs = Array.from({ length: 7 }, (_, index) => `Window ${index + 1}: ` + 'lecture evidence '.repeat(260));
const until = async condition => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Window work did not start');
};
const answer = (prompt, options) => options.kind === 'proofread' ? '{"corrections":[]}'
  : options.kind === 'translate' ? JSON.stringify({ titleEn: `Part ${options.part}`, titleZh: `部分 ${options.part}`,
    paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: `Translation ${options.part}` })) }) : '{"titleEn":"Lecture"}';
function fixture(t, settings = {}) {
  const controller = new AbortController(), files = new Map(), pending = new Map(), calls = [], progress = [];
  let active = 0, maximum = 0;
  const saved = { get: async name => files.get(name), set: async (name, value) => files.set(name, value) };
  const complete = async (system, prompt, options) => {
    if (!['proofread', 'translate'].includes(options.kind)) return answer(prompt, options);
    const key = `${options.kind}:${options.part}`;
    calls.push(key); active++; maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        pending.set(key, { resolve: () => { options.signal.removeEventListener('abort', abort); resolve(); },
          reject: error => { options.signal.removeEventListener('abort', abort); reject(error); } });
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
      return answer(prompt, options);
    } finally { pending.delete(key); active--; }
  };
  const run = () => finishTranscript({ paragraphs, filename: 'lecture.wav', settings, complete, saved,
    keys: { raw: 'r', text: 't' }, signal: controller.signal, progress: p => progress.push(p) });
  t.after(() => controller.abort());
  return { run, controller, files, pending, calls, progress, saved, get active() { return active; }, get maximum() { return maximum; } };
}

test('two-window mode caps active calls in both text phases', async t => {
  const f = fixture(t, { textConcurrency: 2 }), work = f.run();
  work.catch(() => {});
  while (f.calls.length < 14 || f.pending.size) {
    await until(() => f.pending.size > 0);
    assert.ok(f.pending.size <= 2);
    for (const request of f.pending.values()) request.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await work;
  assert.equal(f.maximum, 2);
});

test('cancelling a recording cancels all active children and starts no later window', async t => {
  const f = fixture(t), work = f.run();
  work.catch(() => {});
  await until(() => f.pending.size === 3);
  f.controller.abort(new Error('learner stopped'));
  await assert.rejects(work, /learner stopped/);
  assert.equal(f.active, 0);
  assert.equal(f.calls.length, 3);
  assert.equal(f.files.size, 0);
});

test('a fatal child failure stops siblings while completed checkpoints remain reusable', async t => {
  const f = fixture(t), work = f.run();
  work.catch(() => {});
  await until(() => f.pending.size === 3);
  f.pending.get('proofread:2').resolve();
  await until(() => f.files.size === 1);
  f.pending.get('proofread:1').reject(Object.assign(new Error('invalid key'), { fatal: true }));
  await assert.rejects(work, /校对第 1\/7 段失败：invalid key/);
  assert.equal(f.active, 0);
  assert.equal(f.calls.length, 4, 'window 2 finished, so window 4 took its slot before the failure');
  const retried = [];
  await finishTranscript({ paragraphs, filename: 'lecture.wav', settings: {}, saved: f.saved, keys: { raw: 'r', text: 't' },
    complete: async (system, prompt, options) => { retried.push(`${options.kind}:${options.part}`); return answer(prompt, options); } });
  assert.ok(!retried.includes('proofread:2'), 'successful sibling does not need another request');
  assert.equal(retried.filter(key => key.startsWith('proofread')).length, 6);
});

test('a legacy recording-parallelism value is ignored and the limits of both concurrencies hold', async t => {
  const home = await mkdtemp(join(tmpdir(), 'audio-window-settings-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  await mkdir(join(home, 'study'));
  await writeFile(join(home, 'study', 'audio.json'), JSON.stringify({ audioConcurrency: 6, paidKey: 'AIzaExistingKey_0000000000001' }));
  const effective = await readAudioSettings();
  assert.equal(effective.audioConcurrency, undefined);
  assert.equal(effective.transcribeConcurrency, 1);
  assert.equal(effective.textConcurrency, 3);
  assert.equal((await saveAudioSettings({ textConcurrency: 2 })).paidKey, effective.paidKey);
  assert.equal((await readAudioSettings()).textConcurrency, 2);
  assert.equal((await saveAudioSettings({ transcribeConcurrency: 2 })).transcribeConcurrency, 2);
  await assert.rejects(saveAudioSettings({ textConcurrency: 7 }), /1 到 6/);
  await assert.rejects(saveAudioSettings({ textConcurrency: 0 }), /1 到 6/);
  await assert.rejects(saveAudioSettings({ transcribeConcurrency: 4 }), /1 到 3/);
});
