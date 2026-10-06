import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { wav, TEST_KEY } from '../audio-single-characterization-process.mjs';

export async function probePublicAudio({ ctx, parent, sibling, until, config }) {
  const rootContext = ctx.root || ctx;
  const host = await until(() => rootContext[Symbol.for('studyhub.workbench.host.v1')], 'installed StudyHub workbench');
  const api = rootContext.get('studyRuntime');
  assert.ok(api?.requestServices, 'installed runtime API unavailable');
  const native = await api.requestServices({ agent: parent });
  assert.equal(native.workOwner, host.services.workOwner);
  assert.equal(native.runtimePilot?.audioSingle, true, 'public pilot configuration did not reach request services');
  const require = createRequire(join(process.env.DSH_HOME, 'profiles/studyhub-e2e/package.json'));
  const packageRoot = dirname(require.resolve('@ericwang1358/dsh-daily-flashcard/package.json'));
  const files = ['lib/contexts/audio/jobs/single-import.js', 'lib/jobs/lifecycle.js', 'lib/jobs/gateway.js', 'lib/audio-runtime-store.js', 'lib/audio-import.js', 'lib/index.js'];
  const fingerprints = Object.fromEntries(await Promise.all(files.map(async file => {
    const installed = await readFile(join(packageRoot, file)), expected = await readFile(join(config.sourceRoot, file));
    assert.equal(createHash('sha256').update(installed).digest('hex'), createHash('sha256').update(expected).digest('hex'), `installed source differs: ${file}`);
    return [file, createHash('sha256').update(installed).digest('hex')];
  })));
  const root = await api.resolveWorkspace({ agent: parent }), runtime = api.forLibrary(root);
  let release, transcriptions = 0;
  const fetch = async (url, options) => {
    assert.ok(String(url).includes('transcribe:'), 'fixture refuses non-transcription HTTP');
    transcriptions++;
    await new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      release = () => { options.signal.removeEventListener('abort', abort); resolve(); };
      options.signal.addEventListener('abort', abort, { once: true });
    });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Today we study databases and transaction boundaries.' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 } }));
  };
  const services = { ...native, fetch }, call = (action, args = {}) => runtime.call(action, args, services);
  await call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1, textConcurrency: 2 });
  const baseline = await call('snapshot'), suffix = Date.now();
  const path = join(config.workspace, `s16-native-${suffix}.wav`), bytes = wav(); bytes.writeUInt32LE(suffix % 2 ** 32, bytes.length - 4); await writeFile(path, bytes);
  const first = await call('audio.import', { path, courses: ['S1-6 native fixture'] });
  await until(() => transcriptions === 1, 'public native transcription held');
  const snapshot = () => call('snapshot');
  const find = async id => (await snapshot()).jobs.find(job => job.id === id);
  let observed = await find(first.jobId);
  assert.equal(observed.contract.contractVersion, 2);
  const firstNative = observed.contract.runtime.attempts.at(-1).executor;
  assert.equal(firstNative.ownerAgentId, parent.id);
  const jobService = ctx.get('jobs'); assert.equal(jobService.get(firstNative.handleId, parent.id).owner, parent.id);
  assert.throws(() => jobService.get(firstNative.handleId, sibling.id));
  const queuedPath = join(config.workspace, `s16-queued-${suffix}.wav`), queuedBytes = wav(); queuedBytes[queuedBytes.length - 1] = 7; await writeFile(queuedPath, queuedBytes);
  const second = await call('audio.import', { path: queuedPath });
  assert.equal(second.queuedBehind, 1, 'public queued receipt must retain the actual gate position');
  await until(async () => (await find(second.jobId)).contract.status === 'queued', 'public native queued job');
  await call('job.control', { jobId: second.jobId, action: 'pause' });
  await until(async () => (await find(second.jobId)).contract.status === 'paused', 'queued native checkpoint');
  await call('job.control', { jobId: second.jobId, action: 'resume' });
  await call('job.control', { jobId: second.jobId, action: 'cancel' });
  const cancelled = await call('job.wait', { jobId: second.jobId }); assert.equal(cancelled.status, 'cancelled');
  assert.equal(transcriptions, 1, 'queued native pause/resume/cancel must not dispatch');
  await call('job.control', { jobId: first.jobId, action: 'pause' }); release();
  await until(async () => (await find(first.jobId)).contract.status === 'paused', 'transcription safely checkpointed');
  await call('job.control', { jobId: first.jobId, action: 'resume' });
  const done = await call('job.wait', { jobId: first.jobId }); assert.equal(done.status, 'complete', done.stage);
  observed = await find(first.jobId);
  const modelCalls = observed.contract.calls.filter(call => call.modelRequest), children = modelCalls.filter(call => call.runner === 'subagent');
  assert.equal(children.length, 3, JSON.stringify(observed.contract.calls));
  assert.ok(children.every(call => call.childId && call.parentId === parent.id && call.observation.requestCount === null));
  const output = await call('job.output', { jobId: first.jobId, callId: children[0].callId });
  assert.ok(JSON.stringify(output).includes('corrections'), 'actual child output unavailable');
  const state = await snapshot(); assert.equal(state.decks.length, baseline.decks.length); assert.equal(state.sources.length, baseline.sources.length + 1);
  assert.equal(transcriptions, 1); assert.equal(observed.contract.runtime.attempts.length, 2);
  assert.equal(observed.contract.events.filter(event => event.type === 'settled').length, 1);
  assert.equal(host.services.audioGate.active.size, 0); assert.equal(host.services.audioGate.waiting.length, 0);
  return { packageRoot, version: JSON.parse(await readFile(join(packageRoot, 'package.json'))).version, fingerprints, root,
    firstNative, finalNative: observed.contract.runtime.attempts.at(-1).executor, job: observed.contract,
    cancelled: (await find(second.jobId)).contract, transcriptions, children: children.map(call => ({ callId: call.callId, childId: call.childId, parentId: call.parentId, tokens: call.tokens })),
    sourceCount: state.sources.length - baseline.sources.length, deckCount: state.decks.length - baseline.decks.length, outputAvailable: true, gateDrained: true,
    modelBoundary: 'Actual installed rc.2 jobs and child agents; transcription is injected fake fetch, text uses only the local fake OpenAI endpoint; no real provider or paid quality validation.' };
}
