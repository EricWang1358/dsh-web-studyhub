/* global document, window, MutationObserver -- recordNotices runs in the browser */
/* node scripts/qa/dsh-upgrade.mjs --dsh-bin <lib/bin.js> [--dsh-version <x>] [--offline] [--port 3220] [--lang zh|en] [--out <dir>] [--from <tgz>]
   WP15 end-to-end proof of the in-app upgrade inside a real, isolated DSH web host: whichever release --dsh-bin is (never
   ~/.dsh, never the owner's keys, SSH_TTY set). --dsh-version only adds a check that it is that release.
   1. packs this plugin twice: as it is, and as the next major "-test" with every module under lib/ changed. A real release
      changes its code; a copy that only renames the version does not: pnpm re-links the identical files and DSH reloads none;
   2. serves a fake GitHub "latest release" of the second (with SHA256SUMS) on 127.0.0.1; STUDYHUB_QA_UPDATE_FEED points there;
   3. creates a fresh profile from the `web` template, adds the first with `dsh plugin add`, boots DSH with a local fake model;
   4. opens Study, clicks the update chip, 一键升级 → 确认升级, and waits for the host's own answer to that click, however long it
      takes (DSH may unload StudyHub's page before it has finished installing), then checks the profile on disk against it;
      a learner comes straight back, so StudyHub is opened again as soon as its page closes, answered or not;
   5. before any restart, opens StudyHub again: Settings › 关于与更新 says which version runs (DSH may load the new code at once,
      or keep the old until a restart), and the restart chip has to agree; then loads the page once more, an ordinary start;
   6. restarts DSH and checks that Settings reports the new version;
   7. every 「已升级到」 notice the page showed from the click on is recorded: exactly one, for the new version, before the restart
      when the new code already ran then and after it otherwise, and reported to the host once (noticeVerdict).
   --from <tgz>: the profile starts on that packed release (an earlier published one, say) instead of the current code.
   --offline: pnpm uses only what its store already holds. pnpm 11 reads pnpm_config_offline and ignores npm_config_offline.
   Output: output/qa/wp15-upgrade/*.png, dsh.log, summary.json (also the first 200 failed browser requests and console errors,
   with their step, and how often each action was asked after the click). Not part of npm test; what it decides without a host
   is in dsh-upgrade-checks.mjs, tested by tests/qa-upgrade-proof.test.mjs. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { scrubSecrets, scrubProcessEnv } from "./env.mjs";
import { launchChromium } from "./browser.mjs";
import { createFakeOpenAI } from "./fake-openai.mjs";
import { dshPatch, FAKE_KEY_ENV, openDsh, stopTree } from "./dsh-e2e.mjs";
import { REPO, UPGRADE_NOTICE, fakeRelease, hostProblem, installVerdict, noticeVerdict, offlineEnv, parseArgs, relabelRelease, runningBeforeRestart, systemTar,
  upgradeTestVersion } from "./dsh-upgrade-checks.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PROFILE = "studyhub-upgrade";
const PACKAGE = "@ericwang1358/dsh-daily-flashcard";
// One install end to end: the download from the loopback feed, pnpm, and DSH reloading what changed. The host's answer ends the wait.
const INSTALL_TIMEOUT_MS = 6 * 60 * 1000;
// How long a start is watched for a notice: it comes with the first update.check, which waits for the library to load.
const NOTICE_WAIT_MS = 10 * 1000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, args, { cwd = repoRoot, env, shell = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, shell, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${(result.stdout || "").slice(-2000)}\n${(result.stderr || "").slice(-2000)}`);
  return result.stdout || "";
}
const npm = (args, options) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], options)
  : run("npm", args, { shell: process.platform === "win32", ...options });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The current package (or `from`, a packed release to start on) and release upgradeTestVersion(current) made from the current one (relabelRelease). */
