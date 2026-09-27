import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { defaultWorkflow } from "../lib/workflow-contract.js";
import { Store } from "../lib/store.js";
import { notify } from "../lib/inbox.js";
import { scopeKey } from "../lib/mastery.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root);
}
test("workspace and chat share a five-template bound even with concurrent saves", async (t) => {
  const service = await setup(t);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.call("workflow.save", defaultWorkflow())));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal((await service.call("workflow.list")).templates.length, 5);
  const one = results.find((r) => r.status === "fulfilled").value;
  const saved = await service.call("workflow.save", { ...one, title: "我的方法" });
  await assert.rejects(service.call("workflow.save", { ...one, title: "过期修改" }), /已更新/);
  assert.equal(saved.title, "我的方法");
});
test("retrying a new template save does not consume another slot", async (t) => {
  const service = await setup(t);
  const input = { ...defaultWorkflow(), requestId: "create-once" };
  const [first, second] = await Promise.all([service.call("workflow.save", input), service.call("workflow.save", input)]);
  assert.equal(first.id, second.id);
  assert.equal((await service.call("workflow.list")).templates.length, 1);
});
test("session snapshot, output, transitions and pause survive reload without changing cards", async (t) => {
  const service = await setup(t);
  const template = await service.call("workflow.save", { title: "复述", steps: [
    { id: "recall", kind: "recall", title: "讲清楚", next: "$next", retry: "$stay" },
    { id: "reflection", kind: "reflection", title: "总结" }] });
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "没有题目的新主题", requestId: "start" });
  assert.equal((await service.call("workflow.session.start", { templateId: template.id, topic: "同一次", requestId: "start" })).id, session.id);
  await service.call("workflow.save", { ...template, title: "新方法" });
  await service.call("workflow.delete", { id: template.id, version: 2 });
  assert.equal((await service.call("workflow.session.get", { id: session.id })).session.template.title, "复述");
  await assert.rejects(service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "a" }), /写下/);
  session = await service.call("workflow.session.record", { id: session.id, version: session.version, output: "我的解释" });
  const first = { id: session.id, version: session.version, outcome: "done", requestId: "a" };
  session = await service.call("workflow.session.advance", first);
  assert.equal((await service.call("workflow.session.advance", first)).version, session.version);
  assert.equal(session.currentStepId, "reflection");
  session = await service.call("workflow.session.status", { id: session.id, version: session.version, status: "paused" });
  const restored = await new StudyService(service.store.root).call("workflow.session.get", { id: session.id });
  assert.equal(restored.session.status, "paused");
  assert.equal(restored.session.records.recall.output, "我的解释");
  await assert.rejects(service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "skipped", requestId: "b" }), /继续/);
  session = await service.call("workflow.session.status", { id: session.id, version: session.version, status: "active" });
  session = await service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "skipped", requestId: "b" });
  assert.equal(session.status, "completed");
  assert.equal(session.history[1].outcome, "skipped");
  assert.deepEqual((await service.store.read()).attempts, []);
});
test("invalid branches fail atomically and a main-session material update cannot write a stale step", async (t) => {
  const service = await setup(t);
  await assert.rejects(service.call("workflow.save", { title: "坏流程", steps: [{ id: "a", kind: "overview", title: "a", next: "missing" }] }), /不存在/);
  const template = await service.call("workflow.save", defaultWorkflow());
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "架构", requestId: "start" });
  const stale = { id: session.id, version: session.version, stepId: session.currentStepId, content: "例子与推导" };
  session = await service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "step" });
  await assert.rejects(service.call("workflow.session.material", stale), /已更新/);
  const context = await service.call("workflow.context", { sessionId: session.id });
  assert.equal(context.session.currentStepId, "step-2");
  assert.equal(context.components.length, 6);
});

