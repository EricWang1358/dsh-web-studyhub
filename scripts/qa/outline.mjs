/* npm run qa:outline [-- --lang zh|en --theme dark|light --width 1440|1194|420 --out <dir>]
   The reader's contents panel as a tree and the AI re-outline / re-segmentation flow, in the browser preview: a seeded
   temporary library (a bilingual transcript as Markdown, a text PDF, a recording of three files, a pasted text), the fake
   model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json (steps,
   console errors, page errors, failed API calls); exits non-zero when a step fails or the page throws. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Store } from "../../lib/store.js";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { bilingualMarkdown } from "../../tests/helpers/bilingual-transcript.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) values[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440);
  return { lang, theme, width, height: Number(values.height ?? (width < 700 ? 860 : 900)), out: resolve(values.out ?? join(repoRoot, `output/qa/outline/${lang}-${theme}-${width}`)) };
}

/** A library with one of each kind of document the flow is meant for. */
async function seed(root) {
  const runtime = createStudyRuntime(root);
  await runtime.call("materials.document.import", { filename: "platform-economics.md", dataBase64: Buffer.from(bilingualMarkdown()).toString("base64"), courses: ["QA"] });
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  const chapters = [["Chapter 1 Processes", "A process is the unit of resource allocation in an operating system."], ["Chapter 2 Memory", "Virtual memory gives every process its own address space to work in."], ["Chapter 3 Files", "A file system keeps persistent data organised on a disk for the user."]];
  for (const [title, text] of chapters) for (const lines of [[title, text, "The text of this page goes on with more words so that it counts as a real page."], [`Notes on ${title}`, text, "A second page of the same chapter, with enough words to be extracted."]]) {
    const page = doc.addPage([480, 600]);
    lines.forEach((line, index) => page.drawText(line, { x: 30, y: 540 - index * 24, size: 12, font }));
  }
  await runtime.call("materials.document.import", { filename: "operating-systems.pdf", dataBase64: Buffer.from(await doc.save()).toString("base64"), courses: ["QA"] });
  runtime.dispose();
  const store = new Store(root), at = "2026-10-01T08:00:00.000Z";
  const volumes = ["Welcome to the lecture.\nChapter 1 Basics\nWe start with the basics of the course.", "More about the basics.\nChapter 2 Practice\nNow we practise what we learned.", "Practice continues.\nThanks for listening."];
  await store.update((state) => {
    volumes.forEach((text, index) => state.sources.push({ id: `pe1-${index + 1}`, title: `PE1 (${index + 1}/3)`, text, createdAt: at, courses: ["QA"],
      audio: { batch: { id: "pe1", title: "PE1", volume: index + 1, volumes: 3 }, sourceIds: ["pe1-1", "pe1-2", "pe1-3"] } }));
    state.sources.push({ id: "note-1", title: "Pasted notes", createdAt: at, courses: ["QA"],
      text: "Chapter 1 Warm-up\nA short paragraph of notes about the warm-up of the course.\nChapter 2 Core ideas\nThe core ideas in a few sentences, written for review.\nChapter 3 Practice\nWhat to practise before the exam, in short." });
  });
}

