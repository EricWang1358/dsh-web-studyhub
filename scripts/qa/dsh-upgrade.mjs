/* node scripts/qa/dsh-upgrade.mjs [--dsh-bin <bin.js>] [--port 3220] [--lang zh|en]
   WP15 end-to-end proof of the in-app upgrade inside a real, isolated DSH 0.2
   web host (never ~/.dsh, never the owner's keys, SSH_TTY set):
   1. packs this plugin twice: as-is (package.json version) and as "2.1.1-test";
   2. serves a fake GitHub "latest release" (2.1.1-test, with SHA256SUMS) on
      127.0.0.1 and points StudyHub at it with STUDYHUB_QA_UPDATE_FEED;
   3. creates a fresh profile from the `web` template, adds the current package
      with `dsh plugin add`, boots DSH with a local fake model;
   4. opens Study, clicks the update chip, 一键升级 → 确认升级, and checks that
      DSH's plugin manager installed the verified file (profile package.json +
      node_modules) while the running code is still the old version;
   5. restarts DSH and checks that Settings › 关于与更新 reports 2.1.1-test.
   Output: output/qa/wp15-upgrade/*.png and summary.json. Not part of npm test. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { scrubSecrets, scrubProcessEnv } from "./env.mjs";
import { launchChromium } from "./browser.mjs";
import { createFakeOpenAI } from "./fake-openai.mjs";
import { dshPatch, DSH_VERSION, FAKE_KEY_ENV } from "./dsh-e2e.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PROFILE = "studyhub-upgrade";
const TEST_VERSION = "2.1.1-test";
const REPO = "EricWang1358/dsh-web-studyhub";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    values[match[1]] = match[2] ?? argv[++i];
  }
  const port = Number(values.port ?? 3220);
  return { dshBin: values["dsh-bin"] || process.env.DSH_QA_BIN || join(repoRoot, "output/qa/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    port, modelPort: port + 1, feedPort: port + 2, lang: values.lang === "en" ? "en" : "zh", out: resolve(values.out ?? join(repoRoot, "output/qa/wp15-upgrade")) };
}

function run(command, args, { cwd = repoRoot, env, shell = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, shell, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${(result.stdout || "").slice(-2000)}\n${(result.stderr || "").slice(-2000)}`);
  return result.stdout || "";
}
const npm = (args, options) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], options)
  : run("npm", args, { shell: process.platform === "win32", ...options });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The current package, and a copy relabelled TEST_VERSION (same code, new version). */
async function packBoth(packDir, env) {
  npm(["run", "build"], { env });
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  const current = join(packDir, npm(["pack", "--ignore-scripts", "--pack-destination", packDir], { env }).trim().split(/\r?\n/).at(-1));
  const staging = join(packDir, "staging");
  await mkdir(staging, { recursive: true });
  run("tar", ["-xzf", current, "-C", staging]);
  const manifestPath = join(staging, "package", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const original = manifest.version;
  manifest.version = TEST_VERSION;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const nextName = `ericwang1358-dsh-daily-flashcard-${TEST_VERSION}.tgz`;
  run("tar", ["-czf", join(packDir, nextName), "-C", staging, "package"]);
  return { current, original, next: join(packDir, nextName), nextName };
}

/** A loopback stand-in for api.github.com + the release download host. */
async function fakeGithub(port, packagePath, packageName) {
  const bytes = await readFile(packagePath), origin = `http://127.0.0.1:${port}`;
  const sums = `${sha256(bytes)}  ${packageName}\n`;
  const download = `${origin}/${REPO}/releases/download/v${TEST_VERSION}`;
  const release = { tag_name: `v${TEST_VERSION}`, name: `StudyHub ${TEST_VERSION}`, draft: false, prerelease: false,
    published_at: new Date().toISOString(), html_url: `${origin}/${REPO}/releases/tag/v${TEST_VERSION}`,
    body: "## QA build\n- Same code as the current package, relabelled to prove the in-app upgrade.",
    assets: [{ name: packageName, browser_download_url: `${download}/${packageName}` },
      { name: `SHA256SUMS-${TEST_VERSION}.txt`, browser_download_url: `${download}/SHA256SUMS-${TEST_VERSION}.txt` }] };
  const log = [];
  const server = createServer((request, response) => {
    log.push(`${request.method} ${request.url} UA=${request.headers["user-agent"]}`);
    if (request.url === `/${REPO}/releases/latest`) { response.writeHead(302, { location: `${origin}/${REPO}/releases/tag/v${TEST_VERSION}` }); return response.end(); }
    if (request.url === `/repos/${REPO}/releases/latest`) { response.writeHead(200, { "content-type": "application/json" }); return response.end(JSON.stringify(release)); }
    if (request.url === `/${REPO}/releases/download/v${TEST_VERSION}/${packageName}`) { response.writeHead(200, { "content-type": "application/octet-stream" }); return response.end(bytes); }
    if (request.url === `/${REPO}/releases/download/v${TEST_VERSION}/SHA256SUMS-${TEST_VERSION}.txt`) { response.writeHead(200); return response.end(sums); }
    response.writeHead(404); response.end("not found");
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return { origin, log, sha: sha256(bytes), close: () => new Promise((done) => server.close(done)) };
}

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}
async function bootDsh(bin, { env, cwd, patch, port }) {
  const child = spawn(process.execPath, [bin, "--profile", PROFILE, "--patch", patch, "--port", String(port), "--no-open"],
    { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const url = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`DSH did not print its URL within 180 s:\n${output.slice(-2000)}`)), 180000);
    const read = (chunk) => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/); if (match) { clearTimeout(timer); done(match[0]); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`DSH exited (${code}) before it was ready:\n${output.slice(-2000)}`)); });
  });
  return { child, url, output: () => output };
}

