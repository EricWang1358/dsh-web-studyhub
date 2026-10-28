/* The ZCode host adapter: StudyHub's own host handler (lib/host.js createHostHandler, the one DSH and the local preview
   answer the panel with) over a ZCode-shaped context, plus what only this host has: the library folder and the model
   endpoint saved in the ZCode config file, the in-process job executor, the upgrade path through the ZCode package and
   the assistant boundary for the model's tools. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   Two doors, as under DSH:
   - the panel (`from: 'panel'`, only for a study_call that carried this process's panel nonce, see entry.mjs) goes
     through the host handler, like DSH's panel transport;
   - the assistant (`from: 'agent'`, the default: study_workspace and the domain tools) gets exactly what DSH's
     study_workspace tool gives it (lib/index.js runStudyTool): the assistant boundary, the board, notebooks,
     binding.get, panel.current and the library's own actions, nothing of the host handler's panel-only ones.
   Nothing here re-implements library logic. */
import { mkdirSync } from 'node:fs';
import { applyHome, keyHint, modelReady, readConfig, saveLibraryRoot, saveModel } from './workspace.mjs';
import { openaiComplete } from './openai-complete.mjs';
import { inProcessExecutor } from './job-executor.mjs';
import { zcodeErrorText, zcodeText } from './messages.mjs';
import { appMessages, audioFiles, boundary, hostLib, skeletonDiagrams, tokenUsage, tools, updateCheck, usageScope } from './studyhub-lib.mjs';

/** Plan contract C3 for this host: no composer to hand a prompt to, no agent tasks, no landing shell. */
export const ZCODE_CAPABILITIES = Object.freeze({ edition: 'zcode', chat: false, agentTasks: false, landing: false });
export const SESSION_ID = 'zcode';
/** Host actions the assistant never gets: the model endpoint and its key are the learner's, and so is the library folder. */
export const PANEL_ONLY = Object.freeze(new Set(['model.config.get', 'model.config.set', 'model.config.test', 'app.open', 'binding.set']));
const TEST_TIMEOUT_MS = 30_000;

/** The name a route shows (DSH shows "provider · model"): the learner's label, else the endpoint's host name. */
export function providerName(model) {
  if (model?.label) return model.label;
  try { return new URL(model?.baseUrl).hostname || 'OpenAI-compatible'; } catch { return 'OpenAI-compatible'; }
}

/** The ZCode release asset for a release version: the zip next to the DSH package in the same GitHub release. */
export function zcodeAsset(latest) {
  if (!latest) return { assetName: null, assetUrl: null, sha256Url: null };
  const base = `${updateCheck.releaseDownloadPrefix()}v${latest}/`, assetName = `StudyHub-ZCode-${latest}.zip`;
  return { assetName, assetUrl: `${base}${assetName}`, sha256Url: `${base}SHA256SUMS-ZCode-${latest}.txt` };
}

/** update.check as the panel's guided upgrade needs it here: the same release, the ZCode package's address, no one-click install. */
export function zcodeUpdateView(view) {
  if (!view || typeof view !== 'object') return view;
  return { ...view, ...zcodeAsset(view.latest), install: { available: false, desktop: false, host: 'zcode' } };
}

/** Why the assistant may not call `action` here, or null: lib/assistant-boundary.js, then this host's own panel-only actions. */
export function agentRefusal(action, args) {
  return boundary.assistantRefusal(action)
    || (PANEL_ONLY.has(action) ? `${action} is not available to the assistant: ${zcodeText('panel-only', 'en')}` : null)
    || (action === 'panel.open' ? zcodeText('panel-open-unavailable', 'en') : null)
    || boundary.assistantArgsRefusal(action, args);
}

/**
 * Create the host. `complete` replaces the endpoint call (tests use the fake model); `documents` replaces the Documents
 * folder lookup and `check` the library check (tests). `call(action, args, { from })` answers { ok, value } or
 * { ok: false, error, code }.
 */
