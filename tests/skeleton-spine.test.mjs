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

import { spineCounts, spineDefaultOpen, spineOpenKey, readSpineOpen, writeSpineOpen } from "../ui/skeleton-spine.js";

test("the counts are stations and the points under them, at any depth", () => {
  const spine = skeletonSpine({
    nodes: [
      { id: "a", term: "A" }, { id: "a1", term: "A1", parent: "a" }, { id: "a1x", term: "A1x", parent: "a1" },
      { id: "b", term: "B" }, { id: "b1", term: "B1", parent: "b" },
    ],
  });
  assert.deepEqual(spineCounts(spine), { stations: 2, points: 3 });
  assert.deepEqual(spineCounts([]), { stations: 0, points: 0 });
});

test("the spine is expanded by default only where the skeleton is the subject of the step", () => {
  assert.equal(spineDefaultOpen("skeleton"), true);
  for (const kind of ["lesson", "overview", "recall", "reflection", "practice", "", undefined]) assert.equal(spineDefaultOpen(kind), false, String(kind));
});

test("the folded state is kept per browser and per step type, and a blocked storage never throws", () => {
  const data = new Map();
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)) };
  assert.notEqual(spineOpenKey("lesson"), spineOpenKey("skeleton"));
  assert.equal(readSpineOpen("lesson", storage), false, "falls back to the default");
  assert.equal(readSpineOpen("skeleton", storage), true);
  writeSpineOpen("lesson", true, storage);
  writeSpineOpen("skeleton", false, storage);
  assert.equal(readSpineOpen("lesson", storage), true);
  assert.equal(readSpineOpen("skeleton", storage), false);
  assert.equal(readSpineOpen("recall", storage), false, "other step types keep their own default");
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readSpineOpen("skeleton", blocked), true);
  assert.doesNotThrow(() => writeSpineOpen("skeleton", false, blocked));
  assert.equal(readSpineOpen("lesson", null), false);
});