/** Bring the StudyHub page up: it opens by itself, offers 新建会话 without a session, or sits behind its sidebar entry. */
async function ensureStudy(page) {
  const app = page.locator(".study-app .sidebar").first();
  for (let i = 0; i < 40 && !await app.count(); i++) {
    const start = page.locator(".studyhub-page-empty button");
    if (await start.count()) { await start.first().click(); await sleep(3000); continue; }
    const entry = page.getByText("StudyHub", { exact: true });
    if (i % 5 === 2 && await entry.count()) await entry.first().click().catch(() => {});
    await sleep(1000);
  }
  await app.waitFor({ timeout: 60000 });
  await sleep(2500);
}
async function openStudy(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await sleep(1500);
  for (let i = 0; i < 4; i++) {
    const next = page.getByRole("button", { name: /^(继续|稍后配置|跳过|Continue|Configure later|Skip)$/ });
    if (!await next.count()) break;
    await next.first().click({ timeout: 5000 }).catch(() => {});
    await sleep(800);
  }
  await ensureStudy(page);
}
async function readSettings(page) {
  await page.locator('[data-tour="nav-settings"]').first().click();
  const section = page.locator(".update-settings");
  await section.waitFor({ timeout: 30000 });
  await section.scrollIntoViewIfNeeded();
  await sleep(1500);
  return section;
}

