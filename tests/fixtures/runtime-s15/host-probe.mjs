import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Actual installed service preflight. No replacement controller or model calls.
export async function probeExecutorInspection({ ctx, parent, sibling, until, sourceRoot, route }) {
  const jobs = ctx.get('jobs'), done = Promise.withResolvers();
  let entered = false;
  const id = jobs.start({ owner: parent.id, kind: 's15-inspection', label: 'S1-5 executor inspection',
    run: () => { entered = true; return { done: done.promise, cancel: () => done.resolve({ status: 'killed' }) }; } });
  try {
    await until(() => entered, 'inspection executor started');
    const active = jobs.get(id, parent.id);
    assert.equal(active.id, id); assert.equal(active.owner, parent.id); assert.equal(active.status, 'running');
    assert.throws(() => jobs.get(id, sibling.id), /belongs to another session/);
    assert.throws(() => jobs.get(id), /belongs to another session/);
    const missing = `${id}-absent`;
    assert.throws(() => jobs.get(missing, parent.id), error => error.message === `unknown job ${missing}`);
    done.resolve({ status: 'completed' });
    const ended = await until(() => { const value = jobs.get(id, parent.id); return value.status === 'completed' && value; }, 'inspection executor settled');
    assert.ok(ended.finishedAt);
    const durable = await probeDurableBinding({ ctx, parent, until, sourceRoot, route });
    return { durable, service: 'dsh-jobs', ownerAgentId: parent.id, handleId: id,
      activeStatus: active.status, terminalStatus: ended.status, wrongOwnerRefused: true,
      callerlessRefused: true, missingError: 'unknown job <id>', paidModel: false,
      limitation: 'Native get is owner-scoped. Missing alone does not prove old process death; process witness/recovery wiring still required.' };
  } finally { done.resolve({ status: 'killed' }); await jobs.wait(id, 10000, parent.id); }
}

async function probeDurableBinding({ ctx, parent, until, sourceRoot, route }) {
  const load = file => import(pathToFileURL(join(sourceRoot, file)).href);
  const [{ createJobLifecycle }, { createRuntimeWork }, { dshJobExecutor }, { createSingleAudioPersistence }, { prepareSingleAudioRecord }, { Store }, { modelCompletion }] = await Promise.all([
    'lib/jobs/lifecycle.js', 'lib/runtime/work.js', 'lib/jobs/executor.js', 'lib/audio-runtime-store.js', 'lib/audio-batch.js', 'lib/store.js', 'lib/index.js',
  ].map(load));
  const root = join(process.env.DSH_HOME, 's15-durable-probe', String(Date.now())); await mkdir(root, { recursive: true });
  const path = join(root, 'input.wav'); await writeFile(path, 'synthetic fingerprint, not audio quality');
  const input = await prepareSingleAudioRecord(root, { path });
  const library = new Store(root), persistence = createSingleAudioPersistence(root, { library });
  const executor = dshJobExecutor(ctx, parent), lifecycle = createJobLifecycle(root, createRuntimeWork());
  const definition = { kind: 'audio-import', version: 1, capabilities: { retry: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint' }, persistence,
    run: async context => {
      const text = await context.gateway.step('native-text', { purpose: 'probe', feature: 'audio', requestedEffort: 'default', executionMode: 'direct', budget: { timeoutMs: 10000, maxOutputTokens: 100 } }).complete('Return short text.', 'Native durability probe.');
      const adapter = await persistence.open({ singleId: input.id });
      const receipt = await context.commitArtifact('publish:single', () => adapter.prepareArtifacts('publish:single', [{ id: 'native-durable-source', title: 'Native durability probe', text, createdAt: new Date().toISOString() }]), { publish: adapter.publishArtifacts });
      await context.saveCheckpoint(receipt.checkpoint); return { refs: receipt.refs };
    } };
  lifecycle.register(ctx, 'audio.v1', definition);
  const port = lifecycle.scoped({ owner: Symbol('durable-probe'), domain: 'audio.v1', executor,
    modelHost: { ctx: parent.ctx, sessionId: parent.id, route, complete: modelCompletion(ctx, () => route, parent.id) } });
  let restoredLife;
  try {
    const submitted = await port.submit('audio-import', { singleId: input.id }), ended = await port.wait(submitted.jobId);
    assert.equal(ended.status, 'complete', JSON.stringify(ended.error)); assert.equal(ended.calls.length, 1);
    assert.equal(ended.calls[0].accounting, 'recorded'); assert.equal(ended.calls[0].observation.requestCount, null);
    const adapter = await persistence.open({ singleId: input.id }), saved = await adapter.store.load();
    assert.equal(saved.contract.status, 'complete'); assert.equal(saved.requestIntents[0].status, 'completed');
    assert.equal(saved.contract.runtime.attempts[0].executor.ownerAgentId, parent.id);
    assert.equal(saved.commits[0].status, 'complete'); assert.ok(saved.checkpoint);
    const native = saved.contract.runtime.attempts[0].executor;
    await until(() => executor.inspect(native, saved.executorWitness).state === 'lost', 'actual durable native Job settled');
    restoredLife = createJobLifecycle(root, createRuntimeWork()); restoredLife.register(ctx, 'audio.v1', definition);
    const restoredPort = restoredLife.scoped({ owner: Symbol('restored-probe'), domain: 'audio.v1', executor });
    const restored = await restoredPort.restore('audio-import', { singleId: input.id });
    assert.equal(restored.jobId, submitted.jobId); assert.equal(restored.events.length, 1); assert.equal(restored.calls.length, 1);
    assert.equal((await library.read()).sources.length, 1);
    const files = ['lib/jobs/lifecycle.js', 'lib/jobs/executor.js', 'lib/jobs/store.js', 'lib/jobs/durability.js', 'lib/jobs/gateway.js', 'lib/atomic-json.js', 'lib/audio-runtime-store.js', 'lib/audio-batch.js', 'lib/model-usage.js', 'lib/audio-dashboard.js'];
    const fingerprints = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(sourceRoot, file))).digest('hex')])));
    return { native, status: ended.status, checkpoint: saved.checkpoint, calls: ended.calls, sourceCount: 1, restoredEventCount: restored.events.length, fingerprints,
      paidModel: false, observation: 'Actual installed rc.2 owner/job/llm with local fake adapter; current source modules, single manifest and real library writer. Installed StudyHub package unchanged.' };
  } finally { await restoredLife?.dispose(); await lifecycle.dispose(); }
}
