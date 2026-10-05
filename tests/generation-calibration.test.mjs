import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { estimateFromState, compactEstimate, stageTotals, calibrateEstimate } from "../lib/token-estimate.js";
import { createCalibration, observedByStage, stageOfStep } from "../lib/estimate-calibration.js";

/* #218: the estimate learns from this library's own runs. Each finished generation job records, per stage, what it used against what was
   estimated; the median ratio of the last runs scales the next estimate (stage by stage), so the range covers what a run really costs here.
   Generation details show tokens per stage. */

const long = (n) => `Section ${n}. ${"Architecture includes the principles guiding a system's design and evolution. ".repeat(40)}`;
const state = { sources: [{ id: "s", title: "Notes", text: long(1) }], decks: [], drafts: [], courses: [], settings: {}, attempts: [], runs: [] };
const estimate = () => estimateFromState("generate", { sourceIds: ["s"], count: 6, kind: "flashcard", language: "English" }, state, {});
const job = (usage) => ({ steps: [
  { stage: "Planning evidence and learning targets · Group 1/1", tokenUsage: { uncachedInputTokens: usage.plan, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } },
  { stage: "Part 1/1 · Preparing supported answers and scenarios", tokenUsage: { uncachedInputTokens: usage.blueprint, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } },
  { stage: "Part 1/1 · Writing and self-checking questions", tokenUsage: { uncachedInputTokens: usage.author, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } },
  { stage: "Part 1/1 · Reviewing ambiguity and source support", tokenUsage: { uncachedInputTokens: usage.review, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 } },
  { stage: "Part 1/1 · Writing replacement questions from reserve targets", tokenUsage: { uncachedInputTokens: usage.author2 || 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } },
].map((step, index) => ({ id: `s${index}`, ...step })) });

test("the stage of a recorded step, and the tokens a job used per stage", () => {
  assert.equal(stageOfStep({ stage: "Part 1/1 · Preparing supported answers and scenarios" }), "blueprint");
  assert.equal(stageOfStep({ stage: "Part 1/1 · Reviewing ambiguity and source support" }), "review");
  assert.equal(stageOfStep({ stage: "Repairing flagged questions within this run" }), "repair");
  assert.equal(stageOfStep({ stage: "Waiting" }), undefined);
  const used = observedByStage(job({ plan: 1000, blueprint: 2000, author: 3000, review: 4000, author2: 500 }));
  assert.deepEqual(used, { plan: 1000, blueprint: 2000, author: 3500, review: 4000 }, "replacement writing counts as writing");
});

test("a calibrated estimate covers what this library's runs really used, stage by stage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-calibration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = estimate(), totals = stageTotals(raw), mid = (id) => (totals[id].low + totals[id].high) / 2;
  assert.ok(totals.plan && totals.author && totals.review, JSON.stringify(Object.keys(totals)));
  const calibration = createCalibration(root);
  assert.deepEqual((await calibration.factors()).stages, {}, "no runs, no correction");
  assert.deepEqual(calibrateEstimate(raw, await calibration.factors()), raw, "an uncalibrated estimate is returned as it is");
  // The reviews and writing cost 2.5x and 1.6x what was estimated, planning as estimated.
  const actual = { plan: mid("plan"), blueprint: mid("blueprint"), author: mid("author") * 1.6, review: mid("review") * 2.5 };
  for (let run = 0; run < 2; run++) await calibration.record({ stageTotals: totals, actual });
  assert.deepEqual((await calibration.factors()).stages, {}, "two runs are not enough to move an estimate");
  await calibration.record({ stageTotals: totals, actual });
  const factors = await calibration.factors();
  assert.ok(Math.abs(factors.stages.review - 2.5) < 0.01 && Math.abs(factors.stages.author - 1.6) < 0.01 && Math.abs(factors.stages.plan - 1) < 0.01, JSON.stringify(factors));
  const better = calibrateEstimate(raw, factors);
  const used = Object.values(actual).reduce((sum, value) => sum + value, 0);
  assert.ok(raw.totalTokens.high < used, "the raw estimate missed this library's real cost");
  assert.ok(better.totalTokens.low <= used && used <= better.totalTokens.high, `calibrated ${better.totalTokens.low}-${better.totalTokens.high} covers ${used}`);
  assert.deepEqual(better.calls, raw.calls, "the number of calls is not rescaled");
  assert.ok(better.notes.includes("calibrated"));
  assert.equal(better.calibration.samples, 3);
  assert.equal(better.calibration.deviates, true, "off by more than 50% for the long run: the details say so");
  assert.equal(compactEstimate(better).calibration.samples, 3);
  assert.deepEqual(compactEstimate(raw).stageTotals, totals, "the job keeps the uncalibrated stage totals the next ratio is read against");
});

test("calibration keeps only recent runs, clamps wild ratios and starts afresh from a damaged file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-calibration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calibration = createCalibration(root, { keep: 4 });
  const totals = { author: { low: 100, high: 200 } };
  for (const ratio of [1, 1, 1, 50, 50, 50, 50]) await calibration.record({ stageTotals: totals, actual: { author: 150 * ratio } });
  const factors = await calibration.factors();
  assert.equal(factors.samples, 4, "only the last runs count");
  assert.equal(factors.stages.author, 4, "a wild ratio is clamped");
  await writeFile(join(root, "estimate-calibration.json"), "not json");
  assert.deepEqual((await createCalibration(root).factors()).stages, {});
  await createCalibration(root).record({ stageTotals: totals, actual: { author: 0 } });
  assert.deepEqual((await createCalibration(root).factors()).stages, {}, "a run that used nothing teaches nothing");
});

test("generation details show the tokens of each stage next to the estimate", async () => {
  const require = createRequire(import.meta.url);
  const compiled = await build({ stdin: { contents: `export { default as GenerationTrace } from './ui/GenerationTrace.jsx'; export { stageUsageRows } from './ui/generation-status.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
  const m = module.exports;
  const finished = { id: "j", status: "complete", type: "generate", stage: "Draft ready", parts: 1, savedCount: 6, requestedTotal: 6,
    estimate: { totalTokens: { low: 9000, high: 12000 }, calls: { low: 4, high: 6 }, stageTotals: { plan: { low: 1000, high: 2000 }, review: { low: 3000, high: 4000 } } },
    ...job({ plan: 1500, blueprint: 2000, author: 3000, review: 9000 }), tokenUsage: { uncachedInputTokens: 15500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 6 } };
  const rows = m.stageUsageRows(finished);
  assert.deepEqual(rows.map((row) => row.code), ["plan", "blueprint", "author", "review"]);
  assert.equal(rows.find((row) => row.code === "review").tokens, 9000);
  assert.deepEqual(rows.find((row) => row.code === "review").estimate, { low: 3000, high: 4000 });
  m.setUiLanguage("zh");
  const out = renderToStaticMarkup(React.createElement(m.GenerationTrace, { job: finished, defaultOpen: true })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(out, /各阶段用量/);
  assert.match(out, /独立审阅 9,?000 tok（预计 3,?000–4,?000）/);
  m.setUiLanguage("en");
  const english = renderToStaticMarkup(React.createElement(m.GenerationTrace, { job: finished, defaultOpen: true })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  m.setUiLanguage("zh");
  assert.match(english, /Tokens per stage/);
  assert.match(english, /Independent review 9,?000 tok \(estimated 3,?000–4,?000\)/);
});
