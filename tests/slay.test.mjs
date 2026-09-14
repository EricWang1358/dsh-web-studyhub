import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { importExample } from "../ui/json-prompts.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-slay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const draft = await service.call("draft.import", { text: importExample("mixed") });
  await service.call("draft.publish", { id: draft.id });
  return { service, deck: await service.call("deck.get", { id: draft.id }) };
}

test("slay skips current card and retries without grading, restores original state and links", async (t) => {
  const { service, deck } = await setup(t);
  const run = await service.call("review.start", { deckId: deck.id, mode: "flashcard" });
  const card = deck.cards.find((c) => c.id === run.card.id);
  const dependent = deck.cards.find((c) => c.id !== card.id);
  await service.call("card.link", { deckId: deck.id, cardId: dependent.id, requires: { deckId: deck.id, cardId: card.id } });
  const before = await service.store.read();
  const next = await service.call("card.slay", { runId: run.id, deckId: deck.id, cardId: card.id });
  assert.equal(next.total, run.total - 1);
  assert.notEqual(next.card?.id, card.id);
  let state = await service.store.read();
  const slain = state.decks.find((d) => d.systemKind === "slain");
  assert.equal(slain.archived, true);
  assert.equal(slain.cards[0].suspended, true);
  assert.deepEqual(state.attempts, before.attempts);
  assert.deepEqual(slain.cards[0].review, card.review);
  assert.equal(state.decks.find((d) => d.id === deck.id).cards.find((c) => c.id === dependent.id).requires[0].deckId, slain.id);
  await assert.rejects(service.call("review.start", { deckId: slain.id, mode: "due" }));
  await assert.rejects(service.call("deck.archive", { id: slain.id, archived: false }));
  await assert.rejects(service.call("deck.edit", { id: slain.id }));
  await assert.rejects(service.call("card.suspend", { deckId: slain.id, cardId: card.id, suspended: false }));
  await service.call("card.restore", { deckId: slain.id, cardId: card.id });
  state = await service.store.read();
  const restored = state.decks.find((d) => d.id === deck.id);
  assert.deepEqual(restored.cards.find((c) => c.id === card.id).review, card.review);
  assert.equal(restored.cards.find((c) => c.id === card.id).suspended, false);
  assert.equal(restored.cards.find((c) => c.id === dependent.id).requires[0].deckId, deck.id);
});

test("concurrent slays across decks use one workspace collection and repeat requests do not duplicate", async (t) => {
  const { service, deck } = await setup(t);
  const other = await service.call("draft.import", { text: importExample("flashcard") });
  await service.call("draft.publish", { id: other.id });
  await Promise.all([
    service.call("card.slay", { deckId: deck.id, cardId: deck.cards[0].id }),
    service.call("card.slay", { deckId: other.id, cardId: other.cards[0].id }),
  ]);
  await service.call("card.slay", { deckId: deck.id, cardId: deck.cards[0].id });
  const state = await service.store.read();
  assert.equal(state.decks.filter((d) => d.systemKind === "slain").length, 1);
  assert.equal(state.decks.find((d) => d.systemKind === "slain").cards.length, 2);
  const snapshot = await service.call("snapshot");
  assert.equal(snapshot.decks.find((d) => d.systemKind === "slain").count, 2);
});

test("slay synchronizes editing drafts and blocks stale saves from resurrecting cards", async (t) => {
  const { service, deck } = await setup(t);
  const stale = await service.call("deck.edit", { id: deck.id });
  const result = await service.call("card.slay", { deckId: deck.id, cardId: deck.cards[0].id });
  await assert.rejects(service.call("draft.save", { deck: stale }), /changed/);
  let state = await service.store.read();
  const draft = state.drafts.find((d) => d.id === stale.id);
  assert.equal(draft.cards.length, deck.cards.length - 1);
  await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  await service.call("card.restore", { deckId: result.deckId, cardId: deck.cards[0].id });
  state = await service.store.read();
  assert.equal(state.decks.find((d) => d.id === deck.id).cards.length, deck.cards.length);
});

test("slaying final card completes review, preserves attempts and restores previous suspension", async (t) => {
  const { service } = await setup(t);
  const d = await service.call("draft.import", { text: importExample("flashcard") });
  await service.call("draft.publish", { id: d.id });
  const run = await service.call("review.start", { deckId: d.id, mode: "flashcard" });
  await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 1 });
  await service.call("card.suspend", { deckId: d.id, cardId: run.card.id, suspended: true });
  const before = await service.store.read();
  const next = await service.call("card.slay", { runId: run.id, deckId: d.id, cardId: run.card.id });
  assert.equal(next.complete, true);
  assert.equal(next.total, 0);
  let state = await service.store.read();
  assert.deepEqual(state.attempts, before.attempts);
  const slain = state.decks.find((d) => d.systemKind === "slain");
  await service.call("card.restore", { deckId: slain.id, cardId: run.card.id });
  state = await service.store.read();
  assert.equal(state.decks.find((x) => x.id === d.id).cards[0].suspended, true);
});
