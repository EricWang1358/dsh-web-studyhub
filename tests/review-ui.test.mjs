import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewElement } from "./helpers/review-render.mjs";

const compiled = await build({ stdin: { contents: "export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx';", resolveDir: process.cwd() }, bundle: true,
  write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Review = module.exports.default;
const reviewEl = (old) => reviewElement(Review, module.exports.StudyServicesContext, old);
function render(kind, revealed, runPatch = {}, dataPatch = {}) {
  const card = { id: "q", kind, topic: "Context", prompt: "Who processes payments?",
    options: [{ id: "a", text: "Payment System" }],
    cloze: { text: "付款由 {{actor}} 处理。", blanks: [{ id: "actor" }] } };
  return renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card, revealed,
      feedback: revealed ? { correct: false, details: [{ id: "actor", correct: false, expected: "Payment System" }] } : null,
      solution: revealed ? { answer: "Payment System", explanation: "Payment System handles payments.",
        cloze: { answers: [{ id: "actor", value: "Payment System" }] } } : null, ...runPatch },
    data: { sources: [], ...dataPatch }, host: {}, choice: ["quiz", "multi"].includes(kind), isCloze: kind === "cloze",
    selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
  }));
}
function renderResult(status, next = "review_weak") {
  const card = { id: "q", kind: "quiz", topic: "Context", prompt: "Who processes payments?", options: [] };
  const debrief = { headline: "先把「Context」补稳。", why: "", next, insights: [],
    metrics: { answered: 4, gradedAnswered: 4, gradedCorrect: 2 }, status };
  const noop = () => {};
  return renderToStaticMarkup(reviewEl({
    run: { id: "r", mode: "path", complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 2,
      weakTopics: ["Context"], scope: [], card },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {},
    shellTitle: "Review", busy: false, act: noop, enterRun: noop, setPage: noop, askInChat: noop,
    coachProps: { call: async () => ({}), debrief, autopilot: false, onPractice: noop, onContinue: noop, onReviewWeak: noop },
  }));
}

test("review action feedback is in the question's local tools area", () => {
  const html = renderToStaticMarkup(reviewEl({
    run: { id: "feedback-run", index: 0, total: 1, mode: "path", card: {
      id: "feedback-card", kind: "quiz", topic: "Context", prompt: "Which context?", options: [],
    } }, data: { sources: [] }, host: {}, choice: true, selected: [], clozeValues: {},
    feedback: React.createElement("p", { role: "status" }, "Help was submitted"),
  }));
  assert.match(html, /Help was submitted/);
  assert.ok(html.indexOf("Help was submitted") > html.indexOf('class="question-toolbar"'));
});
test("the round's debrief sits under the score, and asks once before preparing 定制题", () => {
  const ask = renderResult({ enabled: true, consent: null, ready: 0 });
  assert.match(ask, /data-next="review_weak"[^>]*class="study-reading coach-debrief"/, "the debrief is a reading block (the Aa setting applies to its text)");
  assert.ok(ask.indexOf("coach-debrief") < ask.indexOf("result-details"), "not folded under 更多结果与练习");
  assert.match(ask, /好，帮我备题/);
  assert.doesNotMatch(renderResult({ enabled: true, consent: false, ready: 0 }), /好，帮我备题/, "a no is not asked again");
  assert.doesNotMatch(renderResult({ enabled: false, consent: null, ready: 0 }), /好，帮我备题/, "no model, no offer");
  assert.match(renderResult({ enabled: true, consent: true, ready: 3 }), /刷 3 道为你定制的题/);
});
test("imported question citations and verification warning start collapsed", () => {
  const source = { id: "import", title: "JSON 导入：90题", provenance: "json-card-self-reference" };
  const html = render("quiz", true, {
    solution: { answer: "Payment System", explanation: "Explanation", citations: [
      { sourceId: source.id, quote: "A long imported question body" },
    ] },
  }, { sources: [source] });
  assert.match(html, /<details class="citation-disclosure"/);
  assert.match(html, /引用与来源核对/);
  assert.doesNotMatch(html, /A long imported question body|这些引用来自导入的题目自身/);
});
for (const kind of ["quiz", "multi", "cloze", "flashcard", "open"]) {
  test(`${kind} keeps hint before answering and shows explanation directly afterwards`, () => {
    for (const revealed of [false, true]) {
      const html = render(kind, revealed);
      assert.equal((html.match(/class="question-toolbar"/g) || []).length, 1);
      if (revealed) {
        assert.doesNotMatch(html, />讲解<\/button>/);
        assert.match(html, /理解这道题/);
        assert.match(html, /Payment System handles payments/);
      } else {
        assert.match(html, />提示<\/button>/);
        assert.doesNotMatch(html, /理解这道题/);
      }
      assert.doesNotMatch(html, /✧ 讲解|⌃|⌄/);
    }
  });
}
test("cloze shows each correction once without claiming a lost answer was blank", () => {
  const html = render("cloze", true);
  assert.doesNotMatch(html, /cloze-verdicts|空<\/span>/);
  assert.match(html, /Payment System/);
});

