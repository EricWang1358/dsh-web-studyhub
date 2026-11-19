import { createHostHandler, jsonSafe, modelStatus } from '../../../lib/host.js';
import { registerHostConcurrencyCap } from '../../../lib/generation-settings.js';
import { localizeAppMessage } from '../../../lib/application-messages.js';
import { DESKTOP_CAPABILITIES } from '../domain/contracts.js';
import {
  OPENAI_PRESETS,
  applyConfigPatch,
  concurrencyHookForMode,
  redactDesktopConfig,
  resolveEffectiveModel,
} from '../domain/config-policy.js';
import { cliLaunchRequest } from '../domain/terminal-command.js';
import { createDesktopCompletePort } from './complete-port.js';
import { localizeProviders } from './provider-discovery.js';
import { desktopUpdateView } from './update-view.js';

export const DESKTOP_SESSION_ID = 'desktop';

function createDesktopContext({ session, getRoute, getEffective, jobsService, disposers }) {
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

function buildConfigResponse({ config, providers, configPath, keyDropped, language = 'zh' }) {
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
    presets: OPENAI_PRESETS,
    ...(keyDropped !== undefined ? { keyDropped } : {}),
  };
}

async function buildBindingView({ ctx, state, route }) {
  const status = await modelStatus(ctx, route);
  return {
    root: state.library.root,
    // The folder that was asked for: the same as `root`, unless the library is the DSH plugin's `.dsh-study` inside it.
    pickedRoot: state.library.pickedRoot,
    rootSource: state.library.rootSource,
    workspaceRoot: state.library.root,
    defaultRoot: state.library.defaultRoot,
    libraryProblem: state.library.problem,
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

function createDesktopActionHandlers(deps) {
  const { configStore, providerDiscovery, completePort, openExternal, openCliTerminal, getState, reloadState, getRoute, ctx, forward } = deps;
  return {
    'desktop.config.get': async (args) => {
      const providers = await providerDiscovery.scan({ force: false });
      return buildConfigResponse({ config: getState().config, providers, configPath: configStore.configPath, language: langOf(args) });
    },
    'desktop.providers.scan': async (args) => ({
      providers: localizeProviders(await providerDiscovery.scan({ force: args?.force === true }), langOf(args)),
    }),
    'desktop.config.save': async (args) => {
      const { config: nextConfig, keyDropped } = applyConfigPatch(getState().config, args || {});
      await configStore.save(nextConfig);
      await reloadState();
      const providers = await providerDiscovery.scan({ force: false });
      return buildConfigResponse({
        config: getState().config, providers, configPath: configStore.configPath, keyDropped, language: langOf(args),
      });
    },
    'desktop.config.test': async (args) => {
      await providerDiscovery.scan({ force: false });
      const { uiLanguage: _lang, ...draft } = args || {};
      return completePort.testConnection(Object.keys(draft).length ? draft : null, langOf(args));
    },
    'app.open': async (args) => {
      await openExternal(args?.url);
      return { ok: true };
    },
    // Only the CLI's name is read from the page: the program is the one discovery found ready, the folder is the one the learner picked for
    // the library (a DSH workspace when the library is the `.dsh-study` inside it, so the CLI sees the notes beside it too).
    'desktop.cli.open': async (args) => {
      const { pickedRoot, root } = getState().library;
      const request = cliLaunchRequest(await providerDiscovery.scan({ force: false }), args?.provider, pickedRoot || root);
      await openCliTerminal(request);
      return { ok: true, provider: args.provider, cwd: request.cwd };
    },
    'binding.get': () => buildBindingView({ ctx, state: getState(), route: getRoute() || null }),
    'binding.set': async (args) => {
      // getState().config still holds the folder from before this call, so the folder just saved
      // has to be carried into the second write or it would be put back.
      try {
        const libraryRoot = typeof args?.root === 'string'
          ? await configStore.saveLibraryRoot(args.root)
          : getState().config.libraryRoot;
        if (typeof args?.reasoningEffort === 'string') {
          await configStore.save({ ...getState().config, libraryRoot, reasoningEffort: args.reasoningEffort.trim() });
        }
      } finally {
        // Also after a failed second write: the folder may already be saved, and the state in memory has to match the file.
        await reloadState();
      }
      return buildBindingView({ ctx, state: getState(), route: getRoute() || null });
    },
    'update.check': async (args) => {
      const answer = await forward('update.check', args);
      if (!answer.ok) throw Object.assign(new Error(answer.error?.message || '检查更新失败'), { code: answer.error?.code });
      return desktopUpdateView(answer.value);
    },
    'update.install': () => ({ status: 'failed', code: 'UPDATE_NO_INSTALLER' }),
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

const DESKTOP_ERROR_EN = Object.freeze({
  'invalid-cli': 'This local CLI cannot be opened',
  'cli-not-ready': 'This local CLI is not ready yet; select Rescan first',
  'terminal-unsupported': 'Opening a command-line window is not supported on this system yet',
  'terminal-path-unsafe': 'A path has special characters or is not on a local drive, so the command-line window was not opened. Open a command line yourself, go to the library folder and run the CLI there',
  'terminal-launch-failed': 'Could not open a command-line window',
  BROKEN_SHIM: 'The launch script of this CLI is broken or its target file is missing',
  'invalid-config': 'Configuration payload must be an object',
  'invalid-mode': 'Unsupported model provider mode',
  'invalid-effort': 'Invalid reasoning effort value',
  'model-url-invalid': 'Invalid base URL; please provide a full http:// or https:// URL',
  'model-key-invalid': 'Invalid API key format; spaces and control characters are not allowed',
});

function formatCallError(error, language) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'STUDY_ERROR';
  if (language === 'en' && Object.hasOwn(DESKTOP_ERROR_EN, code)) {
    return { ok: false, error: DESKTOP_ERROR_EN[code], code };
  }
  const message = localizeAppMessage(error?.message || String(error), language);
  return { ok: false, error: message, code };
}

function formatForwardAnswer(answer) {
  if (answer.ok) return { ok: true, value: answer.value };
  return {
    ok: false,
    error: answer.error?.message || 'Study request failed',
    code: answer.error?.code || 'STUDY_ERROR',
  };
}

function createCallDispatcher(desktopHandlers, forward) {
  return async function call(action, args = {}) {
    const language = args?.uiLanguage === 'en' ? 'en' : 'zh';
    try {
      if (typeof action !== 'string' || !action) {
        throw Object.assign(new Error('An action is required'), { code: 'invalid-action' });
      }
      if (Object.hasOwn(desktopHandlers, action)) {
        return { ok: true, value: jsonSafe(await desktopHandlers[action](args)) };
      }
      return formatForwardAnswer(await forward(action, args));
    } catch (error) {
      return formatCallError(error, language);
    }
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
}) {
  let state = await configStore.load();
  await ensureDir(state.library.root);

  const disposers = [];
  const session = { header: { cwd: state.library.root } };
  const handlerConfig = { libraryRoot: state.library.root };

  registerHostConcurrencyCap(() => concurrencyHookForMode(state.config.mode));

  const getEffective = buildEffectiveResolver({
    getConfig: () => state.config,
    providerDiscovery,
    injectedComplete,
  });
  const getRoute = () => {
    const effective = getEffective();
    return effective.provider && effective.model ? { provider: effective.provider, model: effective.model } : undefined;
  };
  const completePort = createDesktopCompletePort({
    getConfig: () => state.config,
    getAgyExecutablePath: () => providerDiscovery.findReadyAgyPath(),
    getCodexExecutablePath: () => providerDiscovery.findReadyCodexPath?.() || '',
    openaiComplete,
    agyComplete,
    codexComplete,
    injectedComplete,
  });
  const ctx = createDesktopContext({ session, getRoute, getEffective, jobsService: jobExecutor.asDshJobsService(), disposers });
  const handle = createHostHandler(ctx, handlerConfig, () => completePort.makeComplete(), {
    owner: ctx,
    capabilities: DESKTOP_CAPABILITIES,
  });
  const forward = (action, args) => handle('call', { sessionId: DESKTOP_SESSION_ID, action, args });

  async function reloadState() {
    state = await configStore.load();
    await ensureDir(state.library.root);
    session.header = { cwd: state.library.root };
    handlerConfig.libraryRoot = state.library.root;
  }

  const desktopHandlers = createDesktopActionHandlers({
    configStore, providerDiscovery, completePort, openExternal, openCliTerminal,
    getState: () => state, reloadState, getRoute, ctx, forward,
  });
  const call = createCallDispatcher(desktopHandlers, forward);

  let disposing = null;
  function dispose() {
    disposing ||= (async () => {
      registerHostConcurrencyCap(null);
      for (const fn of [...disposers].reverse()) await fn();
    })();
    return disposing;
  }

  return Object.freeze({
    call,
    dispose,
    get config() { return state.config; },
    get library() { return state.library; },
  });
}
