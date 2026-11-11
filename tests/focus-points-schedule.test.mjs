import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import {
  normalizeFocusTerm,
  parseFocusText,
  focusMatcher,
  isFocusCard,
  courseFocusTopics,
  escalateFocusDifficulty,
} from "../lib/focus-points.js";
import { initialReview, schedule, focusScheduleSettings } from "../lib/sm2.js";
import { planPath } from "../lib/mastery.js";
import { courseBatch } from "../lib/course-route.js";
import { crunchPlan } from "../lib/crunch-plan.js";
import { periodPlan } from "../lib/plan-schedule.js";
import { emptyState } from "../lib/store.js";

const makeQuiz = (id, topic, extra = {}) => ({
  id,
  kind: "quiz",
  topic,
  objective: `Objective for ${topic} (${id})`,
  prompt: `Question ${id} about ${topic}?`,
  answer: "Option A",
  hint: "Check the conditions first.",
  explanation: "Option A holds when the precondition holds.",
  misconception: "Ignoring the precondition.",
  citations: [{ sourceId: "src-1", quote: "Option A holds when the precondition holds in all processes." }],
  options: [
    { id: "a", text: "Option A", correct: true, explanation: "Supported." },
    { id: "b", text: "Option B", correct: false, explanation: "Violates condition." },
    { id: "c", text: "Option C", correct: false, explanation: "Unrelated." },
  ],
  ...extra,
});

