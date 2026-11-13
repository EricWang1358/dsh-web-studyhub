import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";
import { createAssistService } from "../lib/assist.js";
import { gradeClozeSpokenLocal, normalizeVoiceOpenGrading } from "../lib/contexts/study/voice-assessment.js";
import { encodeWavPcm16, isAudioSetupError } from "../ui/voice/mic.js";
import { shortcutAction } from "../ui/review/session-logic.js";

async function waitAssist(assist, root, taskId) {
  for (let i = 0; i < 200; i++) {
    const task = assist.assistView(root).tasks.find((item) => item.id === taskId);
    if (task && task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`assist task ${taskId} did not settle`);
}

test("encodeWavPcm16 builds RIFF/WAVE PCM16 blob and isAudioSetupError spots decoupled audio setup errors", async () => {
  const blob = encodeWavPcm16([new Int16Array([100, -100, 200, -200])], 16000);
  assert.equal(blob.name, "voice-clip.wav");
  assert.equal(blob.size, 44 + 8);
  const head = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
  assert.equal(head, "RIFF");
  assert.equal(isAudioSetupError(new Error("Unknown action: audio.upload.start")), true);
  assert.equal(isAudioSetupError(new Error("请先在「设置 › 音频转写」中配置语音识别 API Key")), true);
  assert.equal(isAudioSetupError(new Error("网络超时")), false);
});

test("gradeClozeSpokenLocal hits with 0 LLM calls when spoken transcript matches all blanks", () => {
  const card = {
    id: "clz-1",
    kind: "cloze",
    prompt: "补全",
    cloze: {
      text: "重试必须配合 {{b1}} 和 {{b2}}。",
      answers: [
        { id: "b1", value: "幂等", accept: ["幂等性"] },
        { id: "b2", value: "指数退避", accept: [] },
      ],
    },
  };
  const hit = gradeClozeSpokenLocal(card, "第一空填幂等性，第2空是指数退避。");
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.answers, { b1: "幂等性", b2: "指数退避" });

  const miss = gradeClozeSpokenLocal(card, "大概是防重和等一会儿");
  assert.equal(miss.hit, false);
});

test("cloze spoken fast-path uses 0 LLM calls and schedules FSRS; choice cards stay excluded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-voice-cloze-"));
  let llmCalls = 0;
  const service = new StudyService(root, {
    complete: async () => { llmCalls++; return "{}"; },
    transcribeUpload: async ({ uploadId }) => ({ text: "第1空幂等性，第2空指数退避", uploadId, durationSec: 2.1 }),
  });
  await service.store.update((s) => {
    s.decks.push({
      id: "d1",
      title: "Reliability",
      cards: [
        {
          id: "c-cloze",
          kind: "cloze",
          topic: "重试",
          prompt: "补全重试机制",
          cloze: {
            text: "重试依赖 {{b1}} 与 {{b2}}",
            answers: [{ id: "b1", value: "幂等", accept: ["幂等性"] }, { id: "b2", value: "指数退避", accept: [] }],
          },
        },
        {
          id: "c-choice",
          kind: "quiz",
          topic: "单选",
          prompt: "哪个对？",
          options: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }],
        },
      ],
    });
  });

  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "c-cloze" }, { deckId: "d1", cardId: "c-choice" }], fresh: true });
  const assist = createAssistService();
  t.after(() => assist.dispose());

  // Choice cards must refuse mode: 'grade'.
  await assert.rejects(
    assist.startAssist({}, {
      root, service, sessionId: "panel", mode: "grade",
      ref: { deckId: "d1", cardId: "c-choice" }, runId: run.id, uploadId: "upload-abc-001",
      card: { id: "c-choice", kind: "quiz", options: [{ id: "a" }] }, deckTitle: "Reliability",
    }),
    /选择题保持传统点选作答/,
  );

  const started = await assist.startAssist({}, {
    root, service, sessionId: "panel", mode: "grade",
    ref: { deckId: "d1", cardId: "c-cloze" }, runId: run.id, uploadId: "upload-cloze-01",
    card: run.card, deckTitle: "Reliability",
  });
  const done = await waitAssist(assist, root, started.id);
  assert.equal(done.status, "done", done.message);
  assert.equal(llmCalls, 0, "cloze local exact match makes 0 LLM calls");

  const view = await service.call("review.get", { runId: run.id });
  assert.equal(view.feedback.correct, true);
  assert.equal(view.feedback.grade, 4);
  assert.equal(view.feedback.transcript, "第1空幂等性，第2空指数退避");
  assert.deepEqual(view.feedback.answers, { b1: "幂等性", b2: "指数退避" });
  assert.equal(view.feedback.correctionPending, undefined);
});

