/* npm run qa:coverage [-- --lang zh|en --theme dark|light --width 1280|420 --accent jade --out <dir>]
   Coverage (lib/coverage.js) in the browser preview, on a seeded temporary library with the fake model: the merged five-recording transcript (80 parts, two volumes: tests/helpers/merged-transcript.mjs), a
   published deck whose questions point into five parts of it, and a question run over both volumes whose review of two batches is damaged on purpose, so the draft it leaves is short and has planned-and-failed
   sections. The walk is the student's:
     资料 page: the coverage chip beside the mastery line → the reader: the chip in the toolbar, the outline's square marks and 覆盖 x/y, 只看没覆盖的, the 做这几页的题 panel → the 任务 console:
     资料部分 rows with 覆盖 a/b 小节, the strip with the real reason, the header's 为没覆盖的部分补题 → the draft page: the summary, one row per recording, the list of what has no question and its way
     to the reader, THE one top-up → run it → the numbers change (the failed batches are written again from their plan, the rest of the gaps planned from the text) → the home 待发布 row.
   Every number on screen is compared with the same fact from coverage.get. Fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json. */
/* global document, window */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";

const world = mergedTranscript();
const day = 86400000, iso = (ms) => new Date(ms).toISOString();
const NUMBERS = "一二三四五六七八九十";
const quoteIn = (volume, recording, part) => {
  const text = world.sources[volume].text, at0 = text.indexOf(`## ${recording}.`), from = text.indexOf(`第${part <= 10 ? NUMBERS[part - 1] : "十" + NUMBERS[part - 11]}部分：预览段落 ${part}】`, at0);
  const at = text.indexOf(`Recording ${recording}, part ${part}, point 2.1:`, from);
  return text.slice(at, text.indexOf(".", at + 40) + 1);
};

