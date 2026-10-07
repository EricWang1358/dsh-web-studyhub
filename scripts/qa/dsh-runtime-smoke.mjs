/* npm run qa:dsh-runtime [-- --dsh-bin <bin.js> --port 3190 --model-port 4194 --out output/qa/s67-smoke]
   The unified job runtime inside a real, isolated DSH 0.2 host (S6-7 host evidence):
   1. builds and packs this plugin and adds it to a fresh profile in a private DSH_HOME (pnpm offline: nothing is downloaded);
   2. boots DSH with every *_API_KEY/*_TOKEN/*BASE_URL variable removed, SSH_TTY=audit, private TEMP/TMP, and ALL migration switches on in the plugin config;
      the only model is the local fake of scripts/qa/fake-openai.mjs (a model that is HELD on demand, so a job can be seen running);
   3. drives the plugin's own RPC from the page (the route the Study UI uses) for the paths that need no real model, looks at the 任务 console at 1280 and 420 wide,
      then stops the host and checks that nothing outside the private folders was written.
   Not run here, and said so in the summary: every path that needs a real model or a network (transcription, real text models, installs, cloud conversion).
   Output: <out>/summary.json and screenshots. It never reads or writes ~/.dsh, ~/.mineru or the owner's library. Not part of npm test. */
/* global document -- callbacks passed to page.evaluate run in the browser */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { scrubProcessEnv, scrubSecrets } from "./env.mjs";
import { launchChromium } from "./browser.mjs";
import { createFakeOpenAI } from "./fake-openai.mjs";
import { DSH_PROFILE, DSH_VERSION, FAKE_KEY_ENV, bootDsh, dshPatch, stopTree } from "./dsh-e2e.mjs";
import { MIGRATION_SWITCHES } from "../../lib/runtime-config.js";
import { subtitleText, wav } from "../../tests/helpers/audio-fakes.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const DEFAULT_BIN = process.env.DSH_QA_BIN || "D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js";

