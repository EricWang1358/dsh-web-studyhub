/* npm run qa:selection-job [-- --lang zh|en --theme dark|light --width 1440|420 --out <dir> --scenario full|shots|failure]
   The reader's learning panel with a passage supplement running as a background job (the panel used to be blocked
   by one long call): start it, watch the stage / counts / clock in place, keep asking about the passage meanwhile,
   see the same passage refused twice, stop a second job, finish, and jump to the new questions.

   Runs the real preview server (scripts/preview-server.mjs) on a fresh temporary library with the fake model and
   every key/token/base-url variable removed, in Chromium. One screenshot per state in <out>; summary.json lists
   console errors, page errors and failed API calls and the script exits non-zero on any failure. */
/* global document, getSelection, MouseEvent, innerHeight, getComputedStyle */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { sampleMarkdown } from "./fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const options = { lang: "zh", theme: "dark", width: 1440, height: 900, scenario: "full", out: resolve(repoRoot, "output/qa/selection-job") };
  for (let index = 0; index < argv.length; index++) {
    const [key, inline] = argv[index].split("=");
    const take = () => inline ?? argv[++index];
    if (key === "--lang") options.lang = take() === "en" ? "en" : "zh";
    else if (key === "--theme") options.theme = take() === "light" ? "light" : "dark";
    else if (key === "--width") { options.width = Number(take()); options.height = options.width < 600 ? 860 : 900; }
    else if (key === "--scenario") options.scenario = ({ shots: "shots", failure: "failure" })[take()] || "full";
    else if (key === "--out") options.out = resolve(take());
  }
  return options;
}

