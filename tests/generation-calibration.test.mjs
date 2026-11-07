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
  const perCall = { ...(await calibration.outputPerCall()), defaults: undefined };
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
  assert.deepEqual(calibrateEstimate(raw, null, { ...(await calibration.outputPerCall({ model: "mine" })), defaults: undefined }), raw, "nothing measured for this model: the estimate is untouched");
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
  for (const [id, order] of [["blueprint", 9_437], ["author", 8_662], ["review", 12_973]]) assert.equal(perCall.defaults[id], order, `${id} allowance is the order the owner's finished run measured`);
  const raised = calibrateEstimate(raw, null, perCall);
  for (const id of ["blueprint", "author", "review"]) {
    const before = raw.stages.find(stage => stage.id === id), after = raised.stages.find(stage => stage.id === id);
    assert.equal(after.outputTokens.low, before.outputTokens.low, `${id}: a model that does not think still fits the low end`);
    assert.equal(after.outputTokens.high, Math.max(before.outputTokens.high, perCall.defaults[id] * before.calls), `${id}: the high end is what a thinking model writes`);
  }
  assert.ok(raised.totalTokens.high > raw.totalTokens.high * 2, "the high end is no longer a third of a thinking run");
  assert.equal(raised.totalTokens.low, raw.totalTokens.low, "the low end is the sample estimate");
  assert.ok(raised.notes.includes("thinking-default") && !raised.notes.includes("includes-thinking"), "an assumption, not a measurement");
  // One stage measured on this machine: that stage says "measured", the others stay assumed.
  const mixed = calibrateEstimate(raw, null, { ...perCall, stages: { review: 20_000 }, samples: 3 });
  assert.equal(mixed.stages.find(stage => stage.id === "review").outputTokens.high, Math.max(raw.stages.find(stage => stage.id === "review").outputTokens.high, 20_000 * raw.stages.find(stage => stage.id === "review").calls));
  assert.ok(mixed.notes.includes("includes-thinking") && mixed.notes.includes("thinking-default"));
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