const seed = async (service) => service.store.update((s) => {
  s.sources.push({ id: "s", title: "范围示例", text: "缓存保存可重复使用的结果，在请求可复用且结果仍有效时减少重复计算。" });
  s.decks.push({ id: "d", title: "示例题组", cards: [{ id: "q", kind: "flashcard", topic: "缓存",
    objective: "解释复用条件", prompt: "结果在什么条件下可以复用？", answer: "请求可复用且结果仍有效。",
    explanation: "先核对请求是否相同，再检查结果是否过期。", hint: "检查条件", misconception: "把过期结果也当作可复用。",
    citations: [{ sourceId: "s", quote: "在请求可复用且结果仍有效时减少重复计算" }] }] });
});

test("portal practice reuses grading without taking over standalone flashcards", async (t) => {
  const service = await setup(t);
  await seed(service);
  const regular = await service.call("review.start", { mode: "flashcard", deckId: "d" });
  const template = await service.call("workflow.save", { title: "练习", steps: [{ id: "practice", kind: "practice", title: "练一题", count: 1 }] });
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "缓存", scope: [{ deckId: "d", topic: "缓存" }], requestId: "start" });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  session = started.session;
  let run = started.run;
  assert.notEqual(run.id, regular.id);
  assert.equal((await service.call("review.get", { runId: regular.id })).closed, false);
  const snapshot = await service.call("snapshot");
  assert.equal(snapshot.lastRun.id, regular.id);
  assert.deepEqual(snapshot.runs.map((r) => r.id), [regular.id]);
  assert.equal((await service.store.read()).attempts.length, 0);
  assert.equal((await service.call("workflow.practice.start", { id: session.id, version: session.version })).run.id, run.id);
  await assert.rejects(service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "finish" }), /完成本步练习/);
  run = await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 });
  session = await service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "finish" });
  assert.equal(session.status, "completed");
  assert.equal((await service.store.read()).attempts.length, 1);
  assert.equal((await service.call("review.get", { runId: run.id })).closed, true);
  assert.equal((await service.call("review.get", { runId: regular.id })).feedback, null);
});

test("practice remediation keeps old evidence but creates a new round", async (t) => {
  const service = await setup(t);
  await seed(service);
  const template = await service.call("workflow.save", { title: "再练一遍", steps: [{ id: "practice", kind: "practice", title: "练习", retry: "$stay" }] });
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "缓存", scope: [{ deckId: "d" }], requestId: "start" });
  const first = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  session = await service.call("workflow.session.advance", { id: session.id, version: first.session.version, outcome: "needs_work", requestId: "retry", output: "需要先回顾概念" });
  const second = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  assert.notEqual(first.run.id, second.run.id);
  assert.equal((await service.call("review.get", { runId: first.run.id })).closed, true);
  assert.equal(second.session.history[0].practiceRunId, first.run.id);
  assert.equal((await service.store.read()).attempts.length, 0);
});

test("an unbound custom topic never silently practises the whole library", async (t) => {
  const service = await setup(t);
  await seed(service);
  const template = await service.call("workflow.save", { title: "练习", steps: [{ id: "p", kind: "practice", title: "练习" }] });
  const session = await service.call("workflow.session.start", { templateId: template.id, topic: "自定义新主题", requestId: "new-topic" });
  assert.equal((await service.call("workflow.session.get", { id: session.id })).resources.cardCount, 0);
  await assert.rejects(service.call("workflow.practice.start", { id: session.id, version: session.version }), /没有可练习/);
  assert.deepEqual((await service.store.read()).runs, []);
});

test("main-session teaching preserves learner output and rejects stale concurrent overwrites", async (t) => {
  const service = await setup(t);
  const template = await service.call("workflow.save", defaultWorkflow());
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "新主题", requestId: "topic" });
  session = await service.call("workflow.session.record", { id: session.id, version: session.version, output: "我想弄清它为何有效" });
  const version = session.version;
  session = await service.call("workflow.session.material", { id: session.id, version, stepId: session.currentStepId, content: "以实际条件为起点，逐步分析。补充例子：……" });
  await assert.rejects(service.call("workflow.session.record", { id: session.id, version, output: "另一窗口写入" }), /已更新/);
  assert.equal(session.records[session.currentStepId].output, "我想弄清它为何有效");
  assert.match(session.records[session.currentStepId].content, /逐步分析/);
  assert.equal(session.history.length, 0);
  assert.deepEqual((await service.store.read()).attempts, []);
});

