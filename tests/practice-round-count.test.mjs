import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";
import { importExample } from "../ui/json-prompts.js";
import { roundPosition } from "../lib/round-position.js";

/* #660: a wrong answer queues one extra try at the end of the round. The round stays the size it was when it started; the extra try is named as a
   re-ask (再练), never counted as a bigger round. The one place that says it is lib/round-position.js, which the run, the sidebar list and the
   course rows all read. */

const entries = (...retry) => retry.map((value) => ({ retry: !!value }));
// The learner on question `index` has answered the ones before it (a question set aside with 先跳过 is the exception, tested below).
const at_ = ({ entries: queue, index }) => ({ entries: queue.map((entry, place) => (place < index ? { ...entry, feedback: { correct: true } } : entry)), index });

test("roundPosition: the size is the questions of the round, a re-ask does not grow it", () => {
  const queue = entries(0, 0, 0, 0, 1);
  assert.deepEqual(roundPosition(at_({ entries: queue, index: 0 })), { total: 4, at: 1, retries: 1, retryAt: 0, last: false });
  assert.deepEqual(roundPosition(at_({ entries: queue, index: 3 })), { total: 4, at: 4, retries: 1, retryAt: 0, last: false });
  assert.deepEqual(roundPosition(at_({ entries: queue, index: 4 })), { total: 4, at: 4, retries: 1, retryAt: 1, last: true }, "the re-ask is the end of a full round");
  assert.deepEqual(roundPosition(at_({ entries: queue, index: 5 })), { total: 4, at: 4, retries: 1, retryAt: 0, last: true }, "past the end: the round is full");
});

test("roundPosition: several re-asks are counted one by one, and no re-ask means none", () => {
  const queue = entries(0, 0, 1, 1);
  assert.deepEqual(roundPosition(at_({ entries: queue, index: 2 })), { total: 2, at: 2, retries: 2, retryAt: 1, last: false });
  assert.deepEqual(roundPosition(at_({ entries: queue, index: 3 })), { total: 2, at: 2, retries: 2, retryAt: 2, last: true });
  assert.deepEqual(roundPosition(at_({ entries: entries(0, 0, 0), index: 1 })), { total: 3, at: 2, retries: 0, retryAt: 0, last: false });

});

test("roundPosition: 完成 waits for a question set aside with 先跳过; an exam goes by order", () => {
  const queue = entries(0, 0, 0).map((entry, place) => (place === 1 ? { ...entry, feedback: { correct: true } } : entry));
  assert.equal(roundPosition({ entries: queue, index: 2 }).last, false, "question 1 was set aside and still waits");
  assert.equal(roundPosition({ entries: queue, index: 0 }).last, false, "back on question 1, question 3 still waits");
  const done = queue.map((entry, place) => (place === 2 ? { ...entry, feedback: { correct: true } } : entry));
  assert.equal(roundPosition({ entries: done, index: 0 }).last, true, "the set-aside question is the only one left");
  assert.equal(roundPosition({ entries: queue, index: 2, mode: "exam" }).last, true, "an exam: the last in order");
  assert.equal(roundPosition({ entries: done, index: 0, mode: "exam" }).last, false);
});

async function started(t) {
  const root = await mkdtemp(join(tmpdir(), "study-round-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const card = JSON.parse(importExample("quiz")).cards[0];
  const text = "Bridge separates an abstraction from its implementation so the two can vary independently.";
  await service.call("source.add", { id: "s", title: "Bridge", text });
  await service.call("draft.save", { deck: { id: "d", title: "Round count", cards: ["q1", "q2", "q3", "q4"].map((id) => (
    { ...card, id, prompt: `${card.prompt} (${id})`, objective: `${card.objective} (${id})`, citations: [{ sourceId: "s", quote: text }] })) } });
  await service.call("draft.publish", { id: "d" });
  return { service, run: await service.call("review.start", { deckId: "d", mode: "quiz" }) };
}
const wrong = { selected: ["b"] }, right = { selected: ["a"] };
const at = (run) => [run.position.at, run.position.total];

test("a wrong answer keeps the round at 4 questions: 1/4 stays 2/4, and the re-ask is named", async (t) => {
  const { service, run: first } = await started(t);
  assert.deepEqual([first.total, ...at(first)], [4, 1, 4]);
  let run = await service.call("review.answer", { runId: first.id, cardId: first.card.id, ...wrong });
  assert.equal(run.feedback.retryQueued, true);
  assert.deepEqual([run.total, run.questions, ...at(run), run.position.retries], [4, 4, 1, 4, 1], "the total did not grow; one re-ask is waiting");
  run = await service.call("review.move", { runId: run.id, direction: 1 });
  assert.deepEqual([run.total, ...at(run)], [4, 2, 4], "the next question is 2 of the same 4");
  for (const answer of [right, right, right]) {
    run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, ...answer });
    run = await service.call("review.move", { runId: run.id, direction: 1 });
  }
  assert.equal(run.retry, true, "the fifth stop is the re-ask");
  assert.deepEqual([run.total, ...at(run), run.position.retryAt, run.position.retries], [4, 4, 4, 1, 1], "a full round, plus re-ask 1 of 1");
  assert.equal(run.complete, false);
});

test("wrong twice on one question: still one re-ask, the round is the same size", async (t) => {
  const { service, run: first } = await started(t);
  const args = { runId: first.id, cardId: first.card.id };
  let run = await service.call("review.answer", { ...args, ...wrong });
  run = await service.call("review.answer", { ...args, ...wrong });
  assert.deepEqual([run.total, run.position.retries], [4, 1], "submitting the same wrong answer again queues nothing more");
  for (let step = 0; step < 4; step++) {
    run = await service.call("review.move", { runId: run.id, direction: 1 });
    if (step < 3) run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, ...right });
  }
  assert.equal(run.retry, true);
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, ...wrong });
  assert.deepEqual([run.total, run.position.retries, run.position.retryAt], [4, 1, 1], "a second wrong answer on the re-ask queues no second re-ask");
  assert.equal((await service.call("review.move", { runId: run.id, direction: 1 })).complete, true);
});

test("a right answer queues nothing: the round is the questions and nothing else", async (t) => {
  const { service, run: first } = await started(t);
  const run = await service.call("review.answer", { runId: first.id, cardId: first.card.id, ...right });
  assert.deepEqual([run.total, run.position.retries, run.feedback.retryQueued], [4, 0, undefined]);
});

test("the library lists (sidebar, deck rows) say the same size and never run past it", async (t) => {
  const { service, run: first } = await started(t);
  let run = await service.call("review.answer", { runId: first.id, cardId: first.card.id, ...wrong });
  for (let step = 0; step < 4; step++) {
    run = await service.call("review.move", { runId: run.id, direction: 1 });
    if (step < 3) run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, ...right });
  }
  assert.equal(run.retry, true);
  const snapshot = await service.call("snapshot");
  assert.deepEqual([snapshot.lastRun.total, snapshot.lastRun.index + 1], [4, 4], "the sidebar shows 4/4 while the re-ask is open");
  const listed = snapshot.runs?.find((item) => item.id === run.id);
  assert.ok(listed, "the open round is in the library's list of rounds");
  assert.deepEqual([listed.total, listed.index + 1], [4, 4]);
});
