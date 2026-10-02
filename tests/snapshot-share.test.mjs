import test from "node:test";
import assert from "node:assert/strict";
import { shareUnchanged, sameExceptFingerprint } from "../ui/snapshot-share.js";

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