test("v2 upgrade backs up the full old library and workflow data round-trips through export", async (t) => {
  const service = await setup(t);
  await seed(service);
  const path = service.store.path;
  const old = JSON.parse(await readFile(path, "utf8"));
  old.version = 2;
  delete old.shards.workflowTemplates;
  delete old.shards.workflowSessions;
  await writeFile(path, JSON.stringify(old));
  const legacyCard = structuredClone((await service.store.read()).decks[0].cards[0]);
  const template = await service.call("workflow.save", defaultWorkflow());
  const session = await service.call("workflow.session.start", { templateId: template.id, topic: "缓存", requestId: "start" });
  const backups = await readdir(join(service.store.root, "backups"));
  const backup = JSON.parse(await readFile(join(service.store.root, "backups", backups.find((f) => f.startsWith("study-workspace-v2-"))), "utf8"));
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.decks[0].cards[0], legacyCard);
  const destination = await mkdtemp(join(tmpdir(), "study-workflow-restored-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const exported = await service.call("export");
  const restored = new Store(destination);
  await restored.restore(exported);
  const state = await restored.read();
  assert.equal(state.workflowSessions[0].id, session.id);
  assert.equal(state.workflowTemplates[0].id, template.id);
  assert.deepEqual(state.decks[0].cards[0], legacyCard);
});

const seedOrganization = async (service) => {
  await seed(service);
  await service.store.update((s) => {
    const original = s.decks[0].cards[0];
    const card = (id, topic, extra = {}) => ({ ...structuredClone(original), id, topic, prompt: `问题 ${id}`, ...extra });
    s.decks[0].cards.push(card("r", "队列"), card("held", "缓存", { suspended: true }));
    s.decks.push({ id: "target", title: "目标题组", cards: [card("target-cache", "缓存"), card("target-queue", "队列")] });
    s.decks.push({ id: "other", title: "独立题组", cards: [card("other-card", "其他")] });
  });
};
const practiceTemplate = (service) => service.call("workflow.save", {
  title: "练习", steps: [{ id: "p", kind: "practice", title: "练习", count: 10 }],
});

test("saved workflow scopes keep the same members through split and merge without widening either deck", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const template = await practiceTemplate(service);
  const cases = [
    { name: "whole", scope: [{ deckId: "d" }], cards: ["q", "r"], saved: ["held", "q", "r"] },
    { name: "topic", scope: [{ deckId: "d", topic: "缓存" }], cards: ["q"], saved: ["held", "q"] },
    { name: "card", scope: [{ deckId: "d", cardId: "q" }], cards: ["q"], saved: ["q"] },
    { name: "target", scope: [{ deckId: "target" }], cards: ["target-cache", "target-queue"], saved: ["target-cache", "target-queue"] },
    { name: "target-topic", scope: [{ deckId: "target", topic: "缓存" }], cards: ["target-cache"], saved: ["target-cache"] },
    { name: "unrelated", scope: [{ deckId: "other" }], cards: ["other-card"] },
  ];
  for (const item of cases) item.session = await service.call("workflow.session.start", {
    templateId: template.id, topic: item.name, scope: item.scope, requestId: item.name,
  });
  const split = await service.call("deck.split", { id: "d", title: "拆出的缓存", topics: ["缓存"] });
  for (const item of cases) {
    const { session, resources } = await service.call("workflow.session.get", { id: item.session.id });
    assert.deepEqual(resources.readings.map((r) => r.cardId).sort(), item.cards, `${item.name} after split`);
    assert.equal(session.version, item.session.version + (item.scope[0].deckId === "d" ? 1 : 0));
    if (item.scope[0].deckId === "d") assert.ok(session.updatedAt > item.session.updatedAt);
  }
  const beforeMerge = await service.call("workflow.session.get", { id: cases[0].session.id });
  await service.call("deck.merge", { sourceIds: [split.targetId], targetId: "target" });
  const restored = new StudyService(service.store.root);
  for (const item of cases) {
    const { session, resources } = await restored.call("workflow.session.get", { id: item.session.id });
    assert.deepEqual(resources.readings.map((r) => r.cardId).sort(), item.cards, `${item.name} after merge and reload`);
    assert.deepEqual(session.template, template, "organization never rewrites the immutable template");
    if (item.saved) assert.deepEqual(session.scope.map((r) => r.cardId).sort(), item.saved);
    if (item.name === "unrelated") assert.deepEqual(session, item.session);
    else assert.ok(session.version > item.session.version);
  }
  await assert.rejects(restored.call("workflow.session.record", {
    id: beforeMerge.session.id, version: beforeMerge.session.version, output: "过期窗口",
  }), /已更新/);
  await restored.call("card.suspend", { deckId: "target", cardId: "held", suspended: false });
  for (const item of cases) {
    const { session } = await restored.call("workflow.session.get", { id: item.session.id });
    const started = await restored.call("workflow.practice.start", { id: session.id, version: session.version });
    assert.deepEqual(started.run.navigation.map((r) => r.cardId).sort(), item.saved || item.cards,
      `${item.name} practice keeps suspended members when they return`);
  }
});

