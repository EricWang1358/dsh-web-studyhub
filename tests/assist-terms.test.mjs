import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  ASSIST_MODES,
  normalizeAssistRequest,
  createAssistService,
} from "../lib/assist.js";
import { assistDigest, assistInput, assistInstruction } from "../lib/assist-content.js";
import { localizeAppMessage } from "../lib/application-messages.js";
import { TERMS_INSTRUCTION, validateTermsReply } from "../lib/contexts/study/terms-ladder.js";
import { createHostHandler } from "../lib/host.js";
import { cardIndex, orderByPrerequisites, planPath } from "../lib/mastery.js";
import { StudyService } from "../lib/service.js";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { ended } from "./helpers/assist-library.mjs";
import { privateRoot } from "./helpers/model-family-baseline.mjs";
import { SWITCH_MODES, switchOptions } from "./helpers/runtime-switch.mjs";

const EVIDENCE =
  "Ingress filtering inspects incoming packet source IP prefixes at the edge router and drops packets from unexpected prefixes.";

const PARENT_CARD = {
  id: "card-main",
  kind: "flashcard",
  topic: "IP Spoofing",
  objective: "Mitigate source-address spoofing",
  prompt: "如何缓解 IP 欺骗？",
  answer: "在边缘路由器做入口过滤（BCP38），必要时配合出口过滤。",
  hint: "从报文离开或进入网络边界时的源地址检查入手。",
  explanation: "网络边界知道下游合法地址前缀，因此能在第一时间丢弃伪造源地址的报文。",
  misconception: "以为只有目的路由器能发现源地址造假。",
  citations: [{ sourceId: "src-1", quote: EVIDENCE }],
};

function makeStep({
  term,
  alt,
  layer = 1,
  needs = [],
  prompt = `用正式的说法讲一遍，「${term}」解决什么问题？`,
  formal = `${term}${alt ? `（${alt}）` : ""}是用于检验边界源地址前缀的正式规则。`,
  explanation,
  note,
  citations = [{ sourceId: "src-1", quote: EVIDENCE }],
}) {
  return {
    term,
    ...(alt ? { alt } : {}),
    layer,
    needs,
    problem: `需要解释为什么缺少「${term}」时边界无法识别伪造报文。`,
    plain: `在大白话里，「${term}」就像门口只放行本小区住户寄出的信。`,
    formal,
    example: `当接入口只分了 10.1.0.0/16 前缀，源地址写成别的前缀就会被「${term}」丢弃。`,
    card: {
      kind: "flashcard",
      topic: `${term} 检查`,
      objective: `掌握「${term}」的正式定义`,
      prompt,
      answer: `边界检查源地址前缀并在不匹配时丢弃。`,
      hint: `想想「${term}」检查的是哪一段字段。`,
      ...(explanation !== undefined ? { explanation } : {}),
      misconception: `把「${term}」当成检查目的地址。`,
      citations,
    },
    ...(note !== undefined ? { note } : {}),
  };
}