test("flashcard/open enforces fragmentsOnly cap + 3-stage correction gate + review.grade.adjust + voice ask", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-voice-open-"));
  const service = new StudyService(root, {
    complete: async (_sys, prompt) => {
      const data = JSON.parse(prompt);
      if (data.mode === "ask") {
        return JSON.stringify({ answer: "幂等保证多次重试效果等价于一次执行。" });
      }
      // Deliberately return inflated grade: 4 paired with fragmentsOnly: true!
      return JSON.stringify({
        fragmentsOnly: true,
        grade: 4,
        summary: "只说出了零散关键词，缺少状态去重与原因链。",
        criteria: [
          { id: "c1", label: "核心定义", max: 3, score: 1, evidence: ["幂等"], missing: ["状态去重条件"], suggestion: "补充幂等键存储与原子校验" },
          { id: "c2", label: "边界场景", max: 2, score: 0, evidence: [], missing: ["网络超时 vs 业务失败"], suggestion: "区分可重试异常" },
        ],
        correction: {
          keywordExpansion: "可以用幂等键配合唯一索引保证同一请求只落库一次。",
          phrasingUpgrade: {
            informal: "就是那个幂等加锁防止重复扣钱",
            professional: "通过唯一幂等键（Idempotency Key）配合事务内状态机或唯一约束实现请求去重。",
          },
          missingLinks: ["未说明幂等键过期窗口"],
        },
      });
    },
    transcribeUpload: async ({ uploadId }) => ({
      text: uploadId.includes("ask") ? "为什么超时才需要幂等" : "就是那个幂等加锁防止重复扣钱",
    }),
  });
  await service.store.update((s) => {
    s.decks.push({
      id: "d1",
      title: "Backend",
      cards: [
        { id: "o1", kind: "open", topic: "幂等性", prompt: "如何设计支付接口的幂等性？", answer: "唯一幂等键+状态机" },
        { id: "f1", kind: "flashcard", topic: "退避", prompt: "指数退避要加什么？", answer: "随机抖动 Jitter" },
      ],
    });
  });

  // Also test pure normalizer clamping directly.
  const clamped = normalizeVoiceOpenGrading({ fragmentsOnly: true, grade: 5, criteria: [{ id: "c1", label: "K", max: 5, score: 4 }] }, { transcript: "幂等" });
  assert.equal(clamped.grade, 2, "fragmentsOnly clamps grade <= 2");

  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "o1" }, { deckId: "d1", cardId: "f1" }], fresh: true });
  const assist = createAssistService();
  t.after(() => assist.dispose());

  // 1. Voice Answer (even after autopilot moves run.index to card 2!)
  const tGrade = await assist.startAssist({}, {
    root, service, sessionId: "panel", mode: "grade",
    ref: { deckId: "d1", cardId: "o1" }, runId: run.id, uploadId: "upload-ans-0001",
    card: run.card, deckTitle: "Backend",
  });
  // Simulate autopilot moving to card 2 while card 1's STT/LLM finishes in background.
  await service.call("review.move", { runId: run.id, index: 1 });
  const doneGrade = await waitAssist(assist, root, tGrade.id);
  assert.equal(doneGrade.status, "done", doneGrade.message);

  let state = await service.call("export");
  const entry0 = state.runs.find((r) => r.id === run.id).entries[0];
  assert.equal(entry0.feedback.grade, 2, "fragmentsOnly prevents inflated FSRS score >= 3");
  assert.equal(entry0.feedback.transcript, "就是那个幂等加锁防止重复扣钱");
  assert.equal(entry0.feedback.correction.phrasingUpgrade.professional.includes("Idempotency Key"), true);

  // Lower manually to grade 1 -> triggers 3-stage correctionPending gate WITHOUT pushing retry yet!
  let view = await service.call("review.grade.adjust", { runId: run.id, cardId: "o1", entryIndex: 0, grade: 1 });
  assert.equal(view.pendingCorrections.length, 1);
  state = await service.call("export");
  const runStored = state.runs.find((r) => r.id === run.id);
  assert.equal(runStored.entries.filter((e) => e.retry).length, 0, "retry is NOT queued before learner clicks 我看懂了 · 加入重练");
  assert.equal(runStored.entries[0].feedback.correctionPending, true);

  // Acknowledge correction -> pushes retry onto run.entries!
  view = await service.call("review.correction.ack", { runId: run.id, cardId: "o1", entryIndex: 0 });
  assert.equal(view.pendingCorrections, undefined);
  state = await service.call("export");
  assert.equal(state.runs.find((r) => r.id === run.id).entries.filter((e) => e.retry).length, 1);
  assert.equal(state.runs.find((r) => r.id === run.id).entries[0].feedback.correctionViewed, true);

  // 2. Voice Ask routes cleanly into followups without creating an answer attempt.
  const attemptsBeforeAsk = state.attempts.length;
  const tAsk = await assist.startAssist({}, {
    root, service, sessionId: "panel", mode: "ask",
    ref: { deckId: "d1", cardId: "f1" }, runId: run.id, uploadId: "upload-ask-0001",
    card: { id: "f1", prompt: "指数退避要加什么？" }, deckTitle: "Backend",
  });
  const doneAsk = await waitAssist(assist, root, tAsk.id);
  assert.equal(doneAsk.status, "done", doneAsk.message);
  state = await service.call("export");
  assert.equal(state.attempts.length, attemptsBeforeAsk, "voice ask never writes a review attempt");
  const f1Followups = state.decks[0].cards[1].followups;
  assert.equal(f1Followups.at(-1).question, "为什么超时才需要幂等");
});

