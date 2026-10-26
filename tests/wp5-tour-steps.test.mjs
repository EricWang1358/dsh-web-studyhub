/* WP5 · guided tour data (plan §4 C7) and navigation order (P11). The steps
   are data, so the source tree can be checked for every anchor they need. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { TOUR_STEPS, availableTourSteps, tourNeighbour, tourKeyAction, tourStepCopy, CORE_TOUR_LENGTH, CORE_ORDER } from "../ui/tour/steps.js";
import { NAV_DEFAULTS, mergeOrder } from "../ui/nav-order.js";

const han = /[㐀-鿿]/;
const english = JSON.parse(await readFile("ui/locales/en.onboarding.json", "utf8"));
const catalogue = Object.assign({}, ...await Promise.all((await readdir("ui/locales")).filter((name) => /^en(\..+)?\.json$/.test(name))
  .map(async (name) => JSON.parse(await readFile(join("ui/locales", name), "utf8")))));

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}
/** Every `data-tour` anchor rendered by the UI source, including the nav items' `nav-${id}`. */
async function anchorsInSource() {
  const anchors = new Set();
  for (const file of await sourceFiles("ui")) {
    const text = await readFile(file, "utf8");
    // JSX attributes (data-tour="x") and spread props ({ "data-tour": "x" }).
    for (const match of text.matchAll(/data-tour["']?\s*[=:]\s*["']([a-z0-9-]+)["']/g)) anchors.add(match[1]);
    // A settings section names its anchor with the tour prop of SettingsSection (rendered as data-tour).
    if (/\bSettingsSection\b/.test(text)) for (const match of text.matchAll(/\btour=["']([a-z0-9-]+)["']/g)) anchors.add(match[1]);
    if (/data-tour=\{`nav-\$\{id\}`\}/.test(text)) for (const id of Object.values(NAV_DEFAULTS).flat()) anchors.add(`nav-${id}`);
    // Tabs described as data ({ …, tour: "x" } rendered with data-tour={tab.tour}, ui/Generate.jsx).
    if (/data-tour=\{tab\.tour\}/.test(text)) for (const match of text.matchAll(/\btour:\s*["']([a-z0-9-]+)["']/g)) anchors.add(match[1]);
  }
  return anchors;
}
/* Anchors another work package still has to add to its own pages (plan §5).
   WP3 and WP4 have merged, so every anchor must exist now. */
const PARALLEL = {};
const PLAN_ANCHORS = ["nav", "nav-library", "nav-sources", "nav-generate", "nav-wrongbook", "nav-exam", "nav-dashboard", "nav-skeleton",
  "nav-workflows", "nav-settings", "tour-reopen", "home-hero", "home-today", "home-catalog", "sources-list", "sources-add", "import-drop",
  "generate-from-sources", "generate-submit", "review-question", "review-help", "wrongbook-list", "exam-start", "dashboard-summary",
  "skeleton-main", "workflows-main", "settings-model", "settings-audio", "settings-sample",
  // 2.1.2 refresh (WP29)
  "generate-sources", "generate-options", "generate-summary", "wrongbook-recs", "dashboard-charts", "settings-extensions", "settings-update"];
const PAGES = new Set(["library", "sources", "generate", "draft", "review", "wrongbook", "exam", "dashboard", "skeleton", "workflows",
  "settings", "notes", "board", "audio", "live", "graph", "manage", "tasks", "examprep", "book"]);

test("navigation is grouped by when a page is used: every day, now and then, once per course", () => {
  assert.deepEqual(NAV_DEFAULTS, {
    daily: ["library", "sources", "generate", "tasks", "wrongbook", "workflows", "notes", "board"],
    periodic: ["exam", "examprep", "book", "dashboard"],
    setup: ["skeleton", "audio", "live"],
  });
  // A learner's saved order still applies; pages it does not mention join at the end of their group.
  const saved = { daily: ["board", "library"], setup: ["live", "audio"] };
  assert.deepEqual(mergeOrder(saved, NAV_DEFAULTS), {
    daily: ["board", "library", "sources", "generate", "tasks", "wrongbook", "workflows", "notes"],
    periodic: ["exam", "examprep", "book", "dashboard"],
    setup: ["live", "audio", "skeleton"],
  });
  // An order saved before the regrouping (main / upkeep) keeps working: its order is applied inside the new groups.
  assert.deepEqual(mergeOrder({ main: ["library", "workflows", "live", "audio"], upkeep: ["sources", "generate", "skeleton"] }, NAV_DEFAULTS).setup,
    ["live", "audio", "skeleton"]);
});

const ALL = { sample: { loaded: true, deckId: "d", sourceId: "s", draftId: "r" }, pageAvailable: () => true, hasContext: () => true };
const idsOf = (ctx) => availableTourSteps(TOUR_STEPS, { ...ALL, ...ctx }).map((step) => step.id);

test("the default tour is the first-run line's order in 7 steps: 欢迎, 设置·模型, 资料, 出题, 草稿, 练习, 完成; 任务 only in the full tour (3.6 D5)", () => {
  // While the first-run line is up (an empty library, the sample never counts), the last step is the line's step 2 on the library home.
  const core = idsOf({ line: true });
  assert.deepEqual(core, ["welcome", "settings-model", "sources", "generate-quick", "draft", "practice", "finish-line"]);
  assert.equal(core.length, CORE_TOUR_LENGTH, "the number the line's sample link says");
  assert.equal(CORE_TOUR_LENGTH, 7, "8 → 7 steps");
  assert.ok(!core.includes("tasks"), "任务 is in the full tour only: on the first run the run's card is in the line's step 3");
  const last = TOUR_STEPS.find((step) => step.id === "finish-line");
  assert.equal(last.page, "library");
  assert.deepEqual(last.anchor, ["first-run-material", "home-today"], "it lights the line's step 2 (the compact card while the tour shows the home)");
  assert.equal(last.final, true, "its card offers 添加资料, which comes back to the line");
  // With a deck of the learner's own (no line), the same seven, ending on Settings as before.
  assert.deepEqual(idsOf({}), ["welcome", "settings-model", "sources", "generate-quick", "draft", "practice", "finish"]);
  assert.deepEqual(CORE_ORDER.filter((id) => !id.startsWith("finish")), core.slice(0, -1));
  assert.equal(TOUR_STEPS.at(-1).final, true);
});

test("the full tour is the explicit extra: every step but the short-tour-only ones, in order, with 任务, notes, 备考补习 and the reader's two controls", () => {
  assert.deepEqual(idsOf({ full: true }), ["welcome", "nav", "home", "course", "sources", "document", "reader-practice", "translation", "generate", "generate-tune", "generate-cost",
    "tasks", "draft", "practice", "help", "wrongbook", "exam", "examprep", "dashboard", "notes", "skeleton", "workflows", "settings-model", "settings-audio", "settings-extensions", "finish"]);
  assert.ok(!idsOf({ full: true }).includes("generate-quick"), "the short generate step has longer siblings in the full tour");
  assert.deepEqual(idsOf({ full: true, line: true }), idsOf({ full: true }), "the full tour is the same whether or not the line is up");
  assert.equal(new Set(TOUR_STEPS.map((step) => step.id)).size, TOUR_STEPS.length, "unique ids");
  assert.equal(TOUR_STEPS[0].anchor, undefined, "the welcome step is centred");
  const anchors = new Set(TOUR_STEPS.flatMap((step) => [step.anchor].flat()).filter(Boolean));
  for (const anchor of ["reader-practice", "translation-toggle", "nav-tasks", "nav-notes", "nav-examprep"]) assert.ok(anchors.has(anchor), `${anchor} is toured`);
  for (const step of TOUR_STEPS) {
    if (step.page) assert.ok(PAGES.has(step.page), `${step.id}: unknown page ${step.page}`);
    for (const anchor of [step.anchor].flat().filter(Boolean)) assert.ok(PLAN_ANCHORS.includes(anchor) || ["source-tools", "source-tools-toggle", "draft-publish", "exam-case", "home-course",
      "reader-practice", "translation-toggle", "nav-tasks", "nav-notes", "nav-examprep", "first-run-material"].includes(anchor), `${step.id}: anchor ${anchor} is not in the plan's list`);
  }
});

test("the reader's 原始 PDF page bar and page panel carry their tour anchors (#456)", async () => {
  const anchors = await anchorsInSource();
  for (const anchor of ["reader-pdf-bar", "reader-page-ask"]) assert.ok(anchors.has(anchor), anchor);
});

test("every anchor the tour uses exists in the UI source", async (t) => {
  const anchors = await anchorsInSource();
  const used = [...new Set([...TOUR_STEPS.flatMap((step) => [step.anchor].flat()).filter(Boolean), ...PLAN_ANCHORS.filter((id) => !PARALLEL[id])])];
  const missing = used.filter((anchor) => !anchors.has(anchor));
  const waiting = missing.filter((anchor) => PARALLEL[anchor]);
  if (waiting.length) t.diagnostic(`anchors still owned by parallel work packages: ${waiting.map((id) => `${id} (${PARALLEL[id]})`).join(", ")}`);
  assert.deepEqual(missing.filter((anchor) => !PARALLEL[anchor]), []);
  // A step with several anchors (fallbacks) must find at least one of its own.
  for (const step of TOUR_STEPS.filter((item) => Array.isArray(item.anchor)))
    assert.ok(step.anchor.some((anchor) => anchors.has(anchor) || PARALLEL[anchor]), step.id);
});

test("every step has Chinese copy with an English translation", () => {
  for (const step of TOUR_STEPS) {
    const texts = tourStepCopy(step);
    assert.ok(texts.length >= 2, step.id);
    for (const text of texts) {
      assert.match(text, han, `${step.id}: source copy is Chinese`);
      assert.ok(Object.hasOwn(catalogue, text), `${step.id}: missing English for 「${text}」`);
      assert.doesNotMatch(catalogue[text], han, `${step.id}: English copy`);
    }
  }
  for (const [zh, en] of Object.entries(english)) {
    assert.match(zh, han);
    assert.doesNotMatch(en, han, `en.onboarding.json: ${zh}`);
  }
});

test("steps that need sample data, a page or a component are left out when it is missing", () => {
  const all = { ...ALL, full: true };
  assert.equal(availableTourSteps(TOUR_STEPS, all).length, TOUR_STEPS.filter((step) => step.only !== "core").length);
  const ids = (ctx) => availableTourSteps(TOUR_STEPS, ctx).map((step) => step.id);
  const bare = ids({ ...all, sample: { loaded: false } });
  for (const id of ["document", "reader-practice", "translation", "draft", "practice", "help"]) assert.ok(!bare.includes(id), id);
  for (const id of ["welcome", "nav", "home", "sources", "generate", "tasks", "wrongbook", "settings-model", "finish"]) assert.ok(bare.includes(id), id);
  assert.ok(!ids({ ...all, sample: { ...all.sample, draftId: null } }).includes("draft"), "a published sample draft drops the draft step");
  assert.ok(!ids({ ...all, hasContext: (id) => id !== "audio" }).includes("settings-audio"));
  assert.ok(!ids({ ...all, pageAvailable: (page) => page !== "workflows" }).includes("workflows"));
  assert.ok(!ids({ ...all, pageAvailable: (page) => page !== "examprep" }).includes("examprep"), "备考补习 is toured only while the host has it on");
  // Without the sample the short tour is still a tour: the model, add, make, then the line's step 2.
  assert.deepEqual(ids({ ...ALL, sample: { loaded: false }, line: true }), ["welcome", "settings-model", "sources", "generate-quick", "finish-line"]);
});

test("the group hints and the tour's sidebar step name every page of the group (任务 and 备考补习 included)", async () => {
  const { NAV_GROUPS } = await import("../ui/nav-order.js");
  const { PAGES: registry } = await import("../ui/pages.js");
  const nav = TOUR_STEPS.find((step) => step.id === "nav").body;
  for (const group of NAV_GROUPS) for (const id of NAV_DEFAULTS[group.id]) {
    assert.ok(group.hint.includes(registry[id].label), `${group.id} hint names ${registry[id].label}`);
    assert.ok(nav.includes(registry[id].label), `the sidebar step names ${registry[id].label}`);
  }
});

test("back, next and the keyboard move one step; Escape pauses", () => {
  const steps = TOUR_STEPS.slice(0, 4);
  assert.equal(tourNeighbour(steps, "nav", 1), "home");
  assert.equal(tourNeighbour(steps, "nav", -1), "welcome");
  assert.equal(tourNeighbour(steps, "welcome", -1), null);
  assert.equal(tourNeighbour(steps, steps.at(-1).id, 1), null);
  assert.equal(tourNeighbour(steps, "gone", 1), "welcome", "a step that disappeared restarts at the first one");
  assert.equal(tourKeyAction({ key: "ArrowRight" }), "next");
  assert.equal(tourKeyAction({ key: "ArrowLeft" }), "back");
  assert.equal(tourKeyAction({ key: "Escape" }), "close");
  assert.equal(tourKeyAction({ key: "ArrowRight", altKey: true }), null);
  assert.equal(tourKeyAction({ key: "a" }), null);
});

test("the QA journey has an onboarding set: --steps tour", async () => {
  const { parseJourneyArgs, JOURNEY_STEPS, TOUR_STEPS: journeyTour } = await import("../scripts/qa/journey.mjs");
  assert.deepEqual(journeyTour.map((step) => step.name), ["tour-welcome", "tour-walk", "tour-after"]);
  assert.deepEqual(parseJourneyArgs(["--steps", "tour"]).steps, ["tour-welcome", "tour-walk", "tour-after"]);
  assert.deepEqual(parseJourneyArgs(["--steps", "empty-home,tour-walk"]).steps, ["empty-home", "tour-walk"]);
  assert.deepEqual(parseJourneyArgs([]).steps, JOURNEY_STEPS.map((step) => step.name), "the default run is unchanged");
  assert.throws(() => parseJourneyArgs(["--steps", "tour-nope"]), /Unknown step "tour-nope"/);
});

test("the old JSON-centric guide is gone", async () => {
  await assert.rejects(access("ui/Guide.jsx"));
  for (const file of await sourceFiles("ui")) {
    const text = await readFile(file, "utf8");
    // The retired guide was a component (ui/Guide.jsx) and a chat-only prompt; the name 「study-guide」 is no longer banned:
    // 3.7.0 ships a real skill under that name (skills/study-guide/SKILL.md, lib/study-skills.js), which is not a page and hands nothing off.
    assert.doesNotMatch(text, /from ["']\.\/Guide\.jsx["']|<Guide\b/, file);
  }
  // Onboarding copy never sends a new learner to JSON imports or chat-only prompts.
  for (const file of ["ui/Welcome.jsx", ...(await sourceFiles("ui/tour"))]) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /study-spar|askInChat/, file);
    for (const literal of text.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) || [])
      if (han.test(literal)) assert.doesNotMatch(literal, /JSON|对话里|在对话中/, `${file}: ${literal}`);
  }
});
