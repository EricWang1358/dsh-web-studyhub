import test from "node:test";
import assert from "node:assert/strict";
import { NAV_START_KEY, START_PAGES, isStartPage, markStart, readStarts, startHere } from "../ui/nav-start.js";

/* 「从这里开始」 (3.7 guidance, step 5): the five sidebar entries a learner needs first carry one small marker until they have opened the page.
   The marker hides nothing, locks nothing and does not reorder the rail; the memory of what was opened is one list in this browser, read and
   written through ui/storage.js (nav-order.js does the same). These are the pure rules; the rail's markup is in nav-consistency.test.mjs. */

/** A localStorage lookalike for one test; a failing one says the browser refuses storage. */
function store(entries = {}, { blocked = false } = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => { if (blocked) throw new Error("blocked"); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (blocked) throw new Error("blocked"); map.set(key, String(value)); },
    removeItem: (key) => { if (blocked) throw new Error("blocked"); map.delete(key); },
  };
}

test("the five starting entries are 学习库, 资料, 创建题组, 错题与待巩固 and 回到题目", () => {
  assert.deepEqual([...START_PAGES], ["library", "sources", "generate", "wrongbook", "review"]);
  for (const id of START_PAGES) assert.equal(isStartPage(id), true, id);
  for (const id of ["settings", "dashboard", "notes", "tasks", "board"]) assert.equal(isStartPage(id), false, id);
});

test("nothing remembered means every marker is still there", () => {
  const storage = store();
  assert.deepEqual(readStarts(storage), []);
  for (const id of START_PAGES) assert.equal(startHere(id, readStarts(storage)), true, id);
  assert.equal(startHere("settings", []), false, "a page that never had the marker never gets one");
});

test("opening a page remembers it once; the marker of that page, and only that page, goes away", () => {
  const storage = store();
  assert.deepEqual(markStart("sources", storage), ["sources"]);
  assert.deepEqual(markStart("sources", storage), ["sources"], "opening it again adds nothing");
  assert.deepEqual(readStarts(storage), ["sources"]);
  assert.equal(startHere("sources", readStarts(storage)), false);
  assert.equal(startHere("library", readStarts(storage)), true);
  assert.deepEqual(JSON.parse(storage.map.get(NAV_START_KEY)), ["sources"], "one list, in this browser");
  assert.match(NAV_START_KEY, /^study-nav-start:/, "a key of its own, versioned like the rail's order (ui/nav-order.js)");
});

test("only the five entries can be remembered, and a damaged list reads as nothing", () => {
  const storage = store();
  assert.deepEqual(markStart("settings", storage), [], "a page outside the starting five is not stored");
  for (const raw of ['"nope"', '{"sources":true}', 'not json', 'null']) {
    const damaged = store({ [NAV_START_KEY]: raw });
    assert.deepEqual(readStarts(damaged), [], raw);
  }
  const mixed = store({ [NAV_START_KEY]: JSON.stringify(["sources", "bogus", 7, "sources", "review"]) });
  assert.deepEqual(readStarts(mixed), ["sources", "review"], "only the five, without duplicates");
});

test("a browser that refuses storage keeps the marker gone for this visit and never throws", () => {
  const blocked = store({}, { blocked: true });
  assert.deepEqual(readStarts(blocked), []);
  assert.deepEqual(markStart("library", blocked), ["library"], "the memory of the visit still answers");
  assert.equal(startHere("library", markStart("library", blocked)), false);
  assert.deepEqual(markStart("nope", blocked), []);
  assert.doesNotThrow(() => readStarts(null));
  assert.deepEqual(readStarts(null), [], "no storage at all is the same as an empty one");
});
