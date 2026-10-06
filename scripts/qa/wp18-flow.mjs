/* node scripts/qa/wp18-flow.mjs [--out <dir>] [--combos zh:dark:1440,en:light:420,...]
   WP18 screenshots: the guided flow's course line, switcher, cross-course hint,
   readable references and the friendly rate-limit / connection error states, on
   a library that resembles the owner's (a current course of JSON-imported exam
   decks plus a "Cloud Native Solution Design / 0N" course). The model is a
   local stub that answers every call with a provider-style failure.
   Secrets are scrubbed from the environment first; nothing leaves this machine. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { StudyService } from "../../lib/service.js";
import { launchChromium } from "./browser.mjs";
import { pick } from "./pick.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(arg("out", join(repoRoot, "output/qa/wp18")));
const combos = arg("combos", "zh:dark:1440,zh:light:420,en:light:1440,en:dark:420").split(",").map((c) => c.split(":"));
const PE = "Platform Engineering", CN = "Cloud Native Solution Design";
const RATE = "Your requests to gpt-6-luna for gpt-6-luna in centralus have exceeded token rate limit.";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const TOPICS_PE = ["平台工程基础", "内部开发者平台", "GitOps 发布", "可观测性", "容器编排", "CI/CD 流水线", "基础设施即代码"];
const TOPICS_CN = ["Cloud computing 概述", "云原生架构", "微服务拆分", "服务网格"];
const card = (id, topic, n, extra = {}) => ({ id, topic, kind: "flashcard", objective: `理解${topic}${n}`, prompt: `${topic}：关于「${topic}」的第 ${n} 个要点是什么？`,
  answer: `${topic}的要点 ${n}：把能力做成自助服务，并保持可审计。`, hint: `想想${topic}解决的问题`, misconception: "常见误区", citations: [],
  explanation: `${topic}的核心是把重复工作交给平台，让团队专注业务。要点 ${n} 说明了边界与取舍。`, ...extra });

async function seed(root) {
  const service = new StudyService(root, {});
  await service.store.update((s) => {
    for (let n = 1; n <= 5; n++) s.sources.push({ id: `json0${n}`, title: `JSON 导入：${PE}｜期末综合卷0${n}｜90题`, provenance: "json-card-self-reference", text: "{}" });
    s.sources.push({ id: "notes", title: "Cloud Native 课堂讲义", text: "云计算是按需获取计算资源的模式，资源可以弹性伸缩，并按使用量计费。" });
    for (let n = 1; n <= 5; n++) s.decks.push({ id: `pe0${n}`, title: `${PE}｜期末综合卷0${n}｜90题`, course: PE, folder: "",
      cards: Array.from({ length: 21 }, (_, i) => {
        const topic = TOPICS_PE[(i + n) % TOPICS_PE.length], c = card(`pe${n}-${i}`, topic, i + 1);
        // Older bank imports cited the card itself: the quote was the card's JSON.
        return { ...c, citations: [{ sourceId: `json0${n}`, quote: JSON.stringify({ kind: c.kind, prompt: c.prompt, answer: c.answer, topic }) }] };
      }) });
    TOPICS_CN.forEach((topic, i) => s.decks.push({ id: `cn0${i + 1}`, title: `${CN} / 0${i + 1} ${topic}`, course: CN, folder: "",
      cards: Array.from({ length: 8 }, (_, k) => card(`cn${i}-${k}`, topic, k + 1, i === 0 && k === 0
        ? { citations: [{ sourceId: "notes", quote: "云计算是按需获取计算资源的模式，资源可以弹性伸缩，并按使用量计费。", locator: "p.2" }] } : {})) }));
    s.decks.push({ id: "db1", title: "Databases / 01 事务", course: "Databases", folder: "", cards: [card("db1", "事务隔离", 1), card("db2", "索引", 2)] });
  });
  await service.call("focus.set", { course: PE });
  return service;
}

const stub = async (system) => {
  if (/choose study material|writing a private StudyHub learning article|careful (Chinese )?tutor writing/.test(system)) throw new Error(RATE);
  throw new Error("Connection error.");
};

async function run() {
  const removed = scrubProcessEnv();
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const root = join(out, "work", "library");
  const service = await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(out, "work", "home"), port: Number(process.env.PORT || 4330), model: stub });
  const browser = await launchChromium();
  const summary = { url: server.url, scrubbedEnv: removed, combos: [], pageErrors: [], consoleErrors: [] };
  try {
    for (const [lang, theme, widthText] of combos) {
      const width = Number(widthText), tag = `${lang}-${theme}-${width}`;
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
      const page = await context.newPage();
      page.on("pageerror", (error) => summary.pageErrors.push({ tag, text: String(error?.stack || error) }));
      page.on("console", (m) => { if (m.type() === "error") summary.consoleErrors.push({ tag, text: m.text() }); });
      const shot = (name, target = page, options = {}) => target.screenshot({ path: join(out, `${tag}-${name}.png`), ...options });
      await page.goto(server.url);
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: lang === "en" ? "Learning flow" : "学习流", exact: true }).first().click();
      const goal = lang === "en" ? "understand cloud computing" : "弄懂cloud computing重点";
      await page.getByLabel(lang === "en" ? "What would you like to learn?" : "想学什么").fill(goal);
      await shot("0-start");
      await page.getByRole("button", { name: lang === "en" ? "Start learning →" : "开始学 →" }).click();
      await page.locator(".wf-scope-line").waitFor({ timeout: 20000 });
      await page.locator(".wf-teaching .wf-notice .wf-model-error").waitFor({ timeout: 20000 }).catch(() => {});
      await sleep(900);
      const record = { tag, scope: await page.locator(".wf-scope").innerText(), options: await page.locator(".wf-course-switch option").allInnerTexts() };
      await shot("1-portal");
      await shot("2-scope", page.locator(".wf-heading"));
      if (await page.locator(".wf-teaching .wf-notice").count()) {
        await page.locator(".wf-teaching .wf-notice").scrollIntoViewIfNeeded();
        record.teachingError = await page.locator(".wf-teaching .wf-notice").innerText();
        await shot("3-teaching-error", page.locator(".wf-teaching .wf-notice"));
      }
      if (await page.locator(".wf-spine-status").count()) {
        record.spineStatus = await page.locator(".wf-spine-status").first().innerText();
        await shot("3b-spine-status", page.locator(".wf-spine-status").first());
      }
      // The references: bank-imported cards read as cards, real quotes stay quotes.
      await page.locator(".wf-readings > summary").first().click();
      await sleep(300);
      record.readings = (await page.locator(".wf-readings").first().innerText()).slice(0, 600);
      await shot("4-readings", page.locator(".wf-readings").first());
      await page.locator('.wf-course-switch [role="combobox"]').focus();
      await shot("5-switcher", page.locator(".wf-scope"));
      // One click on the hint moves the flow to the better-matching course.
      await page.locator(".wf-scope-hint .link-btn").click();
      await page.locator(".wf-scope-line", { hasText: CN }).waitFor({ timeout: 20000 });
      await sleep(600);
      record.afterRescope = await page.locator(".wf-scope").innerText();
      await page.locator(".wf-history > summary").scrollIntoViewIfNeeded();
      await page.locator(".wf-history > summary").click();
      await shot("6-rescoped", page, { fullPage: true });
      record.history = await page.locator(".wf-history").innerText();
      summary.combos.push(record);
      if (tag === "zh-dark-1440" || tag === `${combos[0].join("-")}`) {
        // With a practice answer on record the switch asks to start a new session.
        const { sessions } = await previewCall(server, "workflow.list", {});
        const id = sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
        await service.store.update((s) => { s.runs.push({ id: `qa-run-${tag}`, mode: "path", workflowSessionId: id, entries: [{ deckId: "pe01", card: card("q", "平台工程基础", 1), feedback: { grade: 3 } }] }); });
        await sleep(9000);
        await page.reload();
        await page.getByRole("button", { name: lang === "en" ? "Learning flow" : "学习流", exact: true }).first().click();
        await page.locator(".wf-quick-resume .link-btn").click().catch(() => {});
        await page.locator('.wf-course-switch [role="combobox"]').waitFor({ timeout: 20000 });
        await pick(page, page.locator('.wf-course-switch [role="combobox"]'), PE);
        await page.locator("dialog[open]").waitFor({ timeout: 5000 });
        await sleep(400);
        record.blocked = await page.locator("dialog[open]").innerText();
        await shot("7-blocked-dialog");
      }
      await context.close();
    }
  } finally {
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close().catch(() => {});
    await server.close();
  }
  console.log(JSON.stringify({ combos: summary.combos.length, pageErrors: summary.pageErrors.length, consoleErrors: summary.consoleErrors.length }));
  if (summary.pageErrors.length) process.exitCode = 1;
}
await run();
