import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COURSE_TERMS_LIMITS,
  TERMS_OVER_LIMIT_ERROR,
  checkedTerms,
  mergeCourseTerms,
  termState,
  courseTermsWithState,
  coursePromptTerms,
  partitionCourseTermCards,
} from "../lib/contexts/courses/contracts.js";
import { assistInput, assistInstruction } from "../lib/assist-content.js";
import { createAssistService } from "../lib/assist.js";
import { localizeAppMessage } from "../lib/application-messages.js";
import { StudyService } from "../lib/service.js";
import { Store } from "../lib/store.js";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { ended } from "./helpers/assist-library.mjs";
import { loadUi } from "./helpers/ui-module.mjs";

const EVIDENCE =
  "Ingress filtering inspects incoming packet source IP prefixes at the edge router and drops packets from unexpected prefixes.";

async function tempRoot(t, prefix = "course-terms-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

function makeCard(id, prompt = `Check prompt for ${id}`, repetitions = 0, intervalDays = 0) {
  return {
    id,
    kind: "flashcard",
    topic: "Topic",
    objective: "Objective",
    prompt,
    answer: "Answer text",
    hint: "Hint",
    explanation: "Explanation",
    misconception: "Misconception",
    citations: [],
    ...(repetitions > 0 || intervalDays > 0
      ? { review: { repetitions, interval_days: intervalDays, ease: 2.5, due_at: "2027-01-01T00:00:00.000Z" } }
      : {}),
  };
}

test("checkedTerms validates whitespace, length <= 60, case-insensitive dedup, max 500, and null when empty", () => {
  assert.equal(checkedTerms(undefined), undefined);
  assert.equal(checkedTerms(null), null);
  assert.equal(checkedTerms({ version: 1, items: [] }), null);

  assert.throws(() => checkedTerms("bad"), /生词表格式无效/);
  assert.throws(() => checkedTerms({ version: 2, items: [] }), /生词表版本不支持/);
  assert.throws(() => checkedTerms({ version: 1, items: [{ term: "hello\nworld" }] }), /生词不能换行/);
  assert.throws(() => checkedTerms({ version: 1, items: [{ term: "   " }] }), /生词不能换行/);
  assert.throws(() => checkedTerms({ version: 1, items: [{ term: "a".repeat(61) }] }), /1–60/);

  const maxLen = "a".repeat(60);
  const valid = checkedTerms({
    version: 1,
    items: [
      { term: `  ${maxLen}  `, at: "2026-11-18T10:00:00.000Z" },
      { term: "  BCP38\t\t过滤  ", at: "2026-11-18T12:00:00.000Z", from: { deckId: "d1", cardId: "c1" } },
      { term: "bcp38 过滤", alt: "ingress RFC2827", at: "2026-11-18T09:00:00.000Z", card: { deckId: "d1", cardId: "c2" } },
    ],
  });
  assert.equal(valid.version, COURSE_TERMS_LIMITS.version);
  assert.equal(valid.items.length, 2);
  assert.equal(valid.items[0].term, maxLen);
  assert.equal(valid.items[1].term, "bcp38 过滤");
  assert.equal(valid.items[1].alt, "ingress RFC2827");
  assert.equal(valid.items[1].at, "2026-11-18T09:00:00.000Z");
  assert.deepEqual(valid.items[1].from, { deckId: "d1", cardId: "c1" });
  assert.deepEqual(valid.items[1].card, { deckId: "d1", cardId: "c2" });

  // Max 500 succeeds; 501 throws explicit message with English localization.
  const fiveHundred = Array.from({ length: 500 }, (_, i) => ({ term: `term-${i}`, at: "2026-11-18T12:00:00.000Z" }));
  assert.equal(checkedTerms({ version: 1, items: fiveHundred }).items.length, 500);
  assert.throws(
    () => checkedTerms({ version: 1, items: [...fiveHundred, { term: "term-500", at: "2026-11-18T12:00:00.000Z" }] }),
    (err) => err.message === TERMS_OVER_LIMIT_ERROR,
  );
  assert.doesNotMatch(localizeAppMessage(TERMS_OVER_LIMIT_ERROR, "en"), /[\u3400-\u9fff]/);
});

test("termState covers all 4 conditions including missing/deleted card", () => {
  const levels = new Map([
    ["d1:c-new", "new"],
    ["d1:c-weak", "weak"],
    ["d1:c-learning", "learning"],
    ["d1:c-familiar", "familiar"],
    ["d1:c-mastered", "mastered"],
  ]);
  const levelOf = (deckId, cardId) => levels.get(`${deckId}:${cardId}`) ?? null;

  assert.equal(termState({ term: "A" }, levelOf), "unknown");
  assert.equal(termState({ term: "A", card: { deckId: "d1", cardId: "c-deleted" } }, levelOf), "unknown");
  assert.equal(termState({ term: "A", card: { deckId: "d1", cardId: "c-new" } }, levelOf), "unknown");
  assert.equal(termState({ term: "A", card: { deckId: "d1", cardId: "c-weak" } }, levelOf), "unknown");
  assert.equal(termState({ term: "A", card: { deckId: "d1", cardId: "c-learning" } }, levelOf), "learned");
  assert.equal(termState({ term: "A", card: { deckId: "d1", cardId: "c-familiar" } }, levelOf), "known");
  assert.equal(termState({ term: "A", card: { deckId: "d1", cardId: "c-mastered" } }, levelOf), "known");
});

test("five course.terms operations, mastery updates, store round-trip persistence, and empty field deletion", async (t) => {
  const root = await tempRoot(t);
  const service = new StudyService(root);
  t.after(() => service.dispose());

  await service.call("snapshot");
  await service.store.update((state) => {
    state.decks.push({
      id: "deck-1",
      title: "Routing",
      course: "Networks",
      cards: [
        makeCard("c-src", "请解释 入口过滤 和 BCP38 在边缘路由器上的作用，这段题面故意写得长一些方便检验截断"),
        makeCard("c-chk-1", "Check card 1"),
        makeCard("c-chk-2", "Check card 2"),
      ],
    });
  });

  // 1. Virtual course before terms exist returns empty list gracefully.
  const initial = await service.call("course.terms.get", { course: "Networks" });
  assert.equal(initial.course, "Networks");
  assert.deepEqual(initial.items, []);

  // 2. course.terms.mark adds non-duplicates (case-insensitive) and deduplicates repeats.
  const mark1 = await service.call("course.terms.mark", {
    course: "Networks",
    terms: ["入口过滤", "BCP38", "bcp38", "  入口过滤  "],
    from: { deckId: "deck-1", cardId: "c-src" },
  });
  assert.equal(mark1.added, 2);
  assert.equal(mark1.items.length, 2);

  const markRepeat = await service.call("course.terms.mark", {
    course: "Networks",
    terms: ["bcp38"],
    from: { deckId: "deck-1", cardId: "c-src" },
  });
  assert.equal(markRepeat.added, 0);
  assert.equal(markRepeat.items.length, 2);

  // 3. course.terms.attach attaches check cards to existing terms and adds unseen terms cleanly.
  const attachRes = await service.call("course.terms.attach", {
    course: "Networks",
    links: [
      { term: "bcp38", alt: "RFC 2827", card: { deckId: "deck-1", cardId: "c-chk-1" } },
      { term: "出口过滤", alt: "egress filtering", from: { deckId: "deck-1", cardId: "c-src" }, card: { deckId: "deck-1", cardId: "c-chk-2" } },
    ],
  });
  assert.equal(attachRes.attached, 2);
  assert.equal(attachRes.items.length, 3);

  // Simulate review attempts for c-chk-1 (learning -> learned) and c-chk-2 (familiar -> known).
  await service.store.update((state) => {
    const chk1 = state.decks[0].cards.find((c) => c.id === "c-chk-1");
    chk1.review = { repetitions: 1, interval_days: 1, ease: 2.5, due_at: "2027-01-01T00:00:00.000Z" };
    const chk2 = state.decks[0].cards.find((c) => c.id === "c-chk-2");
    chk2.review = { repetitions: 2, interval_days: 10, ease: 2.5, due_at: "2027-01-01T00:00:00.000Z" };
    state.attempts.push(
      { id: "a1", deckId: "deck-1", quiz_id: "c-chk-1", grade: 3, at: "2026-11-18T10:00:00.000Z" },
      { id: "a2", deckId: "deck-1", quiz_id: "c-chk-2", grade: 4, at: "2026-11-18T10:01:00.000Z" },
    );
  });

  const got = await service.call("course.terms.get", { course: "Networks" });
  const byTerm = new Map(got.items.map((item) => [item.term, item]));
  assert.equal(byTerm.get("入口过滤").state, "unknown");
  assert.equal(byTerm.get("BCP38").state, "learned");
  assert.equal(byTerm.get("BCP38").alt, "RFC 2827");
  assert.equal(byTerm.get("出口过滤").state, "known");
  assert.ok(byTerm.get("入口过滤").fromPrompt.startsWith("请解释 入口过滤"));

  // Round-trip through Store shards on disk: exact terms record survives fresh reload.
  await service.dispose();
  const reloadedState = await new Store(root).read();
  const savedCourse = reloadedState.courses.find((c) => c.name === "Networks");
  assert.equal(savedCourse.terms.items.length, 3);

  // Deleting check card degrades termState back to unknown dynamically.
  const service2 = new StudyService(root);
  t.after(() => service2.dispose());
  await service2.store.update((state) => {
    state.decks[0].cards = state.decks[0].cards.filter((c) => c.id !== "c-chk-2");
  });
  const afterDelete = await service2.call("course.terms.get", { course: "Networks" });
  assert.equal(afterDelete.items.find((item) => item.term === "出口过滤").state, "unknown");

  // 4. course.terms.unmark removes case-insensitively.
  const unmark1 = await service2.call("course.terms.unmark", { course: "Networks", terms: ["bcp38"] });
  assert.equal(unmark1.removed, 1);
  assert.equal(unmark1.items.length, 2);

  // Removing remaining items deletes course.terms field completely.
  await service2.call("course.terms.unmark", { course: "Networks", terms: ["入口过滤", "出口过滤"] });
  const afterAllUnmarked = await service2.store.read();
  assert.equal(afterAllUnmarked.courses.find((c) => c.name === "Networks").terms, undefined);

  // 5. course.terms.clear deletes course.terms field.
  await service2.call("course.terms.mark", { course: "Networks", terms: ["路由表"] });
  const cleared = await service2.call("course.terms.clear", { course: "Networks" });
  assert.equal(cleared.cleared, true);
  assert.deepEqual(cleared.items, []);
  const afterClear = await service2.store.read();
  assert.equal(afterClear.courses.find((c) => c.name === "Networks").terms, undefined);
});

test("course.terms.unmark with onlyUnattached keeps attached terms while deleting unattached ones (#1212)", async (t) => {
  const root = await tempRoot(t, "course-terms-unmark-guard-");
  const service = new StudyService(root);
  t.after(() => service.dispose());

  await service.call("snapshot");
  await service.store.update((state) => {
    state.decks.push({
      id: "deck-1",
      title: "Routing",
      course: "Networks",
      cards: [
        makeCard("c-chk-1", "Check card 1"),
        makeCard("c-chk-2", "Check card 2"),
      ],
    });
  });

  await service.call("course.terms.mark", {
    course: "Networks",
    terms: ["Ingress"],
  });
  await service.call("course.terms.attach", {
    course: "Networks",
    links: [
      { term: "BCP38", card: { deckId: "deck-1", cardId: "c-chk-1" } },
      { term: "Egress", card: { deckId: "deck-1", cardId: "c-chk-2" } },
    ],
  });

  // onlyUnattached: true deletes unattached "Ingress" while preserving attached "BCP38".
  const guarded = await service.call("course.terms.unmark", {
    course: "Networks",
    terms: ["bcp38", "ingress"],
    onlyUnattached: true,
  });
  assert.equal(guarded.removed, 1);
  assert.deepEqual(guarded.items.map((item) => item.term), ["BCP38", "Egress"]);
  assert.deepEqual(guarded.items[0].card, { deckId: "deck-1", cardId: "c-chk-1" });

  // Calling again with only attached terms deletes nothing.
  const noopGuarded = await service.call("course.terms.unmark", {
    course: "Networks",
    terms: ["bcp38"],
    onlyUnattached: true,
  });
  assert.equal(noopGuarded.removed, 0);
  assert.equal(noopGuarded.items.length, 2);

  // Without onlyUnattached (or with onlyUnattached: false), attached terms ARE deleted.
  const unguarded = await service.call("course.terms.unmark", {
    course: "Networks",
    terms: ["bcp38"],
  });
  assert.equal(unguarded.removed, 1);
  assert.deepEqual(unguarded.items.map((item) => item.term), ["Egress"]);

  const falseFlag = await service.call("course.terms.unmark", {
    course: "Networks",
    terms: ["egress"],
    onlyUnattached: false,
  });
  assert.equal(falseFlag.removed, 1);
  assert.deepEqual(falseFlag.items, []);
});

test("mergeCourseTerms and course.merge take union keeping earlier at and card links", async (t) => {
  const merged = mergeCourseTerms(
    {
      version: 1,
      items: [
        { term: "BCP38", at: "2026-11-18T12:00:00.000Z", card: { deckId: "d1", cardId: "c1" } },
        { term: "ACL", at: "2026-11-18T10:00:00.000Z" },
      ],
    },
    {
      version: 1,
      items: [
        { term: "bcp38", alt: "RFC2827", at: "2026-11-18T08:00:00.000Z" },
        { term: "NAT", at: "2026-11-18T09:00:00.000Z", card: { deckId: "d2", cardId: "c2" } },
      ],
    },
  );
  assert.equal(merged.items.length, 3);
  const bcp = merged.items.find((item) => item.term.toLowerCase() === "bcp38");
  assert.equal(bcp.at, "2026-11-18T08:00:00.000Z");
  assert.deepEqual(bcp.card, { deckId: "d1", cardId: "c1" });
  assert.equal(bcp.alt, "RFC2827");

  const root = await tempRoot(t, "course-terms-merge-");
  const service = new StudyService(root);
  t.after(() => service.dispose());
  await service.call("course.save", {
    name: "Net I",
    terms: {
      version: 1,
      items: [{ term: "Ingress", at: "2026-11-18T12:00:00.000Z", card: { deckId: "d1", cardId: "c1" } }],
    },
  });
  await service.call("course.save", {
    name: "Net II",
    terms: {
      version: 1,
      items: [
        { term: "ingress", alt: "入口", at: "2026-11-18T07:00:00.000Z" },
        { term: "Egress", at: "2026-11-18T09:00:00.000Z" },
      ],
    },
  });
  const list = await service.call("course.list");
  const intoId = list.courses.find((c) => c.name === "Net I").id;
  const fromId = list.courses.find((c) => c.name === "Net II").id;
  await service.call("course.merge", { into: intoId, from: [fromId] });

  const mergedCourse = await service.call("course.terms.get", { course: "Net I" });
  assert.equal(mergedCourse.items.length, 2);
  const ing = mergedCourse.items.find((item) => item.term.toLowerCase() === "ingress");
  assert.equal(ing.at, "2026-11-18T07:00:00.000Z");
  assert.deepEqual(ing.card, { deckId: "d1", cardId: "c1" });
});

test("assist ask and terms include capped <= 100 known/unknown word lists and attach only layer 1 cards", async (t) => {
  const root = await tempRoot(t, "course-terms-assist-");
  const capturedPayloads = [];
  const fake = createFakeModel();
  const spyModel = async (instruction, payload) => {
    capturedPayloads.push({ instruction, input: JSON.parse(payload) });
    return fake(instruction, payload);
  };

  const service = new StudyService(root, { complete: spyModel });
  const assist = createAssistService();
  t.after(async () => {
    assist.dispose();
    await service.dispose();
  });

  // Seed 115 unknown terms and 115 known/learned terms to check the 100-item cap.
  const knownCards = [];
  const seededTerms = [];
  const attempts = [];
  for (let i = 0; i < 115; i++) {
    const cid = `ck-${i}`;
    knownCards.push({
      ...makeCard(cid, `Known check ${i}`, 2, 10),
    });
    attempts.push({ id: `ak-${i}`, deckId: "deck-1", quiz_id: cid, grade: 4, at: "2026-11-18T08:00:00.000Z" });
    seededTerms.push({
      term: `已知词-${String(i).padStart(3, "0")}`,
      at: new Date(Date.UTC(2026, 10, 18, 0, i)).toISOString(),
      card: { deckId: "deck-1", cardId: cid },
    });
    seededTerms.push({
      term: `未知词-${String(i).padStart(3, "0")}`,
      at: new Date(Date.UTC(2026, 10, 18, 2, i)).toISOString(),
    });
  }

  await service.store.update((state) => {
    state.sources.push({ id: "src-1", title: "Routing", text: EVIDENCE });
    state.decks.push({
      id: "deck-1",
      title: "Network Security",
      course: "NetSec",
      cards: [
        {
          ...makeCard("card-main", "如何缓解 IP 欺骗？"),
          citations: [{ sourceId: "src-1", quote: EVIDENCE }],
        },
        ...knownCards,
      ],
    });
    state.attempts.push(...attempts);
  });
  await service.call("course.save", {
    name: "NetSec",
    terms: { version: 1, items: seededTerms },
  });

  const ctx = { sessions: { get: () => ({ header: { cwd: root } }) }, get: () => undefined };

  // 1. Direct assistInput & assistInstruction check for both ask & terms.
  const snap = await service.store.read();
  const askData = assistInput(snap, { deckId: "deck-1", cardId: "card-main" }, {
    mode: "ask",
    request: { question: "讲讲入口过滤", choices: [], requests: [] },
    assessment: null,
  });
  assert.equal(askData.terms.known.length, 100);
  assert.equal(askData.terms.unknown.length, 100);
  assert.ok(askData.terms.known.includes("已知词-114"), "keeps most recent 100 known words");
  assert.ok(!askData.terms.known.includes("已知词-000"), "drops oldest known words beyond 100");
  assert.ok(askData.terms.unknown.includes("未知词-114"), "keeps most recent 100 unknown words");
  assert.match(assistInstruction("ask", false), /terms\.unknown/);
  assert.match(assistInstruction("ask", false), /terms\.known/);
  assert.match(assistInstruction("terms", false), /terms\.unknown/);
  assert.match(assistInstruction("terms", false), /terms\.known/);

  // Direct coursePromptTerms verification.
  const promptTerms = coursePromptTerms(snap, "NetSec");
  assert.equal(promptTerms.known.length, 100);
  assert.equal(promptTerms.unknown.length, 100);
  assert.equal(courseTermsWithState(snap, "NetSec").length, 230);

  // 2. End-to-end ask & terms runs through assist -> fake model receives both <= 100 lists, and commit attaches only layer-1 steps.
  await assist.startAssist(ctx, {
    root,
    service,
    sessionId: "s1",
    mode: "ask",
    ref: { deckId: "deck-1", cardId: "card-main" },
    text: "请用大白话解释一下",
    card: { prompt: "如何缓解 IP 欺骗？", answer: "入口过滤" },
    deckTitle: "Network Security",
  });
  await ended(assist, root);

  await assist.startAssist(ctx, {
    root,
    service,
    sessionId: "s1",
    mode: "terms",
    ref: { deckId: "deck-1", cardId: "card-main" },
    terms: ["入口过滤", "BCP38"],
    card: { prompt: "如何缓解 IP 欺骗？", answer: "入口过滤" },
    deckTitle: "Network Security",
  });
  await ended(assist, root);

  assert.equal(capturedPayloads.length, 2);
  const askCall = capturedPayloads.find((p) => p.input.mode === "ask");
  const termsCall = capturedPayloads.find((p) => p.input.mode === "terms");
  assert.equal(askCall.input.terms.known.length, 100);
  assert.equal(askCall.input.terms.unknown.length, 100);
  assert.equal(termsCall.input.terms.known.length, 100);
  assert.equal(termsCall.input.terms.unknown.length, 100);
  assert.ok(termsCall.input.terms.unknown.includes("入口过滤"));
  assert.ok(termsCall.input.terms.unknown.includes("BCP38"));

  const afterAssist = await service.call("course.terms.get", { course: "NetSec" });
  const attachedIngress = afterAssist.items.find((item) => item.term === "入口过滤");
  const attachedBcp = afterAssist.items.find((item) => item.term === "BCP38");
  assert.ok(attachedIngress?.card?.cardId, "layer-1 term attached check card");
  assert.ok(attachedBcp?.card?.cardId, "layer-1 term attached check card");
  // Layer 2 foundational term added by fake-model ("前置前提") must NOT be added to course.terms.
  assert.equal(afterAssist.items.some((item) => item.term === "前置前提"), false);
});

test("TermListDialog static render shows three state groups, prompts, remove buttons, menu and confirm clear", async () => {
  const { setUiLanguage, TermChips, TermListDialog } = await loadUi(`
    export * from "./ui/i18n.js";
    export { default as TermChips } from "./ui/review/TermChips.jsx";
    export { default as TermListDialog } from "./ui/review/TermListDialog.jsx";
  `);
  const sampleItems = [
    { term: "入口过滤", alt: "ingress filtering", state: "unknown", fromPrompt: "如何缓解 IP 欺骗？" },
    { term: "BCP38", state: "learned", fromPrompt: "在边界检查源地址前缀的标准是什么？" },
    { term: "ACL", state: "known", fromPrompt: "访问控制列表的作用是什么？" },
  ];

  setUiLanguage("zh");
  const stripHtml = renderToStaticMarkup(
    React.createElement(TermChips, { terms: ["入口过滤"], hasCourse: true, onTermList() {}, onRemove() {}, onFill() {} }),
  );
  assert.match(stripHtml, /生词表/);
  assert.match(stripHtml, /data-tour="review-term-list"/);

  const dialogHtml = renderToStaticMarkup(
    React.createElement(TermListDialog, {
      courseName: "网络课",
      items: sampleItems,
      onRemove() {},
      onClear() {},
      onClose() {},
      menuDefaultOpen: true,
    }),
  );
  assert.match(dialogHtml, /网络课 · 生词表/);
  assert.match(dialogHtml, /不认识/);
  assert.match(dialogHtml, /学过/);
  assert.match(dialogHtml, /会了/);
  assert.match(dialogHtml, /入口过滤/);
  assert.match(dialogHtml, /ingress filtering/);
  assert.match(dialogHtml, /出自：如何缓解 IP 欺骗？/);
  assert.match(dialogHtml, /从生词表移除「入口过滤」/);
  assert.match(dialogHtml, /清空生词表/);

  const confirmHtml = renderToStaticMarkup(
    React.createElement(TermListDialog, {
      courseName: "网络课",
      items: sampleItems,
      onRemove() {},
      onClear() {},
      onClose() {},
      confirmClearDefaultOpen: true,
    }),
  );
  assert.match(confirmHtml, /清空这门课的生词表？/);

  // Stateful React render: verify Menu onSelect -> ConfirmDialog -> only confirming invokes onClear, remove invokes onRemove.
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prevH = internals.H;
  const removed = [];
  let cleared = 0;
  const states = [];
  let hookIdx = 0;
  const renderWithState = (props) => {
    hookIdx = 0;
    const tree = TermListDialog(props);
    return tree;
  };
  internals.H = {
    useState: (init) => {
      const idx = hookIdx++;
      if (idx >= states.length) states.push(typeof init === "function" ? init() : init);
      return [states[idx], (v) => { states[idx] = typeof v === "function" ? v(states[idx]) : v; }];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init }),
    useId: () => "id-1",
    useContext: () => ({}),
  };
  try {
    const props = {
      courseName: "网络课",
      items: sampleItems,
      onRemove: async (term) => { removed.push(term); },
      onClear: async () => { cleared += 1; },
      onClose() {},
    };
    const tree1 = renderWithState(props);
    const findNodes = (node, pred, out = []) => {
      if (!node || typeof node !== "object") return out;
      if (Array.isArray(node)) { node.forEach((n) => findNodes(n, pred, out)); return out; }
      if (pred(node)) out.push(node);
      if (node.props?.children) findNodes(node.props.children, pred, out);
      for (const key of ["footer", "trigger"]) if (node.props?.[key]) findNodes(node.props[key], pred, out);
      return out;
    };
    // 1. Trigger single-item remove.
    const removeButtons = findNodes(tree1, (n) => n.props?.icon === "close");
    assert.equal(removeButtons.length, 3);
    await removeButtons[0].props.onClick();
    assert.deepEqual(removed, ["入口过滤"]);

    // 2. Selecting "clear" in Menu opens ConfirmDialog without calling onClear yet.
    const menus = findNodes(tree1, (n) => typeof n.props?.onSelect === "function" && Array.isArray(n.props?.items));
    assert.equal(menus.length, 1);
    assert.equal(menus[0].props.items[0].id, "clear");
    assert.equal(menus[0].props.items[0].danger, true);
    menus[0].props.onSelect("clear");
    assert.equal(cleared, 0, "menu choice opens confirmation first, never clears directly");

    // 3. Render again -> ConfirmDialog is open; confirming triggers onClear.
    const tree2 = renderWithState(props);
    const confirms = findNodes(tree2, (n) => typeof n.props?.onConfirm === "function");
    assert.equal(confirms.length, 1);
    await confirms[0].props.onConfirm();
    assert.equal(cleared, 1);
  } finally {
    internals.H = prevH;
  }

  // English rendering check: no Han characters leak when UI is English.
  setUiLanguage("en");
  const enHtml = renderToStaticMarkup(
    React.createElement(TermListDialog, {
      courseName: "Networks",
      items: [{ term: "BCP38", state: "unknown", fromPrompt: "Explain ingress filtering" }],
      onRemove() {},
      onClear() {},
      onClose() {},
      menuDefaultOpen: true,
      confirmClearDefaultOpen: true,
    }),
  );
  assert.doesNotMatch(enHtml, /[\u3400-\u9fff]/);
  assert.match(enHtml, /Networks · Word list/);
  assert.match(enHtml, /Clear word list/);
  setUiLanguage("zh");
});

