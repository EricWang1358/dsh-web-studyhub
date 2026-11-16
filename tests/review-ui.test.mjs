import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalCss } from "./helpers/global-css.mjs";
import { reviewElement } from "./helpers/review-render.mjs";

const compiled = await build({ stdin: { contents: "export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { formatAssistTaskSummary } from './ui/review/QuestionRun.jsx';", resolveDir: process.cwd() }, bundle: true,
  write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Review = module.exports.default;
const { formatAssistTaskSummary } = module.exports;
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
    coachProps: { debrief, autopilot: false, onPractice: noop, onContinue: noop, onReviewWeak: noop },
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
test("a cloze draws the formulas of its text and of its expected answer, a blank inside a formula splitting it in two", () => {
  const expected = "$\\max\\{\\frac{m}{p_2}-1,0\\}$";
  const card = { id: "q", kind: "cloze", topic: "需求", prompt: "", cloze: { text: "在 $u=\\ln x_1+x_2$ 下，$x_2^*={{b1}}$。", blanks: [{ id: "b1" }] } };
  const html = render("cloze", true, { card, feedback: { correct: false, answers: { b1: "2" }, details: [{ id: "b1", correct: false, expected }] },
    solution: { answer: expected, cloze: { answers: [{ id: "b1", value: expected }] } } });
  assert.match(html, /<span class="md-math-source">\$u=\\ln x_1\+x_2\$<\/span>/);
  assert.match(html, /<span class="md-math-source">\\\(x_2\^\*=\\\)<\/span>/);
  assert.match(html, /cloze-expected"><span class="md-math"><span class="md-math-source">\$\\max/);
  assert.doesNotMatch(html, /\$x_2\^\*=/, "the formula the blank was in is not shown as raw text");
  assert.match(html, /你的答案：2/);
});

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
  assert.match(html, /<summary><span class="sh-badge sh-badge--sm en-mark" data-tone="accent">Q&amp;A<\/span><h4>第一个问题？<\/h4><span class="followup-state" aria-hidden="true">展开<\/span><\/summary>/, "the question is the fold's title, with its state in words (#160)");
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
  // The pill is the page's quiet Button with the arrow icon, in a Tooltip (not a title=) that says what the way back is.
  assert.match(html, /<span class="[^"]*\breview-detour\b[^"]*"[^>]*><button[^>]*><svg[^>]*>.*?<\/svg>回到之前的第 5 题<\/button>/s);
  assert.match(html, /role="tooltip"[^>]*>回到从信箱跳过来之前正在做的题</);
  assert.doesNotMatch(html, /title="回到从信箱跳过来之前正在做的题"/);
});

test("during a round started in the book or on the 总纲 the header's return button names that page and it is not said again under the card; other trails keep 返回学习库 and their pill with the arrow icon", () => {
  const run = { id: "from-book", index: 0, total: 1, card: { id: "q", kind: "flashcard", topic: "T", prompt: "Q?" }, revealed: false, feedback: null };
  const page = (extra) => renderToStaticMarkup(reviewEl({ run, data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, shellTitle: "今日学习", busy: false,
    onReturnContext: () => {}, ...extra }));
  const book = page({ contextKind: "book", contextPlace: "1.2.2 Title", contextReturnLabel: "回到复习全书" });
  assert.match(book, /<button[^>]*review-return[^>]*aria-label="回到复习全书"[^>]*>\s*<span class="review-return-full">回到复习全书<\/span>/);
  assert.doesNotMatch(book, /返回学习库/);
  assert.doesNotMatch(book, /review-detour/, "one way back during the run: the header's, no pill under the card");
  assert.doesNotMatch(book, /←/);
  const outline = page({ contextKind: "outline", contextReturnLabel: "回到总纲" });
  assert.match(outline, /review-return[^>]*aria-label="回到总纲"/);
  assert.doesNotMatch(outline, /review-detour/);
  const other = page({ contextKind: "library", contextReturnLabel: "返回学习库首页" });
  assert.match(other, /review-return[^>]*aria-label="返回学习库"/);
  assert.match(other, /<button[^>]*class="sh-btn [^"]*review-detour"[^>]*><svg[^>]*>.*?<\/svg>返回学习库首页<\/button>/s, "the pill is the page's Button, with the Phosphor arrow");
  assert.match(page({}), /review-return[^>]*aria-label="返回学习库"/);
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
  const html = render("quiz", true);
  const area = /<div class="question-area[^"]*"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(area, /--reading-measure:\s*\d+px/, "the reading measure reaches the column");
  assert.match(area, /--review-column:\s*calc\(var\(--reading-measure\)\s*-\s*4px\)/);
  assert.match(area, /--card-scale:\s*1(;|$)/, "16px is the designed size: scale 1");
  const css = globalCss();
  assert.match(css, /\.question-area\s*\{[^}]*width:\s*min\(var\(--review-column,\s*700px\),\s*calc\(100% - 48px\)\)/, "the column is no longer a fixed 700px");
  for (const [name, pattern] of [
    ["the stem", /\.question \{[^}]*font-size:\s*calc\(var\(--fs-2xl\) \* var\(--card-scale, 1\)\)/],
    ["the options", /\.option \{[^}]*font-size:\s*calc\(var\(--fs-lg\) \* var\(--card-scale, 1\)\)/],
    ["the flashcard face", /\.flash-prompt \{[^}]*font-size:\s*calc\(var\(--fs-3xl\) \* var\(--card-scale, 1\)\)/],
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

test("multi-choice shows selection count and 清空 link; multi-blank cloze counts filled blanks; open shows char hint (#1, #31, #32, #33)", () => {
  const multiCard = { id: "m1", kind: "multi", multiple: true, topic: "T", prompt: "Pick two", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] };
  const multiSelected = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 1, card: multiCard, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: ["a"], clozeValues: {}, shellTitle: "Review", busy: false,
  }));
  assert.match(multiSelected, /已选 1 项 · 按 Enter 提交/);
  assert.match(multiSelected, /submit-clear[^>]*>清空<\/button>/);
  const multiEmpty = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 1, card: multiCard, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
  }));
  assert.doesNotMatch(multiEmpty, /已选|submit-clear/);

  const twoBlankCloze = { id: "c2", kind: "cloze", topic: "T", prompt: "", cloze: { text: "{{b1}} and {{b2}}", blanks: [{ id: "b1" }, { id: "b2" }] } };
  const clozeHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 1, card: twoBlankCloze, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: false, isCloze: true, selected: [], clozeValues: { b1: "one", b2: "" }, shellTitle: "Review", busy: false,
  }));
  assert.match(clozeHtml, /已填 1\/2 空/);
  assert.match(clozeHtml, /Shift\+Enter 回上一空/);

  const openHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 1, card: { id: "o1", kind: "open", topic: "T", prompt: "Explain?", options: [] }, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, response: "hello", shellTitle: "Review", busy: false,
  }));
  assert.match(openHtml, /5 字 · Ctrl\+Enter 看答案/);
});

