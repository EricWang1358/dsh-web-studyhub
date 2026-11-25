import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { isTeachSkipAllPhrase, isTeachSkipPhrase } from "../lib/teaching.js";
import { libraryContracts } from "../lib/study-contracts.js";

/* #1318: skipping a guided-teaching step (and revealing the rest) never calls the model and never counts as mastery.
   The base behaviour landed with #1396; what this file holds is the part that was still missing: the learner can say
   「直接讲完」 / "skip all" as their *answer* and the remaining steps are revealed instead of being graded as an answer. */

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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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

test("#1318: skip-all phrases are recognised, single-skip phrases are not swallowed by them", () => {
  // zh: the learner names the rest, not one step
  assert.equal(isTeachSkipAllPhrase("直接讲完"), true);
  assert.equal(isTeachSkipAllPhrase("直接讲完吧"), true);
  assert.equal(isTeachSkipAllPhrase("那剩下的直接讲吧"), true);
  assert.equal(isTeachSkipAllPhrase("剩下的直接讲给我听"), true);
  assert.equal(isTeachSkipAllPhrase("剩下的都讲一遍。"), true);
  assert.equal(isTeachSkipAllPhrase("直接告诉我剩下的"), true);
  assert.equal(isTeachSkipAllPhrase("全部跳过"), true);
  // en
  assert.equal(isTeachSkipAllPhrase("skip all"), true);
  assert.equal(isTeachSkipAllPhrase("Show me the rest."), true);
  assert.equal(isTeachSkipAllPhrase("skip the remaining steps"), true);
  // one step stays one step
  assert.equal(isTeachSkipAllPhrase("跳过"), false);
  assert.equal(isTeachSkipAllPhrase("skip this step"), false);
  assert.equal(isTeachSkipAllPhrase("我不会"), false);
  assert.equal(isTeachSkipPhrase("直接讲完"), false);
  // a real explanation that happens to contain the words is an answer, not an intent
  assert.equal(isTeachSkipAllPhrase("剩下的直接讲给我听是一种取巧，真正的理解需要自己推导每一步的因果"), false);
  assert.equal(isTeachSkipAllPhrase("skip all the checks because the cache is warm"), false);
});

test("#1318: typing 「直接讲完」 as the answer reveals every remaining step with 0 model calls", async (t) => {
  const { service, run, getCalls } = await setup(t);
  const started = await service.call("teach.start", { runId: run.id, mode: "understanding", language: "zh" });
  assert.equal(getCalls(), 1, "plan generation is the only model call so far");
  assert.equal(started.index, 0);

  const revealed = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "直接讲完" });
  assert.equal(getCalls(), 1, "skip-all MUST NOT call the model");
  assert.equal(revealed.complete, true);
  assert.equal(revealed.masteredCount, 0, "a revealed step is never mastery");
  assert.deepEqual(revealed.skippedSteps.map((step) => step.index), [0, 1, 2]);
  assert.match(revealed.feedback, /Step 1: Each byte has a sequence number/);
  assert.match(revealed.feedback, /Step 2: Cumulative ACK/);
  assert.match(revealed.feedback, /Step 3: Missing segments/);
  assert.ok(revealed.transfer);

  const stored = (await service.store.read()).teaching.find((item) => item.id === started.id);
  assert.equal(stored.mastered_rungs.length, 0);
  assert.equal(stored.skipped_rungs.length, 3);
});

test("#1318: an English learner typing \"skip all\" gets the same reveal, in English", async (t) => {
  const { service, run, getCalls } = await setup(t);
  const started = await service.call("teach.start", { runId: run.id, mode: "understanding", language: "en" });
  assert.equal(getCalls(), 1);
  const revealed = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "Skip the rest please." });
  assert.equal(getCalls(), 1, "skip-all MUST NOT call the model");
  assert.equal(revealed.complete, true);
  assert.equal(revealed.skippedSteps.length, 3);
  assert.match(revealed.feedback, /Skipped remaining 3 step/);
  assert.match(revealed.feedback, /not counted as mastered/);
});

test("#1318: a single skip still advances one step, two misses nudge, and only a passed check counts as mastery", async (t) => {
  const { service, run, getCalls } = await setup(t);
  const started = await service.call("teach.start", { runId: run.id, mode: "understanding", language: "zh" });
  assert.equal(JSON.stringify(started).includes("First byte of the segment"), false, "rung answers stay hidden before reveal");

  const miss = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "wrong" });
  assert.equal(miss.index, 0);
  assert.equal(miss.wrongTries, 1);
  const miss2 = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "wrong again" });
  assert.equal(miss2.wrongTries, 2, "two misses are what the panel's nudge keys on");

  const skippedOnce = await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "跳过" });
  assert.equal(getCalls(), 3, "a typed single skip MUST NOT call the model");
  assert.equal(skippedOnce.index, 1);
  assert.equal(skippedOnce.wrongTries, 0);
  assert.equal(skippedOnce.skippedSteps.length, 1);
  assert.equal(skippedOnce.masteredCount, 0);

  const done = await service.call("teach.answer", { id: started.id, stepIndex: 1, answer: "skip all" });
  assert.equal(done.complete, true);
  assert.equal(done.masteredCount, 0);
  assert.equal(done.skippedSteps.length, 3);
});

test("#1318/#1395: skipping records no help evidence, so it is never counted as using a hint", async (t) => {
  const { service, run, getCalls } = await setup(t);
  const started = await service.call("teach.start", { runId: run.id, mode: "understanding", language: "zh" });
  await service.call("teach.answer", { id: started.id, stepIndex: 0, answer: "直接讲完" });
  assert.equal(getCalls(), 1);
  const state = await service.store.read();
  const card = state.decks.flatMap((deck) => deck.cards).find((item) => item.id === "c1");
  assert.equal(card.socratic, undefined, "a skipped rung must not write a Socratic help record");
  const entry = state.runs.find((item) => item.id === run.id).entries.find((item) => item.card.id === "c1");
  assert.equal(entry?.socratic, undefined, "and must not stamp help onto the round's question either");
});

test("#1318: the model-facing contract names teach.skip so the assistant can reveal the rest", () => {
  assert.match(libraryContracts.learning, /teach\.start \{runId\}, teach\.get \{id\}, teach\.answer \{id,answer\}, teach\.skip/);
});