test("partly answered Portal practice remains open with the same progress after card relocation", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const ordinary = await service.call("review.start", { mode: "flashcard", deckId: "d" });
  const template = await practiceTemplate(service);
  const session = await service.call("workflow.session.start", {
    templateId: template.id, topic: "缓存与队列", scope: [{ deckId: "d" }], requestId: "progress",
  });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  await service.call("review.reveal", { runId: started.run.id, cardId: "q" });
  await service.call("review.answer", { runId: started.run.id, cardId: "q", grade: 4 });
  await service.call("review.move", { runId: started.run.id, index: 1 });
  const before = (await service.store.read()).runs.find((r) => r.id === started.run.id);
  const split = await service.call("deck.split", { id: "d", title: "缓存", topics: ["缓存"] });
  await service.call("deck.merge", { sourceIds: ["d"], targetId: "target" });
  const restored = new StudyService(service.store.root);
  const saved = await restored.call("workflow.session.get", { id: session.id });
  const resumed = await restored.call("workflow.practice.start", { id: session.id, version: saved.session.version });
  assert.equal(resumed.run.id, started.run.id);
  assert.equal(resumed.run.closed, false);
  assert.equal(resumed.run.index, 1);
  assert.equal(resumed.run.card.id, "r");
  assert.deepEqual(resumed.run.navigation.map(({ cardId, deckId }) => ({ cardId, deckId })), [
    { cardId: "q", deckId: split.targetId }, { cardId: "r", deckId: "target" },
  ]);
  const state = await restored.store.read();
  const run = state.runs.find((r) => r.id === started.run.id);
  assert.equal(run.key, before.key);
  assert.deepEqual(run.scope, saved.session.scope);
  assert.equal(run.deckId, null, "the run now spans two decks");
  assert.deepEqual(run.entries[0].feedback, before.entries[0].feedback);
  assert.equal(run.entries[0].revealed, true);
  assert.equal(run.entries[0].signature, before.entries[0].signature);
  assert.equal(saved.session.records.p.runId, started.run.id);
  assert.equal(state.attempts[0].deckId, split.targetId);
  assert.equal((await restored.call("review.get", { runId: ordinary.id })).closed, true,
    "ordinary review keeps its existing relocation behavior");
  await restored.call("review.reveal", { runId: run.id, cardId: "r" });
  await restored.call("review.answer", { runId: run.id, cardId: "r", grade: 4 });
  const completed = await restored.call("workflow.session.advance", {
    id: session.id, version: saved.session.version, outcome: "done", requestId: "done",
  });
  assert.equal(completed.status, "completed");
  assert.equal((await restored.store.read()).attempts.length, 2);
});

