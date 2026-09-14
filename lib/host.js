import { readFile, writeFile, rename, access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { StudyService } from "./service.js";
import { MAX_REQUEST_BYTES } from "./documents.js";
import {
  listNotebooks,
  publishNotebook,
  unpublishNotebook,
  searchNotebooks,
} from "./notebooks.js";

const BINDING_FILE = ".dsh-study-binding.json";
const SLOW_REQUEST_MS = 1000;

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
/**
 * The model the session's next request would use, as the composer shows it:
 * the latest `model/selection` or `request/header`, then the host default.
 */
export function sessionModel(ctx, session) {
  if (typeof session?.eventAt === "function" && Number(session.seq) > 0) {
    for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (event?.type === "model/selection") return selection(event.data);
      if (event?.type === "request/header")
        return selection(event.data?.header?.config);
    }
  }
  const header = selection(session?.requestHeader?.()?.config);
  if (header) return header;
  try {
    return selection(ctx?.get?.("agentDefaultModel")?.currentSelection?.());
  } catch {
    return undefined;
  }
}
export async function binding(cwd, config = {}, followed) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(join(cwd, BINDING_FILE), "utf8"));
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
export async function serviceFor(ctx, config, cwd, session, makeComplete, id) {
  const b = await binding(cwd, config);
  const fixed = b.route,
    route = () => fixed || sessionModel(ctx, session);
  const available = makeComplete && route();
  return new StudyService(b.root, {
    complete: available ? makeComplete(route, id) : undefined,
    completeLight: available ? makeComplete(route, id, { light: true }) : undefined,
    coach: true,
  });
}
export function createHostHandler(ctx, config = {}, makeComplete) {
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
          value: await binding(cwd, config, sessionModel(ctx, session)),
        });
      if (action === "binding.set") {
        await saveBinding(cwd, args);
        return {
          ok: true,
          value: await binding(cwd, config, sessionModel(ctx, session)),
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
      return traced({ ok: true, value: await service.call(action, args) });
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
                MAX_REQUEST_BYTES
              )
                return new Response("Too large", { status: 413 });
              let body;
              try {
                const raw = await request.text();
                if (raw.length > MAX_REQUEST_BYTES)
                  return new Response("Too large", { status: 413 });
                body = JSON.parse(raw);
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
