import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { lintCard } from "../lib/skeleton.js";
import { layoutClasses, layoutFocus, layoutSequence, clipToBox, fit } from "../ui/skeleton-diagrams.js";

const quote = "Cloud hosting downtime causes include failure domains, retry spikes, overload, noisy neighbours and bad dependencies.";
const base = { hint: "Think about causes.", misconception: "Assuming one cause.", citations: [{ sourceId: "s1", quote }] };
const looseQuiz = (id, topic, prompt) => ({
  ...base, id, kind: "multi", topic, objective: `objective ${id}`, prompt,
  answer: "Retry spikes; Overload", explanation: "见课件。",
  options: [
    { id: "a", text: "Retry spikes", correct: true, explanation: "Retry spikes" },
    { id: "b", text: "Overload", correct: true, explanation: "Overload" },
    { id: "c", text: "Server OS too old", correct: false, explanation: "Server OS too old" },
  ],
});
const goodCard = (id, topic) => ({
  ...base, id, kind: "quiz", topic, objective: `why ${id}`, prompt: "为什么大量客户端同时重试会让一次小故障变成全面过载？",
  answer: "Retry spikes", explanation: "失败后客户端同时重试，请求量在短时间内成倍放大，把本来只是局部的故障推成过载。",
  options: [
    { id: "a", text: "Retry spikes", correct: true, explanation: "重试把失败请求重复发送，放大了负载。" },
    { id: "b", text: "Noisy neighbor", correct: false, explanation: "这是同宿主其他租户抢占资源，不是客户端重试。" },
    { id: "c", text: "Bad dependency", correct: false, explanation: "这是下游依赖出错，起点不在客户端的重复请求。" },
  ],
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-skeleton-"));
  const service = new StudyService(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await service.call("source.add", { id: "s1", title: "HA", text: quote });
  await service.call("draft.save", { deck: { id: "d1", title: "HA 题库 A", cards: [
    looseQuiz("a1", "Cloud Downtime Causes", "以下哪些属于课件第18页 Cloud Hosting downtime causes?"),
    goodCard("a2", "Cloud Downtime Causes"),
  ] } });
  await service.call("draft.publish", { id: "d1" });
  await service.call("draft.save", { deck: { id: "d2", title: "HA 题库 B", cards: [
    looseQuiz("b1", "cloud downtime causes", "Which are listed on slide 18?"),
    goodCard("b2", "Redundancy"),
  ] } });
  await service.call("draft.publish", { id: "d2" });
  return service;
}

test("topics merge by name across decks and lint flags loose vocabulary cards", async (t) => {
  const service = await setup(t);
  const { topics } = await service.call("skeleton.topics");
  const downtime = topics.find((x) => x.key === "clouddowntimecauses");
  assert.equal(downtime.decks.length, 2, "same topic in two decks is one row");
  assert.equal(downtime.count, 3);
  assert.equal(topics[0].key, "clouddowntimecauses", "cross-deck topics sort first");

  const scope = downtime.decks.map((d) => ({ deckId: d.deckId, topic: d.topic }));
  const lint = await service.call("skeleton.lint", { scope });
  assert.equal(lint.total, 3);
  assert.equal(lint.decks, 2);
  const loose = lint.cards.find((c) => c.cardId === "a1");
  assert.ok(loose.issues.includes("echo-explanation"));
  assert.ok(loose.issues.includes("membership-stem"));
  assert.ok(loose.issues.includes("thin-explanation"));
  assert.ok(lint.cards.find((c) => c.cardId === "b1").issues.includes("membership-stem"), "English slide reference");
  assert.deepEqual(lint.cards.find((c) => c.cardId === "a2").issues, []);
  assert.equal(lint.flagged, 2);

  const context = await service.call("skeleton.context", { scope });
  assert.equal(context.cards.length, 3);
  assert.equal(context.cards[0].options.length, 3);
  assert.ok(context.evidence.length > 0, "cited evidence travels with the cards");
  assert.match(context.instructions, /UML class diagram/);
  assert.equal(lintCard({ kind: "cloze", prompt: "{{a}} 是什么", explanation: "" }, { linked: true }).includes("isolated-recall"), false);
});

test("a skeleton saves with UML attributes and sequences, validates refs, and summarizes in the snapshot", async (t) => {
  const service = await setup(t);
  const scope = [{ deckId: "d1", topic: "Cloud Downtime Causes" }, { deckId: "d2", topic: "cloud downtime causes" }];
  const skeleton = {
    title: "云托管停机原因",
    scope,
    overview: "从**外部依赖**到**自身过载**的一条链。",
    classNote: "上面是原因大类，下面是具体原因。",
    nodes: [
      { id: "cause", term: "Downtime cause", meaning: "让服务不可用的原因。", attributes: ["可来自内部或外部"] },
      { id: "retry", term: "Retry spikes", meaning: "失败后同时重试放大负载。", parent: "cause", attributes: ["放大效应", "常在故障后出现"], cards: [{ deckId: "d1", cardId: "a1" }, "b1", "a2"] },
      { id: "overload", term: "Overload", meaning: "请求超过容量。", parent: "cause", cards: ["a1"] },
    ],
    relations: [{ from: "retry", to: "overload", type: "causes", note: "重试堆积成过载" }],
    sequences: [{
      title: "重试风暴",
      explanation: "一次超时如何变成全面过载。",
      participants: [{ id: "client", label: "Clients" }, { id: "svc", label: "Service", node: "overload" }],
      steps: [
        { from: "client", to: "svc", message: "请求超时" },
        { from: "client", to: "svc", message: "同时重试", kind: "async", note: "流量翻倍" },
        { from: "svc", to: "client", message: "503", kind: "return" },
      ],
    }],
  };
  const saved = await service.call("skeleton.save", { skeleton });
  assert.equal(saved.nodes[1].cards.length, 3, "string and object card refs both resolve");
  assert.equal(saved.nodes[1].cards[1].deckId, "d2", "a bare cardId finds its deck");
  assert.equal(saved.sequences[0].participants[1].node, "overload");
  assert.equal(saved.sequences[0].steps[0].kind, "call", "kind defaults to call");

  const snap = await service.call("snapshot");
  assert.equal(snap.skeletons.length, 1);
  assert.deepEqual(snap.skeletons[0].cardIds.sort(), ["a1", "a2", "b1"]);
  assert.equal(snap.skeletons[0].sequences, 1);
  assert.equal(snap.skeletons[0].decks, 2);

  const updated = await service.call("skeleton.save", { skeleton: { ...skeleton, id: saved.id, title: "云托管停机原因 v2" } });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, saved.createdAt);
  assert.equal((await service.call("skeleton.list")).skeletons.length, 1);

  await assert.rejects(service.call("skeleton.save", { skeleton: { ...skeleton, nodes: [{ id: "x", term: "X", meaning: "m", cards: ["nope"] }] } }), /unknown card nope/);
  await assert.rejects(service.call("skeleton.save", { skeleton: { ...skeleton, relations: [{ from: "retry", to: "overload", type: "friends" }] } }), /type must be one of/);
  await assert.rejects(service.call("skeleton.save", { skeleton: { ...skeleton, sequences: [{ ...skeleton.sequences[0], steps: [{ from: "client", to: "ghost", message: "x" }] }] } }), /between participant ids/);
  await assert.rejects(service.call("skeleton.save", { skeleton: { ...skeleton, nodes: [{ id: "a", term: "A", meaning: "m", parent: "zzz" }] } }), /unknown parent/);

  await service.call("skeleton.delete", { id: saved.id });
  assert.deepEqual((await service.call("snapshot")).skeletons, []);
  const reopened = new StudyService(service.store.root);
  assert.deepEqual((await reopened.call("skeleton.list")).skeletons, []);
});

test("class layout puts parents above children and parts below wholes; sequence rows go down in order", () => {
  const skeleton = {
    nodes: [
      { id: "root", term: "Cause", meaning: "m", cards: [] },
      { id: "a", term: "Retry", meaning: "m", parent: "root", attributes: ["x", "y"], cards: [] },
      { id: "b", term: "Overload", meaning: "m", parent: "root", cards: [] },
      { id: "c", term: "Queue", meaning: "m", cards: [] },
    ],
    relations: [
      { from: "c", to: "b", type: "part-of" },
      { from: "a", to: "b", type: "causes" },
    ],
  };
  const layout = layoutClasses(skeleton);
  const box = Object.fromEntries(layout.boxes.map((b) => [b.id, b]));
  assert.ok(box.root.y < box.a.y && box.a.y === box.b.y, "siblings share a row under their parent");
  assert.ok(box.b.y < box.c.y, "a part sits below its whole");
  assert.deepEqual(layout.edges.map((e) => e.kind).sort(), ["composition", "dependency", "generalization", "generalization"]);
  assert.ok(layout.width >= box.b.x + box.b.w);

  const p = clipToBox({ x: 0, y: 0, w: 100, h: 40 }, 300, 20);
  assert.deepEqual(p, { x: 100, y: 20 }, "an edge leaves through the facing side");
  assert.equal(fit("知识骨架很长很长", 8), "知识骨…");

  const seq = layoutSequence({ participants: [{ id: "u" }, { id: "s" }], steps: [{ from: "u", to: "s", message: "a" }, { from: "s", to: "s", message: "b", note: "self" }, { from: "s", to: "u", message: "c" }] });
  assert.ok(seq.participants[0].x < seq.participants[1].x);
  assert.ok(seq.steps[0].y < seq.steps[1].y && seq.steps[1].y < seq.steps[2].y);
  assert.equal(seq.steps[1].self, true);
  assert.ok(seq.steps[2].y - seq.steps[1].y > seq.steps[1].y - seq.steps[0].y, "a note adds room below its step");
});

test("focus view keeps only direct neighbours, placed around the focused concept", () => {
  const skeleton = {
    nodes: [
      { id: "cause", term: "Cause", meaning: "m", cards: [] },
      { id: "internal", term: "Internal", meaning: "m", parent: "cause", cards: [] },
      { id: "retry", term: "Retry", meaning: "m", parent: "internal", cards: [] },
      { id: "overload", term: "Overload", meaning: "m", parent: "internal", cards: [] },
      { id: "queue", term: "Queue", meaning: "m", cards: [] },
      { id: "dep", term: "Dependency", meaning: "m", cards: [] },
      { id: "far", term: "Far away", meaning: "m", cards: [] },
    ],
    relations: [
      { from: "queue", to: "internal", type: "part-of" },
      { from: "dep", to: "internal", type: "causes" },
      { from: "internal", to: "far", type: "contrasts" },
      { from: "retry", to: "overload", type: "causes" },
      { from: "far", to: "cause", type: "related" },
    ],
  };
  const view = layoutFocus(skeleton, "internal");
  const at = Object.fromEntries(view.boxes.map((b) => [b.id, b]));
  assert.deepEqual(Object.keys(at).sort(), ["cause", "dep", "far", "internal", "overload", "queue", "retry"]);
  assert.equal(view.neighbours, 6);
  assert.ok(at.cause.y < at.internal.y, "generalization parent above");
  assert.ok(at.retry.y > at.internal.y && at.queue.y > at.internal.y, "subtypes and parts below");
  assert.ok(at.dep.x < at.internal.x, "incoming relation on the left");
  assert.ok(at.far.x > at.internal.x, "outgoing relation on the right");
  const kinds = view.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.ok(kinds.includes("retry>overload"), "edges between neighbours stay visible");
  assert.ok(kinds.includes("far>cause"));

  const leaf = layoutFocus(skeleton, "retry");
  assert.deepEqual(leaf.boxes.map((b) => b.id).sort(), ["internal", "overload", "retry"], "grandparents and unrelated concepts are hidden");
  assert.equal(layoutFocus(skeleton, "missing"), null);
});

test("topic groups sit above cards: replace, merge later topics, one group per topic, cards untouched", async (t) => {
  const service = await setup(t);
  const before = (await service.call("export")).decks.map((d) => d.cards.map((c) => [c.id, c.topic, c.review]));
  let { topics, groups } = await service.call("skeleton.topics", { compact: true, samples: 1 });
  assert.equal(groups.groups.length, 0);
  assert.deepEqual(groups.ungrouped.sort(), ["clouddowntimecauses", "redundancy"]);
  assert.deepEqual(topics.find((x) => x.key === "clouddowntimecauses").decks, ["HA 题库 A", "HA 题库 B"], "compact lists deck titles");
  assert.equal(topics[0].samples.length, 1);

  const saved = await service.call("topic.groups.save", { groups: [{ title: "可用性", description: "停机原因", topics: ["Cloud Downtime Causes"] }] });
  assert.deepEqual(saved.groups[0].topics, ["clouddowntimecauses"], "a topic name resolves to its merged key");
  assert.equal(saved.groups[0].count, 3);
  assert.equal(saved.groups[0].decks, 2);
  assert.deepEqual(saved.ungrouped, ["redundancy"]);

  const merged = await service.call("topic.groups.save", { mode: "merge", groups: [{ title: "可用性", topics: ["redundancy", "clouddowntimecauses"] }] });
  assert.equal(merged.groups.length, 1);
  assert.deepEqual(merged.groups[0].topics, ["clouddowntimecauses", "redundancy"]);
  assert.deepEqual(merged.ungrouped, []);

  await assert.rejects(service.call("topic.groups.save", { groups: [{ title: "A", topics: ["redundancy"] }, { title: "B", topics: ["redundancy"] }] }), /one group/);
  await assert.rejects(service.call("topic.groups.save", { groups: [{ title: "A", topics: ["no such topic"] }] }), /unknown topic/);

  ({ groups } = await new StudyService(service.store.root).call("skeleton.topics"));
  assert.equal(groups.groups[0].title, "可用性", "groups persist");
  const after = (await service.call("export")).decks.map((d) => d.cards.map((c) => [c.id, c.topic, c.review]));
  assert.deepEqual(after, before, "grouping never edits card topics or scheduling");
});

test("skeleton.patch extends a skeleton step by step, atomically, widening scope for newly linked cards", async (t) => {
  const service = await setup(t);
  const saved = await service.call("skeleton.save", { skeleton: {
    title: "停机原因", scope: [{ deckId: "d1", topic: "Cloud Downtime Causes" }],
    nodes: [
      { id: "cause", term: "Downtime cause", meaning: "让服务不可用的原因。" },
      { id: "retry", term: "Retry spikes", meaning: "同时重试放大负载。", parent: "cause", cards: ["a1"] },
    ],
    relations: [],
  } });
  assert.equal(saved.lastChange.summary, "对话生成了骨架");

  // Contrast Retry spikes with a concept the skeleton (and its scope) lacked; b2 lives in another deck/topic.
  const { skeleton, change } = await service.call("skeleton.patch", { id: saved.id, note: "对比冗余", ops: [
    { op: "node.add", node: { id: "redundancy", term: "Redundancy", meaning: "多副本消除单点故障。", parent: "cause", cards: ["b2"] } },
    { op: "node.update", id: "retry", set: { attributes: ["放大负载", "故障后出现"] } },
    { op: "relation.add", from: "retry", to: "redundancy", type: "contrasts", note: "一个放大故障，一个吸收故障" },
    { op: "node.cards", id: "retry", add: ["a2"] },
    { op: "sequence.add", sequence: { title: "重试风暴", participants: [{ id: "c", label: "Client" }, { id: "s", label: "Service", node: "retry" }], steps: [{ from: "c", to: "s", message: "重试" }] } },
  ] });
  assert.deepEqual(skeleton.nodes.map((n) => n.id), ["cause", "retry", "redundancy"]);
  assert.deepEqual(skeleton.nodes[1].attributes, ["放大负载", "故障后出现"]);
  assert.deepEqual(skeleton.nodes[1].cards.map((c) => c.cardId), ["a1", "a2"]);
  assert.ok(skeleton.scope.some((x) => x.cardId === "b2" && x.deckId === "d2"), "a card from another deck widens the scope");
  assert.ok(!skeleton.scope.some((x) => x.cardId === "a2"), "a card already covered by a topic scope is not added again");
  assert.deepEqual(change.addedNodes, ["redundancy"]);
  assert.deepEqual(change.nodes.sort(), ["redundancy", "retry"]);
  assert.deepEqual(change.relations, ["retry>redundancy>contrasts"]);
  assert.match(change.summary, /\+1 个概念.*改了 1 个概念.*\+1 条关系.*挂上 2 道题.*\+1 条时序.*对比冗余/);
  assert.match((await service.call("snapshot")).skeletons[0].lastChange.summary, /\+1 个概念/);

  // One bad op rejects the whole batch; the skeleton stays as it was.
  await assert.rejects(service.call("skeleton.patch", { id: saved.id, ops: [
    { op: "node.add", node: { id: "x", term: "X", meaning: "m" } },
    { op: "relation.add", from: "x", to: "ghost", type: "causes" },
  ] }), /existing node ids/);
  await assert.rejects(service.call("skeleton.patch", { id: saved.id, ops: [{ op: "node.add", node: { id: "retry", term: "R", meaning: "m" } }] }), /already exists/);
  await assert.rejects(service.call("skeleton.patch", { id: saved.id, ops: [{ op: "node.cards", id: "retry", add: ["nope"] }] }), /unknown card nope/);
  await assert.rejects(service.call("skeleton.patch", { id: saved.id, ops: [{ op: "fly" }] }), /unknown op/);
  assert.equal((await service.call("skeleton.get", { id: saved.id })).nodes.length, 3);

  // Removing a node drops its relations, child parent links and sequence refs.
  const removed = (await service.call("skeleton.patch", { id: saved.id, ops: [{ op: "node.remove", id: "retry" }] })).skeleton;
  assert.deepEqual(removed.relations, []);
  assert.equal(removed.sequences[0].participants[1].node, undefined);
  assert.match(removed.lastChange.summary, /删了 1 个概念/);
});
