/* node scripts/qa/all-materials.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   Flow A (the owner's report of 2026-10-11: 「选了 8 份资料，只有 2 份出了题」) in the browser preview, on a seeded temporary library with the fake model: eight lecture recordings merged into one
   transcript (tests/helpers/materials-fixture.mjs), and a draft whose questions cover seven of them.
     创建题组 → pick the recordings → the line 「选了 8 份资料，每份都会出题。」 under the estimate, and with a custom count of 5 the one line 「已从 5 题自动提高到 8 题」 (no dialog)
     → the draft page: 「选了 8 份，7 份已出题，1 份没出题」, the eighth with its reason and its own 补题 → the press runs a fill round for that recording → 「都已出题」.
   Every number on screen is compared with usage.estimate / coverage.get. One screenshot per step and <out>/summary.json; no horizontal overflow at the width asked for. */
/* global document, window */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { eightRecordings } from "../../tests/helpers/materials-fixture.mjs";

const world = eightRecordings();
const iso = (ms) => new Date(ms).toISOString();
const SENTENCE = /Recording (\d+), part (\d+), point (\d+)\.1: [^.]{20,90}/g;

async function seed(root) {
  const store = new Store(root), batch = { id: "qa-eight", title: `${world.names[0]} + 7`, members: world.names.map((filename, index) => ({ order: index + 1, filename, hash: String(index + 1).padStart(64, "0") })), volumes: world.sources.length };
  const ids = world.sources.map((_, index) => `audio-batch-qa-eight-v${index + 1}`);
  // Questions on recordings 1-4 and 6-8 (one each): recording 5 has none, as if its round had come back short.
  const quotes = [];
  world.sources.forEach((source, index) => { for (const match of source.text.matchAll(SENTENCE)) if (match[2] === "1" && match[3] === "1" && match[1] !== "5") quotes.push({ sourceId: ids[index], quote: match[0], recording: Number(match[1]) }); });
  const cards = [...new Map(quotes.map((item) => [item.recording, item])).values()].map((item, index) => ({ id: `qa-card-${index + 1}`, kind: "quiz", topic: "Platform", objective: `Objective ${item.recording}`,
    prompt: `Which statement matches lecture ${item.recording}?`, answer: "The first option.", hint: "Compare with the passage.", explanation: "The passage supports the first option.", misconception: "Mixing scopes.",
    citations: [{ sourceId: item.sourceId, quote: item.quote }],
    options: [{ id: "a", text: "The first option.", correct: true, explanation: "Supported." }, { id: "b", text: "The second option.", correct: false, explanation: "Not supported." }, { id: "c", text: "The third option.", correct: false, explanation: "Not supported." }] }));
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["QA"], title: `${batch.title} · ${index + 1}/${world.sources.length}`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
    state.drafts.push({ id: "qa-draft-eight", title: "Eight lectures", course: "QA", draftVersion: 1, cards,
      editorial: { requested: cards.length, generated: cards.length, generation: { sourceIds: ids, kind: "quiz", language: "中文" }, failures: [], reviewedCards: {} } });
  });
  return ids;
}

export const parseArgs = (argv) => { const base = parseQaArgs(argv, "all-materials"); return { ...base, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width }; };

