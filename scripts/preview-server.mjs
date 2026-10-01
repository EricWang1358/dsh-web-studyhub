/* Local browser preview of the study panel (npm run dev, QA journeys, tests).
   It stands in for one DSH session whose workspace is `libraryRoot`, and
   answers every action through the real host handler (lib/host.js), so jobs,
   progress, stop buttons, uploads and assist.start behave as they do in DSH. */
import { createServer } from "node:http";
import { readFile, mkdir, access } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createHostHandler, unverifiedModelStatus } from "../lib/host.js";
import { localizeAppMessage } from "../lib/application-messages.js";
import { MAX_REQUEST_BYTES } from "../lib/documents.js";
import { createFakeModel, FAKE_MODEL_ROUTE } from "./fake-model.mjs";
import { cleanEffortPreference, withEffortState } from "../lib/reasoning-effort.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const SESSION_ID = "study-preview";
// The host transport accepts large bodies only for a backup restore.
const MAX_RESTORE_REQUEST_BYTES = 64 * 1024 * 1024;

/** The dev CLI's flags and environment (scripts/dev.mjs). */
export function previewOptions(argv = process.argv, env = process.env) {
  const library = argv.find((arg) => arg.startsWith("--library="))?.slice(10);
  return {
    libraryRoot: resolve(library || resolve(repoRoot, "output/preview-library")),
    // Global study files (notebooks, board, audio settings) never default to ~/.dsh.
    home: resolve(env.DSH_HOME?.trim() || resolve(repoRoot, "output/preview-home")),
    port: Number(env.PORT || 4178),
    model: env.STUDY_API_KEY ? { apiKey: env.STUDY_API_KEY, baseUrl: env.STUDY_BASE_URL, model: env.STUDY_MODEL }
      : env.STUDY_FAKE_MODEL ? "fake" : null,
    fakeLatencyMs: Number(env.STUDY_FAKE_LATENCY_MS || 900),
    // STUDY_FAKE_EFFORTS=low,medium,high: the preview model offers these reasoning levels (lowest first).
    efforts: (env.STUDY_FAKE_EFFORTS || "").split(",").map((id) => id.trim()).filter(Boolean),
  };
}

/** Remote OpenAI-compatible chat completion for STUDY_API_KEY previews. */
function remoteModel({ apiKey, baseUrl, model }) {
  return async (system, prompt, options = {}) => {
    const res = await fetch((baseUrl || "https://api.deepseek.com").replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || "deepseek-chat", messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error("Model request failed (HTTP " + res.status + ")");
    return (await res.json()).choices?.[0]?.message?.content || "";
  };
}

/** 'fake' | fake/real completion function | { apiKey, baseUrl, model } | { complete, light, route } | null. */
function previewModel(model, fakeLatencyMs) {
  if (!model) return null;
  if (model === "fake") return { complete: createFakeModel({ latencyMs: fakeLatencyMs }), route: FAKE_MODEL_ROUTE };
  if (typeof model === "function") return { complete: model, route: FAKE_MODEL_ROUTE };
  if (model.apiKey) return { complete: remoteModel(model), route: { provider: "env", model: model.model || "deepseek-chat" } };
  return { complete: model.complete, light: model.light, route: model.route || FAKE_MODEL_ROUTE };
}

/**
 * A DSH-shaped host: one live session whose workspace is the library folder.
 * Every action goes through createHostHandler (one runtime per library,
 * assist tasks, localized errors). Only the library/model binding is preview
 * state: the library is the --library folder itself, and choosing another one
 * in Settings lasts for this preview without writing a binding file.
 */
function previewHost(workspaceRoot, model, efforts = []) {
  const disposers = [];
  const ctx = {
    // A model catalogue entry with reasoning levels, as DSH's ctx.llm.resolveModelInfo reports it.
    ...(efforts.length ? { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: efforts.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })) } }) } } : {}),
    sessions: new Map([[SESSION_ID, { header: { cwd: workspaceRoot } }]]),
    // The session follows the preview model, as a DSH session follows its selected model.
    get: (name) => name === "agentDefaultModel" && model ? { currentSelection: () => model.route } : undefined,
    effect: (setup) => { const dispose = setup(); if (typeof dispose === "function") disposers.push(dispose); },
  };
  const makeComplete = model ? (_route, _sessionId, options = {}) =>
    (options.light && model.light) || model.complete : undefined;
  // binding() in lib/host.js reads these on every request.
  const config = { libraryRoot: workspaceRoot };
  const handle = createHostHandler(ctx, config, makeComplete, { owner: ctx });
  let chosen = { root: "", provider: "", model: "", reasoningEffort: "" };
  const view = async () => {
    const custom = !!(chosen.provider && chosen.model);
    // The preview session follows its model at the middle level when it offers levels.
    const session = model?.route && efforts.length ? { ...model.route, reasoningEffort: efforts[Math.floor(efforts.length / 2)] } : model?.route || null;
    const route = custom ? { provider: chosen.provider, model: chosen.model } : session;
    // Plan contract C3, as lib/host.js answers it for hosts without a model registry.
    return withEffortState(ctx, { root: chosen.root || workspaceRoot, rootSource: chosen.root ? "custom" : "workspace", workspaceRoot,
      provider: chosen.provider, model: chosen.model, modelSource: custom ? "custom" : "session", route,
      reasoningEffort: chosen.reasoningEffort,
      modelStatus: unverifiedModelStatus(route),
      host: { edition: "preview", chat: false, agentTasks: false, landing: false } });
  };
  function choose(args = {}) {
    // Same rules and messages as saveBinding, so the UI shows the same errors.
    const root = typeof args.root === "string" ? args.root.trim() : "";
    if (root && !isAbsolute(root)) throw new Error("Choose an absolute library directory");
    const provider = String(args.provider || "").trim(), modelId = String(args.model || "").trim();
    if (!provider !== !modelId) throw new Error("Choose both a provider and a model, or follow the session model");
    // Like saveBinding: an omitted level is kept, an empty one follows the session.
    const reasoningEffort = args.reasoningEffort === undefined ? chosen.reasoningEffort : cleanEffortPreference(args.reasoningEffort);
    chosen = { root, provider, model: modelId, reasoningEffort };
    config.libraryRoot = root || workspaceRoot;
    if (provider) Object.assign(config, { provider, model: modelId });
    else { delete config.provider; delete config.model; }
    return view();
  }
  async function call(action, args = {}) {
    if (action !== "binding.get" && action !== "binding.set") return handle("call", { sessionId: SESSION_ID, action, args });
    try { return { ok: true, value: action === "binding.set" ? await choose(args) : await view() }; }
    catch (error) { return { ok: false, error: { code: "STUDY_ERROR", message: localizeAppMessage(error.message, args.uiLanguage || "zh") } }; }
  }
  return { call, dispose: async () => { for (const dispose of disposers.reverse()) await dispose(); } };
}