async function seed(root) {
  const store = new Store(root), batchId = "qa-cov-batch", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: ids.length, sourceIds: ids };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["QA"], title: `${batch.title} · 全量中英对照逐字稿 (${index + 1}/${ids.length})`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
  });
  const runtime = createStudyRuntime(root), places = [[0, 1, 2], [0, 1, 6], [0, 2, 4], [0, 4, 5], [1, 5, 3]], selections = [];
  for (const [volume, recording, part] of places) selections.push((await runtime.call("materials.selection.resolve", { sourceId: ids[volume], quote: quoteIn(volume, recording, part) })).selection);
  runtime.dispose();
  const mastered = { repetitions: 4, interval_days: 30, due_at: iso(Date.now() + 20 * day), ease_factor: 2.6 }, weak = { repetitions: 1, interval_days: 1, due_at: iso(Date.now() - day), ease_factor: 2.3 };
  const card = (id, prompt, volume, selection, review) => ({ id, kind: "flashcard", topic: "Platform", objective: `Objective ${id}`, prompt, answer: `Answer to ${prompt}`, hint: "Think.", explanation: "Because.", misconception: "A mistake.",
    citations: [{ sourceId: ids[volume], quote: selection.quote, selection }], selections: [selection], ...(review ? { review } : {}) });
  await store.update((state) => {
    state.decks.push({ id: "platform", title: "Platform", course: "QA", cards: [card("c1", "Recording 1, part 2?", 0, selections[0], mastered), card("c2", "Recording 1, part 6?", 0, selections[1]), card("c3", "Recording 2, part 4?", 0, selections[2], weak),
      card("c4", "Recording 4, part 5?", 0, selections[3]), card("c5", "Recording 5, part 3?", 1, selections[4], mastered)] });
  });
  return ids;
}

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "coverage", { accent: "cinnabar" });
  return { ...base, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runCoverageQa(options) {
  // The review of batches 3 and 5 is cut off for as long as `inject.on`: those parts fail, and their planned targets are what the top-up writes again.
  const inject = { on: true }, inner = createFakeModel({ latencyMs: 12, usage: true });
  const partOf = (o) => { const found = /Part (\d+)\//.exec(o.stage || ""); return o.part ?? (found ? Number(found[1]) : null); };
  const model = async (system, prompt, o = {}) => {
    const reply = await inner(system, prompt, o);
    return inject.on && system.startsWith("Act as a strict assessment editor") && [3, 5].includes(partOf(o)) ? reply.slice(0, Math.floor(reply.length * 0.6)) : reply;
  };
  return runQa({ name: "coverage", options, model, localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }), "study-reader": null },
    seed: async (root) => { options.ids = await seed(root); },
    async run({ page, server, t, step, check, summary }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const ids = options.ids, zh = options.lang === "zh", narrow = options.width < 900;
      const idle = async () => { for (let guard = 0; guard < 600; guard += 1) { if (!(await call("snapshot", {})).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status))) return; await sleep(250); } throw new Error("the jobs did not finish"); };
      const viewer = page.locator(".study-document-viewer"), facts = {};
      summary.facts = facts;
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const openOutline = async () => { if (!(await viewer.locator(".reader-outline").count())) await viewer.getByRole("button", { name: t("目录", "Contents"), exact: true }).click(); await viewer.locator(".reader-outline").waitFor(); };
      const closeOutlineIfNarrow = async () => { if (narrow && (await viewer.locator(".reader-scrim").count())) { await viewer.locator(".reader-scrim").click({ position: { x: options.width - 8, y: 200 } }); await sleep(300); } };
      const closeReader = async () => { await page.keyboard.press("Escape"); await sleep(300); if (await viewer.count()) await page.locator("dialog[open]").getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); await sleep(400); };
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const numbers = (c) => `${c.covered}/${c.leaves}`;

      // The question run whose two batches fail.
      const started = await call("generate", { sourceIds: ids, count: 15, kind: "quiz", title: t("覆盖演示", "Coverage demo"), performance: { fillRounds: 0 } });
      await idle();
      let snapshot = await call("snapshot", {});
      const job = snapshot.jobs.find((item) => item.id === started.jobId), draft = snapshot.drafts[0];
      facts.run = { status: job.status, stage: job.stage, parts: job.parts, cards: draft.cards.length, requested: draft.editorial.requested };
      const before = await call("coverage.get", { draftId: draft.id }), doc = await call("coverage.get", { sourceId: ids[0] });
      facts.before = { draft: before.coverage && { covered: before.coverage.covered, plannedFailed: before.coverage.plannedFailed, neverPlanned: before.coverage.neverPlanned, leaves: before.coverage.leaves, percent: before.coverage.percentLeaves },
        document: { covered: doc.coverage.covered, leaves: doc.coverage.leaves, percent: doc.coverage.percentLeaves }, round: { sections: before.round.sections, questions: before.round.questions, left: before.round.left, rounds: before.round.rounds } };
      facts.plans = draft.editorial.partPlans.map((plan) => [plan.part, plan.status, plan.reason || "", (plan.ranges || []).map((range) => [range.sourceId.slice(-3), range.start, range.end]), plan.targets.map((target) => [target.status, target.sourceId.slice(-3), target.start])]);
      facts.failedSections = before.coverage.sections.filter((section) => section.state === "planned-failed").map((section) => [section.key.slice(-12), section.start, section.end, section.reason, section.parts]);
      await check("the run leaves a short draft with planned-and-failed sections", async () => { assert.ok(before.coverage.plannedFailed >= 1, "planned and failed"); assert.ok(before.coverage.covered >= 5); assert.ok(before.coverage.neverPlanned > 40); });

      await step("sources-row-chip", async () => {
        await goto("sources");
        const row = page.locator(".source-doc", { hasText: RECORDING_NAMES[0] }).first();
        await row.waitFor();
        const chip = row.locator("[data-coverage-chip]");
        assert.equal((await chip.innerText()).trim(), t(`覆盖 ${doc.coverage.percentLeaves}%`, `Covered ${doc.coverage.percentLeaves}%`));
        const mastery = await row.locator(".mastery-line").innerText();
        facts.rowMastery = mastery.trim();
        assert.ok(/掌握|Mastery|\d/.test(mastery), mastery);
        const heights = await row.evaluate((element) => element.getBoundingClientRect().height);
        facts.rowHeight = Math.round(heights);
        await noOverflow("资料 page");
      });

      await step("reader-toolbar-chip-and-outline", async () => {
        await page.locator(".source-doc", { hasText: RECORDING_NAMES[0] }).first().locator(".source-main").click();
        await viewer.waitFor();
        await sleep(1500);
        await openOutline();
        const head = await viewer.locator("[data-coverage-head]").innerText();
        assert.ok(head.includes(numbers(doc.coverage)), `the outline header says ${JSON.stringify(head)}, the document is ${numbers(doc.coverage)}`);
        const volume = doc.coverage.sections.filter((section) => section.sourceId === ids[0]);
        const marks = async (state) => viewer.locator(`.reader-outline [data-coverage-mark="${state}"]`).count();
        const seen = { covered: await marks("covered"), failed: await marks("planned-failed"), never: await marks("never-planned") };
        const wanted = { covered: volume.filter((s) => s.state === "covered").length, failed: volume.filter((s) => s.state === "planned-failed").length, never: volume.filter((s) => s.state === "never-planned").length };
        facts.marks = { seen, wanted };
        assert.deepEqual(seen, wanted, "one mark per section of this volume, with the state coverage.get gives it");
        assert.ok((await viewer.locator(".reader-outline .mastery-mark").count()) >= 4, "the mastery rings are still there beside the squares");
        const squares = await viewer.locator(".reader-outline .cov-mark svg rect").count(), circles = await viewer.locator(".reader-outline .cov-mark svg circle").count();
        assert.ok(squares >= 1 && circles === 0, "coverage is a square");
        if (!narrow) assert.equal((await viewer.locator(".reader-toolbar__coverage").innerText()).trim(), t(`覆盖 ${doc.coverage.percentLeaves}%`, `Covered ${doc.coverage.percentLeaves}%`), "the toolbar chip");
        const label = await viewer.locator('.reader-outline [data-coverage-mark="planned-failed"]').first().getAttribute("aria-label").catch(() => null);
        if (wanted.failed) assert.match(label, zh ? /计划了没出成：/ : /Planned, not produced: /);
        await noOverflow("the reader");
      });
      await step("reader-mark-tooltip", async () => {
        const mark = viewer.locator(".reader-outline [data-coverage-mark]").nth(1);
        await mark.hover();
        const tip = page.locator('[role="tooltip"]:popover-open').first();
        await tip.waitFor({ timeout: 5000 });
        facts.tooltip = (await tip.innerText()).replace(/\s+/g, " ");
        assert.ok(facts.tooltip.includes(t("覆盖只说出没出过题", "Coverage only says")) || facts.tooltip.includes(t("这一节", "This section")), facts.tooltip);
      });
      await step("reader-outline-only-uncovered", async () => {
        await viewer.locator("[data-coverage-filter]").check();
        await sleep(300);
        assert.equal(await viewer.locator('.reader-outline [data-coverage-mark="covered"]').count(), 0, "only what has no question");
        const rows = await viewer.locator(".reader-outline__link").count();
        facts.onlyUncoveredRows = rows;
        assert.ok(rows >= 2);
      });
      await viewer.locator("[data-coverage-filter]").uncheck();
      await step("practice-panel-coverage-line", async () => {
        await closeOutlineIfNarrow();
        await viewer.getByRole("button", { name: t("做这几页的题", "Practise these pages"), exact: false }).first().click();
        const panel = viewer.locator(".reader-practice__panel");
        await panel.waitFor();
        facts.panel = (await panel.innerText()).split("\n").filter(Boolean).slice(0, 8);
        await noOverflow("the practice panel");
      });
      await page.keyboard.press("Escape");
      await closeReader();

      await step("console-parts-coverage", async () => {
        await goto("tasks");
        await page.locator(".tc-detail").first().waitFor({ state: "attached", timeout: 30000 });
        await page.locator(".tc-row").first().dispatchEvent("click");
        await page.locator(".tc-tab", { hasText: t("资料部分", "Source parts") }).first().click();
        await page.locator(".tc-partrow").first().waitFor({ state: "attached", timeout: 15000 });
        await page.locator("[data-part-coverage]").first().waitFor({ state: "attached", timeout: 15000 });
        const rows = await page.locator("[data-part-coverage]").allInnerTexts();
        facts.partRows = rows;
        assert.equal(rows.length, job.parts, "every part says what its range has");
        const sum = rows.reduce((total, row) => total + Number(/(\d+)\s*\//.exec(row)[1]), 0);
        facts.partRowsCovered = sum;
        assert.equal(sum, before.coverage.covered, "the parts of the run add up to the draft's covered sections");
        await noOverflow("the console");
      });
      await step("console-strip-reason", async () => {
        const failed = job.partReport?.parts?.find((part) => part.status === "failed") || null;
        const target = page.locator(".tc-partrow", { has: page.locator(".tc-dot[data-state=\"fail\"]") }).first();
        await (await target.count() ? target : page.locator(".tc-partrow").nth(2)).locator(".tc-filerow").click();
        const strip = await page.locator(".tc-strip--parts").innerText();
        facts.strip = strip.replace(/\s+/g, " ");
        assert.ok(strip.includes(t("没有题的小节", "Sections with no question")), strip);
        if (failed) assert.ok(strip.includes(t("审阅回复格式不对", "review reply")), strip);
      });
      await step("console-header-topup-preview", async () => {
        await page.locator("[data-coverage-open]").click();
        const panel = page.locator(".cov-popover__panel");
        await panel.waitFor();
        const sentence = await panel.locator("[data-coverage-round]").innerText();
        facts.consoleRound = sentence;
        assert.ok(sentence.includes(String(before.round.sections)) && sentence.includes(String(before.round.questions)), sentence);
        await panel.locator("[data-token-estimate]").waitFor();
        await page.locator(".cov-popover__panel [data-token-estimate] .token-estimate__line:not(.token-estimate__line--loading)").waitFor({ timeout: 15000 });
        facts.consoleEstimate = (await panel.locator("[data-token-estimate]").innerText()).replace(/\s+/g, " ");
        await noOverflow("the console popover");
      });
      await page.keyboard.press("Escape");

      await step("home-before-the-top-up", async () => {
        await goto("library");
        await page.locator(".draft-row").first().waitFor();
        await page.locator(".draft-row").first().scrollIntoViewIfNeeded();
        const meta = await page.locator(".draft-meta__facts").first().innerText();
        assert.ok(meta.includes(numbers(before.coverage)), meta);
        facts.homeMetaBefore = meta;
        assert.equal(await page.locator(".draft-row [data-coverage-start]").count(), 1, "the home row has the one top-up");
        await noOverflow("the home");
      });
      await step("draft-page-summary", async () => {
        await page.locator(".draft-open").first().click();
        await page.locator("[data-coverage-summary]").waitFor({ timeout: 15000 });
        await page.evaluate(() => { const box = document.querySelector("[data-coverage-summary]").getBoundingClientRect(); window.scrollBy(0, box.top - 150); });
        await sleep(300);
        facts.summaryShot = "the summary at the top of the draft page";
        const line = await page.locator("[data-coverage-line]").innerText();
        facts.draftLine = line;
        assert.ok(line.includes(numbers(before.coverage)) && line.includes(`${before.coverage.percentLeaves}%`), line);
        assert.equal(await page.locator("[data-group]").count(), before.coverage.groups.length, "one row per recording");
        const list = page.locator("[data-coverage-list]");
        await list.locator("summary").click();
        assert.equal(await list.locator("li[data-section]").count(), before.coverage.plannedFailed + before.coverage.neverPlanned, "nothing left out of the list");
        assert.equal(await page.locator("[data-coverage-start]").count(), 1, "one top-up button on the page");
        assert.equal(await page.locator("[data-add-from-sources], .draft-addfrom").count(), 0, "the second control is gone");
        await noOverflow("the draft page");
      });
      await step("draft-page-topup-block", async () => {
        await page.locator("[data-coverage-start]").scrollIntoViewIfNeeded();
      });
      await step("draft-link-opens-the-reader-at-the-section", async () => {
        const first = page.locator("[data-coverage-list] li[data-section]").first();
        const wantedKey = await first.getAttribute("data-section");
        await first.locator("[data-section-open]").click();
        await viewer.waitFor({ timeout: 15000 });
        await sleep(900);
        facts.openedAt = (await viewer.locator(".reader-toolbar__where").innerText()).trim();
        facts.openedKey = wantedKey;
        assert.ok(facts.openedAt.length > 0, "the reader says where it is");
      });
      await closeReader();

      await step("run-the-top-up", async () => {
        inject.on = false;
        await page.locator("[data-coverage-start]").waitFor({ timeout: 15000 });
        await page.locator("[data-coverage-start]").scrollIntoViewIfNeeded();
        await page.locator("[data-coverage-start]").click();
        await page.locator("[data-draft-work]").first().waitFor({ timeout: 20000 });
        facts.working = (await page.locator("[data-draft-work]").first().innerText()).trim();
        await idle();
        await sleep(1500);
      });
      const after = await call("coverage.get", { draftId: draft.id });
      facts.after = { covered: after.coverage.covered, plannedFailed: after.coverage.plannedFailed, neverPlanned: after.coverage.neverPlanned, leaves: after.coverage.leaves, percent: after.coverage.percentLeaves,
        round: { sections: after.round.sections, left: after.round.left } };
      await step("the-numbers-change", async () => {
        const line = await page.locator("[data-coverage-line]").innerText();
        facts.draftLineAfter = line;
        assert.ok(line.includes(numbers(after.coverage)), `the page says ${JSON.stringify(line)}, the backend ${numbers(after.coverage)}`);
        assert.ok(after.coverage.covered > before.coverage.covered, "more sections have a question");
        assert.ok(after.coverage.plannedFailed < before.coverage.plannedFailed, "the failed batches were written again from their plan");
        const draftNow = (await call("snapshot", {})).drafts.find((item) => item.id === draft.id);
        assert.equal(draftNow.editorial.requested, draft.editorial.requested, "what the draft was asked for did not silently grow");
        facts.requested = { before: draft.editorial.requested, after: draftNow.editorial.requested, cards: draftNow.cards.length };
        await noOverflow("the draft page after the top-up");
      });
      await step("home-draft-row", async () => {
        await goto("library");
        await page.locator(".draft-row").first().waitFor();
        await page.locator(".draft-row").first().scrollIntoViewIfNeeded();
        const meta = await page.locator(".draft-meta__facts").first().innerText();
        facts.homeMeta = meta;
        assert.ok(meta.includes(numbers(after.coverage)), meta);
        assert.ok(!/还差|short by/i.test(meta), meta);
        await noOverflow("the home");
      });
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runCoverageQa(options);
    finishCli("Coverage", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