async function setupTermsFixture(t, complete, mode = "legacy", seedExtra = undefined) {
  const root = await privateRoot(t, `assist-terms-${mode}-`);
  const service = new StudyService(root, {
    complete,
    ...switchOptions(mode, { complete, paths: ["assist"] }),
  });
  const assist = createAssistService();
  t.after(async () => {
    assist.dispose();
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await service.store.update((state) => {
    state.sources.push({ id: "src-1", title: "Routing Security", text: EVIDENCE });
    state.decks.push({
      id: "deck-1",
      title: "Network Security",
      course: "Networks",
      cards: [structuredClone(PARENT_CARD)],
    });
    seedExtra?.(state);
  });
  const ctx = { sessions: { get: () => ({ header: { cwd: root } }) }, get: () => undefined };
  return { root, service, assist, ctx };
}

test("normalizeAssistRequest enforces strict terms validation and English localization", () => {
  assert.deepEqual(ASSIST_MODES.terms, { label: "补齐生词", verb: "补词" });
  assert.throws(() => normalizeAssistRequest("terms", "", [], {}), /请先标出 1–6/);
  assert.throws(() => normalizeAssistRequest("terms", "", [], { terms: [] }), /请先标出 1–6/);
  assert.throws(
    () => normalizeAssistRequest("terms", "", [], { terms: ["a", "b", "c", "d", "e", "f", "g"] }),
    /最多补齐 6/,
  );
  assert.throws(() => normalizeAssistRequest("terms", "", [], { terms: ["   "] }), /不能为空/);
  assert.throws(() => normalizeAssistRequest("terms", "", [], { terms: ["line1\nline2"] }), /换行/);
  assert.throws(() => normalizeAssistRequest("terms", "", [], { terms: ["x".repeat(61)] }), /不能超过 60/);
  assert.throws(() => normalizeAssistRequest("terms", "", ["plain"], { terms: ["BCP38"] }), /不支持讲解选项/);

  const normalized = normalizeAssistRequest("terms", "", [], {
    terms: ["  ingress   filtering  ", "Ingress Filtering", "BCP38"],
  });
  assert.deepEqual(normalized, {
    question: "",
    choices: [],
    requests: [],
    terms: ["ingress filtering", "BCP38"],
  });

  assert.equal(localizeAppMessage("补齐生词", "en"), "Fill in terms");
  assert.equal(localizeAppMessage("一次最多补齐 6 个词", "en"), "Fill in at most 6 terms at once");
  assert.equal(
    localizeAppMessage("补了 3 个词，检查题已排到这道题前面", "en"),
    "Filled in 3 terms; check questions are queued before this card",
  );
  assert.equal(
    localizeAppMessage("第 1 层台阶只能是学生标出的词；为了讲清楚而加的词请标 layer 2", "en"),
    "Layer-1 steps must be requested terms; mark added foundational terms as layer 2",
  );
  assert.equal(
    localizeAppMessage("第 2 层台阶不能再依赖别的词（needs 须为空）；还需要更底层的词请写进 deeper", "en"),
    "Layer-2 steps cannot depend on other steps (needs must be empty); list still-missing prerequisites in deeper",
  );
});

test("terms mode happy path: 3 marked terms create 3 cards, 3 prereq links, 1 ladder followup, and notify cleanly in both legacy and runtime", async (t) => {
  for (const switchMode of SWITCH_MODES) {
    let seenSystem = "";
    let seenInput = null;
    const f = await setupTermsFixture(t, async (system, payload) => {
      seenSystem = system;
      seenInput = JSON.parse(payload);
      return JSON.stringify({
        ladder: [
          makeStep({ term: "入口过滤", alt: "ingress filtering", layer: 1, needs: [] }),
          makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
          makeStep({ term: "出口过滤", alt: "egress filtering", layer: 1, needs: ["BCP38"] }),
        ],
      });
    }, switchMode);

    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      text: "",
      terms: ["入口过滤", "BCP38", "出口过滤"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    const [task] = f.assist.assistView(f.root).tasks;
    assert.equal(task.status, "done", `${switchMode}: ${task.message}`);
    if (switchMode === "legacy") assert.equal(task.outcome, "linked");
    assert.deepEqual(task.terms, ["入口过滤", "BCP38", "出口过滤"]);
    assert.equal(task.text, "入口过滤、BCP38、出口过滤");
    assert.match(task.message, /补了 3 个词，检查题已排到这道题前面/);
    assert.doesNotMatch(task.message, /进信箱/);

    assert.match(seenSystem, /bottom-up concept ladder/);
    assert.match(seenSystem, /do NOT write `card\.explanation`/);
    assert.doesNotMatch(seenSystem, /"explanation":/);
    assert.deepEqual(seenInput.terms, { unknown: ["入口过滤", "BCP38", "出口过滤"], known: [] });

    const state = await f.service.store.read();
    const deck = state.decks[0];
    assert.equal(deck.cards.length, 4, `${switchMode}: 3 check cards added`);
    const parent = deck.cards[0];
    assert.equal(parent.requires.length, 3, `${switchMode}: 3 prerequisite links`);
    assert.match(deck.cards[1].explanation, /### 问题/);
    assert.match(deck.cards[1].explanation, /### 大白话/);
    assert.match(deck.cards[1].explanation, /### 正式说法/);
    assert.match(deck.cards[1].explanation, /### 例子/);

    assert.equal(parent.followups.length, 1);
    const fu = parent.followups[0];
    assert.equal(fu.kind, "terms");
    assert.deepEqual(fu.terms, ["入口过滤", "BCP38", "出口过滤"]);
    assert.match(fu.answer, /\*\*入口过滤\*\*（ingress filtering）/);
    assert.match(fu.answer, /问题：/);
    assert.match(fu.answer, /大白话：/);
    assert.match(fu.answer, /正式说法：/);
    assert.match(fu.answer, /例子：/);
    assert.match(fu.answer, /检查题：用正式的说法讲一遍/);

    assert.equal(state.inbox.length, 1, `${switchMode}: one summary letter in inbox`);
    const [followupNotif] = state.inbox;
    assert.equal(followupNotif.kind, "followup");
    assert.equal(followupNotif.cardId, "card-main");
    assert.equal(followupNotif.read, false);
    assert.equal(followupNotif.count, undefined);
    assert.equal(followupNotif.detail, "补了 3 个词，检查题已排到这道题前面");
    assert.doesNotMatch(followupNotif.detail, /进信箱/);
  }
});

test("layer 2 foundations link in chain order and original card never links layer 2 directly", async (t) => {
  const f = await setupTermsFixture(t, async () =>
    JSON.stringify({
      ladder: [
        makeStep({ term: "地址前缀", alt: "prefix", layer: 2, needs: [] }),
        makeStep({ term: "入口过滤", layer: 2, needs: [] }),
        makeStep({ term: "BCP38", layer: 1, needs: ["地址前缀", "入口过滤"] }),
      ],
    }),
  );

  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(f.assist, f.root);

  const state = await f.service.store.read();
  const [parent, prefixCard, ingressCard, bcp38Card] = state.decks[0].cards;
  assert.deepEqual(parent.requires, [{ deckId: "deck-1", cardId: bcp38Card.id }]);
  assert.deepEqual(bcp38Card.requires, [
    { deckId: "deck-1", cardId: prefixCard.id },
    { deckId: "deck-1", cardId: ingressCard.id },
  ]);
  assert.equal(prefixCard.requires, undefined);
  assert.equal(ingressCard.requires, undefined);

  // Course term list attaches only layer-1 terms, never layer-2 added foundations.
  const courseTerms = await f.service.call("course.terms.get", { course: "Networks" });
  assert.deepEqual(courseTerms.items.map((item) => item.term), ["BCP38"]);

  // orderByPrerequisites places layer 2 -> layer 1 -> parent card in daily practice ordering.
  const index = cardIndex(state.decks, () => null);
  const ordered = orderByPrerequisites([{ deckId: "deck-1", card: parent, level: "new" }], index, true);
  assert.deepEqual(
    ordered.map((entry) => entry.card.id),
    [prefixCard.id, ingressCard.id, bcp38Card.id, parent.id],
  );
  const planned = planPath(state.decks, () => null, { limit: 10 });
  assert.deepEqual(
    planned.entries.map((entry) => entry.card.id),
    [prefixCard.id, ingressCard.id, bcp38Card.id, parent.id],
  );
});

test("out-of-order needs triggers one repair retry and failing again keeps the bank untouched", async (t) => {
  // 1. Repaired on retry -> commits cleanly.
  let calls = 0;
  const ok = await setupTermsFixture(t, async (_sys, payload) => {
    calls += 1;
    if (calls === 1) {
      return JSON.stringify({
        ladder: [
          makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
          makeStep({ term: "入口过滤", layer: 1, needs: [] }),
        ],
      });
    }
    assert.match(payload, /REFUSED_REPLY:/);
    assert.match(payload, /前面已经讲过的词条/);
    return JSON.stringify({
      ladder: [
        makeStep({ term: "入口过滤", layer: 1, needs: [] }),
        makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
      ],
    });
  });

  await ok.assist.startAssist(ok.ctx, {
    root: ok.root,
    service: ok.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤", "BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(ok.assist, ok.root);
  assert.equal(calls, 2);
  assert.equal(ok.assist.assistView(ok.root).tasks[0].status, "done");
  assert.equal(ok.assist.assistView(ok.root).tasks[0].repaired, true);
  assert.equal((await ok.service.store.read()).decks[0].cards.length, 3);

  // 2. Retry still broken -> fails and mutates nothing.
  let brokenCalls = 0;
  const bad = await setupTermsFixture(t, async () => {
    brokenCalls += 1;
    return JSON.stringify({
      ladder: [
        makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
        makeStep({ term: "入口过滤", layer: 1, needs: [] }),
      ],
    });
  });
  await bad.assist.startAssist(bad.ctx, {
    root: bad.root,
    service: bad.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤", "BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(bad.assist, bad.root);
  assert.equal(brokenCalls, 2);
  assert.equal(bad.assist.assistView(bad.root).tasks[0].status, "failed");
  const badState = await bad.service.store.read();
  assert.equal(badState.decks[0].cards.length, 1);
  assert.equal(badState.decks[0].cards[0].requires, undefined);
  assert.equal(badState.decks[0].cards[0].followups, undefined);
  assert.equal(badState.inbox.length, 0);
});

test("unrequested term marked layer 1 triggers one repair retry and failing again keeps decks, courses and inbox untouched", async (t) => {
  // 1. Repaired on retry -> commits cleanly without attaching unrequested layer-2 terms.
  let calls = 0;
  const ok = await setupTermsFixture(t, async (_sys, payload) => {
    calls += 1;
    if (calls === 1) {
      return JSON.stringify({
        ladder: [
          makeStep({ term: "地址前缀", layer: 1, needs: [] }),
          makeStep({ term: "路由器", layer: 1, needs: ["地址前缀"] }),
          makeStep({ term: "入口过滤", layer: 1, needs: ["路由器"] }),
        ],
      });
    }
    assert.match(payload, /REFUSED_REPLY:/);
    assert.match(payload, /第 1 层台阶只能是学生标出的词/);
    return JSON.stringify({
      ladder: [
        makeStep({ term: "地址前缀", layer: 2, needs: [] }),
        makeStep({ term: "入口过滤", layer: 1, needs: ["地址前缀"] }),
      ],
      deeper: ["路由器"],
    });
  });

  await ok.assist.startAssist(ok.ctx, {
    root: ok.root,
    service: ok.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(ok.assist, ok.root);
  assert.equal(calls, 2);
  const [okTask] = ok.assist.assistView(ok.root).tasks;
  assert.equal(okTask.status, "done");
  assert.equal(okTask.repaired, true);
  const okState = await ok.service.store.read();
  assert.equal(okState.decks[0].cards.length, 3);
  assert.equal(okState.decks[0].cards[0].requires.length, 1);
  const okTerms = await ok.service.call("course.terms.get", { course: "Networks" });
  assert.deepEqual(okTerms.items.map((item) => item.term), ["入口过滤"]);

  // 2. Case-insensitive requested term at layer 1 succeeds without retry.
  let ciCalls = 0;
  const ci = await setupTermsFixture(t, async () => {
    ciCalls += 1;
    return JSON.stringify({
      ladder: [makeStep({ term: "BCP38", layer: 1, needs: [] })],
    });
  });
  await ci.assist.startAssist(ci.ctx, {
    root: ci.root,
    service: ci.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["bcp38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(ci.assist, ci.root);
  assert.equal(ciCalls, 1);
  assert.equal(ci.assist.assistView(ci.root).tasks[0].status, "done");

  // 3. Retry still marks unrequested term as layer 1 -> fails and leaves decks, courses and inbox untouched.
  let brokenCalls = 0;
  const bad = await setupTermsFixture(t, async () => {
    brokenCalls += 1;
    return JSON.stringify({
      ladder: [
        makeStep({ term: "地址前缀", layer: 1, needs: [] }),
        makeStep({ term: "路由器", layer: 1, needs: ["地址前缀"] }),
        makeStep({ term: "入口过滤", layer: 1, needs: ["路由器"] }),
      ],
    });
  });
  await bad.service.call("course.save", {
    name: "Networks",
    terms: { version: 1, items: [{ term: "入口过滤", at: "2026-11-18T10:00:00.000Z" }] },
  });
  const beforeCourses = structuredClone((await bad.service.store.read()).courses);

  await bad.assist.startAssist(bad.ctx, {
    root: bad.root,
    service: bad.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(bad.assist, bad.root);
  assert.equal(brokenCalls, 2);
  const [badTask] = bad.assist.assistView(bad.root).tasks;
  assert.equal(badTask.status, "failed");
  assert.equal(badTask.repaired, true);
  assert.match(badTask.message, /第 1 层台阶只能是学生标出的词/);
  const badState = await bad.service.store.read();
  assert.equal(badState.decks[0].cards.length, 1);
  assert.equal(badState.decks[0].cards[0].requires, undefined);
  assert.equal(badState.decks[0].cards[0].followups, undefined);
  assert.deepEqual(badState.courses, beforeCourses);
  assert.equal(badState.inbox.length, 0);
});

test("layer 2 step with non-empty needs triggers one repair retry and failing again keeps decks, courses and inbox untouched", async (t) => {
  // 1. Repaired on retry -> moves deeper dependency into `deeper` and clears layer-2 needs.
  let calls = 0;
  const ok = await setupTermsFixture(t, async (_sys, payload) => {
    calls += 1;
    if (calls === 1) {
      return JSON.stringify({
        ladder: [
          makeStep({ term: "地址前缀", layer: 2, needs: [] }),
          makeStep({ term: "入口过滤", layer: 2, needs: ["地址前缀"] }),
          makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
        ],
      });
    }
    assert.match(payload, /REFUSED_REPLY:/);
    assert.match(payload, /第 2 层台阶不能再依赖别的词/);
    return JSON.stringify({
      ladder: [
        makeStep({ term: "入口过滤", layer: 2, needs: [] }),
        makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
      ],
      deeper: ["地址前缀"],
    });
  });

  await ok.assist.startAssist(ok.ctx, {
    root: ok.root,
    service: ok.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(ok.assist, ok.root);
  assert.equal(calls, 2);
  const [okTask] = ok.assist.assistView(ok.root).tasks;
  assert.equal(okTask.status, "done");
  assert.equal(okTask.repaired, true);
  const okState = await ok.service.store.read();
  assert.equal(okState.decks[0].cards.length, 3);
  assert.equal(okState.decks[0].cards[0].requires.length, 1);
  assert.deepEqual(okState.decks[0].cards[0].followups[0].deeper, ["地址前缀"]);

  // 2. Retry still chains layer 2 -> fails cleanly and leaves decks, courses and inbox untouched.
  let brokenCalls = 0;
  const bad = await setupTermsFixture(t, async () => {
    brokenCalls += 1;
    return JSON.stringify({
      ladder: [
        makeStep({ term: "地址前缀", layer: 2, needs: [] }),
        makeStep({ term: "入口过滤", layer: 2, needs: ["地址前缀"] }),
        makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
      ],
    });
  });
  await bad.service.call("course.save", {
    name: "Networks",
    terms: { version: 1, items: [{ term: "BCP38", at: "2026-11-18T10:00:00.000Z" }] },
  });
  const beforeCourses = structuredClone((await bad.service.store.read()).courses);

  await bad.assist.startAssist(bad.ctx, {
    root: bad.root,
    service: bad.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(bad.assist, bad.root);
  assert.equal(brokenCalls, 2);
  const [badTask] = bad.assist.assistView(bad.root).tasks;
  assert.equal(badTask.status, "failed");
  assert.equal(badTask.repaired, true);
  assert.match(badTask.message, /第 2 层台阶不能再依赖别的词/);
  const badState = await bad.service.store.read();
  assert.equal(badState.decks[0].cards.length, 1);
  assert.equal(badState.decks[0].cards[0].requires, undefined);
  assert.equal(badState.decks[0].cards[0].followups, undefined);
  assert.deepEqual(badState.courses, beforeCourses);
  assert.equal(badState.inbox.length, 0);
});

test("skipped and deeper metadata are saved, and all-skipped creates 0 cards cleanly", async (t) => {
  const f = await setupTermsFixture(t, async () =>
    JSON.stringify({
      ladder: [
        makeStep({
          term: "入口过滤",
          layer: 1,
          needs: [],
          note: "补充知识（非原文）：入口过滤是在下游接入接口验证源地址前缀是否在分配前缀之内，否则直接丢弃伪造报文的基本策略。",
          citations: [{ sourceId: "NOTE", quote: "入口过滤是在下游接入接口验证源地址前缀" }],
        }),
      ],
      deeper: ["CIDR", "AS"],
      skipped: [{ term: "或者直接丢掉", reason: "这是半句话，不是具体术语" }],
    }),
  );

  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤", "或者直接丢掉"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(f.assist, f.root);

  const state = await f.service.store.read();
  assert.equal(state.decks[0].cards.length, 2);
  const fu = state.decks[0].cards[0].followups[0];
  assert.deepEqual(fu.deeper, ["CIDR", "AS"]);
  assert.match(fu.answer, /没有补：或者直接丢掉（这是半句话，不是具体术语）/);

  // Empty ladder AND empty skipped must fail.
  const empty = await setupTermsFixture(t, async () => JSON.stringify({ ladder: [], skipped: [] }));
  await empty.assist.startAssist(empty.ctx, {
    root: empty.root,
    service: empty.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(empty.assist, empty.root);
  assert.equal(empty.assist.assistView(empty.root).tasks[0].status, "failed");

  // All skipped with empty ladder is valid and adds 0 cards + 1 explanatory followup.
  const allSkipped = await setupTermsFixture(t, async () =>
    JSON.stringify({
      ladder: [],
      skipped: [{ term: "或者直接丢掉", reason: "不是需要讲解的术语" }],
    }),
  );
  await allSkipped.assist.startAssist(allSkipped.ctx, {
    root: allSkipped.root,
    service: allSkipped.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["或者直接丢掉"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(allSkipped.assist, allSkipped.root);
  assert.equal(allSkipped.assist.assistView(allSkipped.root).tasks[0].status, "done");
  assert.match(allSkipped.assist.assistView(allSkipped.root).tasks[0].message, /已跳过 1 个/);
  const skippedState = await allSkipped.service.store.read();
  assert.equal(skippedState.decks[0].cards.length, 1);
  assert.equal(skippedState.decks[0].cards[0].followups.length, 1);
  assert.match(skippedState.decks[0].cards[0].followups[0].answer, /没有补：或者直接丢掉/);
});

test("12-prerequisite limit preserves created check cards and reports unlinked", async (t) => {
  const fillers = Array.from({ length: 12 }, (_, i) => ({
    ...PARENT_CARD,
    id: `pre-${i}`,
    prompt: `前置填充题 ${i + 1}`,
    objective: `前置 ${i + 1}`,
  }));
  const f = await setupTermsFixture(
    t,
    async () =>
      JSON.stringify({
        ladder: [makeStep({ term: "BCP38", layer: 1, needs: [] })],
      }),
    "legacy",
    (state) => {
      state.decks[0].cards.push(...fillers);
      state.decks[0].cards[0].requires = fillers.map((c) => ({ deckId: "deck-1", cardId: c.id }));
    },
  );

  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: { ...PARENT_CARD, requires: fillers.map((c) => ({ deckId: "deck-1", cardId: c.id })) },
    deckTitle: "Network Security",
  });
  await ended(f.assist, f.root);

  const [task] = f.assist.assistView(f.root).tasks;
  assert.equal(task.status, "done");
  assert.equal(task.outcome, "unlinked");
  const state = await f.service.store.read();
  assert.equal(state.decks[0].cards.length, 14, "created check card kept in deck");
  assert.equal(state.decks[0].cards[0].requires.length, 12);
  assert.equal(state.decks[0].cards[0].followups.length, 1);
});

test("card edited mid-flight rejects commit via assistDigest", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setupTermsFixture(t, async () => {
    await gate;
    return JSON.stringify({
      ladder: [makeStep({ term: "BCP38", layer: 1, needs: [] })],
    });
  });

  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });

  await f.service.call("card.update", {
    deckId: "deck-1",
    cardId: "card-main",
    patch: { answer: "更新后的答案：通过源地址前缀过滤缓解。" },
    reason: "澄清表述",
  });
  release();
  await ended(f.assist, f.root);

  const [task] = f.assist.assistView(f.root).tasks;
  assert.equal(task.status, "failed");
  assert.match(task.message, /题目已更新/);
  const state = await f.service.store.read();
  assert.equal(state.decks[0].cards.length, 1);
  assert.equal(state.decks[0].cards[0].followups, undefined);
  assert.notEqual(assistDigest(state.decks[0].cards[0]), assistDigest(PARENT_CARD));
});

test("reuses existing check card with matching prompt and preserves multiple terms followups on the same card", async (t) => {
  const existingPrompt = "用正式的说法讲一遍，「BCP38」解决什么问题？";
  let runCount = 0;
  const f = await setupTermsFixture(
    t,
    async () => {
      runCount += 1;
      return JSON.stringify({
        ladder: [
          makeStep({
            term: runCount === 1 ? "BCP38" : "出口过滤",
            layer: 1,
            needs: [],
            prompt:
              runCount === 1
                ? existingPrompt
                : "用正式的说法讲一遍，「出口过滤」解决什么问题？",
          }),
        ],
      });
    },
    "legacy",
    (state) => {
      state.decks[0].cards.push({
        id: "existing-bcp38",
        kind: "flashcard",
        topic: "BCP38",
        objective: "Existing check card",
        prompt: existingPrompt,
        answer: "检查进入接口的源地址前缀。",
        hint: "检查前缀。",
        explanation: "已有解析。",
        misconception: "常见误区。",
        citations: [{ sourceId: "src-1", quote: EVIDENCE }],
      });
    },
  );

  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(f.assist, f.root);

  let state = await f.service.store.read();
  assert.equal(state.decks[0].cards.length, 2, "reused existing-bcp38 without creating duplicate");
  assert.deepEqual(state.decks[0].cards[0].requires, [{ deckId: "deck-1", cardId: "existing-bcp38" }]);

  // Running terms again with the exact same question/terms adds a second followup rather than deduping away.
  runCount = 0;
  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(f.assist, f.root);

  state = await f.service.store.read();
  assert.equal(state.decks[0].cards[0].followups.length, 2);
  assert.equal(state.decks[0].cards[0].followups[0].kind, "terms");
  assert.equal(state.decks[0].cards[0].followups[1].kind, "terms");
});

test("host assist.start forwards terms, never reuses ask child sessions, and fake-model satisfies validation", async (t) => {
  const fake = createFakeModel();
  const f = await setupTermsFixture(t, fake);
  let childStarts = 0;
  let childFollowups = 0;
  const hostCtx = {
    sessions: { get: () => ({ header: { cwd: f.root } }) },
    get: (key) =>
      key === "agents"
        ? { get: () => ({ id: "parent" }) }
        : key === "subagents"
          ? {
              getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
              start: async (_kind, req) => {
                childStarts += 1;
                const modePrompt = req.prompt[0].text;
                const isTerms = modePrompt.includes('"mode":"terms"');
                const reply = await fake(
                  assistInstruction(isTerms ? "terms" : "ask", false),
                  JSON.stringify(
                    assistInput(await f.service.store.read(), { deckId: "deck-1", cardId: "card-main" }, {
                      mode: isTerms ? "terms" : "ask",
                      request: isTerms
                        ? { question: "", choices: [], requests: [], terms: ["入口过滤", "BCP38"] }
                        : { question: "解释一下", choices: [], requests: [] },
                    }),
                  ),
                );
                return {
                  id: `child-${childStarts}`,
                  localAgent: {
                    followup() {
                      childFollowups += 1;
                    },
                  },
                  result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: reply }] }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
  };
  const handle = createHostHandler(hostCtx, { libraryRoot: f.root }, () => fake, { assist: f.assist });

  // 1. Start ask child first to populate ask child pool.
  const askRes = await handle("call", {
    sessionId: "parent",
    action: "assist.start",
    args: { deckId: "deck-1", cardId: "card-main", mode: "ask", text: "解释一下", helpChoices: [] },
  });
  assert.equal(askRes.ok, true);
  await ended(f.assist, f.root);

  // 2. Start terms via host handler: must NOT reuse the ask child session.
  const termsRes = await handle("call", {
    sessionId: "parent",
    action: "assist.start",
    args: { deckId: "deck-1", cardId: "card-main", mode: "terms", terms: ["入口过滤", "BCP38"], uiLanguage: "zh" },
  });
  assert.equal(termsRes.ok, true);
  assert.equal(termsRes.value.mode, "terms");
  assert.deepEqual(termsRes.value.terms, ["入口过滤", "BCP38"]);
  await ended(f.assist, f.root);

  assert.equal(childStarts, 2, "terms starts its own bounded call and never reuses ask child");
  assert.equal(childFollowups, 0);

  const tasks = f.assist.assistView(f.root).tasks;
  assert.equal(tasks[1].status, "done", tasks[1].message);
  const state = await f.service.store.read();
  const parent = state.decks[0].cards[0];
  // fake-model includes 1 layer-2 card ("前置前提") + 2 layer-1 cards; parent only links the 2 layer-1 cards.
  assert.equal(state.decks[0].cards.length, 4);
  assert.equal(parent.requires.length, 2);

  // Direct fake-model check in English + REFUSED_REPLY repair check.
  const enReply = JSON.parse(
    await fake(
      `${assistInstruction("terms", false)}\n\nApplication language preference: English`,
      JSON.stringify({ mode: "terms", terms: { unknown: ["linearizability", "BCP38"], known: [] }, card: PARENT_CARD, sources: [] }) +
        "\n\nREFUSED_REPLY:\n{}\n\nREASON:\nmissing ladder",
    ),
  );
  assert.equal(enReply.ladder.length, 3);
  assert.equal(enReply.ladder[0].layer, 2);
  assert.deepEqual(enReply.ladder[0].needs, []);
  assert.equal(enReply.ladder[1].layer, 1);
  assert.equal(enReply.ladder[2].layer, 1);
  assert.deepEqual(enReply.ladder[1].needs, [enReply.ladder[0].term]);
  assert.deepEqual(enReply.ladder[2].needs, ["linearizability"]);
  assert.ok(enReply.ladder.every((step) => step.note && step.card.citations[0].sourceId === "NOTE"));
  assert.ok(enReply.ladder.every((step) => !Object.hasOwn(step.card, "explanation")));
});

test("step cards without card.explanation pass validation and build 4-section explanation, while extra card.explanation stays accepted (#1219)", async (t) => {
  assert.match(TERMS_INSTRUCTION, /do NOT write `card\.explanation`/);
  assert.doesNotMatch(TERMS_INSTRUCTION, /"explanation":/);

  const stepWithout = makeStep({ term: "入口过滤", layer: 1, needs: [] });
  const stepWith = makeStep({ term: "入口过滤", layer: 1, needs: [], explanation: "模型额外写了说明" });
  const stepWithEmpty = makeStep({ term: "入口过滤", layer: 1, needs: [], explanation: "" });
  assert.equal(Object.hasOwn(stepWithout.card, "explanation"), false);

  const withoutExpl = validateTermsReply({ ladder: [stepWithout] }, ["入口过滤"], PARENT_CARD.prompt);
  const withExpl = validateTermsReply({ ladder: [stepWith] }, ["入口过滤"], PARENT_CARD.prompt);
  const withEmptyExpl = validateTermsReply({ ladder: [stepWithEmpty] }, ["入口过滤"], PARENT_CARD.prompt);
  assert.equal(Object.hasOwn(withoutExpl.ladder[0].card, "explanation"), false);
  assert.deepEqual(withExpl, withoutExpl);
  assert.deepEqual(withEmptyExpl, withoutExpl);

  const missingMisconception = makeStep({ term: "入口过滤", layer: 1, needs: [] });
  delete missingMisconception.card.misconception;
  assert.throws(
    () => validateTermsReply({ ladder: [missingMisconception] }, ["入口过滤"], PARENT_CARD.prompt),
    /台阶检查题缺少 misconception/,
  );

  const extraField = makeStep({ term: "入口过滤", layer: 1, needs: [] });
  extraField.card.unknownField = "bad";
  assert.throws(
    () => validateTermsReply({ ladder: [extraField] }, ["入口过滤"], PARENT_CARD.prompt),
    /台阶检查题包含不支持的字段/,
  );

  // Full assist flow: both replies without and with card.explanation commit identical 4-section check cards.
  const committedExplanations = [];
  for (const extraExplanation of [undefined, "模型多余输出的解释"]) {
    const f = await setupTermsFixture(t, async () =>
      JSON.stringify({
        ladder: [makeStep({ term: "入口过滤", layer: 1, needs: [], explanation: extraExplanation })],
      }),
    );
    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["入口过滤"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    const [task] = f.assist.assistView(f.root).tasks;
    assert.equal(task.status, "done", task.message);
    const state = await f.service.store.read();
    assert.equal(state.decks[0].cards.length, 2);
    const createdCard = state.decks[0].cards[1];
    assert.match(createdCard.explanation, /### 问题/);
    assert.match(createdCard.explanation, /### 大白话/);
    assert.match(createdCard.explanation, /### 正式说法/);
    assert.match(createdCard.explanation, /### 例子/);
    assert.doesNotMatch(createdCard.explanation, /模型多余输出的解释/);
    committedExplanations.push(createdCard.explanation);
  }
  assert.equal(committedExplanations[1], committedExplanations[0]);
});

test("5-step terms ladder (3 layer-1 + 2 layer-2) emits only 1 unmerged followup letter on the original card (#1218)", async (t) => {
  for (const switchMode of SWITCH_MODES) {
    const f = await setupTermsFixture(
      t,
      async () =>
        JSON.stringify({
          ladder: [
            makeStep({ term: "源地址", layer: 2, needs: [] }),
            makeStep({ term: "地址前缀", layer: 2, needs: [] }),
            makeStep({ term: "入口过滤", layer: 1, needs: ["源地址", "地址前缀"] }),
            makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
            makeStep({ term: "出口过滤", layer: 1, needs: ["地址前缀", "入口过滤"] }),
          ],
        }),
      switchMode,
    );

    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["入口过滤", "BCP38", "出口过滤"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    const [task] = f.assist.assistView(f.root).tasks;
    assert.equal(task.status, "done", `${switchMode}: ${task.message}`);
    if (switchMode === "legacy") assert.equal(task.outcome, "linked");

    const state = await f.service.store.read();
    assert.equal(state.decks[0].cards.length, 6, `${switchMode}: 5 check cards added`);
    assert.equal(state.decks[0].cards[0].requires.length, 3, `${switchMode}: 3 layer-1 prerequisites linked`);

    assert.equal(state.inbox.length, 1, `${switchMode}: no per-link or duplicate followup letters`);
    const [letter] = state.inbox;
    assert.equal(letter.kind, "followup");
    assert.equal(letter.deckId, "deck-1");
    assert.equal(letter.cardId, "card-main");
    assert.equal(letter.read, false);
    assert.equal(letter.count, undefined);
    assert.equal(letter.detail, "补了 5 个词，检查题已排到这道题前面");

    const inbox = await f.service.call("inbox");
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].kind, "followup");
    assert.equal(inbox.items[0].cardId, "card-main");
    assert.equal(inbox.items[0].count, undefined);
    assert.equal(inbox.items[0].detail, "补了 5 个词，检查题已排到这道题前面");
  }
});

test("non-terms assist modes (derive/ask/improve) and card.link / card.followup.add preserve default inbox notifications while silent: true suppresses them (#1218)", async (t) => {
  // 1. derive (出成前置题) still emits its "关联前置题" letter.
  const prereqStep = makeStep({ term: "源地址", layer: 1, needs: [] });
  const prereqCard = { ...prereqStep.card, explanation: "源地址指 IP 报文头中标记发送方的地址。" };
  const derived = await setupTermsFixture(t, async () => JSON.stringify({ card: prereqCard }));
  await derived.assist.startAssist(derived.ctx, {
    root: derived.root,
    service: derived.service,
    sessionId: "s1",
    mode: "derive",
    ref: { deckId: "deck-1", cardId: "card-main" },
    text: "什么是源地址？",
    derive: { relation: "prerequisite" },
    card: PARENT_CARD,
    deckTitle: "Network Security",
    language: "zh",
  });
  await ended(derived.assist, derived.root);
  assert.equal(derived.assist.assistView(derived.root).tasks[0].status, "done");
  const derivedState = await derived.service.store.read();
  assert.equal(derivedState.inbox.length, 1);
  assert.equal(derivedState.inbox[0].kind, "link");
  assert.equal(derivedState.inbox[0].cardId, "card-main");
  assert.match(derivedState.inbox[0].detail, /^关联前置题：/);
  assert.equal(derivedState.inbox[0].count, undefined);

  // 2. ask (with prerequisites) and improve keep their normal inbox notifications.
  const asked = await setupTermsFixture(t, async () =>
    JSON.stringify({
      answer: "边界路由器在报文进入时校验源地址前缀。",
      prerequisites: [{ card: prereqCard }],
    }),
  );
  await asked.assist.startAssist(asked.ctx, {
    root: asked.root,
    service: asked.service,
    sessionId: "s1",
    mode: "ask",
    ref: { deckId: "deck-1", cardId: "card-main" },
    text: "为什么入口过滤有效？",
    helpChoices: ["prerequisite"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
    language: "zh",
  });
  await ended(asked.assist, asked.root);
  assert.equal(asked.assist.assistView(asked.root).tasks[0].status, "done");
  const askedState = await asked.service.store.read();
  assert.deepEqual(askedState.inbox.map((item) => item.kind), ["link", "followup"]);

  const improved = await setupTermsFixture(t, async () =>
    JSON.stringify({
      patch: { hint: "注意边界路由器检查源地址前缀的方向。" },
      reason: "补充方向提示",
    }),
  );
  await improved.assist.startAssist(improved.ctx, {
    root: improved.root,
    service: improved.service,
    sessionId: "s1",
    mode: "improve",
    ref: { deckId: "deck-1", cardId: "card-main" },
    text: "提示再明确一点",
    helpChoices: [],
    card: PARENT_CARD,
    deckTitle: "Network Security",
    language: "zh",
  });
  await ended(improved.assist, improved.root);
  assert.equal(improved.assist.assistView(improved.root).tasks[0].status, "done");
  const improvedState = await improved.service.store.read();
  assert.equal(improvedState.inbox.length, 1);
  assert.equal(improvedState.inbox[0].kind, "improve");
  assert.equal(improvedState.inbox[0].detail, "补充方向提示");

  // 3. Direct card.link & card.followup.add: silent: true skips notify; omitted / false emits normally.
  const direct = await setupTermsFixture(t, async () => "{}", "legacy", (state) => {
    state.decks[0].cards.push(
      { ...PARENT_CARD, id: "pre-1", prompt: "前置题 1" },
      { ...PARENT_CARD, id: "pre-2", prompt: "前置题 2" },
      { ...PARENT_CARD, id: "pre-3", prompt: "前置题 3" },
    );
  });

  await direct.service.call("card.link", {
    deckId: "deck-1",
    cardId: "card-main",
    requires: { deckId: "deck-1", cardId: "pre-1" },
    silent: true,
  });
  await direct.service.call("card.followup.add", {
    deckId: "deck-1",
    cardId: "card-main",
    question: "静默追问",
    answer: "静默追问回答",
    silent: true,
  });

  let directState = await direct.service.store.read();
  assert.equal(directState.decks[0].cards[0].requires.length, 1);
  assert.equal(directState.decks[0].cards[0].followups.length, 1);
  assert.equal(directState.inbox.length, 0, "silent: true skips both link and followup notifications");

  // Omitted silent and silent: false both notify normally.
  await direct.service.call("card.link", {
    deckId: "deck-1",
    cardId: "card-main",
    requires: { deckId: "deck-1", cardId: "pre-2" },
  });
  await direct.service.call("card.followup.add", {
    deckId: "deck-1",
    cardId: "card-main",
    question: "默认追问",
    answer: "默认追问回答",
    silent: false,
  });

  directState = await direct.service.store.read();
  assert.equal(directState.inbox.length, 2);
  assert.equal(directState.inbox[0].kind, "link");
  assert.equal(directState.inbox[0].detail, "关联前置题：前置题 2");
  assert.equal(directState.inbox[1].kind, "followup");
  assert.equal(directState.inbox[1].detail, "默认追问");

  // A subsequent silent: true call must not merge into or bump counts on existing unread letters.
  await direct.service.call("card.link", {
    deckId: "deck-1",
    cardId: "card-main",
    requires: { deckId: "deck-1", cardId: "pre-3" },
    silent: true,
  });
  await direct.service.call("card.followup.add", {
    deckId: "deck-1",
    cardId: "card-main",
    question: "第二次静默追问",
    answer: "第二次静默追问回答",
    silent: true,
  });
  directState = await direct.service.store.read();
  assert.equal(directState.decks[0].cards[0].requires.length, 3);
  assert.equal(directState.decks[0].cards[0].followups.length, 3);
  assert.equal(directState.inbox.length, 2);
  assert.equal(directState.inbox[0].count, undefined);
  assert.equal(directState.inbox[1].count, undefined);
});

test("500-term course cap keeps check cards, prerequisites, followup, and notifies cleanly in one model call (#1217)", async (t) => {
  const fullTerms = Array.from({ length: 500 }, (_, i) => ({
    term: `existing-term-${i}`,
    at: "2026-11-18T10:00:00.000Z",
  }));

  for (const switchMode of SWITCH_MODES) {
    let calls = 0;
    const f = await setupTermsFixture(
      t,
      async (_sys, payload) => {
        calls += 1;
        const input = JSON.parse(payload);
        const requested = input.request?.terms?.[0] || "入口过滤";
        return JSON.stringify({
          ladder: [
            makeStep({
              term: requested,
              ...(requested === "入口过滤" ? { alt: "ingress filtering" } : {}),
              layer: 1,
              needs: [],
            }),
          ],
        });
      },
      switchMode,
    );
    await f.service.call("course.save", {
      name: "Networks",
      terms: { version: 1, items: fullTerms },
    });
    const beforeItems = structuredClone((await f.service.call("course.terms.get", { course: "Networks" })).items);
    assert.equal(beforeItems.length, 500);

    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["入口过滤"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    assert.equal(calls, 1, `${switchMode}: model called once with no spurious repair retry`);
    const [task] = f.assist.assistView(f.root).tasks;
    assert.equal(task.status, "done", `${switchMode}: ${task.message}`);
    assert.equal(task.repaired, undefined);
    if (switchMode === "legacy") assert.equal(task.outcome, "linked");
    const expectedDetail = "补了 1 个词，检查题已排到这道题前面；生词表已满，这几个词没有记进生词表";
    assert.equal(task.message, expectedDetail);

    const state = await f.service.store.read();
    const deck = state.decks[0];
    assert.equal(deck.cards.length, 2, `${switchMode}: check card saved`);
    const [parent, checkCard] = deck.cards;
    assert.deepEqual(parent.requires, [{ deckId: "deck-1", cardId: checkCard.id }]);
    assert.equal(parent.followups.length, 1);
    assert.equal(parent.followups[0].kind, "terms");
    assert.deepEqual(parent.followups[0].terms, ["入口过滤"]);

    assert.equal(state.inbox.length, 1);
    assert.equal(state.inbox[0].kind, "followup");
    assert.equal(state.inbox[0].cardId, "card-main");
    assert.equal(state.inbox[0].count, undefined);
    assert.equal(state.inbox[0].detail, expectedDetail);

    const afterTerms = await f.service.call("course.terms.get", { course: "Networks" });
    assert.equal(afterTerms.items.length, 500);
    assert.deepEqual(afterTerms.items, beforeItems);

    const expectedEn = "Filled in 1 term; check questions are queued before this card; the course word list is full, so these terms were not saved to it";
    assert.equal(localizeAppMessage(expectedDetail, "en"), expectedEn);
    assert.doesNotMatch(expectedEn, /[\u3400-\u9fff]/);
    const enInbox = await f.service.call("inbox", { uiLanguage: "en" });
    assert.equal(enInbox.items[0].detail, expectedEn);
    assert.doesNotMatch(enInbox.items[0].detail, /[\u3400-\u9fff]/);

    // Updating an already-stored term at the 500 cap stays at 500 and attaches cleanly without the full-list suffix.
    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["existing-term-0"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "en",
    });
    await ended(f.assist, f.root);
    assert.equal(calls, 2);
    const secondTask = f.assist.assistView(f.root).tasks[1];
    assert.equal(secondTask.status, "done");
    assert.doesNotMatch(secondTask.message, /[\u3400-\u9fff]/);
    assert.doesNotMatch(secondTask.message, /word list is full/);
    const updatedTerms = await f.service.call("course.terms.get", { course: "Networks" });
    assert.equal(updatedTerms.items.length, 500);
    assert.ok(updatedTerms.items.find((item) => item.term === "existing-term-0")?.card?.cardId);
  }
});

test("combined 12-prerequisite limit and 500-term course cap reports unlinked with full-list suffix and localizes cleanly (#1217)", async (t) => {
  const fullTerms = Array.from({ length: 500 }, (_, i) => ({
    term: `existing-term-${i}`,
    at: "2026-11-18T10:00:00.000Z",
  }));
  const fillers = Array.from({ length: 12 }, (_, i) => ({
    ...PARENT_CARD,
    id: `pre-${i}`,
    prompt: `前置填充题 ${i + 1}`,
    objective: `前置 ${i + 1}`,
  }));

  let calls = 0;
  const f = await setupTermsFixture(
    t,
    async () => {
      calls += 1;
      return JSON.stringify({
        ladder: [
          makeStep({ term: "地址前缀", layer: 2, needs: [] }),
          makeStep({ term: "入口过滤", layer: 1, needs: ["地址前缀"] }),
        ],
      });
    },
    "legacy",
    (state) => {
      state.decks[0].cards.push(...fillers);
      state.decks[0].cards[0].requires = fillers.map((c) => ({ deckId: "deck-1", cardId: c.id }));
    },
  );
  await f.service.call("course.save", {
    name: "Networks",
    terms: { version: 1, items: fullTerms },
  });

  await f.assist.startAssist(f.ctx, {
    root: f.root,
    service: f.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤"],
    card: { ...PARENT_CARD, requires: fillers.map((c) => ({ deckId: "deck-1", cardId: c.id })) },
    deckTitle: "Network Security",
    language: "zh",
  });
  await ended(f.assist, f.root);

  assert.equal(calls, 1);
  const [task] = f.assist.assistView(f.root).tasks;
  assert.equal(task.status, "done");
  assert.equal(task.repaired, undefined);
  assert.equal(task.outcome, "unlinked");
  const expectedDetail = "补了 2 个词，但原题前置已满或无法关联，检查题保留在题组里；生词表已满，这几个词没有记进生词表";
  assert.equal(task.message, expectedDetail);

  const state = await f.service.store.read();
  assert.equal(state.decks[0].cards.length, 15, "both layer-2 and layer-1 check cards kept in deck");
  assert.equal(state.decks[0].cards[0].requires.length, 12);
  assert.equal(state.decks[0].cards[0].followups.length, 1);
  assert.equal(state.decks[0].cards[0].followups[0].kind, "terms");

  assert.equal(state.inbox.length, 1);
  assert.equal(state.inbox[0].kind, "followup");
  assert.equal(state.inbox[0].detail, expectedDetail);
  assert.equal((await f.service.call("course.terms.get", { course: "Networks" })).items.length, 500);

  const expectedEn = "Filled in 2 terms, but the original card cannot link more prerequisites; check questions were saved in the deck; the course word list is full, so these terms were not saved to it";
  assert.equal(localizeAppMessage(expectedDetail, "en"), expectedEn);
  assert.doesNotMatch(expectedEn, /[\u3400-\u9fff]/);
  const enInbox = await f.service.call("inbox", { uiLanguage: "en" });
  assert.equal(enInbox.items[0].detail, expectedEn);
  assert.doesNotMatch(enInbox.items[0].detail, /[\u3400-\u9fff]/);
});

test("#1215 scenario 1: filling the same term twice on one card makes 1 model call, keeps 1 check card and 1 requires link, and preserves course.terms card", async (t) => {
  for (const switchMode of SWITCH_MODES) {
    let calls = 0;
    const f = await setupTermsFixture(
      t,
      async (_sys, payload) => {
        calls += 1;
        const input = JSON.parse(payload);
        assert.deepEqual(input.request.terms, ["BCP38"]);
        return JSON.stringify({
          ladder: [
            makeStep({
              term: "BCP38",
              alt: "RFC 2827",
              layer: 1,
              needs: [],
              prompt: calls === 1 ? "第一次生成的 BCP38 检查题？" : "第二次换了个问法的 BCP38 检查题？",
            }),
          ],
        });
      },
      switchMode,
    );

    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["BCP38"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    assert.equal(calls, 1);
    const firstState = await f.service.store.read();
    assert.equal(firstState.decks[0].cards.length, 2);
    const firstCheckRef = structuredClone(firstState.decks[0].cards[0].requires[0]);
    const firstCourseTerms = await f.service.call("course.terms.get", { course: "Networks" });
    assert.deepEqual(firstCourseTerms.items.find((item) => item.term === "BCP38")?.card, firstCheckRef);

    // Repeat fill for the same term (even with different casing) on the same card: 0 extra model calls.
    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["bcp38"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    assert.equal(calls, 1, `${switchMode}: second fill skips model call`);
    const tasks = f.assist.assistView(f.root).tasks;
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1].status, "done");
    assert.equal(tasks[1].outcome, "linked");
    assert.deepEqual(tasks[1].terms, ["bcp38"]);
    assert.equal(tasks[1].message, "这几个词以前补过，检查题已排到这道题前面：bcp38");

    const secondState = await f.service.store.read();
    assert.equal(secondState.decks[0].cards.length, 2, `${switchMode}: still 1 check card in deck`);
    assert.deepEqual(secondState.decks[0].cards[0].requires, [firstCheckRef], `${switchMode}: requires deduplicated`);
    assert.equal(secondState.decks[0].cards[0].followups.length, 2, `${switchMode}: records second terms followup for #1193`);
    assert.equal(secondState.decks[0].cards[0].followups[1].kind, "terms");
    assert.deepEqual(secondState.decks[0].cards[0].followups[1].terms, ["bcp38"]);
    assert.equal(secondState.decks[0].cards[0].followups[1].answer, "这几个词以前补过，检查题已排到这道题前面：bcp38");

    const secondCourseTerms = await f.service.call("course.terms.get", { course: "Networks" });
    assert.deepEqual(secondCourseTerms.items.find((item) => item.term === "BCP38")?.card, firstCheckRef);
  }
});

test("#1215 scenario 2: existing check-card term on a second card runs with 0 model calls (even without configured model) and localizes cleanly", async (t) => {
  const secondCard = {
    ...PARENT_CARD,
    id: "card-second",
    topic: "Edge Filtering",
    prompt: "为什么要在网络边界过滤伪造报文？",
  };
  const existingCheck = {
    ...PARENT_CARD,
    id: "chk-bcp38",
    topic: "BCP38",
    prompt: "什么是 BCP38？",
  };

  for (const switchMode of SWITCH_MODES) {
    // 1. Completely unconfigured model (no complete, no jobExecutor) and 2. Throwing model with switchOptions.
    for (const modelKind of ["none", "throwing"]) {
      const root = await privateRoot(t, `assist-terms-reuse-${switchMode}-${modelKind}-`);
      const complete = modelKind === "throwing" ? async () => { throw new Error("model must not be called"); } : undefined;
      const service = modelKind === "none"
        ? new StudyService(root, { runtimePilot: { assist: switchMode === "runtime" } })
        : new StudyService(root, { complete, ...switchOptions(switchMode, { complete, paths: ["assist"] }) });
      const assist = createAssistService();
      t.after(async () => {
        assist.dispose();
        await service.dispose();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      });
      await service.store.update((state) => {
        state.sources.push({ id: "src-1", title: "Routing Security", text: EVIDENCE });
        state.decks.push({
          id: "deck-1",
          title: "Network Security",
          course: "Networks",
          cards: [structuredClone(PARENT_CARD), structuredClone(secondCard), structuredClone(existingCheck)],
        });
      });
      await service.call("course.save", {
        name: "Networks",
        terms: {
          version: 1,
          items: [
            {
              term: "BCP38",
              at: "2026-11-18T08:00:00.000Z",
              from: { deckId: "deck-1", cardId: "card-main" },
              card: { deckId: "deck-1", cardId: "chk-bcp38" },
            },
          ],
        },
      });
      const ctx = { sessions: { get: () => ({ header: { cwd: root } }) }, get: () => undefined };

      const lang = modelKind === "none" ? "zh" : "en";
      await assist.startAssist(ctx, {
        root,
        service,
        sessionId: "s1",
        mode: "terms",
        ref: { deckId: "deck-1", cardId: "card-second" },
        terms: ["BCP38"],
        card: secondCard,
        deckTitle: "Network Security",
        language: lang,
      });
      await ended(assist, root);

      const [task] = assist.assistView(root).tasks;
      assert.equal(task.status, "done", `${switchMode}/${modelKind}: ${task.message}`);
      assert.equal(task.outcome, "linked");
      assert.deepEqual(task.terms, ["BCP38"]);
      assert.equal(task.text, "BCP38");

      const state = await service.store.read();
      assert.equal(state.decks[0].cards.length, 3, "no new check card created");
      const target = state.decks[0].cards.find((c) => c.id === "card-second");
      assert.deepEqual(target.requires, [{ deckId: "deck-1", cardId: "chk-bcp38" }]);
      assert.equal(target.followups.length, 1);
      assert.equal(target.followups[0].kind, "terms");
      assert.deepEqual(target.followups[0].terms, ["BCP38"]);

      assert.equal(state.inbox.length, 1);
      assert.equal(state.inbox[0].kind, "followup");
      assert.equal(state.inbox[0].cardId, "card-second");
      assert.equal(state.inbox[0].read, false);

      if (lang === "zh") {
        assert.equal(task.message, "这几个词以前补过，检查题已排到这道题前面：BCP38");
        assert.equal(target.followups[0].answer, "这几个词以前补过，检查题已排到这道题前面：BCP38");
        assert.equal(state.inbox[0].detail, "这几个词以前补过，检查题已排到这道题前面：BCP38");
      } else {
        assert.equal(task.message, "These terms were already filled in earlier; their check questions are queued before this card: BCP38");
        assert.equal(target.followups[0].answer, "These terms were already filled in earlier; their check questions are queued before this card: BCP38");
        assert.doesNotMatch(task.message, /[\u3400-\u9fff]/);
        assert.doesNotMatch(target.followups[0].answer, /[\u3400-\u9fff]/);
        const enInbox = await service.call("inbox", { uiLanguage: "en" });
        assert.equal(enInbox.items[0].detail, "These terms were already filled in earlier; their check questions are queued before this card: BCP38");
        assert.doesNotMatch(enInbox.items[0].detail, /[\u3400-\u9fff]/);
      }
    }
  }

  // 12-prerequisite cap overflow in reuse-only case sets outcome: 'unlinked' and localizes cleanly.
  const fillers = Array.from({ length: 12 }, (_, i) => ({
    ...PARENT_CARD,
    id: `fill-${i}`,
    prompt: `前置占位 ${i + 1}`,
  }));
  const capRoot = await privateRoot(t, "assist-terms-reuse-cap-");
  const capService = new StudyService(capRoot);
  const capAssist = createAssistService();
  t.after(async () => {
    capAssist.dispose();
    await capService.dispose();
    await rm(capRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await capService.store.update((state) => {
    state.sources.push({ id: "src-1", title: "Routing Security", text: EVIDENCE });
    state.decks.push({
      id: "deck-1",
      title: "Network Security",
      course: "Networks",
      cards: [
        { ...structuredClone(PARENT_CARD), requires: fillers.map((c) => ({ deckId: "deck-1", cardId: c.id })) },
        structuredClone(existingCheck),
        ...fillers,
      ],
    });
  });
  await capService.call("course.save", {
    name: "Networks",
    terms: { version: 1, items: [{ term: "BCP38", at: "2026-11-18T08:00:00.000Z", card: { deckId: "deck-1", cardId: "chk-bcp38" } }] },
  });
  await capAssist.startAssist(
    { sessions: { get: () => ({ header: { cwd: capRoot } }) }, get: () => undefined },
    {
      root: capRoot,
      service: capService,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["BCP38"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "en",
    },
  );
  await ended(capAssist, capRoot);
  const [capTask] = capAssist.assistView(capRoot).tasks;
  assert.equal(capTask.status, "done");
  assert.equal(capTask.outcome, "unlinked");
  assert.match(capTask.message, /cannot link more prerequisites.*BCP38/);
  assert.doesNotMatch(capTask.message, /[\u3400-\u9fff]/);
  const capEnInbox = await capService.call("inbox", { uiLanguage: "en" });
  assert.doesNotMatch(capEnInbox.items[0].detail, /[\u3400-\u9fff]/);
});

test("#1215 scenario 3: mixed 3 terms (1 live check card + 2 missing) sends 2 request.terms + 1 terms.hasCard, links all 3 and cited needs, and repairs redundant steps", async (t) => {
  const existingCheck = {
    ...PARENT_CARD,
    id: "chk-bcp38",
    topic: "BCP38",
    prompt: "什么是 BCP38？",
  };

  for (const switchMode of SWITCH_MODES) {
    let seenInput = null;
    let seenSystem = "";
    const f = await setupTermsFixture(
      t,
      async (system, payload) => {
        seenSystem = system;
        seenInput = JSON.parse(payload);
        return JSON.stringify({
          ladder: [
            makeStep({ term: "入口过滤", alt: "ingress filtering", layer: 1, needs: ["BCP38"] }),
            makeStep({ term: "出口过滤", alt: "egress filtering", layer: 1, needs: ["入口过滤"] }),
          ],
        });
      },
      switchMode,
      (state) => {
        state.decks[0].cards.push(structuredClone(existingCheck));
        state.courses.push({
          id: "course-net",
          name: "Networks",
          aliases: [],
          createdAt: "2026-11-18T08:00:00.000Z",
          updatedAt: "2026-11-18T08:00:00.000Z",
          guidanceSourceIds: [],
          focusTopics: [],
          terms: {
            version: 1,
            items: [
              {
                term: "BCP38",
                alt: "RFC 2827",
                at: "2026-11-18T08:00:00.000Z",
                from: { deckId: "deck-1", cardId: "card-main" },
                card: { deckId: "deck-1", cardId: "chk-bcp38" },
              },
            ],
          },
        });
      },
    );

    await f.assist.startAssist(f.ctx, {
      root: f.root,
      service: f.service,
      sessionId: "s1",
      mode: "terms",
      ref: { deckId: "deck-1", cardId: "card-main" },
      terms: ["BCP38", "入口过滤", "出口过滤"],
      card: PARENT_CARD,
      deckTitle: "Network Security",
      language: "zh",
    });
    await ended(f.assist, f.root);

    const [task] = f.assist.assistView(f.root).tasks;
    assert.equal(task.status, "done", `${switchMode}: ${task.message}`);
    assert.deepEqual(task.terms, ["BCP38", "入口过滤", "出口过滤"], `${switchMode}: task keeps all 3 terms for #1214 strip clear`);
    assert.equal(task.message, "补了 2 个词，复用 1 个已有检查题，检查题已排到这道题前面");

    assert.match(seenSystem, /terms\.hasCard/);
    assert.deepEqual(seenInput.request.terms, ["入口过滤", "出口过滤"], `${switchMode}: model receives only 2 missing terms`);
    assert.deepEqual(seenInput.terms.hasCard, ["BCP38"], `${switchMode}: model receives 1 hasCard term`);
    assert.equal(seenInput.terms.unknown.includes("BCP38"), false, `${switchMode}: hasCard term excluded from terms.unknown`);

    const state = await f.service.store.read();
    const deck = state.decks[0];
    assert.equal(deck.cards.length, 4, `${switchMode}: parent + 1 existing + 2 new = 4 cards`);
    const parent = deck.cards.find((c) => c.id === "card-main");
    const ingress = deck.cards.find((c) => c.topic === "入口过滤 检查");
    const egress = deck.cards.find((c) => c.topic === "出口过滤 检查");
    assert.equal(parent.requires.length, 3, `${switchMode}: parent card links all 3 prerequisites`);
    assert.deepEqual(parent.requires.map((r) => r.cardId), ["chk-bcp38", ingress.id, egress.id]);
    assert.deepEqual(ingress.requires, [{ deckId: "deck-1", cardId: "chk-bcp38" }], `${switchMode}: new step links reused check card`);
    assert.deepEqual(egress.requires, [{ deckId: "deck-1", cardId: ingress.id }]);

    assert.equal(parent.followups.length, 1);
    assert.equal(parent.followups[0].kind, "terms");
    assert.deepEqual(parent.followups[0].terms, ["BCP38", "入口过滤", "出口过滤"]);
    assert.match(parent.followups[0].answer, /已有检查题（以前补过，已直接关联）：BCP38/);

    const courseTerms = await f.service.call("course.terms.get", { course: "Networks" });
    assert.deepEqual(courseTerms.items.find((item) => item.term === "BCP38")?.card, { deckId: "deck-1", cardId: "chk-bcp38" });
    assert.deepEqual(courseTerms.items.find((item) => item.term === "入口过滤")?.card, { deckId: "deck-1", cardId: ingress.id });
    assert.deepEqual(courseTerms.items.find((item) => item.term === "出口过滤")?.card, { deckId: "deck-1", cardId: egress.id });

    const enInbox = await f.service.call("inbox", { uiLanguage: "en" });
    assert.equal(enInbox.items[0].detail, "Filled in 2 terms and reused 1 existing check question; check questions are queued before this card");
    assert.doesNotMatch(enInbox.items[0].detail, /[\u3400-\u9fff]/);
  }

  // Repair retry when model emits a step for a `hasCard` term, and layer-2 `needs` still rejected.
  let retryCalls = 0;
  const repairFixture = await setupTermsFixture(
    t,
    async (_sys, payload) => {
      retryCalls += 1;
      if (retryCalls === 1) {
        return JSON.stringify({
          ladder: [
            makeStep({ term: "BCP38", layer: 2, needs: [] }),
            makeStep({ term: "入口过滤", layer: 1, needs: ["BCP38"] }),
          ],
        });
      }
      assert.match(payload, /REFUSED_REPLY:/);
      assert.match(payload, /已有检查题的词不用再生成台阶/);
      return JSON.stringify({
        ladder: [makeStep({ term: "入口过滤", layer: 1, needs: ["BCP38"] })],
      });
    },
    "legacy",
    (state) => {
      state.decks[0].cards.push(structuredClone(existingCheck));
      state.courses.push({
        id: "course-net",
        name: "Networks",
        aliases: [],
        createdAt: "2026-11-18T08:00:00.000Z",
        updatedAt: "2026-11-18T08:00:00.000Z",
        guidanceSourceIds: [],
        focusTopics: [],
        terms: {
          version: 1,
          items: [{ term: "BCP38", at: "2026-11-18T08:00:00.000Z", card: { deckId: "deck-1", cardId: "chk-bcp38" } }],
        },
      });
    },
  );
  await repairFixture.assist.startAssist(repairFixture.ctx, {
    root: repairFixture.root,
    service: repairFixture.service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["BCP38", "入口过滤"],
    card: PARENT_CARD,
    deckTitle: "Network Security",
  });
  await ended(repairFixture.assist, repairFixture.root);
  assert.equal(retryCalls, 2);
  assert.equal(repairFixture.assist.assistView(repairFixture.root).tasks[0].status, "done");
  assert.equal(repairFixture.assist.assistView(repairFixture.root).tasks[0].repaired, true);
  assert.doesNotMatch(localizeAppMessage("已有检查题的词不用再生成台阶，请直接移除或在 needs 中引用", "en"), /[\u3400-\u9fff]/);
  assert.doesNotMatch(localizeAppMessage("台阶前置依赖必须指向前面已经讲过的词条或已有检查题的词", "en"), /[\u3400-\u9fff]/);
  assert.throws(
    () => validateTermsReply(
      {
        ladder: [
          makeStep({ term: "地址前缀", layer: 2, needs: ["BCP38"] }),
          makeStep({ term: "入口过滤", layer: 1, needs: ["地址前缀"] }),
        ],
      },
      ["入口过滤"],
      PARENT_CARD.prompt,
      ["BCP38"],
    ),
    /第 2 层台阶不能再依赖别的词/,
  );
});

test("#1215 scenario 4: term whose check card was deleted, archived, or slain is treated as missing and course.terms.attach updates card to new live card", async (t) => {
  for (const switchMode of SWITCH_MODES) {
    for (const deadMode of ["deleted", "archived", "slain"]) {
      let calls = 0;
      const f = await setupTermsFixture(
        t,
        async (_sys, payload) => {
          calls += 1;
          const input = JSON.parse(payload);
          assert.deepEqual(input.request.terms, ["BCP38"]);
          assert.equal(input.terms.hasCard, undefined);
          return JSON.stringify({
            ladder: [makeStep({ term: "BCP38", layer: 1, needs: [] })],
          });
        },
        switchMode,
        (state) => {
          if (deadMode === "archived") {
            state.decks.push({
              id: "deck-arch",
              title: "Archived",
              course: "Networks",
              archived: true,
              cards: [{ ...PARENT_CARD, id: "chk-dead", topic: "BCP38", prompt: "旧的已归档检查题？" }],
            });
          } else if (deadMode === "slain") {
            state.decks.push({
              id: "deck-slain",
              title: "斩题组",
              systemKind: "slain",
              archived: true,
              cards: [{ ...PARENT_CARD, id: "chk-dead", topic: "BCP38", prompt: "旧的已斩检查题？" }],
            });
          }
          state.courses.push({
            id: "course-net",
            name: "Networks",
            aliases: [],
            createdAt: "2026-11-18T08:00:00.000Z",
            updatedAt: "2026-11-18T08:00:00.000Z",
            guidanceSourceIds: [],
            focusTopics: [],
            terms: {
              version: 1,
              items: [
                {
                  term: "BCP38",
                  at: "2026-11-18T08:00:00.000Z",
                  card: {
                    deckId: deadMode === "archived" ? "deck-arch" : deadMode === "slain" ? "deck-slain" : "deck-1",
                    cardId: "chk-dead",
                  },
                },
              ],
            },
          });
        },
      );

      await f.assist.startAssist(f.ctx, {
        root: f.root,
        service: f.service,
        sessionId: "s1",
        mode: "terms",
        ref: { deckId: "deck-1", cardId: "card-main" },
        terms: ["BCP38"],
        card: PARENT_CARD,
        deckTitle: "Network Security",
        language: "zh",
      });
      await ended(f.assist, f.root);

      assert.equal(calls, 1, `${switchMode}/${deadMode}: triggers model call when previous card is ${deadMode}`);
      const [task] = f.assist.assistView(f.root).tasks;
      assert.equal(task.status, "done", `${switchMode}/${deadMode}: ${task.message}`);

      const state = await f.service.store.read();
      const newCheckCard = state.decks[0].cards.find((c) => c.id !== "card-main");
      assert.ok(newCheckCard, `${switchMode}/${deadMode}: created replacement check card`);
      assert.notEqual(newCheckCard.id, "chk-dead");
      assert.deepEqual(state.decks[0].cards[0].requires, [{ deckId: "deck-1", cardId: newCheckCard.id }]);

      const courseTerms = await f.service.call("course.terms.get", { course: "Networks" });
      assert.deepEqual(
        courseTerms.items.find((item) => item.term === "BCP38")?.card,
        { deckId: "deck-1", cardId: newCheckCard.id },
        `${switchMode}/${deadMode}: course.terms card updated to new live card`,
      );
    }
  }
});
