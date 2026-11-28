import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalCss } from "./helpers/global-css.mjs";
import { reviewElement } from "./helpers/review-render.mjs";

const compiled = await build({ stdin: { contents: "export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { formatAssistTaskSummary } from './ui/review/QuestionRun.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() }, bundle: true,
  write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Review = module.exports.default;
const { formatAssistTaskSummary, setUiLanguage } = module.exports;
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
  assert.match(html, /<summary><span class="sh-badge sh-badge--sm en-mark" data-tone="accent">Q&amp;A<\/span><span class="followup-item__title">第一个问题？<\/span><span class="followup-state" aria-hidden="true">展开<\/span><\/summary>/, "the question is the fold's title, with its state in words (#160)");
  assert.match(html, /<span class="followup-item__title">第三个问题？<\/span><span class="followup-state" aria-hidden="true">收起<\/span>/, "the open one offers to fold");
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
  assert.match(book, /<button[^>]*review-return[^>]*aria-label="回到复习全书"[^>]*>\s*<svg[^>]*>.*?<\/svg><span class="review-return-full">回到复习全书<\/span>/, 'a way back leads with arrow-left (#1073 round 6)');
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

test("flashcard grading keeps 0-5 buttons on either side without a Space cue (#1697); long explanations add collapse/next footer (#35, #39)", () => {
  const flashFront = render("flashcard", true, { feedback: null });
  assert.doesNotMatch(flashFront, /grading-side-cue|按 Space/);
  assert.match(flashFront, /data-usage="review\.grade"/);

  const flashBack = renderToStaticMarkup(reviewEl({
    run: { id: "r", index: 0, total: 2, card: { id: "q", kind: "flashcard", topic: "Context", prompt: "Q?" }, revealed: true, feedback: null, solution: { answer: "A", explanation: "E" } },
    data: { sources: [] }, host: {}, choice: false, isCloze: false, selected: [], clozeValues: {}, showBack: true, shellTitle: "Review", busy: false,
  }));
  assert.doesNotMatch(flashBack, /grading-side-cue|按 Space/);
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

test("summary-course shows finished chapter wording (weak=0, weak>0, multi-chapter), falls back cleanly when empty, and hides bar above 30 chapters (#1195)", () => {
  const noop = () => {};
  const textOf = (html) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const renderCourseSummary = (course) => {
    const html = renderToStaticMarkup(reviewEl({
      run: {
        id: "r-course", mode: "path", complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 4,
        weakTopics: [], scope: [], card: { id: "q", kind: "quiz", topic: "T", prompt: "Q?", options: [] },
        course,
      },
      data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {},
      shellTitle: "课程 · Cloud Native", busy: false, act: noop, enterRun: noop, setPage: noop, askInChat: noop,
    }));
    const start = html.indexOf('class="summary-course"');
    assert.ok(start > -1, "renders .summary-course");
    const end = html.indexOf('<div class="summary-actions">', start);
    return html.slice(start, end);
  };

  setUiLanguage("zh");
  try {
    // 1. No finished chapters: exact legacy wording + 3-state bar
    const plain = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 6, chapters: 3, doneChapters: 0,
      chapter: { index: 0, title: "01 概览", learned: 6, total: 12 },
      finished: [],
      segments: ["started", "upcoming", "upcoming"],
      next: { label: "01 概览 · 第 7–12 题" },
    });
    assert.match(textOf(plain), /课程进度 · 已学 6 \/ 20 题 · 第 1 \/ 3 章「01 概览」6\/12 · 下一批：01 概览 · 第 7–12 题/);
    assert.match(plain, /class="summary-course__bar" aria-hidden="true"/);
    assert.equal((plain.match(/class="summary-course__seg /g) || []).length, 3);
    assert.doesNotMatch(plain, /<button\b/, "no extra buttons inside .summary-course");

    // 2. Single finished chapter with weak === 0
    const oneClean = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 12, chapters: 4, doneChapters: 1,
      chapter: { index: 1, title: "02 迁移", learned: 0, total: 8 },
      finished: [{ index: 0, title: "01 概览", total: 12, weak: 0 }],
      segments: ["done", "upcoming", "upcoming", "upcoming"],
      next: { label: "02 迁移 · 第 1–8 题" },
    });
    assert.match(textOf(oneClean), /「01 概览」做完一遍，都答对过 · 全课 4 章，已过 1 章 · 下一批：02 迁移 · 第 1–8 题/);
    assert.match(oneClean, /<strong>01 概览<\/strong>/);

    // 3. Single finished chapter with weak > 0
    const oneWeak = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 12, chapters: 4, doneChapters: 1,
      chapter: { index: 1, title: "02 迁移", learned: 0, total: 8 },
      finished: [{ index: 0, title: "01 概览", total: 12, weak: 2 }],
      segments: ["done", "upcoming", "upcoming", "upcoming"],
      next: { label: "02 迁移 · 第 1–8 题" },
    });
    assert.match(textOf(oneWeak), /「01 概览」做完一遍，2 题还不稳 · 全课 4 章，已过 1 章 · 下一批：02 迁移 · 第 1–8 题/);

    // 4. Multiple finished chapters (weak === 0 and weak > 0)
    const multiClean = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 20, chapters: 3, doneChapters: 2,
      chapter: { index: 2, title: "03 网格", learned: 0, total: 4 },
      finished: [
        { index: 0, title: "01 概览", total: 8, weak: 0 },
        { index: 1, title: "02 迁移", total: 8, weak: 0 },
      ],
      segments: ["done", "done", "upcoming"],
      next: null,
    });
    assert.match(textOf(multiClean), /「01 概览」等 2 章做完一遍，都答对过 · 全课 3 章，已过 2 章/);

    const multiWeak = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 20, chapters: 3, doneChapters: 2,
      chapter: { index: 2, title: "03 网格", learned: 0, total: 4 },
      finished: [
        { index: 0, title: "01 概览", total: 8, weak: 0 },
        { index: 1, title: "02 迁移", total: 8, weak: 3 },
      ],
      segments: ["done", "done", "upcoming"],
      next: null,
    });
    assert.match(textOf(multiWeak), /「01 概览」等 2 章做完一遍，3 题还不稳 · 全课 3 章，已过 2 章/);

    // 5. Chapter count boundary: 30 renders bar, 31 does not
    const bar30 = renderCourseSummary({
      name: "Big Course", cards: 30, learned: 10, chapters: 30, doneChapters: 1,
      chapter: { index: 1, title: "Ch 2", learned: 0, total: 1 },
      finished: [],
      segments: ["done", ...Array(29).fill("upcoming")],
      next: null,
    });
    assert.equal((bar30.match(/class="summary-course__seg /g) || []).length, 30);

    const bar31 = renderCourseSummary({
      name: "Huge Course", cards: 31, learned: 10, chapters: 31, doneChapters: 1,
      chapter: { index: 1, title: "Ch 2", learned: 0, total: 1 },
      finished: [],
      segments: ["done", ...Array(30).fill("upcoming")],
      next: null,
    });
    assert.doesNotMatch(bar31, /summary-course__bar/, "chapters > 30 suppresses the segment bar");

    // 6. English wording & #one singular forms
    setUiLanguage("en");
    const enSingleOneWeakOneChapter = renderCourseSummary({
      name: "Cloud Native", cards: 10, learned: 10, chapters: 1, doneChapters: 1,
      chapter: null,
      finished: [{ index: 0, title: "01 Overview", total: 10, weak: 1 }],
      segments: ["done"],
      next: null,
    });
    assert.match(textOf(enSingleOneWeakOneChapter), /“01 Overview” finished once, 1 question still shaky · 1 of 1 chapter done/);
    assert.doesNotMatch(textOf(enSingleOneWeakOneChapter), /[\u3400-\u9fff]/);

    const enSinglePlural = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 10, chapters: 4, doneChapters: 1,
      chapter: null,
      finished: [{ index: 0, title: "01 Overview", total: 10, weak: 2 }],
      segments: ["done", "upcoming", "upcoming", "upcoming"],
      next: null,
    });
    assert.match(textOf(enSinglePlural), /“01 Overview” finished once, 2 questions still shaky · 1 of 4 chapters done/);
    assert.doesNotMatch(textOf(enSinglePlural), /[\u3400-\u9fff]/);

    const enMultiOneWeak = renderCourseSummary({
      name: "Cloud Native", cards: 20, learned: 20, chapters: 3, doneChapters: 2,
      chapter: null,
      finished: [
        { index: 0, title: "01 Overview", total: 10, weak: 1 },
        { index: 1, title: "02 Migration", total: 10, weak: 0 },
      ],
      segments: ["done", "done", "upcoming"],
      next: null,
    });
    assert.match(textOf(enMultiOneWeak), /2 chapters including “01 Overview” finished once, 1 question still shaky · 2 of 3 chapters done/);
    assert.doesNotMatch(textOf(enMultiOneWeak), /[\u3400-\u9fff]/);
  } finally {
    setUiLanguage("zh");
  }
});

