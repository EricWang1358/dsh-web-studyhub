import { randomUUID } from 'node:crypto';
import { subagentApi, workerCapable, startWorker, groupsSubagentTrees, isParentGone } from './subagent-api.js';
import { hostService } from './host-service.js';

/** A saved selection can name a provider configured in a different host profile. */
export function assertHostModelRoute(ctx, route) {
  const llm = hostService(ctx, 'llm', 'listProviders');
  if (!route || typeof llm?.listProviders !== 'function') return;
  if (!llm.listProviders().some(provider => provider.id === route.provider))
    throw Object.assign(new Error(`当前 DSH 宿主未注册模型提供方「${route.provider}」（NO_ADAPTER）。请在当前宿主的模型设置中启用该提供方后点「接着做」；已保存的转写会继续复用。`),
      { code: 'NO_ADAPTER', modelFailure: true, fatal: true });
}

/** Whether this host offers a route (it registers the provider; the catalog of models is advisory in DSH): true / false, or undefined when it cannot say. */
export function hostOffersModel(ctx, route) {
  const llm = hostService(ctx, 'llm', 'listProviders');
  if (typeof llm?.listProviders !== 'function') return undefined;
  try { return llm.listProviders().some(provider => provider.id === route?.provider); } catch { return undefined; }
}

/** One capability decision for model work in live chats and desktop panels. */
export function backgroundCapability(ctx, sessionId, route) {
  const subagents = ctx.get?.('subagents');
  const agents = ctx.get?.('agents');
  const parent = agents?.get(sessionId);
  const provider = subagents?.getProvider?.('spawn');
  const desktop = !parent && !!sessionId && typeof agents?.create === 'function' &&
    !!(ctx.sessions?.get(sessionId)?.header?.cwd || ctx.get?.('sessionPersistence')?.stat || ctx.get?.('sessionQuery')?.observeSession);
  // A selected route must be honoured, not silently inherited from the parent. DSH 0.2.0 and 0.2.1 differ in how a
  // tool-less child is started (lib/subagent-api.js); either one counts.
  const api = subagentApi(subagents);
  const native = !!((parent || desktop) && workerCapable(ctx, subagents, provider, route));
  return { subagents, parent, provider, native, desktop, ctx, agents, sessionId, route, api };
}

/** A cold panel owns a fresh idle coordinator, never the learner's live chat. */
async function desktopParent(capability, signal) {
  const { ctx, agents, sessionId, route } = capability;
  let cwd = ctx.sessions?.get(sessionId)?.header?.cwd;
  if (!cwd) cwd = (await abortable(ctx.get?.('sessionPersistence')?.stat?.(sessionId), signal))?.header?.cwd;
  if (!cwd && ctx.get?.('sessionQuery')?.observeSession) {
    const pending = ctx.get('sessionQuery').observeSession(sessionId, { projectionMode: 'none' });
    let observed;
    try { observed = await abortable(pending, signal); }
    catch (error) {
      if (signal?.aborted) void Promise.resolve(pending).then(value => value[Symbol.dispose]?.()).catch(() => {});
      throw error;
    }
    try { cwd = observed.header?.cwd; } finally { observed[Symbol.dispose]?.(); }
  }
  signal?.throwIfAborted();
  if (!cwd) throw new Error('后台子代理无法确定当前会话的工作目录');
  // DSH 0.2.2 starts a child only under the root of a live tree, and a session marked origin 'subagent' that no tree owns is refused
  // ("agent has no active runtime owner", dsh-subagent 0.2.2-rc.2 lib/index.js:1643-1651): there the coordinator is a root of its own.
  const marking = groupsSubagentTrees(capability.subagents) ? {} : { origin: 'subagent', delegationDepth: 1 };
  const pending = Promise.resolve().then(() => agents.create({ sessionId: randomUUID(),
    meta: { cwd, parentSession: sessionId, ...marking },
    ...(route ? { agentOptions: route } : {}), signal }));
  try { return await abortable(pending, signal); }
  catch (error) {
    if (signal?.aborted) void pending.then(handle => handle.dispose()).catch(() => {});
    throw error;
  }
}