test("course.terms.attach keeps live card refs intact and overwrites only missing/archived/slain refs (#1215)", async (t) => {
  const root = await tempRoot(t, "course-terms-attach-guard-");
  const service = new StudyService(root);
  t.after(() => service.dispose());

  await service.call("snapshot");
  await service.store.update((state) => {
    state.decks.push(
      {
        id: "deck-live",
        title: "Routing",
        course: "Networks",
        cards: [
          makeCard("c-live-1", "Live check 1"),
          makeCard("c-live-2", "Live check 2"),
          makeCard("c-live-3", "Live check 3"),
          makeCard("c-replacement", "Replacement check"),
        ],
      },
      {
        id: "deck-arch",
        title: "Old Routing",
        course: "Networks",
        archived: true,
        cards: [makeCard("c-archived", "Archived check")],
      },
      {
        id: "deck-slain",
        title: "斩题组",
        systemKind: "slain",
        archived: true,
        cards: [makeCard("c-slain", "Slain check")],
      },
    );
  });

  await service.call("course.save", {
    name: "Networks",
    terms: {
      version: 1,
      items: [
        { term: "LiveTerm", alt: "orig alt", at: "2026-11-18T08:00:00.000Z", card: { deckId: "deck-live", cardId: "c-live-1" } },
        { term: "DeletedTerm", at: "2026-11-18T08:01:00.000Z", card: { deckId: "deck-live", cardId: "c-deleted" } },
        { term: "ArchivedTerm", at: "2026-11-18T08:02:00.000Z", card: { deckId: "deck-arch", cardId: "c-archived" } },
        { term: "SlainTerm", at: "2026-11-18T08:03:00.000Z", card: { deckId: "deck-slain", cardId: "c-slain" } },
      ],
    },
  });

  const snapBefore = await service.store.read();
  assert.deepEqual(
    partitionCourseTermCards(snapBefore, "Networks", ["liveterm", "DeletedTerm", "ArchivedTerm", "SlainTerm", "Unseen"]),
    {
      hasCard: [{ term: "liveterm", card: { deckId: "deck-live", cardId: "c-live-1" } }],
      missing: ["DeletedTerm", "ArchivedTerm", "SlainTerm", "Unseen"],
    },
  );

  const liveOnly = await service.call("course.terms.attach", {
    course: "Networks",
    links: [{ term: "liveterm", alt: "new alt", card: { deckId: "deck-live", cardId: "c-live-2" } }],
  });
  assert.equal(liveOnly.attached, 0, "live card ref is not overwritten");
  assert.deepEqual(liveOnly.items.find((item) => item.term === "LiveTerm")?.card, { deckId: "deck-live", cardId: "c-live-1" });
  assert.equal(liveOnly.items.find((item) => item.term === "LiveTerm")?.alt, "orig alt");

  const replaced = await service.call("course.terms.attach", {
    course: "Networks",
    links: [
      { term: "LiveTerm", card: { deckId: "deck-live", cardId: "c-live-2" } },
      { term: "DeletedTerm", card: { deckId: "deck-live", cardId: "c-live-3" } },
      { term: "ArchivedTerm", card: { deckId: "deck-live", cardId: "c-replacement" } },
      { term: "SlainTerm", card: { deckId: "deck-live", cardId: "c-live-2" } },
    ],
  });
  assert.equal(replaced.attached, 3, "overwrites only dead/archived/slain card refs");
  assert.deepEqual(replaced.items.find((item) => item.term === "LiveTerm")?.card, { deckId: "deck-live", cardId: "c-live-1" });
  assert.deepEqual(replaced.items.find((item) => item.term === "DeletedTerm")?.card, { deckId: "deck-live", cardId: "c-live-3" });
  assert.deepEqual(replaced.items.find((item) => item.term === "ArchivedTerm")?.card, { deckId: "deck-live", cardId: "c-replacement" });
  assert.deepEqual(replaced.items.find((item) => item.term === "SlainTerm")?.card, { deckId: "deck-live", cardId: "c-live-2" });
});
