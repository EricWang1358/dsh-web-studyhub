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
function render(kind, revealed, runPatch = {}) {
  const card = { id: "q", kind, topic: "Context", prompt: "Who processes payments?",
    options: [{ id: "a", text: "Payment System" }],
    cloze: { text: "付款由 {{actor}} 处理。", blanks: [{ id: "actor" }] } };
  return renderToStaticMarkup(React.createElement(Review, {
    run: { id: "r", index: 0, total: 2, card, revealed,
      feedback: revealed ? { correct: false, details: [{ id: "actor", correct: false, expected: "Payment System" }] } : null,
      solution: revealed ? { answer: "Payment System", cloze: { answers: [{ id: "actor", value: "Payment System" }] } } : null, ...runPatch },
    data: { sources: [] }, host: {}, choice: ["quiz", "multi"].includes(kind), isCloze: kind === "cloze",
    selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
  }));
}
for (const kind of ["quiz", "multi", "cloze", "flashcard", "open"]) {
  test(`${kind} uses the shared plain hint/explanation controls`, () => {
    for (const revealed of [false, true]) {
      const html = render(kind, revealed);
      assert.equal((html.match(/class="question-toolbar"/g) || []).length, 1);
      assert.match(html, new RegExp(`>${revealed ? "讲解" : "提示"}</button>`));
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
