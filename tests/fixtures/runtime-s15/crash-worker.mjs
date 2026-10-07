import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { Store } from '../../../lib/store.js';
import { createSingleAudioPersistence } from '../../../lib/audio-runtime-store.js';
import { createJobLifecycle } from '../../../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../../../lib/runtime/work.js';
import { dshJobExecutor } from '../../../lib/jobs/executor.js';

export function crashRuntime(root, singleId, window = 'recover', { slowReconcile } = {}) {
  const library = new Store(root), real = createSingleAudioPersistence(root, { library });
  // `slowReconcile`: a promise the checking of a recorded publication waits for (a check that takes long, as on a loaded disk).
  const persistence = slowReconcile ? { ...real, async open(input) { const port = await real.open(input); return { ...port, reconcileCommit: async commit => { await slowReconcile; return port.reconcileCommit(commit); } }; } } : real;
  const ctx = new Context(), agent = { id: `fixture-agent-${process.pid}` }; let sequence = 0;
  // Controlled native-service double. Process death and the real library/ledger
  // files are exercised here; actual rc.2 binding has a separate manual probe.
  const hooks = new Map();
  const jobs = { start(spec) { const id = `fixture-native-${++sequence}`; const run = spec.run({ append() {} }); hooks.set(id, run); return id; },
    kill(id, owner, reason) { hooks.get(id)?.cancel(reason); }, get() { throw new Error('unknown fixture job'); } };
  const executor = dshJobExecutor({ get: key => key === 'jobs' ? jobs : key === 'agents' ? { get: id => id === agent.id ? agent : null } : null }, agent);
  const lifecycle = createJobLifecycle(root, createRuntimeWork());
  lifecycle.register(ctx, 'audio.v1', { kind: 'audio-import', version: 1, capabilities: { retry: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint' }, persistence,
    run: async context => {
      const port = await persistence.open({ singleId }); let prepared;
      try { prepared = await port.readPreparedArtifacts('publish:single'); }
      catch {
        const step = context.gateway.step('transcript:1', { purpose: 'transcribe', feature: 'audio', requestedEffort: 'default', executionMode: 'direct', budget: null });
        const text = await step.run(() => step.observe({ boundary: 'host-attempt', kind: 'transcribe' }, async () => {
          await appendFile(join(root, 'fake-model-calls.jsonl'), '{"localFake":true}\n');
          if (window === 'during-request') process.exit(74);
          return { value: 'Synthetic saved transcript.', tokenUsage: { uncachedInputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        }));
        prepared = await port.prepareArtifacts('publish:single', [{ id: 'audio-fixture-source', title: 'Crash fixture', text, createdAt: new Date().toISOString(), audio: { hash: port.inputRef.hash } }]);
      }
      const receipt = await context.commitArtifact('publish:single', async () => prepared, { publish: async (value, guard) => {
        if (window === 'before-artifact') process.exit(71);
        const receipt = await port.publishArtifacts(value, guard);
        if (window === 'after-artifact') process.exit(72);
        return receipt;
      } });
      await context.saveCheckpoint(receipt.checkpoint);
      if (window === 'after-checkpoint') process.exit(73);
      return { refs: receipt.refs };
    } });
  return { library, lifecycle, port: lifecycle.scoped({ owner: Symbol('fixture-owner'), domain: 'audio.v1', executor }), dispose: async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, singleId, window] = process.argv.slice(2), runtime = crashRuntime(root, singleId, window);
  const job = await runtime.port.submit('audio-import', { singleId }); await runtime.port.wait(job.jobId); await runtime.dispose();
}