test("unrelated deck organization preserves Portal ownership even if an old key collides with ordinary review", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const template = await practiceTemplate(service);
  const scope = [{ deckId: "d", topic: "缓存" }];
  const session = await service.call("workflow.session.start", {
    templateId: template.id, topic: "缓存", scope, requestId: "ownership",
  });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  const key = (await service.store.read()).runs.find((r) => r.id === started.run.id).key;
  await service.call("deck.merge", { sourceIds: ["other"], targetId: "target" });
  await service.call("deck.split", { id: "target", title: "其他", topics: ["其他"] });
  assert.equal((await service.store.read()).runs.find((r) => r.id === started.run.id).key, key);
  // Libraries written by the broken relocation code may already have ordinary keys.
  await service.store.update((s) => { s.runs.find((r) => r.id === started.run.id).key = scopeKey("path", scope); });
  const ordinary = await service.call("review.start", { mode: "path", scope });
  assert.notEqual(ordinary.id, started.run.id);
  assert.equal((await service.call("review.start", { mode: "path", scope })).id, ordinary.id);
  const fresh = await service.call("review.start", { mode: "path", scope, fresh: true });
  assert.notEqual(fresh.id, ordinary.id);
  assert.equal((await service.call("review.get", { runId: ordinary.id })).closed, true);
  assert.equal((await service.call("review.get", { runId: started.run.id })).closed, false);
});

test("inbox navigation never adopts or moves a Portal run, including a supplied Portal run ID", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const ordinary = await service.call("review.start", { mode: "flashcard", deckId: "other" });
  const template = await practiceTemplate(service);
  const session = await service.call("workflow.session.start", {
    templateId: template.id, topic: "缓存与队列", scope: [{ deckId: "d" }], requestId: "inbox",
  });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  await service.store.update((s) => { notify(s, { kind: "followup", deckId: "d", cardId: "r", detail: "补充内容" }); });
  const letter = (await service.call("inbox")).items[0];
  const inboxRun = await service.call("inbox.open", { id: letter.id, runId: ordinary.id });
  assert.notEqual(inboxRun.id, started.run.id);
  assert.equal(inboxRun.card.id, "r");
  assert.equal(inboxRun.returnTo, ordinary.id);
  await service.call("review.end", { runId: inboxRun.id });
  const suppliedPortal = await service.call("inbox.open", { id: letter.id, runId: started.run.id });
  assert.notEqual(suppliedPortal.id, started.run.id);
  assert.equal(suppliedPortal.returnTo, null);
  const portal = await service.call("review.get", { runId: started.run.id });
  assert.equal(portal.index, 0);
  assert.equal(portal.card.id, "q");
  assert.equal(portal.feedback, null);
  assert.equal(portal.closed, false);
});

test("implicit current-card and prerequisite capture use ordinary review while explicit Portal actions still work", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const ordinary = await service.call("review.start", { mode: "flashcard", deckId: "other" });
  const template = await practiceTemplate(service);
  const session = await service.call("workflow.session.start", {
    templateId: template.id, topic: "缓存", scope: [{ deckId: "d" }], requestId: "current",
  });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  await service.store.update((s) => {
    s.runs.find((r) => r.id === ordinary.id).entries[0].startedAt = 1;
    s.runs.find((r) => r.id === started.run.id).entries[0].startedAt = 2;
  });
  assert.equal((await service.call("card.current")).card.id, "other-card");
  const capture = new StudyService(service.store.root, { complete: async () => assert.fail("exact capture should not call a model") });
  await capture.call("capture", { question: "问题 r", requiredBy: "current" });
  assert.deepEqual((await service.call("card.get", { cardId: "other-card" })).card.requires, [{ deckId: "d", cardId: "r" }]);
  assert.deepEqual((await service.call("card.get", { cardId: "q" })).card.requires || [], []);
  await service.call("review.end", { runId: ordinary.id });
  await assert.rejects(service.call("card.current"), /No question is open/);
  const portal = await service.call("review.move", { runId: started.run.id, index: 1 });
  assert.equal(portal.card.id, "r");
  assert.equal((await service.call("review.reveal", { runId: portal.id, cardId: "r" })).closed, false);
});

