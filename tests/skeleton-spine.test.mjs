import test from "node:test";
import assert from "node:assert/strict";
import { skeletonSpine } from "../ui/skeleton-spine.js";

const card = (cardId) => ({ deckId: "d", cardId });

test("top-level nodes become ordered stations with nested branches", () => {
  const spine = skeletonSpine({
    nodes: [
      { id: "a", term: "Behavioural", meaning: "m", cards: [card("1")] },
      { id: "a1", term: "Memento", parent: "a", cards: [card("2"), card("1")] },
      { id: "a1x", term: "Caretaker", parent: "a1", cards: [card("3")] },
      { id: "b", term: "Structural", cards: [] },
      { id: "b1", term: "Bridge", parent: "b", cards: [card("4")] },
    ],
    relations: [{ from: "a1", to: "b1", type: "contrasts" }, { from: "a", to: "b", type: "related" }],
  });
  assert.deepEqual(spine.map((s) => [s.step, s.term]), [[1, "Behavioural"], [2, "Structural"]]);
  assert.deepEqual(spine[0].children.map((c) => c.term), ["Memento"]);
  assert.deepEqual(spine[0].children[0].children.map((c) => c.term), ["Caretaker"]);
  assert.equal(spine[0].children[0].children[0].depth, 2);
  assert.deepEqual(spine[0].subtreeCards.map((c) => c.cardId), ["1", "2", "3"], "subtree cards are deduplicated");
  assert.deepEqual(spine[0].children[0].contrasts, ["Bridge"]);
  assert.deepEqual(spine[1].children[0].contrasts, ["Memento"]);
});

test("unknown parents and parent cycles never drop a node", () => {
  const spine = skeletonSpine({
    nodes: [
      { id: "x", term: "Orphan", parent: "missing", cards: [] },
      { id: "p", term: "P", parent: "q", cards: [] },
      { id: "q", term: "Q", parent: "p", cards: [] },
    ],
  });
  const terms = (list) => list.flatMap((s) => [s.term, ...terms(s.children)]);
  assert.deepEqual(terms(spine).sort(), ["Orphan", "P", "Q"]);
  assert.equal(spine[0].term, "Orphan");
});
