import { randomUUID } from 'node:crypto';

/** A saved selection can name a provider configured in a different host profile. */
export function assertHostModelRoute(ctx, route) {
  if (!route || typeof ctx.llm?.listProviders !== 'function') return;
  if (!ctx.llm.listProviders().some(provider => provider.id === route.provider))
    throw Object.assign(new Error(`当前 DSH 宿主未注册模型提供方「${route.provider}」（NO_ADAPTER）。请在当前宿主的模型设置中启用该提供方后点「接着做」；已保存的转写会继续复用。`),
      { code: 'NO_ADAPTER', modelFailure: true, fatal: true });
}

/** One capability decision for model work in live chats and desktop panels. */
export function backgroundCapability(ctx, sessionId, route) {
  const subagents = ctx.get?.('subagents');
  const agents = ctx.get?.('agents');
  const parent = agents?.get(sessionId);
  const provider = subagents?.getProvider?.('spawn');
  const desktop = !parent && !!sessionId && typeof agents?.create === 'function' &&
    !!(ctx.sessions?.get(sessionId)?.header?.cwd || ctx.get?.('sessionPersistence')?.stat || ctx.get?.('sessionQuery')?.observeSession);
  // A selected route must be honoured, not silently inherited from the parent.
  const native = !!((parent || desktop) && typeof subagents?.start === 'function' &&
    provider?.capabilities?.toolFilter && (!route || provider.capabilities.agentOptions));
  return { subagents, parent, provider, native, desktop, ctx, agents, sessionId, route };
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
  const pending = Promise.resolve().then(() => agents.create({ sessionId: randomUUID(),
    meta: { cwd, parentSession: sessionId, origin: 'subagent', delegationDepth: 1 },
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

/** Dispose an admitted child even if admission finishes after cancellation. */
export async function startBoundedChild(subagents, request, capability) {
  const coordinator = !request.parent && capability?.desktop ? await desktopParent(capability, request.signal) : undefined;
  if (coordinator) request = { ...request, parent: coordinator.agent };
  const pending = Promise.resolve().then(() => subagents.start('spawn', request));
  try {
    const run = await abortable(pending, request.signal);
    rememberParent(run.id, request.parent?.id);
    if (!coordinator) return run;
    return { ...run, async dispose() { try { await run.dispose(); } finally { await coordinator.dispose(); } } };
  }
  catch (error) {
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