test("flashcard grading shows side cue and keeps 0-5 buttons; long explanations add collapse/next footer (#35, #39)", () => {
  const flashFront = render("flashcard", true, { feedback: null });
  assert.match(flashFront, /grading-side-cue[^>]*>正在看正面题干 · 按 Space 回背面</);
  assert.match(flashFront, /data-usage="review\.grade"/);

  const flashBack = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card: { id: "q", kind: "flashcard", topic: "Context", prompt: "Q?" }, revealed: true, feedback: null, solution: { answer: "A", explanation: "E" } },
    data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, showBack: true, shellTitle: "Review", busy: false,
  }));
  assert.match(flashBack, /grading-side-cue[^>]*>按 Space 可翻回正面核对题干</);
  assert.match(flashBack, /data-usage="review\.grade"/);

  const longExplanation = "X".repeat(290);
  const longHtml = render("quiz", true, {
    complete: false,
    feedback: { correct: true, details: [] },
    solution: { answer: "Payment System", explanation: longExplanation },
  });
  assert.match(longHtml, /class="explanation-foot"/);
  assert.match(longHtml, /收起解析 \(H\)/);
  assert.equal((longHtml.match(/下一题/g) || []).length, 1, "single sticky primary 下一题 action even on long explanations");

  const shortHtml = render("quiz", true, {
    complete: false,
    feedback: { correct: true, details: [] },
    solution: { answer: "Payment System", explanation: "Short." },
  });
  assert.doesNotMatch(shortHtml, /explanation-foot/);
});

test("RetellPanel offers voice input and ExplanationFollowup shows saved note tooltip (#4, #25)", async () => {
  const { loadUi } = await import("./helpers/ui-module.mjs");
  const uiMods = await loadUi(`
    export { default as RetellPanel } from './ui/review/RetellPanel.jsx';
    export { default as ExplanationFollowup } from './ui/ExplanationFollowup.jsx';
  `);

  const retellHtml = renderToStaticMarkup(React.createElement(uiMods.RetellPanel, {
    op: "teach.retell", args: { cardId: "q" }, draftKey: "r:q", model: { ready: true }, onDone() {}, onClose() {},
  }));
  assert.match(retellHtml, /让 AI 看看/);
  assert.match(retellHtml, /语音作答/);

  const fuHtml = renderToStaticMarkup(React.createElement(uiMods.ExplanationFollowup, {
    run: { id: "r", card: { id: "q" }, solution: { followups: [{ id: "f1", question: "Q1?", answer: "A1" }] } },
    noteQa: { savedIn: () => "n1", onSave() {}, onOpen() {} },
    cardNotes: [{ noteId: "n1", title: "交易系统笔记", followupIds: ["f1", "f2"] }],
  }));
  assert.match(fuHtml, /已存进笔记 · 打开/);
  assert.match(fuHtml, /已存进「交易系统笔记」（含 2 条问答）/);
});

test("formatAssistTaskSummary summarizes chips without raw prompts (#U3) and QuestionRun renders collapsible EnBlock (#48)", async () => {
  const { PLAIN_HELP_REQUEST } = await import("../lib/assist-contract.js");
  assert.equal(
    formatAssistTaskSummary({ choices: ["plain", "angle"], question: "为什么重试会放大负载" }),
    "通俗详解 · 换个角度讲 · 为什么重试会放大负载",
  );
  const rawOnly = formatAssistTaskSummary({
    text: `${PLAIN_HELP_REQUEST}；换一种解释角度，指出关键概念之间的关系；重试延迟机制`,
  });
  assert.equal(rawOnly, "通俗详解 · 换个角度讲 · 重试延迟机制");
  assert.doesNotMatch(rawOnly, /贴近生活的比喻/);

  const card = {
    id: "q-en", kind: "quiz", topic: "T", prompt: "题目",
    translation: { prompt: "English stem" },
    options: [{ id: "a", text: "是" }],
  };
  const enHtml = renderToStaticMarkup(reviewEl({
    run: {
      id: "r-en", index: 0, total: 1, card, revealed: true,
      feedback: { correct: true, details: [] },
      solution: { answer: "是", explanation: "解析", translation: { explanation: "English explanation" } },
    },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, showEn: true,
    selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
  }));
  assert.equal((enHtml.match(/class="en-block__toggle"/g) || []).length, 2);
  assert.match(enHtml, /English stem/);
  assert.match(enHtml, /English explanation/);
});
