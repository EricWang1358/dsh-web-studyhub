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
      explanation: `占位说明`,
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
    assert.deepEqual(task.terms, ["入口过滤", "BCP38", "出口过滤"]);
    assert.equal(task.text, "入口过滤、BCP38、出口过滤");
    assert.match(task.message, /补了 3 个词，检查题已排到这道题前面/);
    assert.doesNotMatch(task.message, /进信箱/);

    assert.match(seenSystem, /bottom-up concept ladder/);
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

    const followupNotif = state.inbox.find((item) => item.kind === "followup");
    assert.ok(followupNotif);
    assert.equal(followupNotif.detail, "补了 3 个词，检查题已排到这道题前面");
    assert.doesNotMatch(followupNotif.detail, /进信箱/);
  }
});

test("layer 2 foundations link in chain order and original card never links layer 2 directly", async (t) => {
  const f = await setupTermsFixture(t, async () =>
    JSON.stringify({
      ladder: [
        makeStep({ term: "地址前缀", alt: "prefix", layer: 2, needs: [] }),
        makeStep({ term: "入口过滤", layer: 2, needs: ["地址前缀"] }),
        makeStep({ term: "BCP38", layer: 1, needs: ["入口过滤"] }),
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
  assert.deepEqual(bcp38Card.requires, [{ deckId: "deck-1", cardId: ingressCard.id }]);
  assert.deepEqual(ingressCard.requires, [{ deckId: "deck-1", cardId: prefixCard.id }]);
  assert.equal(prefixCard.requires, undefined);

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
  assert.deepEqual(enReply.ladder[1].needs, [enReply.ladder[0].term]);
  assert.deepEqual(enReply.ladder[2].needs, ["linearizability"]);
  assert.ok(enReply.ladder.every((step) => step.note && step.card.citations[0].sourceId === "NOTE"));
});
