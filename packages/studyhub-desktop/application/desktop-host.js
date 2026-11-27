import { createHostHandler, jsonSafe, modelStatus } from '../../../lib/host.js';
import { registerHostConcurrencyCap } from '../../../lib/generation-settings.js';
import { DESKTOP_CAPABILITIES } from '../domain/contracts.js';
import {
  OPENAI_PRESETS,
  applyConfigPatch,
  concurrencyHookForMode,
  modelViaOf,
  redactDesktopConfig,
  resolveEffectiveModel,
} from '../domain/config-policy.js';
import { libraryPlaceOf } from '../domain/library-place.js';
import { cliLaunchRequest } from '../domain/terminal-command.js';
import { createDesktopCompletePort } from './complete-port.js';
import { formatCallError, formatForwardAnswer } from './desktop-errors.js';
import { localizeProviders } from './provider-discovery.js';
import { createRetrievalActionHandlers, prepareRetrievalForAction } from './retrieval-actions.js';
import { createDesktopLibrarySync } from './library-sync.js';
import { desktopUpdateView } from './update-view.js';

export const DESKTOP_SESSION_ID = 'desktop';

function createDesktopContext({ session, getRoute, getEffective, jobsService, toolsService, disposers }) {
  const desktopAgent = Object.freeze({ id: DESKTOP_SESSION_ID });
  const agents = new Map([[DESKTOP_SESSION_ID, desktopAgent]]);
  const sessions = new Map([[DESKTOP_SESSION_ID, session]]);

  function listProviders() {
    const route = getRoute();
    return route ? [{ id: route.provider, name: route.provider }] : [];
  }

  function listConfigurableProviders() {
    const effective = getEffective();
    if (effective.reason !== 'no-credential' || !effective.provider) return [];
    return [{ provider: effective.provider, settingsNs: 'desktop', settingsPath: [] }];
  }

  return {
    sessions,
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'jobs') return jobsService;
      if (name === 'tools' && toolsService) return toolsService;
      if (name === 'agentDefaultModel') return { currentSelection: getRoute };
      if (name === 'llm') return { listProviders, listConfigurableProviders };
      if (name === 'settings') {
        return { describe: () => [{ ns: 'desktop', value: { apiKeyEnv: 'DESKTOP_MODEL_CREDENTIAL' } }] };
      }
      if (name === 'credentials') {
        return { describe: async () => ({ configured: getEffective().ready }) };
      }
      return undefined;
    },
    effect(setup) {
      const dispose = setup();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };
}

function localizeEffectiveLabel(effective, language) {
  if (language !== 'en') return effective.label;
  return effective.label
    .replace('默认模型', 'Default model')
    .replace('OpenAI 兼容接口', 'OpenAI-compatible');
}

function buildConfigResponse({ config, providers, configPath, configProblem = null, keyDropped, language = 'zh' }) {
  const redacted = redactDesktopConfig(config);
  const localizedProviders = localizeProviders(providers, language);
  const effective = resolveEffectiveModel(config, localizedProviders);
  return {
    ...redacted,
    providers: localizedProviders,
    effective: {
      ready: effective.ready,
      label: localizeEffectiveLabel(effective, language),
      reason: effective.reason,
      maxConcurrency: effective.maxConcurrency,
      defaultConcurrency: effective.defaultConcurrency,
    },
    configPath,
    configProblem,
    presets: OPENAI_PRESETS,
    ...(keyDropped !== undefined ? { keyDropped } : {}),
  };
}

async function buildBindingView({ ctx, state, route, systemDrive, providerDiscovery }) {
  const status = await modelStatus(ctx, route);
  // Only a codex model needs discovery here (how it is signed in decides what it costs), and the last scan answers it however old it is: this view
  // is read at every start and after every folder change, which must not wait for the CLI each time. Only a process with no scan yet waits, once.
  const known = state.config.mode === 'codex' ? providerDiscovery.getCached() : [];
  const providers = state.config.mode === 'codex' && !known.length ? await providerDiscovery.scan({ force: false }).catch(() => []) : known;
  return {
    root: state.library.root,
    // The folder that was asked for: the same as `root`, unless the library is the DSH plugin's `.dsh-study` inside it.
    pickedRoot: state.library.pickedRoot,
    rootSource: state.library.rootSource,
    workspaceRoot: state.library.root,
    defaultRoot: state.library.defaultRoot,
    libraryProblem: state.library.problem,
    configProblem: state.configProblem || null,
    libraryPlace: libraryPlaceOf({
      confirmed: state.config.libraryPlaceConfirmed, rootSource: state.library.rootSource, root: state.library.root, systemDrive,
    }),
    modelVia: modelViaOf(state.config, providers),
    provider: '',
    model: '',
    modelSource: 'config',
    reasoningEffort: state.config.reasoningEffort || '',
    route,
    modelStatus: status,
    host: { ...DESKTOP_CAPABILITIES },
  };
}

const langOf = (args) => (args?.uiLanguage === 'en' ? 'en' : 'zh');

