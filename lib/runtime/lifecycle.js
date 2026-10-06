import { dshJobExecutor } from '../jobs/executor.js';
import { StudyRuntime } from '../runtime.js';
import { createBuiltinEnvironment, fullContextIds } from './builtins.js';
import { domainTool, discoveryTool } from './tools.js';

const scopeKey = Symbol.for('studyhub.runtime.scope.v1');

function createScope(root) {
  const state = { root, references: 0, contributions: new Map(), libraries: new Map(), toolDisposers: new Map(), toolContext: null, hostHooks: [] };
  state.requests = new Set();
  const requestOwners = new WeakMap();
  const trackedRuntimes = new WeakMap();
  const removeRequest = entry => { state.requests.delete(entry); entry.group?.delete(entry); };
  const finalizedRequests = new FinalizationRegistry(removeRequest);
  const disposeRequests = (entries, id) => {
    const pending = [];
    for (const entry of [...entries]) {
      const runtime = entry.weak.deref();
      if (id) pending.push(runtime?.disposeContext(id));
      else { pending.push(runtime?.dispose()); finalizedRequests.unregister(entry); removeRequest(entry); }
    }
    return Promise.all(pending);
  };
  state.disposeRequests = () => disposeRequests(state.requests);
  state.disposeRequestContext = id => disposeRequests(state.requests, id);
  const trackRequestRuntime = (runtime, owner) => {
    if (trackedRuntimes.has(runtime)) return;
    let group;
    if (owner && typeof owner.effect === 'function') {
      group = requestOwners.get(owner);
      if (!group) {
        group = new Set();
        requestOwners.set(owner, group);
        owner.effect(() => () => disposeRequests(group));
      }
    }
    const entry = { weak: new WeakRef(runtime), group };
    group?.add(entry);
    state.requests.add(entry);
    trackedRuntimes.set(runtime, entry);
    finalizedRequests.register(runtime, entry, entry);
  };
  const configureHost = hooks => {
    const entry = { ...hooks };
    state.hostHooks.push(entry);
    return () => { const index = state.hostHooks.indexOf(entry); if (index >= 0) state.hostHooks.splice(index, 1); };
  };
  const hostMethod = name => state.hostHooks.findLast(hooks => typeof hooks[name] === 'function')?.[name];
  const defaultWorkspace = async execution => {
    const cwd = execution?.agent?.session?.header?.cwd;
    if (!cwd) return undefined;
    const { binding } = await import('../host.js');
    return (await binding(cwd)).root;
  };
  const defaultServices = async execution => {
    const agent = execution?.agent;
    const signal = execution?.signal;
    const jobExecutor = dshJobExecutor(root, agent);
    const sessionQuery = (() => { try { return root.get?.('sessionQuery') || undefined; } catch { return undefined; } })();
    if (!agent?.session || !root.llm) return { signal, sessionQuery, jobExecutor };
    const { binding, sessionModel } = await import('../host.js');
    const { withEffortPreference } = await import('../reasoning-effort.js');
    const saved = await binding(agent.session.header.cwd), fixed = saved.route;
    const route = () => fixed || withEffortPreference(sessionModel(root, agent.session), saved.reasoningEffort);
    if (!route()) return { signal, sessionQuery, jobExecutor };
    const { modelCompletion, sessionNotifier } = await import('../index.js');
    const complete = modelCompletion(root, route, agent.id);
    return { complete, jobModelHost: { ctx: agent.ctx || root, route, sessionId: agent.id, complete },
      completeLight: modelCompletion(root, route, agent.id, { light: true }),
      sessionId: agent.id, signal, jobExecutor, notify: sessionNotifier(agent),
      tokenMeter: (() => { try { return root.get?.('tokenMeter') || undefined; } catch { return undefined; } })(), sessionQuery };
  };
  const library = path => {
    if (!state.libraries.has(path)) {
      const runtime = new StudyRuntime(path);
      const environment = createBuiltinEnvironment(path, runtime);
      const disposers = new Map();
      for (const id of state.contributions.keys()) disposers.set(id, environment.install(id));
      state.libraries.set(path, { runtime, environment, disposers });
    }
    return state.libraries.get(path);
  };
  const api = Object.freeze({ version: 1,
    runtimeForLibrary: path => library(path).runtime,
    contextIds: () => [...state.contributions.keys()],
    forLibrary: path => {
      const { runtime } = library(path);
      return Object.freeze({ call: (action, args, services) => runtime.call(action, args, services),
        invoke: (domain, operation, args, services) => runtime.invoke(domain, operation, args, services),
        describe: () => runtime.describe(), capabilities: services => runtime.capabilities(services),
        register: definition => runtime.register(definition), registerJob: (ctx, api, definition) => runtime.registerJob(ctx, api, definition) });
    },
    configureHost,
    trackRequestRuntime,
    resolveWorkspace: execution => (hostMethod('resolveWorkspace') || defaultWorkspace)(execution),
    requestServices: execution => (hostMethod('requestServices') || defaultServices)(execution),
  });
  state.api = api;
  state.provideDispose = typeof root.provide === 'function' ? root.provide('studyRuntime', api) : (() => {
    root.studyRuntime = api;
    return () => { delete root.studyRuntime; };
  })();
  state.syncTools = () => {
    if (!state.toolContext?.tools) return;
    for (const id of ['runtime', ...state.contributions.keys()]) {
      if (state.toolDisposers.has(id)) continue;
      const definition = id === 'runtime' ? discoveryTool(api) : domainTool(id, api);
      if (definition) state.toolDisposers.set(id, state.toolContext.tools.register(definition) || (() => {}));
    }
  };
  if (typeof root.inject === 'function') state.toolInjection = root.inject(['tools'], context => {
    state.toolContext = context;
    state.syncTools();
    context.effect?.(() => () => { state.toolContext = null; state.toolDisposers.clear(); });
  });
  else if (root.tools) { state.toolContext = root; state.syncTools(); }
  return state;
}

