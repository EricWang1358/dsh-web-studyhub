import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { estimateFromState, compactEstimate, stageTotals, calibrateEstimate } from "../lib/token-estimate.js";
import { calibrationDir, calibrationFor, createCalibration, learningOff, observedByStage, stageOfStep } from "../lib/estimate-calibration.js";

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


/* #772: the file is the machine's, not the library's (a new book used to start uncalibrated and a long coverage run taught nothing), and a run made on one
   model is not corrected by another model's habits. */
test("the correction lives on the machine, beside the usage ledger, so a new book learns from the first run that finished anywhere", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "study-dsh-home-"));
  const previous = process.env.DSH_HOME, previousOff = process.env.STUDY_NO_CALIBRATION;
  process.env.DSH_HOME = home;
  // scripts/test.mjs turns learning off for its children (one DSH home, many libraries); this test is the app path, so it turns it back on for itself.
  delete process.env.STUDY_NO_CALIBRATION;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    if (previousOff !== undefined) process.env.STUDY_NO_CALIBRATION = previousOff;
    await rm(home, { recursive: true, force: true });
  });
  const machine = createCalibration(calibrationDir()), raw = estimate(), totals = stageTotals(raw), mid = (id) => (totals[id].low + totals[id].high) / 2;
  assert.equal(calibrationDir(), join(home, "study"), "the DSH home the host set, not the library");
  for (let run = 0; run < 3; run++) await machine.record({ stageTotals: totals, actual: { plan: mid("plan") * 2, blueprint: mid("blueprint"), author: mid("author"), review: mid("review") } });
  const written = JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8"));
  assert.equal(written.runs.length, 3);
  const factors = await calibrationFor().factors();
  assert.ok(factors.stages.plan > 1.5, JSON.stringify(factors.stages));
});

test("a run made on one model does not correct another model's estimate, and an older record without a model still counts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "study-calibration-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calibration = createCalibration(dir), raw = estimate(), totals = stageTotals(raw), mid = (id) => (totals[id].low + totals[id].high) / 2;
  const at = (id, ratio) => ({ plan: mid("plan"), blueprint: mid("blueprint"), author: mid("author"), review: mid("review"), [id]: mid(id) * ratio });
  for (let run = 0; run < 3; run++) await calibration.record({ stageTotals: totals, actual: at("author", 2), model: "deepseek/deepseek-v4.1-flash" });
  for (let run = 0; run < 3; run++) await calibration.record({ stageTotals: totals, actual: at("author", 0.5), model: "other/model" });
  const mine = await calibration.factors({ model: "deepseek/deepseek-v4.1-flash" }), theirs = await calibration.factors({ model: "other/model" }), all = await calibration.factors();
  assert.ok(mine.stages.author > 1.5 && mine.stages.author < 2.5, JSON.stringify(mine.stages));
  assert.ok(theirs.stages.author > 0.4 && theirs.stages.author < 0.7, JSON.stringify(theirs.stages));
  assert.equal(all.samples, 6, "without a model the machine's whole record is read");
  await calibration.record({ stageTotals: totals, actual: at("author", 1) });
  const legacy = await calibration.factors({ model: "deepseek/deepseek-v4.1-flash" });
  assert.equal(legacy.samples, 4, "a record from before the model field still counts");
});


/* #771: the estimate sizes output from sample cards, and a thinking model writes several times that (the owner's 宏经 run: ~9k output a call where a card is
   hundreds of tokens). Every finished run now records what each stage wrote per call; the next estimate takes that as its high end and says why. */
test("what each stage writes per call is measured, and the estimate takes it as its output high end", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "study-calibration-thinking-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calibration = createCalibration(dir), raw = estimate();
  assert.deepEqual((await calibration.outputPerCall()).stages, {}, "no runs, nothing measured");
  assert.deepEqual(calibrateEstimate(raw, null, { stages: {} }), raw, "an unmeasured stage leaves the estimate as it was");
  // A call of the writing stage really wrote 9 000 tokens (the thinking is inside the output a provider reports).
  for (let run = 0; run < 3; run++) await calibration.record({ outputs: { author: { calls: 4, output: 4 * 9_000 }, review: { calls: 2, output: 2 * 12_000 } } });
  const perCall = await calibration.outputPerCall();
  assert.equal(perCall.stages.author, 9_000);
  assert.equal(perCall.stages.review, 12_000);
  const raised = calibrateEstimate(raw, null, perCall);
  const author = raised.stages.find(stage => stage.id === "author"), before = raw.stages.find(stage => stage.id === "author");
  assert.equal(author.outputTokens.high, Math.max(before.outputTokens.high, 9_000 * before.calls), "a thinking model writes what a call really writes");
  assert.ok(author.outputTokens.low >= before.outputTokens.low);
  assert.ok(raised.outputTokens.high > raw.outputTokens.high, "the total grows with it");
  assert.ok(raised.totalTokens.high > raw.totalTokens.high);
  assert.ok(raised.notes.includes("includes-thinking"), "and says why the number grew");
  assert.ok(raised.thinking.samples >= 3);
  const untouched = raised.stages.find(stage => stage.id === "plan");
  assert.deepEqual(untouched.outputTokens, raw.stages.find(stage => stage.id === "plan").outputTokens, "a stage nobody measured is left alone");
});

