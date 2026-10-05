/* npm run qa:coverage-strength [-- --lang zh|en --theme dark|light --width 1280|420 --accent jade --out <dir>]
   覆盖强度 (lib/coverage-strength.js) in the browser preview, on a seeded temporary library with the fake model: the merged five-recording transcript (80 parts, two volumes: tests/helpers/merged-transcript.mjs).
   The walk is the student's:
     创建题组 → pick the material → the 覆盖强度 control and the one line that says what the choice means for THIS material (「标准：约 343 道题，覆盖 81/81 个部分，分 12 轮，预计 … tok · … 次模型调用」)
     at each level (精简 / 标准 / 完整) and with a custom number of questions → run (标准) → the draft page: the plan line, the coverage and, in the list of sections with no question, the importance and the
     reason of each section (the fake model rates a spread of importances) → the plan the job made is the plan the line promised.
   Every number on screen is compared with the same fact from usage.estimate / coverage.get. Fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json. */
/* global document, window */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";

const world = mergedTranscript();
const iso = (ms) => new Date(ms).toISOString();

async function seed(root) {
  const store = new Store(root), batchId = "qa-strength", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: world.sources.length };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["QA"], title: `${batch.title} · ${index + 1}/${world.sources.length}`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
  });
  return ids;
}

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "coverage-strength", { accent: "cinnabar" });
  return { ...base, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runStrengthQa(options) {
  return runQa({ name: "coverage-strength", options, model: createFakeModel({ latencyMs: 40, usage: true }), latencyMs: 40,
    localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
    seed: async (root) => { options.ids = await seed(root); },
    async run({ page, server, t, step, check, summary }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const ids = options.ids, facts = {}, zh = options.lang === "zh";
      summary.facts = facts;
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const lineText = async () => {
        await page.locator("[data-coverage-consequence] .token-estimate__line:not(.token-estimate__line--loading)").first().waitFor({ timeout: 20000 });
        return (await page.locator("[data-coverage-consequence] .token-estimate__line").first().innerText()).replace(/\s+/g, " ").trim();
      };
      const settle = async (previous) => { for (let guard = 0; guard < 80; guard += 1) { await sleep(250); const now = await lineText(); if (now !== previous) return now; } return lineText(); };
      const level = (name) => page.locator(".cov-strength__levels .sh-seg__item", { hasText: name }).first();
      const idle = async () => { for (let guard = 0; guard < 900; guard += 1) { if (!(await call("snapshot", {})).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status))) return; await sleep(400); } throw new Error("the run did not finish"); };
      const promised = async (extra = {}) => (await call("usage.estimate", { feature: "generate", sourceIds: ids, coverageLevel: "standard", ...extra })).coverage;
      const goal = (text) => Number((zh ? /约 (\d+) 道题|自定义：(\d+) 道题/ : /about (\d+) questions|Custom: (\d+) questions/).exec(text)?.slice(1).find(Boolean));

      await step("create-form-standard", async () => {
        const nav = page.locator('[data-tour="nav-generate"]').first();
        await nav.waitFor({ state: "attached" });
        await nav.dispatchEvent("click");
        await page.locator('[data-tour="generate-sources"]').waitFor({ timeout: 20000 });
        await page.getByRole("button", { name: /选择当前范围|Select this scope/ }).first().click();
        await page.locator("[data-coverage-strength]").scrollIntoViewIfNeeded();
        const line = await lineText(), want = await promised();
        facts.standardLine = line;
        assert.equal(goal(line), want.goal, `the line says ${goal(line)} questions, the estimate ${want.goal}`);
        assert.ok(line.includes(`${want.sections}/${want.leaves}`), line);
        assert.ok(line.includes(zh ? `分 ${want.rounds} 轮` : `${want.rounds} rounds`), line);
        assert.ok(zh ? line.startsWith("标准：") : line.startsWith("Standard:"), line);
        assert.equal(await page.locator("[data-coverage-strength] .sh-seg__item[aria-pressed='true']").innerText(), zh ? "标准" : "Standard", "the default strength");
        const levels = (await page.locator("[data-coverage-levels]").innerText()).replace(/\s+/g, " ");
        facts.levelsLine = levels;
        assert.ok(levels.includes(String((await promised({ coverageLevel: "lean" })).goal)) && levels.includes(String(want.goal)), levels);
        assert.equal(await page.locator("[data-coverage-strength] .generate-stepper").count(), 0, "the bare question-count stepper is gone");
        await noOverflow("the create form");
      });
      await step("create-form-lean", async () => {
        const before = await lineText();
        await level(zh ? "精简" : "Lean").click();
        const line = await settle(before), want = await promised({ coverageLevel: "lean" });
        facts.leanLine = line;
        assert.equal(goal(line), want.goal);
        assert.ok(line.includes(`${want.sections}/${want.leaves}`), line);
        assert.ok(want.sections < want.leaves, "lean covers the sections that matter most, not every one");
        await noOverflow("the create form, lean");
      });
      await step("create-form-full", async () => {
        const before = await lineText();
        await level(zh ? "完整" : "Full").click();
        const line = await settle(before), want = await promised({ coverageLevel: "full" });
        facts.fullLine = line;
        assert.equal(goal(line), want.goal);
        assert.equal(want.sections, want.leaves, "full covers every section");
        await noOverflow("the create form, full");
      });
      await step("create-form-custom-number", async () => {
        await level(zh ? "标准" : "Standard").click();
        const before = await lineText();
        const disclosure = page.locator(".cov-strength__custom");
        await disclosure.locator("summary").click();
        await page.locator("#generate-count").fill("100");
        const line = await settle(before), want = await promised({ coverageLevel: "standard", count: 100 });
        facts.customLine = line;
        assert.equal(goal(line), 100);
        assert.equal(want.rounds, 4);
        assert.ok(line.includes(zh ? "分 4 轮" : "4 rounds"), line);
        await page.locator("#generate-count").scrollIntoViewIfNeeded();
        await noOverflow("the create form, custom number");
      });
      await step("create-form-back-to-standard", async () => {
        const before = await lineText();
        await page.getByRole("button", { name: zh ? "改回按覆盖强度" : "Back to coverage strength" }).click();
        const line = await settle(before);
        assert.ok(zh ? line.startsWith("标准：") : line.startsWith("Standard:"), line);
        await page.locator('[data-tour="generate-submit"]').scrollIntoViewIfNeeded();
      });

      let jobId;
      await step("run-standard", async () => {
        const want = await promised();
        await page.locator('[data-tour="generate-submit"]').click();
        await page.locator(".generation-jobs").first().waitFor({ timeout: 30000 }).catch(() => {});
        await sleep(1000);
        const snapshot = await call("snapshot", {});
        const job = snapshot.jobs.at(-1);
        jobId = job.id;
        facts.started = { goal: job.coveragePlan?.goal, rounds: job.coveragePlan?.rounds, count: job.count };
        assert.equal(job.coveragePlan.goal, want.goal, "the job makes the plan the line promised");
        assert.equal(job.coveragePlan.rounds, want.rounds);
        assert.ok(job.count <= 30, "one round is at most 30 questions");
        await idle();
      });
      let view;
      await step("draft-page-plan-and-reasons", async () => {
        const snapshot = await call("snapshot", {}), job = snapshot.jobs.find((item) => item.id === jobId), draft = snapshot.drafts[0];
        facts.finished = { status: job.status, stage: job.stage, cards: draft.cards.length, requested: draft.editorial.requested, weights: draft.editorial.coverageSpec?.weightSource };
        assert.equal(job.status, "complete", job.stage);
        assert.equal(draft.editorial.coverageSpec.weightSource, "model");
        view = await call("coverage.get", { draftId: draft.id });
        await page.locator('[data-tour="nav-library"]').first().dispatchEvent("click");
        await page.locator(".draft-row").first().waitFor({ timeout: 20000 });
        await page.locator(".draft-open").first().click();
        await page.locator("[data-coverage-summary]").waitFor({ timeout: 20000 });
        await page.evaluate(() => { const box = document.querySelector("[data-coverage-summary]").getBoundingClientRect(); window.scrollBy(0, box.top - 120); });
        const plan = (await page.locator("[data-coverage-plan]").innerText()).trim();
        facts.planLine = plan;
        assert.ok(plan.includes(String(view.coverage.spec.goal)) && plan.includes(zh ? `分 ${view.coverage.spec.rounds} 轮` : `${view.coverage.spec.rounds} rounds`), plan);
        const list = page.locator("[data-coverage-list]");
        await list.locator("summary").click();
        const rows = list.locator("li[data-section]");
        assert.equal(await rows.count(), view.coverage.sections.filter((section) => section.state !== "covered").length, "every uncovered section is listed");
        const whys = await list.locator("[data-section-why]").allInnerTexts();
        facts.whyRows = whys.slice(0, 6);
        assert.equal(whys.length, await rows.count(), "every row says why");
        assert.ok(whys.every((line) => zh ? /^重要性 [1-5]\/5/.test(line.trim()) : /^Importance [1-5]\/5/.test(line.trim())), whys.find((line) => !/重要性|Importance/.test(line)));
        const top = view.coverage.sections.find((section) => section.state !== "covered" && section.weight.importance === 5);
        assert.ok(top, "the fake model rated some sections as the heart of the material");
        assert.ok((await page.locator(`li[data-section="${top.key}"] [data-section-why]`).innerText()).includes(top.weight.reason));
        await noOverflow("the draft page");
      });
      await check("the first round holds the heaviest sections", async () => {
        const spec = (await call("snapshot", {})).drafts[0].editorial.coverageSpec, first = new Set(spec.rounds[0].sectionIds);
        const weight = new Map(spec.weights.map((item) => [item.sectionId, item.importance]));
        const covered = view.coverage.sections.filter((section) => section.state === "covered").map((section) => section.key);
        facts.diff = { covered: covered.length, first: first.size, onlyCovered: covered.filter((key) => !first.has(key)).map((key) => key.slice(-10)), onlyFirst: [...first].filter((key) => !covered.includes(key)).map((key) => key.slice(-10)) };
        // Every section of the first round has its questions. The fake model may also quote a heading line that every recording repeats ("[Part 1: Preview Passage 1]"), which stands first in
        // recording 1: those extras are the fake's non-unique quotes, not sections the plan skipped, so they are reported, not failed.
        assert.deepEqual(facts.diff.onlyFirst, [], `every section of the first round has a question: ${JSON.stringify(facts.diff)}`);
        assert.ok(facts.diff.onlyCovered.length <= 3, `at most a few extras from repeated heading quotes: ${JSON.stringify(facts.diff)}`);
        const important = spec.weights.filter((item) => item.importance === 5).length, inFirst = [...first].filter((key) => weight.get(key) === 5).length;
        facts.roundOne = { sections: first.size, questions: spec.rounds[0].questions, importance5InFirst: inFirst, importance5: important };
        assert.ok(inFirst >= Math.min(important, first.size) - 2, "the importance-5 sections come first");
      });
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runStrengthQa(options);
    finishCli("Coverage strength", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
