/* npm run qa:dsh [-- --lang zh|en --port 3190 --model-port 4194 --dsh-bin <bin.js> --reuse-home]
   The plugin inside a real, isolated DSH 0.2 web host:
   1. installs @deepseek-ai/dsh@0.2.0-rc.2 into output/qa/dsh-cli when missing
      (or uses --dsh-bin / DSH_QA_BIN, the path of an installed lib/bin.js);
   2. creates a fresh DSH_HOME at output/qa/dsh-home with a profile made from
      the shipped `web` template, builds and packs this plugin and adds it;
   3. boots it with every *_API_KEY/*_TOKEN/*BASE_URL variable removed,
      SSH_TTY=audit (in-browser folder picker, never a native dialog), a local
      fake OpenAI-compatible model (scripts/qa/fake-openai.mjs) as the default
      model, and the default workspace under output/qa/dsh-documents;
   4. opens Study with Playwright, screenshots it, then stops everything.
   It never reads or writes ~/.dsh or the owner's Documents folder.
   Output: output/qa/dsh-e2e/*.png and summary.json. Not part of npm test. */
/* global document -- callbacks passed to page.evaluate / waitForFunction run in the browser */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { scrubSecrets, scrubProcessEnv } from "./env.mjs";
import { launchChromium } from "./browser.mjs";
import { createFakeOpenAI, FAKE_OPENAI_MODEL } from "./fake-openai.mjs";

export const DSH_VERSION = "0.2.0-rc.2";
export const DSH_PROFILE = "studyhub-e2e";
export const FAKE_PROVIDER = "studyhub-qa-fake";
// Deliberately not *_API_KEY: it must survive the secret scrub, and it is not a secret.
export const FAKE_KEY_ENV = "STUDYHUB_QA_FAKE_KEY";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const qaRoot = resolve(repoRoot, "output/qa");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = (path) => access(path).then(() => true, () => false);

/** The --patch overlay: a local fake model as the default route, documents inside output/qa. */
export function dshPatch({ fakeModelUrl, documentsDirectory, keyEnv = FAKE_KEY_ENV }) {
  return [
    { id: "llm-pi-ai", config: { providers: { [FAKE_PROVIDER]: { displayName: "StudyHub QA fake model (local)", apiKeyEnv: keyEnv,
      api: "openai-completions", baseURL: fakeModelUrl,
      models: [{ id: FAKE_OPENAI_MODEL, name: "Fake Tutor", contextWindow: 65536, reasoningEfforts: false }] } } } },
    { id: "agent-default-model", config: { provider: FAKE_PROVIDER, model: FAKE_OPENAI_MODEL } },
    { id: "workspace-controller", config: { documentsDirectory } },
  ];
}

export function parseDshArgs(argv = []) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    if (match[1] === "reuse-home") { values["reuse-home"] = true; continue; }
    values[match[1]] = match[2] ?? argv[++i];
  }
  const lang = values.lang ?? "zh";
  if (!["zh", "en"].includes(lang)) throw new Error("--lang must be zh or en");
  return { lang, port: Number(values.port ?? 3190), modelPort: Number(values["model-port"] ?? 4194),
    dshBin: values["dsh-bin"] || process.env.DSH_QA_BIN || "", reuseHome: !!values["reuse-home"],
    out: resolve(values.out ?? join(qaRoot, "dsh-e2e")) };
}

/** Run a command to completion with the scrubbed environment; throws with its output on failure. */
function run(command, args, { cwd = repoRoot, env, shell = false, label = command } = {}) {
  const result = spawnSync(command, args, { cwd, env, shell, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true });
  if (result.status !== 0)
    throw new Error(`${label} failed (exit ${result.status}):\n${(result.stdout || "").slice(-2000)}\n${(result.stderr || "").slice(-2000)}`);
  return result.stdout || "";
}
const npm = (args, options) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], { label: `npm ${args[0]}`, ...options })
  : run("npm", args, { shell: process.platform === "win32", label: `npm ${args[0]}`, ...options });