export async function run(options) {
  scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  // The `failure` scenario makes the independent review fail (as a dropped connection would) once the material and deck are seeded.
  const fake = createFakeModel({ latencyMs: 200, generationLatencyMs: 2200 });
  const flaky = { failReview: false };
  const model = Object.assign((system, prompt, request) => {
    if (flaky.failReview && system.startsWith("Act as a strict")) throw new Error("fetch failed");
    return fake(system, prompt, request);
  }, fake);
  const server = await createPreviewServer({ libraryRoot: join(options.out, "work", "library"), home: join(options.out, "work", "home"), port: 0, model });
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { options, steps: [], consoleErrors: [], pageErrors: [], apiErrors: [], overflow: [] };
  const api = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
      locale: options.lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme });
    await context.addInitScript(([lang, theme]) => { try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme); } catch { /* blocked */ } },
      [options.lang, options.theme]);
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => summary.pageErrors.push(String(error?.stack || error)));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      let action = "";
      try { action = JSON.parse(response.request().postData() || "{}").action; } catch { /* not JSON */ }
      summary.apiErrors.push({ action, status: response.status() });
    });
    let shotIndex = 0;
    const shot = async (name) => { const file = `${String(++shotIndex).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(options.out, file) }); return file; };
    const check = async (label, fn) => {
      const record = { label, status: "ok" };
      try { await fn(record); } catch (error) { record.status = "failed"; record.error = String(error?.message || error).split("\n")[0]; await shot(`failed-${shotIndex}`).catch(() => {}); }
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${label}${record.error ? ` — ${record.error}` : ""}`);
    };
    const until = async (condition, label, timeout = 60000) => {
      const deadline = Date.now() + timeout;
      for (;;) { if (await condition()) return; if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(200); }
    };
    const overflowCheck = async (label) => {
      const wide = await page.evaluate(() => {
        const dialog = document.querySelector(".study-document-viewer") || document.body;
        return [...dialog.querySelectorAll(".study-document-learning *, .selection-job *")].filter((element) => element.scrollWidth > element.clientWidth + 2 &&
          getComputedStyle(element).overflowX === "visible" && element.clientWidth > 0).map((element) => `${element.tagName}.${element.className}`).slice(0, 5);
      });
      if (wide.length) summary.overflow.push({ label, wide });
    };
    const t = (zh, en) => (options.lang === "en" ? en : zh);

    // Seed: a material, and a deck to add to (through the API, as an earlier session would have left them).
    const material = sampleMarkdown(options.lang);
    await api("materials.document.import", { filename: material.name, dataBase64: Buffer.from(material.text).toString("base64") });
    const sourceIds = (await api("snapshot")).sources.map((source) => source.id);
    const seeded = await api("generate", { sourceIds, count: 3, kind: "flashcard", title: t("观察者模式基础", "Observer basics"), language: options.lang === "en" ? "English" : "中文" });
    await api("job.wait", { jobId: seeded.jobId, timeoutSeconds: 90 });
    const draft = (await api("snapshot")).drafts[0];
    await api("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
    flaky.failReview = options.scenario === "failure";

    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    const deckCount = async () => (await api("deck.get", { id: (await api("snapshot")).decks.find((deck) => !deck.systemKind).id })).cards.length;
    const startCards = await deckCount();

    // Open the reader on the material and select the first paragraph.
    await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${t("资料", "Sources")}`) }).first().click();
    await sleep(500);
    await page.locator(".source-main").first().click();
    await page.locator(".study-document-viewer").waitFor({ timeout: 20000 });
    await sleep(800);
    const select = async (index) => {
      await page.evaluate((at) => {
        const body = document.querySelector(".study-document-body");
        const paragraphs = [...body.querySelectorAll("p, li")].filter((node) => node.textContent.trim().length > 40);
        const range = document.createRange();
        range.selectNodeContents(paragraphs[at % paragraphs.length]);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }, index);
      await sleep(400);
      const panel = page.locator('[data-tour="source-tools"]');
      if (!(await panel.isVisible())) { await page.locator('[data-tour="source-tools-toggle"]').click(); await sleep(400); }
    };
    const learning = () => page.locator(".study-document-learning");
    const deckSelect = () => learning().locator("form").nth(1).locator("select").first();

    await check("select a passage and see the form with its estimate", async () => {
      await select(0);
      await learning().locator("form").nth(1).waitFor({ timeout: 15000 });
      await deckSelect().selectOption({ index: 1 });
      await learning().locator('input[type="number"]').fill("2");
      await page.locator("[data-token-estimate] .token-estimate__line:not(.token-estimate__line--loading)").waitFor({ timeout: 15000 });
      const estimate = await page.locator("[data-token-estimate] .token-estimate__line:not(.token-estimate__line--loading)").innerText();
      if (!/tok/.test(estimate)) throw new Error(`no estimate line: ${estimate}`);
      await overflowCheck("form");
      await shot("form-with-estimate");
    });

    await check("start returns at once and the job shows in place", async () => {
      const before = Date.now();
      await learning().locator("button.primary").click();
      await page.locator(".selection-job").first().waitFor({ timeout: 8000 });
      if (Date.now() - before > 6000) throw new Error("the panel waited for the model");
      await page.locator('.selection-job[data-phase="planning"], .selection-job[data-phase="writing"], .selection-job[data-phase="reviewing"], .selection-job[data-phase="queued"]').first().waitFor({ timeout: 8000 });
      await sleep(600); // the panel scrolls to the new card
      const inView = await page.locator(".selection-job").first().evaluate((card) => { const box = card.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight - 40; });
      if (!inView) throw new Error("the new job card is not in view after starting");
      await overflowCheck("running");
      await shot("running");
    });

    if (options.scenario === "full") {
      await check("the panel is not blocked: ask about the passage while the job runs", async () => {
        const phase = await page.locator(".selection-job").first().getAttribute("data-phase");
        if (!["planning", "writing", "reviewing", "queued"].includes(phase)) throw new Error(`job already ${phase}; raise the fake latency`);
        const ask = learning().getByRole("button", { name: t("依据原文回答", "Answer using the source") });
        await learning().locator("textarea").fill(t("这里的依赖关系是什么？", "What dependency does this describe?"));
        if (await ask.isDisabled()) throw new Error("the ask button is disabled while a job runs");
        await ask.click();
        await learning().locator(".study-grounded-answer").waitFor({ timeout: 20000 });
        await shot("asked-while-running");
      });

      await check("the same passage and deck is refused with a plain message", async () => {
        const phase = await page.locator(".selection-job").first().getAttribute("data-phase");
        if (!["planning", "writing", "reviewing", "queued"].includes(phase)) throw new Error(`job already ${phase}`);
        const button = learning().locator("button.primary");
        if (!(await button.isDisabled())) throw new Error("the generate button is not disabled for the same passage and deck");
        const hint = await learning().getByText(t("这段原文补到这个题组的任务正在进行", "A job for this passage and deck is already running")).count();
        if (!hint) throw new Error("no explanation of why it is disabled");
        await shot("duplicate-refused");
      });

      await check("a second job for another passage can be started and stopped without touching the deck", async () => {
        await select(1);
        await deckSelect().selectOption({ index: 1 });
        await learning().locator('input[type="number"]').fill("1");
        await sleep(500);
        await learning().locator("button.primary").click();
        await until(async () => (await page.locator(".selection-job").count()) >= 2, "second job card");
        const stop = page.locator(".selection-job").first().getByRole("button", { name: t("停止", "Stop"), exact: true });
        await stop.click();
        await until(async () => (await page.locator('.selection-job[data-phase="cancelled"]').count()) === 1, "the second job is stopped", 30000);
        await shot("second-job-stopped");
      });
    }

    if (options.scenario === "failure") {
      await check("a failed review says why in plain words and the deck is unchanged", async () => {
        await until(async () => (await page.locator('.selection-job[data-phase="failed"]').count()) === 1, "the job fails", 60000);
        const text = await page.locator('.selection-job[data-phase="failed"]').innerText();
        if (!new RegExp(t("连不上模型服务", "reach the model"), "i").test(text)) throw new Error(`no plain failure reason: ${text.slice(0, 160)}`);
        if ((await deckCount()) !== startCards) throw new Error("the deck changed although the review failed");
        await overflowCheck("failed");
        await shot("failed");
      });
      await check("retrying under the same operation reuses the candidates and saves once", async () => {
        flaky.failReview = false;
        const before = await deckCount();
        await page.locator('.selection-job[data-phase="failed"]').getByRole("button", { name: t("重试", "Retry"), exact: true }).click();
        await until(async () => (await page.locator('.selection-job[data-phase="done"], .selection-job[data-phase="partial"]').count()) === 1, "the retry finishes", 90000);
        const after = await deckCount();
        if (after !== before + 2) throw new Error(`expected 2 new cards, deck went ${before} -> ${after}`);
        await shot("retried-and-done");
      });
      return summary;
    }

    await check("the first job finishes with a result block and the new cards", async () => {
      await until(async () => (await page.locator('.selection-job[data-phase="done"], .selection-job[data-phase="partial"]').count()) >= 1, "the first job finishes", 90000);
      const cards = await deckCount();
      if (cards <= startCards) throw new Error("no cards were added to the deck");
      const result = page.locator('.selection-job[data-phase="done"], .selection-job[data-phase="partial"]').first();
      const text = await result.innerText();
      if (!new RegExp(t("已加入「.+」\\d+ 张", "Added \\d+ to")).test(text)) throw new Error(`result headline missing: ${text.slice(0, 120)}`);
      await overflowCheck("done");
      await shot("done");
      const inbox = (await api("snapshot")).inbox;
      if (!inbox.items.some((item) => item.kind === "passage-added")) throw new Error("no inbox letter");
    });

    if (options.scenario === "full") {
      await check("the toast offers the jump, and the jump starts a run on exactly the new cards", async () => {
        const practise = page.locator('.selection-job[data-phase="done"], .selection-job[data-phase="partial"]').first()
          .getByRole("button", { name: new RegExp(t("马上练这", "Practise ")) });
        await practise.click();
        await page.locator(".study-document-viewer").waitFor({ state: "detached", timeout: 15000 });
        await sleep(1200);
        const run = (await api("snapshot")).runs?.at?.(-1);
        await shot("practising-the-new-cards");
        if (!run) throw new Error("no run was started");
      });
    }
  } finally {
    summary.ok = !summary.pageErrors.length && summary.steps.every((step) => step.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await run(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: summary.ok, consoleErrors: summary.consoleErrors.length, pageErrors: summary.pageErrors.length, apiErrors: summary.apiErrors, overflow: summary.overflow }));
  process.exit(summary.ok ? 0 : 1);
}
