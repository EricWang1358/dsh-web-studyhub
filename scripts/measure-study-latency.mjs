// Isolated model-latency fixture; never opens the user's library or network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const root = await mkdtemp(join(tmpdir(), "study-latency-"));
let calls = 0;
const service = new StudyService(root, { completeLight: async (_system, prompt) => {
  calls++;
  await new Promise((resolve) => setTimeout(resolve, 100));
  return JSON.stringify(JSON.parse(prompt).task
    ? { explain: "换一个角度理解这个概念。" }
    : { questions: ["为什么？", "怎么用？", "能举例吗？"] });
} });

try {
  await service.store.update((s) => {
    s.decks.push({ id: "d", title: "Demo", cards: [{ id: "c", kind: "flashcard", topic: "Demo", prompt: "Question", answer: "Answer", citations: [] }] });
    s.coach = [{ id: "n", type: "nudge", deckId: "d", cardId: "c", point: "Concept", explain: "First explanation", followups: [] }];
  });
  const started = performance.now();
  await Promise.all([1, 2].map(() => service.call("coach.reply", { noteId: "n", reply: "confused" })));
  const reply = { modelCalls: calls, elapsedMs: Math.round(performance.now() - started), savedFollowups: (await service.store.read()).coach[0].followups.length };
  calls = 0;
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await service.call("card.followup.suggest", { cardId: "c" });
    samples.push(Math.round((performance.now() - start) * 10) / 10);
  }
  const start = performance.now();
  const snapshot = await service.call("snapshot");
  const fullMs = performance.now() - start;
  const pollStart = performance.now();
  const poll = await service.call("snapshot", { since: snapshot.fingerprint });
  console.log(JSON.stringify({ simulatedModelMs: 100, concurrentReply: reply, suggestions: { modelCalls: calls, elapsedMs: samples }, tinyLibrarySnapshot: { fullMs, unchangedMs: performance.now() - pollStart, unchanged: poll.unchanged } }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
