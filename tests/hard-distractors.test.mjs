import test from "node:test";
import assert from "node:assert/strict";
import { cardLocalIssues, blueprintAssessment, blueprintPrompts, QUALITY_CRITERIA, REVIEW_SEVERITY_CRITERIA } from "../lib/assessment-quality.js";
import { reviewPrompts, authorPrompts, mentionsCard } from "../lib/generation.js";
import { patchCandidates, patchFields, rejectionCode } from "../lib/generation-yield.js";
import { classifyFailure } from "../lib/generation-failure.js";
import { writeVariants, writeRewrite } from "../lib/coach.js";
import { DISTRACTOR_RULE, DISTRACTOR_WRITING, DISTRACTOR_CUES, optionCueIssues } from "../lib/option-cues.js";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { qualityPlan, qualityBlueprint } from "./helpers/assessment.mjs";

/* Harder distractors (owner, 2026-11-05: 「选项还是有一点点太容易区分错误了」). The rule is written once (lib/option-cues.js DISTRACTOR_RULE): the answer stage writes
   the options by it, 为你定制 variants too, the reviewer fails a card that a learner could solve by a cue; and the cues the program can see are sent back through the
   same repair path as every other local issue. */

// ui/quality-reasons.js reads the interface catalogue (JSON), so it is bundled the way the client is before it is imported.
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL("../ui/quality-reasons.js", import.meta.url))], bundle: true, write: false, format: "esm",
  platform: "browser", logLevel: "silent" });
const { issueCode } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

const source = { id: "s", title: "Notes", text: "事务的隔离性要求并发执行的事务互不干扰，每个事务都像在独占数据库一样运行。" };
const citations = [{ sourceId: "s", quote: source.text.slice(0, 20) }];
const OK = ["并发事务互不干扰，像独占数据库一样", "事务一旦提交，修改就写入磁盘保存", "事务内部的语句要么全部成功要么全部撤销", "事务执行前后数据库满足完整性约束"];
const quiz = (texts = OK, prompt = "下列哪项描述了事务的隔离性？") => ({ id: "q1", kind: "quiz", topic: "事务", objective: "区分隔离性与其他特性", prompt,
  answer: texts[0], hint: "想想并发时事务能否看到彼此。", explanation: "隔离性要求并发事务互不干扰。", misconception: "把隔离性当成持久性。", citations,
  options: texts.map((text, at) => ({ id: "abcd"[at], text, correct: at === 0, explanation: at === 0 ? "符合隔离性定义。" : "这是另一个特性，不是隔离性。" })) });
const deck = (...cards) => ({ title: "T", cards });

test("the candidate gate sends back a choice card with a cue, and passes one without", () => {
  assert.deepEqual(cardLocalIssues(deck(quiz()), { sources: [source] }), []);
  const issues = cardLocalIssues(deck(quiz([OK[0], OK[1], OK[2], "以上都对"])), { sources: [source] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^Card 1: option cue \(catchall\)/);
});

test("the answer stage corrects an option cue with the issue named, and keeps nothing that still has one", async () => {
  const req = { count: 1, kind: "quiz", sources: [source] }, plan = qualityPlan(req);
  const bad = qualityBlueprint(req, plan, deck(quiz([OK[0], OK[1], OK[2], "以上都对"])));
  const good = qualityBlueprint(req, plan, deck(quiz()));
  const replies = [bad, good], prompts = [];
  const result = await blueprintAssessment(async (_system, prompt) => { prompts.push(prompt); return replies.shift(); }, req, plan);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /option cue \(catchall\): option d/);
  assert.deepEqual(result.items[0].options.map((option) => option.text), OK);
});

test("a card flagged only for an option cue is re-worded in the run, by its options", () => {
  const flagged = quiz([OK[0], OK[1], OK[2], "以上都对"]);
  const d = deck(flagged);
  const local = optionCueIssues(d);
  assert.equal(patchCandidates(d, { local, binding: [], review: [] }, mentionsCard).has("q1"), true);
  assert.deepEqual([...patchFields(local)], ["options"]);
});

