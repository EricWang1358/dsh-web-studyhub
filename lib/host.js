import { parseStoredJson } from "./util.js";
import { readFile, writeFile, rename, access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { StudyService } from "./service.js";
import { boardAction } from "./board.js";
import { MAX_REQUEST_BYTES } from "./documents.js";
import { resolveAudioImportPaths, scanAudioFiles } from "./audio-files.js";
import { assistView, startAssist } from "./assist.js";
import { disposeAssistChildren } from './assist-child.js';
import { setPanelVisible, takePanelIntent } from "./panel-bridge.js";
import {
  listNotebooks,
  publishNotebook,
  unpublishNotebook,
  searchNotebooks,
} from "./notebooks.js";

const BINDING_FILE = ".dsh-study-binding.json";
const SLOW_REQUEST_MS = 1000;
const MAX_RESTORE_REQUEST_BYTES = 64 * 1024 * 1024;

/** The session workspace itself when it already holds a library, else a folder inside it. */
export async function workspaceLibrary(cwd) {
  try {
    await access(join(cwd, "study-workspace.json"));
    return cwd;
  } catch {
    return join(cwd, ".dsh-study");
  }
}
function selection(value) {
  if (!value?.provider || !value?.model) return undefined;
  return {
    provider: String(value.provider),
    model: String(value.model),
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(value.reasoningEffort) }),
  };
}
function defaultModel(ctx) {
  try { return selection(ctx?.get?.('agentDefaultModel')?.currentSelection?.()); }
  catch { return undefined; }
}
function logModel(session) {
  if (typeof session?.eventAt === "function" && Number(session.seq) > 0) {
    const used = [];
    for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (event?.type === 'request/header') {
        const route = selection(event.data?.header?.config);
        if (route) used.push(route);
      }
      if (event?.type === 'model/selection') {
        const pending = selection(event.data);
        // Official modelSelection semantics: another request may still be
        // using the old route. Only a matching use consumes the pending one.
        return pending && !used.some(route => JSON.stringify(route) === JSON.stringify(pending)) ? pending : used[0];
      }
    }
    if (used.length) return used[0];
  }
  return selection(session?.requestHeader?.()?.config);
}
/** Read the same next-model projection as the composer, without replaying it. */
export function sessionModel(ctx, session) {
  if (session) {
    const projected = ctx.get?.('sessionProjections')?.snapshot?.(session, ['modelSelection'])?.values?.modelSelection;
    if (projected !== undefined) return selection(projected.next) || defaultModel(ctx);
  }
  return logModel(session) || defaultModel(ctx);
}
const storedModelCache = new WeakMap();
/** Cold panels keep the saved session's selection without activating its Agent. */
export async function sessionModelFor(ctx, sessionId, session = ctx.sessions?.get(sessionId)) {
  if (session) return sessionModel(ctx, session);
  const query = ctx.get?.('sessionQuery');
  if (!query?.observeSession) return defaultModel(ctx);
  const persistence = ctx.get?.('sessionPersistence');
  const stored = await persistence?.stat?.(sessionId);
  let cache = storedModelCache.get(ctx);
  if (!cache) storedModelCache.set(ctx, cache = new Map());
  const before = cache.get(sessionId);
  if (stored?.revision !== undefined && before?.revision === stored.revision && before.query === query && before.persistence === persistence)
    return before.value || defaultModel(ctx);
  // An observation is not a Session, so snapshot(observation) is invalid.
  // The official reader reuses prepared sessions and their projection cache.
  const observed = await query.observeSession(sessionId, { projectionMode: 'all' });
  try {
    const projected = observed.projections?.values?.modelSelection;
    const events = projected === undefined ? observed.events : undefined;
    const value = projected === undefined
      ? logModel({ seq: events?.length || 0, eventAt: index => events[index] })
      : selection(projected.next);
    const revision = observed.revision ?? stored?.revision;
    if (revision !== undefined) cache.set(sessionId, { revision, query, persistence, value });
    return value || defaultModel(ctx);
  } finally { observed[Symbol.dispose]?.(); }
}
export async function binding(cwd, config = {}, followed) {
  let saved = {};
  try {
    saved = parseStoredJson(await readFile(join(cwd, BINDING_FILE), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const workspaceRoot = await workspaceLibrary(cwd),
    custom = selection(saved) || selection(config);
  return {
    root: saved.root || config.libraryRoot || workspaceRoot,
    rootSource: saved.root ? "custom" : config.libraryRoot ? "config" : "workspace",
    workspaceRoot,
    provider: custom?.provider || "",
    model: custom?.model || "",
    modelSource: selection(saved) ? "custom" : custom ? "config" : "session",
    route: custom || followed || null,
  };
}
async function sessionBinding(ctx, config, cwd, sessionId, session) {
  const value = await binding(cwd, config);
  if (!value.route) value.route = await sessionModelFor(ctx, sessionId, session) || null;
  return value;
}
/** Empty root follows the workspace; empty provider/model follows the session model. */
export async function saveBinding(cwd, args = {}) {
  const root = typeof args.root === "string" ? args.root.trim() : "";
  if (root && !isAbsolute(root))
    throw new Error("Choose an absolute library directory");
  const provider = String(args.provider || "").trim(),
    model = String(args.model || "").trim();
  if (!provider !== !model)
    throw new Error("Choose both a provider and a model, or follow the session model");
  const value = { root, provider, model };
  const target = join(cwd, BINDING_FILE),
    tmp = target + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, target);
  return value;
}
/**
 * Tool outputs must be lossless JSON: no undefined, NaN, -0 or class
 * instances. A JSON round-trip drops undefined fields and normalizes the rest.
 */
export const jsonSafe = (value) =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));
// A session's cwd is fixed in its immutable header, so one lookup per session
// is enough. Keyed per host context so separate hosts never share entries.
const workspaceCache = new WeakMap();
export async function workspaceFor(ctx, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200)
    throw new Error("A session id is required");
  const session = ctx.sessions.get(sessionId);
  if (session?.header?.cwd) return session.header.cwd;
  let cache = workspaceCache.get(ctx);
  if (!cache) workspaceCache.set(ctx, (cache = new Map()));
  if (!cache.has(sessionId)) {
    const lookup = resolveStoredWorkspace(ctx, sessionId);
    cache.set(sessionId, lookup);
    // Failures are not remembered; a session created later can still resolve.
    lookup.then((cwd) => cwd || cache.delete(sessionId), () => cache.delete(sessionId));
  }
  const cwd = await cache.get(sessionId);
  if (cwd) return cwd;
  throw new Error("Session workspace is unavailable");
}
/**
 * A session that is not live: read only its stored header. observeSession
 * would read and replay the whole event log just to learn the cwd, which is
 * what made opening the study tab on a long conversation take seconds.
 */
