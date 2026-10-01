/* node scripts/qa/wp27-usage.mjs [--out <dir>] [--combos zh:dark:1440,zh:dark:420]
   WP27 screenshots: the 创建题组 summary with its token estimate and info panel,
   a finished job's actual usage next to its estimate, and 学习统计 › 模型用量.
   The model is the local fake model with `usage: true`, which reports token
   usage the way a provider does; nothing leaves this machine and secrets are
   scrubbed from the environment first. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel, FAKE_MODEL_ROUTE } from "../fake-model.mjs";
import { StudyService } from "../../lib/service.js";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(arg("out", join(repoRoot, "output/qa/wp27")));
const combos = arg("combos", "zh:dark:1440,zh:dark:420").split(",").map((c) => c.split(":"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const PARAGRAPH = "Microservices split a system into independently deployable services that own their data. Event-driven architecture lets services react to events published by others, which decouples producers from consumers. The strangler fig pattern migrates a monolith incrementally by routing features to new services one at a time. ";
const page = (n) => ({ id: `handbook-p${n}`, title: `Cloud Native Handbook.pdf · p.${n}`, text: `Page ${n}. ${PARAGRAPH.repeat(10)}`,
  document: { id: "h".repeat(64), format: "pdf", page: n, pages: 30 }, courses: ["Cloud Native"] });

async function seed(root) {
  const service = new StudyService(root, {});
  await service.store.update((state) => { for (let n = 1; n <= 30; n++) state.sources.push(page(n)); });
  return service;
}

async function run() {
  const removed = scrubProcessEnv();
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const root = join(out, "work", "library");
  const service = await seed(root);
  const complete = createFakeModel({ latencyMs: 0, generationLatencyMs: 250, usage: true });
  const server = await createPreviewServer({ libraryRoot: root, home: join(out, "work", "home"), port: Number(process.env.PORT || 4420),
    model: { complete, route: FAKE_MODEL_ROUTE } });
  const browser = await launchChromium();
  const summary = { url: server.url, scrubbedEnv: removed, combos: [], pageErrors: [], consoleErrors: [] };
  try {
    for (const [lang, theme, widthText] of combos) {
      const width = Number(widthText), tag = `${lang}-${theme}-${width}`;
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
      const view = await context.newPage();
      view.on("pageerror", (error) => summary.pageErrors.push({ tag, text: String(error?.stack || error) }));
      view.on("console", (m) => { if (m.type() === "error") summary.consoleErrors.push({ tag, text: m.text() }); });
      const shot = (name, target = view, options = {}) => target.screenshot({ path: join(out, `${tag}-${name}.png`), ...options });
      const record = { tag };
      await view.goto(server.url);
      await view.locator("aside, nav").first().waitFor({ timeout: 30000 });
      const go = (label) => view.locator("nav button", { hasText: label }).first().click();
      await go(lang === "en" ? "Create questions" : "创建题组");
      await view.locator(".generate-summary").waitFor({ timeout: 20000 });
      await view.locator(".generate-submit .token-estimate__line").waitFor({ timeout: 20000 });
      record.estimateLine = await view.locator(".generate-submit .token-estimate__line").first().innerText();
      await view.locator(".generate-submit").scrollIntoViewIfNeeded();
      await shot("1-generate-estimate", view.locator(".generate-submit"));
      await view.locator(".generate-submit .token-estimate__info").first().click();
      await view.locator(".generate-submit .token-estimate__panel").first().waitFor({ timeout: 5000 });
      await view.locator(".generate-submit .token-estimate__panel").first().scrollIntoViewIfNeeded();
      record.panel = await view.locator(".generate-submit .token-estimate__panel").first().innerText();
      await shot("2-generate-estimate-panel", view.locator(".generate-submit"));
      await view.locator('[data-tour="generate-submit"]').click();
      // The learning library shows the job; wait for it to finish and carry its usage.
      await view.locator("[data-job-usage] [data-token-usage]").first().waitFor({ timeout: 60000 }).catch(() => {});
      await view.locator("details.generation-trace > summary").first().click().catch(() => {});
      await sleep(400);
      const trace = view.locator("details.generation-trace").first();
      if (await trace.count()) {
        record.job = await trace.innerText();
        await view.locator("[data-job-usage]").first().scrollIntoViewIfNeeded();
        await shot("3-job-usage", view);
      }
      await go(lang === "en" ? "Stats" : "统计");
      await view.locator("[data-model-usage] .model-usage__list").waitFor({ timeout: 20000 }).catch(() => {});
      await sleep(500);
      const usage = view.locator("[data-model-usage]");
      if (await usage.count()) {
        record.stats = await usage.innerText();
        await usage.scrollIntoViewIfNeeded();
        await shot("4-stats-usage", usage);
      }
      await shot("5-stats-page", view, { fullPage: true });
      summary.combos.push(record);
      await context.close();
    }
    summary.ledger = await previewCall(server, "usage.summary", { days: 30 });
  } finally {
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close().catch(() => {});
    await server.close();
    service.dispose();
  }
  console.log(JSON.stringify({ combos: summary.combos.length, pageErrors: summary.pageErrors.length, consoleErrors: summary.consoleErrors.length, total: summary.ledger?.total }));
  if (summary.pageErrors.length) process.exitCode = 1;
}
await run();
