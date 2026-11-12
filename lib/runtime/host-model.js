import { runGenerationAgent } from "../generation-agent.js";
import { stageRequest } from "../prompt-order.js";
import { correctionEffort, runCorrectionAgent } from "../live-correction-agent.js";
import { reasoningFor } from "../model-effort.js";
import { hostOffersModel, parentOfChild } from "../host-capabilities.js";
import { GENERATION_TIMEOUT_MS } from "../generation-limits.js";
import { hedgeFirstChunk, streamFailure } from "../model-retry.js";
import { createSessionNotifier } from "../session-notice.js";
import { effortRoute, modelEfforts, routeOnModel } from "../reasoning-effort.js";
import { acceptedEfforts, replacementEffort } from "../effort-rejection.js";
import { stageEffortRoute } from "../stage-effort.js";
import { usageFromTokenUsage } from "../token-usage.js";
import { reportUsage } from "../usage-scope.js";

let llmSdk = {};
try { llmSdk = await import("@deepseek-ai/dsh-llm"); }
catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
const { BlockAssembler, createUserMessage, ReasoningEffortId } = llmSdk;

const LIGHT_TIMEOUT_MS = 90000;
const LIGHT_HEDGE_MS = 15000;

export const PLUGIN_SOURCE_NAME = "daily-flashcard";
export const hasModelSdk = () => Boolean(BlockAssembler);

/** DSH's token estimator (`ctx.tokenMeter`) when the host has it; estimates fall back to its mirrored rule. */
export function hostTokenMeter(ctx) {
  try { return ctx?.get?.("tokenMeter") || undefined; } catch { return undefined; }
}

/* Passive panel context waits for the next step; terminal generation receipts
   start a reporting turn in the session that initiated the task. */
