import test from "node:test";
import assert from "node:assert/strict";
import { shareUnchanged, sameExceptFingerprint, mergePartial } from "../ui/snapshot-share.js";

const snapshot = (overrides = {}) => ({ revision: 1, fingerprint: "a", sources: [{ id: "s1", title: "One", chars: 10 }], decks: [{ id: "d1", count: 3 }], progress: { d1: { due: 2 } }, ...overrides });

test("an identical poll hands back the previous snapshot itself", () => {
  const first = shareUnchanged(null, snapshot());
  assert.equal(first.changed, true, "the first snapshot is a change");
  const second = shareUnchanged(first.value, snapshot(), first.texts);
  assert.equal(second.changed, false);
  assert.equal(second.value, first.value, "nothing changed, so the same object: no render, no recomputation");
});

test("a changed key is new while unchanged keys keep their identity", () => {
  const first = shareUnchanged(null, snapshot());
  const second = shareUnchanged(first.value, snapshot({ revision: 2, progress: { d1: { due: 1 } } }), first.texts);
  assert.equal(second.changed, true);
  assert.notEqual(second.value, first.value);
  assert.equal(second.value.sources, first.value.sources, "sources did not change: a memo keyed on data.sources stays valid");
  assert.equal(second.value.decks, first.value.decks);
  assert.notEqual(second.value.progress, first.value.progress);
  assert.deepEqual(second.value.progress, { d1: { due: 1 } });
  assert.equal(second.value.revision, 2);
});

test("a key that disappears or appears is a change", () => {
  const first = shareUnchanged(null, snapshot());
  const { fingerprint: _gone, ...without } = snapshot();
  assert.equal(shareUnchanged(first.value, without, first.texts).changed, true);
  assert.equal(shareUnchanged(first.value, snapshot({ extra: [] }), first.texts).changed, true);
});

test("a snapshot that only rolled its fingerprint over counts as quiet for the poll rhythm", () => {
  const first = shareUnchanged(null, snapshot());
  const rolled = shareUnchanged(first.value, snapshot({ fingerprint: "b" }), first.texts);
  assert.equal(rolled.changed, true, "the panel still takes the new fingerprint");
  assert.equal(sameExceptFingerprint(first.value, rolled.value), true);
  const moved = shareUnchanged(rolled.value, snapshot({ fingerprint: "c", progress: { d1: { due: 0 } } }), rolled.texts);
  assert.equal(sameExceptFingerprint(rolled.value, moved.value), false, "a real change is not quiet");
  assert.equal(sameExceptFingerprint(null, first.value), false);
  assert.equal(sameExceptFingerprint(first.value, first.value), true);
  const { sources: _gone, ...fewer } = first.value;
  assert.equal(sameExceptFingerprint(first.value, fewer), false, "a key that disappeared is a change");
});

test("the texts of one poll feed the next, and carry through unchanged keys", () => {
  let state = shareUnchanged(null, snapshot());
  for (let poll = 0; poll < 3; poll++) state = shareUnchanged(state.value, snapshot(), state.texts);
  assert.equal(state.changed, false);
  assert.equal(state.texts.sources, JSON.stringify(snapshot().sources));
});

test("a partial answer (only the clock moved) keeps every key it does not carry, and the ones it carries unchanged", () => {
  const first = shareUnchanged(null, snapshot({ today: { due: 2 } }));
  const merged = mergePartial(first.value, { partial: true, fingerprint: "b", progress: { d1: { due: 3 } }, today: { due: 2 }, decks: [{ id: "d1", count: 3 }] }, first.texts);
  assert.equal(merged.changed, true);
  assert.equal(merged.value.partial, undefined, "the marker is not part of the snapshot");
  assert.equal(merged.value.fingerprint, "b", "the next poll sends the new fingerprint");
  assert.deepEqual(merged.value.progress, { d1: { due: 3 } });
  assert.equal(merged.value.sources, first.value.sources, "a key the answer does not carry keeps its object");
  assert.equal(merged.value.revision, first.value.revision);
  assert.equal(merged.value.today, first.value.today, "a key it carries with the same text keeps its object too");
  assert.equal(merged.value.decks, first.value.decks);
  assert.ok(sameExceptFingerprint(merged.value, { ...first.value, progress: merged.value.progress, fingerprint: "c" }));
  // The texts follow, so the next whole snapshot compares against what the panel now holds.
  const again = shareUnchanged(merged.value, { ...snapshot({ today: { due: 2 } }), fingerprint: "b", progress: { d1: { due: 3 } } }, merged.texts);
  assert.equal(again.changed, false);
  assert.equal(again.value, merged.value);
});

test("a partial answer that moved only the fingerprint is a quiet poll", () => {
  const first = shareUnchanged(null, snapshot());
  const merged = mergePartial(first.value, { partial: true, fingerprint: "b" }, first.texts);
  assert.equal(merged.changed, true, "the fingerprint is held, so it is written");
  assert.ok(sameExceptFingerprint(first.value, merged.value), "the poll rhythm counts it as unchanged");
  assert.equal(merged.value.sources, first.value.sources);
});
