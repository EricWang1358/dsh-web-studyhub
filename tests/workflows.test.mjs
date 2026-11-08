import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { defaultWorkflow } from "../lib/workflow-contract.js";
import { saveWorkflow, startSession, deleteSession } from "../lib/workflows.js";
import { Store } from "../lib/store.js";
import { notify } from "../lib/inbox.js";
import { scopeKey } from "../lib/mastery.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root);
}

const seed = async (service) => service.store.update((s) => {
  s.sources.push({ id: "s", title: "范围示例", text: "缓存保存可重复使用的结果，在请求可复用且结果仍有效时减少重复计算。" });
  s.decks.push({ id: "d", title: "示例题组", cards: [{ id: "q", kind: "flashcard", topic: "缓存",
    objective: "解释复用条件", prompt: "结果在什么条件下可以复用？", answer: "请求可复用且结果仍有效。",
    explanation: "先核对请求是否相同，再检查结果是否过期。", hint: "检查条件", misconception: "把过期结果也当作可复用。",
    citations: [{ sourceId: "s", quote: "在请求可复用且结果仍有效时减少重复计算" }] }] });
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

async function seedPortalSession(service, { topic = "缓存与队列", scope = [{ deckId: "d" }], requestId = "portal" } = {}) {
  let template, session;
  await service.store.update((s) => {
    template = s.workflowTemplates[0] || saveWorkflow(s, { title: "练习", steps: [{ id: "p", kind: "practice", title: "练习", count: 10 }] });
    session = startSession(s, { templateId: template.id, topic, scope, requestId });
  });
  const rawRun = await service.call("review.start", { mode: "path", scope, fresh: true });
  await service.store.update((s) => {
    const run = s.runs.find((item) => item.id === rawRun.id);
    run.workflowSessionId = session.id;
    run.workflowStepId = "p";
    run.key = `workflow:${session.id}:p`;
    const live = s.workflowSessions.find((item) => item.id === session.id);
    live.records.p = { runId: run.id };
    live.version += 1;
    session = structuredClone(live);
  });
  return { template, session, run: await service.call("review.get", { runId: rawRun.id }) };
}

test("public mutating workflow RPCs refuse with WORKFLOW_RETIRED while read-only list, get and context work", async (t) => {
  const service = await setup(t);
  let template, session;
  await service.store.update((s) => {
    template = saveWorkflow(s, defaultWorkflow());
    session = startSession(s, { templateId: template.id, topic: "架构", requestId: "start" });
  });
  for (const [action, args] of [
    ["workflow.save", defaultWorkflow()],
    ["workflow.delete", { id: template.id, version: template.version }],
    ["workflow.session.start", { templateId: template.id, topic: "新", requestId: "n" }],
    ["workflow.session.record", { id: session.id, version: session.version, output: "x" }],
    ["workflow.session.material", { id: session.id, version: session.version, stepId: session.currentStepId, content: "x" }],
    ["workflow.session.material.restore", { id: session.id, version: session.version, stepId: session.currentStepId, index: 0 }],
    ["workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "a" }],
    ["workflow.session.goto", { id: session.id, version: session.version, stepId: session.currentStepId }],
    ["workflow.session.status", { id: session.id, version: session.version, status: "paused" }],
    ["workflow.session.delete", { id: session.id, version: session.version }],
    ["workflow.practice.start", { id: session.id, version: session.version }],
  ]) {
    await assert.rejects(() => service.call(action, args), { code: "WORKFLOW_RETIRED" }, action);
  }
  const listing = await service.call("workflow.list");
  assert.equal(listing.retired, true);
  assert.equal(listing.sessions.length, 1);
  const got = await service.call("workflow.session.get", { id: session.id });
  assert.equal(got.retired, true);
  assert.equal(got.session.topic, "架构");
  const context = await service.call("workflow.context", { sessionId: session.id });
  assert.equal(context.retired, true);
  assert.equal(context.session.id, session.id);
});

test("v2 upgrade backs up the full old library and historical workflow data round-trips through export", async (t) => {
  const service = await setup(t);
  await seed(service);
  let template, session;
  await service.store.update((s) => {
    template = saveWorkflow(s, defaultWorkflow());
    session = startSession(s, { templateId: template.id, topic: "缓存", requestId: "start" });
  });
  const path = service.store.path;
  const old = JSON.parse(await readFile(path, "utf8"));
  old.version = 2;
  await writeFile(path, JSON.stringify(old));
  const reloaded = new StudyService(service.store.root);
  const legacyCard = structuredClone((await reloaded.store.read()).decks[0].cards[0]);
  await reloaded.store.update(() => {});
  const backups = await readdir(join(service.store.root, "backups"));
  const backup = JSON.parse(await readFile(join(service.store.root, "backups", backups.find((f) => f.startsWith("study-workspace-v2-"))), "utf8"));
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.decks[0].cards[0], legacyCard);
  const destination = await mkdtemp(join(tmpdir(), "study-workflow-restored-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const exported = await reloaded.call("export");
  const restored = new Store(destination);
  await restored.restore(exported);
  const state = await restored.read();
  assert.equal(state.workflowSessions[0].id, session.id);
  assert.equal(state.workflowTemplates[0].id, template.id);
  assert.deepEqual(state.decks[0].cards[0], legacyCard);
});

test("saved historical workflow scopes keep the same members through split and merge without widening either deck", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  let template;
  const cases = [
    { name: "whole", scope: [{ deckId: "d" }], cards: ["q", "r"], saved: ["held", "q", "r"] },
    { name: "topic", scope: [{ deckId: "d", topic: "缓存" }], cards: ["q"], saved: ["held", "q"] },
    { name: "card", scope: [{ deckId: "d", cardId: "q" }], cards: ["q"], saved: ["q"] },
    { name: "target", scope: [{ deckId: "target" }], cards: ["target-cache", "target-queue"], saved: ["target-cache", "target-queue"] },
    { name: "target-topic", scope: [{ deckId: "target", topic: "缓存" }], cards: ["target-cache"], saved: ["target-cache"] },
    { name: "unrelated", scope: [{ deckId: "other" }], cards: ["other-card"] },
  ];
  await service.store.update((s) => {
    template = saveWorkflow(s, { title: "练习", steps: [{ id: "p", kind: "practice", title: "练习", count: 10 }] });
    for (const item of cases) item.session = startSession(s, { templateId: template.id, topic: item.name, scope: item.scope, requestId: item.name });
  });
  const split = await service.call("deck.split", { id: "d", title: "拆出的缓存", topics: ["缓存"] });
  for (const item of cases) {
    const { session, resources } = await service.call("workflow.session.get", { id: item.session.id });
    assert.deepEqual(resources.readings.map((r) => r.cardId).sort(), item.cards, `${item.name} after split`);
    assert.equal(session.version, item.session.version + (item.scope[0].deckId === "d" ? 1 : 0));
  }
  await service.call("deck.merge", { sourceIds: [split.targetId], targetId: "target" });
  const restored = new StudyService(service.store.root);
  for (const item of cases) {
    const { session, resources } = await restored.call("workflow.session.get", { id: item.session.id });
    assert.deepEqual(resources.readings.map((r) => r.cardId).sort(), item.cards, `${item.name} after merge and reload`);
    assert.deepEqual(session.template, template);
    if (item.saved) assert.deepEqual(session.scope.map((r) => r.cardId).sort(), item.saved);
  }
});

test("historical Portal practice runs remain isolated from ordinary review, inbox navigation and card.current", async (t) => {
  const service = await setup(t);
  await seedOrganization(service);
  const started = await seedPortalSession(service, { scope: [{ deckId: "d" }], requestId: "inbox" });
  const ordinary = await service.call("review.start", { mode: "flashcard", deckId: "other" });
  await service.store.update((s) => {
    s.runs.find((r) => r.id === ordinary.id).entries[0].startedAt = 1;
    s.runs.find((r) => r.id === started.run.id).entries[0].startedAt = 2;
    notify(s, { kind: "followup", deckId: "d", cardId: "r", detail: "补充内容" });
  });
  assert.equal((await service.call("card.current")).card.id, "other-card");
  const letter = (await service.call("inbox")).items[0];
  const suppliedPortal = await service.call("inbox.open", { id: letter.id, runId: started.run.id });
  assert.notEqual(suppliedPortal.id, started.run.id);
  assert.equal(suppliedPortal.returnTo, null);

  await service.store.update((s) => { s.runs.find((r) => r.id === started.run.id).key = scopeKey("path", [{ deckId: "d" }]); });
  const pathRun = await service.call("review.start", { mode: "path", scope: [{ deckId: "d" }] });
  assert.notEqual(pathRun.id, started.run.id);

  await service.store.update((s) => { deleteSession(s, { id: started.session.id, version: started.session.version }); });
  assert.equal((await service.call("review.get", { runId: started.run.id })).closed, true);
});
