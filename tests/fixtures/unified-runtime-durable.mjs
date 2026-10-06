// Durable lifecycle over a real manifest store with a controlled native executor.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../../lib/runtime/work.js';
import { createManifestJobStore } from '../../lib/jobs/store.js';
import { saveAudioBatch } from '../../lib/audio-batch.js';

export async function durableFixture(t, run, { recoveryMode = 'retry-from-start', pauseMode = 'unsupported', notifications = [], waitForDelivery = false, admit } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'durable-life-')), id = 'single-fixture-1';
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'audio-batches', id), { recursive: true });
  await saveAudioBatch(root, { id, kind: 'single', job: { id: 'legacy' } });
  const store = createManifestJobStore(join(root, 'audio-batches', id, 'manifest.json'));
  const inputRef = { id, hash: 'original-input', size: 42 };
  let starts = 0, state = 'lost', invalid;
  const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'test-process' }),
    inspect: () => ({ state, reason: 'controlled-fixture' }), start({ run, cancel }) { const id = `native-${++starts}`; void run(); return { id, ownerAgentId: 'actual-test-owner', stop: cancel, append() {} }; } };
  const ctx = new Context(), work = createRuntimeWork(), lifecycle = createJobLifecycle(root, work);
  const definition = { kind: 'persist', version: 1, capabilities: { retry: true, recoveryMode, pauseMode },
    persistence: { open: async input => ({ store, inputRef, input, notifications, waitForDelivery,
      validateInput: async () => { if (invalid) throw Object.assign(new Error(invalid), { code: invalid }); }, validateCheckpoint: async () => {}, reconcileCommit: async () => null }) }, run, ...(admit ? { admit } : {}) };
  lifecycle.register(ctx, 'persist.v1', definition);
  const owner = Symbol('owner'), port = lifecycle.scoped({ owner, domain: 'persist.v1', executor });
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  return { root, lifecycle, port, store, definition, ctx, executor, starts: () => starts, setState: value => { state = value; }, invalidate: value => { invalid = value; } };
}