test("choice feedback maps stored IDs to shuffled display letters and separates missed and wrong selections", () => {
  const patch = {
    card: { id: "q", kind: "multi", prompt: "Select", options: ["d", "b", "a", "c"].map((id) => ({ id, text: id })) },
    feedback: { selected: ["d", "b", "c"] },
    solution: { options: ["a", "b", "c", "d"].map((id) => ({ id, correct: id !== "c" })) },
  };
  const html = render("multi", true, patch);
  assert.match(html, /你的答案：<strong>ABD<\/strong>/);
  assert.match(html, /正确答案：<strong>ABC<\/strong>/);
  assert.match(html, /漏选：<strong>C<\/strong>/);
  assert.match(html, /错选：<strong>D<\/strong>/);
  const before = render("multi", false, { ...patch, feedback: null, solution: null });
  assert.doesNotMatch(before, /choice-feedback|你的答案：|正确答案：/);
  const right = render("quiz", true, { ...patch, feedback: { selected: ["d", "b", "a"] } });
  assert.doesNotMatch(right, /漏选：|错选：/);
  const single = render("quiz", true, { ...patch, card: { ...patch.card, kind: "quiz" },
    feedback: { selected: ["d"] }, solution: { options: ["a", "b", "c", "d"].map((id) => ({ id, correct: id === "a" })) } });
  assert.match(single, /你的答案：<strong>A<\/strong>/);
  assert.match(single, /正确答案：<strong>C<\/strong>/);
  assert.doesNotMatch(single, /漏选|错选/, "a single-choice question has nothing to miss or over-select");
});
test("a flashcard's prerequisite strip sits below the card, clear of its floating header", () => {
  const prerequisites = [{ deckId: "d", cardId: "p", prompt: "CAP 是什么？", level: "familiar" }];
  const flash = render("flashcard", false, { prerequisites });
  const strip = flash.indexOf('class="prereq-strip"');
  assert.ok(strip > 0, "the strip is shown");
  assert.ok(strip > flash.lastIndexOf('class="flip-face'), "below both card faces, not under the absolute header");
  const quiz = render("quiz", false, { prerequisites });
  assert.ok(quiz.indexOf('class="prereq-strip"') < quiz.indexOf('class="options"'), "a choice card keeps it above the options");
  assert.equal((flash.match(/class="prereq-strip"/g) || []).length, 1, "rendered once");
});
test("each Q&A folds: the newest starts open, the rest closed, with one control for all", () => {
  const followups = ["一", "二", "三"].map((n, i) => ({ id: `f${i}`, question: `第${n}个问题？`, answer: `第${n}个回答` }));
  const solution = { answer: "Payment System", explanation: "Explanation", followups };
  const html = render("quiz", true, { solution });
  const items = html.match(/<details class="followup-item"[^>]*>/g) || [];
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((tag) => / open=""/.test(tag)), [false, false, true], "only the newest is open");
  assert.match(html, /3 条问答/);
  assert.match(html, />全部展开</);
  assert.match(html, /<summary><span class="en-tag">Q&amp;A<\/span><h4>第一个问题？<\/h4><span class="followup-state" aria-hidden="true">展开<\/span><\/summary>/, "the question is the fold's title, with its state in words (#160)");
  assert.match(html, /<h4>第三个问题？<\/h4><span class="followup-state" aria-hidden="true">收起<\/span>/, "the open one offers to fold");
  const single = render("quiz", true, { solution: { ...solution, followups: followups.slice(0, 1) } });
  assert.match(single, /<details class="followup-item" open="">/);
  assert.doesNotMatch(single, /条问答/, "no bulk control for a single Q&A");
});
test("a question reached from the inbox offers the way back to where the learner was", () => {
  const html = renderToStaticMarkup(reviewEl({
    run: { id: "letter", index: 0, total: 1, card: { id: "q", kind: "flashcard", topic: "T", prompt: "Q?" }, revealed: false, feedback: null },
    detour: { runId: "course", index: 4, title: "课程 · Cloud Native" }, onReturnFromDetour: () => {},
    data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, shellTitle: "信箱", busy: false,
  }));
  assert.match(html, /class="review-detour"[^>]*>← 回到之前的第 5 题</);
});

