/* WP18 / S5 · pure course-matching helpers and historical sessionResources stay intact for read-only history,
   while workflow.quickstart and workflow.rescope refuse as retired. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { goalTokens, matchTopics, sessionResources, courseHint, isCardJson, startQuickSession } from "../lib/workflows.js";
import { skeletonTopics } from "../lib/skeleton.js";

const PE = "Platform Engineering", CN = "Cloud Native Solution Design";

const card = (id, topic, extra = {}) => ({ id, topic, kind: "flashcard", objective: `理解${topic}${id}`, prompt: `${topic}：要点${id}？`,
  answer: `${topic}的答案${id}`, hint: `提示${id}`, explanation: `${topic}的讲解${id}`, misconception: "常见误区", citations: [], ...extra });
const jsonCard = (c, sourceId) => ({ ...c, citations: [{ sourceId, quote: JSON.stringify({ kind: c.kind, prompt: c.prompt, answer: c.answer }) }] });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-wp18-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update((s) => {
    for (const n of ["05", "01"])
      s.sources.push({ id: `json${n}`, title: `JSON 导入：${PE}｜期末综合卷${n}｜90题`, provenance: "json-card-self-reference", text: "{}" });
    s.sources.push({ id: "notes", title: "云原生课堂讲义", text: "云计算是按需获取计算资源的模式，资源可以弹性伸缩。" });
    const exam = (n, topics) => ({ id: `pe${n}`, title: `${PE}｜期末综合卷${n}｜90题`, course: PE, folder: "",
      cards: topics.flatMap(([topic, count], ti) => Array.from({ length: count }, (_, i) => jsonCard(card(`${n}-${ti}-${i}`, topic), `json${n}`))) });
    s.decks.push(exam("05", [["平台工程基础", 4], ["GitOps 发布", 3], ["可观测性", 2]]));
    s.decks.push(exam("01", [["平台工程基础", 2], ["内部开发者平台", 2]]));
    s.decks.push({ id: "cn1", title: `${CN} / 01 云计算基础`, course: CN, folder: "",
      cards: [card("c1", "Cloud computing 概述", { citations: [{ sourceId: "notes", quote: "云计算是按需获取计算资源的模式，资源可以弹性伸缩。" }] }), card("c2", "云原生架构")] });
    s.decks.push({ id: "cn2", title: `${CN} / 02 微服务`, course: CN, folder: "", cards: [card("c3", "服务网格"), card("c4", "Cloud computing 概述")] });
  });
  await service.call("focus.set", { course: PE });
  return service;
}

test("goal tokens split latin words and CJK runs, and drop filler words", () => {
  assert.deepEqual(goalTokens("弄懂cloud computing重点").sort(), ["cloud", "computing"]);
  assert.ok(goalTokens("缓存命中策略").includes("缓存") && goalTokens("缓存命中策略").includes("命中"));
  assert.deepEqual(goalTokens("learn the basics of TCP"), ["basics", "tcp"]);
});

test("matchTopics finds latin words glued to Chinese text in the goal", () => {
  const topics = [{ key: "a", topic: "Cloud computing 概述", count: 2, decks: [{ deckTitle: "x", folder: "" }] },
    { key: "b", topic: "GitOps 发布", count: 3, decks: [{ deckTitle: "y", folder: "" }] }];
  assert.deepEqual(matchTopics(topics, "弄懂cloud computing重点").map((t) => t.key), ["a"]);
});

test("courseHint ignores the current course and short noise", async (t) => {
  const service = await setup(t);
  const state = await service.store.read();
  assert.equal(courseHint(state, "cloud", PE)?.course, CN);
  assert.equal(courseHint(state, "cloud", CN), null);
  assert.equal(courseHint(state, "", PE), null);
});

test("workflow.quickstart and workflow.rescope refuse as retired while historical course sessions stay readable", async (t) => {
  const service = await setup(t);
  await assert.rejects(() => service.call("workflow.quickstart", { goal: "GitOps", requestId: "r-1" }), { code: "WORKFLOW_RETIRED" });
  let seeded;
  await service.store.update((s) => {
    seeded = startQuickSession(s, {
      goal: "弄懂cloud computing重点",
      title: "平台工程基础",
      scope: [{ deckId: "pe05", topic: "平台工程基础" }],
      course: { name: PE, label: PE },
      method: "course",
      requestId: "legacy-course",
    });
  });
  await assert.rejects(() => service.call("workflow.rescope", { id: seeded.id, version: seeded.version, course: CN, requestId: "rescope" }), { code: "WORKFLOW_RETIRED" });
  const { session, resources } = await service.call("workflow.session.get", { id: seeded.id });
  assert.equal(session.course.name, PE);
  assert.equal(resources.hint.course, CN);
  assert.ok(resources.scopeTopics.includes("平台工程基础"));
  assert.equal(resources.courses.find((c) => c.name === PE).current, true);
  assert.equal(resources.courses.find((c) => c.name === CN).cards, 4);
});

test("references never expose raw card JSON: self-cited cards become a compact card summary", async (t) => {
  const service = await setup(t);
  const state = await service.store.read();
  const topics = skeletonTopics(state);
  const scope = [{ deckId: "pe05", topic: "GitOps 发布" }, { deckId: "cn1", topic: "Cloud computing 概述" }];
  const session = { id: "s", scope };
  const { readings } = sessionResources(state, { ...session, template: { steps: [] }, records: {}, history: [], skeletonId: null });
  assert.ok(topics.length);
  const bank = readings.find((r) => r.deckId === "pe05");
  assert.deepEqual(bank.citations, [], "the JSON quote is dropped");
  assert.equal(bank.card.prompt, "GitOps 发布：要点05-1-0？");
  assert.match(bank.card.answer, /GitOps 发布的答案/);
  assert.match(bank.card.deck, /期末综合卷05/);
  assert.equal(bank.card.kind, "flashcard");
  for (const reading of readings) assert.doesNotMatch(JSON.stringify(reading.citations), /"kind"|\{\\"/);
  const real = readings.find((r) => r.deckId === "cn1");
  assert.equal(real.citations.length, 1, "a real source quote is kept");
  assert.match(real.citations[0].quote, /云计算是按需获取/);
  assert.equal(real.card, undefined);
});

test("a quote that parses as a card object is hidden even from an ordinary source", async (t) => {
  const service = await setup(t);
  await service.store.update((s) => {
    s.sources.push({ id: "odd", title: "杂项", text: "x" });
    s.decks.find((d) => d.id === "cn1").cards[1].citations = [{ sourceId: "odd", quote: '{"kind":"flashcard","prompt":"什么是云原生？","answer":"为云而生"}' }];
  });
  const state = await service.store.read();
  const { readings } = sessionResources(state, { id: "s", scope: [{ deckId: "cn1", topic: "云原生架构" }], template: { steps: [] }, records: {}, history: [], skeletonId: null });
  assert.deepEqual(readings[0].citations, []);
  assert.equal(readings[0].card.prompt, "云原生架构：要点c2？");
  assert.equal(isCardJson('{"kind":"flashcard","prompt":"p"}'), true);
  assert.equal(isCardJson("{ 不是 JSON"), true, "anything that starts with { is not prose");
  assert.equal(isCardJson("云计算是按需获取计算资源的模式"), false);
});
