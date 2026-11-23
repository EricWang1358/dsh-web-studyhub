import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { isSkipIntent, isSkipAllIntent } from "../lib/teaching.js";

const quote = "TCP uses sequence numbers and cumulative acknowledgements for reliable delivery.";
const plan = () => ({
  diagnosis: "Need to connect sequence numbers, ACKs, and retransmissions.",
  transfer: "Always trace what the receiver ACKs when a segment is lost.",
  rungs: [
    { lesson: "Step 1: Each byte has a sequence number.", check: "What does SEQ identify?", answer: "First byte of the segment" },
    { lesson: "Step 2: Cumulative ACK names the next expected byte.", check: "What does ACK=500 mean?", answer: "Bytes up to 499 received" },
    { lesson: "Step 3: Missing segments trigger retransmission.", check: "How does sender detect loss?", answer: "Timeout or 3 duplicate ACKs" },
  ],
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-teach-skip-1318-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelCalls = 0;
  const service = new StudyService(root, {
    complete: async (_sys, prompt) => {
      modelCalls++;
      const parsed = JSON.parse(prompt);
      if (parsed.learnerAnswer) {
        if (/correct/i.test(parsed.learnerAnswer)) return JSON.stringify({ passed: true, feedback: "Correct!" });
        return JSON.stringify({ passed: false, feedback: "Not quite, try again." });
      }
      return JSON.stringify(plan());
    },
  });
  await service.store.update((s) => {
    s.sources.push({ id: "s1", title: "TCP", text: quote });
    s.decks.push({
      id: "d1",
      title: "Networks",
      cards: [{
        id: "c1",
        kind: "flashcard",
        topic: "TCP",
        objective: "Understand TCP reliability",
        hint: "Think of cumulative ACKs",
        prompt: "How does TCP recover from packet loss?",
        answer: "Cumulative ACKs and retransmission.",
        explanation: "TCP tracks bytes via sequence numbers.",
        misconception: "Confusing selective vs cumulative ACK.",
        citations: [{ sourceId: "s1", quote }],
      }],
    });
  });
  const run = await service.call("review.start", { deckId: "d1", mode: "flashcard" });
  await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 1 });
  return { service, run, getCalls: () => modelCalls };
}

test("#1318: isSkipIntent detects Chinese/English skip phrases without catching real explanations", () => {
  assert.equal(isSkipIntent("跳过"), true);
  assert.equal(isSkipIntent("跳过，下一问"), true);
  assert.equal(isSkipIntent("不会"), true);
  assert.equal(isSkipIntent("skip"), true);
  assert.equal(isSkipIntent("I don't know."), true);
  assert.equal(isSkipAllIntent("剩下的直接讲给我听"), true);
  assert.equal(isSkipAllIntent("skip all"), true);
  // Real explanation mentioning 跳过 must NOT trigger skip
  assert.equal(isSkipIntent("TCP 接收端不会跳过丢失的字节，而是重复确认上一个连续字节"), false);
});

test("#1318: teach.skip and skip phrases advance with 0 model calls, reveal key points, exclude skipped from mastered, and suggest skip after 2 misses", async (t) => {
  const { service, run, getCalls } = await setup(t);
  const started = await service.call("teach.start", { runId: run.id, mode: "understanding", language: "zh" });
  assert.equal(getCalls(), 1);
  assert.equal(started.index, 0);
  assert.equal(started.suggestSkip, false);
  assert.equal(started.skippedCount, 0);
  assert.equal(JSON.stringify(started).includes("First byte of the segment"), false, "answer stays hidden before skip");

  // Two wrong answers on step 0 -> suggestSkip becomes true
  const miss1 = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "wrong 1" });
  assert.equal(getCalls(), 2);
  assert.equal(miss1.index, 0);
  assert.equal(miss1.stepAttempts, 1);
  assert.equal(miss1.suggestSkip, false);

  const miss2 = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "wrong 2" });
  assert.equal(getCalls(), 3);
  assert.equal(miss2.index, 0);
  assert.equal(miss2.stepAttempts, 2);
  assert.equal(miss2.suggestSkip, true);

  // Explicit teach.skip on step 0 -> 0 model calls, shows step 0 lesson + reference, advances to step 1
  const afterSkip0 = await service.call("teach.skip", { id: started.id, stepIndex: 0 });
  assert.equal(getCalls(), 3, "teach.skip MUST NOT call the model");
  assert.equal(afterSkip0.index, 1);
  assert.equal(afterSkip0.stepAttempts, 0);
  assert.equal(afterSkip0.suggestSkip, false);
  assert.equal(afterSkip0.skippedCount, 1);
  assert.equal(afterSkip0.masteredCount, 0);
  assert.match(afterSkip0.feedback, /Step 1: Each byte has a sequence number/);
  assert.equal(afterSkip0.stepStatuses[0], "skipped");

  // Natural-language skip phrase via teach.answer on step 1 -> ALSO 0 model calls!
  const afterPhraseSkip1 = await service.call("teach.answer", { id: started.id, stepIndex: 1, answer: "跳过，下一问" });
  assert.equal(getCalls(), 3, "skip phrase in teach.answer MUST NOT call the model");
  assert.equal(afterPhraseSkip1.index, 2);
  assert.equal(afterPhraseSkip1.skippedCount, 2);
  assert.equal(afterPhraseSkip1.masteredCount, 0);
  assert.match(afterPhraseSkip1.feedback, /Step 2: Cumulative ACK/);

  // Pass step 2 normally -> 1 model call, completes session, lists skipped steps 0 & 1 and masteredCount === 1
  const done = await service.call("teach.answer", { id: started.id, stepIndex: 2, answer: "correct timeout or 3 dup ACKs" });
  assert.equal(getCalls(), 4);
  assert.equal(done.complete, true);
  assert.equal(done.masteredCount, 1);
  assert.equal(done.skippedCount, 2);
  assert.deepEqual(done.skippedSteps.map((s) => s.index), [0, 1]);
  assert.deepEqual(done.stepStatuses, ["skipped", "skipped", "mastered"]);

  const stored = (await service.store.read()).teaching.find((x) => x.id === started.id);
  assert.equal(stored.mastered_rungs.length, 1);
  assert.equal(stored.skipped_rungs.length, 2);
});

test("#1318: teach.skip { all: true } ends teaching immediately with all remaining lessons and 0 model calls", async (t) => {
  const { service, run, getCalls } = await setup(t);
  const started = await service.call("teach.start", { runId: run.id, mode: "understanding", language: "zh" });
  assert.equal(getCalls(), 1);

  const finished = await service.call("teach.skip", { id: started.id, stepIndex: 0, all: true });
  assert.equal(getCalls(), 1, "skip all MUST NOT call the model");
  assert.equal(finished.complete, true);
  assert.equal(finished.masteredCount, 0);
  assert.equal(finished.skippedCount, 3);
  assert.match(finished.feedback, /Step 1/);
  assert.match(finished.feedback, /Step 2/);
  assert.match(finished.feedback, /Step 3/);
  assert.ok(finished.transfer);
});
