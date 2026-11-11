import { dshJobExecutor } from './jobs/executor.js';
/* StudyHub for DeepSeek Harness (DSH): the plugin's server entry.
   Contributed by ericwang1358 (https://github.com/EricWang1358). */
import { studyToolDescription, studyUsagePrompt } from './study-contracts.js';
import { registerStudySkills } from './study-skills.js';
import Schema from "schemastery";
import { boardAction } from "./board.js";
import { resolveAudioImportPaths } from './audio-files.js';
import { effectiveDirectory } from './working-directory.js';
import { scopeDiagramArgs } from './skeleton-diagrams.js';
import { acquireContexts } from './runtime/lifecycle.js';
import { fullContextIds } from './runtime/builtins.js';
import {
  hasModelSdk,
  hostTokenMeter,
  modelCompletion,
  pickLightEffort,
  PLUGIN_SOURCE_NAME,
  sessionNotifier,
} from './runtime/host-model.js';
let defineTool = definition => definition;
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
import {
  binding,
  saveBinding,
  sessionModel,
  modelStatus,
  withModelStatus,
  withSession,
  serviceFor,
  installTransport,
  jsonSafe,
  servicesForHost,
} from "./host.js";
import {
  listNotebooks,
  publishNotebook,
  unpublishNotebook,
  searchNotebooks,
} from "./notebooks.js";
import { parseSparInput, formatCapture } from "./capture.js";
import { withEffortPreference, withEffortState } from "./reasoning-effort.js";
/** DSH's session query (`ctx.sessionQuery`) when the host has it: the jobs context reads a finished sub-agent's final reply through it (lib/session-reply.js). */
const hostSessionQuery = (ctx) => { try { return ctx?.get?.('sessionQuery') || undefined; } catch { return undefined; } };
import { retrievalPort } from "./retrieval-host.js";
import { assistantArgsRefusal, assistantRefusal } from "./assistant-boundary.js";
import { readAudioSettings } from "./audio-settings.js";
import { RuntimeConfig } from "./runtime-config.js";

export { hostTokenMeter, sessionNotifier, pickLightEffort, modelCompletion };

