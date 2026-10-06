import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, hostModel, library, wav } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { managedRuntimeOptions, switchOptions } from './helpers/runtime-switch.mjs';
import { createProviderResources } from '../lib/jobs/resources.js';
import { settleJob } from './helpers/wait.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// S2-3: the text windows of an audio job on the runtime. One layer grants the permits (the text pool, which also owns the 429 back-off and the
// climb back up), one layer retries transient failures (the model retry); the gateway only observes each attempt as a call of its own.

const LECTURE = Array.from({ length: 9 }, (_, index) => `Window ${index + 1}: ${'lecture evidence '.repeat(260)}`).join('\n\n');
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
const transcribing = async () => reply(LECTURE);
const CALL_MS = 120;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A host text model that refuses (429) a call made while more than `capacity` are open; `failFirst` fails the first call of a kind with a 503. */
function fakeHost({ capacity = Infinity, failFirst } = {}) {
  const answer = hostModel([]), stats = { active: 0, peak: 0, refused: 0, calls: [] }, failed = new Set();
  const complete = async (system, prompt, options = {}) => {
    stats.active++;
    try {
      // Long enough for the calls to overlap: the runtime saves an intent for each call before it is sent, one write after another.
      await pause(CALL_MS);
      if (stats.active > capacity) { stats.refused++; throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }); }
      const text = await answer(system, prompt, options);
      const kind = system.startsWith('You translate') ? 'translate' : system.startsWith('You proofread') ? 'proofread' : 'title';
      stats.calls.push(kind);
      if (kind === failFirst && !failed.has(kind)) { failed.add(kind); throw Object.assign(new Error('503 service unavailable'), { status: 503 }); }
      stats.peak = Math.max(stats.peak, stats.active);
      return text;
    } finally { stats.active--; }
  };
  return { complete, stats };
}

async function hostLibrary(t, host) {
  const lib = await library(t, { fetch: transcribing, complete: host.complete,
    ...switchOptions('runtime', { complete: host.complete, paths: [...AUDIO_SWITCHES] }), settings: { paidKey: KEY, textProvider: 'host', textConcurrency: 6 } });
  const file = join(lib.dir, 'lecture.wav'); await writeFile(file, wav(1));
  return { ...lib, file };
}
const cardOf = async (lib, id) => (await lib.service.call('snapshot')).jobs.find(job => job.id === id);

for (const shape of ['single', 'batch']) {
  test(`${shape}: a model that allows two at once is met by the text pool alone — it lowers, backs off and finishes, never above what the model allowed`, async t => {
    const host = fakeHost({ capacity: 2 }), lib = await hostLibrary(t, host);
    const started = await lib.service.call('audio.import', shape === 'batch' ? { files: [{ path: lib.file }] } : { path: lib.file });
    const done = await settleJob(lib.service, started.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.ok(host.stats.refused >= 1, 'the model did push back');
    assert.ok(host.stats.peak <= 2, `no more than two accepted at once (saw ${host.stats.peak})`);
    const card = await cardOf(lib, started.jobId);
    assert.deepEqual([card.parallel.text.lowest, card.parallel.text.lowered], [2, true], "it settled at what the model allows and probes upward from there");
    assert.deepEqual(card.warnings, [], 'no window was given up on');
    assert.equal(card.contract.calls.filter(call => call.status === 'failed').length, host.stats.refused, 'every refused attempt is one call of its own');
  });
}

test('a transient failure of one translation is retried once by the model retry, as a new call', async t => {
  const host = fakeHost({ failFirst: 'translate' }), lib = await hostLibrary(t, host);
  const started = await lib.service.call('audio.import', { path: lib.file });
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const asked = kind => host.stats.calls.filter(item => item === kind).length;
  assert.equal(asked('translate'), asked('proofread') + 1, 'one window per paragraph in both passes, and one translation asked twice');
  assert.equal((await cardOf(lib, started.jobId)).contract.calls.filter(call => call.status === 'failed').length, 1);
});

for (const mode of ['legacy', 'runtime']) test(`${mode}: a batch is refused while shared provider quota is on (verified for a single import only), before any job exists`, async t => {
  const owner = Symbol('audio host');
  const resources = createProviderResources({ owner, scopeId: 'audio.v1', sharedProviderQuota: true, queueTimeoutMs: 1000,
    bindings: [{ resourceRef: 'audio-provider', quotaDomainRef: 'trusted-account', routes: ['paid'], limit: 1, providerObservation: 'external-request' }] });
  const host = mode === 'runtime' ? (({ starts: _starts, ...options }) => options)(managedRuntimeOptions({ paths: [...AUDIO_SWITCHES], owner })) : { workOwner: owner };
  const lib = await library(t, { fetch: transcribing, providerResources: resources, ...host, settings: { paidKey: KEY, textProvider: 'gemini' } });
  const file = join(lib.dir, 'lecture.wav'); await writeFile(file, wav(1));
  await assert.rejects(lib.service.call('audio.import', { files: [{ path: file }] }), { code: 'capability-unverified' });
  assert.deepEqual((await lib.service.call('snapshot')).jobs, []);
});