async function ensureDsh(options, env) {
  if (options.dshBin) return resolve(options.dshBin);
  const cli = join(qaRoot, "dsh-cli"), manifest = join(cli, "node_modules/@deepseek-ai/dsh/package.json");
  const installed = await readFile(manifest, "utf8").then((text) => JSON.parse(text).version, () => "");
  if (installed !== DSH_VERSION) {
    console.log(`Installing @deepseek-ai/dsh@${DSH_VERSION} into ${cli} …`);
    await mkdir(cli, { recursive: true });
    if (!await exists(join(cli, "package.json"))) await writeFile(join(cli, "package.json"), JSON.stringify({ name: "studyhub-qa-dsh-cli", private: true }) + "\n");
    npm(["install", `@deepseek-ai/dsh@${DSH_VERSION}`, "--no-audit", "--no-fund"], { cwd: cli, env });
  }
  return join(cli, "node_modules/@deepseek-ai/dsh/lib/bin.js");
}

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

async function bootDsh(bin, { env, cwd, patch, port }) {
  const child = spawn(process.execPath, [bin, "--profile", DSH_PROFILE, "--patch", patch, "--port", String(port), "--no-open"],
    { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const url = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`DSH did not print its URL within 180 s:\n${output.slice(-2000)}`)), 180000);
    const read = (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
      if (match) { clearTimeout(timer); done(match[0]); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`DSH exited (${code}) before it was ready:\n${output.slice(-2000)}`)); });
  });
  return { child, url, output: () => output };
}

