/* WP5 · guided tour data (plan §4 C7) and navigation order (P11). The steps
   are data, so the source tree can be checked for every anchor they need. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { anchorsInSource, sourceFiles } from "./helpers/tour-anchors.mjs";
import { TOUR_STEPS, TOUR_CHAPTERS, availableTourSteps, tourNeighbour, tourNextChapter, tourKeyAction, tourStepCopy, chapterHeading,
  opensFromNav, CORE_TOUR_LENGTH, CORE_ORDER, FULL_TOUR_ORDER } from "../ui/tour/steps.js";
import { NAV_DEFAULTS, mergeOrder, migrateOrder } from "../ui/nav-order.js";

const han = /[㐀-鿿]/;
const english = JSON.parse(await readFile("ui/locales/en.onboarding.json", "utf8"));
const catalogue = Object.assign({}, ...await Promise.all((await readdir("ui/locales")).filter((name) => /^en(\..+)?\.json$/.test(name))
  .map(async (name) => JSON.parse(await readFile(join("ui/locales", name), "utf8")))));

/* Anchors another work package still has to add to its own pages (plan §5).
   WP3 and WP4 have merged, so every anchor must exist now. */
const PARALLEL = {};
const PLAN_ANCHORS = ["nav", "nav-library", "nav-sources", "nav-generate", "nav-wrongbook", "nav-exam", "nav-dashboard", "nav-skeleton",
  "nav-settings", "tour-reopen", "home-hero", "home-today", "home-catalog", "sources-list", "sources-add", "import-drop",
  "generate-from-sources", "generate-submit", "review-question", "review-help", "wrongbook-list", "exam-start", "dashboard-summary",
  "skeleton-main", "settings-model", "settings-audio", "settings-sample",
  // 2.1.2 refresh (WP29)
  "generate-sources", "generate-options", "generate-summary", "wrongbook-recs", "dashboard-charts", "settings-extensions", "settings-update",
  // #654–#657: the 「更多」 fold, the 「帮助」 fold and the narrow window's menu button
  "nav-more", "nav-help", "nav-menu"];
const PAGES = new Set(["library", "sources", "generate", "draft", "review", "wrongbook", "exam", "dashboard", "skeleton", "workflows",
  "settings", "notes", "board", "audio", "live", "graph", "manage", "tasks", "examprep", "examcoach", "book", "outline"]);

test("navigation is a main list of at most 6 pages and 「更多」 grouped by what the pages are about (#654)", () => {
  assert.deepEqual(NAV_DEFAULTS, {
    main: ["library", "sources", "generate", "wrongbook", "exam", "dashboard"],
    material: ["audio", "live"],
    practice: ["book", "skeleton"],
    exam: ["examprep", "examcoach"],
    notes: ["tasks", "notes", "board"],
  });
  // A learner's saved order still applies; pages it does not mention join at the end of their group.
  const saved = { main: ["dashboard", "library"], notes: ["board", "tasks"] };
  assert.deepEqual(mergeOrder(saved, NAV_DEFAULTS), {
    main: ["dashboard", "library", "sources", "generate", "wrongbook", "exam"],
    material: ["audio", "live"],
    practice: ["book", "skeleton"],
    exam: ["examprep", "examcoach"],
    notes: ["board", "tasks", "notes"],
  });
  // An order saved before the regrouping (每天 / 阶段性 / 课程准备与管理, or main / upkeep) keeps the learner's sequence inside the new groups.
  assert.deepEqual(migrateOrder({ main: ["library", "workflows", "live", "audio"], upkeep: ["sources", "generate", "skeleton"] }, NAV_DEFAULTS).material,
    ["live", "audio"]);
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
  assert.deepEqual(idsOf({ full: true }), ["welcome", "flow", "nav", "finder",
    "settings-model", "course", "appearance",
    "sources", "document", "reader-practice", "translation", "generate", "generate-tune", "generate-cost", "tasks", "draft", "draft-check",
    "home", "practice", "grading", "help", "guided-study", "round-end",
    "mastery", "wrongbook", "dashboard", "outline",
    "exam", "examprep", "exam-plan",
    "notes", "skeleton", "book", "board", "settings-audio", "settings-extensions", "backup", "finish"]);
  // A paused full tour is remembered as a step of THIS order: reorder the list or put a step before others, and this number goes up with the list above.
  assert.equal(FULL_TOUR_ORDER, 2);
  assert.ok(!idsOf({ full: true }).includes("generate-quick"), "the short generate step has longer siblings in the full tour");
  assert.deepEqual(idsOf({ full: true, line: true }), idsOf({ full: true }), "the full tour is the same whether or not the line is up");
  assert.equal(new Set(TOUR_STEPS.map((step) => step.id)).size, TOUR_STEPS.length, "unique ids");
  assert.equal(TOUR_STEPS[0].anchor, undefined, "the welcome step is centred");
  const anchors = new Set(TOUR_STEPS.flatMap((step) => [step.anchor].flat()).filter(Boolean));
  for (const anchor of ["reader-practice", "reader-more", "nav-tasks", "nav-notes", "nav-examprep"]) assert.ok(anchors.has(anchor), `${anchor} is toured`);
  for (const step of TOUR_STEPS) {
    if (step.page) assert.ok(PAGES.has(step.page), `${step.id}: unknown page ${step.page}`);
    for (const anchor of [step.anchor].flat().filter(Boolean)) assert.ok(PLAN_ANCHORS.includes(anchor) || ["source-tools", "reader-more", "draft-publish", "exam-case", "home-course",
      "reader-practice", "nav-tasks", "nav-notes", "nav-examprep", "tasks-head", "notes-head", "examprep-head", "first-run-material", "nav-finder", "settings-appearance", "draft-question", "home-mastery", "outline-tree", "outline-book", "board-today-head", "settings-backup"].includes(anchor), `${step.id}: anchor ${anchor} is not in the plan's list`);
  }
});

