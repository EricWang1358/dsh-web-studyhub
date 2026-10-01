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

test('one recording overlaps three windows, checkpoints out of order and assembles in source order', async t => {
  const f = fixture(t), work = f.run();
  work.catch(() => {});
  await until(() => f.pending.size === 3);
  assert.deepEqual(f.calls, ['proofread:1', 'proofread:2', 'proofread:3']);
  f.pending.get('proofread:3').resolve(); f.pending.get('proofread:2').resolve();
  await until(() => f.files.size === 2);
  assert.equal(f.calls.length, 3, 'later waves wait for the shared terminology boundary');
  assert.ok(!f.calls.some(key => key.startsWith('translate')), 'translation waits for all corrected text');
  f.pending.get('proofread:1').resolve();
  for (const keys of [['proofread:4', 'proofread:5', 'proofread:6'], ['proofread:7'],
    ['translate:1', 'translate:2', 'translate:3'], ['translate:4', 'translate:5', 'translate:6'], ['translate:7']]) {
    await until(() => keys.every(key => f.pending.has(key)));
    for (const key of keys.toReversed()) f.pending.get(key).resolve();
  }
  const result = await work;
  assert.equal(f.maximum, 3);
  assert.equal(f.active, 0);
  for (let i = 1; i < 7; i++) {
    assert.ok(result.documents.join('').indexOf(`Window ${i}:`) < result.documents.join('').indexOf(`Window ${i + 1}:`));
    assert.ok(result.documents.join('').indexOf(`Translation ${i}`) < result.documents.join('').indexOf(`Translation ${i + 1}`));
  }
  for (const phase of ['proofread', 'translate'])
    assert.deepEqual(f.progress.filter(p => p.phase === phase).map(p => p.done), Array.from({ length: 8 }, (_, n) => n));
});

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

test('waves share prior terminology and translation consumes corrections in source order', async () => {
  const contexts = { proofread: [], translate: [] };
  const result = await finishTranscript({ paragraphs, filename: 'lecture.wav', settings: {},
    saved: { get: async () => null, set: async () => {} }, keys: { raw: 'r', text: 't' },
    complete: async (system, prompt, options) => {
      if (options.kind === 'title') return answer(prompt, options);
      const input = JSON.parse(prompt);
      contexts[options.kind].push(input);
      if (options.kind === 'proofread') return JSON.stringify({ corrections: [{ wrong: `Window ${options.part}`,
        right: `Section ${options.part}`, context: `Window ${options.part}: lecture evidence`, reason: 'Correct terminology', confidence: 'high' }] });
      return answer(prompt, options);
    } });
  assert.deepEqual(contexts.proofread.slice(0, 3).map(input => input.knownFixes), [[], [], []]);
  for (const input of contexts.proofread.slice(3, 6)) assert.deepEqual(input.knownFixes.map(fix => fix.right), ['Section 1', 'Section 2', 'Section 3']);
  assert.equal(result.corrections.applied.length, 7);
  assert.deepEqual(contexts.translate.slice(0, 3).map(input => input.previousTitles), [[], [], []]);
  for (const input of contexts.translate.slice(3, 6)) assert.deepEqual(input.previousTitles, ['Part 1', 'Part 2', 'Part 3']);
  assert.deepEqual(contexts.translate.map(input => input.paragraphs[0].text.slice(0, 10)), Array.from({ length: 7 }, (_, i) => `Section ${i + 1}:`));
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
  assert.equal(f.calls.length, 3);
  const retried = [];
  await finishTranscript({ paragraphs, filename: 'lecture.wav', settings: {}, saved: f.saved, keys: { raw: 'r', text: 't' },
    complete: async (system, prompt, options) => { retried.push(`${options.kind}:${options.part}`); return answer(prompt, options); } });
  assert.ok(!retried.includes('proofread:2'), 'successful sibling does not need another request');
  assert.equal(retried.filter(key => key.startsWith('proofread')).length, 6);
});

test('legacy recording parallelism becomes serial and text parallelism is limited to two or three', async t => {
  const home = await mkdtemp(join(tmpdir(), 'audio-window-settings-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  await mkdir(join(home, 'study'));
  await writeFile(join(home, 'study', 'audio.json'), JSON.stringify({ audioConcurrency: 6, paidKey: 'AIzaExistingKey_0000000000001' }));
  const effective = await readAudioSettings();
  assert.equal(effective.audioConcurrency, 1);
  assert.equal(effective.textConcurrency, 3);
  assert.equal((await saveAudioSettings({ textConcurrency: 2 })).paidKey, effective.paidKey);
  assert.equal((await readAudioSettings()).textConcurrency, 2);
  await assert.rejects(saveAudioSettings({ textConcurrency: 4 }), /2 或 3/);
  await assert.rejects(saveAudioSettings({ textConcurrency: 1 }), /2 或 3/);
});
