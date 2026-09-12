import { readFile, writeFile, rename } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { StudyService } from "./service.js";

export async function binding(cwd, config = {}) {
  let saved = {};
  try {
    saved = JSON.parse(
      await readFile(join(cwd, ".dsh-study-binding.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return {
    root: saved.root || config.libraryRoot || "",
    provider: saved.provider || config.provider || "",
    model: saved.model || config.model || "",
  };
}
export async function saveBinding(cwd, args) {
  if (typeof args.root !== "string" || !isAbsolute(args.root))
    throw new Error("Choose an absolute library directory");
  const value = {
    root: args.root,
    provider: String(args.provider || ""),
    model: String(args.model || ""),
  };
  const target = join(cwd, ".dsh-study-binding.json"),
    tmp = target + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, target);
  return value;
}
export async function workspaceFor(ctx, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200)
    throw new Error("A session id is required");
  const session = ctx.sessions.get(sessionId);
  if (session?.header?.cwd) return session.header.cwd;
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
  throw new Error("Session workspace is unavailable");
}
export function createHostHandler(ctx, config = {}, makeComplete) {
  return async function handle(_endpoint, request) {
    try {
      if (_endpoint !== "call") throw new Error("Unknown endpoint");
      const cwd = await workspaceFor(ctx, request?.sessionId),
        action = request.action,
        args = request.args || {};
      if (action === "binding.get")
        return { ok: true, value: await binding(cwd, config) };
      if (action === "binding.set")
        return { ok: true, value: await saveBinding(cwd, args) };
      const b = await binding(cwd, config);
      const complete =
        b.provider && b.model && makeComplete
          ? makeComplete(b, request.sessionId)
          : undefined;
      return {
        ok: true,
        value: await new StudyService(b.root, { complete }).call(action, args),
      };
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
                2 * 1024 * 1024
              )
                return new Response("Too large", { status: 413 });
              let body;
              try {
                const raw = await request.text();
                if (raw.length > 2 * 1024 * 1024)
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
