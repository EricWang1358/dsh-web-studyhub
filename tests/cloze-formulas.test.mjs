import test from "node:test";
import assert from "node:assert/strict";
import { clozeRuns, blanksInFormula, formulaValue, plainValue } from "../lib/cloze-text.js";
import { clozeIssues, cardLocalIssues, blueprintAssessment, blueprintPrompts, CLOZE_RULE } from "../lib/assessment-quality.js";
import { qualityPlan, qualityBlueprint } from "./helpers/assessment.mjs";

/* A cloze whose blank sat inside a formula ("$x_2^*={{b1}}$", answer "$\max\{\frac{m}{p_2}-1,0\}$", reported 2026-10-28): the review screen showed the whole stem
   as raw TeX, and no learner could type the answer the program compares. The screen now draws it; generation no longer writes it. */

const reported = "在 $u=\\ln x_1+x_2$ 与预算约束 $p_1x_1+p_2x_2=m$ 下，最优需求为 $x_1^*=\\min\\{\\frac{p_2}{p_1},\\frac{m}{p_1}\\}$，$x_2^*={{b1}}$。";

test("a blank inside a formula splits it: both halves still draw, and the formulas without a blank stay whole", () => {
  assert.deepEqual(clozeRuns(reported), [
    { t: "text", v: "在 $u=\\ln x_1+x_2$ 与预算约束 $p_1x_1+p_2x_2=m$ 下，最优需求为 $x_1^*=\\min\\{\\frac{p_2}{p_1},\\frac{m}{p_1}\\}$，\\(x_2^*=\\)" },
    { t: "blank", id: "b1" },
    { t: "text", v: "。" },
  ]);
  assert.deepEqual(clozeRuns("$a={{b1}}+1$ 与 {{b2}}"), [
    { t: "text", v: "\\(a=\\)" }, { t: "blank", id: "b1" }, { t: "text", v: "\\(+1\\) 与 " }, { t: "blank", id: "b2" }]);
  assert.deepEqual(clozeRuns("付款由 {{ actor }} 处理。"), [{ t: "text", v: "付款由 " }, { t: "blank", id: "actor" }, { t: "text", v: " 处理。" }]);
  assert.deepEqual(clozeRuns("价格 $5 与 {{b1}}"), [{ t: "text", v: "价格 $5 与 " }, { t: "blank", id: "b1" }], "a price sign is not a formula");
});

test("blanks inside formulas, and blank values written as formulas, are found", () => {
  assert.deepEqual(blanksInFormula(reported), ["b1"]);
  assert.deepEqual(blanksInFormula("$$y={{b1}}$$ 与 \\(z={{b2}}\\) 和 {{b3}} 在 $x$ 旁"), ["b1", "b2"]);
  assert.deepEqual(blanksInFormula("效用函数 $u=\\ln x_1+x_2$ 是 {{b1}} 效用"), []);
  for (const value of ["$\\max\\{\\frac{m}{p_2}-1,0\\}$", "\\frac{m}{p_2}", "\\(x\\)"]) assert.equal(formulaValue(value), true, value);
  for (const value of ["拟线性", "12 m", "x_1", "50%"]) assert.equal(formulaValue(value), false, value);
  assert.equal(plainValue("$12$"), "12");
  assert.equal(plainValue(" $x$ "), "x");
  assert.equal(plainValue("$x^2$"), "$x^2$", "a real formula is left for the gate");
  assert.equal(plainValue("拟线性"), "拟线性");
});

const source = { id: "s", title: "Notes", text: "Quasilinear utility u = ln x1 + x2 gives a demand for good 1 that does not depend on income once income is large enough." };
const clozeCard = (text, value) => ({ id: "q", kind: "cloze", topic: "Quasilinear demand", objective: "Recognise quasilinear demand",
  prompt: text, answer: value, hint: "Look at how income enters the utility.", explanation: "Income only changes the demand for good 2.",
  misconception: "Income changes every demand.", citations: [{ sourceId: "s", quote: source.text.slice(0, 40) }], cloze: { text, answers: [{ id: "b1", value }] } });

test("the gate names a blank inside a formula and a formula answer, with the rule to follow", () => {
  const bad = { title: "T", cards: [clozeCard(reported, "$\\max\\{\\frac{m}{p_2}-1,0\\}$")] };
  const issues = clozeIssues(bad);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /\{\{b1\}\} is inside a formula/);
  assert.match(issues[1], /cloze answer b1 is written as a formula/);
  assert.ok(issues.every(issue => issue.includes(CLOZE_RULE)));
  assert.ok(cardLocalIssues(bad, { sources: [source] }).some(issue => /inside a formula/.test(issue)), "the candidate gate holds it too");
  const good = { title: "T", cards: [clozeCard("$u=\\ln x_1+x_2$ 是 {{b1}} 效用函数。", "拟线性")] };
  assert.deepEqual(clozeIssues(good), []);
  assert.deepEqual(clozeIssues({ cards: [{ ...good.cards[0], kind: "flashcard" }] }), [], "only cloze cards");
});

test("the answer stage is told the cloze rule, and only for cloze", () => {
  const req = { count: 1, kind: "cloze", sources: [source] };
  assert.ok(blueprintPrompts(req, qualityPlan(req)).prompt.includes(CLOZE_RULE));
  for (const kind of ["quiz", "multi", "open", "flashcard"]) {
    const other = { ...req, kind };
    assert.ok(!blueprintPrompts(other, qualityPlan(other)).prompt.includes(CLOZE_RULE), kind);
  }
});

test("an answer-stage cloze with a blank inside a formula gets one focused correction; a plain value in dollars is just cleaned", async () => {
  const req = { count: 1, kind: "cloze", sources: [source] }, plan = qualityPlan(req);
  const good = qualityBlueprint(req, plan, { cards: [clozeCard("$u=\\ln x_1+x_2$ 是 {{b1}} 效用函数。", "拟线性")] });
  const bad = qualityBlueprint(req, plan, { cards: [clozeCard("拟线性效用下，$x_2^*={{b1}}$。", "$\\max\\{\\frac{m}{p_2}-1,0\\}$")] });
  const replies = [bad, good], prompts = [];
  const result = await blueprintAssessment(async (_system, prompt) => { prompts.push(prompt); return replies.shift(); }, req, plan);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /inside a formula/);
  assert.match(prompts[1], /written as a formula/);
  assert.deepEqual(result.items[0].cloze, good.items[0].cloze);

  const dollars = qualityBlueprint(req, plan, { cards: [clozeCard("这类效用叫 {{b1}} 效用，需求与 {{b1}} 无关。".replace(/ \{\{b1\}\} 无关/, "收入无关"), "$12$")] });
  dollars.items[0].cloze.answers[0].accept = ["$x$"];
  let calls = 0;
  const cleaned = await blueprintAssessment(async () => { calls++; return dollars; }, req, plan);
  assert.equal(calls, 1, "no correction round for a value that only had dollars around it");
  assert.deepEqual(cleaned.items[0].cloze.answers[0], { id: "b1", value: "12", accept: ["x"] });
});