export async function runAllMaterialsQa(options) {
  return runQa({ name: "all-materials", options, model: createFakeModel({ latencyMs: 30, usage: true }), latencyMs: 30,
    seed: async (root) => { options.ids = await seed(root); },
    async run({ page, server, step, summary }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const ids = options.ids, facts = {}, zh = options.lang === "zh";
      summary.facts = facts;
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const idle = async () => { for (let guard = 0; guard < 600; guard += 1) { if (!(await call("snapshot", {})).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status))) return; await sleep(400); } throw new Error("the run did not finish"); };
      const textOf = async (selector) => (await page.locator(selector).first().innerText()).replace(/\s+/g, " ").trim();
      const until = async (selector, test, what) => { for (let guard = 0; guard < 120; guard += 1) { const value = await page.locator(selector).count() ? await textOf(selector) : ""; if (test(value)) return value; await sleep(250); } throw new Error(`waited for ${what}`); };

      await step("create-form-materials-line", async () => {
        const nav = page.locator('[data-tour="nav-generate"]').first();
        await nav.waitFor({ state: "attached" });
        await nav.dispatchEvent("click");
        await page.locator('[data-tour="generate-sources"]').waitFor({ timeout: 20000 });
        await page.getByRole("button", { name: /选择当前范围|Select this scope/ }).first().click();
        const want = (await call("usage.estimate", { feature: "generate", sourceIds: ids, coverageLevel: "standard" })).coverage.materials;
        assert.deepEqual([want.selected, want.planned], [8, 8]);
        const line = await until("[data-generate-estimate] [data-coverage-materials]", (value) => value.length > 0, "the materials line");
        facts.formLine = line;
        assert.equal(line, zh ? "选了 8 份资料，每份都会出题。" : "8 materials selected; each of them will get questions.");
        await page.locator("[data-generate-estimate]").scrollIntoViewIfNeeded();
        await noOverflow("the create form");
      });
      await step("create-form-raised-count", async () => {
        const more = page.locator("summary", { hasText: zh ? "更多选项" : "More options" }).first();
        if (await more.count()) await more.click().catch(() => {});
        const custom = page.locator(".cov-strength__custom summary").first();
        await custom.scrollIntoViewIfNeeded();
        await custom.click();
        await page.locator("#generate-count").fill("5");
        const line = await until("[data-coverage-raised]", (value) => value.length > 0, "the raised line");
        facts.raisedLine = line;
        const want = (await call("usage.estimate", { feature: "generate", sourceIds: ids, coverageLevel: "standard", count: 5 })).coverage.raised;
        assert.deepEqual(want, { from: 5, to: 8 });
        assert.ok(line.includes("5") && line.includes("8"), line);
        assert.equal(await page.locator("[role=dialog], [role=alertdialog]").count(), 0, "a notice, never a dialog");
        await page.locator("[data-coverage-raised]").scrollIntoViewIfNeeded();
        await noOverflow("the create form, raised count");
      });
      let view;
      await step("draft-page-materials-report", async () => {
        view = await call("coverage.get", { draftId: "qa-draft-eight" });
        assert.deepEqual([view.materials.selected, view.materials.covered, view.materials.missing], [8, 7, 1]);
        await page.locator('[data-tour="nav-library"]').first().dispatchEvent("click");
        await page.locator(".draft-row").first().waitFor({ state: "attached", timeout: 20000 });
        // The 待发布 list is folded on the library page: open it, then the draft.
        if (!(await page.locator(".draft-open").first().isVisible())) await page.locator("details:has(.draft-row) > summary").first().click();
        await page.locator(".draft-open").first().click();
        await page.locator("[data-materials-report]").waitFor({ timeout: 20000 });
        await page.evaluate(() => { const box = document.querySelector("[data-materials-report]").getBoundingClientRect(); window.scrollBy(0, box.top - 120); });
        const head = await textOf(".cov-materials__head");
        facts.draftLine = head;
        assert.equal(head, zh ? "选了 8 份，7 份已出题，1 份没出题" : "8 materials selected: 7 with questions, 1 without");
        const row = await textOf("[data-materials-report] li[data-material]");
        facts.row = row;
        assert.ok(row.startsWith("lecture-05.mp3"), row);
        assert.equal(await page.locator("[data-material-topup]").count(), 1);
        await noOverflow("the draft page");
      });
      await step("material-topup", async () => {
        await page.locator("[data-material-topup]").click();
        await sleep(800);
        await idle();
        const after = await call("coverage.get", { draftId: "qa-draft-eight" });
        facts.after = { covered: after.materials.covered, missing: after.materials.missing, lastRound: after.run ? (await call("snapshot", {})).drafts[0].editorial.coverageSpec?.rounds?.at(-1) : null };
        assert.equal(after.materials.covered, 8, JSON.stringify(after.materials));
        const head = await until(".cov-materials__head", (value) => (zh ? value.includes("都已出题") : value.includes("all of them")), "the line after the top-up");
        facts.afterLine = head;
        await noOverflow("the draft page after the top-up");
      });
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runAllMaterialsQa(options);
    finishCli("All materials", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
