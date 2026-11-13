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

/*
 * DSH 0.2.2 (@deepseek-ai/dsh-subagent 0.2.2-rc.2) flattened the activation spec: `SubagentActivationSpec extends
 * Omit<SubagentStartRequest, 'label' | 'signal'>` (lib/types/types.d.ts:23), and startActivation reads `spec.parent.id`
 * (lib/index.js:3024), `spec.agentPreset` / `spec.prompt` (lib/index.js:1497-1557). 0.2.1-rc.2 reads the same fields
 * from `spec.request` (lib/index.js:3045, 1392-1470). Neither reads the other's place, so one spec carries both.
 * Neither release can start a child without a live parent (both throw a TypeError on a missing one).
 */
function activationSpec({ label, childId, signal, parent, prompt, agentOptions }) {
  const task = { parent, prompt, agentPreset: WORKER_PRESET, ...(agentOptions ? { agentOptions } : {}) };
  return { provider: 'spawn', label, childId, delivery: 'caller', signal, ...task, request: task };
}

/** DSH 0.2.2 groups sub-agents in trees under a live root (`rootOf`, dsh-subagent 0.2.2-rc.2 lib/index.js:1643, :3043); 0.2.1 has no trees. */
export const groupsSubagentTrees = subagents => typeof subagents?.rootOf === 'function';

/** Why DSH refused to start a StudyHub worker when the host and StudyHub disagree on the API: a TypeError of a changed spec, or a refusal no retry repairs. */
const ENGINE_REFUSALS = new Set(['UNAUTHORIZED', 'UNSUPPORTED_CAPABILITY']);
const engineRefused = error => error instanceof TypeError || (error?.name === 'SubagentError' && ENGINE_REFUSALS.has(error.code));

/** The engine failure lib/generation-failure.js names 'engine' (by SUBAGENT_START): a start DSH rejected, with DSH's own words kept for the log. */
function engineFailure(detail, cause) {
  return Object.assign(new Error(`DSH sub-agent engine could not start a StudyHub worker (SUBAGENT_START): ${detail}`, cause ? { cause } : undefined),
    { code: 'SUBAGENT_START' });
}

/* The Agent StudyHub holds is no longer the one DSH has under that id: the conversation that started the work was closed or reloaded while it ran
   (UNAUTHORIZED "subagent creation requires the exact live parent agent", dsh-subagent 0.2.2-rc.2 lib/index.js:3024, 0.2.1-rc.2 :3045; rootOf's
   "subagent tree access requires the exact live caller", 0.2.2-rc.2 :1643). lib/generation-failure.js names it 'parent-gone' (by PARENT_GONE). */
const parentGone = error => error?.name === 'SubagentError' && error.code === 'UNAUTHORIZED' && /exact live (?:parent|caller)/i.test(error.message);
const parentGoneFailure = cause => Object.assign(new Error(
  `The DSH conversation that started this StudyHub work was closed or reloaded (PARENT_GONE): ${cause.message}`, { cause }), { code: 'PARENT_GONE' });

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
  if (!request.parent) throw engineFailure('no live parent agent to start it under');
  const bound = boundChildTools(ctx, childId, allow);
  let receipt;
  try {
    receipt = await subagents.startActivation(activationSpec({ ...request, childId,
      // dsh-subagent 0.2.1 startLocal calls spec.signal.throwIfAborted() unguarded.
      signal: request.signal ?? new AbortController().signal }));
  } catch (error) {
    throw parentGone(error) ? parentGoneFailure(error) : engineRefused(error) ? engineFailure(error.message, error) : error;
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