async function packBoth(packDir, env, from) {
  npm(["run", "build"], { env });
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  const current = join(packDir, npm(["pack", "--ignore-scripts", "--pack-destination", packDir], { env }).trim().split(/\r?\n/).at(-1));
  const staging = join(packDir, "staging"), tar = systemTar();
  await mkdir(staging, { recursive: true });
  run(tar, ["-xzf", current, "-C", staging], { env });
  const original = JSON.parse(await readFile(join(staging, "package", "package.json"), "utf8")).version;
  const version = upgradeTestVersion(original);
  const modules = await relabelRelease(join(staging, "package"), version);
  const packageName = `ericwang1358-dsh-daily-flashcard-${version}.tgz`;
  run(tar, ["-czf", join(packDir, packageName), "-C", staging, "package"], { env });
  const start = from ? { current: from, original: JSON.parse(run(tar, ["-xzOf", from, "package/package.json"], { env })).version } : { current, original };
  return { ...start, version, modules, next: join(packDir, packageName), packageName };
}

/** A loopback stand-in for api.github.com + the release download host. */
async function fakeGithub(port, packagePath, packageName, version) {
  const bytes = await readFile(packagePath), origin = `http://127.0.0.1:${port}`;
  const sums = `${sha256(bytes)}  ${packageName}\n`;
  const release = fakeRelease(origin, version, packageName);
  const download = `/${REPO}/releases/download/v${version}`;
  const log = [];
  const server = createServer((request, response) => {
    log.push(`${request.method} ${request.url} UA=${request.headers["user-agent"]}`);
    if (request.url === `/${REPO}/releases/latest`) { response.writeHead(302, { location: release.html_url }); return response.end(); }
    if (request.url === `/repos/${REPO}/releases/latest`) { response.writeHead(200, { "content-type": "application/json" }); return response.end(JSON.stringify(release)); }
    if (request.url === `${download}/${packageName}`) { response.writeHead(200, { "content-type": "application/octet-stream" }); return response.end(bytes); }
    if (request.url === `${download}/SHA256SUMS-${version}.txt`) { response.writeHead(200); return response.end(sums); }
    response.writeHead(404); response.end("not found");
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return { origin, log, sha: sha256(bytes), close: () => new Promise((done) => server.close(done)) };
}

async function bootDsh(bin, { env, cwd, patch, port }) {
  const child = spawn(process.execPath, [bin, "--profile", PROFILE, "--patch", patch, "--port", String(port), "--no-open"],
    { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  try {
    const url = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`DSH did not print its URL within 180 s:\n${output.slice(-2000)}`)), 180000);
      const read = (chunk) => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/); if (match) { clearTimeout(timer); done(match[0]); } };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`DSH exited (${code}) before it was ready:\n${output.slice(-2000)}`)); });
    });
    return { child, url, output: () => output };
  } catch (error) {
    // the caller never gets this host back: stop it here, or its piped stdio keeps the script alive
    const stopped = await stopTree(child);
    if (!stopped.stopped) error.message += `\n(the host, PID ${stopped.pid}, is still running)`;
    throw error;
  }
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
  await openDsh(page, url);
  await sleep(1500);
  for (let i = 0; i < 4; i++) {
    const next = page.getByRole("button", { name: /^(继续|稍后配置|跳过|Continue|Configure later|Skip)$/ });
    if (!await next.count()) break;
    await next.first().click({ timeout: 5000 }).catch(() => {});
    await sleep(800);
  }
  await ensureStudy(page);
}
/** Settings › 关于与更新, once it has its answer: the section, and the version it names as running (its first fact). */
async function readSettings(page) {
  await page.locator('[data-tour="nav-settings"]').first().click();
  await page.locator('.settings-nav [data-category="update"]').click();
  const section = page.locator(".update-settings");
  await section.waitFor({ timeout: 30000 });
  const running = section.locator(".update-facts dd").first();
  await running.filter({ hasText: /\d/ }).waitFor({ timeout: 60000 });
  await section.scrollIntoViewIfNeeded();
  return { section, current: (await running.innerText()).trim() };
}

const bodyOf = (request) => { try { return JSON.parse(request.postData() || "") ?? {}; } catch { return {}; } };
/** The host call a browser request carries (study-workspace/call names its action), or the bare RPC method. */
const actionOf = (request) => { const body = bodyOf(request); return body.payload?.action || body.method || ""; };

