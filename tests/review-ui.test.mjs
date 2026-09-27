import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({ entryPoints: ["ui/Review.jsx"], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Review = module.exports.default;
function render(kind, revealed, runPatch = {}, dataPatch = {}) {
  const card = { id: "q", kind, topic: "Context", prompt: "Who processes payments?",
    options: [{ id: "a", text: "Payment System" }],
    cloze: { text: "付款由 {{actor}} 处理。", blanks: [{ id: "actor" }] } };
  return renderToStaticMarkup(React.createElement(Review, {
    run: { id: "r", index: 0, total: 2, card, revealed,
      feedback: revealed ? { correct: false, details: [{ id: "actor", correct: false, expected: "Payment System" }] } : null,
      solution: revealed ? { answer: "Payment System", explanation: "Payment System handles payments.",
        cloze: { answers: [{ id: "actor", value: "Payment System" }] } } : null, ...runPatch },
    data: { sources: [], ...dataPatch }, host: {}, choice: ["quiz", "multi"].includes(kind), isCloze: kind === "cloze",
    selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
  }));
}
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
