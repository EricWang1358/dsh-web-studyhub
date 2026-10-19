import { randomUUID } from 'node:crypto';

/*
 * The two DSH sub-agent APIs StudyHub runs its background children on.
 *
 * DSH 0.2.0 ('legacy'): `subagents.start('spawn', request)` with a per-request
 * `toolFilter` and `persona`, `startContinuable` / `drainContinuableChildren`.
 *
 * DSH 0.2.1 ('activation'): those are gone (@deepseek-ai/dsh-subagent 0.2.1-rc.2
 * lib/index.js:3036 `startActivation`, :3133 `drainChildren`). The spawn provider
 * advertises { agentOptions, agentPreset, outputSchema, depthLimit }; "the selected
 * preset owns persona and tool composition" (dsh-subagent-spawn-in-process 0.2.1-rc.2).
 * So a StudyHub child selects the `study-worker` preset StudyHub ships
 * (presets/study-worker.patch.yml: a persona, no tool rows), and the host-wide
 * tools that no preset can drop (StudyHub's study_* tools, working_directory) are
 * masked on that exact child before its first prompt, as `toolFilter: { allow: [] }`
 * did on 0.2.0. A child whose creation is not observed is not allowed to run.
 */

export const WORKER_PRESET = 'study-worker';

/** Which sub-agent API this host speaks: 'activation' (DSH 0.2.1+), 'legacy' (0.2.0), or null. */
export function subagentApi(subagents) {
  if (typeof subagents?.startActivation === 'function') return 'activation';
  if (typeof subagents?.start === 'function') return 'legacy';
  return null;
}

/** Whether the spawn provider can run a bounded, tool-less StudyHub worker on the selected route. */
export function workerCapable(ctx, subagents, provider, route) {
  const capabilities = provider?.capabilities;
  if (!capabilities || (route && !capabilities.agentOptions)) return false;
  const api = subagentApi(subagents);
  if (api === 'legacy') return !!capabilities.toolFilter;
  if (api === 'activation') return !!capabilities.agentPreset && !provider.inheritsParentContext &&
    !!ctx?.get?.('agentPresets') && typeof (ctx.root || ctx).on === 'function';
  return false;
}

/**
 * Bound one exact child the moment DSH announces it (before its first prompt): native tool presentation
 * (no PTC code-mode transport) and only the `allow`ed host-wide tools.
 */
export function boundChildTools(ctx, childId, allow = []) {
  let agent, failure, bounded = false;
  // Listen on the root: a context scoped to the parent agent (a job's host ctx is `agent.ctx`) need not see its child's announcement.
  const off = (ctx.root || ctx).on('agent/created', ({ agent: created } = {}) => {
    if (created?.id !== childId) return;
    agent = created;
    try {
      const tools = created.ctx.get('tools');
      if (typeof tools?.presentAs === 'function') tools.presentAs('native');
      tools.restrict({ allow });
      bounded = true;
    } catch (error) { failure = error; }
  });
  return { dispose: () => off?.(), agent: () => agent, bounded: () => bounded, error: () => failure };
}

/** The finished child's own events, read once it settled: what usage and failure details are folded from. */
function settledSession(agent) {
  try {
    const session = agent?.session;
    const count = Number(session?.seq);
    if (!Number.isSafeInteger(count) || count <= 0 || typeof session.eventAt !== 'function') return undefined;
    const events = [];
    for (let seq = 0; seq < count; seq += 1) events.push(session.eventAt(seq));
    return { seq: events.length, eventAt: index => events[index] };
  } catch { return undefined; }
}

/**
 * Start one StudyHub worker through `startActivation` and hand back the shape the 0.2.0 `start` gave:
 * { id, result, localAgent, dispose }. The result is returned to StudyHub only (delivery 'caller'), never
 * injected into the learner's conversation. `localAgent` is the live child while it runs; once it has
 * settled (DSH tears a settled child down before `result` resolves) it is a read-only stub with its events.
 */
export async function startWorker(ctx, subagents, request, { childId = randomUUID(), allow = [] } = {}) {
  const bound = boundChildTools(ctx, childId, allow);
  let receipt;
  try {
    receipt = await subagents.startActivation({
      provider: 'spawn', label: request.label, childId, signal: request.signal, delivery: 'caller',
      request: { parent: request.parent, prompt: request.prompt, agentPreset: WORKER_PRESET,
        ...(request.agentOptions ? { agentOptions: request.agentOptions } : {}) },
    });
  } finally { bound.dispose(); }
  if (!bound.bounded()) {
    await Promise.resolve().then(() => receipt.dispose()).catch(() => {});
    throw new Error(bound.error()
      ? `Could not limit the StudyHub child's tools: ${bound.error().message}`
      : 'StudyHub child creation was not observed; refusing to run it with host tools');
  }
  let settled;
  const result = Promise.resolve(receipt.result).then(value => {
    settled = { status: 'settled', session: settledSession(bound.agent()) };
    return value;
  });
  result.catch(() => {});
  const agents = ctx.get?.('agents');
  return {
    id: receipt.childId || childId,
    result,
    get localAgent() {
      const live = bound.agent();
      if (live && agents?.get?.(live.id) === live) return live;
      return settled;
    },
    dispose: () => receipt.dispose(),
  };
}