test("every step has a chapter, and the list walks the chapters in the learning order, each in one piece", () => {
  assert.deepEqual([...TOUR_CHAPTERS], ["开始", "前置", "备料", "练习", "复习", "考试", "更多"]);
  for (const step of TOUR_STEPS) assert.ok(TOUR_CHAPTERS.includes(step.chapter), `${step.id}: chapter ${step.chapter}`);
  const walked = TOUR_STEPS.map((step) => step.chapter).filter((chapter, at, all) => chapter !== all[at - 1]);
  assert.deepEqual(walked, [...TOUR_CHAPTERS], "no chapter comes back after the tour left it");
  const chapterOf = (id) => TOUR_STEPS.find((step) => step.id === id).chapter;
  for (const [id, chapter] of [["welcome", "开始"], ["nav", "开始"], ["settings-model", "前置"], ["course", "前置"], ["sources", "备料"], ["draft", "备料"],
    ["home", "练习"], ["guided-study", "练习"], ["wrongbook", "复习"], ["dashboard", "复习"], ["exam", "考试"], ["examprep", "考试"], ["notes", "更多"], ["finish", "更多"], ["finish-line", "更多"],
    ["flow", "开始"], ["finder", "开始"], ["appearance", "前置"], ["draft-check", "备料"], ["grading", "练习"], ["round-end", "练习"], ["mastery", "复习"], ["outline", "复习"],
    ["exam-plan", "考试"], ["book", "更多"], ["board", "更多"], ["backup", "更多"]])
    assert.equal(chapterOf(id), chapter, id);
  // The header says the chapter; each heading has its own English, so 前置 here is not the coverage view's 前置 ("Prerequisite").
  for (const chapter of TOUR_CHAPTERS) {
    assert.equal(chapterHeading(chapter), `功能导览 · ${chapter}`);
    assert.ok(english[chapterHeading(chapter)], `missing English for ${chapterHeading(chapter)}`);
    assert.doesNotMatch(english[chapterHeading(chapter)], han);
  }
  assert.ok(english["跳到下一章"], "the skip action has its English");
});

test("chapters belong to the full tour: no card of the short tour carries one, so its ending does not read as 更多", () => {
  for (const line of [false, true]) for (const step of availableTourSteps(TOUR_STEPS, { ...ALL, line })) assert.equal(step.chapter, undefined, step.id);
  for (const step of availableTourSteps(TOUR_STEPS, { ...ALL, full: true })) assert.ok(TOUR_CHAPTERS.includes(step.chapter), step.id);
  assert.equal(TOUR_STEPS.find((step) => step.id === "finish").chapter, "更多", "the list itself keeps its chapters");
});