export async function createZcodeHost({ env = process.env, fetch = globalThis.fetch, complete: injected, documents, check, log = console.error } = {}) {
  const { home, source: homeSource, relative } = applyHome(env);
  // lib/ reads the home from process.env on every call.
  process.env.DSH_HOME = home;
  if (relative) log(`[studyhub] DSH_HOME is a relative path; it is taken from your user folder: ${home}`);
  let config = readConfig({ env, home, documents, check });
  mkdirSync(config.libraryRoot, { recursive: true });
  const disposers = [];
  const session = { header: { cwd: config.libraryRoot } };
  const ready = () => !!injected || modelReady(config.model);
  const route = () => (ready() ? { provider: providerName(config.model), model: config.model?.id || 'fake' } : undefined);
  const report = (usage, meta) => usageScope.reportUsage(tokenUsage.usageFromTokenUsage(usage), meta);
  const ctx = {
    sessions: new Map([[SESSION_ID, session]]),
    get(name) {
      // 跟随当前会话 here means "the endpoint the learner saved": there is no conversation model to follow.
      if (name === 'agentDefaultModel') return { currentSelection: route };
      // Model readiness (lib/host.js modelStatus): the saved endpoint is the one provider, and it owes no other key.
      if (name === 'llm') return { listProviders: () => (route() ? [{ id: route().provider, name: route().provider }] : []), listConfigurableProviders: () => [] };
      return undefined;
    },
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  const owned = hostLib.servicesForHost(ctx, undefined, {}, { jobExecutor: inProcessExecutor({ log }) });
  const handlerConfig = { libraryRoot: config.libraryRoot };
  const makeComplete = () => injected || openaiComplete(config.model, { fetch, report });
  const handle = hostLib.createHostHandler(ctx, handlerConfig, makeComplete, { owner: ctx, capabilities: ZCODE_CAPABILITIES });
  const request = (action, args) => handle('call', { sessionId: SESSION_ID, action, args });

  function reload() {
    config = readConfig({ env, home, documents, check });
    mkdirSync(config.libraryRoot, { recursive: true });
    session.header = { cwd: config.libraryRoot };
    handlerConfig.libraryRoot = config.libraryRoot;
  }

  /** A configured library that could not be opened, in words (null when the configured one is in use). */
  const problemView = (language) => (config.problem ? {
    root: config.problem.root, source: config.problem.source, reason: config.problem.reason,
    message: zcodeText('library-fallback', language, [config.problem.root, config.problem.reason, config.libraryRoot]),
  } : null);

  async function binding(language) {
    const current = route() || null;
    return { root: config.libraryRoot, rootSource: config.rootSource === 'env' ? 'config' : config.rootSource === 'fallback' ? 'default' : config.rootSource,
      workspaceRoot: config.libraryRoot, defaultRoot: config.defaultRoot, libraryProblem: problemView(language),
      provider: '', model: '', modelSource: 'config', reasoningEffort: '', route: current,
      modelStatus: await hostLib.modelStatus(ctx, current), host: { ...ZCODE_CAPABILITIES } };
  }

  /** The endpoint as the panel may see it: never the key, only whether one is saved, its last four characters and where it is from. */
  function modelView(extra = {}) {
    const model = config.model;
    return { baseUrl: model?.baseUrl || '', model: model?.id || '', label: model?.label || '', ready: modelReady(model),
      key: { set: !!model?.apiKey, hint: keyHint(model?.apiKey), source: model?.keySource === 'env' ? 'env' : model?.apiKey ? 'file' : '' }, ...extra };
  }

  async function testModel(language) {
    if (!modelReady(config.model)) return { ok: false, message: zcodeText('model-incomplete', language) };
    try {
      const answer = await openaiComplete(config.model, { fetch, timeoutMs: TEST_TIMEOUT_MS })('Reply with the single word OK.', 'OK?', { maxTokens: 16 });
      return { ok: true, message: zcodeText('model-test-ok', language), answer: String(answer).slice(0, 40) };
    } catch (error) {
      return { ok: false, message: appMessages.localizeAppMessage(error?.message || String(error), language) };
    }
  }

  /** The study service of the bound library, the one the panel's requests use. */
  const services = new Map();
  async function currentService() {
    const service = await hostLib.serviceFor(ctx, handlerConfig, config.libraryRoot, session, makeComplete, SESSION_ID, undefined, ctx);
    services.set(service.store.root, service);
    return service;
  }

  /** The panel's own host actions; undefined hands the action on to lib/'s handler. */
  async function panelAction(action, args, language) {
    switch (action) {
      case 'binding.get': return binding(language);
      case 'binding.set':
        // The model is the endpoint form's (model.config.set); a library folder ('' = the default) is this action's.
        // A folder that cannot hold a library is refused before anything is saved.
        if (typeof args.root === 'string') { await saveLibraryRoot(home, args.root, { ...(check ? { check } : {}) }); reload(); }
        return binding(language);
      case 'model.config.get': return modelView();
      case 'model.config.set': {
        const patch = {};
        for (const field of ['baseUrl', 'model', 'label', 'apiKey']) if (typeof args[field] === 'string') patch[field] = args[field];
        const { keyDropped } = await saveModel(home, patch, env);
        reload();
        return modelView({ keyDropped });
      }
      case 'model.config.test': return testModel(language);
      case 'update.check': {
        const answer = await request(action, args);
        if (!answer.ok) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
        return zcodeUpdateView(answer.value);
      }
      // The guided upgrade shows the ZCode package; there is no installer to run from here.
      case 'update.install': return { status: 'failed', code: 'UPDATE_NO_INSTALLER' };
      case 'panel.current': return currentPanel();
      default: return undefined;
    }
  }

  function currentPanel() {
    const { bridge } = owned;
    return { current: bridge.hasPanelVisibility(SESSION_ID) ? bridge.panelObservation(SESSION_ID) : null };
  }

  /** The assistant's door, the same set of actions DSH's study_workspace tool reaches (lib/index.js runStudyTool). */
  async function agentAction(action, args) {
    const refusal = agentRefusal(action, args);
    if (refusal) throw Object.assign(new Error(refusal), { code: 'assistant-refused' });
    if (action.startsWith('board.') || action.startsWith('notebook.')) {
      const answer = await request(action, args);
      if (!answer.ok) throw Object.assign(new Error(answer.error?.message), { code: answer.error?.code });
      return answer.value;
    }
    if (action === 'binding.get') return binding('en');
    if (action === 'panel.current') return currentPanel();
    const service = await currentService();
    if (!service.runtime.hasAction(action)) throw Object.assign(new Error(`Unknown study action: ${action}`), { code: 'STUDY_ERROR' });
    const cwd = config.libraryRoot;
    const value = await service.call(action, action === 'snapshot' ? { ...args, compact: true }
      : action === 'audio.import' ? audioFiles.resolveAudioImportPaths(cwd, args)
        : skeletonDiagrams.scopeDiagramArgs(action, args, cwd, cwd));
    if (action === 'snapshot' && value && typeof value === 'object')
      hostLib.withModelStatus(value, hostLib.withSession(await hostLib.modelStatus(ctx, route()), route()));
    return value;
  }

  /**
   * One action. `from: 'agent'` (the default; study_workspace and the domain tools) is the assistant's door; `from:
   * 'panel'` is the learner's UI, which only a study_call carrying this process's panel nonce reaches (entry.mjs).
   */
  async function call(action, args = {}, { from = 'agent' } = {}) {
    const language = args?.uiLanguage === 'en' ? 'en' : 'zh';
    try {
      if (typeof action !== 'string' || !action) throw new Error('An action is required');
      if (from !== 'panel') return { ok: true, value: hostLib.jsonSafe(await agentAction(action, args)) };
      const own = await panelAction(action, args, language);
      if (own !== undefined) return { ok: true, value: hostLib.jsonSafe(own) };
      const answer = await request(action, args);
      return answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error?.message || 'Study request failed', code: answer.error?.code };
    } catch (error) {
      return { ok: false, error: zcodeErrorText(error, language), ...(error?.code ? { code: error.code } : {}) };
    }
  }

  /** The typed domain tools DSH registers (lib/runtime/tools.js: study_materials, study_bank, …), over this host's library.
      Each call keeps the library it started on: the root it resolved selects its service, so a switch mid-call cannot redirect it. */
  function domainTools() {
    // Each tool call hands its own execution object to every step (entry.mjs makes one per call).
    const calls = new WeakMap();
    const core = {
      resolveWorkspace: async (execution) => { const service = await currentService(); calls.set(execution, service); return service.store.root; },
      requestServices: async (execution) => (calls.get(execution) || await currentService()).modelOptions,
      contextIds: () => [],
      forLibrary: (root) => {
        const runtime = services.get(root).runtime;
        return { invoke: (domain, operation, input, options) => runtime.invoke(domain, operation, input, options),
          call: (name, input, options) => runtime.call(name, input, options), capabilities: (options) => runtime.capabilities(options) };
      },
    };
    const list = ['bank', 'materials', 'generation', 'study', 'audio'].map((id) => tools.domainTool(id, core)).filter(Boolean);
    return [...list, tools.discoveryTool(core)];
  }

  /** What studyhub_open, studyhub_status and the SessionStart hook say about the library: the one actually in use. */
  const libraryStatus = (language = 'zh') => ({ root: config.libraryRoot, problem: problemView(language) });

  let disposing;
  return {
    call,
    domainTools,
    libraryStatus,
    get config() { return config; },
    homeSource,
    /** Idempotent: the second call waits for the first. */
    dispose() {
      disposing ||= (async () => { for (const dispose of [...disposers].reverse()) await dispose(); })();
      return disposing;
    },
  };
}
