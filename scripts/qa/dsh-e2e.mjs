/* npm run qa:dsh [-- --lang zh|en --port 3190 --model-port 4194 --dsh-version 0.2.0-rc.2 --dsh-bin <bin.js> --reuse-home]
   The plugin inside a real, isolated DSH 0.2 web host:
   1. installs @deepseek-ai/dsh@<--dsh-version | DSH_QA_VERSION | 0.2.1-rc.2> into output/qa/dsh-cli[-<version>] when missing
      (or uses --dsh-bin / DSH_QA_BIN, the path of an installed lib/bin.js);
   2. creates a fresh DSH_HOME at output/qa/dsh-home with a profile made from
      the shipped `web` template, builds and packs this plugin and adds it;
   3. boots it with every *_API_KEY/*_TOKEN/*BASE_URL variable removed,
      SSH_TTY=audit (in-browser folder picker, never a native dialog), a local
      fake OpenAI-compatible model (scripts/qa/fake-openai.mjs) as the default
      model, and the default workspace under output/qa/dsh-documents;
   4. opens Study with Playwright, screenshots it, checks that 发给主会话 from the 复习全书 (seeded into the workspace's library) never overwrites what
      was typed into the chat's input box and never sends, chats in the standard preset and in 学习模式 (the same command,
      sandbox-leaving command and file turns in both: same tools, same approvals, same outcome), then stops everything.
   It never reads or writes ~/.dsh or the owner's Documents folder.
   Output: output/qa/dsh-e2e/*.png and summary.json. Not part of npm test. */
/* global document, window, getComputedStyle -- callbacks passed to page.evaluate / waitForFunction run in the browser */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { scrubSecrets, scrubProcessEnv } from "./env.mjs";
import { launchChromium } from "./browser.mjs";
import { createFakeOpenAI, FAKE_OPENAI_MODEL } from "./fake-openai.mjs";
import { handOffStep, pagePictureStep, seedHandOffBook } from "./dsh-hand-off.mjs";

// The host release the harness pins by default; `--dsh-version <x>` / DSH_QA_VERSION tests another release (see resolveDshVersion).
// StudyHub supports 0.2.0-rc.2 and 0.2.1-rc.2: run both before a release (`npm run qa:dsh -- --dsh-version 0.2.0-rc.2`).
export const DSH_VERSION = "0.2.1-rc.2";
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

