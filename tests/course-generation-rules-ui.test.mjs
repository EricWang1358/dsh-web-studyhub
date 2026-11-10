import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";
import { inApp } from "./helpers/fake-app.mjs";

/* 出题守则 (#889) on the page: 「设为本课守则」 under the 修题 box and on the 👎 tray shows the course and the rules before anything is saved, says what cannot
   be added, and adds only on 加为守则; the course settings list the rules to edit and delete. The markup is rendered on the server; click handlers are caught
   as the elements are created (as tests/fix-phrases-ui.test.mjs does). */
const compiled = await build({
  stdin: { contents: [
    "export * from './ui/course-rules/CourseRuleAdd.jsx';",
    "export { default as CourseRulesEditor } from './ui/course-rules/CourseRulesEditor.jsx';",
    "export { ruleTextsForTags } from './ui/course-rules/tag-rules.js';",
    "export { draftFromCourse, payloadFromDraft } from './ui/CourseSettings.jsx';",
    "export { StudyServicesContext } from './ui/study-context.jsx';",
    "export { setUiLanguage } from './ui/i18n.js';",
  ].join("\n"), resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom", "react-dom/*", "@base-ui/*"], loader: { ".css": "text" }, logLevel: "silent" });
const realRequire = createRequire(import.meta.url);
let handlers = [];
const watchedReact = { ...React, createElement: (type, props, ...children) => {
  if (props && (props.onClick || props.onChange) && typeof type === "string") handlers.push({ type, props });
  return React.createElement(type, props, ...children);
} };
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)((id) => (id === "react" ? watchedReact : realRequire(id)), module, module.exports);
const { CourseRuleAdd, CourseRuleConfirm, rulePlan, CourseRulesEditor, ruleTextsForTags, draftFromCourse, payloadFromDraft, StudyServicesContext, setUiLanguage } = module.exports;

const press = (item) => item.props.onClick({ currentTarget: { offsetWidth: 0, style: { setProperty() {} } }, preventDefault() {} });
const render = (element) => { handlers = []; return renderToStaticMarkup(React.createElement(StudyServicesContext.Provider, { value: { busy: false } }, element)); };
const TRAY_TAGS = ["stem-vague", "bad-options", "too-easy", "too-hard", "wrong-answer", "unclear-explanation", "source-recall"];
const RULE = "题干要自带条件";

test("every 👎 tag of the tray stands for one rule, worded as what the course's questions should do", () => {
  setUiLanguage("zh");
  const texts = ruleTextsForTags(TRAY_TAGS);
  assert.equal(texts.length, TRAY_TAGS.length);
  assert.equal(new Set(texts).size, TRAY_TAGS.length);
  assert.deepEqual(ruleTextsForTags(["general-quality"]), [], "the bare 👎 offers no rule");
  setUiLanguage("en");
  assert.doesNotMatch(ruleTextsForTags(["stem-vague"])[0], /[㐀-鿿]/, "an English interface adds the English wording");
  setUiLanguage("zh");
});

test("the plan says which texts become rules and why the others cannot", () => {
  const full = Array.from({ length: 12 }, (_, index) => `rule ${index}`);
  assert.deepEqual(rulePlan([], [` ${RULE} `]), { adding: [RULE], refused: [] });
  assert.deepEqual(rulePlan([RULE], [RULE]).refused, [{ text: RULE, reason: "saved" }]);
  assert.deepEqual(rulePlan(full, ["one more"]).refused, [{ text: "one more", reason: "full" }]);
  assert.deepEqual(rulePlan([], ["x".repeat(201)]).refused.map((item) => item.reason), ["long"]);
});

test("under the 修题 box: 「设为本课守则」 only when the box has text and the question has a course", () => {
  setUiLanguage("zh");
  const courseRules = { course: "数据库", rules: [], add: async () => true };
  assert.match(render(React.createElement(CourseRuleAdd, { courseRules, text: RULE })), /设为本课守则/);
  assert.equal(render(React.createElement(CourseRuleAdd, { courseRules, text: "  " })), "");
  assert.equal(render(React.createElement(CourseRuleAdd, { courseRules: { ...courseRules, course: "" }, text: RULE })), "");
});

test("the confirmation names the course and the rules, and only 加为守则 saves them", async () => {
  setUiLanguage("zh");
  const added = [];
  let closed = 0;
  const courseRules = { course: "数据库", rules: ["已有守则"], add: async (texts) => { added.push(texts); return true; } };
  const html = render(React.createElement(CourseRuleConfirm, { courseRules, texts: [RULE, "已有守则"], onClose: () => { closed++; } }));
  assert.match(html, /加为「数据库」的出题守则？/);
  assert.match(html, new RegExp(RULE));
  assert.match(html, /已经是这门课的出题守则/, "a text that already is a rule is named with its reason");
  assert.equal(added.length, 0, "nothing is saved by showing it");
  assert.match(html, />加为守则</);
  // The confirmation's buttons go cancel first, confirm last (ui/components/InlineConfirm.jsx).
  const confirm = handlers.filter((item) => item.type === "button").at(-1);
  assert.ok(confirm, "a 加为守则 button");
  await press(confirm);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(added, [[RULE]], "only the rule that can be added is saved");
  assert.equal(closed, 1, "the confirmation closes once the rule is saved");
});

test("when nothing can be added the learner is told why and nothing can be confirmed", () => {
  setUiLanguage("zh");
  const full = Array.from({ length: 12 }, (_, index) => `rule ${index}`);
  const html = render(React.createElement(CourseRuleConfirm, { courseRules: { course: "数据库", rules: full, add: async () => true }, texts: [RULE], onClose() {} }));
  assert.match(html, /这门课已有 12 条出题守则/);
  assert.doesNotMatch(html, /加为守则/);
});

test("the course settings list each rule to edit and delete, add a new one, and save the list with the course", () => {
  setUiLanguage("zh");
  const changes = [];
  const html = render(React.createElement(CourseRulesEditor, { value: ["第一条", "第二条"], onChange: (next) => changes.push(next) }));
  assert.match(html, /value="第一条"/);
  assert.match(html, /aria-label="删除第 2 条守则"/);
  press(handlers.find((item) => item.type === "button" && item.props["aria-label"] === "删除第 1 条守则"));
  assert.deepEqual(changes.at(-1), ["第二条"]);
  const inputs = handlers.filter((item) => item.type === "input");
  inputs[0].props.onChange({ target: { value: "第一条（改）" } });
  assert.deepEqual(changes.at(-1), ["第一条（改）", "第二条"]);

  const course = { id: "course-1", name: "数据库", generationRules: ["第一条"] };
  const draft = draftFromCourse(course);
  assert.deepEqual(draft.generationRules, ["第一条"]);
  assert.deepEqual(payloadFromDraft(course, { ...draft, generationRules: [] }).generationRules, [], "deleting every rule sends an empty list");
  assert.equal(payloadFromDraft({ id: "c2", name: "无守则" }, draftFromCourse({ id: "c2", name: "无守则" })).generationRules, undefined, "a course without rules sends none");
});

/* The draft page after the course's rules changed (#889 review follow-up): the banner says the review no longer counts, and the hint's count of questions not
   reviewed by a model says the same, instead of the questions the old review vouched for. */
const draftPage = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { reviewedCardFingerprint } from './lib/review-integrity.js';
`);

test("the draft page counts every question as not reviewed once the course's rules changed after its review", () => {
  const m = draftPage;
  m.setUiLanguage("zh");
  const card = (id) => ({ id, kind: "quiz", topic: "t", prompt: `问题 ${id}`, answer: "a", hint: "h", explanation: "e", misconception: "x", options: [], citations: [] });
  const cards = [card("c1"), card("c2")];
  const draft = { id: "d1", title: "T", draftVersion: 1, course: "数据库", cards, editorial: {
    generation: { kind: "quiz", course: "数据库", moduleOverrides: { courseRules: [RULE] } }, reviewedRequirementsDigest: "req",
    reviewedCards: Object.fromEntries(cards.map((item) => [item.id, m.reviewedCardFingerprint(item)])) } };
  const noop = () => {};
  const page = (rules) => {
    const data = { sources: [], decks: [], drafts: [draft], jobs: [], runs: [], modelReady: true, revision: "r1", courses: [{ id: "course-1", name: "数据库", generationRules: rules }] };
    return renderToStaticMarkup(inApp(m, React.createElement(m.Draft, { data, draft, draftLoaded: JSON.stringify(draft), setDraft: noop, draftText: "", setDraftText: noop, jsonMode: false,
      setJsonMode: noop, openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setModal: noop, blankCard: noop, patchCard: noop,
      parseDraft: JSON.parse, topUpDraft: noop }), { data }));
  };
  const unchanged = page([RULE]);
  assert.doesNotMatch(unchanged, /data-course-rules-changed/);
  assert.doesNotMatch(unchanged, /题未经过模型审阅/, "the review still vouches for every question");
  const changed = page([RULE, "另一条守则"]);
  assert.match(changed, /data-course-rules-changed/);
  assert.match(changed, /2 题未经过模型审阅/, "no question counts as reviewed under rules the course no longer has");
});