test("decoupled audio fallback rejects uploadId cleanly when audio is absent while text grading still works", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-voice-fallback-"));
  const service = new StudyService(root, {
    complete: async () => JSON.stringify({
      fragmentsOnly: false,
      grade: 4,
      summary: "回答完整",
      criteria: [{ id: "c1", label: "核心", max: 5, score: 4, evidence: ["唯一键"], missing: [], suggestion: "" }],
    }),
  });
  // Force decoupled no-audio state by hiding runtime action.
  service.hasAudioClipSupport = () => false;
  await service.store.update((s) => {
    s.decks.push({ id: "d1", title: "T", cards: [{ id: "o1", kind: "open", topic: "T", prompt: "Q?", answer: "唯一键" }] });
  });
  const assist = createAssistService();
  t.after(() => assist.dispose());
  await assert.rejects(
    assist.startAssist({}, {
      root, service, sessionId: "panel", mode: "grade",
      ref: { deckId: "d1", cardId: "o1" }, uploadId: "upload-missing-01",
      card: { id: "o1", kind: "open", prompt: "Q?" }, deckTitle: "T",
    }),
    /设置 › 音频转写/,
  );

  // Text grading works even with audio disabled.
  const tText = await assist.startAssist({}, {
    root, service, sessionId: "panel", mode: "grade",
    ref: { deckId: "d1", cardId: "o1" }, text: "用唯一键实现去重",
    card: { id: "o1", kind: "open", prompt: "Q?" }, deckTitle: "T",
  });
  const done = await waitAssist(assist, root, tText.id);
  assert.equal(done.status, "done", done.message);
});

test("keyboard shortcuts bind V / Shift+V only on non-choice non-exam practice cards", () => {
  const ctx = { inside: true, modalOpen: false, page: "review", busy: false, shortcutHelp: false, selected: [], clozeValues: {} };
  const baseEv = { code: "KeyV", shiftKey: false, repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false };

  const flashHit = shortcutAction({ ...baseEv, key: "v" }, { ...ctx, choice: false, isCloze: false, rubricCard: false, run: { mode: "path", card: { kind: "flashcard" }, feedback: null, revealed: false } });
  assert.equal(flashHit.action.type, "voice-answer");

  const choiceIgnored = shortcutAction({ ...baseEv, key: "v" }, { ...ctx, choice: true, isCloze: false, rubricCard: false, run: { mode: "path", card: { kind: "quiz", options: [{ id: "a" }] }, feedback: null, revealed: false } });
  assert.equal(choiceIgnored.action, null);

  const askHit = shortcutAction({ ...baseEv, key: "V", shiftKey: true }, { ...ctx, choice: true, isCloze: false, rubricCard: false, run: { mode: "path", card: { kind: "quiz" }, feedback: null, revealed: true } });
  assert.equal(askHit.action.type, "voice-ask");
});