test("QuestionPlace shows source document/chapter in normal mode, hides in exam/complete/null, and stays plain text when outline is unavailable (#1197)", async () => {
  const { loadUi } = await import("./helpers/ui-module.mjs");
  const { keepOutline, keptOutlineTarget, clearOutlineTarget, outlineTargetExpandKeys } = await loadUi(`
    export { keepOutline, keptOutlineTarget, clearOutlineTarget, outlineTargetExpandKeys } from './ui/outline/model.js';
  `);

  const cardPlace = {
    course: "Arch",
    document: { key: "pdf:doc-1", title: "Architecture Guide.pdf" },
    chapter: { key: "pdf:doc-1#1", title: "Core Layers" },
    leaf: null,
  };
  const docSource = { id: "s1", title: "Architecture Guide · p. 1", courses: ["Arch"] };

  const clickableHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r-place", index: 0, total: 2, card: { id: "q-p", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] }, cardPlace },
    data: { sources: [docSource] }, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Arch", busy: false,
    onOpenOutline: () => {}, openSkeleton: () => {},
  }));
  assert.match(clickableHtml, /data-review-place=""/);
  assert.match(clickableHtml, /<button[^>]*data-review-place=""[^>]*data-usage="review\.place"[^>]*data-tour="review-place"[^>]*>/);
  assert.match(clickableHtml, /出处 ·/);
  assert.match(clickableHtml, /Architecture Guide › Core Layers/);
  assert.doesNotMatch(clickableHtml, /<[^>]*data-review-place=""[^>]*\btitle=/);

  const docOnlyHtml = renderToStaticMarkup(reviewEl({
    run: {
      id: "r-doc", index: 0, total: 2,
      card: { id: "q-d", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] },
      cardPlace: { course: "Arch", document: { key: "doc:plain", title: "Plain Notes" }, chapter: null, leaf: null },
    },
    data: { sources: [docSource] }, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Arch", busy: false,
    onOpenOutline: () => {},
  }));
  assert.match(docOnlyHtml, /出处 ·/);
  assert.match(docOnlyHtml, /Plain Notes/);
  assert.doesNotMatch(docOnlyHtml, /Plain Notes ›/);

  const staticHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r-static", index: 0, total: 2, card: { id: "q-s", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] }, cardPlace },
    data: { sources: [] }, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Arch", busy: false,
    onOpenOutline: () => {},
  }));
  assert.match(staticHtml, /<span[^>]*review-place-static[^>]*data-review-place=""[^>]*>/);
  assert.doesNotMatch(staticHtml, /<button[^>]*data-review-place=""/);
  assert.doesNotMatch(staticHtml, /data-usage="review\.place"/);

  const unplacedHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r-null", index: 0, total: 2, card: { id: "q-n", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] },
      cardPlace: { course: "Arch", document: null, chapter: null, leaf: null } },
    data: { sources: [docSource] }, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Arch", busy: false,
    onOpenOutline: () => {},
  }));
  assert.doesNotMatch(unplacedHtml, /data-review-place/);

  const examHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r-exam", mode: "exam", index: 0, total: 2, card: { id: "q-e", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] }, cardPlace },
    data: { sources: [docSource] }, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Exam", busy: false,
    onOpenOutline: () => {},
  }));
  assert.doesNotMatch(examHtml, /data-review-place/);

  const completeHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r-done", complete: true, index: 1, total: 1, questions: 1, answered: 1, correct: 1, card: { id: "q-c", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] }, cardPlace },
    data: { sources: [docSource] }, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Arch", busy: false,
    onOpenOutline: () => {},
  }));
  assert.doesNotMatch(completeHtml, /data-review-place/);

  // Coexists with 知识骨架 button when both are present.
  const bothHtml = renderToStaticMarkup(reviewEl({
    run: { id: "r-both", index: 0, total: 2, card: { id: "q-b", kind: "quiz", topic: "Arch", prompt: "Prompt?", options: [{ id: "a", text: "A" }] }, cardPlace },
    data: { sources: [docSource], skeletons: [{ id: "sk-1", title: "Arch Skeleton", cardIds: ["q-b"] }] },
    host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "Arch", busy: false,
    onOpenOutline: () => {}, openSkeleton: () => {},
  }));
  assert.match(bothHtml, /data-review-place=""/);
  assert.match(bothHtml, /知识骨架/);

  // One-shot outline target helpers in ui/outline/model.js
  keepOutline("/lib", "Arch", { target: "pdf:doc-1#1", leafKey: "bk:leaf-1" });
  const got = keptOutlineTarget("/lib", "Arch");
  assert.deepEqual(got, { target: "pdf:doc-1#1", leafKey: "bk:leaf-1" });
  assert.deepEqual(outlineTargetExpandKeys(got, { nodes: [{ key: "bk:part-1", children: [{ key: "bk:leaf-1" }] }] }), ["bk:part-1", "bk:leaf-1", "pdf:doc-1", "pdf:doc-1#1"]);
  clearOutlineTarget("/lib", "Arch");
  assert.equal(keptOutlineTarget("/lib", "Arch"), null);
});