/** In-process DSH omits diagnostic; the child's persisted terminal reason retains it. */
export function childFailure(run, result) {
  if (result.diagnostic) return result.diagnostic;
  const session = run?.localAgent?.session;
  if (session?.eventAt) for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type !== 'turn/end') continue;
    const reason = event.data?.reason;
    return reason?.error?.message || reason?.message || result.stopReason;
  }
  return result.stopReason;
}

/** Keep typed provider failures available to retry and checkpoint decisions. */
export function childError(run, result) {
  const error = Object.assign(new Error(`Study subagent ${result.stopReason}: ${childFailure(run, result)}`), { modelFailure: true });
  const session = run?.localAgent?.session;
  if (session?.eventAt) for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type !== 'turn/end') continue;
    const failure = event.data?.reason?.error;
    if (failure?.code) error.code = failure.code;
    if (failure?.status) error.status = failure.status;
    break;
  }
  return error;
}

/** Continuable children have been unloaded when their end event is emitted. */
export async function settledChildError(ctx, childId, result) {
  const live = ctx.get?.('agents')?.get(childId);
  if (live) return childError({ localAgent: live }, result);
  const query = ctx.get?.('sessionQuery');
  if (!query?.observeSession) return childError(null, result);
  try {
    const observed = await query.observeSession(childId, { projectionMode: 'none' });
    try {
      const events = observed.events || [];
      return childError({ localAgent: { session: { seq: events.length, eventAt: index => events[index] } } }, result);
    } finally { observed[Symbol.dispose]?.(); }
  } catch { return childError(null, result); }
}