function createConfigHandlers({ configStore, providerDiscovery, completePort, getState, reloadState }) {
  const configReply = async (args, keyDropped) => {
    const providers = await providerDiscovery.scan({ force: false });
    return buildConfigResponse({
      config: getState().config, providers, configPath: configStore.configPath,
      configProblem: getState().configProblem || null, keyDropped, language: langOf(args),
    });
  };
  return {
    'desktop.config.get': (args) => configReply(args),
    'desktop.providers.scan': async (args) => ({
      providers: localizeProviders(await providerDiscovery.scan({ force: args?.force === true }), langOf(args)),
    }),
    'desktop.config.save': async (args) => {
      const { config: nextConfig, keyDropped } = applyConfigPatch(getState().config, args || {});
      await configStore.save(nextConfig);
      await reloadState();
      return configReply(args, keyDropped);
    },
    'desktop.config.recover': async (args) => {
      const rec = typeof configStore.recover === 'function' ? await configStore.recover() : { backupPath: '' };
      if (typeof configStore.recover !== 'function') await configStore.save({}, { force: true });
      await reloadState();
      return { recovered: rec?.recovered !== false, backupPath: rec?.backupPath || '', config: await configReply(args) };
    },
    'desktop.config.test': async (args) => {
      // The scan only supplies a ready CLI's path when the draft and the saved config name none, and the last scan answers that however
      // old it is (as in buildBindingView) as long as it found the CLI being tested; if it did not, look again (installed or signed in
      // since). A full scan costs ~6 s of CLI probes and its 30 s cache is always stale after one ~40 s agy test.
      const cached = providerDiscovery.getCached();
      const mode = args?.mode || getState()?.config?.mode;
      const unfound = (mode === 'agy' || mode === 'codex') && !cached.some((item) => item.id === mode && item.status === 'ready');
      if (!cached.length || unfound) await providerDiscovery.scan({ force: false });
      const { uiLanguage: _lang, ...draft } = args || {};
      return completePort.testConnection(Object.keys(draft).length ? draft : null, langOf(args));
    },
  };
}

function createDesktopActionHandlers(deps) {
  const { configStore, providerDiscovery, openExternal, openCliTerminal, getState, reloadState, getRoute, ctx, forward, systemDrive, notifyLibraryChanged } = deps;
  const bindingView = () => buildBindingView({ ctx, state: getState(), route: getRoute() || null, systemDrive, providerDiscovery });
  return {
    ...createConfigHandlers(deps),
    'app.open': async (args) => { await openExternal(args?.url); return { ok: true }; },
    'desktop.cli.open': async (args) => {
      const { pickedRoot, root } = getState().library;
      const request = cliLaunchRequest(await providerDiscovery.scan({ force: false }), args?.provider, pickedRoot || root);
      await openCliTerminal(request);
      return { ok: true, provider: args.provider, cwd: request.cwd };
    },
    'binding.get': bindingView,
    'binding.set': async (args) => {
      try {
        const shouldSaveRoot = typeof args?.root === 'string'
          && !(args.root === '' && getState().library.rootSource !== 'custom' && typeof args?.reasoningEffort === 'string');
        if (shouldSaveRoot) { await configStore.saveLibraryRoot(args.root); await reloadState(); }
        if (typeof args?.reasoningEffort === 'string') {
          await configStore.save({ ...getState().config, reasoningEffort: args.reasoningEffort.trim() });
        }
      } finally { await reloadState(); }
      return bindingView();
    },
    'desktop.library.confirm': async () => { await configStore.confirmLibraryPlace(); await reloadState(); return bindingView(); },
    'webGemini.status': () => ({ enabled: false, toolName: '', waitSeconds: 600, minWaitSeconds: 30, maxWaitSeconds: 1800, effectiveTool: null, missing: null, available: false, hasToolRegistry: false, tools: [], active: false }),
    'webGemini.set': () => ({ enabled: false, toolName: '', waitSeconds: 600, minWaitSeconds: 30, maxWaitSeconds: 1800, effectiveTool: null, missing: null, available: false, hasToolRegistry: false, tools: [], active: false }),
    'webGemini.test': () => ({ ok: false, toolName: '', reason: 'missing', latencyMs: 0, message: 'Desktop edition does not use DSH ask-gemini-mcp.' }),
    'update.check': async (args) => {
      const answer = await forward('update.check', args);
      if (!answer.ok) throw Object.assign(new Error(answer.error?.message || '检查更新失败'), { code: answer.error?.code });
      return desktopUpdateView(answer.value);
    },
    'update.install': () => ({ status: 'failed', code: 'UPDATE_NO_INSTALLER' }),
    'library.notifyChanged': async (args) => notifyLibraryChanged(args),
    'ui.refresh': async (args) => notifyLibraryChanged(args),
  };
}

