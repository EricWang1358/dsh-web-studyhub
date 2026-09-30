import { studyToolDescription, studyUsagePrompt } from './study-contracts.js';
import Schema from "schemastery";
import { boardAction } from "./board.js";
import { resolveAudioImportPaths } from './audio-files.js';
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  BlockAssembler,
  createUserMessage,
  ReasoningEffortId,
} from "@deepseek-ai/dsh-llm";
import {
  binding,
  saveBinding,
  sessionModel,
  serviceFor,
  installTransport,
  jsonSafe,
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
import { GENERATION_TIMEOUT_MS } from "./generation-limits.js";
import { hedgeFirstChunk, streamFailure } from "./model-retry.js";
import { queuePanelIntent, panelObservation, hasPanelVisibility, registerPanelNotifier,
} from "./panel-bridge.js";
import { createSessionNotifier } from "./session-notice.js";

const LIGHT_TIMEOUT_MS = 90000;
const LIGHT_HEDGE_MS = 15000;

export const name = "daily-flashcard";
// Tool and command closures also resolve the live session's model route.
// Cordis requires this in the parent scope, not only in the panel transport.
export const inject = ["tools", "llm", "systemPrompt", "sessions"];
export const Config = Schema.object({
  libraryRoot: Schema.string().default(""),
  provider: Schema.string().default(""),
  model: Schema.string().default(""),
});
/* Background results reach the conversation as injected plugin context: queued
   for the session's next step, so a finished generation is reported without
   interrupting whatever the learner is doing. Hosts without the inbox API just
   skip it. */
const sessionNotifier = (agent) => createSessionNotifier(agent, createUserMessage, name);
// Cheapest thinking level per exact route: off/none/minimal when offered, else low.
const lightEfforts = new Map();
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
  const key = provider + "\0" + model;
  if (!lightEfforts.has(key))
    lightEfforts.set(key, ctx.llm.resolveModelInfo?.(provider, model, signal)
      .then((info) => pickLightEffort(info?.reasoning?.efforts))
      .catch(() => {
        lightEfforts.delete(key);
        return null;
      }) ?? Promise.resolve(null));
  return lightEfforts.get(key);
}
/**
 * @param route - returns the provider/model to call, resolved per request.
 * @param options.light - 陪学 calls: lowest reasoning effort and, when thinking
 *   is fully off, a capped output so a chatty reply cannot burn tokens.
 * @param options.lightTimeoutMs / options.hedgeMs - per-attempt budget and the
 *   no-first-chunk delay before a light call races a second request.
 */
export function modelCompletion(ctx, route, sessionId, { light = false, lightTimeoutMs = LIGHT_TIMEOUT_MS, hedgeMs = LIGHT_HEDGE_MS } = {}) {
  /* One streamed call. ctx.llm.stream never throws for provider problems: a
     rate limit, transport error or our own timeout abort all arrive as an
     `error`/`aborted` finish chunk. Read it, so a 90s timeout is reported as a
     timeout (and not retried as if the model had merely answered empty). */
  const complete = async (system, prompt, timeoutMs = 180000, externalSignal, maxTokens, task = "light", onChunk, correctionReasoning, selectedRoute) => {
    const started = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, ...(externalSignal ? [externalSignal] : [])]),
      selected = selectedRoute || route();
    if (!selected) throw new Error("No model is available for generation");
    const effort = light && !correctionReasoning ? await lightEffort(ctx, selected.provider, selected.model, signal) : null;
    let reasoningEffort = effort?.id ?? selected.reasoningEffort;
    if (correctionReasoning) {
      // A correction never inherits the parent chat's high reasoning setting.
      reasoningEffort = await correctionEffort(ctx, selected, correctionReasoning, signal);
    }
    const call = await ctx.llm.resolveCallConfig(
      {
        provider: selected.provider,
        model: selected.model,
        ...(reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
        ...((effort?.off || correctionReasoning || task === 'assist') && maxTokens ? { maxTokens } : {}),
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
      throw error;
    } finally {
      const ended = performance.now();
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
    return attachChild((system, prompt, options = {}) => options.task?.startsWith('live.correct')
      ? correct(system, prompt, options)
      : hedgeFirstChunk((signal, onChunk) => complete(system, prompt, lightTimeoutMs, signal, options.maxTokens, options.task, onChunk), { hedgeMs }));
  return attachChild((system, prompt, execution) => execution?.task === 'assist'
    ? complete(system, prompt, 8 * 60 * 1000, execution.signal, execution.maxTokens, 'assist', undefined, undefined, execution.route)
    : execution?.task?.startsWith('live.correct') ? correct(system, prompt, execution) : execution
    ? runGenerationAgent(ctx, route(), sessionId, system, prompt, execution, () => complete(system, prompt, GENERATION_TIMEOUT_MS, execution.signal))
    : complete(system, prompt));
}
export function apply(ctx, config = {}) {
  const makeComplete = (route, id, options) => modelCompletion(ctx, route, id, options);
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
            ctx,
            config,
            cwd,
            agent.session,
            makeComplete,
            agent.id,
            sessionNotifier(agent),
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
  ctx.tools.register(
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
  );
  /** Runs one study_workspace call; execute normalizes the result to lossless JSON. */
  async function runStudyTool(a, exec) {
    const agent = exec.agent,
      cwd = agent?.session?.header?.cwd;
    if (!cwd) throw new Error("A session workspace is required");
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
    const followed = () => sessionModel(ctx, agent.session);
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
    if (a.action === "binding.get")
      return binding(cwd, config, followed());
    if (a.action === "binding.set") {
      await saveBinding(cwd, args);
      return binding(cwd, config, followed());
    }
    const service = await serviceFor(
      ctx,
      config,
      cwd,
      agent.session,
      makeComplete,
      agent.id,
      sessionNotifier(agent),
    );
    registerPanelNotifier(agent.id, sessionNotifier(agent));
    if (a.action === "panel.current") {
      return { current: hasPanelVisibility(agent.id) ? panelObservation(agent.id) : null };
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
        queuePanelIntent(agent.id, { type: "candidates", candidates, returnTo });
        return { status: "candidates_queued", total: candidates.length, candidates };
      }
      const selected = candidates[0];
      const run = await service.call("review.start", { mode: "path", fresh: true,
        scope: [{ deckId: selected.deckId, cardId: selected.cardId }],
        ...(returnTo ? { returnTo } : {}) });
      queuePanelIntent(agent.id, { type: "run", runId: run.id });
      return { status: "queued_for_sidebar", runId: run.id, deckId: selected.deckId,
        cardId: selected.cardId, prompt: selected.prompt, returnTo };
    }
    return service.call(
      a.action,
      a.action === "snapshot" ? { ...args, compact: true } : a.action === 'audio.import' ? resolveAudioImportPaths(cwd, args) : args,
    );
  }
  ctx.systemPrompt.section({
    name: "daily-flashcard:usage",
    order: 70,
    text: studyUsagePrompt,
  });
}
