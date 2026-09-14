import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJsonImport } from "../lib/json-import.js";
import { importExample } from "../ui/json-prompts.js";
import { StudyService } from "../lib/service.js";

for (const kind of ["quiz", "multi", "flashcard", "open", "cloze"]) {
  test(`JSON ${kind} example imports with matching citations`, () => {
    const raw = JSON.stringify(JSON.parse(importExample(kind)));
    const { source, deck } = prepareJsonImport(`\uFEFF\n\`\`\`json\n${raw}\n\`\`\``);
    assert.equal(deck.cards[0].kind, kind);
    assert.ok(source.text.includes(deck.cards[0].citations[0].quote));
    assert.deepEqual(deck.quality.errors, []);
  });
}

test("invalid JSON, counts, fields and answer shapes are rejected", () => {
  for (const raw of ["", "text", "[]", "null", '{"cards":[]}', "x".repeat(500001)]) assert.throws(() => prepareJsonImport(raw));
  for (const mutate of [
    (q) => { q.options = [null]; },
    (q) => { q.options.forEach((o) => { o.correct = false; }); },
    (q) => { q.prompt = ""; },
    (q) => { q.hint = q.answer; },
  ]) {
    const input = JSON.parse(importExample("quiz"));
    mutate(input.cards[0]);
    assert.throws(() => prepareJsonImport(JSON.stringify(input)));
  }
});

test("import is atomic, strips external lifecycle fields, and publishes through normal draft flow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "json-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await assert.rejects(service.call("draft.import", { text: '{"title":"bad","cards":[{}]}' }));
  const before = await service.store.read();
  assert.equal(before.sources.length, 0);
  assert.equal(before.drafts.length, 0);
  const input = JSON.parse(importExample("quiz"));
  input.editingDeckId = "existing";
  input.cards[0].review = { repetitions: 99 };
  input.cards[0].suspended = true;
  const deck = await service.call("draft.import", { text: JSON.stringify(input) });
  assert.equal(deck.editingDeckId, undefined);
  assert.equal(deck.cards[0].review, undefined);
  assert.equal(deck.cards[0].suspended, undefined);
  await service.call("draft.publish", { id: deck.id, draftVersion: deck.draftVersion });
  const state = await service.store.read();
  assert.equal(state.decks.length, 1);
  assert.equal(state.decks[0].cards[0].review.repetitions, 0);
});