function buildEffectiveResolver({ getConfig, providerDiscovery, injectedComplete }) {
  return () => {
    if (injectedComplete) {
      return {
        ready: true,
        label: 'Desktop · Stub Model',
        reason: 'ok',
        provider: 'desktop-stub',
        model: 'stub',
        maxConcurrency: null,
        defaultConcurrency: null,
      };
    }
    return resolveEffectiveModel(getConfig(), providerDiscovery.getCached());
  };
}

async function terminalUnavailable() {
  throw Object.assign(new Error('当前系统暂不支持自动打开命令行'), { code: 'terminal-unsupported' });
}

function createCallDispatcher(desktopHandlers, forward, retrievalRuntime) {
  return async function call(action, args = {}) {
    const language = args?.uiLanguage === 'en' ? 'en' : 'zh';
    try {
      if (typeof action !== 'string' || !action) {
        throw Object.assign(new Error('An action is required'), { code: 'invalid-action' });
      }
      if (Object.hasOwn(desktopHandlers, action)) {
        return { ok: true, value: jsonSafe(await desktopHandlers[action](args)) };
      }
      await prepareRetrievalForAction(retrievalRuntime, action);
      return formatForwardAnswer(await forward(action, args));
    } catch (error) {
      return formatCallError(error, language);
    }
  };
}

function buildRouteResolver(getEffective, getConfig) {
  return () => {
    const effective = getEffective();
    if (effective.reason === 'no-route' || !effective.provider || !effective.model) return undefined;
    const effort = getConfig().reasoningEffort || '';
    return { provider: effective.provider, model: effective.model, ...(effort ? { reasoningEffort: effort } : {}) };
  };
}

/**
 * Create the StudyHub Desktop application host.
 * Wires `lib/host.js` (`createHostHandler`), `registerHostConcurrencyCap`,
 * `inProcessExecutor`, provider discovery, and desktop-specific RPC actions.
 */
export async function createDesktopHost({
  configStore,
  providerDiscovery,
  openaiComplete,
  agyComplete,
  codexComplete = null,
  jobExecutor,
  openExternal,
  openCliTerminal = terminalUnavailable,
  ensureDir,
  injectedComplete = null,
  retrievalRuntime = null,
  libraryEvents = null,
  systemDrive = '',
}) {
  let state = await configStore.load();
  await ensureDir(state.library.root);

  const disposers = [];
  if (retrievalRuntime) disposers.push(() => retrievalRuntime.dispose());
  const session = { header: { cwd: state.library.root } };
  const handlerConfig = {
    libraryRoot: state.library.root,
    reasoningEffort: state.config.reasoningEffort || '',
    ignoreBindingFile: true,
    disableWebGemini: true,
  };
  registerHostConcurrencyCap(() => concurrencyHookForMode(state.config.mode));

  const getEffective = buildEffectiveResolver({ getConfig: () => state.config, providerDiscovery, injectedComplete });
  const getRoute = buildRouteResolver(getEffective, () => state.config);
  const completePort = createDesktopCompletePort({
    getConfig: () => state.config,
    getAgyExecutablePath: () => providerDiscovery.findReadyAgyPath(),
    getCodexExecutablePath: () => providerDiscovery.findReadyCodexPath?.() || '',
    openaiComplete, agyComplete, codexComplete, injectedComplete,
  });
  const toolsService = retrievalRuntime ? retrievalRuntime.asDshToolsService() : null;
  const ctx = createDesktopContext({
    session, getRoute, getEffective, jobsService: jobExecutor.asDshJobsService(), toolsService, disposers,
  });
  const handle = createHostHandler(ctx, handlerConfig, (route, sessionId, options) => completePort.makeComplete(route, sessionId, options), {
    owner: ctx,
    libraryEvents,
    capabilities: DESKTOP_CAPABILITIES,
  });
  const forward = (action, args) => handle('call', { sessionId: DESKTOP_SESSION_ID, action, args });
  const librarySync = createDesktopLibrarySync({ libraryEvents, getRoot: () => state.library.root, forward });
  disposers.push(() => librarySync.dispose());
  const reloadState = async () => {
    state = await configStore.load();
    await ensureDir(state.library.root);
    session.header = { cwd: state.library.root };
    handlerConfig.libraryRoot = state.library.root;
    handlerConfig.reasoningEffort = state.config.reasoningEffort || '';
    librarySync.syncWatcher();
  };
  const desktopHandlers = {
    ...createDesktopActionHandlers({
      configStore, providerDiscovery, completePort, openExternal, openCliTerminal,
      getState: () => state, reloadState, getRoute, ctx, forward, systemDrive,
      notifyLibraryChanged: (args) => librarySync.notifyChanged(args),
    }),
    ...createRetrievalActionHandlers({ retrievalRuntime, forward }),
  };
  const call = createCallDispatcher(desktopHandlers, forward, retrievalRuntime);
  let disposing = null;
  const dispose = () => (disposing ||= (async () => {
    registerHostConcurrencyCap(null);
    for (const fn of [...disposers].reverse()) await fn();
  })());
  return Object.freeze({
    call, subscribeEvents: librarySync.subscribeEvents, dispose,
    get config() { return state.config; },
    get library() { return state.library; },
  });
}
