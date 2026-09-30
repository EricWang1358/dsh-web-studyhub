import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

async function fixture() {
  const service = new StudyService(await mkdtemp(join(tmpdir(), "study-organize-")));
  const card = (id, topic, requires = []) => ({ id, topic, kind: "flashcard", prompt: id, answer: id, requires,
    review: { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: "2026-10-01T00:00:00.000Z" } });
  await service.store.update((s) => {
    s.decks.push({ id: "a", title: "A", folder: "course", cards: [card("one", "first"), card("two", "second", [{ deckId: "b", cardId: "three" }])] });
    s.decks.push({ id: "b", title: "B", folder: "course", cards: [card("three", "third", [{ deckId: "a", cardId: "one" }])] });
    s.attempts.push({ quiz_id: "three", deckId: "b", grade: 1, at: "2026-09-01T00:00:00.000Z" });
    s.skeletons.push({ id: "sk", scope: [{ deckId: "b", cardId: "three" }], nodes: [{ cards: [{ deckId: "b", cardId: "three" }] }] });
    s.notes.push({ id: "note", title: "Topic note", status: "published", publicUrl: "https://blog.csdn.net/example/article/details/123",
      cards: [{ deckId: "b", cardId: "three" }, { deckId: "a", cardId: "one" }] });
  });
  return service;
}

test("merge keeps all cards, schedules, attempts and prerequisite links", async () => {
  const service = await fixture();
  const result = await service.call("deck.merge", { sourceIds: ["b"], targetId: "a" });
  assert.equal(result.moved, 1);
  const state = await service.call("export");
  assert.deepEqual(state.decks.map((d) => d.id), ["a"]);
  assert.deepEqual(state.decks[0].cards.map((c) => c.id), ["one", "two", "three"]);
  assert.equal(state.decks[0].cards[2].review.repetitions, 2);
  assert.equal(state.decks[0].cards[1].requires[0].deckId, "a");
  assert.equal(state.attempts[0].deckId, "a");
  assert.equal(state.skeletons[0].nodes[0].cards[0].deckId, "a");
  assert.equal(state.notes[0].cards[0].deckId, "a");
  const view = await service.call("card.get", { cardId: "two" });
  assert.equal(view.prerequisites[0].deckId, "a");
});

test("split by topic and reorder keep card references and history", async () => {
  const service = await fixture();
  await service.store.update((state) => { state.decks.find((deck) => deck.id === "a").course = "Platform Engineering"; });
  const result = await service.call("deck.split", { id: "b", title: "Third", topics: ["third"] }).catch((error) => error);
  assert.match(result.message, /两个题组都必须有题目/);
  const split = await service.call("deck.split", { id: "a", title: "First", topics: ["first"] });
  const state = await service.call("export");
  assert.deepEqual(state.decks.map((d) => d.id), ["a", split.targetId, "b"]);
  assert.equal(state.decks[2].cards[0].requires[0].deckId, split.targetId);
  assert.equal(state.decks[1].cards[0].review.repetitions, 2);
  assert.equal(state.decks[1].course, "Platform Engineering");
  assert.equal(state.notes[0].cards[1].deckId, split.targetId);
  await service.call("deck.reorder", { ids: ["b", split.targetId, "a"] });
  assert.deepEqual((await service.call("export")).decks.map((d) => d.id), ["b", split.targetId, "a"]);
});

test("AI merge suggestions stay read-only until confirmation and reject invented IDs", async () => {
  let submitted;
  const service = new StudyService(await mkdtemp(join(tmpdir(), "study-merge-suggest-")), {
    completeLight: async (_system, prompt) => {
      submitted = JSON.parse(prompt);
      return JSON.stringify({ proposals: submitted.course === '' ? [
        { targetId: 'u', sourceIds: ['v'], reason: 'Same unassigned topic' },
      ] : [
      { targetId: "a", sourceIds: ["b"], reason: "同一主题的补充练习" },
      { targetId: "a", sourceIds: ["invented"], reason: "不应采纳" },
      ] });
    },
  });
  const card = (id) => ({ id, kind: "flashcard", prompt: id, answer: id, topic: "Architecture" });
  await service.store.update((state) => {
    state.decks.push({ id: "a", title: "Architecture 1", folder: "course", cards: [card("one")] });
    state.decks.push({ id: "b", title: "Architecture 2", folder: "course", cards: [card("two")] });
    state.decks.push({ id: "c", title: "Other course", folder: "other", cards: [card("three")] });
  });
  const suggestion = await service.call("deck.merge.suggest", { course: "course" });
  assert.equal(suggestion.proposals.length, 1);
  assert.deepEqual(suggestion.proposals[0].sourceIds, ["b"]);
  assert.equal((await service.call("export")).decks.length, 3);
  await service.call("deck.merge", { targetId: suggestion.proposals[0].targetId,
    sourceIds: suggestion.proposals[0].sourceIds });
  assert.deepEqual((await service.call("export")).decks.map((deck) => deck.id), ["a", "c"]);
  await service.store.update(state => {
    state.decks.push({ id: 'u', title: 'Unassigned 1', course: '', folder: 'course', cards: [card('u')] },
      { id: 'v', title: 'Unassigned 2', course: '', folder: 'course', cards: [card('v')] });
  });
  await service.call('focus.set', { course: 'course' });
  const unassigned = await service.call('deck.merge.suggest', { course: '' });
  assert.equal(unassigned.course, '');
  assert.deepEqual(submitted.decks.map(deck => deck.id), ['u', 'v']);
  assert.deepEqual(unassigned.proposals[0].sourceIds, ['v']);
  assert.equal((await service.call('snapshot')).focus.course, 'course');
});
