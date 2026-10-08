/* WP29 · the feature tour after 2.1.1 / 2.1.2: no longer than needed, every
   step still anchored to a real, stable element, the new generate form, mistakes,
   exam formats, statistics and settings shown, optional parts never anchored
   without a fallback, and the docs stating the same step count. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import { TOUR_STEPS, availableTourSteps, CORE_TOUR_LENGTH } from "../ui/tour/steps.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(join(repo, path), "utf8");
const step = (id) => TOUR_STEPS.find((item) => item.id === id);
const anchorsOf = (item) => [item.anchor].flat().filter(Boolean);

test("the default tour stays short: at most 9 steps; the full one is the extra, with welcome first and the sample hand-off last in both", () => {
  const sample = { loaded: true, deckId: "d", sourceId: "s", draftId: "r" };
  const core = availableTourSteps(TOUR_STEPS, { sample }), full = availableTourSteps(TOUR_STEPS, { sample, full: true });
  assert.ok(core.length <= 9, `${core.length} steps`);
  assert.equal(core.length, CORE_TOUR_LENGTH);
  assert.ok(full.length <= 28, `${full.length} steps`);
  assert.ok(full.length > core.length);
  for (const list of [core, full]) {
    assert.equal(list[0].id, "welcome");
    assert.equal(list.at(-1).id, "finish");
  }
  assert.equal(full.length, TOUR_STEPS.filter((item) => item.only !== "core").length);
});

test("the new generate form is toured: the picker, the switches with 帮我想想, then the 预计 token line", () => {
  const ids = TOUR_STEPS.map((item) => item.id);
  const at = ids.indexOf("generate");
  assert.deepEqual(ids.slice(at, at + 3), ["generate", "generate-tune", "generate-cost"]);
  for (const id of ["generate", "generate-tune", "generate-cost"]) assert.equal(step(id).page, "generate");
  assert.equal(step("generate").prepare, "prepareGenerate", "the sample lecture is already ticked");
  assert.deepEqual(anchorsOf(step("generate")), ["generate-sources"]);
  assert.deepEqual(anchorsOf(step("generate-tune")), ["generate-options"]);
  assert.deepEqual(anchorsOf(step("generate-cost")), ["generate-summary"]);
  assert.match(step("generate").body, /选择章节/);
  assert.match(step("generate-tune").body, /帮我想想/);
  assert.match(step("generate-cost").body, /预计/);
  assert.match(step("generate-cost").body, /实际用量/);
});

test("copy matches 2.1.x: Word and PowerPoint, one exam page with three formats, mistakes with 举一反三, forecast and usage", () => {
  assert.match(step("sources").body, /Word/);
  assert.match(step("sources").body, /PowerPoint/);
  assert.match(step("sources").body, /大教材/);
  assert.match(step("document").body, /从这份资料出题/);
  assert.match(step("wrongbook").body, /为你推荐/);
  assert.match(step("wrongbook").body, /变式/);
  for (const format of ["选择题笔试", "案例分析卷", "口头面试"]) assert.match(step("exam").body, new RegExp(format));
  assert.match(step("dashboard").body, /14 天/);
  assert.match(step("dashboard").body, /模型用量/);
  assert.match(step("workflows").body, /换课程/);
  assert.match(step("nav").body, /待办/);
  assert.match(step("nav").body, /语言/);
  assert.match(step("settings-extensions").body, /大教材/);
  assert.match(step("settings-extensions").body, /更新/);
  assert.equal(TOUR_STEPS.some((item) => item.id === "case"), false);
});

test("steps that may find their element missing carry a fallback anchor or a context guard", () => {
  // Rendered only in some states: no mistakes yet, no generation context, no similar questions.
  const optional = ["wrongbook-recs", "settings-extensions", "settings-audio", "dashboard-charts", "home-course", "home-today"];
  for (const item of TOUR_STEPS) {
    const anchors = anchorsOf(item);
    if (!anchors.some((anchor) => optional.includes(anchor))) continue;
    assert.ok(anchors.length > 1 || item.context, `${item.id}: ${anchors.join(", ")} may be absent; add a stable fallback anchor or a context`);
  }
  assert.deepEqual(anchorsOf(step("wrongbook")), ["wrongbook-recs", "wrongbook-list"]);
  assert.deepEqual(anchorsOf(step("settings-extensions")), ["settings-extensions", "settings-update"]);
  assert.deepEqual(anchorsOf(step("dashboard")), ["dashboard-charts", "dashboard-summary"]);
  // 推理程度 exists only for models that offer levels: the tour never points at it.
  for (const item of TOUR_STEPS) for (const anchor of anchorsOf(item)) assert.doesNotMatch(anchor, /reasoning|effort/, item.id);
});

test("every prepare hook is handled by the app and every page it names is a real page", async () => {
  const app = await read("ui/app/use-tour.js");
  const handled = new Set([...app.matchAll(/step\.prepare === ["']([A-Za-z]+)["']/g)].map((match) => match[1]));
  for (const item of TOUR_STEPS.filter((candidate) => candidate.prepare)) assert.ok(handled.has(item.prepare), `${item.id}: ${item.prepare} is not handled in ui/app/use-tour.js`);
  // The exam format switch is shown as the learner left it; the tour must not force a format that hides the switch.
  assert.equal(step("exam").prepare, undefined);
});

test("the sample course gives every step what it shows, without a model", async (t) => {
  const base = join(repo, "output", "test-wp29");
  await mkdir(base, { recursive: true });
  const libraryRoot = await mkdtemp(join(base, "lib-")), home = await mkdtemp(join(base, "home-"));
  t.after(() => Promise.all([libraryRoot, home].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }))));
  let calls = 0;
  const server = await createPreviewServer({ libraryRoot, home, port: 0, model: async () => { calls++; throw new Error("the tour needs no model"); } });
  t.after(() => server.close());
  const call = async (action, args = {}) => {
    const res = await fetch(server.url + "/api/call", { method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": server.token },
      body: JSON.stringify({ action, args }) });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.value;
  };
  const status = await call("sample.load", { language: "zh" });
  for (const key of new Set(TOUR_STEPS.map((item) => item.needs).filter(Boolean))) assert.ok(status[key], `the sample status has ${key}`);
  assert.ok(status.skeletonId, "openSampleSkeleton has a skeleton");
  const snapshot = await call("snapshot", { uiLanguage: "zh" });
  assert.ok(snapshot.sources.some((item) => item.id === status.sourceId));
  assert.ok(snapshot.drafts.some((item) => item.id === status.draftId));
  // 错题与待巩固: mistakes grouped by topic and, for 为你推荐, similar questions already in the bank.
  const mistakes = await call("wrongbook", { course: "*", offset: 0, limit: 100 });
  assert.ok(mistakes.total >= 2, "the sample has unmastered questions");
  assert.ok(new Set(mistakes.items.map((item) => item.topic)).size >= 2, "more than one topic group");
  const recs = await call("wrongbook.recommend", { course: "*", limit: 10 });
  assert.ok(recs.items.length > 0, "the sample has similar questions to recommend, so the recommend panel is there");
  assert.equal(calls, 0, "no model call");
});

test("README states the step count of the default tour and no longer promises three minutes (the changelog is written at release time)", async () => {
  const count = CORE_TOUR_LENGTH;
  const readme = await read("README.md"), readmeZh = await read("README.zh-CN.md");
  assert.match(readme, new RegExp(`The ${count}-step tour`));
  assert.match(readmeZh, new RegExp(`${count} 步导览`));
  for (const [file, text] of [["README.md", readme], ["README.zh-CN.md", readmeZh]]) assert.doesNotMatch(text, /\b(17|19|21)[- ]?step|(17|19|21) 步导览|3 minutes|3 分钟/, file);
});