export async function runDshE2e(options) {
  const removed = scrubProcessEnv();
  const home = join(qaRoot, "dsh-home"), documents = join(qaRoot, "dsh-documents"), packDir = join(qaRoot, "dsh-pack");
  // DSH's own default workspace under documentsDirectory; also the launch directory.
  const workspace = join(documents, "deepseek-harness", "default-workspace");
  const baseEnv = { ...scrubSecrets(process.env), DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", SSH_TTY: "audit" };
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), options, scrubbedEnv: removed, steps: [], consoleErrors: [], pageErrors: [] };
  const step = async (name, work) => {
    const started = Date.now();
    try { const value = await work(); summary.steps.push({ name, status: "ok", ms: Date.now() - started }); return value; }
    catch (error) { summary.steps.push({ name, status: "failed", ms: Date.now() - started, error: String(error?.message || error).slice(0, 2000) }); throw error; }
  };
  let model, dsh, browser;
  try {
    const bin = await step("install-dsh", () => ensureDsh(options, baseEnv));
    const version = run(process.execPath, [bin, "--version"], { env: baseEnv }).trim();
    if (version !== DSH_VERSION) throw new Error(`DSH ${version} found; this harness pins ${DSH_VERSION}`);
    const tgz = await step("pack-plugin", async () => {
      npm(["run", "build"], { env: baseEnv });
      await rm(packDir, { recursive: true, force: true });
      await mkdir(packDir, { recursive: true });
      const name = npm(["pack", "--ignore-scripts", "--pack-destination", packDir], { env: baseEnv }).trim().split(/\r?\n/).at(-1);
      return join(packDir, name);
    });
    await step("create-profile", async () => {
      if (!options.reuseHome) await rm(home, { recursive: true, force: true });
      await mkdir(home, { recursive: true });
      await mkdir(workspace, { recursive: true });
      if (!await exists(join(home, "profiles", DSH_PROFILE)))
        run(process.execPath, [bin, "--profile", DSH_PROFILE, "--from-default-profile", "web", "--dump-config"], { cwd: workspace, env: baseEnv, label: "dsh profile" });
      run(process.execPath, [bin, "plugin", "--profile", DSH_PROFILE, "add", tgz], { cwd: workspace, env: baseEnv, label: "dsh plugin add" });
    });
    model = await createFakeOpenAI({ port: options.modelPort });
    const patch = join(options.out, "qa.patch.yml");
    await writeFile(patch, "# Generated by scripts/qa/dsh-e2e.mjs (test-only overlay).\n" + YAML.stringify(dshPatch({ fakeModelUrl: model.url, documentsDirectory: documents })));
    dsh = await step("boot-dsh", () => bootDsh(bin, { env: { ...baseEnv, [FAKE_KEY_ENV]: "not-a-real-key" }, cwd: workspace, patch, port: options.port }));
    summary.url = dsh.url.replace(/token=\S+/, "token=…");
    browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: options.lang === "en" ? "en-US" : "zh-CN" });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => summary.pageErrors.push(String(error?.message || error)));
    const shot = (name) => page.screenshot({ path: join(options.out, `${name}.png`) });
    await step("open-dsh", async () => {
      await page.goto(dsh.url, { waitUntil: "networkidle" });
      await sleep(1500);
      for (let i = 0; i < 4; i++) {
        const next = page.getByRole("button", { name: /^(继续|稍后配置|跳过|Continue|Configure later|Skip)$/ });
        if (!await next.count()) break;
        await next.first().click();
        await sleep(800);
      }
      await shot("01-dsh-home");
    });
    await step("first-message", async () => {
      // DSH 0.2.0-rc.2 opens straight on the Study plugin page (its only plugin tab): there is no composer to type in then.
      if (await page.locator(".study-app").first().isVisible().catch(() => false)) { await shot("02-study-already-open"); return; }
      const box = page.getByRole("textbox").last();
      await box.click();
      await page.keyboard.type(options.lang === "en" ? "Hello, I want to study with my notes." : "你好，我想用我的资料学习。");
      await page.keyboard.press("Enter");
      await sleep(8000);
      await shot("02-after-first-message");
    });
    await step("open-study", async () => {
      const tab = page.getByRole("tab", { name: /学习|Study/ });
      if (!await page.locator(".study-app").first().isVisible().catch(() => false)) {
        await tab.first().waitFor({ timeout: 30000 });
        await tab.first().click();
      }
      await page.locator(".study-app, [class*=study]").first().waitFor({ timeout: 60000 });
      await sleep(3000);
      await shot("03-study");
      await page.setViewportSize({ width: 900, height: 900 });
      await sleep(1500);
      await shot("04-study-900");
    });
    // Select and Combobox (Base UI, lazily loaded chunks) inside the real host: its react (the only one shared), the bundled react-dom, the
    // popups' placement, focus and Escape. Mouse and keyboard; once more inside an open modal dialog (the settings field is moved into one).
    await step("select-and-combobox", async () => {
      const popup = page.locator(".sh-pop__popup:not([data-closed])");
      const nav = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click({ force: true }); await sleep(1200); };
      const focused = async (locator, message) => {
        const handle = await locator.elementHandle();
        await page.waitForFunction((element) => document.activeElement === element, handle, { timeout: 4000 }).catch(() => {});
        if (!await locator.evaluate((element) => document.activeElement === element)) throw new Error(message);
      };
      const inside = async (locator, host) => { const a = await locator.boundingBox(), b = await host.boundingBox(); return !!a && !!b && a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1; };
      await page.setViewportSize({ width: 1440, height: 900 });
      await nav("settings");
      await page.getByRole("button", { name: /^(出题偏好|Generation preferences)$/ }).first().click();
      await sleep(1000);
      const select = page.locator('.settings-form [role="combobox"]:visible').first();
      await select.waitFor({ timeout: 30000 });
      const before = (await select.innerText()).trim();
      // mouse: open, the popup sits under the trigger inside the window, choose another option
      await select.click();
      await popup.waitFor({ timeout: 10000 });
      await sleep(300);
      const a = await select.boundingBox(), b = await popup.boundingBox();
      if (Math.abs(a.x - b.x) > 1.5 || Math.abs(a.width - b.width) > 1.5) {
        summary.selectDiagnostics = await page.evaluate(() => {
          const positioner = document.querySelector(".sh-pop:not([hidden])"), chain = [];
          for (let node = positioner?.parentElement; node && chain.length < 12; node = node.parentElement) {
            const style = getComputedStyle(node);
            chain.push({ tag: node.tagName, cls: String(node.className).slice(0, 60), position: style.position, transform: style.transform, zoom: style.zoom, contain: style.contain, overflow: style.overflow });
          }
          return { positionerStyle: positioner?.getAttribute("style"), data: positioner && Object.fromEntries([...positioner.attributes].map((attribute) => [attribute.name, attribute.value]).filter(([name]) => name !== "style")), chain,
            react: Object.keys(window).filter((key) => /react|loader/i.test(key)) };
        });
        const style = () => page.evaluate(() => document.querySelector(".sh-pop:not([hidden])")?.getAttribute("style"));
        await sleep(2000);
        summary.selectDiagnostics.afterTwoSeconds = await style();
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await sleep(500);
        summary.selectDiagnostics.afterResize = await style();
        await page.keyboard.press("ArrowDown");
        await sleep(500);
        summary.selectDiagnostics.afterKey = await style();
        summary.selectDiagnostics.console = summary.consoleErrors.slice(-5);
        await shot("05-select-misplaced");
        throw new Error(`the select popup is not under its trigger in the host: ${JSON.stringify([a, b])}`);
      }
      await shot("05-select-open");
      const options = await popup.getByRole("option").allInnerTexts();
      if (options.length < 3) throw new Error(`the select offers ${options.length} options`);
      await popup.getByRole("option").nth(1).click();
      await popup.waitFor({ state: "hidden" });
      if ((await select.innerText()).trim() === before) throw new Error("choosing an option did not change the select");
      await focused(select, "focus did not return to the select after a choice");
      // keyboard: Enter opens, ArrowDown moves, Enter chooses, Escape closes and returns focus
      await select.press("Enter");
      await popup.waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await popup.waitFor({ state: "hidden" });
      await focused(select, "focus did not return to the select after keyboard choice");
      await select.press("Enter");
      await popup.waitFor();
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "hidden" });
      await focused(select, "Escape did not return focus to the select");
      // inside an open modal dialog (top layer): the settings field is moved into a <dialog>, the popup must open in it
      await page.evaluate(() => {
        const field = document.querySelector('.settings-form [role="combobox"]').closest(".sh-field");
        const dialog = document.createElement("dialog");
        dialog.id = "qa-dialog";
        dialog.style.cssText = "width: 420px; min-height: 380px; padding: 24px;"; // tall enough for a popup: a dialog clips what it holds, as the Menu has always been
        field.closest(".study-app").appendChild(dialog);
        dialog.appendChild(field);
        dialog.showModal();
      });
      await sleep(400);
      const dialog = page.locator("#qa-dialog");
      const inDialog = dialog.locator('[role="combobox"]').first();
      await inDialog.click();
      await popup.waitFor({ timeout: 10000 });
      await sleep(300);
      if (!await popup.evaluate((element) => !!element.closest("dialog[open]"))) throw new Error("the select popup is not inside the open dialog");
      if (!await popup.isVisible() || !(await popup.getByRole("option").count())) throw new Error("the select popup in the dialog is not usable");
      await shot("06-select-in-dialog");
      await popup.getByRole("option").nth(0).click();
      await popup.waitFor({ state: "hidden" });
      await focused(inDialog, "focus did not return to the select inside the dialog");
      await inDialog.press("Enter");
      await popup.waitFor();
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "hidden" });
      if (!await dialog.evaluate((element) => element.open)) throw new Error("Escape closed the dialog together with the select popup");
      await page.evaluate(() => document.getElementById("qa-dialog").close());
      // Combobox: the page scope of the statistics page
      await nav("dashboard");
      const scope = page.locator('.page-scope [role="combobox"]:visible').first();
      await scope.waitFor({ timeout: 30000 });
      await scope.click();
      await popup.waitFor();
      const search = popup.locator(".sh-combobox__input");
      if (!await search.evaluate((element) => document.activeElement === element)) throw new Error("the combobox search box did not take focus");
      await page.keyboard.type("zzzz-no-such-course");
      await sleep(300);
      if (await popup.getByRole("option").count()) throw new Error("a search with no match still lists options");
      if (!(await popup.locator(".sh-combobox__empty").innerText()).trim()) throw new Error("no empty-state sentence");
      await shot("07-combobox-empty");
      await search.fill("");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await popup.waitFor({ state: "hidden" });
      await focused(scope, "focus did not return to the combobox trigger");
      await scope.click();
      await popup.waitFor();
      if (!await inside(popup, page.locator("body"))) throw new Error("the combobox popup is outside the window");
      await shot("08-combobox-open");
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "hidden" });
      await focused(scope, "Escape did not return focus to the combobox trigger");
    });
    const flushWarnings = summary.consoleErrors.filter((text) => /flushSync|Maximum update depth|Invalid hook call/i.test(text));
    if (flushWarnings.length) summary.steps.push({ name: "no-react-warnings", status: "failed", ms: 0, error: flushWarnings.join(" | ").slice(0, 800) });
    summary.modelRequests = model.log.length;
  } catch (error) {
    summary.error = String(error?.message || error).slice(0, 4000);
  } finally {
    await browser?.close().catch(() => {});
    stopTree(dsh?.child);
    await model?.close();
    if (dsh) await writeFile(join(options.out, "dsh.log"), dsh.output().replace(/token=\S+/g, "token=…"));
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.error && !summary.pageErrors.length && summary.steps.every((item) => item.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDshArgs(process.argv.slice(2));
    const summary = await runDshE2e(options);
    for (const item of summary.steps) console.log(`${item.status === "ok" ? "ok  " : "FAIL"} ${item.name}${item.error ? ` — ${item.error.split("\n")[0]}` : ""}`);
    console.log(`${summary.ok ? "DSH e2e passed" : "DSH e2e FAILED"}: ${options.out}${summary.error ? `\n${summary.error}` : ""}`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