export const name = PLUGIN_SOURCE_NAME;
// Tool and command closures also resolve the live session's model route.
// Cordis requires this in the parent scope, not only in the panel transport.
export const inject = [];
export const Config = Schema.object({
  libraryRoot: Schema.string().default(""),
  provider: Schema.string().default(""),
  model: Schema.string().default(""),
  modular: Schema.boolean().default(false),
  contexts: Schema.array(Schema.string()).default(fullContextIds),
  runtime: RuntimeConfig,
});
function installWorkbench(ctx, config = {}) {
  const hostCtx = ctx.root || ctx;
  const owned = servicesForHost(ctx, config.runtime?.resources, config.runtime?.pilot), { bridge } = owned;
  if (hostCtx[workbenchScope]) hostCtx[workbenchScope].services = owned;
  const makeComplete = (route, id, options) => modelCompletion(hostCtx, route, id, options);
  installTransport(ctx, config, makeComplete);
  ctx.inject(["commands"], (c) => {
    c.commands.register({
      name: "study-spar",
      description: "把不会的问题归类进题库：自动判断范围与原题，默认存为闪卡",
      input: { hint: "[前置] <不会的问题>（加“写成 MQ”存为单选题；以“前置”开头则挂到正在做的题上）" },
      handler: async ({ agent, rawInput }) => {
        const { question, kind, prerequisite } = parseSparInput(rawInput);
        if (!question)
          return {
            kind: "error",
            text: "用法：/study-spar <不会的问题>。默认存为闪卡；加“写成 MQ”存为单选题，“写成多选题”存为多选题。",
          };
        const cwd = agent?.session?.header?.cwd;
        if (!cwd) return { kind: "error", text: "当前会话没有工作区，无法打开学习库。" };
        try {
          const service = await serviceFor(
            hostCtx,
            config,
            cwd,
            agent.session,
            makeComplete,
            agent.id,
            sessionNotifier(agent),
            ctx,
          );
          return {
            kind: "success",
            text: formatCapture(
              await service.call("capture", {
                question,
                kind,
                ...(prerequisite ? { requiredBy: "current" } : {}),
              }),
            ),
          };
        } catch (e) {
          return { kind: "error", text: `没能加入题库：${e.message}` };
        }
      },
    });
  });
  ctx.inject(['tools', 'sessions'], toolCtx => toolCtx.tools.register(
    defineTool({
      name: "study_workspace",
      description: studyToolDescription,
      parameters: {
        action: { type: "string", required: true },
        payload_json: {
          type: "string",
          description: "JSON object of action arguments; omit for read actions",
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(a, exec) {
        const value = jsonSafe(await runStudyTool(a, exec));
        // The output schema is an object; DSH rejects null, arrays and scalars
        // with `"value" must be an object`, failing the whole code run.
        return value && typeof value === "object" && !Array.isArray(value)
          ? value
          : { result: value };
      },
    }),
  ));
  /** Runs one study_workspace call; execute normalizes the result to lossless JSON. */
  async function runStudyTool(a, exec) {
    const agent = exec.agent,
      cwd = agent?.session?.header?.cwd;
    if (!cwd) throw new Error("A session workspace is required");
    // The learner's own usage record and Settings-only actions (programs, installs, models, tokens, consent) are refused by name (lib/assistant-boundary.js).
    const refusal = assistantRefusal(a.action);
    if (refusal) throw new Error(refusal);
    let args = {};
    if (a.payload_json) {
      try {
        args = JSON.parse(a.payload_json);
      } catch (e) {
        throw new Error(
          `payload_json is not valid JSON (${e.message}); send the action arguments as a JSON object string`,
        );
      }
    }
    // live.start with a provider is checked against the learner's saved engine choice (it never leaves this computer for the check).
    const liveProvider = a.action === "live.start" && args?.provider !== undefined ? (await readAudioSettings()).liveProvider : undefined;
    const argsRefusal = assistantArgsRefusal(a.action, args, { liveProvider });
    if (argsRefusal) throw new Error(argsRefusal);
    if (a.action.startsWith("board.")) return boardAction(a.action, args, cwd);
    const followed = () => sessionModel(hostCtx, agent.session);
    if (a.action.startsWith("notebook.")) {
      const root = (await binding(cwd, config)).root;
      if (a.action === "notebook.publish") await publishNotebook(cwd, root);
      else if (a.action === "notebook.unpublish") await unpublishNotebook(root);
      else if (a.action === "notebook.search")
        return searchNotebooks(args.query);
      else if (a.action !== "notebook.list")
        throw new Error(`Unknown action: ${a.action}`);
      return listNotebooks(root);
    }
    // `model` stays the custom model id; the C3 readiness rides beside it.
    const bound = async () => {
      const value = await binding(cwd, config, followed());
      value.modelStatus = await modelStatus(hostCtx, value.route);
      await withEffortState(hostCtx, value);
      return value;
    };
    if (a.action === "binding.get")
      return bound();
    if (a.action === "binding.set") {
      await saveBinding(cwd, args);
      return bound();
    }
    const service = await serviceFor(
      hostCtx,
      config,
      cwd,
      agent.session,
      makeComplete,
      agent.id,
      sessionNotifier(agent),
      ctx,
    );
    bridge.registerPanelNotifier(agent.id, sessionNotifier(agent));
    if (a.action === "panel.current") {
      return { current: bridge.hasPanelVisibility(agent.id) ? bridge.panelObservation(agent.id) : null };
    }
    if (a.action === "panel.open") {
      const current = await service.call("snapshot", { compact: true });
      const returnTo = current.lastRun?.id || null;
      // Hand a round to the right panel and say only what the host confirmed (#537): visible, deferred by the learner's own activity, or queued.
      const deliver = async (run, focus, extra = {}) => {
        const intentResult = bridge.queuePanelIntent(agent.id, { type: "run", runId: run.id, expectedFocus: focus });
        const ackTimeout = typeof args.ackTimeoutMs === 'number' ? args.ackTimeoutMs : 2200;
        const ack = await bridge.waitForIntentAck(agent.id, intentResult.intentId, ackTimeout);
        const isVisible = ack && ack.status === 'displayed';
        const isDeferred = ack && ack.status === 'deferred_by_user_activity';
        const status = isVisible ? 'visible_in_sidebar' : isDeferred ? 'deferred_by_user_activity' : 'queued_for_sidebar';
        return { status, confirmed: !!isVisible, intentId: intentResult.intentId, runId: run.id, ...extra };
      };
      const focusOf = (run) => (run.card ? { cardId: run.card.id, deckId: run.deckId } : null);
      // A round that already exists (#551): the one the learner asked for, as it is (its order, position, answers and drafts), never a new one.
      if (args.runId !== undefined) {
        if (typeof args.runId !== "string" || !args.runId) throw new Error("runId must name a round (review.start / review.get)");
        const run = await service.call("review.get", { runId: args.runId });
        if (run.closed) throw new Error("This round has ended; start a new one with review.start or panel.open {scope}");
        return deliver(run, focusOf(run), { index: run.index, total: run.total, title: run.title });
      }
      // Several named questions as one round, in the order given; an open round over exactly these is resumed, not started again.
      if (args.scope !== undefined) {
        if (!Array.isArray(args.scope) || !args.scope.length || args.scope.length > 200 || args.scope.some((ref) => !ref?.cardId))
          throw new Error("scope is 1–200 questions [{deckId?, cardId}]");
        const scope = [];
        for (const ref of args.scope) { const { deck, card } = await service.call("card.locate", ref); scope.push({ deckId: deck.id, cardId: card.id }); }
        const run = await service.call("review.start", { mode: "path", scope, ...(returnTo ? { returnTo } : {}) });
        return deliver(run, focusOf(run), { index: run.index, total: run.total, returnTo });
      }
      let candidates;
      if (args.cardId) {
        const { deck, card } = await service.call("card.locate", args);
        candidates = [{ deckId: deck.id, deckTitle: deck.title, cardId: card.id,
          kind: card.kind, topic: card.topic, prompt: String(card.prompt).slice(0, 160) }];
      } else {
        if (typeof args.query !== "string" || !args.query.trim())
          throw new Error("请给出题目关键词、cardId、scope:[{deckId,cardId}] 或已有一轮的 runId");
        const found = await service.call("card.search", { query: args.query, limit: 20 });
        candidates = found.results;
      }
      if (!candidates.length) return { status: "not_found", query: args.query || "" };
      if (candidates.length > 1) {
        const intentResult = bridge.queuePanelIntent(agent.id, { type: "candidates", candidates, returnTo });
        return { status: "candidates_queued", total: candidates.length, candidates, intentId: intentResult?.intentId };
      }
      const selected = candidates[0];
      const run = await service.call("review.start", { mode: "path", fresh: true,
        scope: [{ deckId: selected.deckId, cardId: selected.cardId }],
        ...(returnTo ? { returnTo } : {}) });
      return deliver(run, { cardId: selected.cardId, deckId: selected.deckId }, { deckId: selected.deckId, cardId: selected.cardId, prompt: selected.prompt, returnTo });
    }
    // A path the learner names is read from the conversation's current folder (DSH 0.2.1 can change it); the library stays bound to `cwd`.
    const here = effectiveDirectory(hostCtx, agent.session, cwd);
    const value = await service.call(
      a.action,
      a.action === "snapshot" ? { ...args, compact: true } : a.action === 'audio.import' ? resolveAudioImportPaths(here, args) : scopeDiagramArgs(a.action, args, here, cwd),
    );
    // An edited round (#551) is handed to the panel again, so the panel shows its new queue.
    if (a.action === 'review.queue.edit' && value?.id) {
      const intent = bridge.queuePanelIntent(agent.id, { type: 'run', runId: value.id });
      return { ...value, panel: 'queued_for_sidebar', intentId: intent?.intentId };
    }
    if (a.action === 'daily.plan.start') {
      const intent = value.run
        ? { type: 'run', runId: value.run.id }
        : { type: 'studyRef', studyRef: value.studyRef };
      bridge.queuePanelIntent(agent.id, intent);
      return { ...value, status: 'queued_for_sidebar' };
    }
    if (a.action === 'study.session.start' || a.action === 'study.session.resume') {
      const intent = {
        type: 'guidedStudy',
        sessionId: value?.id || args.sessionId,
        session: value,
      };
      bridge.queuePanelIntent(agent.id, intent);
      return { ...value, status: 'queued_for_sidebar' };
    }
    // 带学现场出的新题 (#547): once it is published its round of one question goes to the right panel, as review.start's would.
    if (a.action === 'study.question.result' && value?.status === 'ready' && value.runId) {
      const intent = bridge.queuePanelIntent(agent.id, { type: 'run', runId: value.runId, expectedFocus: { cardId: value.cardId, deckId: value.deckId } });
      const { run: _run, ...rest } = value;
      return { ...rest, status: 'ready', panel: 'queued_for_sidebar', intentId: intent?.intentId };
    }
    if (a.action === "snapshot" && value && typeof value === "object")
      withModelStatus(value, withSession(await modelStatus(hostCtx, (await binding(cwd, config)).route || followed()), followed()));
    return value;
  }
  // The skills StudyHub ships (lib/study-skills.js: study-book, the main chat's way of editing the review book), when the host has a skill registry.
  ctx.inject(['skills'], skillCtx => { registerStudySkills(skillCtx); });
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: "daily-flashcard:usage",
    order: 70,
    text: studyUsagePrompt,
  }));
}

