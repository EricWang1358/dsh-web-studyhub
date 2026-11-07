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
import { calibrationDir, calibrationFor, calibrationModel, createCalibration, learningOff, observedByStage, roundCalibrationModel, stageOfStep, stampStepModel } from "../lib/estimate-calibration.js";
import { DEFAULT_OUTPUT_PER_CALL } from "../lib/stage-usage.js";
import { stageSystem } from "../lib/prompt-order.js";

/** No assumed thinking allowance: the tests that check the arithmetic of the ratios alone (production always has the allowance, lib/token-estimate.js). */
const NO_ASSUMPTION = Object.freeze({ stages: {}, samples: 0, defaults: {} });

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
  assert.deepEqual(calibrateEstimate(raw, await calibration.factors(), NO_ASSUMPTION), raw, "an uncalibrated estimate is returned as it is");
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
  assert.deepEqual(calibrateEstimate(raw, null, NO_ASSUMPTION), raw, "an unmeasured stage leaves the estimate as it was");
  // A call of the writing stage really wrote 9 000 tokens (the thinking is inside the output a provider reports).
  for (let run = 0; run < 3; run++) await calibration.record({ outputs: { author: { calls: 4, output: 4 * 9_000 }, review: { calls: 2, output: 2 * 12_000 } } });
  const perCall = { ...(await calibration.outputPerCall()), defaults: {} };
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
  assert.deepEqual(calibrateEstimate(raw, null, { ...(await calibration.outputPerCall({ model: "mine" })), defaults: {} }), raw, "nothing measured for this model: the estimate is untouched");
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

/* #771 review: with no history on the machine the estimate used to stay where the sample cards put it (a third of a thinking model's run). The owner's measured
   finished run (deepseek-v4.1-flash, 513 pages) gives a per-call allowance per stage; it only lifts the HIGH end of a stage, so a model that does not think
   still lands inside the range, and the number says it is an assumption. */
test("with no history, a stage's high end rises to the measured thinking allowance, its low end stays, and the note says it is assumed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "study-calibration-default-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = estimate(), perCall = await createCalibration(dir).outputPerCall();
  assert.deepEqual(perCall.stages, {}, "nothing measured on this machine");
  assert.equal(perCall.defaults, undefined, "the learning store returns what it learned, never the assumption (#771 gate M5)");
  // #771 gate L3: the p90 of the owner's run per call is the top of the range (the p50 is no point here: the low end stays the sample estimate).
  assert.deepEqual({ ...DEFAULT_OUTPUT_PER_CALL }, { plan: 10_632, blueprint: 13_610, author: 13_531, review: 24_253 }, "p90 per stage; no repair stage in the estimate");
  const raised = calibrateEstimate(raw, null, perCall);
  assert.deepEqual(calibrateEstimate(raw, null, null), raised, "a calibration that could not be read still assumes the allowance");
  for (const id of ["blueprint", "author", "review"]) {
    const before = raw.stages.find(stage => stage.id === id), after = raised.stages.find(stage => stage.id === id);
    assert.equal(after.outputTokens.low, before.outputTokens.low, `${id}: a model that does not think still fits the low end`);
    assert.equal(after.outputTokens.high, Math.max(before.outputTokens.high, DEFAULT_OUTPUT_PER_CALL[id] * before.calls), `${id}: the high end is what a thinking model writes`);
  }
  assert.ok(raised.totalTokens.high > raw.totalTokens.high * 2, "the high end is no longer a third of a thinking run");
  assert.equal(raised.totalTokens.low, raw.totalTokens.low, "the low end is the sample estimate");
  assert.ok(raised.notes.includes("thinking-default") && !raised.notes.includes("includes-thinking"), "an assumption, not a measurement");
  // One stage measured on this machine: that stage says "measured", the others stay assumed.
  const mixed = calibrateEstimate(raw, null, { ...perCall, stages: { review: 20_000 }, samples: 3 });
  assert.equal(mixed.stages.find(stage => stage.id === "review").outputTokens.high, Math.max(raw.stages.find(stage => stage.id === "review").outputTokens.high, 20_000 * raw.stages.find(stage => stage.id === "review").calls));
  assert.deepEqual(mixed.notes.filter((code) => /thinking/.test(code)), ["thinking-default"], "one note, the one that explains the assumed stages (#771 gate L2)");
});

