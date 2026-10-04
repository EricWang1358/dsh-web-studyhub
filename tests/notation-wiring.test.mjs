import test from "node:test";
import assert from "node:assert/strict";
import { wrapBareMath, wrapChoiceOptions } from "../lib/card-autofix.js";
import { authorPrompts } from "../lib/generation.js";
import { blueprintPrompts, formulaIssues } from "../lib/assessment-quality.js";
import { patchPrompts } from "../lib/generation-yield.js";

/* The 公式写法 a run resolved to decides the direction of every formula fix and every prompt rule: text → plain Unicode, latex → $…$. */

test("text notation turns TeX and chemistry into Unicode instead of wrapping them", () => {
  assert.equal(wrapBareMath("$x^{2}+1$", "text"), "x²+1");
  assert.equal(wrapBareMath("硫酸为 H2SO4，由 2 个 H+ 组成", "text").includes("H₂SO₄"), true);
  assert.equal(wrapBareMath("$5\\sqrt{2}$", "text"), "5√2");
  assert.equal(wrapBareMath("由1个H+与1个HSO4-组成，OH-与NH4+", "text"), "由1个H⁺与1个HSO₄⁻组成，OH⁻与NH₄⁺");
  assert.equal(wrapBareMath("C++ 和 A/B 测试", "text"), "C++ 和 A/B 测试");
  // an ambiguous ion is not guessed at; the gate sends it back to the model
  assert.equal(wrapBareMath("1个SO42−", "text"), "1个SO42−");
  // latex keeps the opposite direction
  assert.equal(wrapBareMath("5√2", "latex"), "$5\\sqrt{2}$");
});

test("text notation converts a whole option set and keeps the choices distinct", () => {
  const options = [{ id: "a", text: "$1$", correct: false, explanation: "约成 $1$" }, { id: "b", text: "$x+1$", correct: true, explanation: "约去 $(x-1)$" },
    { id: "c", text: "$x^{2}+1$", correct: false, explanation: "没有分解" }];
  const out = wrapChoiceOptions(options, "text");
  assert.deepEqual(out.map(option => option.text), ["1", "x+1", "x²+1"]);
  assert.equal(new Set(out.map(option => option.text)).size, 3);
});

test("text notation: the gate does not flag Unicode math, only TeX that would show raw", () => {
  const card = (text) => ({ cards: [{ prompt: text, answer: "x", hint: "h", explanation: "e", misconception: "m" }] });
  assert.deepEqual(formulaIssues(card("求 x²+1 与 H₂SO₄"), { notation: "text" }), []);
  assert.equal(formulaIssues(card("求 a^{l-1}"), { notation: "text" }).length, 1);
});

test("every prompt follows the resolved notation", () => {
  const plan = { targets: [{ targetId: "t1", objective: "o", knowledge: "k", citations: [] }] };
  const blueprint = { items: [{ targetId: "t1", answer: "a", reasoning: "r", comparisonAxis: "c", scenario: { kind: "none", facts: [], decisiveConditions: [] } }] };
  const request = (notation) => ({ count: 1, kind: "quiz", sources: [], notation });
  const text = authorPrompts(request("text"), plan, blueprint).prompt, latex = authorPrompts(request("latex"), plan, blueprint).prompt;
  assert.match(text, /plain Unicode/);
  assert.doesNotMatch(text, /Put every formula inside \$/);
  assert.match(latex, /Put every formula inside \$/);
  assert.match(blueprintPrompts(request("text"), plan).prompt, /plain Unicode/);
  assert.doesNotMatch(blueprintPrompts(request("text"), plan).prompt, /Put every formula inside \$/);
  const entries = [{ card: { id: "q1", kind: "quiz", prompt: "p" }, issues: ["q1: explanationQuality failed"] }];
  assert.match(patchPrompts({ entries, sources: [], notation: "text" }).prompt, /plain Unicode/);
  assert.match(patchPrompts({ entries, sources: [] }).prompt, /Wrap every formula in \$/);
});
