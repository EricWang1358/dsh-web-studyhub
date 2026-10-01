/* WP18 · the guided flow knows which course it studies: current-course pick,
   fallback by real topics, a cross-course hint, rescope in place, readable
   references and friendly model errors. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { goalTokens, matchTopics, sessionResources, courseHint, isCardJson } from "../lib/workflows.js";
import { skeletonTopics } from "../lib/skeleton.js";

const PE = "Platform Engineering", CN = "Cloud Native Solution Design";
const RATE = "Your requests to gpt-6-luna for gpt-6-luna in centralus have exceeded token rate limit.";

const card = (id, topic, extra = {}) => ({ id, topic, kind: "flashcard", objective: `理解${topic}${id}`, prompt: `${topic}：要点${id}？`,
  answer: `${topic}的答案${id}`, hint: `提示${id}`, explanation: `${topic}的讲解${id}`, misconception: "常见误区", citations: [], ...extra });
const jsonCard = (c, sourceId) => ({ ...c, citations: [{ sourceId, quote: JSON.stringify({ kind: c.kind, prompt: c.prompt, answer: c.answer }) }] });

async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), "study-wp18-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, complete ? { complete } : {});
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
const start = (service, goal, extra = {}) => service.call("workflow.quickstart", { goal, requestId: `r-${Math.random()}`, ...extra });
const read = async (service, id) => (await service.store.read()).workflowSessions.find((s) => s.id === id);

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

test("the AI pick sees only the current course's topics and the session stores the course", async (t) => {
  let seen;
  const service = await setup(t, async (system, prompt) => {
    seen = JSON.parse(prompt);
    const keys = seen.topics.filter((x) => x.topic === "GitOps 发布").map((x) => x.key);
    return JSON.stringify({ keys, title: "GitOps 怎么发布" });
  });
  const { session, method } = await start(service, "弄懂 GitOps");
  assert.equal(method, "ai");
  assert.equal(seen.course, PE);
  assert.ok(seen.topics.length && seen.topics.every((x) => !/Cloud|云原生|服务网格/.test(x.topic)), "no topic from another course is offered");
  assert.equal(session.course.name, PE, "the course is stored for every method");
  assert.equal(session.pickedBy, "ai");
  assert.ok(session.scope.every((r) => r.deckId.startsWith("pe")));
});

test("no match in the current course falls back to its real topics, names the course and keeps deck titles secondary", async (t) => {
  const service = await setup(t);
  const { session, method, resources } = await start(service, "弄懂cloud computing重点");
  assert.equal(method, "course");
  assert.equal(session.pickedBy, "course");
  assert.equal(session.course.name, PE);
  assert.ok(session.scope.length && session.scope.every((r) => r.topic), "scope is a set of topics, not whole decks");
  assert.ok(resources.scopeTopics.includes("平台工程基础"));
  assert.ok(resources.scopeTopics.every((x) => !x.includes("期末综合卷")), "deck titles are not listed as topics");
  assert.ok(resources.scopeDecks.some((x) => x.includes("期末综合卷")), "deck titles stay as secondary info");
  assert.equal(resources.scopeTopics[0], "平台工程基础", "most frequent topic first");
  assert.equal(session.aiFailed, undefined, "no model connected is not a failure");
});

test("a cross-course hint names the better-matching course but never switches", async (t) => {
  const service = await setup(t);
  const { session, resources } = await start(service, "弄懂cloud computing重点");
  assert.equal(resources.hint.course, CN);
  assert.ok(resources.hint.cards >= 1);
  assert.equal((await read(service, session.id)).course.name, PE, "still on the current course");
  const matched = await start(service, "GitOps");
  assert.equal(matched.session.pickedBy, "match");
  assert.equal(matched.resources.hint, null, "no hint when the current course has a match");
  const none = await start(service, "量子退火");
  assert.equal(none.resources.hint, null, "no hint when no other course matches either");
});

test("courseHint ignores the current course and short noise", async (t) => {
  const service = await setup(t);
  const state = await service.store.read();
  assert.equal(courseHint(state, "cloud", PE)?.course, CN);
  assert.equal(courseHint(state, "cloud", CN), null);
  assert.equal(courseHint(state, "", PE), null);
});

test("when the model pick fails the flow falls back by name and says so", async (t) => {
  const service = await setup(t, async () => { throw new Error(RATE); });
  const { session, method } = await start(service, "GitOps");
  assert.equal(method, "match");
  assert.equal(session.aiFailed, true);
  assert.equal(session.scope.length > 0, true);
  const ok = await setup(t, async () => JSON.stringify({ keys: [], title: "" }));
  const fine = await start(ok, "GitOps");
  assert.notEqual(fine.session.aiFailed, true);
});

test("rescope moves the same goal to another course and keeps what was written", async (t) => {
  const service = await setup(t);
  let { session } = await start(service, "弄懂cloud computing重点");
  const lesson = session.template.steps.find((s) => s.kind === "lesson");
  assert.equal(session.currentStepId, lesson.id);
  session = await service.call("workflow.session.record", { id: session.id, version: session.version, output: "我的笔记：云计算是按需取用资源" });
  const result = await service.call("workflow.rescope", { id: session.id, version: session.version, course: CN, requestId: "rescope-1" });
  const next = result.session;
  assert.equal(next.course.name, CN);
  assert.ok(next.scope.every((r) => r.deckId.startsWith("cn")), "scope is now inside the new course");
  assert.equal(next.pickedBy, "match");
  assert.equal(next.goal, "弄懂cloud computing重点", "the goal is unchanged");
  assert.equal(next.records[lesson.id].output, "我的笔记：云计算是按需取用资源", "notes survive");
  const goalStep = next.template.steps[0];
  assert.equal(next.records[goalStep.id].output, "本次目标：弄懂cloud computing重点", "the goal step record survives");
  assert.ok(next.version > session.version);
  const entry = next.history.at(-1);
  assert.equal(entry.kind, "rescope");
  assert.match(entry.output, new RegExp(CN));
  assert.equal(result.resources.hint, null, "the new course matches, no hint");
  assert.equal(result.resources.courses.find((c) => c.name === CN).current, true);
  const again = await service.call("workflow.rescope", { id: session.id, version: next.version, course: CN, requestId: "rescope-1" });
  assert.equal(again.session.history.length, next.history.length, "a retried request is applied once");
});

test("rescope re-runs the AI pick inside the new course only", async (t) => {
  const prompts = [];
  const service = await setup(t, async (system, prompt) => {
    prompts.push(JSON.parse(prompt));
    const topics = prompts.at(-1).topics;
    return JSON.stringify({ keys: topics.slice(0, 1).map((x) => x.key), title: "云计算" });
  });
  const { session } = await start(service, "cloud computing");
  const result = await service.call("workflow.rescope", { id: session.id, version: session.version, course: CN, requestId: "x" });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].course, CN);
  assert.ok(prompts[1].topics.every((x) => !/平台工程|GitOps|可观测/.test(x.topic)));
  assert.equal(result.session.pickedBy, "ai");
});

test("rescope is refused once a practice answer is recorded, and the portal says so up front", async (t) => {
  const service = await setup(t);
  const { session } = await start(service, "GitOps");
  assert.equal((await service.call("workflow.session.get", { id: session.id })).resources.rescope.allowed, true);
  await service.store.update((s) => {
    s.runs.push({ id: "run1", mode: "path", workflowSessionId: session.id, entries: [{ deckId: "pe05", card: card("x", "t"), feedback: { grade: 3 } }] });
  });
  const state = await service.call("workflow.session.get", { id: session.id });
  assert.equal(state.resources.rescope.allowed, false);
  await assert.rejects(service.call("workflow.rescope", { id: session.id, version: state.session.version, course: CN, requestId: "no" }), /练习/);
  assert.equal((await read(service, session.id)).course.name, PE);
});

test("rescope drops an unanswered practice round so practice follows the new scope", async (t) => {
  const service = await setup(t);
  let { session } = await start(service, "GitOps");
  const practice = session.template.steps.find((s) => s.kind === "practice");
  await service.store.update((s) => {
    const live = s.workflowSessions.find((x) => x.id === session.id);
    s.runs.push({ id: "run2", mode: "path", workflowSessionId: session.id, entries: [{ deckId: "pe05", card: card("x", "t"), feedback: null }] });
    live.records[practice.id] = { runId: "run2" };
    live.version++;
  });
  session = await read(service, session.id);
  const { session: next } = await service.call("workflow.rescope", { id: session.id, version: session.version, course: CN, requestId: "p" });
  assert.equal(next.records[practice.id]?.runId, undefined);
  assert.ok((await service.store.read()).runs.find((r) => r.id === "run2").closedAt, "the old round is closed, not deleted");
});

test("rescope rejects an unknown course", async (t) => {
  const service = await setup(t);
  const { session } = await start(service, "GitOps");
  await assert.rejects(service.call("workflow.rescope", { id: session.id, version: session.version, course: "No Such Course", requestId: "n" }), /课程/);
});

test("quickstart can start inside a chosen course, and the route's own sessions keep their behaviour", async (t) => {
  const service = await setup(t);
  const { session } = await start(service, "cloud computing", { inCourse: CN });
  assert.equal(session.course.name, CN);
  assert.ok(session.scope.every((r) => r.deckId.startsWith("cn")));
  const route = await service.call("workflow.quickstart", { course: PE, requestId: "route" });
  assert.equal(route.session.pickedBy, "route");
  assert.equal(route.session.course.name, PE);
});

test("the course list for the switcher marks the current course and counts cards", async (t) => {
  const service = await setup(t);
  const { resources } = await start(service, "GitOps");
  const names = resources.courses.map((c) => c.name);
  assert.ok(names.includes(PE) && names.includes(CN));
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
