/* npm run qa:journey [-- --lang zh|en --theme dark|light --width 1440|420
                          --steps a,b,c --out <dir> --keep]
   A new learner's core loop in the browser preview, one screenshot set per
   step: empty library → add material → import files → sources → generate →
   job progress → draft → publish → practice → mistakes → settings.

   Runs the real preview server (scripts/preview-server.mjs) with the fake
   model on a fresh temporary library, in Chromium, with every key/token/
   base-url variable removed from the environment. Writes <out>/summary.json
   (steps, console errors, page errors, failed API calls) and exits non-zero
   when a step fails or the page throws.

   Add a step: append one { name, needs?, run } entry to JOURNEY_STEPS.
   `needs` lists state the step requires (material, draft, deck, answers);
   when a step runs without the earlier steps, that state is created through
   the API first. Find elements by data-tour anchors first (plan §4 C7), then
   by their Chinese UI text through j.t(), which follows the UI language. */
/* global document, getComputedStyle, innerHeight -- page.evaluate callbacks run in the browser */
import { mkdir, rm, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { sampleMaterial, sampleMarkdown, samplePdfHtml } from "./fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---------- steps ---------- */

export const JOURNEY_STEPS = [
  { name: "empty-home", run: async (j) => {
    await j.nav("library");
    await j.shot();
  } },
  { name: "add-material", run: async (j) => {
    await j.openAddSource();
    await j.shot("dialog");
    // The add-material dialog (ImportHub) opens on files; pasting is its second tab.
    await j.clickIfPresent(j.dialog().getByRole("button", { name: j.t("粘贴文本"), exact: true }));
    const material = sampleMaterial(j.lang);
    await j.dialog().getByLabel(j.t("资料名称")).first().fill(material.title);
    await j.dialog().getByLabel(j.t("原文")).first().fill(material.text);
    await j.shot("filled");
    await j.dialog().getByRole("button", { name: j.t("保存资料") }).click();
    await j.until(async () => (await j.snapshot()).sources.some((source) => source.title === material.title), "the pasted source is saved");
    await j.settle();
    await j.shot("saved");
  } },
  { name: "import-files", run: async (j) => {
    await j.openAddSource();
    // One drop zone takes several files at once; the dialog closes when all are in.
    const files = [j.fixtures.markdown, j.fixtures.pdf];
    const input = j.dialog().locator('[data-tour="import-drop"] input[type="file"], input[type="file"][accept*=".pdf"]').first();
    await input.setInputFiles(files);
    const stems = files.map((file) => basename(file).replace(/\.[^.]+$/, ""));
    await j.until(async () => {
      const sources = (await j.snapshot()).sources;
      return stems.every((stem) => sources.some((source) => source.title.includes(stem)));
    }, `${files.map((file) => basename(file)).join(" and ")} are imported`);
    await j.until(async () => !(await j.page.locator("dialog[open]").count()), "the dialog closes after the import");
    await j.settle();
    await j.shot("imported");
  } },
  { name: "sources", needs: ["material"], run: async (j) => {
    await j.nav("sources");
    // Show the newest group's rows (groups start collapsed).
    if (!await j.clickIfPresent(j.page.getByRole("button", { name: j.t("全部展开") })))
      await j.clickIfPresent(j.page.locator('.source-group-head[aria-expanded="false"]'));
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  { name: "generate", needs: ["material"], run: async (j) => {
    await j.nav("generate");
    await j.clickIfPresent(j.anchor("generate-from-sources").or(j.page.getByRole("tab", { name: j.t("从资料补题") })));
    await j.clickIfPresent(j.page.getByRole("button", { name: j.t("选择当前范围") }));
    await j.page.getByRole("button", { name: j.t("单选测验"), exact: true }).click();
    await j.page.getByLabel(j.t("题数")).fill("4");
    await j.page.getByLabel(j.t("题组名称（可选）")).fill(j.lang === "en" ? "QA journey deck" : "QA 旅程题组");
    await j.shot("form", { fullPage: true });
    const before = (await j.snapshot()).jobs.length;
    await j.anchor("generate-submit").or(j.page.getByRole("button", { name: new RegExp(`^(${escapeRe(j.t("生成并检查题组 →"))}|${escapeRe(j.t("加入生成队列 →"))})`) })).first().click();
    await j.until(async () => (await j.snapshot()).jobs.length > before, "a generation job starts");
    j.state.jobId = (await j.snapshot()).jobs.at(-1).id;
  } },
  { name: "job-progress", needs: ["job"], run: async (j) => {
    const job = j.page.locator(".generation-jobs .job").first();
    await job.waitFor({ timeout: 15000 });
    await j.settle(200);
    await job.scrollIntoViewIfNeeded();
    await j.shot("running");
    const done = await j.api("job.wait", { jobId: j.state.jobId, timeoutSeconds: 60 });
    if (done.status !== "complete") throw new Error(`generation ended as ${done.status}: ${done.stage}`);
    j.state.draftId = done.draft?.id;
    await j.page.getByRole("button", { name: j.t("打开"), exact: true }).first().waitFor({ timeout: 15000 });
    await j.page.locator(".generation-jobs .job").first().scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("done");
  } },
  { name: "draft", needs: ["draft"], run: async (j) => {
    const open = j.page.locator(".draft-row .draft-open").first();
    if (!await open.count()) await j.nav("library");
    await j.page.locator(".draft-row .draft-open").first().click();
    await j.page.getByRole("button", { name: j.t("保存并发布 →") }).first().waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  { name: "publish", needs: ["draft"], run: async (j) => {
    if (!await j.page.getByRole("button", { name: j.t("保存并发布 →") }).count()) {
      await j.nav("library");
      await j.page.locator(".draft-row .draft-open").first().click();
    }
    const before = (await j.snapshot()).decks.length;
    await j.page.getByRole("button", { name: j.t("保存并发布 →") }).first().click();
    await j.until(async () => (await j.snapshot()).decks.length > before, "the deck is published");
    await j.settle(1500);
    await j.shot();
  } },
  { name: "practice", needs: ["deck"], run: async (j) => {
    if (!await j.page.locator(".options .option").count()) {
      await j.page.getByRole("button", { name: j.t("回到题目") }).first().click();
      await j.page.locator(".options .option").first().waitFor({ timeout: 15000 });
    }
    // The first answer is wrong (it feeds the mistakes page), the second right.
    for (const [index, wantCorrect] of [[1, false], [2, true]]) {
      const run = (await j.snapshot()).runs.at(-1);
      const { card } = await j.api("review.get", { runId: run.id });
      const live = (await j.api("deck.get", { id: card.deckId || run.deckId })).cards.find((item) => item.id === card.id);
      const option = live.options.find((item) => item.correct === wantCorrect) || live.options[0];
      await j.page.locator(".options .option", { hasText: option.text }).first().click();
      const submit = j.page.getByRole("button", { name: j.t("提交答案") });
      if (await submit.count() && await submit.first().isEnabled()) await submit.first().click();
      await j.page.locator(".options .option.correct").first().waitFor({ timeout: 15000 });
      await j.settle();
      await j.shot(`answer-${index}`);
      if (index < 2) {
        await j.page.getByRole("button", { name: new RegExp(escapeRe(j.t("下一题"))) }).first().click();
        await j.page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 });
      }
    }
  } },
  { name: "wrongbook", needs: ["answers"], run: async (j) => {
    await j.nav("wrongbook");
    await j.settle();
    await j.shot();
  } },
  { name: "settings", run: async (j) => {
    await j.nav("settings");
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
];

/* ---------- state a step can require, created through the API ---------- */

const SEED = {
  async material(j) {
    if ((await j.snapshot()).sources.length) return;
    await j.api("source.add", sampleMaterial(j.lang));
  },
  async job(j) {
    if (j.state.jobId) return;
    await SEED.material(j);
    const sourceIds = (await j.snapshot()).sources.map((source) => source.id);
    j.state.jobId = (await j.api("generate", { sourceIds, count: 4, kind: "quiz", title: "QA seed", language: j.lang === "en" ? "English" : "中文" })).jobId;
    await j.nav("library");
  },
  async draft(j) {
    if ((await j.snapshot()).drafts.length) return;
    await SEED.job(j);
    await j.api("job.wait", { jobId: j.state.jobId, timeoutSeconds: 60 });
    await j.reload();
  },
  async deck(j) {
    if ((await j.snapshot()).decks.some((deck) => !deck.systemKind)) return;
    await SEED.draft(j);
    const draft = (await j.snapshot()).drafts[0];
    await j.api("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
    await j.reload();
  },
  async answers(j) {
    if ((await j.snapshot()).attempts.length) return;
    await SEED.deck(j);
    const deck = (await j.snapshot()).decks.find((item) => !item.systemKind);
    const run = await j.api("review.start", { deckId: deck.id, mode: "quiz" });
    const live = (await j.api("deck.get", { id: deck.id })).cards.find((item) => item.id === run.card.id);
    const wrong = live.options?.find((option) => !option.correct);
    await j.api("review.answer", { runId: run.id, cardId: run.card.id, ...(wrong ? { selected: [wrong.id] } : { grade: 1 }) });
    await j.reload();
  },
};

/* ---------- options ---------- */

export function parseJourneyArgs(argv = []) {
  const names = JOURNEY_STEPS.map((step) => step.name);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    const [, key, inline] = match;
    if (key === "keep") { values.keep = true; continue; }
    values[key] = inline ?? argv[++i];
  }
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440);
  if (!["zh", "en"].includes(lang)) throw new Error("--lang must be zh or en");
  if (!["dark", "light"].includes(theme)) throw new Error("--theme must be dark or light");
  if (!Number.isInteger(width) || width < 320 || width > 3840) throw new Error("--width must be a pixel width such as 1440 or 420");
  const steps = values.steps ? values.steps.split(",").map((name) => name.trim()).filter(Boolean) : names;
  for (const name of steps) if (!names.includes(name)) throw new Error(`Unknown step "${name}". Steps: ${names.join(", ")}`);
  const port = Number(values.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number (0 picks a free one)");
  return { lang, theme, width, height: Number(values.height ?? 900), steps,
    out: values.out ? resolve(values.out) : resolve(repoRoot, `output/qa/journey/${lang}-${theme}-${width}`), keep: !!values.keep, port };
}

/** English UI strings, keyed by their Chinese source (ui/locales/en.json and en.*.json fragments). */
async function englishStrings() {
  const dir = resolve(repoRoot, "ui/locales");
  const files = (await readdir(dir)).filter((name) => /^en(\..+)?\.json$/.test(name)).sort();
  return Object.assign({}, ...await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")))));
}

async function writeFixtures(browser, lang, dir) {
  await mkdir(dir, { recursive: true });
  const markdown = sampleMarkdown(lang);
  const files = { markdown: join(dir, markdown.name), pdf: join(dir, lang === "en" ? "qa-database-indexes.pdf" : "qa-数据库索引.pdf") };
  await writeFile(files.markdown, markdown.text, "utf8");
  const page = await browser.newPage();
  await page.setContent(samplePdfHtml(lang), { waitUntil: "load" });
  await page.pdf({ path: files.pdf, format: "A5", printBackground: true });
  await page.close();
  return files;
}

/* ---------- runner ---------- */

export async function runJourney(options) {
  const removed = scrubProcessEnv();
  await access(resolve(repoRoot, "dist/app.js")).catch(() => { throw new Error("dist/app.js is missing: run `npm run build` first"); });
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const english = options.lang === "en" ? await englishStrings() : {};
  const server = await createPreviewServer({ libraryRoot: join(options.out, "work", "library"), home: join(options.out, "work", "home"),
    port: options.port ?? 0, model: createFakeModel({ latencyMs: 250, generationLatencyMs: 2500 }) });
  // Native controls (file pickers) follow the browser's own language, not the page's.
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { startedAt: new Date().toISOString(), options: { ...options }, url: server.url, scrubbedEnv: removed,
    steps: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  try {
    const fixtures = await writeFixtures(browser, options.lang, join(repoRoot, "output/qa/fixtures", options.lang));
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
      locale: options.lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme });
    await context.addInitScript(([lang, theme]) => {
      try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme); } catch { /* storage blocked */ }
    }, [options.lang, options.theme]);
    const page = await context.newPage();
    let current = "boot";
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push({ step: current, text: message.text() }); });
    page.on("pageerror", (error) => summary.pageErrors.push({ step: current, text: String(error?.stack || error) }));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      let action = "";
      try { action = JSON.parse(response.request().postData() || "{}").action; } catch { /* not JSON */ }
      const body = await response.json().catch(() => ({}));
      summary.apiErrors.push({ step: current, action, status: response.status(), error: body.error || "" });
    });
    const j = journeyContext({ page, server, options, english, fixtures, step: () => current });
    await page.goto(server.url);
    await j.ready();
    for (const step of JOURNEY_STEPS.filter((item) => options.steps.includes(item.name))) {
      current = step.name;
      const started = Date.now(), record = { name: step.name, status: "ok", shots: [] };
      j.record = record;
      try {
        for (const need of step.needs || []) await SEED[need](j);
        await step.run(j);
      } catch (error) {
        record.status = "failed";
        record.error = String(error?.message || error).split("\n")[0];
        await j.shot("failed").catch(() => {});
      }
      record.ms = Date.now() - started;
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${step.name}${record.error ? ` — ${record.error}` : ""}`);
    }
    if (options.keep) {
      console.log(`Preview kept running at ${server.url} (library ${server.libraryRoot}); press Ctrl+C to stop.`);
      await new Promise((done) => process.once("SIGINT", done));
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.pageErrors.length && summary.steps.every((step) => step.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

function journeyContext({ page, server, options, english, fixtures, step }) {
  const index = () => String(JOURNEY_STEPS.findIndex((item) => item.name === step()) + 1).padStart(2, "0");
  const t = (zh) => options.lang === "en" && Object.hasOwn(english, zh) ? english[zh] : zh;
  const NAV = { library: "学习库", sources: "资料", generate: "创建题组", wrongbook: "错题与待巩固", exam: "模拟考试",
    dashboard: "统计", skeleton: "知识骨架", workflows: "学习流", settings: "设置" };
  const j = {
    page, server, fixtures, lang: options.lang, state: {}, record: null, t,
    api: (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang }),
    snapshot: () => previewCall(server, "snapshot", { uiLanguage: options.lang }),
    anchor: (id) => page.locator(`[data-tour="${id}"]`),
    dialog: () => page.locator("dialog[open], [role=dialog], .modal").last(),
    async ready() {
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await j.settle(800);
    },
    async reload() { await page.reload(); await j.ready(); },
    /** Let requests, renders and page transitions finish before a screenshot. */
    async settle(ms = 600) {
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" ||
        animation.effect?.getTiming?.().iterations === Infinity), null, { timeout: 4000 }).catch(() => {});
      await sleep(ms);
    },
    async until(check, label, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await sleep(250);
      }
    },
    async clickIfPresent(locator) {
      if (await locator.count() && await locator.first().isVisible()) { await locator.first().click(); await j.settle(300); return true; }
      return false;
    },
    async nav(id) {
      const anchor = j.anchor(`nav-${id}`);
      if (await anchor.count()) await anchor.first().click();
      else if (id === "settings") await page.getByRole("button", { name: t(NAV.settings), exact: true }).first().click();
      else await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${escapeRe(t(NAV[id]))}`) }).first().click();
      await j.settle();
    },
    async openAddSource() {
      await j.nav("sources");
      const add = j.anchor("sources-add").or(page.getByRole("button", { name: t("＋ 添加资料") }));
      if (await add.count() && await add.first().isVisible()) await add.first().click();
      await j.settle(400);
    },
    async closeDialog() {
      if (!await page.locator("dialog[open], [role=dialog], .modal").count()) return;
      await page.keyboard.press("Escape");
      await sleep(300);
      await j.clickIfPresent(page.getByRole("button", { name: t("关闭"), exact: true }));
    },
    /** Viewport screenshot; fullPage grows the viewport to the scrolling panel's full length first. */
    async shot(suffix = "", { fullPage = false } = {}) {
      const name = `${index()}-${step()}${suffix ? `-${suffix}` : ""}.png`;
      const viewport = page.viewportSize();
      if (fullPage) {
        // The app scrolls inside a 100%-high panel, so Playwright's fullPage sees one screen.
        const height = await page.evaluate(() => {
          let tallest = document.documentElement.scrollHeight;
          for (const element of document.querySelectorAll("main, main *, .study-app, [class*=scroll]")) {
            const overflow = getComputedStyle(element).overflowY;
            if (/auto|scroll/.test(overflow) && element.scrollHeight > element.clientHeight + 4 && element.clientHeight > innerHeight / 2)
              tallest = Math.max(tallest, element.scrollHeight + innerHeight - element.clientHeight);
          }
          return tallest;
        });
        await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 9000) });
        await j.settle(400);
      }
      try { await page.screenshot({ path: join(options.out, name) }); }
      finally { if (fullPage) { await page.setViewportSize(viewport); await sleep(200); } }
      j.record?.shots.push(name);
      return name;
    },
  };
  return j;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseJourneyArgs(process.argv.slice(2));
    const summary = await runJourney(options);
    console.log(`${summary.ok ? "Journey passed" : "Journey FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