async function resolveStoredWorkspace(ctx, sessionId) {
  const persistence = ctx.get?.("sessionPersistence");
  if (persistence?.stat) {
    const stored = await persistence.stat(sessionId).catch(() => undefined);
    if (stored?.header?.cwd) return stored.header.cwd;
  }
  const query = ctx.get?.("sessionQuery");
  if (query?.observeSession) {
    const observed = await query.observeSession(sessionId, {
      projectionMode: "none",
    });
    try {
      if (observed?.header?.cwd) return observed.header.cwd;
    } finally {
      observed?.[Symbol.dispose]?.();
    }
  }
  return "";
}
/** Bind a workspace to a StudyService whose model route is resolved at call time. */
export async function serviceFor(ctx, config, cwd, session, makeComplete, id, notify) {
  const b = await binding(cwd, config);
  const fixed = b.route;
  const followed = fixed ? undefined : await sessionModelFor(ctx, id, session);
  const route = () => {
    const live = ctx.sessions?.get(id) || session;
    return fixed || (live ? sessionModel(ctx, live) : followed);
  };
  const available = makeComplete && route();
  return new StudyService(b.root, {
    complete: available ? makeComplete(route, id) : undefined,
    completeLight: available ? makeComplete(route, id, { light: true }) : undefined,
    coach: true,
    notify,
  });
}
export function createHostHandler(ctx, config = {}, makeComplete) {
  ctx.effect?.(() => () => disposeAssistChildren(ctx));
  return async function handle(_endpoint, request) {
    try {
      if (_endpoint !== "call") throw new Error("Unknown endpoint");
      const started = Date.now();
      const cwd = await workspaceFor(ctx, request?.sessionId),
        session = ctx.sessions.get(request.sessionId),
        action = request.action,
        args = request.args || {};
      const resolved = Date.now();
      // Slow panel requests name the phase, so a slow load can be traced from the host log.
      const traced = async (value) => {
        const total = Date.now() - started;
        if (total > SLOW_REQUEST_MS)
          console.warn(`[study-workspace] ${action} took ${total}ms (session workspace ${resolved - started}ms, action ${total - (resolved - started)}ms)`);
        return value;
      };
      if (action === "panel.intent.next")
        return traced({ ok: true, value: { intent: takePanelIntent(request.sessionId) } });
      if (action === "panel.visible")
        return traced({ ok: true, value: { current: setPanelVisible(request.sessionId,
          args.placement, args.run || null, Date.now(), args.sequence) } });
      if (action.startsWith("board."))
        return traced({ ok: true, value: await boardAction(action, args, cwd) });
      // Audio in the session workspace, for the picker in the add-source form (like @ in the composer).
      if (action === "audio.files")
        return traced({ ok: true, value: await scanAudioFiles(cwd, args) });
      if (action.startsWith("notebook.")) {
        const root = (await binding(cwd, config)).root;
        if (action === "notebook.publish") await publishNotebook(cwd, root);
        else if (action === "notebook.unpublish") await unpublishNotebook(root);
        else if (action === "notebook.search")
          return { ok: true, value: await searchNotebooks(args?.query) };
        else if (action !== "notebook.list")
          throw new Error(`Unknown action: ${action}`);
        return traced({ ok: true, value: await listNotebooks(root) });
      }
      if (action === "binding.get")
        return traced({
          ok: true,
          value: await sessionBinding(ctx, config, cwd, request.sessionId, session),
        });
      if (action === "binding.set") {
        await saveBinding(cwd, args);
        return {
          ok: true,
          value: await sessionBinding(ctx, config, cwd, request.sessionId, session),
        };
      }
      const service = await serviceFor(
        ctx,
        config,
        cwd,
        session,
        makeComplete,
        request.sessionId,
      );
      /* The host selects a native child or a direct background model call;
         both return bounded output for the service to validate and save. */
      if (action === "assist.start") {
        const { deck, card } = await service.call("card.locate", args);
        let assessment = null;
        if (args.runId) {
          const run = await service.call("review.get", { runId: args.runId });
          if (run.card?.id !== card.id || run.deckId !== deck.id)
            throw new Error("当前题已切换，请重新打开帮助面板");
          if (run.feedback) assessment = {
            selected: run.feedback.selected || [], correct: run.feedback.correct,
            grade: run.feedback.grade,
            ...(run.feedback.answers ? { answers: run.feedback.answers } : {}),
          };
        }
        return traced({
          ok: true,
          value: await startAssist(ctx, {
            service,
            root: service.store.root,
            sessionId: request.sessionId,
            mode: args.mode,
            ref: { deckId: deck.id, cardId: card.id },
            text: String(args.text ?? "").trim(),
            helpChoices: args.helpChoices,
            language: args.uiLanguage,
            assessment,
            card,
            deckTitle: deck.title,
            route: (await binding(cwd, config)).route || await sessionModelFor(ctx, request.sessionId, session),
          }),
        });
      }
      // A path from the conversation may be quoted, @-mentioned or relative to the workspace.
      const value = await service.call(action, action === 'snapshot'
        ? { ...args, hostState: JSON.stringify(assistView(service.store.root).tasks) }
        : action === "audio.import" ? resolveAudioImportPaths(cwd, args) : args);
      // The panel polls the snapshot; assist tasks ride along with it.
      if (action === "snapshot" && value && typeof value === "object" && !value.unchanged)
        value.assist = assistView(service.store.root).tasks;
      return traced({ ok: true, value });
    } catch (e) {
      return {
        ok: false,
        error: { code: "STUDY_ERROR", message: e.message, details: {} },
      };
    }
  };
}
export function installTransport(ctx, config, makeComplete) {
  ctx.inject(["connection", "sessions"], (c) => {
    const connection = c.get("connection"),
      handle = createHostHandler(c, config, makeComplete);
    if (connection?.fetch?.register) {
      c.effect(
        () =>
          connection.fetch.register({
            path: "/api/study-workspace/call",
            methods: ["POST"],
            requestBody: "buffered",
            async fetch(request) {
              if (
                request.headers.get("content-type")?.split(";")[0].trim() !==
                "application/json"
              )
                return new Response("Expected JSON", { status: 415 });
              if (
                Number(request.headers.get("content-length")) >
                MAX_RESTORE_REQUEST_BYTES
              )
                return new Response("Too large", { status: 413 });
              let body;
              try {
                const raw = await request.text();
                if (raw.length > MAX_RESTORE_REQUEST_BYTES)
                  return new Response("Too large", { status: 413 });
                body = JSON.parse(raw);
                if (raw.length > MAX_REQUEST_BYTES && body?.payload?.action !== "restore")
                  return new Response("Too large", { status: 413 });
              } catch {
                return new Response("Invalid JSON", { status: 400 });
              }
              if (
                body?.type !== "client-request" ||
                typeof body.rpcId !== "string" ||
                body.method !== "study-workspace/call"
              )
                return new Response("Invalid envelope", { status: 400 });
              return Response.json({
                type: "server-response",
                rpcId: body.rpcId,
                result: await handle("call", body.payload),
              });
            },
          }),
        "study authenticated transport",
      );
    } else if (connection?.rpc?.handle)
      c.effect(
        () => connection.rpc.handle("/study-workspace", handle),
        "study legacy transport",
      );
  });
}