/** The host release to test: --dsh-version, else DSH_QA_VERSION, else the pinned default. */
export function resolveDshVersion(value) {
  const version = String(value || process.env.DSH_QA_VERSION || DSH_VERSION).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--dsh-version must be a DSH release such as 0.2.1-rc.2, got ${version}`);
  return version;
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
  const dshVersion = resolveDshVersion(values["dsh-version"]);
  return { lang, port: Number(values.port ?? 3190), modelPort: Number(values["model-port"] ?? 4194),
    dshVersion,
    dshBin: values["dsh-bin"] || process.env.DSH_QA_BIN || "", reuseHome: !!values["reuse-home"],
    out: resolve(values.out ?? join(qaRoot, dshVersion === DSH_VERSION ? "dsh-e2e" : `dsh-e2e-${dshVersion}`)) };
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

export async function ensureDsh(options, env) {
  if (options.dshBin) return resolve(options.dshBin);
  const wanted = options.dshVersion || DSH_VERSION;
  // The pinned default keeps its folder; another release gets its own, so both can stay installed.
  const cli = join(qaRoot, wanted === DSH_VERSION ? "dsh-cli" : `dsh-cli-${wanted}`), manifest = join(cli, "node_modules/@deepseek-ai/dsh/package.json");
  const installed = await readFile(manifest, "utf8").then((text) => JSON.parse(text).version, () => "");
  if (installed !== wanted) {
    console.log(`Installing @deepseek-ai/dsh@${wanted} into ${cli} …`);
    await mkdir(cli, { recursive: true });
    if (!await exists(join(cli, "package.json"))) await writeFile(join(cli, "package.json"), JSON.stringify({ name: "studyhub-qa-dsh-cli", private: true }) + "\n");
    // --legacy-peer-deps=false: the host's boot package takes @deepseek-ai/cordis-plugin-group as a peer, which a user-level legacy-peer-deps=true would skip.
    npm(["install", `@deepseek-ai/dsh@${wanted}`, "--legacy-peer-deps=false", "--no-audit", "--no-fund"], { cwd: cli, env });
  }
  return join(cli, "node_modules/@deepseek-ai/dsh/lib/bin.js");
}

export function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

export async function bootDsh(bin, { env, cwd, patch, port }) {
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
    const wantedVersion = options.dshVersion || DSH_VERSION;
    summary.dshVersion = version;
    if (version !== wantedVersion) throw new Error(`DSH ${version} found; this run wants ${wantedVersion}`);
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
    // A 复习全书 in the workspace's library, for the 发给主会话 step below (seeded once; the documents folder outlives a run).
    summary.handOffBook = await step("seed-hand-off-book", () => seedHandOffBook(workspace, home));
    // "[[tool:<name>]]" in a message makes the fake model call that tool once (the preset-chat step)
    model = await createFakeOpenAI({ port: options.modelPort, toolCall: ({ prompt }) => { const match = /\[\[tool:(\w+)(?: (\{.*?\}))?\]\]/.exec(prompt); return match ? { name: match[1], arguments: match[2] ? JSON.parse(match[2]) : {} } : null; } });
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
        const clicked = await next.first().elementHandle();
        await clicked.click();
        // The host disables Continue while saving; wait for this step to leave before finding the next button.
        await page.waitForFunction((button) => !button.isConnected, clicked);
        await clicked.dispose();
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
      await page.locator('.settings-nav [data-category="generation"]').click();
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
      // an option other than the one shown (the default may be any of them)
      const other = popup.getByRole("option").filter({ hasNotText: before }).first();
      await other.click();
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
    // 发给主会话 never overwrites what the learner typed into the chat's input box and never sends (scripts/qa/dsh-hand-off.mjs).
    await step("hand-off-keeps-typed", async () => { summary.handOff = await handOffStep(page, { lang: options.lang, model, shot }); });
    await step("hand-off-page-picture", async () => { summary.pagePicture = await pagePictureStep(page, { lang: options.lang, model, shot }); });
    // A chat turn per agent preset: the standard preset (control) and the 学习模式 preset this plugin ships (presets/study.patch.yml). The turn goes through the
    // local fake model; the page must show its reply and no host error. A host that refuses the preset's prompt (an unknown {{variable}}, say) shows the error text.
    await step("preset-chat", async () => {
      const message = options.lang === "en" ? "Hello, what can you do?" : "你好，请简单介绍一下你能做什么";
      const presets = [{ key: "standard", pick: null }, { key: "study", pick: /学习模式|Study mode/ }];
      const failedRun = /本轮运行失败|Run failed|This run failed/, replyText = /^【StudyHub QA fake model】收到/;
      // leaf elements (no child element) whose text matches: the page repeats a text in containers, sidebar titles and the conversation
      const leaves = (re) => page.evaluate((source) => [...document.querySelectorAll("body *")].filter((element) => !element.children.length && new RegExp(source).test(element.textContent || "")).length, re.source);
      const leafParent = (re) => page.evaluate((source) => { const hit = [...document.querySelectorAll("body *")].find((element) => !element.children.length && new RegExp(source).test(element.textContent || "")); return hit ? (hit.parentElement?.innerText || hit.textContent) : ""; }, re.source);
      summary.presetChat = {};
      for (const { key, pick } of presets) {
        const result = summary.presetChat[key] = { reply: false, error: "" };
        const requestsBefore = model.log.length;
        await page.getByText(/^(新会话|New (chat|session))$/).first().click();
        const box = page.getByRole("textbox").last();
        await box.waitFor({ timeout: 30000 });
        if (pick) {
          // the preset picker is the button that names the current preset; the standard one is the default
          await page.getByRole("button", { name: /^(标准模式|Standard)/ }).first().click();
          // The roster as the picker shows it: DSH lists every preset a plugin registers (no hidden flag), so StudyHub's worker preset must come last.
          await sleep(500);
          summary.presetPicker = await page.evaluate(() => [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"]')]
            .filter((element) => element.getClientRects().length).map((element) => (element.innerText || element.textContent || "").trim().split(/\r?\n/)[0]).filter(Boolean));
          await shot("09-preset-picker");
          await page.getByText(pick).first().click();
          await sleep(500);
        }
        await shot(`09-chat-${key}-selected`);
        await box.click();
        await page.keyboard.type(message);
        const before = await leaves(replyText);
        await page.getByRole("button", { name: /^(发送消息|Send)/ }).click();
        // the fake model's echo ("【StudyHub QA fake model】收到：…") shows once in the conversation (and again as the session title); a host error shows its own text
        for (const end = Date.now() + 45000; Date.now() < end && !result.reply && !result.error; await sleep(400)) {
          if (await leaves(replyText) > before) result.reply = true;
          else result.error = await leafParent(failedRun);
        }
        if (!result.reply && !result.error) result.error = "no reply and no error text within 45 s";
        result.error = result.error.slice(0, 600);
        result.modelRequests = model.log.length - requestsBefore;
        // the persona the preset sent (study only), and the tools it offered: the request that carried the most of them
        result.personaSent = model.log.slice(requestsBefore).some((entry) => /StudyHub study tutor/.test(entry.systemText || ""));
        result.tools = (model.log.slice(requestsBefore).map((entry) => entry.tools).sort((a, b) => b.length - a.length)[0] || []).slice().sort();
        await shot(`10-chat-${key}-after`);
        if (key === "study" && result.reply && !result.error) {
          // more turns in the same session: the model calls a tool and the plugin's / the host's code runs inside the agent loop. study_capabilities is StudyHub's own tool
          // (registered on the host tools registry); subagent is the host's, started from the preset's delegation group (the child answers through the same fake model).
          const turns = [
            { name: "study_capabilities", text: "[[tool:study_capabilities]]", seen: /"contexts"/ },
            { name: "subagent", text: '[[tool:subagent {"description":"QA child","prompt":"Reply with one short sentence."}]]', seen: /started subagent/ },
            // the preset's "ask ONE short question" path: the host shows the question and waits for the learner's choice
            { name: "ask_user_question", text: '[[tool:ask_user_question {"questions":[{"id":"deck","question":"Which QA deck?","options":[{"label":"Deck Alpha"},{"label":"Deck Beta"}]}]}]]', seen: /Deck Alpha/,
              answer: async () => { await page.getByText("Which QA deck?", { exact: true }).waitFor({ timeout: 30000 }); await shot("11-chat-study-ask-question"); await page.getByText("Deck Alpha", { exact: true }).click(); await sleep(500);
                for (const name of [/^(提交|确认|Submit|Confirm|Send|发送)/]) { const button = page.getByRole("button", { name }).last(); if (await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) await button.click(); } } },
          ];
          result.toolTurns = {};
          for (const turn of turns) {
            const tool = result.toolTurns[turn.name] = { reply: false, called: false, resultSeen: false, pageTail: "" };
            const beforeTool = await leaves(replyText), requestsBeforeTool = model.log.length;
            await page.getByRole("textbox").last().click();
            await page.keyboard.type(turn.text);
            await page.getByRole("button", { name: /^(发送消息|Send)/ }).click();
            if (turn.answer) await turn.answer().catch((error) => { tool.answerError = String(error?.message || error).slice(0, 300); });
            for (const end = Date.now() + 45000; Date.now() < end && !tool.reply; await sleep(400)) if (await leaves(replyText) > beforeTool) tool.reply = true;
            const seen = model.log.slice(requestsBeforeTool);
            tool.called = seen.some((entry) => entry.toolCall === turn.name);
            tool.resultSeen = seen.some((entry) => turn.seen.test(entry.toolResult || ""));
            tool.modelRequests = seen.length;
            tool.pageTail = tool.reply ? "" : await page.evaluate(() => document.body.innerText.slice(-500));
            await shot(`11-chat-study-${turn.name}`);
          }
        }
        // The host's own command and file tools: the SAME three turns in both presets. 学习模式 composes the rows of the standard preset, so each turn must ask for
        // the same approval (DSH's permission preset decides that, not the agent preset) and end the same way. An approval card is accepted once and recorded.
        if (result.reply && !result.error) {
          const shellTool = process.platform === "win32" ? "pwsh" : "bash", probe = join(workspace, "studyhub-work", "qa-probe.txt"), content = `StudyHub QA probe (${key})`;
          const hostTurns = [
            { name: "shell", tool: shellTool, text: `[[tool:${shellTool} {"description":"Print the Node.js version","command":"node -v"}]]`,
              ran: async (seen) => /\bv\d+\.\d+\.\d+\b/.test(seen.map((entry) => entry.toolResult || "").join("\n")) },
            // the same command asking to leave the sandbox: the host must ask the learner first (accepted once here), in both presets alike
            { name: "shell-escalated", tool: shellTool, text: `[[tool:${shellTool} {"description":"Print the Node.js version","command":"node -v","sandbox_permissions":"danger-full-access","justification":"QA check outside the sandbox"}]]`,
              ran: async (seen) => /\bv\d+\.\d+\.\d+\b/.test(seen.map((entry) => entry.toolResult || "").join("\n")) },
            // a new file each time (the fs observation policy treats overwriting an unread file differently), in the session workspace
            { name: "file", tool: "write", text: `[[tool:write {"file_path":"studyhub-work/qa-probe.txt","content":"${content}"}]]`, before: () => rm(probe, { force: true }),
              ran: async () => (await readFile(probe, "utf8").catch(() => "")) === content },
          ];
          result.hostTurns = {};
          const allow = page.getByRole("button", { name: /^(允许一次|Allow once)$/ });
          for (const turn of hostTurns) {
            await turn.before?.();
            const outcome = result.hostTurns[turn.name] = { tool: turn.tool, offered: result.tools.includes(turn.tool), called: false, approval: false, approvalText: "", ran: false, reply: false };
            const beforeTool = await leaves(replyText), requestsBeforeTool = model.log.length;
            await page.getByRole("textbox").last().click();
            await page.keyboard.type(turn.text);
            await page.getByRole("button", { name: /^(发送消息|Send)/ }).click();
            for (const end = Date.now() + 60000; Date.now() < end && !outcome.reply; await sleep(400)) {
              if (await leaves(replyText) > beforeTool) outcome.reply = true;
              else if (await allow.first().isVisible().catch(() => false)) {
                outcome.approval = true;
                outcome.approvalText = await allow.first().evaluate((element) => { let node = element; while (node.parentElement && (node.parentElement.innerText || "").length < 300) node = node.parentElement; return (node.innerText || "").replace(/\s+/g, " ").slice(0, 300); });
                await shot(`12-chat-${key}-${turn.name}-approval`);
                await allow.first().click();
              }
            }
            const seen = model.log.slice(requestsBeforeTool);
            outcome.called = seen.some((entry) => entry.toolCall === turn.tool);
            outcome.toolResult = (seen.map((entry) => entry.toolResult).find(Boolean) || "").slice(0, 400);
            outcome.ran = await turn.ran(seen);
            await shot(`12-chat-${key}-${turn.name}`);
          }
        }
      }
      // The same tools as the standard preset: StudyHub's study_* tools are registered host-wide, so both lists carry them and must be equal.
      const study = summary.presetChat.study || {}, standard = summary.presetChat.standard || {};
      const studyOwn = (study.tools || []).filter((name) => /^study_/.test(name));
      summary.hostToolComparison = {
        tools: { studyOnly: (study.tools || []).filter((name) => !(standard.tools || []).includes(name)), standardOnly: (standard.tools || []).filter((name) => !(study.tools || []).includes(name)), studyTools: studyOwn },
        turns: Object.fromEntries(["shell", "shell-escalated", "file"].map((name) => [name, { study: study.hostTurns?.[name] && { approval: study.hostTurns[name].approval, ran: study.hostTurns[name].ran },
          standard: standard.hostTurns?.[name] && { approval: standard.hostTurns[name].approval, ran: standard.hostTurns[name].ran } }])),
      };
      const sameTools = JSON.stringify(study.tools || []) === JSON.stringify([...new Set([...(standard.tools || []), ...studyOwn])].sort());
      const problem = (key, value) => value.error || (!value.reply && "no reply") || (key === "study" && !value.personaSent && "the preset's persona never reached the model")
        || Object.entries(value.toolTurns || {}).map(([name, turn]) => !(turn.called && turn.resultSeen && turn.reply) && `the ${name} tool turn did not complete: ${JSON.stringify(turn)}`).find(Boolean);
      const workerAt = (summary.presetPicker || []).findIndex((text) => /StudyHub 后台|StudyHub background/.test(text));
      if (workerAt < 0) throw new Error(`the worker preset is missing from the picker: ${JSON.stringify(summary.presetPicker || [])}`);
      if (workerAt !== summary.presetPicker.length - 1) throw new Error(`the worker preset is not last in the picker: ${JSON.stringify(summary.presetPicker)}`);
      const bad = Object.entries(summary.presetChat).map(([key, value]) => [key, problem(key, value)]).filter(([, text]) => text);
      if (!sameTools || studyOwn.length < 7) bad.push(["tools", `学习模式 is not offered the standard tools plus StudyHub's: ${JSON.stringify(summary.hostToolComparison.tools)}`]);
      for (const [name, { study: a, standard: b }] of Object.entries(summary.hostToolComparison.turns)) {
        for (const [key, value] of [["study", study], ["standard", standard]])
          if (!value.hostTurns?.[name]?.called || !value.hostTurns[name].reply) bad.push([key, `the ${name} turn did not complete: ${JSON.stringify(value.hostTurns?.[name] || null)}`]);
        if (JSON.stringify(a) !== JSON.stringify(b)) bad.push([name, `学习模式 ${JSON.stringify(a)} differs from standard ${JSON.stringify(b)}`]);
      }
      if (bad.length) throw new Error(bad.map(([key, text]) => `${key}: ${text}`).join(" | "));
    });
    // StudyHub's own background child (lib/subagent-api.js): the AI helper on a card of the sample library, asked twice on the same card, first from the live study
    // session and then, after a host restart, from a cold panel (a conversation the host has not loaded: lib/host-capabilities.js starts the child under a fresh
    // idle coordinator there). The host must run each as a DSH sub-agent with NO tools (DSH 0.2.0: toolFilter; 0.2.1: the study-worker preset plus the mask on the
    // exact child); its JSON must come back to StudyHub and be saved on the card; the child's session must hold the host's token usage and timing. On DSH 0.2.1 a
    // settled child is torn down by the host, so a second ask must start a NEW child rather than continue the old one.
    const rpc = (method, payload) => page.evaluate(async ({ method: name, payload: body }) => {
      const response = await fetch(`/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: name, payload: body }) });
      return (await response.json()).result;
    }, { method, payload });
    const host021 = !(options.dshVersion || DSH_VERSION).startsWith("0.2.0");
    // DSH 0.2.0 composes the child from its parent's preset, and its toolFilter cannot hide a preset-scoped tool: the 学习模式 parent's `subagent` stays visible
    // there (as in every StudyHub release on 0.2.0). DSH 0.2.1 starts the child in the study-worker preset, so it must see no tool at all.
    const known = host021 ? [] : ["subagent"];
    const askTwice = async (sessionId, label) => {
      const call = async (action, args = {}) => { const result = await rpc("study-workspace/call", { sessionId, action, args }); if (!result.ok) throw new Error(`${action}: ${result.error?.message || "refused"}`); return result.value; };
      const query = options.lang === "en" ? "snapshot" : "快照";
      let [card] = (await call("card.search", { query, limit: 1 })).results;
      if (!card) { await call("sample.load", { language: options.lang }); [card] = (await call("card.search", { query, limit: 1 })).results; }
      if (!card) throw new Error("the sample library has no card to ask about");
      const followups = async () => ((await call("card.locate", { deckId: card.deckId, cardId: card.cardId })).card.followups || []).length;
      const asks = [];
      // a question of its own per run: the sample library outlives a run (output/qa/dsh-documents) and a card keeps one answer per question
      const stamp = `${label} ${Date.now().toString(36)}`;
      for (const text of (options.lang === "en" ? ["Why is that the answer?", "Give me one more example."] : ["为什么是这个答案？", "再举一个例子。"]).map((question) => `${question} (QA ${stamp})`)) {
        const requestsBefore = model.log.length, savedBefore = await followups();
        const started = await call("assist.start", { deckId: card.deckId, cardId: card.cardId, mode: "ask", text });
        const ask = { runtime: started.runtime, status: started.status, workerRequests: 0, toolsOffered: null, workerPersona: false };
        let task = started;
        for (const end = Date.now() + 90000; Date.now() < end && task.status === "running"; await sleep(500))
          task = ((await call("snapshot")).assist || []).find((item) => item.id === started.id) || task;
        const saved = await followups() - savedBefore;
        Object.assign(ask, { status: task.status, message: task.message || "", childId: task.childId || null, reused: task.reused ?? null, saved });
        const worker = model.log.slice(requestsBefore).filter((entry) => entry.handled);
        ask.workerRequests = worker.length;
        ask.toolsOffered = [...new Set(worker.flatMap((entry) => entry.tools))].sort();
        ask.workerPersona = worker.some((entry) => /StudyHub background worker/.test(entry.systemText || ""));
        // The host's own record of the child's session: its token usage and the timing its 会话统计 shows (TTFT, decode speed).
        if (ask.childId) {
          const projected = await rpc("session/projections", { args: { request: { sessionId: ask.childId } } }).catch((error) => ({ error: String(error) }));
          const values = projected?.value?.values || projected?.values || {};
          ask.hostUsage = values.tokenUsage ?? null;
          ask.hostStats = values.sessionStats ? { steps: values.sessionStats.steps, ttftSteps: values.sessionStats.ttftSteps, ttftMs: values.sessionStats.ttftMs,
            decodeTokens: values.sessionStats.decodeTokens, decodeMs: values.sessionStats.decodeMs } : null;
          ask.projectionKind = projected?.value?.kind ?? projected?.kind ?? null;
          if (!ask.hostUsage && !ask.hostStats) ask.projectionRaw = JSON.stringify(projected).slice(0, 600);
        }
        ask.knownHostLeak = (ask.toolsOffered || []).filter((name) => known.includes(name));
        asks.push(ask);
      }
      const problems = [];
      asks.forEach((ask, index) => {
        const which = `${label} ask ${index + 1}`;
        const offered = (ask.toolsOffered || []).filter((name) => !known.includes(name));
        const usage = ask.hostUsage, counted = usage && ["uncachedInputTokens", "outputTokens"].some((key) => Number(usage[key]) > 0);
        problems.push(ask.runtime !== "subagent" && `${which}: the helper ran as ${ask.runtime}, not as a DSH sub-agent`,
          ask.status !== "done" && `${which}: the task ended ${ask.status} (${ask.message})`,
          ask.saved !== 1 && `${which}: ${ask.saved} answers saved on the card, not 1`,
          !ask.childId && `${which}: the task names no child`,
          // a reused child answers through followup(): the request carries the same tools and persona as its first turn
          !ask.workerRequests && `${which}: the child never reached the model`,
          !ask.workerPersona && host021 && `${which}: the worker persona never reached the model`,
          offered.length && `${which}: the child was offered tools: ${offered.join(", ")}`,
          !counted && `${which}: the host recorded no token usage for the child (${JSON.stringify(usage)})`,
          !(ask.hostStats?.ttftSteps > 0) && `${which}: the host recorded no time to first token for the child`);
      });
      // DSH 0.2.1 tears a settled child down, so the second ask must not continue it (the cold-panel case is the one that used to).
      if (host021 && asks[1] && (asks[1].reused || asks[1].childId === asks[0].childId)) problems.push(`${label}: the second ask continued the settled child ${asks[0].childId}`);
      return { asks, problems: problems.filter(Boolean) };
    };
    await step("studyhub-child", async () => {
      const items = (await rpc("session/list", { args: { _request: {} } })).value.items;
      const live = summary.studyChild = await askTwice(items[0]?.sessionId, "live");
      if (live.problems.length) throw new Error(live.problems.join(" | "));
    });
    // A cold panel: restart the host, then ask from a conversation the restarted host has not loaded (session/list marks it `cached`, not `sequenced`).
    await step("studyhub-child-cold", async () => {
      // leave the page first, so the stopped host does not show up as the page's connection errors
      await page.goto("about:blank");
      stopTree(dsh.child);
      await new Promise((done) => { if (dsh.child.exitCode !== null) done(); else { dsh.child.once("exit", done); setTimeout(done, 15000); } });
      await writeFile(join(options.out, "dsh-first-boot.log"), dsh.output().replace(/token=\S+/g, "token=…"));
      dsh = await bootDsh(bin, { env: { ...baseEnv, [FAKE_KEY_ENV]: "not-a-real-key" }, cwd: workspace, patch, port: options.port });
      await page.goto(dsh.url, { waitUntil: "networkidle" });
      await sleep(1500);
      const items = (await rpc("session/list", { args: { _request: {} } })).value.items;
      const cold = items.filter((item) => item.projections?.kind === "cached");
      const sessionId = cold.at(-1)?.sessionId;
      summary.studyChildCold = { sessions: items.map((item) => ({ sessionId: item.sessionId, kind: item.projections?.kind ?? null })), sessionId: sessionId ?? null };
      if (!sessionId) throw new Error(`no cold conversation after the restart: ${JSON.stringify(summary.studyChildCold.sessions)}`);
      const result = await askTwice(sessionId, "cold");
      Object.assign(summary.studyChildCold, result);
      const after = (await rpc("session/list", { args: { _request: {} } })).value.items.find((item) => item.sessionId === sessionId);
      summary.studyChildCold.kindAfter = after?.projections?.kind ?? null;
      if (result.problems.length) throw new Error(result.problems.join(" | "));
      // both asks must have run from the cold panel: if one loaded the conversation, the second took the live path and the cold reuse guard proved nothing
      if (summary.studyChildCold.kindAfter !== "cached") throw new Error(`the cold conversation was loaded during the asks (kind ${summary.studyChildCold.kindAfter})`);
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
