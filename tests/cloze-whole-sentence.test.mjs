import test from "node:test";
import assert from "node:assert/strict";
import { clozeIssues, cardLocalIssues, CLOZE_RULE, CLOZE_SENTENCE, QUALITY_CRITERIA, blueprintPrompts } from "../lib/assessment-quality.js";
import { writeVariants } from "../lib/coach.js";
import { qualityPlan } from "./helpers/assessment.mjs";

/* A cloze cut out of a longer sentence (owner, 2026-11-05, about another tool's questions): of 「虽然…，但是…」 only the 「但是…」 half was kept, so the
   card states one case as if it were the rule, and can say the opposite of the source. A cloze quotes one whole sentence with the clauses that limit it;
   the writer is told so, the reviewer fails a card that drops them, and the program sends back the cuts it can see without a model. */

const source = { id: "s", title: "Notes", text: "虽然列表可以修改，但是元组一旦创建就不能修改。" };
const clozeCard = (text, value) => ({ id: "q", kind: "cloze", topic: "元组", objective: "区分列表与元组", prompt: text, answer: value,
  hint: "想想创建之后还能不能改。", explanation: "元组创建后不能修改，列表可以。", misconception: "元组和列表一样可以修改。",
  citations: [{ sourceId: "s", quote: source.text.slice(0, 16) }], cloze: { text, answers: [{ id: "b1", value }] } });
const issuesOf = (text) => clozeIssues({ title: "T", cards: [clozeCard(text, "元组")] });

test("a cloze that starts in the middle of a sentence, or keeps only its first half, goes back with the rule", () => {
  for (const text of ["但是{{b1}}一旦创建就不能修改。", "但{{b1}}一旦创建就不能修改。", "而是由 {{b1}} 决定。", "所以{{b1}}不能修改。", "因此 {{b1}} 更省内存。",
    "然而{{b1}}不能修改。", "However, a {{b1}} cannot be changed.", "but a {{b1}} cannot be changed.", "Therefore the {{b1}} is immutable.",
    "虽然列表可以修改，{{b1}}", "虽然{{b1}}可以修改。", "不仅{{b1}}可以修改。"]) {
    const issues = issuesOf(text);
    assert.equal(issues.length, 1, text);
    assert.match(issues[0], /whole sentence/, text);
    assert.ok(issues[0].includes(CLOZE_SENTENCE), text);
  }
});

test("a whole sentence passes, including ones that begin with words that only look like a connective", () => {
  for (const text of ["虽然列表可以修改，但是{{b1}}一旦创建就不能修改。", "{{b1}}一旦创建就不能修改。", "但凡创建了 {{b1}}，就不能再修改它。", "只有 {{b1}} 才能做字典的键。",
    "如果对象不可变，就可以用 {{b1}} 存放它。", "不仅列表，{{b1}}也可以切片。", "尽管元组不可变，{{b1}}里的列表仍然可以修改。", "Although lists can change, a {{b1}} cannot.",
    "Butter is a {{b1}} product.", "Thus-far untested code is a {{b1}}.", "So-called {{b1}} objects cannot change."]) {
    assert.deepEqual(issuesOf(text), [], text);
  }
});

test("the candidate gate holds a cut cloze too", () => {
  const deck = { title: "T", cards: [clozeCard("但是{{b1}}一旦创建就不能修改。", "元组")] };
  assert.ok(cardLocalIssues(deck, { sources: [source] }).some((issue) => /whole sentence/.test(issue)));
});

test("the writer and the reviewer are told to keep the clauses that limit a cloze sentence", () => {
  assert.ok(CLOZE_RULE.includes(CLOZE_SENTENCE), "the answer stage's cloze rule carries it");
  const req = { count: 1, kind: "cloze", sources: [source] };
  assert.ok(blueprintPrompts(req, qualityPlan(req)).prompt.includes(CLOZE_SENTENCE));
  assert.match(QUALITY_CRITERIA, /cloze sentence cut from a longer one/i);
});

test("a 为你定制 cloze that is cut is dropped like any other invalid card", async () => {
  const card = { card: { id: "c1", topic: "元组", objective: "x", prompt: "元组能改吗？", answer: "不能" }, kind: "cloze", reason: "wrong" };
  const reply = (text) => JSON.stringify({ cards: [{ target: 0, kind: "cloze", topic: "元组", objective: "区分列表与元组", prompt: text, answer: "元组",
    hint: "想想创建之后还能不能改。", explanation: "元组创建后不能修改，列表可以。", misconception: "元组和列表一样可以修改。",
    citations: [{ sourceId: "s", quote: source.text.slice(0, 16) }], cloze: { text, answers: [{ id: "b1", value: "元组" }] } }] });
  const cut = await writeVariants(async () => reply("但是{{b1}}一旦创建就不能修改。"), { targets: [card], sources: [source], learner: {} });
  const whole = await writeVariants(async () => reply("虽然列表可以修改，但是{{b1}}一旦创建就不能修改。"), { targets: [card], sources: [source], learner: {} });
  assert.equal(cut.length, 0);
  assert.equal(whole.length, 1);
});
