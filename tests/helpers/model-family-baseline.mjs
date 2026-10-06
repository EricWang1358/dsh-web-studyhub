import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostHandler } from '../../lib/host.js';

/* Shared pieces of the S4-0 model-family baseline tests (docs/plans/unified-job-runtime/s4-0-model-baseline.md). Fakes only: no model, no network. */

export const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

/** A private library folder inside this run's TEMP, removed afterwards (retries for a slow Windows filesystem). */
export async function privateRoot(t, prefix, dispose = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}

/**
 * The learner panel's own door: lib/host.js createHostHandler over a fake host whose only session works in `root`, with the given fake models
 * (`complete` for ordinary work, `light` for the coach). It resolves to the action's value and throws what the panel would have shown as an error.
 * The assistant's study_workspace tool ends in the same `service.call(action, args)` (lib/index.js runStudyTool), so a library driven through
 * this door and a library driven by `runtime.call` are the two entries the baseline compares.
 */
export function panelDoor(t, root, { complete, light = complete } = {}) {
  const disposers = [];
  const host = { sessions: { get: () => ({ header: { cwd: root } }) }, get: () => undefined, effect: setup => { disposers.push(setup()); } };
  const handle = createHostHandler(host, { libraryRoot: root, provider: 'fake', model: 'fake' }, (_route, _id, options) => (options?.light ? light : complete));
  t.after(() => { for (const dispose of disposers.reverse()) dispose?.(); });
  return async (action, args = {}) => {
    const reply = await handle('call', { sessionId: 'panel', action, args });
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.value;
  };
}
