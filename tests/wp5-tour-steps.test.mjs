/* WP5 · guided tour data (plan §4 C7) and navigation order (P11). The steps
   are data, so the source tree can be checked for every anchor they need. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { TOUR_STEPS, availableTourSteps, tourNeighbour, tourKeyAction, tourStepCopy } from "../ui/tour/steps.js";
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
  "skeleton-main", "workflows-main", "settings-model", "settings-audio", "settings-sample"];
const PAGES = new Set(["library", "sources", "generate", "draft", "review", "wrongbook", "exam", "dashboard", "skeleton", "workflows",
  "settings", "notes", "board", "audio", "live", "graph", "manage"]);

test("navigation puts the core loop first and the upkeep tools after it", () => {
  assert.deepEqual(NAV_DEFAULTS, {
    main: ["library", "sources", "generate", "wrongbook", "exam", "dashboard"],
    upkeep: ["workflows", "skeleton", "notes", "audio", "live", "board"],
  });
  // A learner's saved order still applies; pages it does not mention join at the end of their group.
  const saved = { main: ["exam", "library"], upkeep: ["board", "audio"] };
  assert.deepEqual(mergeOrder(saved, NAV_DEFAULTS), {
    main: ["exam", "library", "sources", "generate", "wrongbook", "dashboard"],
    upkeep: ["board", "audio", "workflows", "skeleton", "notes", "live"],
  });
  // An order saved before the regrouping (sources / generate were upkeep) keeps working.
  assert.deepEqual(mergeOrder({ main: ["library", "workflows", "live", "audio"], upkeep: ["sources", "generate", "skeleton"] }, NAV_DEFAULTS).main,
    ["library", "sources", "generate", "wrongbook", "exam", "dashboard"]);
});

test("the tour walks the key features in order: welcome → navigation → home → materials → … → settings → finish", () => {
  assert.deepEqual(TOUR_STEPS.map((step) => step.id), ["welcome", "nav", "home", "course", "sources", "document", "generate", "draft", "practice", "help",
    "wrongbook", "exam", "case", "dashboard", "skeleton", "workflows", "settings-model", "settings-audio", "finish"]);
  assert.equal(new Set(TOUR_STEPS.map((step) => step.id)).size, TOUR_STEPS.length, "unique ids");
  assert.equal(TOUR_STEPS[0].anchor, undefined, "the welcome step is centred");
  assert.equal(TOUR_STEPS.at(-1).final, true);
  for (const step of TOUR_STEPS) {
    if (step.page) assert.ok(PAGES.has(step.page), `${step.id}: unknown page ${step.page}`);
    for (const anchor of [step.anchor].flat().filter(Boolean)) assert.ok(PLAN_ANCHORS.includes(anchor) || ["source-tools", "draft-publish", "exam-case", "home-course"].includes(anchor),
      `${step.id}: anchor ${anchor} is not in the plan's list`);
  }
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
  const all = { sample: { loaded: true, deckId: "d", sourceId: "s", draftId: "r" }, pageAvailable: () => true, hasContext: () => true };
  assert.equal(availableTourSteps(TOUR_STEPS, all).length, TOUR_STEPS.length);
  const ids = (ctx) => availableTourSteps(TOUR_STEPS, ctx).map((step) => step.id);
  const bare = ids({ ...all, sample: { loaded: false } });
  for (const id of ["document", "draft", "practice", "help"]) assert.ok(!bare.includes(id), id);
  for (const id of ["welcome", "nav", "home", "sources", "generate", "wrongbook", "settings-model", "finish"]) assert.ok(bare.includes(id), id);
  assert.ok(!ids({ ...all, sample: { ...all.sample, draftId: null } }).includes("draft"), "a published sample draft drops the draft step");
  assert.ok(!ids({ ...all, hasContext: (id) => id !== "audio" }).includes("settings-audio"));
  assert.ok(!ids({ ...all, pageAvailable: (page) => page !== "workflows" }).includes("workflows"));
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
    assert.doesNotMatch(text, /from ["']\.\/Guide\.jsx["']|<Guide\b|study-guide/, file);
  }
  // Onboarding copy never sends a new learner to JSON imports or chat-only prompts.
  for (const file of ["ui/Welcome.jsx", ...(await sourceFiles("ui/tour"))]) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /study-spar|askInChat/, file);
    for (const literal of text.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) || [])
      if (han.test(literal)) assert.doesNotMatch(literal, /JSON|对话里|在对话中/, `${file}: ${literal}`);
  }
});