function parse(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) { const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]); if (!match) throw new Error(`Unexpected argument ${argv[i]}`); values[match[1]] = match[2] ?? argv[++i]; }
  return { bin: resolve(values["dsh-bin"] || DEFAULT_BIN), port: Number(values.port ?? 3190), modelPort: Number(values["model-port"] ?? 4194), out: resolve(values.out ?? join(repo, "output/qa/s67-smoke")) };
}
function run(command, args, { cwd = repo, env, label = command } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true, shell: process.platform === "win32" && command === "npm" });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}):\n${(result.stdout || "").slice(-1500)}\n${(result.stderr || "").slice(-1500)}`);
  return result.stdout || "";
}
const listing = async (folder) => (await readdir(folder).catch(() => [])).sort();

export async function runSmoke(options) {
  const removed = scrubProcessEnv();
  const root = join(repo, "output/qa/s67"), home = join(root, "home"), documents = join(root, "documents"), tmp = join(root, "tmp"), packDir = join(root, "pack");
  const workspace = join(documents, "deepseek-harness", "default-workspace");
  const env = { ...scrubSecrets(process.env), DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", SSH_TTY: "audit", TEMP: tmp, TMP: tmp, npm_config_offline: "true" };
  const dotDsh = join(homedir(), ".dsh"), before = { dotDsh: await listing(dotDsh), mineru: await listing(join(homedir(), ".mineru")) };
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(options.out, { recursive: true, force: true });
  for (const folder of [workspace, tmp, packDir, options.out]) await mkdir(folder, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), options: { ...options, bin: "<dsh bin>" }, scrubbedEnvNames: removed.length, private: { home: "output/qa/s67/home", tmp: "output/qa/s67/tmp" }, steps: [], notRun: [] };
  const step = async (name, work) => {
    const started = Date.now();
    try { const value = await work(); summary.steps.push({ name, status: "ok", ms: Date.now() - started, ...(value && typeof value === "object" && !value.child ? { detail: value } : {}) }); return value; }
    catch (error) { summary.steps.push({ name, status: "failed", ms: Date.now() - started, error: String(error?.message || error).slice(0, 1500) }); return undefined; }
  };
  const notRun = (what, why) => summary.notRun.push({ what, why });
  let model, dsh, browser;
  const gate = { open: Promise.resolve(), release: () => {}, hold() { this.open = new Promise((done) => { this.release = done; }); } };
  try {
    summary.dsh = { version: run(process.execPath, [options.bin, "--version"], { env }).trim(), expected: DSH_VERSION };
    if (summary.dsh.version !== DSH_VERSION) throw new Error(`DSH ${summary.dsh.version} found; this harness pins ${DSH_VERSION}`);
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    summary.plugin = { name: pkg.name, version: pkg.version };
    const tgz = await step("pack-plugin", async () => {
      run("npm", ["run", "build"], { env });
      const name = run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], { env }).trim().split(/\r?\n/).at(-1);
      return join(packDir, name);
    });
    await step("create-profile-and-add-plugin", async () => {
      run(process.execPath, [options.bin, "--profile", DSH_PROFILE, "--from-default-profile", "web", "--dump-config"], { cwd: workspace, env, label: "dsh profile" });
      run(process.execPath, [options.bin, "plugin", "--profile", DSH_PROFILE, "add", tgz], { cwd: workspace, env, label: "dsh plugin add (offline)" });
    });
    // The local stand-in for a model: answers the plugin's prompts like scripts/fake-model.mjs, and waits for `gate` while the run holds it.
    model = await createFakeOpenAI({ port: options.modelPort, beforeReply: () => gate.open });
    const pilot = Object.fromEntries(Object.keys(MIGRATION_SWITCHES).map((key) => [key, true]));
    summary.switchesOn = Object.keys(pilot);
    const patch = join(options.out, "smoke.patch.yml");
    await writeFile(patch, "# Generated by scripts/qa/dsh-runtime-smoke.mjs (test-only overlay).\n" + YAML.stringify([...dshPatch({ fakeModelUrl: model.url, documentsDirectory: documents }), { id: "daily-flashcard", config: { runtime: { pilot } } }]));
    dsh = await step("boot-dsh", () => bootDsh(options.bin, { env: { ...env, [FAKE_KEY_ENV]: "not-a-real-key" }, cwd: workspace, patch, port: options.port }));
    if (!dsh) throw new Error("DSH did not boot");
    summary.url = dsh.url.replace(/token=\S+/, "token=…");
    browser = await launchChromium({ args: ["--lang=zh-CN"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    summary.consoleErrors = []; summary.pageErrors = [];
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push(message.text().slice(0, 300)); });
    page.on("pageerror", (error) => summary.pageErrors.push(String(error?.message || error).slice(0, 300)));
    await page.goto(dsh.url, { waitUntil: "networkidle" });
    await page.locator(".study-app").first().waitFor({ timeout: 90000 });
    await sleep(2500);
    // The wire of the host's fetch RPC: the Study route takes {sessionId, action, args} as its payload, the host's own routes {args}.
    const rpc = (method, payload) => page.evaluate(async ({ method: name, payload: body }) => {
      const response = await fetch(`/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: name, payload: body }) });
      return (await response.json()).result;
    }, { method, payload });
    const listed = (await rpc("session/list", { args: { _request: {} } })).value.items, session = listed[0]?.sessionId;
    summary.session = { listed: listed.length, id: typeof session };
    const call = async (action, args = {}) => { const result = await rpc("study-workspace/call", { sessionId: session, action, args }); if (!result.ok) throw Object.assign(new Error(result.error?.message || "refused"), { code: result.error?.code }); return result.value; };
    const refused = (action, args) => call(action, args).then((value) => ({ value }), (error) => ({ error: String(error.message).slice(0, 300) }));
    const shot = (name) => page.screenshot({ path: join(options.out, `${name}.png`) });
    const jobs = async () => (await call("snapshot")).jobs;
    const row = async (id) => (await jobs()).find((job) => job.id === id);
    const until = async (what, check, timeoutMs = 60000) => { const end = Date.now() + timeoutMs; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(300); } };
    const facts = (job) => ({ id: job.id, kind: job.contract.kind, contractVersion: job.contract.contractVersion, status: job.status, stage: job.contract.stage, actions: Object.fromEntries(Object.entries(job.contract.actions).map(([key, value]) => [key, value.available ? "yes" : value.reason?.code])),
      executor: job.contract.runtime?.attempts?.at(-1)?.executor ?? null, calls: job.contract.calls.map((item) => `${item.kind}:${item.status}`), usage: job.contract.usage, title: job.contract.title });

    await step("settings: the host's own model is the text model", async () => { await call("audio.settings.set", { textProvider: "host" }); return { textProvider: (await call("audio.settings.get")).textProvider }; });
    await step("list: a new library has no job", async () => ({ jobs: (await jobs()).length }));

    // A subtitle import held on the model: seen running, listed, stopped, dismissed.
    const subtitles = (n) => ({ filename: `smoke-${n}.txt`, text: subtitleText.replace("朋友们唉", `第 ${n} 位同学`), course: "Smoke" });
    let held;
    await step("subtitles held: a runtime job on the host, running", async () => {
      gate.hold();
      const started = await call("audio.subtitles.import", subtitles(1));
      held = await until("the job to run", async () => { const job = await row(started.jobId); return job && ["running", "queued"].includes(job.status) && job.contract.calls.length ? job : null; });
      const info = facts(held);
      if (info.contractVersion !== 2 || info.kind !== "audio-subtitles") throw new Error(`not a runtime subtitles job: ${JSON.stringify(info)}`);
      return info;
    });
    await step("console: job.status, job.wait by the card id and the contract id", async () => {
      const out = {};
      for (const [label, id] of [["card", held.id], ["contract", held.contract.jobId]]) out[label] = { status: (await call("job.status", { jobId: id })).status, wait: (await call("job.wait", { jobId: id, timeoutSeconds: 1 })).status };
      return out;
    });
    await step("console: refusals in words (pause, retry, message) while it runs", async () => ({
      pause: await refused("job.control", { jobId: held.id, action: "pause" }), retry: await refused("job.control", { jobId: held.id, action: "retry" }), message: await refused("job.message", { jobId: held.id, message: "hi" }) }));
    await step("console screenshot with a running runtime job (1280 wide)", async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('[data-tour="nav-tasks"]').first().click({ force: true });
      await sleep(1500);
      await shot("tasks-running-1280");
      return { text: (await page.locator(".study-app").first().innerText()).slice(0, 400) };
    });
    await step("console: stop the running job", async () => {
      const reply = await call("job.control", { jobId: held.id, action: "cancel" });
      gate.release();
      const ended = await until("the job to end", async () => { const job = await row(held.id); return job && !["queued", "running", "cancelling"].includes(job.status) ? job : null; });
      return { reply: { action: reply.action, status: reply.status }, ended: facts(ended) };
    });
    await step("console: cancelling the ended job again is refused as the card says", async () => refused("job.control", { jobId: held.id, action: "cancel" }));
    await step("console: dismiss the stopped job", async () => { const out = await call("job.dismiss", { jobId: held.id }); return { dismissed: out.dismissed, left: (await jobs()).length }; });

    let done;
    await step("subtitles with the local fake model: a runtime job completes on the host", async () => {
      gate.release();
      const started = await call("audio.subtitles.import", subtitles(2));
      done = await until("the job to end", async () => { const job = await row(started.jobId); return job && !["queued", "running", "cancelling"].includes(job.status) ? job : null; });
      if (done.status !== "complete") throw new Error(`the job ended ${done.status}: ${JSON.stringify([done.contract.stage, done.contract.error, done.contract.calls.map((item) => `${item.kind}:${item.status}:${item.error ?? ""}`)])}`);
      const info = facts(done), sources = (await call("snapshot")).sources;
      return { ...info, sourceIds: done.contract.result.refs.map((ref) => ref.id), sourcesInLibrary: sources.length };
    });
    await step("console: archive, bring back, dismiss a finished job", async () => {
      const archived = await call("job.archive", { jobId: done.id }), snapshot = await call("snapshot"), brought = await call("job.unarchive", { jobId: done.id });
      return { archived: archived.archived, listedAfterArchive: snapshot.jobs.some((job) => job.id === done.id), archivedRecords: snapshot.archivedJobs.length, brought: brought.unarchived };
    });

    // Paths that need something this host does not have, or a real service: said so, with what the host answers.
    await step("retrieval index: the host without the search extension", async () => ({ status: await refused("retrieval.status"), start: await refused("retrieval.index.start", { course: "Smoke" }) }));
    await step("PDF local route: is anything installed?", async () => ({ marker: await refused("marker.local.status"), mineru: await refused("mineru.local.status") }));
    await step("audio import without a transcription service is refused in words", async () => {
      const path = join(tmp, "synthetic.wav"); await writeFile(path, wav(1));
      return refused("audio.import", { path });
    });
    notRun("transcription, real text model, subtitles/review/class jobs on a real model", "no authorized model or key; the only model here is the local fake");
    notRun("Marker install, MinerU setup, cloud PDF conversion, search-extension index build", "needs network or software that is not installed; no installs were made");

    // The learner's own clicks in the 任务 console: stop a running job, then delete its record.
    await step("console UI: click 停止 on a running runtime job, then select it and 删除", async () => {
      gate.hold();
      const started = await call("audio.subtitles.import", subtitles(4));
      await until("the job to run", async () => { const job = await row(started.jobId); return job && job.contract.calls.length ? job : null; });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('[data-tour="nav-tasks"]').first().click({ force: true });
      await page.locator(".tc-row", { hasText: "smoke-4.txt" }).first().waitFor({ timeout: 30000 });
      await page.locator(".tc-row", { hasText: "smoke-4.txt" }).first().click();
      await sleep(800);
      await page.mouse.move(900, 20);
      await shot("tasks-ui-before-stop-1280");
      await page.getByRole("button", { name: "停止", exact: true }).first().click();
      gate.release();
      const ended = await until("the job to end", async () => { const job = await row(started.jobId); return job && !["queued", "running", "cancelling"].includes(job.status) ? job : null; });
      await sleep(1200);
      await shot("tasks-ui-after-stop-1280");
      await page.getByRole("checkbox", { name: /选择任务：smoke-4\.txt/ }).check({ force: true });
      await page.getByRole("button", { name: "删除", exact: true }).first().click();
      await page.getByRole("button", { name: "确认删除" }).click();
      const gone = await until("the record to be deleted", async () => !(await row(started.jobId)));
      return { endedStatus: ended.status, cardGoneAfterDelete: gone };
    });

    // The console with finished, running and stopped runtime jobs, at both widths.
    await step("console screenshots: a finished and a running runtime job at 1280 and 420 wide", async () => {
      gate.hold();
      const started = await call("audio.subtitles.import", subtitles(3));
      await until("the job to run", async () => { const job = await row(started.jobId); return job && job.contract.calls.length ? job : null; });
      const out = {};
      for (const width of [1280, 420]) {
        await page.setViewportSize({ width, height: width === 420 ? 820 : 900 });
        await page.locator('[data-tour="nav-tasks"]').first().click({ force: true }).catch(() => {});
        await sleep(1500);
        await page.mouse.move(Math.max(5, width - 5), 5);
        await sleep(300);
        await shot(`tasks-${width}`);
        out[width] = { overflowX: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
      }
      await call("job.control", { jobId: started.jobId, action: "cancel" });
      gate.release();
      await until("the job to end", async () => { const job = await row(started.jobId); return job && !["queued", "running", "cancelling"].includes(job.status); });
      return out;
    });
  } catch (error) {
    summary.fatal = String(error?.message || error).slice(0, 1500);
    process.exitCode = 2;
  } finally {
    gate.release();
    await browser?.close().catch(() => {});
    stopTree(dsh?.child);
    await model?.close().catch(() => {});
    await sleep(1500);
    summary.stoppedCleanly = !dsh?.child || dsh.child.exitCode !== null || dsh.child.killed;
    summary.touched = { dotDshUnchanged: JSON.stringify(before.dotDsh) === JSON.stringify(await listing(dotDsh)), mineruUnchanged: JSON.stringify(before.mineru) === JSON.stringify(await listing(join(homedir(), ".mineru"))) };
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.fatal && summary.steps.every((item) => item.status === "ok") && summary.stoppedCleanly && summary.touched.dotDshUnchanged && summary.touched.mineruUnchanged;
    await writeFile(join(options.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ ok: summary.ok, steps: summary.steps.map((item) => `${item.status}: ${item.name}`), notRun: summary.notRun.length, fatal: summary.fatal }, null, 1));
    await stat(options.out).catch(() => {});
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await runSmoke(parse(process.argv.slice(2)));
  process.exitCode ||= summary.ok ? 0 : 1;
}
