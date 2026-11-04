import test from "node:test";
import assert from "node:assert/strict";
import { groupOf, keyMove, mergeOrder, migrateOrder, placeAt, sameOrder } from "../ui/nav-order.js";

/* The rules of the sidebar's order on a small made-up sidebar (#654): a main list and the sections of 「更多」. Every page has a home section; it
   sits either in the main list or in its home, never in another section, and the main list has a limit. */
const homes = { a: "s1", b: "s1", c: "s2", d: "s2", x: "s1", y: "s2", z: "s2" };
const defaults = { main: ["a", "b", "c", "d"], s1: ["x"], s2: ["y", "z"] };
const options = { homes, limit: 4 };

test("a saved order is applied, forgotten pages are dropped and new pages go to their default place", () => {
  assert.deepEqual(mergeOrder({ main: ["c", "a", "gone", "c"], s1: [], s2: ["z"] }, defaults, options), { main: ["c", "a", "b", "d"], s1: ["x"], s2: ["z", "y"] });
  assert.deepEqual(mergeOrder(null, defaults, options), defaults);
  assert.deepEqual(mergeOrder({ main: "nonsense", s2: [1, 2] }, defaults, options), defaults, "a damaged saved value is ignored");
});

test("a page sits in the main list or in its own section, never in another section", () => {
  assert.deepEqual(mergeOrder({ main: ["a", "b", "c"], s1: ["x", "d"], s2: ["d", "y", "z"] }, defaults, options),
    { main: ["a", "b", "c"], s1: ["x"], s2: ["d", "y", "z"] }, "d was taken out of the main list: it goes home to s2, not to s1");
  assert.deepEqual(mergeOrder({ main: ["x", "a", "b", "c"], s1: [], s2: ["d", "y", "z"] }, defaults, options),
    { main: ["x", "a", "b", "c"], s1: [], s2: ["d", "y", "z"] }, "a page of 更多 dragged into the main list stays there");
  assert.deepEqual(mergeOrder({ main: ["x", "y", "a", "b", "c", "d"] }, defaults, options).main, ["x", "y", "a", "b"], "the main list keeps its limit; the rest go home");
});

test("an order saved before the sections keeps the learner's sequence inside every new group", () => {
  // The old sidebar had groups by frequency; each saved group was the learner's own order.
  const old = { daily: ["d", "x", "a"], periodic: ["z", "b"], setup: ["c", "y"] };
  assert.deepEqual(migrateOrder(old, defaults, options), { main: ["d", "a", "b", "c"], s1: ["x"], s2: ["z", "y"] });
  // The even older main / upkeep shape is one sequence too.
  assert.deepEqual(migrateOrder({ main: ["c", "b"], upkeep: ["z", "a"] }, defaults, options), { main: ["c", "b", "a", "d"], s1: ["x"], s2: ["z", "y"] });
  assert.deepEqual(migrateOrder(null, defaults, options), defaults);
  assert.deepEqual(migrateOrder({ daily: "broken", setup: [7, "y", "y"] }, defaults, options), defaults, "only the readable part counts");
});

test("moving a page inside its group, and between the main list and its home", () => {
  assert.deepEqual(placeAt(defaults, "d", 0, undefined, options), { ...defaults, main: ["d", "a", "b", "c"] });
  assert.deepEqual(placeAt(defaults, "a", 2, undefined, options).main, ["b", "c", "a", "d"]);
  assert.deepEqual(placeAt(defaults, "z", 99, undefined, options).s2, ["y", "z"], "past the end means last");
  assert.deepEqual(placeAt(defaults, "a", 0, "s1", options), { main: ["b", "c", "d"], s1: ["a", "x"], s2: ["y", "z"] }, "a main page goes home");
  assert.equal(placeAt(defaults, "c", 0, "s1", options), defaults, "never into another section");
  assert.equal(placeAt(defaults, "x", 0, "main", options), defaults, "the main list is full");
  const roomy = placeAt(defaults, "a", 0, "s1", options);
  assert.deepEqual(placeAt(roomy, "y", 1, "main", options).main, ["b", "y", "c", "d"]);
  assert.equal(placeAt(defaults, "nope", 1, undefined, options), defaults);
  assert.equal(groupOf(defaults, "y"), "s2");
  assert.equal(groupOf(defaults, "nope"), undefined);
});

test("the keyboard moves past the end of a group into the main list or back home (Alt+↑ / Alt+↓)", () => {
  const roomy = { main: ["a", "b", "c"], s1: ["x"], s2: ["d", "y", "z"] };
  assert.deepEqual(keyMove(roomy, "b", -1, options), { order: { ...roomy, main: ["b", "a", "c"] }, id: "b", group: "main", position: 1, count: 3 });
  assert.deepEqual(keyMove(roomy, "d", -1, options), { order: { main: ["a", "b", "c", "d"], s1: ["x"], s2: ["y", "z"] }, id: "d", group: "main", position: 4, count: 4 },
    "the first page of a section goes up into the main list, at its end");
  assert.deepEqual(keyMove(roomy, "c", 1, options), { order: { main: ["a", "b"], s1: ["x"], s2: ["c", "d", "y", "z"] }, id: "c", group: "s2", position: 1, count: 4 },
    "the last page of the main list goes down to the top of its home");
  assert.deepEqual(keyMove(defaults, "y", -1, options), { refused: "full", id: "y" }, "a full main list says so");
  assert.equal(keyMove(roomy, "a", -1, options), null, "nothing above the first main page");
  assert.equal(keyMove(roomy, "z", 1, options), null, "nothing below the last page of a section");
});

test("orders are compared item by item", () => {
  assert.ok(sameOrder(defaults, mergeOrder(null, defaults, options)));
  assert.ok(!sameOrder(defaults, placeAt(defaults, "b", 2, undefined, options)));
  assert.ok(sameOrder(placeAt(defaults, "a", 0, undefined, options), defaults), "putting an item where it already is changes nothing");
});
