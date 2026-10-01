import test from "node:test";
import assert from "node:assert/strict";
import { groupOf, mergeOrder, placeAt, sameOrder } from "../ui/nav-order.js";

const defaults = { main: ["a", "b", "c", "d"], upkeep: ["x", "y", "z"] };

test("a saved order is applied, forgotten pages are dropped and new pages go last in their group", () => {
  assert.deepEqual(mergeOrder({ main: ["c", "a", "gone", "c"], upkeep: ["z"] }, defaults), { main: ["c", "a", "b", "d"], upkeep: ["z", "x", "y"] });
  assert.deepEqual(mergeOrder(null, defaults), defaults);
  assert.deepEqual(mergeOrder({ main: "nonsense", upkeep: [1, 2] }, defaults), defaults, "a damaged saved value is ignored");
  assert.deepEqual(mergeOrder({ main: ["x", "a"] }, defaults).main, ["a", "b", "c", "d"], "a page from another group cannot move in");
});

test("moving an item changes only its own group", () => {
  assert.deepEqual(placeAt(defaults, "d", 0), { main: ["d", "a", "b", "c"], upkeep: defaults.upkeep });
  assert.deepEqual(placeAt(defaults, "a", 2), { main: ["b", "c", "a", "d"], upkeep: defaults.upkeep });
  assert.deepEqual(placeAt(defaults, "x", 99), { main: defaults.main, upkeep: ["y", "z", "x"] }, "past the end means last");
  assert.deepEqual(placeAt(defaults, "y", -5).upkeep, ["y", "x", "z"], "before the start means first");
  assert.equal(placeAt(defaults, "nope", 1), defaults);
  assert.equal(groupOf(defaults, "y"), "upkeep");
  assert.equal(groupOf(defaults, "nope"), undefined);
});

test("orders are compared item by item", () => {
  assert.ok(sameOrder(defaults, mergeOrder(null, defaults)));
  assert.ok(!sameOrder(defaults, placeAt(defaults, "b", 2)));
  assert.ok(sameOrder(placeAt(defaults, "a", 0), defaults), "putting an item where it already is changes nothing");
});