test("a failed background assist offers 重新提交 and 改一改再提交 buttons (it used to only say 'you can submit again')", () => {
  const card = { id: "q", kind: "quiz", topic: "Context", prompt: "Who processes payments?", options: [{ id: "a", text: "Payment System" }] };
  const html = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
    assistTasks: [{ id: "t", cardId: "q", mode: "ask", status: "failed", message: "新前置题格式无效", question: "为什么？", choices: ["prerequisite"] }],
  }));
  assert.match(html, /后台助教没能完成：新前置题格式无效/);
  assert.match(html, /<button[^>]*>重新提交<\/button>/);
  assert.match(html, /<button[^>]*>改一改再提交<\/button>/);
  assert.doesNotMatch(html, /。可以重新提交。/);
  const grade = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
    assistTasks: [{ id: "t", cardId: "q", mode: "grade", status: "failed", message: "x" }],
  }));
  assert.doesNotMatch(grade, /重新提交/, "a grading task has its own flow");
});

test("the review page's column follows the shared reading width, so 版心宽度 changes the card and the explanation, not only the text inside a fixed 700px column", async () => {
  const { readFileSync } = await import("node:fs");
  const html = render("quiz", true);
  const area = /<div class="question-area[^"]*"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(area, /--reading-measure:\s*\d+px/, "the reading measure reaches the column");
  assert.match(area, /--review-column:\s*calc\(var\(--reading-measure\)\s*-\s*4px\)/);
  assert.match(area, /--card-scale:\s*1(;|$)/, "16px is the designed size: scale 1");
  const css = readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  assert.match(css, /\.question-area\s*\{[^}]*width:\s*min\(var\(--review-column,\s*700px\),\s*calc\(100% - 48px\)\)/, "the column is no longer a fixed 700px");
  for (const [name, pattern] of [
    ["the stem", /\.question \{[^}]*font-size:\s*calc\(21px \* var\(--card-scale, 1\)\)/],
    ["the options", /\.option \{[^}]*font-size:\s*calc\(16\.5px \* var\(--card-scale, 1\)\)/],
    ["the flashcard face", /\.flash-prompt \{[^}]*font-size:\s*calc\(27px \* var\(--card-scale, 1\)\)/],
  ]) assert.match(css, pattern, `${name} follows the reading size`);
});

test("each Q&A of a card offers 出成前置题 and 出成独立题; a failed 出成题 task can be sent again as it was", () => {
  const followups = [{ id: "f0", question: "什么是桥接？", answer: "它把两个维度分开。" }];
  const solution = { answer: "Payment System", explanation: "Explanation", followups };
  const html = render("quiz", true, { solution }, {});
  // the Q&A list is read-only in the page, but the derive links are actions on each item
  assert.match(html, /出成前置题/);
  const withHandler = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card: { id: "q", kind: "quiz", topic: "Context", prompt: "P?", options: [{ id: "a", text: "A" }] }, revealed: true,
      feedback: { correct: true, details: [] }, solution },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false, assistCard() {},
    assistTasks: [{ id: "t", cardId: "q", mode: "derive", status: "failed", message: "新题和当前这道题重复，没有保存", question: "", relation: "prerequisite", followupId: "f0" }],
  }));
  assert.match(withHandler, /data-usage="review\.derive-prereq"[^>]*>出成前置题</);
  assert.match(withHandler, /data-usage="review\.derive-standalone"[^>]*>出成独立题</);
  assert.match(withHandler, /后台助教没能完成：新题和当前这道题重复，没有保存/);
  assert.match(withHandler, /<button[^>]*>重新提交<\/button>/);
  assert.doesNotMatch(withHandler, /改一改再提交/, "a Q&A-based task has nothing to edit: only a typed knowledge point does");
  const typed = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card: { id: "q", kind: "quiz", topic: "Context", prompt: "P?", options: [{ id: "a", text: "A" }] }, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false, assistCard() {},
    assistTasks: [{ id: "t", cardId: "q", mode: "derive", status: "failed", message: "x", question: "什么是聚合根", relation: "standalone" }],
  }));
  assert.match(typed, /<button[^>]*>改一改再提交<\/button>/, "a typed knowledge point can be edited first");
});

test("a stem that asks what the source says is called out with a one-click fix, and 修题 offers the usual problems as choices", () => {
  const make = (prompt, assistMode, extra = {}) => renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card: { id: "q", kind: "flashcard", topic: "API", prompt, options: [] }, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false, assistCard() {}, ...extra }));
  const bad = make("API 返回 4xx 与 5xx 时，资料用什么基本区别帮助开发者定位问题？");
  assert.match(bad, /这道题在问「资料怎么说」/);
  assert.match(bad, /data-usage="review\.voice-fix"[^>]*>改成概念或情景题</);
  const good = make("4xx 与 5xx 有什么基本区别？");
  assert.doesNotMatch(good, /在问「资料怎么说」/, "a normal question gets no hint");
  const exam = renderToStaticMarkup(reviewEl({
    run: { id: "r", mode: "exam", index: 0, total: 2, card: { id: "q", kind: "flashcard", topic: "API", prompt: "资料说了什么？", options: [] }, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false, assistCard() {} }));
  assert.doesNotMatch(exam, /在问「资料怎么说」/, "no hint in an exam");
});