export const sessionNotifier = (agent) => createSessionNotifier(agent, createUserMessage, PLUGIN_SOURCE_NAME);

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
  refusedEfforts.set(refusedKey(sent, sent.id), replacementEffort(sent.id, accepted, offered) ?? "");
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
  if (!BlockAssembler || !ctx.llm) throw new Error("Model capability unavailable: DSH model SDK is absent");
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
        ...(((effort?.off && refusal === undefined) || correctionReasoning || task === "assist") && maxTokens ? { maxTokens } : {}),
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
      // Cut at the output cap before any answer (a model that thinks first): the same request is cut the same way, so it is not retried.
      if (!text.trim() && finish?.kind === "max-tokens")
        throw Object.assign(new Error("Model returned no text: it reached its output limit before answering"), { modelFailure: true, code: "MAX_TOKENS" });
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
  const lightRouteOf = (options) => {
    const wanted = options?.lightRoute ?? options?.route;
    return wanted && hostOffersModel(ctx, wanted) !== false ? { provider: wanted.provider, model: wanted.model } : undefined;
  };
  const correct = (system, prompt, options) => complete(system, prompt, lightTimeoutMs, options.signal, options.maxTokens, options.task, undefined, options.reasoningEffort || "low", lightRouteOf(options));
  const attachChild = (fn) => Object.assign(fn, { spawnCorrection: (system, prompt, options = {}) => {
    const selected = route();
    return runCorrectionAgent(ctx, selected, sessionId, system, prompt, options,
      () => complete(system, prompt, lightTimeoutMs, options.signal, options.maxOutputTokens || 4096, "live.correct.background", undefined, options.reasoningEffort || "low", selected));
  } });
  if (light)
    // A request that has not produced a single chunk after 15s is usually
    // stuck in the provider's queue; race a fresh one instead of waiting 90s.
    // A caller that names a reasoning level (为你定制's batches, lib/coach-daily.js) gets that level instead of the lowest one the light path uses by default.
    return attachChild((system, prompt, options = {}) => options.task?.startsWith("live.correct") || options.reasoningEffort
      ? correct(system, prompt, options)
      // A stop from the caller (a Job's signal) ends every attempt of the race, not only the one that has not started.
      : hedgeFirstChunk((signal, onChunk) => complete(system, prompt, lightTimeoutMs, options.signal ? AbortSignal.any([signal, options.signal]) : signal, options.maxTokens, options.task, onChunk, undefined, lightRouteOf(options)), { hedgeMs }));
  const audio = async (system, prompt, execution) => {
    const selected = route();
    // The preference is a relative strength; the nearest level this model offers is used, and the task says which and why.
    const choice = await reasoningFor(ctx, selected, execution.reasoningEffort, execution.signal);
    execution.onEvent?.({ reasoningEffort: choice.id ?? "default", reasoningName: choice.name, reasoningApplied: choice.applied,
      ...(choice.reason ? { reasoningReason: choice.reason } : {}) });
    // The task keeps which session the sub-agent runs under, so the panel can ask DSH to list it before opening it.
    const watched = execution.onEvent ? { ...execution, onEvent: (event) => execution.onEvent(event?.childId ? { ...event, parentId: parentOfChild(event.childId) } : event) } : execution;
    return runGenerationAgent(ctx, { ...selected, reasoningEffort: choice.id }, sessionId, system, prompt, watched,
      () => complete(system, prompt, GENERATION_TIMEOUT_MS, execution.signal, undefined, "audio.text", undefined, execution.reasoningEffort, selected, { text: execution.onOutput, reasoning: execution.onReasoning }));
  };
  /** A question-generation phase: the learner's level, recorded on the step that used it. */
  const generation = async (stageSystem, stagePrompt, execution) => {
    // What the stages of a part share (their sources) leads the request, the stage's own system text behind it (lib/prompt-order.js stageRequest): the provider caches that start.
    const { system, prompt } = stageRequest(stageSystem, stagePrompt);
    // The model the learner chose for this run (lib/job-model.js), else the host's; the session's level, then the stage's own (planning/review/writing/repair) when the learner set one for it (#218).
    const lightChoice = execution.lightRoute && hostOffersModel(ctx, execution.lightRoute) !== false ? execution.lightRoute : null;
    const base = lightChoice
      ? { provider: lightChoice.provider, model: lightChoice.model }
      : await routeOnModel(ctx, route(), execution.model, execution.signal);
    const staged = await stageEffortRoute(ctx, await effortRoute(ctx, base, execution.signal), execution.stage, execution.stageEffort, execution.signal);
    const selected = staged.route;
    if (selected?.reasoningEffort !== undefined || staged.choice) execution.onEvent?.({ reasoningEffort: String(selected?.reasoningEffort ?? "default"),
      ...(staged.choice ? { reasoning: staged.choice.preference, reasoningName: staged.choice.name, reasoningApplied: staged.choice.applied,
        ...(staged.choice.reason ? { reasoningReason: staged.choice.reason } : {}) } : {}) });
    return runGenerationAgent(ctx, selected, sessionId, system, prompt, execution,
      () => complete(system, prompt, GENERATION_TIMEOUT_MS, execution.signal, undefined, undefined, undefined, undefined, selected, { text: execution.onOutput, reasoning: execution.onReasoning }));
  };
  return attachChild((system, prompt, execution) => execution?.task === "assist"
    ? complete(system, prompt, 8 * 60 * 1000, execution.signal, execution.maxTokens, "assist", undefined, undefined, execution.route, { text: execution.onOutput, reasoning: execution.onReasoning })
    : execution?.resultOwner === "plugin" && execution.reasoningEffort ? audio(system, prompt, execution)
    : execution?.task?.startsWith("live.correct") ? correct(system, prompt, execution)
    // Only a question-generation phase carries a job id (its worker is labelled with it). A request with just a signal, such as the
    // answer about a selected passage, is one plain call: sending it to the generation worker failed on `execution.jobId.slice`.
    : execution?.jobId ? generation(system, prompt, execution)
    : complete(system, prompt, undefined, execution?.signal, execution?.maxTokens, undefined, undefined, undefined, execution?.route));
}