test("the headline range says it includes the model's thinking when the estimate raised its high end for it", async () => {
  const require = createRequire(import.meta.url);
  const compiled = await build({ stdin: { contents: `export { estimateSummary } from './ui/token-usage.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
  const m = module.exports, base = { totalTokens: { low: 100_000, high: 400_000 }, calls: { low: 8, high: 10 } };
  m.setUiLanguage("zh");
  assert.doesNotMatch(m.estimateSummary({ ...base, notes: [] }), /含思考/, "a plain estimate says nothing about thinking");
  for (const note of ["includes-thinking", "thinking-default"]) assert.match(m.estimateSummary({ ...base, notes: [note] }), /预计 .*tok（含思考） · /, note);
  m.setUiLanguage("en");
  assert.match(m.estimateSummary({ ...base, notes: ["thinking-default"] }), /tok \(thinking included\) · /);
  m.setUiLanguage("zh");
});

/* #772 gate H1: a coverage run's estimate prices its FIRST round (lib/contexts/generation/generate/estimate.js), while its steps are every round's. Recording the
   whole run against that estimate learned a ratio of about the number of rounds, and three book runs made every estimate on the machine 4x. A run of several
   rounds teaches what its first round used, against the estimate of that round. */
test("a coverage run of several rounds teaches what its first round used, not the whole run against one round's estimate", async (t) => {
  const { StudyService } = await import("../lib/service.js");
  const { reportUsage } = await import("../lib/usage-scope.js");
  const { settleJob } = await import("./helpers/wait.mjs");
  const { mergedTranscript } = await import("./helpers/merged-transcript.mjs");
  const { clusteringModel } = await import("./helpers/clustering-model.mjs");
  const home = await mkdtemp(join(tmpdir(), "study-dsh-home-")), root = await mkdtemp(join(tmpdir(), "study-calibration-rounds-"));
  const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
  process.env.DSH_HOME = home;
  delete process.env.STUDY_NO_CALIBRATION;
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(async () => {
    await service.dispose();
    for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  });
  const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 }), model = clusteringModel();
  service.complete = async (system, prompt, context) => { reportUsage({ uncachedInputTokens: 1000, outputTokens: 100 }); return model.complete(system, prompt, context); };
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split("\n\n")[0]).sections.map((item) => ({ id: item.id, importance: 3, kind: "definition", reason: `Reason for ${item.title}` })) });
  for (const source of world.sources) await service.call("source.add", { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const started = await service.call("generate", { sourceIds: world.sources.map((source) => source.id), coverageLevel: "standard", kind: "quiz" });
  assert.equal(started.plan.rounds, 3);
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, "complete", job.stage);
  const whole = observedByStage(job);
  const runs = JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8")).runs;
  assert.equal(runs.length, 1, "one run, one record");
  const [stage, [estimated, used]] = Object.entries(runs[0].stages).find(([id]) => id === "author");
  const mid = (job.estimate.stageTotals[stage].low + job.estimate.stageTotals[stage].high) / 2;
  assert.ok(Math.abs(estimated - Math.round(mid)) <= 1, "read against the estimate the job kept (the first round's)");
  assert.ok(used < whole.author * 0.6, `the first round's writing (${used}), not all three rounds' (${whole.author})`);
});

/* #772 gate M2-M4, L5: the machine's file is shared by every library and every StudyHub process on the machine. */
test("the machine's file names no library: a carried-in library is kept as a short hash of its folder, once, and only when it carried runs", async (t) => {
  const machine = await mkdtemp(join(tmpdir(), "study-calibration-machine-")), library = await mkdtemp(join(tmpdir(), "study-calibration-library-")),
    empty = await mkdtemp(join(tmpdir(), "study-calibration-empty-"));
  t.after(() => Promise.all([machine, library, empty].map((dir) => rm(dir, { recursive: true, force: true }))));
  await writeFile(join(library, "estimate-calibration.json"), JSON.stringify({ runs: [1, 2, 3].map((n) => ({ at: `2026-10-0${n}T00:00:00.000Z`, stages: { author: [100, 200] } })) }));
  const calibration = createCalibration(machine);
  await calibration.record({ stageTotals: { author: { low: 100, high: 100 } }, actual: { author: 200 }, library: empty });
  await calibration.record({ stageTotals: { author: { low: 100, high: 100 } }, actual: { author: 200 }, library });
  const text = await readFile(join(machine, "estimate-calibration.json"), "utf8"), written = JSON.parse(text);
  assert.equal(written.runs.length, 5, "three carried over and two new");
  assert.ok(!/study-calibration-|tmp|temp/i.test(text), "no folder name in the file");
  assert.equal(written.imported.length, 1, "a library that carried nothing leaves nothing behind");
  assert.match(written.imported[0], /^[0-9a-f]{16}$/);
  if (process.platform === "win32") {
    await calibration.record({ stageTotals: { author: { low: 100, high: 100 } }, actual: { author: 200 }, library: library.toUpperCase() });
    assert.equal((await calibration.factors({ library: library.toLowerCase() })).samples, 6, "the same folder in another case is the same library: not carried twice");
  }
});

test("a damaged file is put aside before the next write; a file that cannot be read now is not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-calibration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const totals = { author: { low: 100, high: 100 } }, path = join(root, "estimate-calibration.json");
  await writeFile(path, "{ not json");
  await createCalibration(root).record({ stageTotals: totals, actual: { author: 150 } });
  const { readdir } = await import("node:fs/promises");
  const aside = (await readdir(root)).filter((name) => name.startsWith("estimate-calibration.json.damaged-"));
  assert.equal(aside.length, 1, "the damaged file is kept beside the new one");
  assert.equal(await readFile(join(root, aside[0]), "utf8"), "{ not json");
  assert.equal(JSON.parse(await readFile(path, "utf8")).runs.length, 1);
  const before = await readFile(path, "utf8");
  const busy = createCalibration(root, { read: async (file) => { if (file === path) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return readFile(file, "utf8"); } });
  await assert.rejects(busy.record({ stageTotals: totals, actual: { author: 150 } }), /busy/, "a read that failed for another reason is no empty file");
  assert.equal(await readFile(path, "utf8"), before, "the machine's history is not wiped");
});

test("two writers on the same folder (two StudyHub processes) both keep their runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-calibration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = createCalibration(root), two = createCalibration(root), totals = { author: { low: 100, high: 100 } };
  await Promise.all(Array.from({ length: 6 }, (_, n) => (n % 2 ? one : two).record({ stageTotals: totals, actual: { author: 100 + n } })));
  assert.equal(JSON.parse(await readFile(join(root, "estimate-calibration.json"), "utf8")).runs.length, 6);
});

test("a partly bad file still calibrates from its good runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-calibration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = (n) => ({ at: `2026-10-0${n}T00:00:00.000Z`, stages: { author: [100, 200] } });
  await writeFile(join(root, "estimate-calibration.json"), JSON.stringify({ runs: [{ at: "x", stages: null }, { at: "y", stages: { author: 5 } }, { at: "z", stages: { author: [0, 10] } }, { at: "w", stages: {} }, good(1), good(2), good(3)] }));
  const factors = await createCalibration(root).factors();
  assert.equal(factors.samples, 3, "only the runs that carry a usable stage count");
  assert.equal(factors.stages.author, 2);
  assert.equal(factors.deviates, true);
});

/* #771 gate H2: the stage ratio is learned from what a run really used, thinking included, so a calibrated stage already carries the thinking. Raising its
   output again counted the thinking twice and put the real cost below the range (probe p1: real 94,644, range 116,127-157,885). A stage with a ratio is
   corrected by the ratio; the measured or assumed thinking only raises a stage this machine has no ratio for. */
test("calibration and measured thinking together still put the real cost inside the range, and the thinking only ever raises the high end", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "study-calibration-both-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = estimate(), totals = stageTotals(raw), calibration = createCalibration(dir);
  // A thinking model: every call writes the mean the owner's run measured (#771 table; the gate's probe p1), the input is as estimated.
  const MEAN = { plan: 3_568, blueprint: 9_437, author: 8_662, review: 12_973 }, actual = {}, outputs = {};
  for (const stage of raw.stages) {
    const written = MEAN[stage.id] * stage.calls;
    actual[stage.id] = (stage.inputTokens.low + stage.inputTokens.high) / 2 + written;
    outputs[stage.id] = { calls: stage.calls, output: written };
  }
  const real = Object.values(actual).reduce((sum, value) => sum + value, 0);
  for (let run = 0; run < 3; run++) await calibration.record({ stageTotals: totals, actual, outputs });
  const factors = await calibration.factors(), measured = await calibration.outputPerCall();
  const ratioOnly = calibrateEstimate(raw, factors, NO_ASSUMPTION), both = calibrateEstimate(raw, factors, measured), assumed = calibrateEstimate(raw, factors, null);
  assert.ok(both.totalTokens.low <= real && real <= both.totalTokens.high, `range ${both.totalTokens.low}-${both.totalTokens.high} covers ${real}`);
  assert.deepEqual(both.totalTokens, ratioOnly.totalTokens, "every stage has a ratio: the thinking is in it already");
  assert.deepEqual(assumed.totalTokens, ratioOnly.totalTokens, "nor is an assumption added on top of a ratio (probe p2 A: the low end fell)");
  assert.ok(!both.notes.some((code) => /thinking/.test(code)), "no thinking note when no stage was raised for it");
  // One stage this machine has no ratio for (plan): only it is raised, by its measured output; the low end never falls.
  const partial = { ...factors, stages: Object.fromEntries(Object.entries(factors.stages).filter(([id]) => id !== "plan")) };
  const partialRatio = calibrateEstimate(raw, partial, NO_ASSUMPTION), partialBoth = calibrateEstimate(raw, partial, measured);
  const plan = raw.stages.find((stage) => stage.id === "plan"), raisedPlan = partialBoth.stages.find((stage) => stage.id === "plan");
  assert.equal(raisedPlan.outputTokens.high, Math.max(plan.outputTokens.high, measured.stages.plan * plan.calls));
  assert.equal(partialBoth.totalTokens.high - partialRatio.totalTokens.high, raisedPlan.outputTokens.high - plan.outputTokens.high, "the total grows by that stage's rise alone");
  assert.ok(partialBoth.totalTokens.low >= partialRatio.totalTokens.low);
  assert.ok(partialBoth.notes.includes("includes-thinking"));
});

test("the job keeps the notes and the per-stage range it showed, beside the raw stage totals it learns against (#771 gate L1)", async () => {
  const raw = estimate(), shown = calibrateEstimate(raw, { stages: { review: 2 }, samples: 3 }, null), kept = compactEstimate(shown, raw);
  assert.deepEqual(kept.stageTotals, stageTotals(raw), "the next ratio is still read against the raw estimate");
  assert.deepEqual(kept.notes, ["calibrated", "thinking-default"], "含思考 and calibrated travel with the job; general advice stays with the form");
  const sum = (side) => Object.values(kept.shownStageTotals).reduce((total, range) => total + range[side], 0);
  assert.deepEqual({ low: sum("low"), high: sum("high") }, shown.totalTokens, "the stages add up to the headline: one fact, one number");
  assert.equal(kept.shownStageTotals.review.high, stageTotals(raw).review.high * 2, "a calibrated stage shows its corrected range");
  const require = createRequire(import.meta.url);
  const compiled = await build({ stdin: { contents: `export { stageUsageRows } from './ui/generation-status.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
  const rows = module.exports.stageUsageRows({ estimate: kept, ...job({ plan: 1, blueprint: 1, author: 1, review: 1 }) });
  assert.deepEqual(rows.find((row) => row.code === "review").estimate, kept.shownStageTotals.review, "the details say the range the headline was made of");
});

test("only the question pipeline gets the thinking allowance (#771 gate L4)", () => {
  const raw = { ...estimate(), feature: "case" };
  assert.deepEqual(calibrateEstimate(raw, null, null), raw, "a case estimate is not given the generation stages' allowance");
});

test("a run that recorded only what it wrote is no sample of the ratio, and a bad outputs entry is dropped (#772 gate L5)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-calibration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calibration = createCalibration(root);
  for (let run = 0; run < 3; run++) await calibration.record({ outputs: { author: { calls: 1, output: 9000 } } });
  const factors = await calibration.factors();
  assert.deepEqual(factors, { stages: {}, samples: 0, deviates: false });
  await writeFile(join(root, "estimate-calibration.json"), JSON.stringify({ runs: [{ at: "a", stages: {}, outputs: { author: 5 } }, { at: "b", stages: {}, outputs: null },
    ...[1, 2, 3].map((n) => ({ at: `c${n}`, stages: {}, outputs: { author: [2, 18000] } }))] }));
  assert.equal((await createCalibration(root).outputPerCall()).stages.author, 9000);
});


test("a planned coverage run records calibration right after round 1 finishes, before round 2 ends, and cleanUp does not record a second time (#772)", async (t) => {
  const { StudyService } = await import("../lib/service.js");
  const { reportUsage } = await import("../lib/usage-scope.js");
  const { settleJob } = await import("./helpers/wait.mjs");
  const { mergedTranscript } = await import("./helpers/merged-transcript.mjs");
  const { clusteringModel } = await import("./helpers/clustering-model.mjs");
  const home = await mkdtemp(join(tmpdir(), "study-dsh-home-")), root = await mkdtemp(join(tmpdir(), "study-calibration-round1-"));
  const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
  process.env.DSH_HOME = home;
  delete process.env.STUDY_NO_CALIBRATION;
  const service = new StudyService(root, {
    coverage: { roundLimit: 8 },
    ...(globalThis.STUDY_RUNTIME_MATRIX_ON ? { model: { provider: "deepseek", model: "deepseek-v4.1-flash" } } : {}),
    jobModelHost: { route: () => ({ provider: "deepseek", model: "deepseek-v4.1-flash" }) },
  });
  let onRoundTwo, releaseRoundTwo;
  const reachedRoundTwo = new Promise((resolve) => { onRoundTwo = resolve; });
  const allowRoundTwo = new Promise((resolve) => { releaseRoundTwo = resolve; });
  t.after(async () => {
    releaseRoundTwo?.();
    await service.dispose();
    for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  });
  const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 }), model = clusteringModel();
  service.complete = async (system, prompt, context) => {
    if (onRoundTwo && stageSystem(system, prompt).startsWith("Plan a source-grounded assessment")) {
      const snap = await service.call("snapshot", {});
      const current = snap.jobs.find((item) => item.status === "running" && item.coverageRun?.list?.[0]?.status === "done");
      if (current) {
        onRoundTwo();
        onRoundTwo = null;
        const hold = setInterval(() => {}, 50);
        try { await allowRoundTwo; } finally { clearInterval(hold); }
      }
    }
    reportUsage({ uncachedInputTokens: 1000, outputTokens: 200 });
    return model.complete(system, prompt, context);
  };
  service.light = async (_system, prompt) => JSON.stringify({
    sections: JSON.parse(prompt.split("\n\n")[0]).sections.map((item) => ({ id: item.id, importance: 3, kind: "definition", reason: `Reason for ${item.title}` })),
  });
  for (const source of world.sources) await service.call("source.add", { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const started = await service.call("generate", { sourceIds: world.sources.map((source) => source.id), coverageLevel: "standard", kind: "quiz" });
  assert.equal(started.plan.rounds, 3);
  await reachedRoundTwo;
  const snapMidRun = await service.call("snapshot", {});
  const liveJob = snapMidRun.jobs.find((item) => item.id === started.jobId);
  assert.equal(liveJob?.status, "running", "round 2 is still in flight");
  const filePath = join(home, "study", "estimate-calibration.json");
  const midRuns = JSON.parse(await readFile(filePath, "utf8")).runs;
  assert.equal(midRuns.length, 1, "round 1 was recorded immediately without waiting for rounds 2 and 3");
  assert.equal(midRuns[0].model, "deepseek/deepseek-v4.1-flash");
  releaseRoundTwo();
  const finished = await settleJob(service, started.jobId);
  assert.equal(finished.status, "complete", finished.stage);
  const finalRuns = JSON.parse(await readFile(filePath, "utf8")).runs;
  assert.equal(finalRuns.length, 1, "cleanUp did not record a duplicate entry after the whole coverage run finished");
  assert.deepEqual(finalRuns[0], midRuns[0]);
});

test("model-keyed runs isolate two models across generate and usage.estimate while unkeyed runs and 'follow' still apply (#772)", async (t) => {
  const { StudyService } = await import("../lib/service.js");
  const { modelKey } = await import("../lib/job-model.js");
  const { reportUsage } = await import("../lib/usage-scope.js");
  const { settleJob } = await import("./helpers/wait.mjs");
  const { mergedTranscript } = await import("./helpers/merged-transcript.mjs");
  const { clusteringModel } = await import("./helpers/clustering-model.mjs");
  assert.equal(calibrationModel({ provider: "deepseek", model: "deepseek-v4.1-flash" }), "deepseek/deepseek-v4.1-flash");
  assert.equal(calibrationModel(modelKey({ provider: "deepseek", model: "deepseek-v4.1-flash" })), "deepseek/deepseek-v4.1-flash");
  assert.equal(calibrationModel("deepseek/deepseek-v4.1-flash"), "deepseek/deepseek-v4.1-flash");
  for (const unknown of ["follow", "", "   ", null, undefined, {}, { provider: "deepseek", model: "follow" }]) {
    assert.equal(calibrationModel(unknown), undefined);
  }
  const home = await mkdtemp(join(tmpdir(), "study-dsh-home-")), root = await mkdtemp(join(tmpdir(), "study-calibration-models-e2e-"));
  const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
  process.env.DSH_HOME = home;
  delete process.env.STUDY_NO_CALIBRATION;
  let activeRoute = null;
  let usage = { uncachedInputTokens: 1_000, outputTokens: 100 };
  const service = new StudyService(root, { jobModelHost: { route: () => activeRoute } });
  const setRoute = (route) => {
    activeRoute = route;
    if (globalThis.STUDY_RUNTIME_MATRIX_ON) service.model = route ?? "follow";
  };
  t.after(async () => {
    await service.dispose();
    for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  });
  const world = mergedTranscript({ recordings: 1, parts: 3, paragraphs: 2 }), model = clusteringModel();
  service.complete = async (system, prompt, context) => {
    reportUsage(usage);
    return model.complete(system, prompt, context);
  };
  const sourceIds = world.sources.map((source) => source.id);
  for (const source of world.sources) await service.call("source.add", { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const runOnce = async () => {
    const started = await service.call("generate", { sourceIds, count: 2, kind: "quiz" });
    const finished = await settleJob(service, started.jobId);
    assert.equal(finished.status, "complete", finished.stage);
    await service.call("draft.delete", { id: finished.draftId });
    return finished;
  };
  // 1 unkeyed run (model unknown) -> counts for every model.
  setRoute(null);
  usage = { uncachedInputTokens: 20_000, outputTokens: 5_000 };
  await runOnce();
  // 2 heavy runs on deepseek/reasoner -> 1 unkeyed + 2 keyed = 3 samples for deepseek/reasoner, only 1 sample for openai/gpt-4o-mini.
  setRoute({ provider: "deepseek", model: "reasoner" });
  usage = { uncachedInputTokens: 40_000, outputTokens: 20_000 };
  await runOnce();
  await runOnce();
  // 3 light runs on openai/gpt-4o-mini -> 1 unkeyed + 3 keyed = 4 samples for openai/gpt-4o-mini.
  setRoute({ provider: "openai", model: "gpt-4o-mini" });
  usage = { uncachedInputTokens: 200, outputTokens: 50 };
  await runOnce();
  await runOnce();
  await runOnce();

  const fileRuns = JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8")).runs;
  assert.deepEqual(fileRuns.map((entry) => entry.model), [
    undefined,
    "deepseek/reasoner",
    "deepseek/reasoner",
    "openai/gpt-4o-mini",
    "openai/gpt-4o-mini",
    "openai/gpt-4o-mini",
  ]);

  setRoute({ provider: "deepseek", model: "reasoner" });
  const estHeavy = await service.call("usage.estimate", { feature: "generate", sourceIds, count: 2, kind: "quiz" });
  const jobHeavy = await runOnce();
  assert.equal(estHeavy.calibration.samples, 3, "heavy model sees its 2 keyed runs + 1 unkeyed run");
  assert.equal(jobHeavy.estimate.calibration.samples, 3, "generate prices with the same model filter as usage.estimate");
  assert.deepEqual(jobHeavy.estimate.totalTokens, estHeavy.totalTokens);

  setRoute({ provider: "openai", model: "gpt-4o-mini" });
  const estLight = await service.call("usage.estimate", { feature: "generate", sourceIds, count: 2, kind: "quiz" });
  assert.equal(estLight.calibration.samples, 4, "light model sees its 3 keyed runs + 1 unkeyed run");
  assert.ok(estLight.totalTokens.high < estHeavy.totalTokens.low, `light ${JSON.stringify(estLight.totalTokens)} isolated from heavy ${JSON.stringify(estHeavy.totalTokens)}`);

  const explicitHeavy = await service.call("usage.estimate", {
    feature: "generate",
    sourceIds,
    count: 2,
    kind: "quiz",
    model: modelKey({ provider: "deepseek", model: "reasoner" }),
  });
  assert.equal(explicitHeavy.calibration.samples, 4, "after jobHeavy finished, deepseek/reasoner has 3 keyed + 1 unkeyed = 4 samples");

  activeRoute = null;
  service.model = "follow";
  const estUnknown = await service.call("usage.estimate", { feature: "generate", sourceIds, count: 2, kind: "quiz" });
  assert.equal(estUnknown.calibration.samples, 7, "when model is unknown/'follow', all 7 recorded runs count");

  // generate ignores an unexecuted `model` arg instead of mispricing or misrecording calibration under it.
  if (!globalThis.STUDY_RUNTIME_MATRIX_ON) service.model = undefined;
  setRoute({ provider: "deepseek", model: "reasoner" });
  const startedIgnored = await service.call("generate", { sourceIds, count: 2, kind: "quiz", model: "ignored/fake-model" });
  const finishedIgnored = await settleJob(service, startedIgnored.jobId);
  assert.equal(finishedIgnored.status, "complete", finishedIgnored.stage);
  await service.call("draft.delete", { id: finishedIgnored.draftId });
  assert.deepEqual(finishedIgnored.estimate.totalTokens, explicitHeavy.totalTokens, "ignored generate model arg does not misprice the run");
  const afterIgnored = JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8")).runs;
  assert.equal(afterIgnored.at(-1).model, "deepseek/reasoner", "ignored generate model arg does not override the dispatched host model");
});


test("roundCalibrationModel distinguishes unkeyed null steps from synthetic unstamped steps, ignores light weighing, and skips mixed-model rounds (#772)", () => {
  const planStep = { id: "s1", stage: "Planning evidence and learning targets · Group 1/1" };
  const authorStep = { id: "s2", stage: "Part 1/1 · Writing and self-checking questions" };
  const weighStep = { id: "w", stage: "Planning evidence and learning targets · Weighing the importance of the sections" };
  const repairStep = { id: "r", stage: "Part 1/1 · Repairing flagged questions" };
  assert.deepEqual(
    roundCalibrationModel([stampStepModel({ ...planStep }, "deepseek/reasoner"), stampStepModel({ ...authorStep }, "deepseek/reasoner"), stampStepModel({ ...repairStep }, "deepseek/chat")], undefined),
    { skip: false, model: "deepseek/reasoner" },
    "mechanical repair step routed to lightModel does not disqualify the calibrated pipeline stages",
  );
  assert.deepEqual(roundCalibrationModel([planStep, authorStep], "deepseek/reasoner"), { skip: false, model: "deepseek/reasoner" }, "synthetic unstamped steps fall back");
  assert.deepEqual(
    roundCalibrationModel([stampStepModel({ ...planStep }, null), stampStepModel({ ...authorStep }, null)], "deepseek/reasoner"),
    { skip: false, model: undefined },
    "explicitly unkeyed steps (null) stay unkeyed instead of falling back to prep.model",
  );
  assert.deepEqual(
    roundCalibrationModel([weighStep, stampStepModel({ ...planStep }, "openai/gpt-4o-mini"), stampStepModel({ ...authorStep }, "openai/gpt-4o-mini")], "deepseek/reasoner"),
    { skip: false, model: "openai/gpt-4o-mini" },
    "light weighing step never conflicts with pipeline stage steps",
  );
  assert.deepEqual(
    roundCalibrationModel([stampStepModel({ ...planStep }, "deepseek/reasoner"), stampStepModel({ ...authorStep }, "openai/gpt-4o-mini")], undefined),
    { skip: true, model: undefined },
    "two named models in one round skip calibration",
  );
  assert.deepEqual(
    roundCalibrationModel([stampStepModel({ ...planStep }, null), stampStepModel({ ...authorStep }, "openai/gpt-4o-mini")], undefined),
    { skip: true, model: undefined },
    "switching from unkeyed null to a named model mid-round skips calibration",
  );
});

for (const mode of ["legacy", "runtime"]) {
  test(`${mode}: switching job.control model while round 1's final call is in flight still records round 1 under the model round 1 dispatched on (#772)`, async (t) => {
    const { StudyService } = await import("../lib/service.js");
    const { modelKey } = await import("../lib/job-model.js");
    const { reportUsage } = await import("../lib/usage-scope.js");
    const { settleJob } = await import("./helpers/wait.mjs");
    const { mergedTranscript } = await import("./helpers/merged-transcript.mjs");
    const { clusteringModel } = await import("./helpers/clustering-model.mjs");
    const { switchOptions } = await import("./helpers/runtime-switch.mjs");
    const home = await mkdtemp(join(tmpdir(), "study-dsh-home-")), root = await mkdtemp(join(tmpdir(), `study-cal-inflight-${mode}-`));
    const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
    process.env.DSH_HOME = home;
    delete process.env.STUDY_NO_CALIBRATION;
    let enterReview, releaseReview;
    const inReview = new Promise((resolve) => { enterReview = resolve; });
    const allowReview = new Promise((resolve) => { releaseReview = resolve; });
    const world = mergedTranscript({ recordings: 1, parts: 4, paragraphs: 3 }), model = clusteringModel();
    const dispatched = [];
    const complete = async (system, prompt, options = {}) => {
      dispatched.push(options.route?.model ?? options.model?.model ?? "reasoner");
      if (enterReview && stageSystem(system, prompt).startsWith("Act as a strict")) {
        enterReview();
        enterReview = null;
        const hold = setInterval(() => {}, 50);
        try { await allowReview; } finally { clearInterval(hold); }
      }
      reportUsage({ uncachedInputTokens: 1_200, outputTokens: 300 });
      return model.complete(system, prompt, options);
    };
    const light = async (_system, prompt) => JSON.stringify({
      sections: JSON.parse(prompt.split("\n\n")[0]).sections.map((item) => ({ id: item.id, importance: 3, kind: "definition", reason: `Reason for ${item.title}` })),
    });
    const switched = switchOptions(mode, { complete, paths: ["generation"] });
    const hostRoute = { provider: "deepseek", model: "reasoner" };
    const service = new StudyService(root, {
      complete,
      light,
      coverage: { roundLimit: 4 },

      ...switched,
      jobModelHost: { ...(switched.jobModelHost || { ctx: {} }), route: () => hostRoute, complete, light },
    });
    t.after(async () => {
      releaseReview?.();
      await service.dispose();
      for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
    });
    await service.call("settings", { generation: { concurrency: 1, batchSize: 5 } });
    for (const source of world.sources) await service.call("source.add", { id: source.id, title: source.title, text: source.text, audio: source.audio });
    const started = await service.call("generate", { sourceIds: world.sources.map((source) => source.id), coverageLevel: "standard", count: 8, kind: "quiz" });
    assert.equal(started.plan.rounds, 2);
    await inReview;
    // Switch the task's model while Round 1's final review call is already in flight.
    await service.call("job.control", { jobId: started.jobId, action: "set", patch: { model: modelKey({ provider: "openai", model: "gpt-4o-mini" }) } });
    releaseReview();
    const finished = await settleJob(service, started.jobId);
    assert.equal(finished.status, "complete", finished.stage);
    const expectedHost = globalThis.STUDY_RUNTIME_MATRIX_ON ? "fixture" : "reasoner";
    const expectedKey = globalThis.STUDY_RUNTIME_MATRIX_ON ? "fixture/fixture" : "deepseek/reasoner";
    assert.ok(dispatched.includes(expectedHost) && dispatched.includes("gpt-4o-mini"), `round 1 ran on ${expectedHost} and round 2 on gpt-4o-mini: ${dispatched.join(", ")}`);
    const runs = JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8")).runs;
    assert.equal(runs.length, 1, "recorded once for round 1");
    assert.equal(runs[0].model, expectedKey, "round 1 recorded under the model its calls actually dispatched on, not the model switched to in flight");
  });

  test(`${mode}: switching job.control model mid-round across calls skips recording the hybrid round on both planned and plain runs (#772)`, async (t) => {
    const { StudyService } = await import("../lib/service.js");
    const { modelKey } = await import("../lib/job-model.js");
    const { reportUsage } = await import("../lib/usage-scope.js");
    const { settleJob } = await import("./helpers/wait.mjs");
    const { mergedTranscript } = await import("./helpers/merged-transcript.mjs");
    const { clusteringModel } = await import("./helpers/clustering-model.mjs");
    const { switchOptions } = await import("./helpers/runtime-switch.mjs");
    const home = await mkdtemp(join(tmpdir(), "study-dsh-home-")), root = await mkdtemp(join(tmpdir(), `study-cal-hybrid-${mode}-`));
    const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
    process.env.DSH_HOME = home;
    delete process.env.STUDY_NO_CALIBRATION;
    let onPlanGate = null, releasePlan = null;
    const world = mergedTranscript({ recordings: 1, parts: 4, paragraphs: 3 }), model = clusteringModel();
    const complete = async (system, prompt, options = {}) => {
      if (onPlanGate && stageSystem(system, prompt).startsWith("Plan a source-grounded assessment")) {
        const notify = onPlanGate;
        onPlanGate = null;
        const hold = setInterval(() => {}, 50);
        try {
          await new Promise((resolve) => {
            releasePlan = resolve;
            notify();
          });
        } finally {
          clearInterval(hold);
        }
      }
      reportUsage({ uncachedInputTokens: 1_500, outputTokens: 400 });
      return model.complete(system, prompt, options);
    };
    const light = async (_system, prompt) => JSON.stringify({
      sections: JSON.parse(prompt.split("\n\n")[0]).sections.map((item) => ({ id: item.id, importance: 3, kind: "definition", reason: `Reason for ${item.title}` })),
    });
    const switched = switchOptions(mode, { complete, paths: ["generation"] });
    const hostRoute = { provider: "deepseek", model: "reasoner" };
    const service = new StudyService(root, {
      complete,
      light,
      coverage: { roundLimit: 4 },

      ...switched,
      jobModelHost: { ...(switched.jobModelHost || { ctx: {} }), route: () => hostRoute, complete, light },
    });
    t.after(async () => {
      releasePlan?.();
      await service.dispose();
      for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
    });
    await service.call("settings", { generation: { concurrency: 1, batchSize: 5 } });
    const sourceIds = world.sources.map((source) => source.id);
    for (const source of world.sources) await service.call("source.add", { id: source.id, title: source.title, text: source.text, audio: source.audio });

    // 1) Planned multi-round run switched after Round 1's planning call started -> hybrid Round 1 skipped.
    const reachedPlanned = new Promise((resolve) => { onPlanGate = resolve; });
    const planned = await service.call("generate", { sourceIds, coverageLevel: "standard", count: 8, kind: "quiz" });
    await reachedPlanned;
    await service.call("job.control", { jobId: planned.jobId, action: "set", patch: { model: modelKey({ provider: "openai", model: "gpt-4o-mini" }) } });
    releasePlan();
    const plannedDone = await settleJob(service, planned.jobId);
    assert.equal(plannedDone.status, "complete", plannedDone.stage);
    await service.call("draft.delete", { id: plannedDone.draftId });

    // 2) Plain single-round run switched after its planning call started -> hybrid plain run skipped.
    const reachedPlain = new Promise((resolve) => { onPlanGate = resolve; });
    const plain = await service.call("generate", { sourceIds, count: 2, kind: "quiz" });
    await reachedPlain;
    await service.call("job.control", { jobId: plain.jobId, action: "set", patch: { model: modelKey({ provider: "openai", model: "gpt-4o-mini" }) } });
    releasePlan();
    const plainDone = await settleJob(service, plain.jobId);
    assert.equal(plainDone.status, "complete", plainDone.stage);

    await assert.rejects(readFile(join(home, "study", "estimate-calibration.json"), "utf8"), { code: "ENOENT" }, "neither hybrid run wrote a calibration record");
    assert.equal((await calibrationFor().factors({ model: "deepseek/reasoner" })).samples, 0);
    assert.equal((await calibrationFor().factors({ model: "openai/gpt-4o-mini" })).samples, 0);
  });
}


test("runtime: retrying a failed run after switching the host model prices and records Attempt 2 under Model B, not Attempt 1's frozen bindings (#772)", async (t) => {
  const { StudyService } = await import("../lib/service.js");
  const { reportUsage } = await import("../lib/usage-scope.js");
  const { settleJob } = await import("./helpers/wait.mjs");
  const { mergedTranscript } = await import("./helpers/merged-transcript.mjs");
  const { clusteringModel } = await import("./helpers/clustering-model.mjs");
  const { managedRuntimeOptions } = await import("./helpers/runtime-switch.mjs");
  const home = await mkdtemp(join(tmpdir(), "study-dsh-home-")), root = await mkdtemp(join(tmpdir(), "study-cal-retry-"));
  const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
  process.env.DSH_HOME = home;
  delete process.env.STUDY_NO_CALIBRATION;
  const owner = Symbol("retry-model-owner");
  const routeA = { provider: "deepseek", model: "reasoner" };
  const routeB = { provider: "openai", model: "gpt-4o-mini" };
  const world = mergedTranscript({ recordings: 1, parts: 3, paragraphs: 2 }), model = clusteringModel();
  let failAttempt = false;
  let usage = { uncachedInputTokens: 40_000, outputTokens: 20_000 };
  const dispatched = [];
  const makeComplete = (fallbackName) => async (system, prompt, options = {}) => {
    dispatched.push(options.route?.model ?? fallbackName);
    if (failAttempt) throw new Error("provider unavailable on attempt 1");
    reportUsage(usage);
    return model.complete(system, prompt, options);
  };
  const completeA = makeComplete("reasoner"), completeB = makeComplete("gpt-4o-mini");
  const { starts: _sA, ...managedA } = managedRuntimeOptions({ complete: completeA, paths: ["generation"], owner });
  const serviceA = new StudyService(root, {
    complete: completeA,
    ...(globalThis.STUDY_RUNTIME_MATRIX_ON ? { model: routeA } : {}),
    ...managedA,
    jobModelHost: { ...managedA.jobModelHost, route: () => routeA, complete: completeA },
  });
  const serviceB = new StudyService(root, {
    runtime: serviceA.runtime,
    storage: serviceA.store,
    complete: completeB,
    ...(globalThis.STUDY_RUNTIME_MATRIX_ON ? { model: routeB } : {}),
    ...managedA,
    jobModelHost: { ...managedA.jobModelHost, route: () => routeB, complete: completeB },
  });
  t.after(async () => {
    await serviceA.dispose();
    for (const [key, value] of [["DSH_HOME", saved.home], ["STUDY_NO_CALIBRATION", saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  });

  const sourceIds = world.sources.map((source) => source.id);
  for (const source of world.sources) await serviceA.call("source.add", { id: source.id, title: source.title, text: source.text, audio: source.audio });

  // Seed distinct calibration histories for Model A (3 heavy runs) and Model B (4 light runs).
  for (let i = 0; i < 3; i += 1) {
    const seeded = await serviceA.call("generate", { sourceIds, count: 2, kind: "quiz" });
    const done = await settleJob(serviceA, seeded.jobId);
    assert.equal(done.status, "complete", done.stage);
    await serviceA.call("draft.delete", { id: done.draftId });
  }
  usage = { uncachedInputTokens: 200, outputTokens: 50 };
  for (let i = 0; i < 4; i += 1) {
    const seeded = await serviceB.call("generate", { sourceIds, count: 2, kind: "quiz" });
    const done = await settleJob(serviceB, seeded.jobId);
    assert.equal(done.status, "complete", done.stage);
    await serviceB.call("draft.delete", { id: done.draftId });
  }

  const estA = await serviceA.call("usage.estimate", { feature: "generate", sourceIds, count: 2, kind: "quiz" });
  const estB = await serviceB.call("usage.estimate", { feature: "generate", sourceIds, count: 2, kind: "quiz" });
  assert.equal(estA.calibration.samples, 3);
  assert.equal(estB.calibration.samples, 4);
  assert.ok(estB.totalTokens.high < estA.totalTokens.low, "Model B's estimate is distinctly lower than Model A's");

  // Attempt 1 starts on serviceA (Model A) and fails: entry.bindings closed over serviceA's frozen Request 1.
  dispatched.length = 0;
  failAttempt = true;
  const started = await serviceA.call("generate", { sourceIds, count: 2, kind: "quiz" });
  const failed = await settleJob(serviceA, started.jobId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.estimate.calibration.samples, 3, "Attempt 1 priced under Model A");
  assert.equal(JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8")).runs.length, 7, "failed Attempt 1 recorded nothing");

  // Retry via serviceB (Model B, fresh per-request services & jobModelHost): Attempt 2 must price AND record under Model B.
  dispatched.length = 0;
  failAttempt = false;
  const retried = await serviceB.call("job.control", { jobId: started.jobId, action: "retry" });
  const completed = await settleJob(serviceB, retried.attemptId);
  assert.equal(completed.status, "complete", completed.stage);
  if (!globalThis.STUDY_RUNTIME_MATRIX_ON) {
    assert.ok(dispatched.length > 0 && dispatched.every((name) => name === "gpt-4o-mini"), `Attempt 2 dispatched on gpt-4o-mini: ${dispatched.join(", ")}`);
  }
  assert.equal(completed.estimate.calibration.samples, 4, "Attempt 2 re-priced under Model B instead of Attempt 1's frozen bindings");
  assert.deepEqual(completed.estimate.totalTokens, estB.totalTokens, "Attempt 2 estimate matches Model B's estimate");
  const runs = JSON.parse(await readFile(join(home, "study", "estimate-calibration.json"), "utf8")).runs;
  assert.equal(runs.length, 8);
  assert.equal(runs.at(-1).model, "openai/gpt-4o-mini", "Attempt 2 recorded calibration under Model B, not Model A");
});