const shell = (token) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Study · DSH</title><link rel="stylesheet" href="/app.css"><body style="margin:0;background:#161412"><div id="root" style="height:100dvh"></div><script>window.STUDY_TOKEN=${JSON.stringify(token)}</script><script src="/app.js"></script></body></html>`;

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_RESTORE_REQUEST_BYTES) throw new Error("Request too large");
  }
  const payload = JSON.parse(body);
  if (body.length > MAX_REQUEST_BYTES && payload?.action !== "restore") throw new Error("Request too large");
  return payload;
}

/**
 * Start the preview. Returns { url, token, port, libraryRoot, home, close() }.
 * `home` becomes DSH_HOME for the global study files (notebooks, board, audio
 * settings) while the preview runs, so it never reads or writes ~/.dsh.
 * `port: 0` picks a free port.
 */
export async function createPreviewServer({ libraryRoot, port = 4178, model = null, home, fakeLatencyMs = 900, efforts = [],
  distDir = resolve(repoRoot, "dist") } = {}) {
  const workspaceRoot = resolve(libraryRoot || resolve(repoRoot, "output/preview-library"));
  const homeDir = resolve(home || resolve(repoRoot, "output/preview-home"));
  await mkdir(homeDir, { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = homeDir;
  await mkdir(workspaceRoot, { recursive: true });
  // A binding file saved by DSH in this folder would choose the library instead of --library.
  if (await access(join(workspaceRoot, ".dsh-study-binding.json")).then(() => true, () => false))
    console.warn(`[study-preview] ${join(workspaceRoot, ".dsh-study-binding.json")} (saved by DSH) chooses the library; pass another --library to preview this folder itself.`);
  const token = randomBytes(24).toString("hex");
  const host = previewHost(workspaceRoot, previewModel(model, fakeLatencyMs), efforts);
  let actualPort = port;
  const json = (res, status, value) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    .end(JSON.stringify(value));
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${actualPort}` && req.headers.host !== `localhost:${actualPort}`) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === "POST" && req.url === "/api/call") {
        if (req.headers["x-study-token"] !== token) {
          res.writeHead(403).end();
          return;
        }
        const { action, args = {} } = await readBody(req);
        if (typeof action !== "string") throw new Error("An action is required");
        const result = await host.call(action, args);
        if (result.ok) json(res, 200, { ok: true, value: result.value });
        else json(res, 400, { ok: false, error: result.error?.message || "Study request failed" });
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(shell(token));
        return;
      }
      if (!["/app.js", "/app.css"].includes(req.url)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": req.url.endsWith(".js") ? "text/javascript" : "text/css", "Cache-Control": "no-store" })
        .end(await readFile(resolve(distDir, req.url.slice(1))));
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => { server.off("error", fail); done(); });
  });
  actualPort = server.address().port;
  let closing;
  return {
    url: `http://127.0.0.1:${actualPort}`, token, port: actualPort, libraryRoot: workspaceRoot, home: homeDir,
    close: () => closing ||= (async () => {
      await new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); });
      await host.dispose();
      if (process.env.DSH_HOME === homeDir) {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
      }
    })(),
  };
}

/** One authenticated action against a running preview (journeys, seeding). */
export async function previewCall({ url, token }, action, args = {}) {
  const res = await fetch(url + "/api/call", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": token },
    body: JSON.stringify({ action, args }),
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!body.ok) throw new Error(body.error);
  return body.value;
}