function stateFor(ctx) {
  const root = ctx.root || ctx;
  if (!root[scopeKey]) Object.defineProperty(root, scopeKey, { value: createScope(root), writable: true, configurable: true });
  return root[scopeKey];
}

/** Shared Symbol identity survives independently installed copies of this package. */
export function acquireContexts(ctx, ids = [], options = {}) {
  ids = [...new Set(ids)];
  for (const id of ids) if (!fullContextIds.includes(id)) throw new Error(`Unknown context ${id}`);
  const state = stateFor(ctx);
  state.references++;
  const owner = Symbol('context owner');
  const acquired = new Set();
  let releaseHost;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const pending = [];
    releaseHost?.();
    for (const id of acquired) {
      const contribution = state.contributions.get(id);
      contribution?.owners.delete(owner);
      if (!contribution?.owners.size) {
        state.contributions.delete(id);
        state.toolDisposers.get(id)?.(); state.toolDisposers.delete(id);
        for (const target of state.libraries.values()) { pending.push(target.disposers.get(id)?.()); target.disposers.delete(id); }
        pending.push(state.disposeRequestContext(id));
      }
    }
    if (--state.references) return Promise.all(pending);
    for (const dispose of state.toolDisposers.values()) dispose();
    state.toolDisposers.clear();
    for (const target of state.libraries.values()) pending.push(target.runtime.dispose());
    state.libraries.clear();
    pending.push(state.disposeRequests());
    state.toolInjection?.dispose?.();
    delete state.root[scopeKey];
    pending.push(state.provideDispose?.());
    return Promise.all(pending);
  };
  try {
    for (const id of ids) {
      let contribution = state.contributions.get(id);
      const installing = !contribution;
      if (installing) {
        contribution = { owners: new Set() };
        state.contributions.set(id, contribution);
      }
      contribution.owners.add(owner);
      acquired.add(id);
      if (installing) for (const target of state.libraries.values())
        target.disposers.set(id, target.environment.install(id));
    }
    releaseHost = options.modelServices ? state.api.configureHost({ requestServices: options.modelServices }) : undefined;
    state.syncTools();
    ctx.effect?.(() => release);
    return { api: state.api, release };
  } catch (error) { release(); throw error; }
}

export function installedContexts(ctx) { return (ctx.root || ctx)[scopeKey]?.api.contextIds() || null; }