test("deleting a session closes only its Portal run and preserves recorded attempts", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const ordinary = await service.call("review.start", { mode: "flashcard", deckId: "d" });
  const template = await practiceTemplate(service);
  const session = await service.call("workflow.session.start", {
    templateId: template.id, topic: "缓存与队列", scope: [{ deckId: "d" }], requestId: "delete-session",
  });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  await service.call("review.reveal", { runId: started.run.id, cardId: "q" });
  await service.call("review.answer", { runId: started.run.id, cardId: "q", grade: 4 });
  const before = await service.store.read();
  assert.equal(before.attempts.length, 1);
  assert.equal((await service.call("review.get", { runId: started.run.id })).closed, false);

  await service.call("workflow.session.delete", { id: session.id, version: started.session.version });
  const restored = new StudyService(service.store.root);
  const after = await restored.store.read();
  assert.equal(after.workflowSessions.some((item) => item.id === session.id), false);
  assert.equal((await restored.call("review.get", { runId: started.run.id })).closed, true);
  assert.equal((await restored.call("review.get", { runId: ordinary.id })).closed, false);
  assert.deepEqual(after.runs.find((run) => run.id === ordinary.id), before.runs.find((run) => run.id === ordinary.id));
  assert.deepEqual(after.attempts, before.attempts);
  assert.deepEqual(after.runs.find((run) => run.id === started.run.id).entries,
    before.runs.find((run) => run.id === started.run.id).entries);
});

test("unfinished Portal practice resumes the same current card, reveals and answers after service restart", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const template = await practiceTemplate(service);
  const session = await service.call("workflow.session.start", {
    templateId: template.id, topic: "缓存与队列", scope: [{ deckId: "d" }], requestId: "restart-practice",
  });
  const started = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  await service.call("review.reveal", { runId: started.run.id, cardId: "q" });
  const answered = await service.call("review.answer", { runId: started.run.id, cardId: "q", grade: 4 });
  await service.call("review.move", { runId: started.run.id, index: 1 });
  await service.call("review.reveal", { runId: started.run.id, cardId: "r" });
  const before = await service.store.read();

  const restored = new StudyService(service.store.root);
  const saved = await restored.call("workflow.session.get", { id: session.id });
  const resumed = await restored.call("workflow.practice.start", { id: session.id, version: saved.session.version });
  assert.equal(resumed.run.id, started.run.id);
  assert.equal(resumed.run.closed, false);
  assert.equal(resumed.run.index, 1);
  assert.equal(resumed.run.card.id, "r");
  assert.equal(resumed.run.revealed, true);
  assert.equal(resumed.run.feedback, null);
  assert.equal(resumed.session.records.p.runId, started.run.id);
  assert.equal(resumed.session.history.length, 0);
  assert.deepEqual((await restored.store.read()).runs, before.runs);

  const previous = await restored.call("review.move", { runId: resumed.run.id, index: 0 });
  assert.equal(previous.card.id, "q");
  assert.equal(previous.revealed, true);
  assert.deepEqual(previous.feedback, answered.feedback);
  await restored.call("review.answer", { runId: resumed.run.id, cardId: "q", grade: 4 });
  assert.deepEqual((await restored.store.read()).attempts, before.attempts, "replaying the saved answer is still idempotent");
  await restored.call("review.move", { runId: resumed.run.id, index: 1 });
  await restored.call("review.answer", { runId: resumed.run.id, cardId: "r", grade: 3 });
  assert.equal((await restored.store.read()).attempts.length, 2);
});