test("a library with no published deck leaves out 掌握度, 总纲 and 复习全书: there is no figure, tree or button for them to talk about", () => {
  const without = idsOf({ full: true, sample: { loaded: false }, hasDeck: false });
  for (const id of ["mastery", "outline", "book"]) assert.ok(!without.includes(id), id);
  const own = idsOf({ full: true, sample: { loaded: false }, hasDeck: true });
  for (const id of ["mastery", "outline", "book"]) assert.ok(own.includes(id), `${id}: the learner's own deck is enough, no sample needed`);
  assert.deepEqual(own.filter((id) => !without.includes(id)), ["mastery", "outline", "book"], "only those three depend on it");
});

test("跳到下一章 goes to the first step of the next chapter that is shown, and nowhere from the last chapter", () => {
  const full = availableTourSteps(TOUR_STEPS, { ...ALL, full: true });
  assert.equal(tourNextChapter(full, "welcome"), "settings-model");
  assert.equal(tourNextChapter(full, "nav"), "settings-model", "from the middle of a chapter too");
  assert.equal(tourNextChapter(full, "settings-model"), "sources");
  assert.equal(tourNextChapter(full, "translation"), "home");
  assert.equal(tourNextChapter(full, "help"), "mastery");
  assert.equal(tourNextChapter(full, "dashboard"), "exam");
  assert.equal(tourNextChapter(full, "exam"), "notes");
  for (const step of full.filter((item) => item.chapter === "更多")) assert.equal(tourNextChapter(full, step.id), null, step.id);
  assert.equal(tourNextChapter(full, "gone"), null, "a step that disappeared offers no jump (下一步 restarts at the first)");
  // A chapter whose first step is left out is entered at its first step that is there.
  const noExam = availableTourSteps(TOUR_STEPS, { ...ALL, full: true, pageAvailable: (page) => page !== "exam" });
  assert.equal(tourNextChapter(noExam, "dashboard"), "examprep");
});

test("the reader's 原始 PDF page bar and page panel carry their tour anchors (#456)", async () => {
  const anchors = await anchorsInSource();
  for (const anchor of ["reader-pdf-bar", "reader-page-ask"]) assert.ok(anchors.has(anchor), anchor);
});

test("#1712: a step that lights a sidebar entry for its page falls back to that page's own heading, not to the menu button", () => {
  const entries = TOUR_STEPS.filter((step) => step.page && [step.anchor].flat()[0] === `nav-${step.page}`);
  assert.deepEqual(entries.map((step) => step.id).filter((id) => ["tasks", "examprep", "notes"].includes(id)).sort(), ["examprep", "notes", "tasks"]);
  for (const step of entries) {
    assert.deepEqual(step.anchor, [`nav-${step.page}`, `${step.page}-head`], step.id);
    assert.equal(opensFromNav(step), true, `${step.id}: its card keeps off the page's first block`);
  }
  assert.equal(opensFromNav(TOUR_STEPS.find((step) => step.id === "nav")), true);
  for (const id of ["welcome", "sources", "dashboard", "settings-model"]) assert.equal(opensFromNav(TOUR_STEPS.find((step) => step.id === id)), false, id);
});