test("QuestionRun and ExplanationFollowup show 「读全书这一节」 only when leaf.built is true and not exam mode, and BookHeader renders 「回到这道题」 (#1196)", async () => {
  const { loadUi } = await import("./helpers/ui-module.mjs");
  const bookUi = await loadUi(`
    export { default as BookHeader } from './ui/book/BookHeader.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage, ui } from './ui/i18n.js';
  `);

  const builtPlace = {
    course: "Arch",
    document: { key: "pdf:doc-1", title: "Architecture Guide.pdf" },
    chapter: { key: "pdf:doc-1#1", title: "Core Layers" },
    leaf: { key: "bk:leaf-1", title: "What is Layered Architecture?", built: true },
  };
  const unbuiltPlace = {
    ...builtPlace,
    leaf: { key: "bk:leaf-2", title: "Who Uses It?", built: false },
  };
  const nullLeafPlace = {
    ...builtPlace,
    leaf: null,
  };
  const followups = [{ id: "fu-1", question: "为什么这样分层？", answer: "为了解耦每一层的职责。" }];
  const quizCard = { id: "q-b1", kind: "quiz", topic: "Arch", prompt: "Which layer?", options: [{ id: "a", text: "Domain" }, { id: "b", text: "UI" }] };
  const flashCard = { id: "q-f1", kind: "flashcard", topic: "Arch", prompt: "Explain domain layer", answer: "Core logic" };
  const baseData = { sources: [{ id: "s1", title: "Architecture Guide", courses: ["Arch"] }] };

  const renderQuestion = (runPatch, extra = {}) => renderToStaticMarkup(reviewEl({
    run: { id: "r-book-1", index: 0, total: 2, card: quizCard, ...runPatch },
    data: baseData,
    host: {},
    choice: !runPatch.card || runPatch.card.kind === "quiz",
    selected: [],
    clozeValues: {},
    shellTitle: "Arch",
    busy: false,
    onOpenBookSection: () => {},
    ...extra,
  }));

  setUiLanguage("zh");
  try {
    // 1. Built leaf + wrong quiz answer -> link below verdict + link under Q&A followup
    const wrongQuizHtml = renderQuestion({
      cardPlace: builtPlace,
      feedback: { correct: false, chosen: ["b"] },
      solution: { answer: "Domain", explanation: "Domain is core.", followups },
    });
    assert.match(wrongQuizHtml, /<button[^>]*data-usage="review\.book-section"[^>]*data-tour="review-book-section"[^>]*data-book-section-link="feedback">读全书这一节<svg class="sh-icon"/);
    assert.match(wrongQuizHtml, /<button[^>]*data-usage="review\.book-section"[^>]*data-tour="review-book-section"[^>]*data-book-section-link="followup">读全书这一节<svg class="sh-icon"/);

    // 2. Built leaf + wrong flashcard (grade < 3) -> link below verdict
    const wrongFlashHtml = renderQuestion({
      card: flashCard,
      cardPlace: builtPlace,
      revealed: true,
      feedback: { grade: 2 },
      solution: { answer: "Core logic", followups },
    });
    assert.match(wrongFlashHtml, /data-book-section-link="feedback"/);
    assert.match(wrongFlashHtml, /data-book-section-link="followup"/);

    // 3. Built leaf + right quiz answer -> NO link under verdict, YES link under Q&A followup
    const rightQuizHtml = renderQuestion({
      cardPlace: builtPlace,
      feedback: { correct: true, chosen: ["a"] },
      solution: { answer: "Domain", explanation: "Domain is core.", followups },
    });
    assert.doesNotMatch(rightQuizHtml, /data-book-section-link="feedback"/);
    assert.match(rightQuizHtml, /data-book-section-link="followup"/);

    // 4. Built leaf + before answer (no feedback yet) -> NO feedback link
    const beforeHtml = renderQuestion({ cardPlace: builtPlace });
    assert.doesNotMatch(beforeHtml, /data-book-section-link=/);

    // 5. Unbuilt leaf (built: false) -> NEVER shows link (neither wrong feedback nor followup)
    const unbuiltHtml = renderQuestion({
      cardPlace: unbuiltPlace,
      feedback: { correct: false, chosen: ["b"] },
      solution: { answer: "Domain", explanation: "Domain is core.", followups },
    });
    assert.doesNotMatch(unbuiltHtml, /data-book-section-link=/);
    assert.doesNotMatch(unbuiltHtml, /读全书这一节/);

    // 6. leaf: null -> NEVER shows link
    const nullLeafHtml = renderQuestion({
      cardPlace: nullLeafPlace,
      feedback: { correct: false, chosen: ["b"] },
      solution: { answer: "Domain", explanation: "Domain is core.", followups },
    });
    assert.doesNotMatch(nullLeafHtml, /data-book-section-link=/);

    // 7. Exam mode -> NEVER shows link even when leaf.built is true
    const examHtml = renderQuestion({
      mode: "exam",
      cardPlace: builtPlace,
      feedback: { correct: false, chosen: ["b"] },
      solution: { answer: "Domain", explanation: "Domain is core.", followups },
    });
    assert.doesNotMatch(examHtml, /data-book-section-link=/);
    assert.doesNotMatch(examHtml, /读全书这一节/);

    // 8. English wording
    setUiLanguage("en");
    const enWrongHtml = renderQuestion({
      cardPlace: builtPlace,
      feedback: { correct: false, chosen: ["b"] },
      solution: { answer: "Domain", explanation: "Domain is core." },
    });
    assert.match(enWrongHtml, /Read this section in the book/);

    // 9. BookHeader default vs returning to question
    const bookServices = { call: async () => ({}), act: async () => undefined, busy: false, notify: () => {}, openSettings: () => {}, navigate: () => {}, openModal: () => {} };
    const renderHeader = (props) => renderToStaticMarkup(
      React.createElement(bookUi.StudyServicesContext.Provider, { value: bookServices },
        React.createElement(bookUi.BookHeader, {
          data: { focus: { courses: [{ course: "Arch", name: "Architecture" }] } },
          course: "Arch",
          courseName: "Architecture",
          book: { status: "ok", notes: true },
          onBack: () => {},
          onCourse: () => {},
          ...props,
        })),
    );
    bookUi.setUiLanguage("zh");
    const defaultHeader = renderHeader({});
    assert.match(defaultHeader, /回到总纲/);
    const returnHeader = renderHeader({ backLabel: bookUi.ui("回到这道题") });
    assert.match(returnHeader, /sh-page-header__back"><svg class="sh-icon"[^>]*>.*?<\/svg>回到这道题/);
    assert.doesNotMatch(returnHeader, /回到总纲/);
    const trailHeader = renderHeader({ backLabel: "回到之前的第 1 题" });
    assert.match(trailHeader, /sh-page-header__back"><svg class="sh-icon"[^>]*>.*?<\/svg>回到之前的第 1 题/);
    assert.doesNotMatch(trailHeader, /回到总纲/);
    bookUi.setUiLanguage("en");
    const enReturnHeader = renderHeader({ backLabel: bookUi.ui("回到这道题") });
    assert.match(enReturnHeader, /Back to this question/);
  } finally {
    setUiLanguage("zh");
    bookUi.setUiLanguage("zh");
  }
});