/** Providers can ignore cancellation; late output must still be discarded. */
export async function abortable(work, signal) {
  signal?.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason || new Error('后台任务已取消'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
}

/* Which session a sub-agent was started under: its caller's own session, or the idle coordinator a cold panel creates. The panel needs it
   to ask DSH to load that session's sub-agent catalog before it opens the child. Bounded; the oldest are forgotten first. */
const parents = new Map();
export const parentOfChild = (childId) => parents.get(childId);
function rememberParent(childId, parentId) {
  if (!childId || !parentId) return;
  parents.delete(childId);
  parents.set(childId, parentId);
  if (parents.size > 500) parents.delete(parents.keys().next().value);
}

/* Idle coordinators kept for the next cold-panel call of the same conversation and model (#1042). DSH 0.2.2 persists each coordinator
   as a session (every child appends `subagent/catalog` to its parent, dsh-subagent 0.2.2-rc.2 lib/index.js:934-942) and offers no way
   to delete one (dsh-session-persistence 0.2.2 types/index.d.ts:119-166), so one coordinator per call left one file per model call.
   Only an idle coordinator is reused: each one still has at most one live child, so sharing never meets the per-parent activation cap
   (default 8; 0.2.2 lib/index.js:1176-1177, 0.2.1 :1046-1047, 0.2.0 :728, a slot released when the child is disposed). Unloaded after
   COORDINATOR_IDLE_MS without work. */
const COORDINATOR_IDLE_MS = 30_000;
const ORIGINAL = Symbol.for('cordis.original');
/* The host a coordinator belongs to. Cordis hands out a fresh traceable Proxy of a service on every ctx.get (@deepseek-ai/cordis
   lib/index.js:124-130), and capabilities are rebuilt for every call, so the proxy is never the same twice: the registry behind it is. */
function registryOf(agents) {
  let registry = agents;
  for (let depth = 0; depth < 4 && registry?.[ORIGINAL] && registry[ORIGINAL] !== registry; depth++) registry = registry[ORIGINAL];
  return registry;
}
const idleByHost = new WeakMap(), idleEntries = new Set();
const coordinatorKey = ({ sessionId, route }) => `${sessionId}\n${JSON.stringify(route ?? null)}`;
/* Only a coordinator DSH still finds by id can be a parent again (startActivation checks the exact live parent). */
const stillLive = (capability, handle) => capability.agents?.get?.(handle.agent?.id) === handle.agent;
const unload = (handle) => Promise.resolve().then(() => handle.dispose()).catch(() => {});

function idleSlot(capability, create) {
  const host = registryOf(capability.agents);
  let byKey = idleByHost.get(host);
  if (!byKey && create) idleByHost.set(host, byKey = new Map());
  const key = coordinatorKey(capability);
  let idle = byKey?.get(key);
  if (!idle && create) byKey.set(key, idle = []);
  return idle && { host, byKey, key, idle };
}

function forget(entry) {
  idleEntries.delete(entry);
  clearTimeout(entry.timer);
  const { byKey, key, idle } = entry.slot;
  const at = idle.indexOf(entry);
  if (at >= 0) idle.splice(at, 1);
  if (!idle.length && byKey.get(key) === idle) byKey.delete(key);
}

async function acquireCoordinator(capability, signal) {
  const slot = idleSlot(capability, false);
  while (slot?.idle.length) {
    const entry = slot.idle.at(-1);
    forget(entry);
    if (stillLive(capability, entry.handle)) return { handle: entry.handle, reused: true };
    void unload(entry.handle);
  }
  return { handle: await desktopParent(capability, signal), reused: false };
}

function releaseCoordinator(capability, handle) {
  const entry = { handle, slot: idleSlot(capability, true) };
  entry.timer = setTimeout(() => { forget(entry); void unload(handle); }, COORDINATOR_IDLE_MS);
  entry.timer.unref?.();
  entry.slot.idle.push(entry);
  idleEntries.add(entry);
}

/** Unload the idle coordinators of the host behind `ctx` now (a host tearing StudyHub down), or of every host without one (tests). */
export async function disposeIdleCoordinators(ctx) {
  let host;
  if (ctx) {
    try { host = registryOf(ctx.get?.('agents')); } catch { host = undefined; }
    if (!host) return;
  }
  const leaving = [...idleEntries].filter(entry => !ctx || entry.slot.host === host);
  for (const entry of leaving) forget(entry);
  await Promise.all(leaving.map(entry => unload(entry.handle)));
}

/** Dispose an admitted child even if admission finishes after cancellation. A cold panel starts it under a coordinator of its own. */
export async function startBoundedChild(subagents, request, capability) {
  if (request.parent || !capability?.desktop) return startUnder(subagents, request, capability);
  const { handle, reused } = await acquireCoordinator(capability, request.signal);
  try { return await startUnder(subagents, request, capability, handle); }
  catch (error) {
    // DSH can unload an idle coordinator between StudyHub's check and its own: a reused one is replaced once. A fresh one that is gone is a real failure.
    if (!reused || !isParentGone(error) || request.signal?.aborted) throw error;
    return startUnder(subagents, request, capability, await desktopParent(capability, request.signal));
  }
}

async function startUnder(subagents, request, capability, coordinator) {
  if (coordinator) request = { ...request, parent: coordinator.agent };
  const pending = Promise.resolve().then(() => subagentApi(subagents) === 'activation'
    ? startWorker(capability?.ctx || {}, subagents, request)
    : subagents.start('spawn', request));
  try {
    const run = await abortable(pending, request.signal);
    rememberParent(run.id, request.parent?.id);
    if (!coordinator) return run;
    // Keep `run`'s accessors live (no spread): on DSH 0.2.1 `localAgent` turns into a read-only stub once the child settles,
    // and a copied value would keep handing out the torn-down child as a reusable teacher.
    let disposed;
    const dispose = async () => {
      let released = false;
      try { await run.dispose(); released = true; }
      finally {
        // A child that was released cleanly (whatever its model answered) leaves its coordinator idle for the next call; a stopped call,
        // a child that could not be released or a coordinator DSH no longer has unloads it.
        if (released && !request.signal?.aborted && stillLive(capability, coordinator)) releaseCoordinator(capability, coordinator);
        else await coordinator.dispose();
      }
    };
    return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(run),
      dispose: { enumerable: true, configurable: true, writable: true, value: () => (disposed ??= dispose()) } });
  }
  catch (error) {
    // A start that failed or was stopped unloads its coordinator.
    if (request.signal?.aborted) {
      const cleanup = pending.then(async run => {
        try { await run.dispose?.(); } finally { await coordinator?.dispose(); }
      }, () => coordinator?.dispose());
      if (capability?.awaitAdmissionCleanup) await cleanup;
      else void cleanup.catch(() => {});
    } else await coordinator?.dispose();
    throw error;
  }
}