test("the full tour's own wording of a core step never reaches the short tour", () => {
  const shortFinish = availableTourSteps(TOUR_STEPS, ALL).find((step) => step.id === "finish");
  const fullFinish = availableTourSteps(TOUR_STEPS, { ...ALL, full: true }).find((step) => step.id === "finish");
  assert.equal(shortFinish.body, "点「添加资料」就能开始。示例数据可以随时在这里移除，你自己的资料和记录不受影响。", "the short tour is as it was");
  for (const words of ["每天一轮", "每周回头清错题", "单元末限时模拟", "「帮助」"]) assert.ok(fullFinish.body.includes(words), words);
  assert.ok(tourStepCopy(TOUR_STEPS.find((step) => step.id === "finish")).includes(fullFinish.body), "its English is checked with the rest");
  assert.equal(TOUR_STEPS.find((step) => step.id === "finish").body, shortFinish.body, "the list itself is not changed by a full tour");
  // The short tour's steps, with their texts, are the ones it had.
  assert.deepEqual(availableTourSteps(TOUR_STEPS, ALL).map((step) => [step.id, step.body]),
    ["welcome", "settings-model", "sources", "generate-quick", "draft", "practice", "finish"].map((id) => [id, TOUR_STEPS.find((step) => step.id === id).body]));
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

test("the tour's English calls a control what the English interface calls it", () => {
  const plain = (name) => name.replace(/…$/, "").toLowerCase();
  // 「前置」 in 创建题组's note is the tour's own chapter, whose heading is 功能导览 · 前置 (前置 alone is the coverage view's word).
  const own = new Set(["generate:前置"]);
  const wrong = [];
  for (const step of TOUR_STEPS) for (const zh of tourStepCopy(step)) {
    for (const [, quoted] of zh.matchAll(/「([^」]+)」/g)) for (const name of quoted.split(" › ")) {
      const product = catalogue[name] ?? catalogue[`${name}…`];
      if (product && !own.has(`${step.id}:${name}`) && !catalogue[zh].toLowerCase().includes(plain(product))) wrong.push(`${step.id}: ${name} is “${product}”`);
    }
  }
  assert.deepEqual(wrong, []);
  // The mastery levels are said without quotes: the same words as the legend's.
  const mastery = TOUR_STEPS.find((step) => step.id === "mastery").body;
  for (const level of ["未学", "薄弱", "学习中", "熟悉", "已掌握"]) assert.ok(catalogue[mastery].includes(catalogue[level]), `${level} is “${catalogue[level]}”`);
});

test("steps that need sample data, a page or a component are left out when it is missing", () => {
  const all = { ...ALL, full: true };
  assert.equal(availableTourSteps(TOUR_STEPS, all).length, TOUR_STEPS.filter((step) => step.only !== "core").length);
  const ids = (ctx) => availableTourSteps(TOUR_STEPS, ctx).map((step) => step.id);
  const bare = ids({ ...all, sample: { loaded: false } });
  for (const id of ["document", "reader-practice", "translation", "draft", "draft-check", "practice", "grading", "help", "guided-study"]) assert.ok(!bare.includes(id), id);
  for (const id of ["flow", "finder", "appearance", "round-end", "mastery", "outline", "exam-plan", "book", "board", "backup"]) assert.ok(bare.includes(id), `${id} needs no sample`);
  for (const id of ["welcome", "nav", "home", "sources", "generate", "tasks", "wrongbook", "settings-model", "finish"]) assert.ok(bare.includes(id), id);
  assert.ok(!ids({ ...all, sample: { ...all.sample, draftId: null } }).includes("draft"), "a published sample draft drops the draft step");
  assert.ok(!ids({ ...all, hasContext: (id) => id !== "audio" }).includes("settings-audio"));
  assert.ok(!ids({ ...all, hasContext: (id) => id !== "audio" }).includes("settings-audio"));
  assert.ok(!ids({ ...all, pageAvailable: (page) => page !== "examprep" }).includes("examprep"), "备考补习 is toured only while the host has it on");
  for (const [page, gone] of [["outline", ["outline", "book"]], ["board", ["board"]], ["settings", ["appearance", "backup"]]])
    for (const id of gone) assert.ok(!ids({ ...all, pageAvailable: (name) => name !== page }).includes(id), `${id} goes with its page`);
  // Without the sample the short tour is still a tour: the model, add, make, then the line's step 2.
  assert.deepEqual(ids({ ...ALL, sample: { loaded: false }, line: true }), ["welcome", "settings-model", "sources", "generate-quick", "finish-line"]);
});

test("the tour's sidebar step describes the layout of #654–#657: the main pages, every section of 「更多」, the footer and the narrow menu", async () => {
  const { NAV_GROUPS } = await import("../ui/nav-order.js");
  const { PAGES: registry } = await import("../ui/pages.js");
  const step = TOUR_STEPS.find((item) => item.id === "nav");
  for (const id of NAV_DEFAULTS.main) assert.ok(step.body.includes(registry[id].label), `the sidebar step names ${registry[id].label}`);
  for (const group of NAV_GROUPS.filter((item) => item.more)) assert.ok(step.body.includes(group.label), `the sidebar step names the section ${group.label}`);
  for (const word of ["更多", "找功能", "帮助", "设置", "菜单"]) assert.ok(step.body.includes(word), word);
  assert.doesNotMatch(step.body, /每天|阶段性|课程准备与管理|切换语言和外观|点标题收起/, "the old groups and footer switches are gone");
  // In a narrow window the sidebar is a drawer behind the top bar's menu button: the step falls back to that button.
  assert.deepEqual(step.anchor, ["nav", "nav-menu"]);
});

test("back, next and the keyboard move one step; Escape pauses", () => {
  const steps = TOUR_STEPS.slice(0, 4);
  assert.equal(tourNeighbour(steps, "nav", 1), "finder");
  assert.equal(tourNeighbour(steps, "nav", -1), "flow");
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
