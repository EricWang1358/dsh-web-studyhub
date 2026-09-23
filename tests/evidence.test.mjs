import test from "node:test";
import assert from "node:assert/strict";
import { quoteFound, validateDeck } from "../lib/domain.js";
import { planAssessment, planIssues } from "../lib/assessment-quality.js";

/* A lecture outline as PDF/markdown transcription: emoji bullets, variation
   selectors, tabs and line breaks. Models routinely drop exactly those. */
const source = {
  id: "s1",
  title: "Design for Performance",
  text: "扫描代码效率\n\t\t\t识别低效区域\n\t\t\t优化建议\n吞吐量提升\n\t\t✋️ 服务器升级\n\t\t♻️ 缓存命中率提升，减少处理时间",
};

test("a verbatim quote survives dropped emoji, lost variation selectors and PDF line breaks", () => {
  for (const [why, quote] of [
    ["exact", "扫描代码效率\n\t\t\t识别低效区域"],
    ["emoji dropped by the model", "吞吐量提升\n\t\t 服务器升级"],
    ["variation selector lost", "吞吐量提升 ✋ 服务器升级"],
    ["line breaks flattened", "扫描代码效率 识别低效区域 优化建议"],
    ["zero-width noise", "缓存命中率提升​，减少处理时间"],
    ["newlines arrived double-escaped", String.raw`扫描代码效率\n\t\t\t识别低效区域\n\t\t\t优化建议`],
  ])
    assert.equal(quoteFound(source.text, quote), true, why);

  assert.equal(quoteFound(source.text, "吞吐量提升靠增加内存条"), false, "an invented passage is still rejected");
  assert.equal(quoteFound(source.text, "识别高效区域"), false, "a changed word is still rejected");
});

test("published cards keep the same tolerance, so an emoji bullet cannot block publishing", () => {
  const card = {
    id: "q1", kind: "flashcard", topic: "性能", objective: "识别缩短处理时间的动作",
    prompt: "SAST 扫出低效区域后，真正缩短处理时间的是哪类动作？", answer: "优化代码，降低复杂度。",
    hint: "想想处理时间由什么决定。", explanation: "扫描只是定位，优化才改变处理时间。", misconception: "以为扫描本身就能提速。",
    citations: [{ sourceId: "s1", quote: "吞吐量提升\n\t\t 服务器升级\n\t\t 缓存命中率提升" }],
  };
  assert.deepEqual(validateDeck({ title: "性能", cards: [card] }, [source]).errors, []);
  const invented = { ...card, id: "q2", citations: [{ sourceId: "s1", quote: "吞吐量提升靠增加内存条" }] };
  assert.match(validateDeck({ title: "性能", cards: [invented] }, [source]).errors.join(" "), /quote must match a source passage/);
});

test("a rejected plan is corrected once, and names the quote that failed", async () => {
  const request = { count: 1, sources: [source], existing: [] };
  const target = {
    objective: "识别缩短处理时间的动作", answerBoundary: "只用资料里写到的优化建议", comparisonAxis: "扫描 vs 优化",
    misconception: "以为扫描本身缩短时间", contextNeeded: "已用 SAST 扫出低效区域",
  };
  const replies = [
    { targets: [{ ...target, citations: [{ sourceId: "s1", quote: "缓存命中率提升，减少服务时间" }] }] },
    { targets: [{ ...target, citations: [{ sourceId: "s1", quote: "缓存命中率提升，减少处理时间" }] }] },
  ];
  const prompts = [];
  const ask = async (_system, prompt) => {
    prompts.push(prompt);
    return replies[prompts.length - 1];
  };
  const plan = await planAssessment(ask, request);
  assert.equal(prompts.length, 2, "the plan is retried once with the problem fed back");
  assert.match(prompts[1], /quote "缓存命中率提升，减少服务时间" is not in source s1/);
  assert.equal(plan.targets[0].citations[0].quote, "缓存命中率提升，减少处理时间");

  const stubborn = async () => replies[0];
  await assert.rejects(planAssessment(stubborn, request), /Assessment plan is not usable: Target 1: quote .* is not in source s1/);
  assert.deepEqual(planIssues({ targets: [] }, request), ["Return exactly 1 targets (got 0)"]);
  assert.deepEqual(
    planIssues({ targets: [{ ...target, citations: [{ sourceId: "nope", quote: "扫描代码效率 识别低效区域" }] }] }, request),
    ["Target 1: sourceId nope is not one of the provided sources"],
  );
});