/** Runs in the page: reports each toast that announces an upgrade, once per toast. */
function recordNotices(pattern) {
  const seen = new WeakSet(), notice = new RegExp(pattern);
  new MutationObserver(() => {
    for (const message of document.querySelectorAll(".sh-toast__message")) {
      if (seen.has(message) || !notice.test(message.textContent)) continue;
      seen.add(message);
      window.studyhubQaNotice({ text: message.textContent.trim(), besideUpgradeDialog: !!document.querySelector(".update-dialog") });
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}

export async function runUpgradeProof(options) {
  const removed = scrubProcessEnv();
  const home = join(options.out, "home"), documents = join(options.out, "documents"), packDir = join(options.out, "pack");
  const workspace = join(documents, "deepseek-harness", "default-workspace");
  const baseEnv = { ...scrubSecrets(process.env), ...offlineEnv(options.offline), DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", SSH_TTY: "audit" };
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const started = Date.now(), at = () => Math.round((Date.now() - started) / 100) / 10;
  const summary = { startedAt: new Date(started).toISOString(), offline: options.offline === true, scrubbedEnv: removed, steps: [],
    consoleErrors: [], pageErrors: [], failedRequests: [], requestsAfterClick: {}, notices: [], noticeReports: [], facts: {} };
  let current = "", clickedAt = 0;
  const step = async (name, work) => {
    const began = Date.now();
    current = name;
    try { const value = await work(); summary.steps.push({ name, status: "ok", ms: Date.now() - began }); return value; }
    catch (error) { summary.steps.push({ name, status: "failed", ms: Date.now() - began, error: String(error?.message || error).slice(0, 3000) }); throw error; }
  };
  // A page that hammers the host after a reload shows as thousands of one action, so each list keeps only its first entries.
  const keep = (list, entry) => { if (list.length < 200) list.push({ at: at(), step: current, ...entry }); };
  const watch = (target) => {
    target.on("console", (message) => { if (message.type() === "error") keep(summary.consoleErrors, { text: message.text(), url: message.location().url.replace(/token=\S+/, "token=…") }); });
    target.on("pageerror", (error) => keep(summary.pageErrors, { text: String(error?.message || error) }));
    target.on("request", (request) => {
      const action = actionOf(request), told = action === "update.preferences" ? bodyOf(request).payload?.args?.upgradeTold : undefined;
      if (told !== undefined) summary.noticeReports.push(told);
      if (clickedAt && action) summary.requestsAfterClick[action] = (summary.requestsAfterClick[action] || 0) + 1;
    });
    const failed = (request, why) => keep(summary.failedRequests, { why, method: request.method(), path: new URL(request.url()).pathname, action: actionOf(request) });
    target.on("response", (response) => { if (response.status() >= 400) failed(response.request(), `HTTP ${response.status()}`); });
    target.on("requestfailed", (request) => failed(request, request.failure()?.errorText || "failed"));
  };
  let model, feed, dsh, browser;
  const logs = [];
  try {
    await access(options.dshBin).catch(() => { throw new Error(`No DSH at ${options.dshBin}: pass --dsh-bin <an installed lib/bin.js> (or set DSH_QA_BIN)`); });
    summary.facts.dshVersion = run(process.execPath, [options.dshBin, "--version"], { env: baseEnv }).trim();
    const problem = hostProblem(summary.facts.dshVersion, options.dshVersion);
    if (problem) throw new Error(problem);
    const packs = await step("pack-plugin", () => packBoth(packDir, baseEnv, options.from));
    Object.assign(summary.facts, { startVersion: packs.original, testVersion: packs.version, changedModules: packs.modules });
    feed = await fakeGithub(options.feedPort, packs.next, packs.packageName, packs.version);
    summary.facts.publishedSha256 = feed.sha;
    await step("create-profile", async () => {
      await mkdir(workspace, { recursive: true });
      run(process.execPath, [options.dshBin, "--profile", PROFILE, "--from-default-profile", "web", "--dump-config"], { cwd: workspace, env: baseEnv });
      run(process.execPath, [options.dshBin, "plugin", "--profile", PROFILE, "add", packs.current], { cwd: workspace, env: baseEnv });
    });
    const profileDir = join(home, "profiles", PROFILE);
    const onDisk = async () => ({
      installed: JSON.parse(await readFile(join(profileDir, "node_modules", ...PACKAGE.split("/"), "package.json"), "utf8")).version,
      dependency: JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")).dependencies?.[PACKAGE],
    });
    summary.facts.before = await onDisk();
    model = await createFakeOpenAI({ port: options.modelPort });
    const patch = join(options.out, "qa.patch.yml");
    await writeFile(patch, "# Generated by scripts/qa/dsh-upgrade.mjs (test-only overlay).\n" + YAML.stringify(dshPatch({ fakeModelUrl: model.url, documentsDirectory: documents })));
    const dshEnv = { ...baseEnv, [FAKE_KEY_ENV]: "not-a-real-key", STUDYHUB_QA_UPDATE_FEED: feed.origin };
    dsh = await step("boot-dsh", () => bootDsh(options.dshBin, { env: dshEnv, cwd: workspace, patch, port: options.port }));
    browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
    const newPage = async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: options.lang === "en" ? "en-US" : "zh-CN" });
      await context.exposeFunction("studyhubQaNotice", (notice) => {
        if (!clickedAt) return;
        summary.notices.push({ at: at(), step: current, ...notice });
        // Taken while it is up; a second one would be the failure the summary names.
        if (summary.notices.length === 1) sleep(400).then(() => shot("05a-notice")).catch(() => {});
      });
      await context.addInitScript(recordNotices, UPGRADE_NOTICE.source);
      const page = await context.newPage();
      watch(page);
      return { context, page };
    };
    let { context, page } = await newPage();
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
      summary.facts.confirmText = (await page.locator(".update-dialog").innerText({ timeout: 5000 }).catch(() => "")).trim();
      await shot("03-confirm");
      const answered = page.waitForResponse((response) => actionOf(response.request()) === "update.install", { timeout: INSTALL_TIMEOUT_MS });
      answered.catch(() => {});
      clickedAt = Date.now();
      await page.locator(".update-dialog .sh-dialog__footer .sh-btn--primary").click();
      // DSH may unload StudyHub's browser code, the dialog with it, long before the install is over: noted, but it ends nothing.
      const closed = page.locator(".update-dialog").waitFor({ state: "detached", timeout: INSTALL_TIMEOUT_MS })
        .then(() => { summary.facts.dialogGoneAfterMs = Date.now() - clickedAt; return true; }, () => false);
      await sleep(300);
      const working = page.locator('.update-dialog .update-lead[role="status"]');
      if (await working.count()) {
        summary.facts.workingText = await working.innerText({ timeout: 2000 }).then((text) => text.trim(), () => "");
        await shot("03b-working");
      }
      // The learner comes straight back once DSH has closed the page, perhaps before the host has answered: the new code must not miss that opening.
      let answerCame = false;
      answered.then(() => { answerCame = true; }, () => {});
      if (await Promise.race([closed, answered.then(() => false, () => false)])) {
        summary.facts.reopenedDuringInstall = await ensureStudy(page)
          .then(() => ({ afterClickMs: Date.now() - clickedAt, beforeTheAnswer: !answerCame }), (error) => ({ error: String(error.message).split("\n")[0] }));
      }
      let answer;
      try { answer = await (await answered).json(); }
      catch (error) {
        throw new Error(`no answer to update.install within ${INSTALL_TIMEOUT_MS / 1000} s (${String(error.message).split("\n")[0]}); on disk: ${JSON.stringify(await onDisk().catch((e) => e.message))}`);
      }
      summary.facts.answeredAfterMs = Date.now() - clickedAt;
      summary.facts.answer = answer.result;
      const verdict = installVerdict(answer, await onDisk(), packs);
      await shot("04-after-install");
      if (!verdict.ok) throw new Error(verdict.reason);
      summary.facts.install = verdict;
    });
    await step("verify-installed-on-disk", async () => {
      summary.facts.after = await onDisk();
      summary.facts.savedSha256 = sha256(await readFile(join(home, "study", "updates", packs.packageName)));
      if (summary.facts.savedSha256 !== feed.sha) throw new Error("the installed file is not the verified one");
    });
    await step("before-restart", async () => {
      // DSH may answer a moment before it closes the page, so the dialog's last words can vanish while they are being dismissed.
      if (await page.locator(".update-dialog .update-done").count())
        await page.locator(".update-dialog .sh-dialog__footer .sh-btn--primary").click({ timeout: 5000 }).catch(() => {});
      await ensureStudy(page);
      for (let waited = 0; waited < NOTICE_WAIT_MS && !summary.notices.length; waited += 500) await sleep(500);
      const settings = await readSettings(page);
      await shot("05-before-restart");
      summary.facts.settingsBeforeRestart = (await settings.section.innerText()).trim();
      summary.facts.beforeRestart = runningBeforeRestart({ current: settings.current, restartChip: await page.locator(".update-chip--restart").count() > 0 },
        { before: packs.original, next: packs.version });
      // StudyHub's marker: `pending` waits for a restart; code that already runs the new version has cleared it.
      const marker = JSON.parse(await readFile(join(home, "study", "update.json"), "utf8"));
      summary.facts.marker = { pending: marker.pending ?? null, installedAt: marker.installedAt ?? null };
    });
    await step("second-start", async () => {
      // The page loaded afresh on the same host: an ordinary start, which must not repeat what was said.
      await openStudy(page, dsh.url);
      await sleep(NOTICE_WAIT_MS);
      summary.facts.noticesBeforeRestart = summary.notices.length;
      await shot("05b-second-start");
    });
    await step("restart-dsh", async () => {
      await context.close();
      const stopped = await stopTree(dsh.child);
      logs.push(dsh.output());
      if (!stopped.stopped) { summary.hostStillRunning = stopped.pid; throw new Error(`the host (PID ${stopped.pid}) did not stop, so it cannot be restarted on port ${options.port}`); }
      dsh = null;
      await sleep(2000);
      dsh = await bootDsh(options.dshBin, { env: dshEnv, cwd: workspace, patch, port: options.port });
    });
    await step("new-version-active", async () => {
      ({ context, page } = await newPage());
      await openStudy(page, dsh.url);
      const settings = await readSettings(page);
      summary.facts.settingsAfterRestart = (await settings.section.innerText()).trim();
      await settings.section.screenshot({ path: join(options.out, "06-settings-after-restart.png") });
      if (settings.current !== packs.version) throw new Error(`after the restart the running version reads ${settings.current}, not ${packs.version}`);
      summary.facts.chipAfterRestart = await page.locator(".update-chip").count();
      if (summary.facts.chipAfterRestart) throw new Error("an update chip is still shown after the restart");
      await sleep(NOTICE_WAIT_MS);
    });
    await step("upgrade-notice", async () => {
      summary.facts.notice = noticeVerdict({ running: summary.facts.beforeRestart.running, shown: summary.notices, reports: summary.noticeReports }, packs);
    });
  } catch (error) {
    summary.error = String(error?.message || error).slice(0, 4000);
    await browser?.contexts().at(-1)?.pages().at(-1)?.screenshot({ path: join(options.out, "99-failure.png") }).catch(() => {});
  } finally {
    if (feed) summary.feedRequests = feed.log;
    await browser?.close().catch(() => {});
    const stopped = await stopTree(dsh?.child);
    if (!stopped.stopped) summary.hostStillRunning = stopped.pid;
    if (dsh) logs.push(dsh.output());
    await model?.close();
    await feed?.close();
    await writeFile(join(options.out, "dsh.log"), logs.join("\n----- restart -----\n").replace(/token=\S+/g, "token=…"));
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.error && summary.steps.every((item) => item.status === "ok") && summary.hostStillRunning === undefined;
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
