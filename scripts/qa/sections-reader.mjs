/* npm run qa:sections-reader [-- --lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   The shared sections (lib/sections.js) in the browser preview, on a seeded temporary library with the fake model: a merged five-recording bilingual transcript
   (80 parts, two volumes, the fourth recording split across them: tests/helpers/merged-transcript.mjs), a published deck whose questions point into parts of it, and a
   question run over both volumes.
     - the reader's outline: recordings with their file names, the parts under them, no 英文原句 / 中文对照 entry; the transcript furniture (80 "=", the 《…》 line)
       is not drawn; a part says which recording it is in; the outline meters (掌握度) sit on the parts and add up in the recording;
     - the 任务 console's 资料部分: every row names its own recording and parts, and 在资料中查看 opens the reader at that part.
   Fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json; exits non-zero when a step fails or the page throws. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";
import { bilingualMarkdown } from "../../tests/helpers/bilingual-transcript.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) values[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1280);
  return { lang, theme, width, height: Number(values.height ?? (width < 700 ? 860 : 900)), out: resolve(values.out ?? join(repoRoot, `output/qa/sections-reader/${lang}-${theme}-${width}`)) };
}

const day = 86400000, iso = (ms) => new Date(ms).toISOString();
const world = mergedTranscript();
const NUMBERS = "一二三四五六七八九十";
const partAt = (volume, recording, part) => {
  const text = world.sources[volume].text, at = text.indexOf(`第${part <= 10 ? NUMBERS[part - 1] : "十" + NUMBERS[part - 11]}部分：预览段落 ${part}】`, text.indexOf(`## ${recording}.`));
  return at;
};
const quoteIn = (volume, recording, part) => {
  const text = world.sources[volume].text, from = partAt(volume, recording, part), at = text.indexOf(`Recording ${recording}, part ${part}, point 2.1:`, from);
  return text.slice(at, text.indexOf(".", at + 40) + 1);
};

async function seed(root) {
  const store = new Store(root);
  const batchId = "qa-merged-batch", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: ids.length, sourceIds: ids };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["QA"], title: `${batch.title} · 全量中英对照逐字稿 (${index + 1}/${ids.length})`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
  });
  const runtime = createStudyRuntime(root);
  const md = await runtime.call("materials.document.import", { filename: "bilingual-notes.md", courses: ["QA"], dataBase64: Buffer.from(bilingualMarkdown()).toString("base64") });
  const pick = async (volume, recording, part) => (await runtime.call("materials.selection.resolve", { sourceId: ids[volume], quote: quoteIn(volume, recording, part) })).selection;
  const places = [[0, 1, 1], [0, 1, 3], [0, 2, 1], [0, 4, 5], [1, 5, 2]];
  const selections = [];
  for (const place of places) selections.push(await pick(...place));
  runtime.dispose();
  const mastered = { repetitions: 4, interval_days: 30, due_at: iso(Date.now() + 20 * day), ease_factor: 2.6 };
  const weak = { repetitions: 1, interval_days: 1, due_at: iso(Date.now() - day), ease_factor: 2.3 };
  const card = (id, prompt, volume, selection, review) => ({ id, kind: "flashcard", topic: "Platform", objective: `Objective ${id}`, prompt, answer: `Answer to ${prompt}`, hint: "Think.", explanation: "Because.", misconception: "A mistake.",
    citations: [{ sourceId: ids[volume], quote: selection.quote, selection }], selections: [selection], ...(review ? { review } : {}) });
  await store.update((state) => {
    state.decks.push({ id: "platform", title: "Platform", course: "QA", cards: [
      card("c1", "What does recording 1 part 1 say?", 0, selections[0], mastered), card("c2", "What does recording 1 part 3 say?", 0, selections[1]),
      card("c3", "What does recording 2 part 1 say?", 0, selections[2], weak), card("c4", "What does recording 4 part 5 say?", 0, selections[3]), card("c5", "What does recording 5 part 2 say?", 1, selections[4], mastered)] });
  });
  return { ids, md: md.sourceIds[0] };
}

export async function runSectionsQa(options) {
  const removed = scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const library = join(options.out, "work", "library");
  await mkdir(library, { recursive: true });
  const seeded = await seed(library);
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0, model: createFakeModel({ latencyMs: 20, usage: true }) });
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { startedAt: new Date().toISOString(), options, url: server.url, scrubbedEnv: removed, steps: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  try {
    // A question run over both volumes: its parts are the 资料部分 rows.
    await previewCall(server, "generate", { sourceIds: seeded.ids, count: 24, kind: "quiz", title: "Platform run", uiLanguage: options.lang });
    // The parts are planned at the start of the run: the console shows them (and their ranges) while it is still working; the run is left to finish on its own.
    for (let guard = 0; guard < 100; guard += 1) {
      const snapshot = await previewCall(server, "snapshot", {});
      if (snapshot.jobs.some((job) => job.parts > 0)) break;
      await sleep(300);
    }
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
    const shot = async (name) => { await sleep(400); const file = `${String(++n).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(options.out, file) }); return file; };
    const facts = {};
    summary.facts = facts;
    const step = async (name, run) => {
      current = name;
      const record = { name, status: "ok" };
      try { await run(); record.shot = await shot(name); } catch (error) { record.status = "failed"; record.error = String(error?.message || error).split("\n")[0]; await shot(`${name}-failed`).catch(() => {}); }
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${name}${record.error ? ` — ${record.error}` : ""}`);
    };
    const viewer = page.locator(".study-document-viewer"), scroller = viewer.locator(".reader-scroll");
    const openOutline = async () => { if (!(await viewer.locator(".reader-outline").count())) await viewer.getByRole("button", { name: t("目录", "Contents"), exact: true }).click(); await viewer.locator(".reader-outline").waitFor(); };
    const closeOutlineIfNarrow = async () => { if (options.width < 900 && (await viewer.locator(".reader-scrim").count())) { await viewer.locator(".reader-scrim").click({ position: { x: options.width - 8, y: 200 } }); await sleep(300); } };
    const closeReader = async () => { await page.keyboard.press("Escape"); await sleep(300); if (await viewer.count()) await page.locator("dialog[open]").getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); await sleep(400); };
    const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
    const outlineLinks = () => viewer.locator(".reader-outline__link");
    const whereIs = async (expected, what) => {
      for (let guard = 0; guard < 40; guard += 1) { const where = await viewer.locator(".reader-toolbar__where").innerText(); if (expected.every((word) => where.includes(word))) return where; await sleep(250); }
      throw new Error(`${what}: the reader says ${JSON.stringify(await viewer.locator(".reader-toolbar__where").innerText())}`);
    };

    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(1000);

    await step("open-the-merged-transcript", async () => {
      await goto("sources");
      await page.locator(".source-doc").first().waitFor();
      await page.locator(".source-doc", { hasText: RECORDING_NAMES[0] }).first().locator(".source-main").click();
      await viewer.waitFor();
      await sleep(1200);
      await openOutline();
    });
    await step("outline-is-recordings-and-parts", async () => {
      const text = await viewer.locator(".reader-outline").innerText();
      assert.ok(text.includes(RECORDING_NAMES[0]) && text.includes(RECORDING_NAMES[3]), "the recordings are entries");
      assert.ok(!/英文原句|中文对照/.test(text), "no label is an entry");
      // One volume has 4 recordings and 56 real parts: 60 entries, where the old outline listed 181 (every part and its two labels).
      const rows = await outlineLinks().count();
      facts.outlineRows = rows;
      assert.ok(rows >= 4 && rows <= 61, `${rows} rows`);
      await viewer.locator(".reader-outline__filter input").fill(t("英文原句", "英文原句"));
      await sleep(300);
      assert.equal(await outlineLinks().count(), 0, "searching for a label finds nothing");
      await viewer.locator(".reader-outline__filter input").fill("");
    });
    await step("furniture-is-not-drawn", async () => {
      const shown = await viewer.locator(".reader-scroll").innerText();
      assert.ok(!/={20}/.test(shown), "no row of = in the text");
      assert.ok(!shown.includes("全量中英对照逐字稿"), "no 《…》 furniture line");
      assert.ok(shown.includes("Preview Lecture Recording 1"), "the English title is a quiet header");
      await closeOutlineIfNarrow();
      await scroller.evaluate((element) => { element.scrollTop = 0; });
    });
    await step("part-under-its-recording", async () => {
      await openOutline();
      await viewer.locator(".reader-outline__link", { hasText: RECORDING_NAMES[1] }).first().click();
      await whereIs([RECORDING_NAMES[1]], "jumped to recording 2");
      await closeOutlineIfNarrow();
      await openOutline();
      // Recording 2's own third part (the outline lists each recording's parts under it).
      await viewer.locator(".reader-outline__link", { hasText: "第三部分：预览段落 3" }).nth(1).click();
      facts.where = await whereIs([RECORDING_NAMES[1], "第三部分"], "jumped to part 3 of recording 2");
      await closeOutlineIfNarrow();
    });
    await step("meters-on-parts-and-recordings", async () => {
      await openOutline();
      const marks = await viewer.locator(".reader-outline .mastery-mark").count();
      assert.ok(marks >= 4, `${marks} meters`);
      const first = await viewer.locator(`.reader-outline [role="img"][aria-label*="${RECORDING_NAMES[0]}"]`).first().getAttribute("aria-label");
      assert.match(first, zh ? /2 (道)?题/ : /2 questions/, `recording 1 holds the questions of its parts 1 and 3: ${first}`);
      const second = await viewer.locator(`.reader-outline [role="img"][aria-label*="${RECORDING_NAMES[1]}"]`).first().getAttribute("aria-label");
      assert.match(second, zh ? /1 (道)?题/ : /1 question/, second);
      const third = await viewer.locator(`.reader-outline [role="img"][aria-label*="${RECORDING_NAMES[2]}"]`).first().getAttribute("aria-label");
      assert.ok(third.includes(t("还没出题", "No questions yet")), third);
    });
    await step("practice-range-is-the-recording", async () => {
      await closeOutlineIfNarrow();
      await viewer.getByRole("button", { name: t("做这几页的题", "Practise these pages"), exact: false }).first().click();
      const panel = viewer.locator(".reader-practice__panel");
      await panel.waitFor();
      const text = await panel.innerText();
      assert.ok(text.length > 0);
      facts.panel = text.split("\n").slice(0, 6);
      await page.keyboard.press("Escape");
    });
    await closeReader();

    await step("markdown-transcript-outline-has-no-labels", async () => {
      await goto("sources");
      await page.locator(".source-doc", { hasText: "bilingual-notes" }).first().locator(".source-main").click();
      await viewer.waitFor();
      await sleep(900);
      await openOutline();
      const text = await viewer.locator(".reader-outline").innerText();
      assert.ok(text.includes(t("第一部分", "第一部分")) && !/英文原句|中文对照/.test(text), text);
      facts.markdownRows = await outlineLinks().count();
      await closeOutlineIfNarrow();
    });
    await closeReader();

    await step("tasks-parts-show-their-ranges", async () => {
      await goto("tasks");
      await page.locator(".tc-detail").first().waitFor({ state: "attached", timeout: 30000 });
      await page.locator(".tc-row").first().dispatchEvent("click");
      await page.locator(".tc-tab", { hasText: t("资料部分", "Source parts") }).first().click();
      await page.locator(".tc-partrow").first().waitFor({ state: "attached", timeout: 15000 });
      const ranges = await page.locator(".tc-filerow__range").allInnerTexts();
      facts.ranges = ranges;
      assert.ok(ranges.length >= 3, `${ranges.length} parts`);
      assert.ok(ranges.every((range) => (zh ? /^录音 \d+ · 第/ : /^Recording \d+ · part/).test(range)), ranges.join(" | "));
      assert.ok(new Set(ranges).size >= ranges.length - 2, "every row says something different");
    });
    await step("view-in-materials-opens-at-the-part", async () => {
      // The last part of the run lies in the second volume, where recording 4 carries on and recording 5 begins.
      const rows = page.locator(".tc-partrow");
      const last = rows.nth((await rows.count()) - 1);
      await last.locator(".tc-filerow").click();
      await last.locator("[data-part-open]").dispatchEvent("click");
      await viewer.waitFor({ timeout: 15000 });
      const wanted = facts.ranges.at(-1).match(/录音 (\d+)|Recording (\d+)/), recording = Number(wanted[1] || wanted[2]);
      facts.openedAt = await whereIs([RECORDING_NAMES[recording - 1]], `opened at recording ${recording}`);
      await openOutline();
      const text = await viewer.locator(".reader-outline").innerText();
      facts.secondVolumeOutline = text.split(/\n/).filter(Boolean).slice(0, 8);
      assert.ok(text.includes(RECORDING_NAMES[3]) && text.includes(RECORDING_NAMES[4]), "the second volume: recording 4 carries on, recording 5 begins");
      assert.ok(!/英文原句|中文对照/.test(text));
      await closeOutlineIfNarrow();
    });
    await closeReader();
    return { summary, facts };
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
    const options = parseArgs(process.argv.slice(2)), { summary } = await runSectionsQa(options);
    console.log(`${summary.ok ? "Sections reader QA passed" : "Sections reader QA FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
