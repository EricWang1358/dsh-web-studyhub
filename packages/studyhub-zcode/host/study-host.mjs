/* The ZCode host adapter: StudyHub's own host handler (lib/host.js createHostHandler, the one DSH and the local preview
   answer the panel with) over a ZCode-shaped context, plus what only this host has: the library folder and the model
   endpoint saved in the ZCode config file, the in-process job executor, the upgrade path through the ZCode package and
   the assistant boundary for the model's tools. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   Nothing here re-implements library logic: every study action, the snapshot, assist tasks, samples, notebooks, the
   board and error localisation are lib/'s. */
import { mkdirSync } from 'node:fs';
import { applyHome, keyHint, modelReady, readConfig, saveLibraryRoot, saveModel } from './workspace.mjs';
import { openaiComplete } from './openai-complete.mjs';
import { inProcessExecutor } from './job-executor.mjs';
import { zcodeError, zcodeErrorText, zcodeText } from './messages.mjs';
import { appMessages, boundary, hostLib, tokenUsage, tools, updateCheck, usageScope } from './studyhub-lib.mjs';

/** Plan contract C3 for this host: no composer to hand a prompt to, no agent tasks, no landing shell. */
export const ZCODE_CAPABILITIES = Object.freeze({ edition: 'zcode', chat: false, agentTasks: false, landing: false });
export const SESSION_ID = 'zcode';
/** Host actions the assistant never gets: the model endpoint and its key are the learner's, set in the panel. */
const PANEL_ONLY = new Set(['model.config.get', 'model.config.set', 'model.config.test']);
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

/**
 * Create the host. `complete` replaces the endpoint call (tests use the fake model); `documents` replaces the Documents
 * folder lookup (tests). The returned `call(action, args, { from })` answers { ok, value } or { ok: false, error, code }.
 */
export async function createZcodeHost({ env = process.env, fetch = globalThis.fetch, complete: injected, documents, log = console.error } = {}) {
  const { home, source: homeSource } = applyHome(env);
  // lib/ reads the home from process.env on every call.
  process.env.DSH_HOME = home;
  let config = readConfig({ env, home, documents });
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
    config = readConfig({ env, home, documents });
    mkdirSync(config.libraryRoot, { recursive: true });
    session.header = { cwd: config.libraryRoot };
    handlerConfig.libraryRoot = config.libraryRoot;
  }

  async function binding() {
    // A DSH binding file in the folder (a DSH workspace chosen as the library) can point elsewhere; say which library is really used.
    const root = (await hostLib.binding(config.libraryRoot, handlerConfig)).root;
    const current = route() || null;
    return { root, rootSource: config.rootSource === 'env' ? 'config' : config.rootSource, workspaceRoot: root, defaultRoot: config.defaultRoot,
      provider: '', model: '', modelSource: 'config', reasoningEffort: '', route: current,
      modelStatus: await hostLib.modelStatus(ctx, current), host: { ...ZCODE_CAPABILITIES } };
  }

  /** The endpoint as the panel may see it: never the key, only whether one is saved, its last four characters and where it is from. */
  function modelView() {
    const model = config.model;
    return { baseUrl: model?.baseUrl || '', model: model?.id || '', label: model?.label || '', ready: modelReady(model),
      key: { set: !!model?.apiKey, hint: keyHint(model?.apiKey), source: model?.keySource === 'env' ? 'env' : model?.apiKey ? 'file' : '' } };
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

  /** Actions only this host answers; undefined hands the action on to lib/'s handler. */
  async function hostAction(action, args, from) {
    const language = args?.uiLanguage === 'en' ? 'en' : 'zh';
    switch (action) {
      case 'binding.get': return binding();
      case 'binding.set':
        // The model is the endpoint form's (model.config.set); a library folder ('' = the default) is this action's.
        if (typeof args.root === 'string') { saveLibraryRoot(home, args.root); reload(); }
        return binding();
      case 'model.config.get': return modelView();
      case 'model.config.set': {
        const patch = {};
        for (const field of ['baseUrl', 'model', 'label', 'apiKey']) if (typeof args[field] === 'string') patch[field] = args[field];
        saveModel(home, patch, env);
        reload();
        return modelView();
      }
      case 'model.config.test': return testModel(language);
      case 'update.check': {
        const answer = await request(action, args);
        if (!answer.ok) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
        return zcodeUpdateView(answer.value);
      }
      // The guided upgrade shows the ZCode package; there is no installer to run from here.
      case 'update.install': return { status: 'failed', code: 'UPDATE_NO_INSTALLER' };
      case 'panel.current': {
        const { bridge } = owned;
        return { current: bridge.hasPanelVisibility(SESSION_ID) ? bridge.panelObservation(SESSION_ID) : null };
      }
      case 'panel.open': if (from === 'agent') throw zcodeError('panel-open-unavailable'); return undefined;
      default: return undefined;
    }
  }

  /**
   * One action. `from: 'agent'` (study_workspace, the model's tools) applies lib/assistant-boundary.js and reads a compact
   * snapshot; `from: 'panel'` (study_call) is the learner's own UI.
   */
  async function call(action, args = {}, { from = 'panel' } = {}) {
    const language = args?.uiLanguage === 'en' ? 'en' : 'zh';
    try {
      if (typeof action !== 'string' || !action) throw new Error('An action is required');
      if (from === 'agent') {
        const refusal = boundary.assistantRefusal(action) || (PANEL_ONLY.has(action)
          ? `${action} is not available to the assistant: the model address and key are the learner's, set in the StudyHub panel` : null)
          || boundary.assistantArgsRefusal(action, args);
        if (refusal) return { ok: false, error: refusal, code: 'assistant-refused' };
        if (action === 'snapshot') args = { ...args, compact: true };
      }
      const own = await hostAction(action, args, from);
      if (own !== undefined) return { ok: true, value: hostLib.jsonSafe(own) };
      const answer = await request(action, args);
      return answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error?.message || 'Study request failed', code: answer.error?.code };
    } catch (error) {
      return { ok: false, error: zcodeErrorText(error, language), ...(error?.code ? { code: error.code } : {}) };
    }
  }

  /** The study service of the bound library (the one the panel's requests use), for the model's domain tools. */
  const currentService = () => hostLib.serviceFor(ctx, handlerConfig, config.libraryRoot, session, makeComplete, SESSION_ID, undefined, ctx);

  /** The typed domain tools DSH registers (lib/runtime/tools.js: study_materials, study_bank, …), over this host's library. */
  function domainTools() {
    // Each tool resolves the workspace first (lib/runtime/tools.js), so the service it found is the one the rest of that call uses.
    let service;
    const core = {
      resolveWorkspace: async () => { service = await currentService(); return service.store.root; },
      requestServices: async () => service.modelOptions,
      contextIds: () => [],
      forLibrary: () => {
        const runtime = service.runtime;
        return { invoke: (domain, operation, input, services) => runtime.invoke(domain, operation, input, services),
          call: (name, input, services) => runtime.call(name, input, services), capabilities: (services) => runtime.capabilities(services) };
      },
    };
    const list = ['bank', 'materials', 'generation', 'study', 'audio'].map((id) => tools.domainTool(id, core)).filter(Boolean);
    return [...list, tools.discoveryTool(core)];
  }

  return {
    call,
    domainTools,
    get config() { return config; },
    homeSource,
    async dispose() { for (const dispose of disposers.reverse()) await dispose(); },
  };
}