const workbenchScope = Symbol.for('studyhub.workbench.host.v1');
const optionalContexts = new Set(['materials', 'bank', 'study', 'authoring', 'generation', 'audio']);
export async function apply(ctx, config = {}) {
  const selected = (config.contexts || fullContextIds).filter(id => !config.modular || !optionalContexts.has(id));
  for (const id of selected) if (!fullContextIds.includes(id)) throw new Error(`Unknown context ${id}`);
  const root = ctx.root || ctx;
  let host = root[workbenchScope];
  if (host && JSON.stringify(host.config.runtime?.resources || {}) !== JSON.stringify(config.runtime?.resources || {}))
    throw new Error('Shared resource configuration cannot change while a host is active; drain and unload its owners first');
  if (!host) {
    host = { owners: 0, configurations: new Map(), config: { ...config } };
    Object.defineProperty(root, workbenchScope, { value: host, configurable: true });
    if (typeof root.plugin === 'function') host.fiber = root.plugin({ name: 'studyhub-workbench-host', inject: [],
      apply: context => installWorkbench(context, host.config) });
    else installWorkbench(ctx, host.config);
  }
  if (host.fiber) await host.fiber;
  let api;
  try { ({ api } = acquireContexts(ctx, selected)); }
  catch (error) {
    if (!host.owners) { delete root[workbenchScope]; await host.fiber?.dispose(); }
    throw error;
  }
  const owner = Symbol('workbench configuration');
  host.configurations.set(owner, config);
  const syncConfig = () => {
    const current = [...host.configurations.values()].at(-1) || {};
    for (const key of Object.keys(host.config)) delete host.config[key];
    Object.assign(host.config, current);
  };
  syncConfig();
  host.owners++;
  const releaseHost = api.configureHost({ resolveWorkspace: async execution => {
    const cwd = execution?.agent?.session?.header?.cwd;
    return cwd ? (await binding(cwd, config)).root : undefined;
  }, requestServices: async execution => {
    const agent = execution?.agent;
    const signal = execution?.signal;
    const jobExecutor = dshJobExecutor(ctx, agent);
    const owned = host.services;
    const workOwner = owned?.workOwner;
    const audioGate = owned?.audioGate;
    const providerResources = owned?.providerResources;
    const runtimePilot = owned?.runtimePilot;
    const sessionQuery = hostSessionQuery(root);
    if (!agent?.session) return { signal, workOwner, audioGate, providerResources, runtimePilot, sessionQuery, jobExecutor };
    const saved = await binding(agent.session.header.cwd, config);
    if (owned) owned.sharedRuntimes.add(api.runtimeForLibrary(saved.root));
    const route = () => saved.route || withEffortPreference(sessionModel(root, root.sessions?.get(agent.id) || agent.session), saved.reasoningEffort);
    if (!route() || !root.llm || !hasModelSdk()) return { signal, workOwner, audioGate, providerResources, runtimePilot, sessionQuery, jobExecutor };
    const complete = modelCompletion(root, route, agent.id);
    return { complete, jobModelHost: { ctx: agent.ctx || root, route, sessionId: agent.id, complete },
      completeLight: modelCompletion(root, route, agent.id, { light: true }),
      sessionId: agent.id, signal, workOwner, audioGate, providerResources, runtimePilot, jobExecutor, notify: sessionNotifier(agent), tokenMeter: hostTokenMeter(root), sessionQuery,
      retrieval: retrievalPort(root) };
  } });
  ctx.effect?.(() => () => {
    releaseHost();
    host.configurations.delete(owner);
    syncConfig();
    if (--host.owners) return;
    delete root[workbenchScope];
    return host.fiber?.dispose();
  });
}
