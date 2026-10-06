import { dshJobExecutor } from './jobs/executor.js';
/* StudyHub for DeepSeek Harness (DSH): the plugin's server entry.
   Contributed by ericwang1358 (https://github.com/EricWang1358). */
import { studyToolDescription, studyUsagePrompt } from './study-contracts.js';
import Schema from "schemastery";
import { boardAction } from "./board.js";
import { resolveAudioImportPaths } from './audio-files.js';
import { scopeDiagramArgs } from './skeleton-diagrams.js';
import { acquireContexts } from './runtime/lifecycle.js';
import { fullContextIds } from './runtime/builtins.js';
let defineTool = definition => definition;
let llmSdk = {};
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
try { llmSdk = await import('@deepseek-ai/dsh-llm'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const { BlockAssembler, createUserMessage, ReasoningEffortId } = llmSdk;
import {
  binding,
  saveBinding,
  sessionModel,
  modelStatus,
  withModelStatus,
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
import { runGenerationAgent } from "./generation-agent.js";
import { correctionEffort, runCorrectionAgent } from './live-correction-agent.js';
import { reasoningFor } from './model-effort.js';
import { parentOfChild } from './host-capabilities.js';
import { GENERATION_TIMEOUT_MS } from "./generation-limits.js";
import { hedgeFirstChunk, streamFailure } from "./model-retry.js";
import { createSessionNotifier } from "./session-notice.js";
import { effortRoute, modelEfforts, withEffortPreference, withEffortState } from "./reasoning-effort.js";
import { acceptedEfforts, replacementEffort } from "./effort-rejection.js";
import { stageEffortRoute } from "./stage-effort.js";
import { usageFromTokenUsage } from "./token-usage.js";
/** DSH's session query (`ctx.sessionQuery`) when the host has it: the jobs context reads a finished sub-agent's final reply through it (lib/session-reply.js). */
const hostSessionQuery = (ctx) => { try { return ctx?.get?.('sessionQuery') || undefined; } catch { return undefined; } };
/** DSH's token estimator (`ctx.tokenMeter`) when the host has it; estimates fall back to its mirrored rule. */
export function hostTokenMeter(ctx) {
  try { return ctx?.get?.("tokenMeter") || undefined; } catch { return undefined; }
}
import { reportUsage } from "./usage-scope.js";
import { retrievalPort } from "./retrieval-host.js";

const LIGHT_TIMEOUT_MS = 90000;
const LIGHT_HEDGE_MS = 15000;

export const name = "daily-flashcard";
// Tool and command closures also resolve the live session's model route.
// Cordis requires this in the parent scope, not only in the panel transport.
export const inject = [];
export const Config = Schema.object({
  libraryRoot: Schema.string().default(""),
  provider: Schema.string().default(""),
  model: Schema.string().default(""),
  modular: Schema.boolean().default(false),
  contexts: Schema.array(Schema.string()).default(fullContextIds),
});
/* Passive panel context waits for the next step; terminal generation receipts
   start a reporting turn in the session that initiated the task. */
export const sessionNotifier = (agent) => createSessionNotifier(agent, createUserMessage, name);
// Cheapest thinking level per exact route: off/none/minimal when offered, else low.
const lightEfforts = new WeakMap();
// Levels a provider refused (2.6.1): provider/model/level -> the level it takes instead ('' = send none). See lib/effort-rejection.js.
const refusedEfforts = new Map();
export function pickLightEffort(efforts = []) {
  const find = (re) => efforts.find((e) => re.test(String(e.id)) || re.test(String(e.name)));
  const off = find(/^(off|none|disabled?|no[-_ ]?think(ing)?|minimal|non[-_ ]?thinking)$/i);
  if (off) return { id: String(off.id), off: true };
  const low = find(/low/i);
  if (low) return { id: String(low.id), off: false };
  // Some routes only offer e.g. high/max; efforts are listed in the adapter's
  // order (lowest first in DSH catalogs), so take the first rather than the default.
  return efforts.length ? { id: String(efforts[0].id), off: false } : null;
}
async function lightEffort(ctx, provider, model, signal) {
  let cache = lightEfforts.get(ctx);
  if (!cache) lightEfforts.set(ctx, cache = new Map());
  const key = provider + "\0" + model;
  if (!cache.has(key))
    cache.set(key, ctx.llm.resolveModelInfo?.(provider, model, signal)
      .then((info) => pickLightEffort(info?.reasoning?.efforts))
      .catch(() => {
        cache.delete(key);
        return null;
      }) ?? Promise.resolve(null));
  return cache.get(key);
}
const refusedKey = (route, id) => `${route.provider}\0${route.model}\0${id}`;
/** True when `error` is a provider's "invalid reasoning_effort" answer for a level we sent and a replacement is now remembered (retry is worth it). */
async function rememberRefusedEffort(ctx, error, signal) {
  const sent = error?.effortSent, accepted = sent && acceptedEfforts(error?.message);
  if (!accepted || signal?.aborted || refusedEfforts.has(refusedKey(sent, sent.id))) return false;
  let offered = [];
  try { offered = (await modelEfforts(ctx, sent.provider, sent.model, signal)).map((item) => item.id); } catch { /* none: send no level */ }
  refusedEfforts.set(refusedKey(sent, sent.id), replacementEffort(sent.id, accepted, offered) ?? '');
  return true;
}
/**
 * @param route - returns the provider/model to call, resolved per request.
 * @param options.light - 陪学 calls: lowest reasoning effort and, when thinking
 *   is fully off, a capped output so a chatty reply cannot burn tokens.
 * @param options.lightTimeoutMs / options.hedgeMs - per-attempt budget and the
 *   no-first-chunk delay before a light call races a second request.
 */
export function modelCompletion(ctx, route, sessionId, { light = false, lightTimeoutMs = LIGHT_TIMEOUT_MS, hedgeMs = LIGHT_HEDGE_MS } = {}) {
  if (!BlockAssembler || !ctx.llm) throw new Error('Model capability unavailable: DSH model SDK is absent');
  /* One streamed call. ctx.llm.stream never throws for provider problems: a
     rate limit, transport error or our own timeout abort all arrive as an
     `error`/`aborted` finish chunk. Read it, so a 90s timeout is reported as a
     timeout (and not retried as if the model had merely answered empty). */
  const complete = async (...args) => {
    try { return await completeOnce(...args); }
    catch (error) {
      // The provider refused the level DSH sent: ask again once with the nearest level it names as accepted.
      if (!(await rememberRefusedEffort(ctx, error, args[3]))) throw error;
      return completeOnce(...args);
    }
  };
  const completeOnce = async (system, prompt, timeoutMs = 180000, externalSignal, maxTokens, task = "light", onChunk, correctionReasoning, selectedRoute, sink) => {
    const started = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, ...(externalSignal ? [externalSignal] : [])]),
      chosen = selectedRoute || route();
    if (!chosen) throw new Error("No model is available for generation");
    // The learner's generation level (Settings) applies to question work only:
    // 陪学 forces the lowest level and corrections / audio carry their own.
    const selected = light || correctionReasoning ? chosen : await effortRoute(ctx, chosen, signal);
    const effort = light && !correctionReasoning ? await lightEffort(ctx, selected.provider, selected.model, signal) : null;
    let reasoningEffort = effort?.id ?? selected.reasoningEffort;
    if (correctionReasoning) {
      // A correction never inherits the parent chat's high reasoning setting.
      reasoningEffort = await correctionEffort(ctx, selected, correctionReasoning, signal);
    }
    const refusal = reasoningEffort === undefined ? undefined : refusedEfforts.get(refusedKey(selected, reasoningEffort));
    if (refusal !== undefined) reasoningEffort = refusal || undefined;
    const call = await ctx.llm.resolveCallConfig(
      {
        provider: selected.provider,
        model: selected.model,
        ...(reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
        ...(((effort?.off && refusal === undefined) || correctionReasoning || task === 'assist') && maxTokens ? { maxTokens } : {}),
      },
      signal,
    );
    const assembler = new BlockAssembler();
    const configured = performance.now();
    let firstChunk = null,
      firstText = null,
      outcome = "failed";
    try {
      for await (const chunk of ctx.llm.stream({
        ...call,
        system,
        messages: [
          createUserMessage({ content: [{ type: "text", text: prompt }] }),
        ],
        sessionId,
        signal,
      })) {
        if (firstChunk === null) {
          firstChunk = performance.now();
          onChunk?.();
        }
        if (firstText === null && chunk.type === "text-delta") firstText = performance.now();
        assembler.push(chunk);
        // What the model writes on the way, for the console's 实时输出 (lib/job-output.js): the answer's text, and only the size of its reasoning.
        if (sink) { if (chunk.type === "text-delta") sink.text?.(chunk.text); else if (chunk.type === "reasoning-delta") sink.reasoning?.(chunk.text.length); }
      }
      const finish = assembler.finish;
      if (finish?.kind === "error" || finish?.kind === "aborted" || signal.aborted) {
        if (externalSignal?.aborted && !timeout.aborted) outcome = "cancelled";
        throw Object.assign(streamFailure(finish, { timedOut: timeout.aborted, timeoutMs }), { modelFailure: true });
      }
      const text = assembler
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text.trim()) throw Object.assign(new Error("Model returned no text"), { modelFailure: true });
      outcome = "ok";
      return text;
    } catch (error) {
      if (error && typeof error === "object" && !error.modelFailure && (timeout.aborted || externalSignal?.aborted)) {
        if (externalSignal?.aborted && !timeout.aborted) outcome = "cancelled";
        throw Object.assign(streamFailure(null, { timedOut: timeout.aborted, timeoutMs }), { modelFailure: true, cause: error });
      }
      if (error && typeof error === "object" && reasoningEffort !== undefined) Object.assign(error, { effortSent: { provider: selected.provider, model: selected.model, id: String(reasoningEffort) } });
      throw error;
    } finally {
      const ended = performance.now();
      // What the provider billed for this attempt, answered or not (WP27); a sink can never break the call.
      reportUsage(usageFromTokenUsage(assembler.usage), { calls: 1, task });
      if (light && outcome !== "cancelled" && ended - started >= 2000)
        console.warn(`[study-model] ${task} ${outcome}: config ${Math.round(configured - started)}ms, first chunk ${firstChunk === null ? "none" : Math.round(firstChunk - configured) + "ms"}, first text ${firstText === null ? "none" : Math.round(firstText - configured) + "ms"}, generation ${firstText === null ? 0 : Math.round(ended - firstText)}ms, total ${Math.round(ended - started)}ms`);
    }
  };
  const correct = (system, prompt, options) => complete(system, prompt, lightTimeoutMs, options.signal, options.maxTokens, options.task, undefined, options.reasoningEffort || 'low');
  const attachChild = fn => Object.assign(fn, { spawnCorrection: (system, prompt, options = {}) => {
    const selected = route();
    return runCorrectionAgent(ctx, selected, sessionId, system, prompt, options,
      () => complete(system, prompt, lightTimeoutMs, options.signal, options.maxOutputTokens || 4096, 'live.correct.background', undefined, options.reasoningEffort || 'low', selected));
  } });
  if (light)
    // A request that has not produced a single chunk after 15s is usually
    // stuck in the provider's queue; race a fresh one instead of waiting 90s.
    // A caller that names a reasoning level (为你定制's batches, lib/coach-daily.js) gets that level instead of the lowest one the light path uses by default.
    return attachChild((system, prompt, options = {}) => options.task?.startsWith('live.correct') || options.reasoningEffort
      ? correct(system, prompt, options)
      : hedgeFirstChunk((signal, onChunk) => complete(system, prompt, lightTimeoutMs, signal, options.maxTokens, options.task, onChunk), { hedgeMs }));
  const audio = async (system, prompt, execution) => {
    const selected = route();
    // The preference is a relative strength; the nearest level this model offers is used, and the task says which and why.
    const choice = await reasoningFor(ctx, selected, execution.reasoningEffort, execution.signal);
    execution.onEvent?.({ reasoningEffort: choice.id ?? 'default', reasoningName: choice.name, reasoningApplied: choice.applied,
      ...(choice.reason ? { reasoningReason: choice.reason } : {}) });
    // The task keeps which session the sub-agent runs under, so the panel can ask DSH to list it before opening it.
    const watched = execution.onEvent ? { ...execution, onEvent: (event) => execution.onEvent(event?.childId ? { ...event, parentId: parentOfChild(event.childId) } : event) } : execution;
    return runGenerationAgent(ctx, { ...selected, reasoningEffort: choice.id }, sessionId, system, prompt, watched,
      () => complete(system, prompt, GENERATION_TIMEOUT_MS, execution.signal, undefined, 'audio.text', undefined, execution.reasoningEffort, selected, { text: execution.onOutput, reasoning: execution.onReasoning }));
  };
  /** A question-generation phase: the learner's level, recorded on the step that used it. */
  const generation = async (system, prompt, execution) => {
    // The session's level, then the stage's own (planning/review/writing/repair) when the learner set one for it (#218).
    const staged = await stageEffortRoute(ctx, await effortRoute(ctx, route(), execution.signal), execution.stage, execution.stageEffort, execution.signal);
    const selected = staged.route;
    if (selected?.reasoningEffort !== undefined || staged.choice) execution.onEvent?.({ reasoningEffort: String(selected?.reasoningEffort ?? 'default'),
      ...(staged.choice ? { reasoning: staged.choice.preference, reasoningName: staged.choice.name, reasoningApplied: staged.choice.applied,
        ...(staged.choice.reason ? { reasoningReason: staged.choice.reason } : {}) } : {}) });
    return runGenerationAgent(ctx, selected, sessionId, system, prompt, execution,
      () => complete(system, prompt, GENERATION_TIMEOUT_MS, execution.signal, undefined, undefined, undefined, undefined, selected, { text: execution.onOutput, reasoning: execution.onReasoning }));
  };
  return attachChild((system, prompt, execution) => execution?.task === 'assist'
    ? complete(system, prompt, 8 * 60 * 1000, execution.signal, execution.maxTokens, 'assist', undefined, undefined, execution.route)
    : execution?.resultOwner === 'plugin' && execution.reasoningEffort ? audio(system, prompt, execution)
    : execution?.task?.startsWith('live.correct') ? correct(system, prompt, execution)
    // Only a question-generation phase carries a job id (its worker is labelled with it). A request with just a signal, such as the
    // answer about a selected passage, is one plain call: sending it to the generation worker failed on `execution.jobId.slice`.
    : execution?.jobId ? generation(system, prompt, execution)
    : complete(system, prompt, undefined, execution?.signal, execution?.maxTokens));
}
function installWorkbench(ctx, config = {}) {
  const hostCtx = ctx.root || ctx;
  const owned = servicesForHost(ctx), { bridge } = owned;
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
    // The usage frequency record is the learner's own: the panel reads and switches it, the assistant never does (docs/usage-frequency.md).
    if (a.action.startsWith("usage.frequency."))
      throw new Error("usage.frequency.* is not available to the assistant: it is the learner's own usage record, used by the panel only");
    // Installing software on the learner's computer is the learner's own click in Settings, never an assistant tool call.
    if (["marker.install.start", "marker.install.uninstall"].includes(a.action))
      throw new Error(`${a.action} is not available to the assistant: it installs or removes software, and the learner starts it in Settings`);
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
      let candidates;
      if (args.cardId) {
        const { deck, card } = await service.call("card.locate", args);
        candidates = [{ deckId: deck.id, deckTitle: deck.title, cardId: card.id,
          kind: card.kind, topic: card.topic, prompt: String(card.prompt).slice(0, 160) }];
      } else {
        if (typeof args.query !== "string" || !args.query.trim())
          throw new Error("请给出题目关键词或 cardId");
        const found = await service.call("card.search", { query: args.query, limit: 20 });
        candidates = found.results;
      }
      if (!candidates.length) return { status: "not_found", query: args.query || "" };
      if (candidates.length > 1) {
        bridge.queuePanelIntent(agent.id, { type: "candidates", candidates, returnTo });
        return { status: "candidates_queued", total: candidates.length, candidates };
      }
      const selected = candidates[0];
      const run = await service.call("review.start", { mode: "path", fresh: true,
        scope: [{ deckId: selected.deckId, cardId: selected.cardId }],
        ...(returnTo ? { returnTo } : {}) });
      bridge.queuePanelIntent(agent.id, { type: "run", runId: run.id });
      return { status: "queued_for_sidebar", runId: run.id, deckId: selected.deckId,
        cardId: selected.cardId, prompt: selected.prompt, returnTo };
    }
    const value = await service.call(
      a.action,
      a.action === "snapshot" ? { ...args, compact: true } : a.action === 'audio.import' ? resolveAudioImportPaths(cwd, args) : scopeDiagramArgs(a.action, args, cwd),
    );
    if (a.action === 'daily.plan.start') {
      const intent = value.run
        ? { type: 'run', runId: value.run.id }
        : { type: 'studyRef', studyRef: value.studyRef };
      bridge.queuePanelIntent(agent.id, intent);
      return { ...value, status: 'queued_for_sidebar' };
    }
    if (a.action === "snapshot" && value && typeof value === "object")
      withModelStatus(value, await modelStatus(hostCtx, (await binding(cwd, config)).route || followed()));
    return value;
  }
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
    const sessionQuery = hostSessionQuery(root);
    if (!agent?.session) return { signal, workOwner, audioGate, sessionQuery, jobExecutor };
    const saved = await binding(agent.session.header.cwd, config);
    if (owned) owned.sharedRuntimes.add(api.runtimeForLibrary(saved.root));
    const route = () => saved.route || withEffortPreference(sessionModel(root, root.sessions?.get(agent.id) || agent.session), saved.reasoningEffort);
    if (!route() || !root.llm || !BlockAssembler) return { signal, workOwner, audioGate, sessionQuery, jobExecutor };
    return { complete: modelCompletion(root, route, agent.id),
      completeLight: modelCompletion(root, route, agent.id, { light: true }),
      sessionId: agent.id, signal, workOwner, audioGate, jobExecutor, notify: sessionNotifier(agent), tokenMeter: hostTokenMeter(root), sessionQuery,
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
