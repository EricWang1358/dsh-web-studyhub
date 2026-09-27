import test from "node:test";
import assert from "node:assert/strict";
import { queuePanelIntent, takePanelIntent, setPanelVisible, panelObservation,
  registerPanelNotifier } from "../lib/panel-bridge.js";

test("panel intent is consumed once and expires", () => {
  queuePanelIntent("bridge-once", { type: "run", runId: "r1" }, 1000);
  assert.equal(takePanelIntent("bridge-once", 1001).runId, "r1");
  assert.equal(takePanelIntent("bridge-once", 1002), null);
  queuePanelIntent("bridge-expired", { type: "run", runId: "r2" }, 1000);
  assert.equal(takePanelIntent("bridge-expired", 121001), null);
});

test("visible sidebar card and grading are observed without repeated notices", () => {
  const notices = [];
  registerPanelNotifier("bridge-view", (value) => notices.push(value));
  const main = { id: "original", deckId: "d", card: { id: "one" }, index: 3, total: 10 };
  const temporary = { id: "temporary", deckId: "d", card: { id: "two" }, index: 0, total: 1,
    feedback: { selected: ["b"], correct: false, grade: 1 } };
  setPanelVisible("bridge-view", "main", main, 1000);
  setPanelVisible("bridge-view", "sidebar", temporary, 2000);
  setPanelVisible("bridge-view", "sidebar", temporary, 3000);
  assert.equal(panelObservation("bridge-view").cardId, "two");
  assert.deepEqual(panelObservation("bridge-view").selected, ["b"]);
  assert.equal(panelObservation("bridge-view").correct, false);
  assert.equal(notices.length, 2);
  setPanelVisible("bridge-view", "sidebar", null);
  assert.equal(panelObservation("bridge-view").cardId, "one");
});

test("a delayed visibility request cannot overwrite the newer screen", () => {
  const first = { id: "first", card: { id: "a" }, index: 0 };
  const second = { id: "second", card: { id: "b" }, index: 0 };
  setPanelVisible("bridge-ordered", "sidebar", second, 2000, 2);
  setPanelVisible("bridge-ordered", "sidebar", first, 3000, 1);
  assert.equal(panelObservation("bridge-ordered").cardId, "b");
  setPanelVisible("bridge-ordered", "sidebar", null, 4000, 3);
  setPanelVisible("bridge-ordered", "sidebar", second, 5000, 2);
  assert.equal(panelObservation("bridge-ordered"), null);
});
