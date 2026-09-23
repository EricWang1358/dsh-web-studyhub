import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { notify } from "../lib/inbox.js";

const quote = "Bridge separates an abstraction from its implementation so the two can vary independently.";
const card = (id, prompt) => ({
  id, kind: "flashcard", topic: "Bridge", objective: `Explain ${id}`, prompt, answer: "Two dimensions vary independently.",
  hint: "Two reasons to change.", explanation: "Composition over inheritance.", misconception: "It adapts interfaces.",
  citations: [{ sourceId: "s1", quote }],
});
async function setup(t, options) {
  const root = await mkdtemp(join(tmpdir(), "study-inbox-"));
  const service = new StudyService(root, options);
  t.after(() => rm(root, { recursive: true, force: true }));
  await service.call("source.add", { id: "s1", title: "Bridge", text: quote });
  await service.call("draft.save", { deck: { id: "d1", title: "Patterns", cards: [
    card("c1", "Why use Bridge for reports and renderers?"),
    card("c2", "What does Bridge separate?"),
    card("c3", "When is Bridge overkill?"),
  ] } });
  await service.call("draft.publish", { id: "d1" });
  return service;
}

test("conversation edits and links post letters that persist, fold per card and can be read", async (t) => {
  const service = await setup(t);
  assert.deepEqual((await service.call("snapshot")).inbox, { unread: 0, items: [] });

  await service.call("card.update", { cardId: "c1", patch: { hint: "Count the reasons to change." }, reason: "补充提示" });
  await service.call("card.update", { cardId: "c1", patch: { hint: "Two independent axes." }, reason: "再改提示" });
  await service.call("card.link", { deckId: "d1", cardId: "c1", requires: { deckId: "d1", cardId: "c2" } });
  await service.call("card.link", { deckId: "d1", cardId: "c1", requires: { deckId: "d1", cardId: "c2" } }); // already linked: no letter

  let inbox = (await service.call("snapshot")).inbox;
  assert.equal(inbox.unread, 2);
  const [link, improve] = inbox.items;
  assert.equal(link.kind, "link");
  assert.match(link.detail, /What does Bridge separate/);
  assert.equal(improve.kind, "improve");
  assert.equal(improve.count, 2, "two unread edits of one card fold into one letter");
  assert.equal(improve.detail, "再改提示");
  assert.equal(improve.prompt, "Why use Bridge for reports and renderers?");
  assert.equal(improve.deckTitle, "Patterns");

  const reopened = new StudyService(service.store.root);
  assert.equal((await reopened.call("inbox")).unread, 2, "letters survive reopening the library");

  inbox = await service.call("inbox.read", { ids: [link.id] });
  assert.equal(inbox.unread, 1);
  inbox = await service.call("inbox.read", { all: true });
  assert.equal(inbox.unread, 0);
  assert.equal(inbox.items.length, 2, "reading keeps the history");
});

test("opening a letter lands on the card inside the current run, else a one-card run that returns", async (t) => {
  const service = await setup(t);
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1" }], fresh: true });
  const targetIndex = run.navigation.find((n) => n.cardId === "c3").index;
  await service.store.update((s) => { notify(s, { kind: "followup", deckId: "d1", cardId: "c3", detail: "为什么？" }); });
  const letter = (await service.call("inbox")).items[0];

  const moved = await service.call("inbox.open", { id: letter.id, runId: run.id });
  assert.equal(moved.id, run.id);
  assert.equal(moved.index, targetIndex);
  assert.equal(moved.card.id, "c3");
  assert.equal((await service.call("inbox")).unread, 0);

  // A card outside every open run gets its own run, titled as from the mailbox.
  await service.call("review.end", { runId: run.id });
  const other = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "c1" }], fresh: true });
  await service.store.update((s) => { notify(s, { kind: "coach", deckId: "d1", cardId: "c2", detail: "陪学点" }); });
  const coach = (await service.call("inbox")).items[0];
  const single = await service.call("inbox.open", { id: coach.id, runId: other.id });
  assert.notEqual(single.id, other.id);
  assert.equal(single.card.id, "c2");
  assert.equal(single.total, 1);
  assert.equal(single.returnTo, other.id);
  assert.equal(single.title, "信箱 · 1 道");

  await service.store.update((s) => {
    notify(s, { kind: "improve", deckId: "d1", cardId: "gone", detail: "x" });
  });
  const gone = (await service.call("inbox")).items[0];
  assert.equal(gone.missing, true);
  await assert.rejects(service.call("inbox.open", { id: gone.id }), /不在题库/);
});

test("a background followup answer posts a letter", async (t) => {
  const service = await setup(t, {
    completeLight: async () => JSON.stringify({ question: "为什么要拆成两个维度？", answer: "因为两者独立变化。" }),
  });
  await service.call("card.followup", { deckId: "d1", cardId: "c2", question: "为啥拆" });
  const [letter] = (await service.call("inbox")).items;
  assert.equal(letter.kind, "followup");
  assert.equal(letter.cardId, "c2");
  assert.equal(letter.detail, "为什么要拆成两个维度？");
});
