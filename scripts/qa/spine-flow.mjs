/* The 本次脉络 panel inside the real learning flow (WorkflowPortal) on an isolated temporary library (one course, six topics, no
   skeleton yet), fake model, no network:
     node scripts/qa/spine-flow.mjs [--out output/qa/spine-flow] [--combos zh:dark:1440,en:light:420,...]
   Starts a flow on the demo library, has the fake model draft the skeleton in the background (the fake draws one station per
   topic, each with up to four points), then screenshots the portal folded, opened, on another station, and with the overview.
   Secrets are scrubbed from the environment first; nothing leaves this machine. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { StudyService } from "../../lib/service.js";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const out = resolve(repoRoot, flag("out", arg("out", "output/qa/spine-flow")));
const combos = flag("combos", "zh:dark:1440,en:light:1194,zh:light:768,en:dark:420").split(",").map((c) => c.split(":"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TOPICS = ["领域驱动的服务边界", "服务间通信", "服务发现与负载均衡", "数据访问与读写分离", "故障隔离与熔断", "可观测性与链路追踪"];
const COURSE = "Microservices";

async function seed(root) {
  const service = new StudyService(root, {});
  await service.store.update((s) => {
    s.decks.push({ id: "ms1", title: `${COURSE} / 01 边界与通信`, course: COURSE, folder: "",
      cards: TOPICS.flatMap((topic, t) => Array.from({ length: 4 }, (_, k) => ({ id: `c${t}-${k}`, topic, kind: "flashcard", objective: `理解${topic}${k + 1}`,
        prompt: `${topic}：第 ${k + 1} 个要点是什么？`, answer: `${topic}的要点 ${k + 1}：先看边界，再看通信方式与失败时的退路。`, hint: "想想它解决的问题", misconception: "常见误区", citations: [],
        explanation: `${topic}要点 ${k + 1} 说明了职责边界与取舍：每个服务拥有自己的数据，调用失败时要有超时和降级。` }))) });
  });
  await service.call("focus.set", { course: COURSE });
}

scrubProcessEnv();
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await seed(join(out, "work", "library"));
const server = await createPreviewServer({ libraryRoot: join(out, "work", "library"), home: join(out, "work", "home"), port: Number(process.env.PORT || 4341), model: createFakeModel({ latencyMs: 80, generationLatencyMs: 200 }) });
const browser = await launchChromium();
const summary = { url: server.url, combos: [], errors: [] };
try {
  for (const [lang, theme, widthText] of combos) {
    const width = Number(widthText), tag = `${lang}-${theme}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
    await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
    const page = await context.newPage();
    page.on("pageerror", (error) => summary.errors.push({ tag, text: String(error) }));
    page.on("console", (m) => { if (m.type() === "error") summary.errors.push({ tag, text: m.text() }); });
    const shot = (name, options = {}) => page.screenshot({ path: join(out, `${tag}-${name}.png`), ...options });
    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: lang === "en" ? "Learning flow" : "学习流", exact: true }).first().click();
    await page.getByLabel(lang === "en" ? "What would you like to learn?" : "想学什么").fill(lang === "en" ? "understand the core ideas" : "弄懂核心概念");
    await page.getByRole("button", { name: lang === "en" ? "Start learning →" : "开始学 →" }).click();
    await page.locator(".wf-heading").waitFor({ timeout: 20000 });
    const record = { tag };
    if (!(await page.locator(".spine").count())) {
      const { sessions } = await previewCall(server, "workflow.list", {});
      const id = sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
      await previewCall(server, "workflow.skeleton.generate", { id }).catch((error) => { record.generate = String(error.message); });
      for (let i = 0; i < 40 && !(await page.locator(".spine").count()); i += 1) { await sleep(500); if (i === 6) await page.reload(); }
    }
    await page.locator(".spine").first().waitFor({ timeout: 20000 }).catch(() => { record.noSpine = true; });
    await sleep(500);
    const box = async (selector) => page.locator(selector).first().boundingBox().catch(() => null);
    record.folded = await box(".spine");
    await shot("1-folded");
    if (!record.noSpine) {
      if ((await page.locator(".spine-toggle").getAttribute("aria-expanded")) !== "true") await page.locator(".spine-toggle").click();
      await sleep(300);
      record.open = await box(".spine");
      await shot("2-open");
      if (await page.locator(".spine-tab").count() > 3) { await page.locator(".spine-tab").nth(2).click(); await sleep(300); await shot("3-station-3"); }
      if (await page.locator(".spine-all-toggle").count()) { await page.locator(".spine-all-toggle").click(); await sleep(300); await shot("4-all", { fullPage: true }); }
    }
    summary.combos.push(record);
    await context.close();
  }
} finally {
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  await browser.close().catch(() => {});
  await server.close();
}
console.log(JSON.stringify({ combos: summary.combos, errors: summary.errors.length }, null, 1));