export async function runUpgradeProof(options) {
  const removed = scrubProcessEnv();
  const home = join(options.out, "home"), documents = join(options.out, "documents"), packDir = join(options.out, "pack");
  const workspace = join(documents, "deepseek-harness", "default-workspace");
  const baseEnv = { ...scrubSecrets(process.env), DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", SSH_TTY: "audit" };
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), scrubbedEnv: removed, steps: [], consoleErrors: [], pageErrors: [], facts: {} };
  const step = async (name, work) => {
    const started = Date.now();
    try { const value = await work(); summary.steps.push({ name, status: "ok", ms: Date.now() - started }); return value; }
    catch (error) { summary.steps.push({ name, status: "failed", ms: Date.now() - started, error: String(error?.message || error).slice(0, 3000) }); throw error; }
  };
  let model, feed, dsh, browser;
  const logs = [];
  try {
    const version = run(process.execPath, [options.dshBin, "--version"], { env: baseEnv }).trim();
    if (version !== DSH_VERSION) throw new Error(`DSH ${version} found; this proof pins ${DSH_VERSION}`);
    const packs = await step("pack-plugin", () => packBoth(packDir, baseEnv));
    summary.facts.startVersion = packs.original;
    feed = await fakeGithub(options.feedPort, packs.next, packs.nextName);
    summary.facts.publishedSha256 = feed.sha;
    await step("create-profile", async () => {
      await mkdir(workspace, { recursive: true });
      run(process.execPath, [options.dshBin, "--profile", PROFILE, "--from-default-profile", "web", "--dump-config"], { cwd: workspace, env: baseEnv });
      run(process.execPath, [options.dshBin, "plugin", "--profile", PROFILE, "add", packs.current], { cwd: workspace, env: baseEnv });
    });
    const profileDir = join(home, "profiles", PROFILE);
    const installedVersion = async () => JSON.parse(await readFile(join(profileDir, "node_modules", "@ericwang1358", "dsh-daily-flashcard", "package.json"), "utf8")).version;
    const dependency = async () => JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")).dependencies?.["@ericwang1358/dsh-daily-flashcard"];
    summary.facts.before = { installed: await installedVersion(), dependency: await dependency() };
    model = await createFakeOpenAI({ port: options.modelPort });
    const patch = join(options.out, "qa.patch.yml");
    await writeFile(patch, "# Generated by scripts/qa/dsh-upgrade.mjs (test-only overlay).\n" + YAML.stringify(dshPatch({ fakeModelUrl: model.url, documentsDirectory: documents })));
    const dshEnv = { ...baseEnv, [FAKE_KEY_ENV]: "not-a-real-key", STUDYHUB_QA_UPDATE_FEED: feed.origin };
    dsh = await step("boot-dsh", () => bootDsh(options.dshBin, { env: dshEnv, cwd: workspace, patch, port: options.port }));
    browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: options.lang === "en" ? "en-US" : "zh-CN" });
    let page = await context.newPage();
    const watch = (target) => {
      target.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push(message.text()); });
      target.on("pageerror", (error) => summary.pageErrors.push(String(error?.message || error)));
    };
    watch(page);
    const shot = (name) => page.screenshot({ path: join(options.out, `${name}.png`) });
    await step("open-study", () => openStudy(page, dsh.url));
    await step("chip-appears", async () => {
      await page.locator(".update-chip").first().waitFor({ timeout: 60000 });
      summary.facts.chip = (await page.locator(".update-chip").first().innerText()).trim();
      await shot("01-chip");
    });
    await step("one-click-upgrade", async () => {
      await page.locator(".update-chip").first().click();
      await page.locator(".update-dialog").waitFor();
      await sleep(500);
      await shot("02-dialog");
      await page.locator(".update-dialog .sh-dialog__footer .sh-btn--primary").click();
      await sleep(300);
      await shot("03-confirm");
      await page.locator(".update-dialog .sh-dialog__footer .sh-btn--primary").click();
      // DSH may unload and reload StudyHub's browser code as soon as the package files change,
      // taking the dialog (and the pending answer) with it; both endings are recorded.
      const answered = page.locator(".update-dialog .update-done, .update-dialog .sh-inline--error").first();
      summary.facts.installOutcome = await Promise.race([
        answered.waitFor({ timeout: 240000 }).then(() => "dialog-answered"),
        page.locator(".update-dialog").waitFor({ state: "detached", timeout: 240000 }).then(() => "panel-unloaded"),
      ]);
      await sleep(1500);
      await shot("04-after-install");
      if (summary.facts.installOutcome === "dialog-answered") {
        if (!await page.locator(".update-dialog .update-done").count())
          throw new Error(`The dialog reports: ${(await page.locator(".update-dialog .sh-inline--error").innerText()).trim()}`);
        summary.facts.installedMessage = (await page.locator(".update-dialog .update-done").innerText()).trim();
      }
    });
    await step("verify-installed-on-disk", async () => {
      summary.facts.after = { installed: await installedVersion(), dependency: await dependency() };
      const saved = await readFile(join(home, "study", "updates", packs.nextName));
      summary.facts.savedSha256 = sha256(saved);
      if (summary.facts.after.installed !== TEST_VERSION) throw new Error(`node_modules still has ${summary.facts.after.installed}`);
      if (!String(summary.facts.after.dependency).includes(packs.nextName)) throw new Error(`profile dependency is ${summary.facts.after.dependency}`);
      if (summary.facts.savedSha256 !== feed.sha) throw new Error("the installed file is not the verified one");
      summary.facts.update = JSON.parse(await readFile(join(home, "study", "update.json"), "utf8"));
    });
    await step("before-restart", async () => {
      if (await page.locator(".update-dialog .update-done").count()) await page.locator(".update-dialog .sh-dialog__footer .sh-btn--primary").click();
      await ensureStudy(page);
      summary.facts.chipBeforeRestart = (await page.locator(".update-chip").first().innerText().catch(() => "")).trim();
      await shot("05-before-restart");
      summary.facts.settingsBeforeRestart = (await (await readSettings(page)).innerText()).trim();
    });
    await step("restart-dsh", async () => {
      await context.close();
      stopTree(dsh.child);
      logs.push(dsh.output());
      await sleep(2000);
      dsh = await bootDsh(options.dshBin, { env: dshEnv, cwd: workspace, patch, port: options.port });
    });
    await step("new-version-active", async () => {
      const second = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: options.lang === "en" ? "en-US" : "zh-CN" });
      page = await second.newPage();
      watch(page);
      await openStudy(page, dsh.url);
      const section = await readSettings(page);
      summary.facts.settingsAfterRestart = (await section.innerText()).trim();
      await section.screenshot({ path: join(options.out, "06-settings-after-restart.png") });
      if (!summary.facts.settingsAfterRestart.includes(TEST_VERSION)) throw new Error(`Settings shows: ${summary.facts.settingsAfterRestart}`);
      summary.facts.chipAfterRestart = await page.locator(".update-chip").count();
    });
  } catch (error) {
    summary.error = String(error?.message || error).slice(0, 4000);
    await browser?.contexts().at(-1)?.pages().at(-1)?.screenshot({ path: join(options.out, "99-failure.png") }).catch(() => {});
  } finally {
    if (feed) summary.feedRequests = feed.log;
    await browser?.close().catch(() => {});
    stopTree(dsh?.child);
    if (dsh) logs.push(dsh.output());
    await model?.close();
    await feed?.close();
    await writeFile(join(options.out, "dsh.log"), logs.join("\n----- restart -----\n").replace(/token=\S+/g, "token=…"));
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.error && summary.steps.every((item) => item.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runUpgradeProof(options);
  for (const item of summary.steps) console.log(`${item.status === "ok" ? "ok  " : "FAIL"} ${item.name}${item.error ? ` — ${item.error.split("\n")[0]}` : ""}`);
  console.log(JSON.stringify(summary.facts, null, 2));
  console.log(`${summary.ok ? "Upgrade proof passed" : "Upgrade proof FAILED"}: ${options.out}${summary.error ? `\n${summary.error}` : ""}`);
  process.exitCode = summary.ok ? 0 : 1;
}
