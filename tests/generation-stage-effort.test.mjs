import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { RELATIVE_EFFORTS, EFFORT_DEFAULTS, EFFORT_STAGES, effortStageOf, resolveEffort, stageEffortRoute } from "../lib/stage-effort.js";
import { GENERATION_SETTINGS_DEFAULTS, normalizeGenerationPerformance, validateGenerationPatch, resolveGenerationRequest } from "../lib/generation-settings.js";
import { withQualityStages } from "./helpers/assessment.mjs";
import { settleJob } from "./helpers/wait.mjs";

/* #218: the reasoning level is chosen per stage, in relative terms ("low", "high"...) resolved to the nearest level the model really offers
   (DeepSeek V4.1 Flash has Off/Low/Default/High/Max and no "medium"). Planning and review follow the session's level by default; writing,
   replacement and repair run low. */

const DEEPSEEK = [{ id: "off", name: "Off" }, { id: "low", name: "Low" }, { id: "default", name: "Default" }, { id: "high", name: "High" }, { id: "max", name: "Max" }];
const ctxWith = (efforts, defaultEffort = "default") => ({ llm: { resolveModelInfo: async () => ({ reasoning: { efforts, defaultEffort } }) } });

test("a relative level resolves to the nearest level the model really offers, with a note when it is not exact", () => {
  assert.deepEqual(RELATIVE_EFFORTS, ["follow", "lowest", "low", "default", "high", "highest"]);
  const pick = (relative, efforts = DEEPSEEK) => resolveEffort(efforts, relative, "default");
  assert.equal(pick("lowest").id, "off");
  assert.equal(pick("low").id, "low");
  assert.equal(pick("low").note, "");
  assert.equal(pick("default").id, "default");
  assert.equal(pick("high").id, "high");
  assert.equal(pick("highest").id, "max");
  assert.equal(pick("follow").id, undefined, "follow sets nothing");
  assert.equal(resolveEffort([], "low").id, undefined, "a model without levels is left alone");
  // a model that only offers low/high: "default" and "lowest" map to the nearest real level and say so
  const twoLevels = [{ id: "low", name: "Low" }, { id: "high", name: "High" }];
  assert.equal(resolveEffort(twoLevels, "lowest", "high").id, "low");
  const approx = resolveEffort(twoLevels, "highest", "high");
  assert.equal(approx.id, "high");
  assert.match(approx.note, /no "highest" level/);
  const noMedium = resolveEffort([{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }], "default", "");
  assert.ok(["a", "b", "c"].includes(noMedium.id) && noMedium.note);
});

test("the stage of a model call comes from the stage text the pipeline reports", () => {
  assert.deepEqual(EFFORT_STAGES, ["planning", "review", "writing", "repair"]);
  assert.equal(effortStageOf("Part 1/2 · Planning evidence and learning targets · Group 1/1"), "planning");
  assert.equal(effortStageOf("Preparing supported answers and scenarios"), "planning");
  assert.equal(effortStageOf("Part 2/2 · Reviewing ambiguity and source support"), "review");
  assert.equal(effortStageOf("Writing and self-checking questions"), "writing");
  assert.equal(effortStageOf("Writing replacement questions from reserve targets"), "writing");
  assert.equal(effortStageOf("Repairing flagged questions within this run"), "repair");
  assert.equal(effortStageOf("something else"), undefined);
});

test("per-stage levels give different call parameters than one level for everything", async () => {
  const session = { provider: "p", model: "m", reasoningEffort: "high" };
  const ctx = ctxWith(DEEPSEEK);
  const stages = ["Planning evidence and learning targets", "Preparing supported answers and scenarios", "Writing and self-checking questions",
    "Reviewing ambiguity and source support", "Repairing flagged questions within this run"];
  const everythingHigh = await Promise.all(stages.map((stage) => stageEffortRoute(ctx, session, stage, { planning: "follow", review: "follow", writing: "follow", repair: "follow" })));
  assert.ok(everythingHigh.every((item) => item.route.reasoningEffort === "high"), "following the session keeps one level for every stage");
  const perStage = await Promise.all(stages.map((stage) => stageEffortRoute(ctx, session, stage, EFFORT_DEFAULTS)));
  assert.deepEqual(perStage.map((item) => item.route.reasoningEffort), ["high", "high", "low", "high", "low"], "planning and review keep the higher level, writing and repair run low");
  const custom = await stageEffortRoute(ctx, session, "Reviewing ambiguity and source support", { review: "highest" });
  assert.equal(custom.route.reasoningEffort, "max");
  const unknown = await stageEffortRoute(ctx, session, "Waiting for the previous generation", EFFORT_DEFAULTS);
  assert.equal(unknown.route, session, "an unknown stage is left alone");
  const flat = await stageEffortRoute(ctxWith([]), session, "Writing and self-checking questions", EFFORT_DEFAULTS);
  assert.equal(flat.route, session, "a model without levels keeps the route");
  const approx = await stageEffortRoute(ctxWith([{ id: "low", name: "Low" }, { id: "high", name: "High" }], "high"), session, "Writing and self-checking questions", { writing: "lowest" });
  assert.equal(approx.route.reasoningEffort, "low");
});

test("the four stage levels are settings that ride on the job's performance, 'low' for writing and repair by default", () => {
  assert.deepEqual(Object.fromEntries(EFFORT_STAGES.map((stage) => [stage, GENERATION_SETTINGS_DEFAULTS[`effort${stage[0].toUpperCase()}${stage.slice(1)}`]])), EFFORT_DEFAULTS);
  assert.deepEqual(EFFORT_DEFAULTS, { planning: "follow", review: "follow", writing: "low", repair: "low" });
  const performance = normalizeGenerationPerformance({ effortReview: "highest", effortWriting: "banana" });
  assert.equal(performance.effortReview, "highest");
  assert.equal(performance.effortWriting, "low", "an unknown level falls back to the default");
  assert.deepEqual(validateGenerationPatch({ effortPlanning: "high" }), { effortPlanning: "high" });
  assert.throws(() => validateGenerationPatch({ effortPlanning: "medium" }), /Invalid generation setting: effortPlanning/);
  assert.equal(resolveGenerationRequest({ effortRepair: "lowest" }, {}, { language: "zh" }).performance.effortRepair, "lowest");
});

test("a generation job hands each model call the stage levels of its snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-stage-effort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", { id: "s", title: "Notes", text: "Architecture includes the principles guiding a system's design and evolution." });
  await service.call("settings", { generation: { effortReview: "highest", effortWriting: "lowest" } });
  const seen = [];
  const inner = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "T", cards: [{ id: "q1", kind: "flashcard", topic: "Architecture", objective: "O1", prompt: "What does architecture include?", answer: "Principles guiding design and evolution.",
      hint: "Think about change over time.", explanation: "The statement says it.", misconception: "Only structure.", citations: [{ sourceId: "s", quote: "Architecture includes the principles guiding a system's design and evolution." }] }].slice(0, request.count) });
  });
  service.complete = async (system, prompt, context) => { seen.push({ stage: context?.stage, stageEffort: context?.stageEffort }); return inner(system, prompt, context); };
  const started = await service.call("generate", { sourceIds: ["s"], count: 1, kind: "flashcard" });
  assert.equal((await settleJob(service, started.jobId)).status, "complete");
  assert.ok(seen.length >= 4);
  assert.ok(seen.every((call) => call.stageEffort && call.stageEffort.review === "highest" && call.stageEffort.writing === "lowest" && call.stageEffort.planning === "follow" && call.stageEffort.repair === "low"),
    JSON.stringify(seen[0]));
});
