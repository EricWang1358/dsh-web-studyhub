/* npm run qa:reading-loop [-- --lang zh|en --theme dark|light --width 1440|420 --out <dir>]
   The reading loop in the browser preview: READ -> 做这几页的题 -> counts before starting -> practise -> finish -> the result page
   says the mastery change and offers 回到阅读 -> the reader reopens at the same position -> the outline meters moved; the none-yet path
   (为这几页出题 opens the generation entry with the pages' sources); and a wrong answer's 看这题的原文 with its way back to the same card.
   A seeded temporary library (a text PDF of six pages, a Markdown note with headings, linked flashcards in every review state), the
   fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json (steps, console
   errors, page errors, failed API calls); exits non-zero when a step fails or the page throws. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { makeTextPdf } from "../../tests/helpers/text-pdf.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) values[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440);
  return { lang, theme, width, height: Number(values.height ?? (width < 700 ? 860 : 900)), out: resolve(values.out ?? join(repoRoot, `output/qa/reading-loop/${lang}-${theme}-${width}`)) };
}

const day = 86400000, iso = (ms) => new Date(ms).toISOString();
const PAGES = [
  ["Processes and threads", "A process is the unit of resource allocation in an operating system and owns its address space."],
  ["Scheduling", "The scheduler decides which ready thread runs next on the processor and for how long it may run."],
  ["Memory management", "Virtual memory gives every process its own address space that the kernel maps onto physical frames."],
  ["Page replacement", "When memory is full the kernel evicts a page chosen by a replacement policy such as least recently used."],
  ["File systems", "A file system keeps persistent data organised in files and directories on a block device for the user."],
  ["Input and output", "Drivers hide the differences between devices behind a small and uniform set of operations."],
];
const NOTES = "# Study notes\n\nIntroduction paragraph that welcomes the reader to the notes about indexing.\n\n## Hash indexes\n\nA hash index answers equality lookups quickly but cannot serve range queries at all in practice.\n\n## Balanced trees\n\nThe most common index structure is a balanced tree which finds a key in logarithmic time always.\n\n## Summary\n\nIndexes trade write cost and space for faster reads, so choose them for the queries that matter.\n";

const card = (id, prompt, quote, sourceId, selection, review) => ({ id, kind: "flashcard", topic: "Operating systems", objective: `Objective ${id}`, prompt, answer: `Answer to ${prompt}`, hint: "Think of the definition.",
  explanation: `Because ${quote}`, misconception: "The common mistake.", citations: [{ sourceId, quote, ...(selection ? { selection } : {}) }], ...(selection ? { selections: [selection] } : {}), ...(review ? { review } : {}) });

async function seed(root) {
  const runtime = createStudyRuntime(root);
  const pdf = await runtime.call("materials.document.import", { filename: "operating-systems.pdf", courses: ["QA"], dataBase64: (await makeTextPdf(PAGES.map(([title, text]) => [title, text]))).toString("base64") });
  const notes = await runtime.call("materials.document.import", { filename: "index-notes.md", courses: ["QA"], dataBase64: Buffer.from(NOTES).toString("base64") });
  const pick = async (quote) => (await runtime.call("materials.selection.resolve", { documentId: notes.documentId, revision: notes.revision, quote })).selection;
  const hashSel = await pick("A hash index answers equality lookups quickly"), treeSel = await pick("The most common index structure is a balanced tree");
  runtime.dispose();
  const [p1, p2, , p4] = pdf.sourceIds;
  const mastered = { repetitions: 4, interval_days: 30, due_at: iso(Date.now() + 20 * day), ease_factor: 2.6 };
  const overdueWeak = { repetitions: 1, interval_days: 1, due_at: iso(Date.now() - day), ease_factor: 2.3 };
  const store = new Store(root);
  await store.update((state) => {
    state.decks.push({ id: "os", title: "Operating systems", course: "QA", cards: [
      card("a1", "What does a process own?", "A process is the unit of resource allocation", p1, null),
      card("a2", "Why is a process a unit of allocation?", "owns its address space", p1, null, mastered),
      card("b1", "What does the scheduler decide?", "decides which ready thread runs next", p2, null, overdueWeak),
      card("d1", "What does a replacement policy choose?", "evicted a page chosen by a replacement policy", p4, null),
    ] });
    state.decks.push({ id: "idx", title: "Indexes", course: "QA", cards: [
      card("h1", "What can a hash index not serve?", "cannot serve range queries", notes.sourceIds[0], hashSel),
      card("t1", "How fast does a balanced tree find a key?", "logarithmic time", notes.sourceIds[0], treeSel),
    ] });
    state.attempts.push({ id: "at-b1", deckId: "os", quiz_id: "b1", grade: 1, at: iso(Date.now() - day), runId: "old" });
  });
  return { pages: pdf.sourceIds };
}

export async function runReadingLoopQa(options) {
  const removed = scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const library = join(options.out, "work", "library");
  await mkdir(library, { recursive: true });
  await seed(library);
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0, model: createFakeModel({ latencyMs: 300, usage: true }) });
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
    const scroller = viewer.locator(".reader-scroll");
    const row = (title) => page.locator(".source-doc", { hasText: title });
    const control = () => viewer.getByRole("button", { name: t("做这几页的题", "Practise these pages"), exact: false }).first();
    const panel = () => viewer.locator(".reader-practice__panel");
    const openOutline = async () => { if (!(await viewer.locator(".reader-outline").count())) await viewer.getByRole("button", { name: t("目录", "Contents"), exact: true }).click(); await viewer.locator(".reader-outline").waitFor(); };
    const jumpTo = async (label) => { await openOutline(); await viewer.locator(".reader-outline__link", { hasText: label }).first().click(); await sleep(900); };
    const closeOutlineIfNarrow = async () => { if (options.width < 900 && (await viewer.locator(".reader-scrim").count())) { await viewer.locator(".reader-scrim").click({ position: { x: options.width - 8, y: 200 } }); await sleep(300); } };
    const openReader = async (title) => { await row(title).locator(".source-main").click(); await viewer.waitFor(); await sleep(900); };
    const closeReader = async () => { await page.keyboard.press("Escape"); await sleep(400); if (await viewer.count()) await page.locator("dialog[open]").getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); await sleep(400); };
    const openPanel = async () => { await closeOutlineIfNarrow(); if (!(await panel().count())) await control().click(); await panel().waitFor(); await sleep(300); };
    const markState = (title) => viewer.locator(`.reader-outline [role="img"][aria-label*="${title}"]`).first().getAttribute("data-state");
    const answerAll = async (grade) => {
      await page.locator(".review-page").first().waitFor();
      for (let guard = 0; guard < 8; guard += 1) {
        if (await page.locator(".result-page").count()) return;
        await page.locator(".review-heading h1").first().click().catch(() => {});
        await page.keyboard.press("Space"); await sleep(500);
        await page.keyboard.press(String(grade)); await sleep(700);
        await page.keyboard.press("Enter"); await sleep(700);
      }
    };
    let savedTop = 0;

    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
    await sleep(800);

    await step("sources-rows-show-mastery", async () => {
      await page.locator(".source-doc").first().waitFor();
      const os = (await row("operating-systems").innerText()), notes = (await row("index-notes").innerText());
      assert.match(os, zh ? /掌握 \d+% · 4 题/ : /Mastery \d+% · 4 questions/);
      assert.match(notes, zh ? /未学 · 2 题/ : /New · 2 questions/);
    });
    await step("sources-pages-show-mastery", async () => {
      await row("operating-systems").getByRole("button", { name: /(查看|View|Show) \d+/ }).click();
      const list = await row("operating-systems").locator(".source-doc__page-list").innerText();
      assert.ok(list.includes(t("还没出题", "No questions yet")), "a page with no question says so");
    });

    await step("reader-control-and-meters", async () => {
      await openReader("operating-systems");
      await control().waitFor();
      await openOutline();
      assert.ok((await viewer.locator(".reader-outline .mastery-mark").count()) >= 6, "a meter per page");
    });
    await step("panel-this-page", async () => {
      await jumpTo(t("第 2 页", "Page 2"));
      await openPanel();
      const counts = await panel().locator("[data-testid=practice-counts]").innerText();
      assert.equal(counts, zh ? "1 道题 · 1 道到期 · 1 道薄弱题" : "1 question · 1 due · 1 weak", counts);
      savedTop = await scroller.evaluate((el) => el.scrollTop);
    });
    await step("panel-just-read", async () => {
      await panel().getByText(t("刚读过的", "just read")).first().click();
      const counts = await panel().locator("[data-testid=practice-counts]").innerText();
      assert.match(counts, /^[0-9]/);
    });
    await step("panel-this-page-again", async () => { await panel().getByText(t("本页", "This page"), { exact: true }).click(); });
    await step("practise-starts-review", async () => {
      await panel().getByRole("button", { name: zh ? /开始做这/ : /Practise this|Practise these/ }).click();
      await page.locator(".review-page").waitFor();
      await page.getByRole("button", { name: t("回到原文", "Back to the text") }).waitFor();
    });
    await step("return-context-survives-reload", async () => {
      // The app is closed and opened again mid-run: the run is resumed (S) and still knows where the learner was reading.
      await page.reload();
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await sleep(1200);
      await page.locator("main, body").first().click({ position: { x: Math.min(600, options.width - 40), y: 300 } }).catch(() => {});
      await page.keyboard.press("s");
      await page.locator(".review-page").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: t("回到原文", "Back to the text") }).waitFor();
    });
    await step("finish-and-see-mastery-change", async () => {
      await answerAll(5);
      await page.locator(".result-page").waitFor({ timeout: 20000 });
      const change = await page.locator("[data-testid=mastery-change]").innerText();
      assert.match(change, zh ? /这几页的掌握度 \d+% → \d+%/ : /Mastery of these pages \d+% → \d+%/, change);
      const [from, to] = change.match(/\d+/g).map(Number);
      assert.ok(to > from, `${from} -> ${to}`);
      await page.getByRole("button", { name: t("回到阅读", "Back to reading") }).first().waitFor();
    });
    await step("back-to-reading-same-place", async () => {
      await page.getByRole("button", { name: t("回到阅读", "Back to reading") }).first().click();
      await viewer.waitFor();
      await sleep(1600);
      const top = await scroller.evaluate((el) => el.scrollTop);
      assert.ok(Math.abs(top - savedTop) <= 90, `scrollTop ${top} vs ${savedTop}`);
      await openOutline();
      const here = await viewer.locator('.reader-outline [aria-current="location"]').innerText();
      assert.match(here, zh ? /第 2 页/ : /Page 2/);
    });
    await step("outline-meters-updated", async () => {
      assert.notEqual(await markState(t("第 2 页", "Page 2")), "learning", "the page 2 meter moved off its earlier state");
      assert.ok(["familiar", "mastered"].includes(await markState(t("第 2 页", "Page 2"))));
    });
    await step("none-yet-path", async () => {
      await jumpTo(t("第 3 页", "Page 3"));
      await openPanel();
      await panel().locator("[data-testid=practice-none]").waitFor();
      assert.equal(await panel().getByRole("button").count(), 1, "exactly one button");
      await panel().getByRole("button", { name: t("为这几页出题", "Make questions for these pages") }).click();
      await page.getByRole("heading", { name: /创建题组|Create|Generate/ }).first().waitFor({ timeout: 10000 }).catch(() => {});
      await sleep(600);
      assert.equal(await viewer.count(), 0, "the reader closed for the generation page");
    });
    await step("wrong-answer-source-and-way-back", async () => {
      await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
      await sleep(600);
      await openReader("operating-systems");
      await jumpTo(t("第 1 页", "Page 1"));
      await openPanel();
      await panel().getByRole("button", { name: zh ? /开始做这/ : /Practise this|Practise these/ }).click();
      await page.locator(".review-page").waitFor();
      await page.locator(".review-heading h1").first().click();
      await page.keyboard.press("Space"); await sleep(500);
      await page.keyboard.press("1"); await sleep(900);
      const question = await page.locator(".question, .flip-card, .review-page").first().innerText();
      await page.getByRole("button", { name: t("看这题的原文", "See this question’s source text") }).click();
      await viewer.waitFor();
      await sleep(700);
      assert.ok((await viewer.innerText()).includes("process"), "the reader shows the cited text");
      await viewer.getByRole("button", { name: t("回到这道题", "Back to this question") }).click();
      await page.locator(".review-page").waitFor();
      assert.equal(await viewer.count(), 0);
      assert.ok(question.length > 0);
    });
    await step("markdown-sections-meter", async () => {
      await page.getByRole("button", { name: t("返回学习库", "Back to library") }).first().click().catch(() => {});
      await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
      await sleep(600);
      await openReader("index-notes");
      await openOutline();
      assert.ok((await viewer.locator(".reader-outline .mastery-mark").count()) >= 3, "heading sections have meters");
      await openPanel();
      const counts = await panel().locator("[data-testid=practice-counts]").innerText();
      assert.match(counts, zh ? /^2 道题/ : /^2 questions/, "the whole note: its title section holds both headings' questions");
      await closeOutlineIfNarrow();
      await page.keyboard.press("Escape"); await sleep(300);
      await openOutline();
      const hash = await viewer.locator('.reader-outline [role="img"][aria-label*="Hash indexes"]').first().getAttribute("aria-label");
      assert.match(hash, zh ? /1 (道)?题/ : /1 question/, hash);
      const summary = await viewer.locator('.reader-outline [role="img"][aria-label*="Summary"], .reader-outline [role="img"][aria-label*="小结"]').first().getAttribute("aria-label");
      assert.ok(summary.includes(t("还没出题", "No questions yet")), summary);
    });
    await step("keyboard-shortcut-p-toggles-panel", async () => {
      assert.equal(await panel().count(), 0, "the panel is closed first");
      await scroller.focus();
      await page.keyboard.press("p");
      await panel().waitFor({ timeout: 4000 });
      await page.keyboard.press("p");
      await panel().waitFor({ state: "detached", timeout: 4000 });
    });
    await closeReader();
    return summary;
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.pageErrors.length && !summary.consoleErrors.length && summary.steps.every((item) => item.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runReadingLoopQa(options);
    console.log(`${summary.ok ? "Reading loop QA passed" : "Reading loop QA FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