test("one model's output does not raise another model's estimate, and a record without measurements teaches nothing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "study-calibration-thinking-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calibration = createCalibration(dir), raw = estimate();
  for (let run = 0; run < 3; run++) await calibration.record({ outputs: { author: { calls: 1, output: 9_000 } }, model: "other/model" });
  for (let run = 0; run < 3; run++) await calibration.record({ stages: { author: [1, 2] }, model: "mine" });
  assert.deepEqual((await calibration.outputPerCall({ model: "mine" })).stages, {}, "the other model's measurements are not mine");
  assert.equal((await calibration.outputPerCall({ model: "other/model" })).stages.author, 9_000);
  assert.equal((await calibration.outputPerCall()).stages.author, 9_000, "without a model the machine's whole record is read");
  assert.deepEqual(calibrateEstimate(raw, null, await calibration.outputPerCall({ model: "mine" })), raw, "nothing measured for this model: the estimate is untouched");
});

/* #772 review: the old file lived in each learning library. The machine's file takes it over once, leaves the old file where it is, and never counts a run twice. */
test("a library's own earlier file is carried into the machine's once, left untouched, and never counted twice", async (t) => {
  const machine = await mkdtemp(join(tmpdir(), "study-calibration-machine-")), library = await mkdtemp(join(tmpdir(), "study-calibration-library-"));
  t.after(() => Promise.all([rm(machine, { recursive: true, force: true }), rm(library, { recursive: true, force: true })]));
  const raw = estimate(), totals = stageTotals(raw), mid = (id) => (totals[id].low + totals[id].high) / 2;
  const old = JSON.stringify({ runs: [1, 2, 3].map((n) => ({ at: `2026-10-0${n}T00:00:00.000Z`, stages: { author: [Math.round(mid("author")), Math.round(mid("author") * 2)] } })) });
  await writeFile(join(library, "estimate-calibration.json"), old);
  const calibration = createCalibration(machine);
  assert.deepEqual((await calibration.factors()).stages, {}, "without naming the library there is nothing to carry over");
  const carried = await calibration.factors({ library });
  assert.equal(carried.samples, 3);
  assert.ok(Math.abs(carried.stages.author - 2) < 0.01, JSON.stringify(carried));
  await assert.rejects(readFile(join(machine, "estimate-calibration.json"), "utf8"), "reading an estimate writes nothing");
  await calibration.record({ stageTotals: totals, actual: { author: mid("author") * 2 }, library });
  await calibration.record({ stageTotals: totals, actual: { author: mid("author") * 2 }, library });
  assert.equal((await calibration.factors({ library })).samples, 5, "three carried over and two new, not three more each time");
  assert.equal(JSON.parse(await readFile(join(machine, "estimate-calibration.json"), "utf8")).runs.length, 5);
  assert.equal(await readFile(join(library, "estimate-calibration.json"), "utf8"), old, "the library's own file is left as it was");
  const another = createCalibration(machine);
  assert.equal((await another.factors({ library })).samples, 5, "a fresh process reads the same, with no second import");
  await writeFile(join(library, "estimate-calibration.json"), "not json");
  assert.equal((await createCalibration(await mkdtemp(join(tmpdir(), "study-calibration-machine-"))).factors({ library })).samples, 0, "a damaged old file carries nothing");
});

test("a test process that was not given a DSH home never writes to the real one", () => {
  const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
  try {
    delete process.env.STUDY_NO_CALIBRATION;
    delete process.env.DSH_HOME;
    assert.equal(learningOff(), true, "node --test with no DSH_HOME: learning is off, the real ~/.dsh stays untouched");
    process.env.DSH_HOME = tmpdir();
    assert.equal(learningOff(), false, "a test that names a home learns there");
    process.env.STUDY_NO_CALIBRATION = "1";
    assert.equal(learningOff(), true);
  } finally {
    for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