test("the learner-facing reason and the failure class read an option cue as weak options", () => {
  const line = "Card 2: option cue (length): the correct option is clearly longer than every wrong one (30 against at most 12 characters); give";
  assert.equal(issueCode(line), "options");
  assert.equal(rejectionCode(line), "options");
  assert.equal(classifyFailure(`Quality gate failed: ${line}`).code, "quality");
});

test("a 为你定制 variant with a cue is dropped like any invalid card, and the model is told the rule", async () => {
  const target = { card: { id: "c1", topic: "事务", objective: "x", prompt: "事务的隔离性是什么？", answer: "互不干扰" }, kind: "quiz", reason: "wrong" };
  const asked = [];
  const reply = (texts, prompt) => JSON.stringify({ cards: [{ target: 0, ...quiz(texts, prompt), id: undefined }] });
  const complete = (text) => async (system, prompt) => { asked.push(prompt); return text; };
  const cue = await writeVariants(complete(reply([OK[0], OK[1], OK[2], "以上都对"], "下列哪项是隔离性？")), { targets: [target], sources: [source], learner: {} });
  const fine = await writeVariants(complete(reply(OK, "下列哪项是隔离性的含义？")), { targets: [target], sources: [source], learner: {} });
  assert.equal(cue.length, 0);
  assert.equal(fine.length, 1);
  assert.ok(asked.every((prompt) => prompt.includes(DISTRACTOR_RULE.slice(0, 60))), "the variant writer carries the rule");
  const flash = [{ ...target, kind: "flashcard" }];
  await writeVariants(complete(JSON.stringify({ cards: [] })), { targets: flash, sources: [source], learner: {} });
  assert.ok(!asked.at(-1).includes(DISTRACTOR_RULE.slice(0, 60)), "a flashcard variant pays nothing for it");
});

test("a rewrite for 选项太烂 is told the rule as well", async () => {
  const asked = [];
  const complete = async (system, prompt) => { asked.push(prompt); return JSON.stringify({ patch: {}, summary: "x" }); };
  await writeRewrite(complete, { card: quiz(), tags: ["bad-options"], evidence: [], learner: {} });
  assert.ok(asked[0].includes(DISTRACTOR_RULE.slice(0, 60)));
  await writeRewrite(complete, { card: quiz(), tags: ["stem-vague"], evidence: [], learner: {} });
  assert.ok(!asked[1].includes(DISTRACTOR_RULE.slice(0, 60)));
});

test("one rule text reaches the answer stage (choice kinds only), the author's checklist and the reviewer", () => {
  assert.ok(DISTRACTOR_RULE.includes(DISTRACTOR_WRITING) && DISTRACTOR_RULE.includes(DISTRACTOR_CUES));
  for (const kind of ["quiz", "multi"]) {
    const req = { count: 1, kind, sources: [source] };
    const prompt = blueprintPrompts(req, qualityPlan(req)).prompt;
    assert.equal(prompt.split(DISTRACTOR_RULE).length - 1, 1, `${kind}: the answer stage writes the options by the rule, once`);
  }
  for (const kind of ["open", "cloze", "flashcard"]) {
    const req = { count: 1, kind, sources: [source] };
    assert.ok(!blueprintPrompts(req, qualityPlan(req)).prompt.includes(DISTRACTOR_WRITING), `${kind} pays nothing for it`);
  }
  assert.equal(QUALITY_CRITERIA.split(DISTRACTOR_CUES).length - 1, 1, "the checklist the author revisits and the reviewer reads names the cues once");
  assert.match(QUALITY_CRITERIA, /embodies no recognisable misconception/);
  assert.match(REVIEW_SEVERITY_CRITERIA, /ruled out by a cue/);
  const req = { count: 1, kind: "quiz", sources: [source] }, plan = qualityPlan(req);
  assert.ok(authorPrompts(req, plan, qualityBlueprint(req, plan, deck(quiz()))).prompt.includes(DISTRACTOR_CUES));
  assert.ok(reviewPrompts({ sources: [source], deck: deck(quiz()), kind: "quiz", count: 1 }).payload.includes(JSON.stringify(DISTRACTOR_CUES).slice(1, -1)));
});