export async function runOutlineQa(options) {
  const removed = scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const library = join(options.out, "work", "library");
  await mkdir(library, { recursive: true });
  await seed(library);
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0, model: createFakeModel({ latencyMs: 700, usage: true }) });
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { startedAt: new Date().toISOString(), options, url: server.url, scrubbedEnv: removed, steps: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, locale: options.lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme });
    await context.addInitScript(([lang, theme]) => { try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme); localStorage.removeItem("study-reader"); } catch { /* blocked */ } }, [options.lang, options.theme]);
    const page = await context.newPage();
    let current = "boot", n = 0;
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push({ step: current, text: message.text() }); });
    page.on("pageerror", (error) => summary.pageErrors.push({ step: current, text: String(error?.stack || error) }));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      const body = await response.json().catch(() => ({}));
      summary.apiErrors.push({ step: current, status: response.status(), error: body.error || "" });
    });
    const zh = options.lang === "zh", t = (chinese, english) => (zh ? chinese : english);
    const shot = async (name) => { await sleep(350); const file = `${String(++n).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(options.out, file) }); return file; };
    const step = async (name, run) => {
      current = name;
      const record = { name, status: "ok" };
      try { await run(); record.shot = await shot(name); } catch (error) { record.status = "failed"; record.error = String(error?.message || error).split("\n")[0]; await shot(`${name}-failed`).catch(() => {}); }
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${name}${record.error ? ` — ${record.error}` : ""}`);
    };
    const viewer = page.locator(".study-document-viewer");
    const openOutline = async () => { if (!(await viewer.locator(".reader-outline").count())) await viewer.getByRole("button", { name: t("目录", "Contents"), exact: true }).click(); await viewer.locator(".reader-outline").waitFor(); };
    const closeReader = async () => { await page.keyboard.press("Escape"); await sleep(400); if (await page.locator("dialog[open]").count()) await page.locator("dialog[open]").getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); await sleep(400); };
    const openRow = async (title) => { await page.locator(".source-doc", { hasText: title }).locator(".source-main").click(); await viewer.waitFor(); await sleep(500); };
    const row = (title) => page.locator(".source-doc", { hasText: title });
    const dialog = page.locator("dialog[open]");

    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
    await sleep(800);

    await step("sources-list", async () => { await page.locator(".source-doc").first().waitFor(); });
    await step("reader-tree", async () => { await openRow("platform-economics"); await openOutline(); });
    await step("reader-current-part", async () => {
      await viewer.locator(".reader-outline__link", { hasText: "第三部分" }).first().click();
      await sleep(700);
    });
    await step("reader-filter", async () => { await openOutline(); await viewer.locator(".reader-outline__filter input").fill("对照"); });
    await step("reader-filter-cleared", async () => { await openOutline(); await viewer.locator(".reader-outline__filter input").fill(""); });
    await step("ai-estimate", async () => {
      await openOutline();
      await viewer.getByRole("button", { name: t("对自动解析的标题不满意？让 AI 帮你", "Not happy with the automatic headings? Let AI help") }).click();
      await viewer.locator('[data-phase="ready"]').waitFor();
    });
    await step("ai-running", async () => { await openOutline(); await viewer.getByRole("button", { name: t("开始", "Start") }).click(); await viewer.locator('[data-phase="running"]').waitFor(); });
    await step("ai-proposal", async () => { await dialog.locator(".reader-assist__preview").waitFor({ timeout: 15000 }); });
    await step("ai-accepted", async () => {
      await dialog.getByRole("button", { name: t("采用这个目录", "Use this outline") }).click();
      await viewer.locator(".reader-outline__foot", { hasText: t("AI 目录", "AI headings") }).waitFor();
    });
    await step("segment-dialog", async () => {
      await openOutline();
      await viewer.getByRole("button", { name: t("用它重新分段", "Re-segment by this outline") }).click();
      await dialog.locator(".reader-segment").waitFor();
    });
    await step("segment-level-2", async () => { await dialog.locator('input[name="segment-level"][value="2"]').check(); });
    await step("segment-applied", async () => {
      await dialog.getByRole("button", { name: t("用这个分段", "Use this segmentation") }).click();
      await viewer.locator(".reader-outline__foot", { hasText: t("分成", "Split into") }).waitFor();
    });
    await step("reader-ai-tree", async () => { await openOutline(); await viewer.locator(".reader-outline__link").nth(2).click(); await sleep(500); });
    await closeReader();

    await step("sources-chapters-text", async () => {
      await row("platform-economics").getByRole("button", { name: /(查看|View) \d+/ }).click();
      await row("platform-economics").locator(".source-doc__chapters").waitFor();
    });
    await step("row-menu", async () => { await row("operating-systems").locator("summary").click(); });
    await step("row-dialog", async () => {
      await row("operating-systems").getByRole("button", { name: t("AI 重新分段…", "Re-segment with AI…") }).click();
      await dialog.locator(".reader-assist-dialog").waitFor();
    });
    await step("row-dialog-estimate", async () => {
      await dialog.getByRole("button", { name: t("让 AI 找出章节（较省）", "Find chapters with AI (cheaper)") }).click();
      await dialog.locator('[data-phase="ready"]').waitFor();
    });
    await step("row-dialog-proposal", async () => {
      await dialog.locator('[data-phase="ready"]').getByRole("button", { name: t("开始", "Start") }).click();
      await page.locator("dialog[open]").nth(1).locator(".reader-assist__preview").waitFor({ timeout: 15000 });
    });
    await step("row-dialog-chapters-applied", async () => {
      await page.locator("dialog[open]").getByRole("button", { name: t("采用这些章节", "Use these chapters") }).click();
      await page.locator("dialog[open] .reader-assist-dialog", { hasText: t("分成", "Split into") }).waitFor();
    });
    await page.keyboard.press("Escape");
    await sleep(500);
    await step("sources-chapters-pdf", async () => {
      await row("operating-systems").getByRole("button", { name: /(查看|View) \d+/ }).click();
      await row("operating-systems").locator(".source-doc__chapters").waitFor();
    });
    await page.getByRole("button", { name: /^(全部展开|Expand all)$/ }).click();
    await sleep(500);
    await step("recording-dialog", async () => {
      await row("PE1").locator("summary").click();
      await row("PE1").getByRole("button", { name: t("AI 重新分段…", "Re-segment with AI…") }).click();
      await dialog.locator(".reader-assist-dialog").waitFor();
    });
    await step("recording-estimate", async () => {
      await dialog.getByRole("button", { name: t("让 AI 找出章节（较省）", "Find chapters with AI (cheaper)") }).click();
      await dialog.locator('[data-phase="ready"]').waitFor();
    });
    await step("recording-proposal", async () => {
      await dialog.locator('[data-phase="ready"]').getByRole("button", { name: t("开始", "Start") }).click();
      await page.locator("dialog[open]").nth(1).locator(".reader-assist__preview").waitFor({ timeout: 15000 });
    });
    await step("recording-applied", async () => {
      await page.locator("dialog[open]").getByRole("button", { name: t("采用这些章节", "Use these chapters") }).click();
      await page.locator("dialog[open] .reader-assist-dialog", { hasText: t("分成", "Split into") }).waitFor();
    });
    await page.keyboard.press("Escape");
    await sleep(500);
    await step("sources-chapters-recording", async () => {
      await row("PE1").getByRole("button", { name: /(查看|View) \d+/ }).click();
      await row("PE1").locator(".source-doc__chapters").waitFor();
    });
    await step("notes-segment-preview", async () => {
      await row("Pasted notes").locator("summary").click();
      await row("Pasted notes").getByRole("button", { name: t("AI 重新分段…", "Re-segment with AI…") }).click();
      await dialog.getByRole("button", { name: t("让 AI 找出章节（较省）", "Find chapters with AI (cheaper)") }).click();
      await dialog.locator('[data-phase="ready"]').getByRole("button", { name: t("开始", "Start") }).click();
      await page.locator("dialog[open]").nth(1).locator(".reader-assist__preview").waitFor({ timeout: 15000 });
      await page.locator("dialog[open]").getByRole("button", { name: t("采用这些章节", "Use these chapters") }).click();
      await page.locator("dialog[open] .reader-assist-dialog", { hasText: t("分成", "Split into") }).waitFor();
      await dialog.getByRole("button", { name: t("用它重新分段", "Re-segment by this outline") }).click();
      await page.locator("dialog[open] .reader-segment").waitFor();
    });
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(400);
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.pageErrors.length && summary.steps.every((item) => item.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runOutlineQa(options);
    console.log(`${summary.ok ? "Outline QA passed" : "Outline QA FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