async function makeService(t) {
  const root = await mkdtemp(join(tmpdir(), "study-focus-sched-"));
  const study = new StudyService(root);
  t.after(async () => {
    study.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return study;
}

test("parseFocusText deterministically extracts focus topics from chat notes and OCR text with zero model calls", () => {
  const raw = [
    "# 期末复习重点",
    "1. 重点：死锁四个必要条件；银行家算法安全性检查",
    "- 页面置换（LRU、Clock）",
    "② 虚拟内存缺页中断、快表 TLB、多级页表",
    "[看不清]",
    "Page 2",
  ].join("\n");
  const parsed = parseFocusText(raw, { title: "OS 重点" });
  assert.deepEqual(parsed.topics, [
    "死锁四个必要条件",
    "银行家算法安全性检查",
    "页面置换（LRU、Clock）",
    "虚拟内存缺页中断",
    "快表 TLB",
    "多级页表",
  ]);
  assert.match(parsed.markdown, /^# OS 重点\n\n## 重点知识点/);
  assert.equal(normalizeFocusTerm("重点 3：**TCP 拥塞控制**；"), "TCP 拥塞控制");
  assert.equal(normalizeFocusTerm("期末考试范围"), "");
});

test("focusMatcher enforces word boundaries on short ASCII acronyms and inherits parent course focusTopics", () => {
  const matcher = focusMatcher(["OS", "TCP", "银行家算法"]);
  assert.equal(matcher.matchesText("The total cost of ownership"), false, "OS must not match inside 'cost'");
  assert.equal(matcher.matchesText("tcpdump packet capture"), false, "TCP must not match inside 'tcpdump'");
  assert.equal(matcher.matchesText("OS kernel mode switch"), true);
  assert.equal(matcher.matchesText("TCP congestion window"), true);
  assert.equal(matcher.matchesText("利用银行家算法判断安全序列"), true);

  const state = emptyState();
  state.courses = [
    { id: "c-os", name: "OS", focusTopics: ["死锁", "TLB"] },
    { id: "c-ch3", name: "OS / 第 3 章", focusTopics: ["信号量"] },
  ];
  state.decks = [{ id: "d1", title: "Ch 3", course: "OS / 第 3 章", cards: [] }];
  assert.deepEqual(courseFocusTopics(state, "OS / 第 3 章"), ["死锁", "TLB", "信号量"]);
  assert.deepEqual(courseFocusTopics(state, "OS", { includeDescendants: true }), ["死锁", "TLB", "信号量"]);
  assert.equal(escalateFocusDifficulty("foundation"), "application");
  assert.equal(escalateFocusDifficulty("mixed"), "advanced");
  assert.equal(escalateFocusDifficulty("application"), "advanced");
  assert.equal(escalateFocusDifficulty("advanced"), "advanced");
});

test("FSRS-6 schedules shorter review intervals for focus cards while preserving pure stability and difficulty", async (t) => {
  const settings = { request_retention: 0.9 };
  const focusSettings = focusScheduleSettings(settings, { isFocus: true });
  assert.equal(focusSettings.request_retention, 0.94);
  assert.equal(focusScheduleSettings({ request_retention: 0.9, focus_boost: false }, { isFocus: true }).request_retention, 0.9);

  let normalRev = initialReview(settings);
  let focusRev = initialReview(focusSettings);
  let tNormal = Date.parse("2026-10-01T08:00:00Z");
  let tFocus = tNormal;
  for (const grade of [4, 4, 4]) {
    normalRev = schedule(normalRev, grade, new Date(tNormal).toISOString(), settings);
    focusRev = schedule(focusRev, grade, new Date(tFocus).toISOString(), focusSettings);
    tNormal = Date.parse(normalRev.due_at);
    tFocus = Date.parse(focusRev.due_at);
  }
  assert.ok(focusRev.interval_days < normalRev.interval_days, `focus interval (${focusRev.interval_days}d) < normal (${normalRev.interval_days}d)`);

  // End-to-end through StudyService: focus card (by course focusTopics or card.focus) gets shorter due_at and focusScheduled receipt
  const study = await makeService(t);
  await study.call("source.add", {
    id: "src-1",
    title: "OS Notes",
    text: "Option A holds when the precondition holds in all processes. Deadlock requires four conditions.",
    courses: ["OS"],
  });
  await study.call("course.save", { name: "OS", focusTopics: ["死锁"] });
  await study.store.update((s) => {
    const seeded = schedule(initialReview(s.settings), 4, "2026-09-20T08:00:00Z", s.settings);
    s.decks.push({
      id: "os-deck",
      title: "OS Deck",
      course: "OS",
      cards: [
        makeQuiz("c-normal", "进程概念", { review: structuredClone(seeded) }),
        makeQuiz("c-focus", "死锁四个条件", { review: structuredClone(seeded) }),
      ],
    });
    s.focus = { mode: "class", course: "OS" };
  });

  // Toggle card.focus explicitly and revert to test both card-level and course-level focus
  const toggled = await study.call("card.focus", { deckId: "os-deck", cardId: "c-normal", focus: true });
  assert.equal(toggled.focus, true);
  const untoggled = await study.call("card.focus", { deckId: "os-deck", cardId: "c-normal", focus: false });
  assert.equal(untoggled.focus, false);

  const started = await study.call("review.start", { mode: "path", course: "OS", daily: true, fresh: true });
  assert.equal(started.card.id, "c-focus", "focus card comes first in the daily round");
  assert.equal(started.card.focus, true);
  assert.equal(started.card.focusSource, "course");

  const ansFocus = await study.call("review.answer", { runId: started.id, cardId: "c-focus", selected: ["a"], confidence: 4 });
  assert.equal(ansFocus.feedback.focusScheduled, true);
  const afterNext = await study.call("review.move", { runId: started.id, direction: 1 });
  assert.equal(afterNext.card.id, "c-normal");
  assert.equal(afterNext.card.focus, undefined);
  const ansNormal = await study.call("review.answer", { runId: started.id, cardId: "c-normal", selected: ["a"], confidence: 4 });
  assert.equal(ansNormal.feedback.focusScheduled, undefined);
  assert.ok(
    Date.parse(ansFocus.feedback.nextDue) < Date.parse(ansNormal.feedback.nextDue),
    `focus nextDue (${ansFocus.feedback.nextDue}) is earlier than normal (${ansNormal.feedback.nextDue})`,
  );
});

test("planPath, focusOnly mode, courseBatch, snapshot, and crunch/period plans all prioritise focus content", async (t) => {
  const study = await makeService(t);
  await study.call("course.save", { name: "OS", focusTopics: ["银行家算法"] });
  await study.store.update((s) => {
    const cards = [];
    // 15 ordinary fresh cards followed by 2 focus fresh cards at the end of the deck:
    // without focus prioritisation, newLimit=10 would starve the 2 focus cards!
    for (let i = 1; i <= 15; i++) cards.push(makeQuiz(`ord-${i}`, `普通章节 ${i}`));
    cards.push(makeQuiz("foc-course", "银行家算法安全性检查"));
    cards.push(makeQuiz("foc-card", "页面置换细节", { focus: true }));
    s.decks.push({ id: "os-deck", title: "OS Ch 1", course: "OS", cards });
    s.focus = { mode: "class", course: "OS" };
  });

  // Default reading order ('reading') keeps new cards in chapter/material order without jumping p.94 focus ahead of p.1
  const defaultSnap = await study.call("snapshot");
  assert.equal(defaultSnap.today.focusTotal, 2);
  assert.equal(defaultSnap.today.focusRound, 0, "reading-order default starts with the first 10 chapter cards rather than jumping ahead");
  assert.equal(defaultSnap.next.topic, "普通章节 1");

  // Opting into 'focus' newCardOrder pulls focus new cards to the front for pre-exam cramming
  await study.call("settings.practice.set", { patch: { newCardOrder: "focus" } });
  const snap = await study.call("snapshot");
  assert.equal(snap.today.focusTotal, 2);
  assert.equal(snap.today.focusRound, 2, "with newCardOrder=focus, both focus cards enter the 10-new-card daily round despite sitting at index 15 and 16");
  assert.equal(snap.next.topic, "银行家算法安全性检查");
  assert.equal(snap.next.focus, true);

  // Dedicated focusOnly practice run ("只练重点")
  const focusRun = await study.call("review.start", { mode: "path", course: "OS", focusOnly: true, fresh: true });
  assert.equal(focusRun.focusOnly, true);
  assert.equal(focusRun.total, 2);
  assert.deepEqual(
    focusRun.navigation.map((entry) => entry.cardId),
    ["foc-course", "foc-card"],
  );
  assert.ok(focusRun.navigation.every((entry) => entry.focus === true));

  // Course route batch also pulls the chapter's focus fresh cards first
  const exported = await study.call("export");
  const batch = courseBatch(exported, { course: "OS", count: 3 });
  assert.deepEqual(batch.fresh.slice(0, 2).map((item) => item.card.id), ["foc-course", "foc-card"]);

  // Crunch & period plans give focus points higher weight so they receive more study minutes
  const points = [
    { id: "p-ord", order: 0, tested: 0, weakness: 0.6, questions: 4, size: 1000, pitfalls: 0, focus: false },
    { id: "p-foc", order: 1, tested: 0, weakness: 0.6, questions: 4, size: 1000, pitfalls: 0, focus: true },
  ];
  const crunch = crunchPlan({ points, papers: 0, today: "2026-11-01", examDate: "2026-11-06", minutesPerDay: 90 });
  assert.ok(crunch.scores["p-foc"].weight > crunch.scores["p-ord"].weight);
  assert.equal(crunch.order.learn[0], "p-foc");

  const period = periodPlan({
    points,
    papers: 0,
    today: "2026-11-01",
    plan: { version: 1, startDate: "2026-11-01", minutesPerDay: 90 },
    examDate: "2026-11-12",
  });
  assert.ok(period.scores["p-foc"].weight > period.scores["p-ord"].weight);
  assert.equal(period.order.learn[0], "p-foc");
  assert.equal(isFocusCard(makeQuiz("x", "银行家算法"), { focusTopics: ["银行家算法"] }), true);
  assert.equal(planPath(exported.decks, () => undefined, { focusOnly: true, isFocus: (_d, c) => !!c.focus }).size, 1);
});
