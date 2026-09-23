import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJsonImport } from "../lib/json-import.js";
import { importExample } from "../ui/json-prompts.js";
import { StudyService } from "../lib/service.js";
import { JSON_CARD_SOURCE, selfCitedCardCount } from "../lib/source-provenance.js";

for (const kind of ["quiz", "multi", "flashcard", "open", "cloze"]) {
  test(`JSON ${kind} example imports with matching citations`, () => {
    const raw = JSON.stringify(JSON.parse(importExample(kind)));
    const { source, deck } = prepareJsonImport(`\uFEFF\n\`\`\`json\n${raw}\n\`\`\``);
    assert.equal(deck.cards[0].kind, kind);
    assert.equal(source.provenance, JSON_CARD_SOURCE);
    assert.equal(selfCitedCardCount(deck.cards, [source]), 1);
    assert.ok(source.text.includes(deck.cards[0].citations[0].quote));
    assert.deepEqual(deck.quality.errors, []);
  });
}

test("invalid JSON and malformed card shapes are rejected; content defects stay in a draft", () => {
  for (const raw of ["", "text", "[]", "null", '{"cards":[]}', "x".repeat(500001)]) assert.throws(() => prepareJsonImport(raw));
  for (const mutate of [
    (q) => { q.kind = "unknown"; },
  ]) {
    const input = JSON.parse(importExample("quiz"));
    mutate(input.cards[0]);
    assert.throws(() => prepareJsonImport(JSON.stringify(input)));
  }
  const brokenOptions = JSON.parse(importExample("quiz"));
  brokenOptions.cards[0].options = [null];
  const optionDraft = prepareJsonImport(JSON.stringify(brokenOptions)).deck;
  assert.deepEqual(optionDraft.cards[0].options, []);
  assert.match(optionDraft.quality.errors.join(), /need 3–6 options/);
  const missingKey = JSON.parse(importExample("quiz"));
  delete missingKey.cards[0].options[0].correct;
  const keyDraft = prepareJsonImport(JSON.stringify(missingKey)).deck;
  assert.deepEqual(keyDraft.cards[0].options, [], "a missing correctness value must not be guessed as false");
  for (const mutate of [
    (q) => { q.options.forEach((o) => { o.correct = false; }); },
    (q) => { q.prompt = ""; },
    (q) => { q.hint = q.answer; },
  ]) {
    const input = JSON.parse(importExample("quiz"));
    mutate(input.cards[0]);
    assert.ok(prepareJsonImport(JSON.stringify(input)).deck.quality.errors.length);
  }
  const missing = JSON.parse(importExample("flashcard"));
  delete missing.cards[0].explanation;
  missing.cards[0].hint = null;
  const prepared = prepareJsonImport(JSON.stringify(missing));
  assert.equal(prepared.deck.cards[0].explanation, "");
  assert.equal(prepared.deck.cards[0].hint, "");
  assert.match(prepared.deck.quality.errors.join(), /explanation is required/);
});

test("imported answers remain visibly self-cited until an independent source replaces that citation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "json-import-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const imported = await service.call("draft.import", { text: importExample("flashcard") });
  assert.equal(selfCitedCardCount(imported.cards, (await service.call("snapshot")).sources), 1);
  await service.call("draft.publish", { id: imported.id, draftVersion: imported.draftVersion });
  assert.equal((await service.call("snapshot")).decks[0].selfCited, 1);
  const evidence = await service.call("source.add", { id: "independent", title: "Original notes",
    text: "Binary search halves a sorted interval after comparing its midpoint." });
  const edit = await service.call("deck.edit", { id: imported.id });
  const saved = await service.call("draft.save", { deck: { ...edit, cards: edit.cards.map((card) => ({ ...card,
    citations: [{ sourceId: evidence.id, quote: evidence.text }] })) } });
  await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.equal((await service.call("snapshot")).decks[0].selfCited, 0);
});

test("older JSON-import sources without provenance still show the self-citation warning", () => {
  assert.equal(selfCitedCardCount([{ citations: [{ sourceId: "legacy" }] }],
    [{ id: "legacy", title: "JSON 导入：旧题组", text: "{}" }]), 1);
});

test("JSON citations match existing source passages in bulk without trusting unmatched references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "json-import-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const passage = "Binary search discards half the remaining sorted interval after comparing its midpoint.";
  await service.call("source.add", { id: "notes", title: "Original notes", text: passage });
  const input = JSON.parse(importExample("flashcard"));
  input.cards[0].citations = [{ quote: passage }];
  input.cards.push({ ...input.cards[0], objective: "Explain a second case", prompt: "Why is order needed?",
    citations: [{ sourceId: "missing", quote: passage }] });
  const imported = await service.call("draft.import", { text: JSON.stringify(input) });
  const sources = (await service.call("snapshot")).sources;
  assert.deepEqual(imported.cards[0].citations, [{ sourceId: "notes", quote: passage }]);
  assert.equal(selfCitedCardCount(imported.cards, sources), 1);
  assert.match(imported.quality.warnings.join(), /1 条外部引用未能唯一匹配/);
  const published = await service.call("draft.publish", { id: imported.id, draftVersion: imported.draftVersion });
  assert.deepEqual({ accepted: published.accepted, rejected: published.rejected }, { accepted: 2, rejected: 0 });
  assert.equal((await service.call("snapshot")).decks[0].selfCited, 1);
});

test("ambiguous quotes need a source title or ID before replacing the import self-citation", () => {
  const passage = "Binary search discards half the remaining sorted interval after comparing its midpoint.";
  const sources = [{ id: "a", title: "Chapter A", text: passage },
    { id: "b", title: "Chapter B", text: passage }];
  const input = JSON.parse(importExample("flashcard"));
  input.cards[0].citations = [{ quote: passage }];
  const ambiguous = prepareJsonImport(JSON.stringify(input), sources);
  assert.equal(selfCitedCardCount(ambiguous.deck.cards, [ambiguous.source, ...sources]), 1);
  input.cards[0].citations[0].sourceTitle = "Chapter B";
  const resolved = prepareJsonImport(JSON.stringify(input), sources);
  assert.deepEqual(resolved.deck.cards[0].citations, [{ sourceId: "b", quote: passage }]);
  assert.equal(resolved.deck.quality.warnings.some((warning) => warning.includes("只引用题目自身")), false);
});

test("a previous JSON import is never treated as independent original evidence", () => {
  const input = JSON.parse(importExample("flashcard"));
  const passage = "Binary search discards half the remaining sorted interval after comparing its midpoint.";
  input.cards[0].citations = [{ quote: passage }];
  const previous = { id: "prior-json", title: "JSON 导入：旧题组", text: passage,
    provenance: JSON_CARD_SOURCE };
  const imported = prepareJsonImport(JSON.stringify(input), [previous]);
  assert.equal(selfCitedCardCount(imported.deck.cards, [previous, imported.source]), 1);
  assert.match(imported.deck.quality.warnings.join(), /1 条外部引用未能唯一匹配/);
});

test("malformed options in one imported quiz leave that quiz pending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "json-import-option-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const input = JSON.parse(importExample("quiz"));
  input.cards.push({ ...input.cards[0], objective: "Explain another decision",
    prompt: "Which second condition applies?", options: [null] });
  const draft = await service.call("draft.import", { text: JSON.stringify(input) });
  assert.match(draft.quality.errors.join(), /Card 2: need 3–6 options/);
  const published = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  assert.deepEqual({ accepted: published.accepted, rejected: published.rejected }, { accepted: 1, rejected: 1 });
  assert.equal((await service.call("export")).decks[0].cards.length, 1);
  assert.deepEqual(published.rejectedDraft.cards[0].options, []);
});

test("one incomplete imported card does not hold back another card", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "json-import-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const input = JSON.parse(importExample("flashcard"));
  const incomplete = { ...input.cards[0], objective: "Explain a second case", prompt: "A second question?" };
  delete incomplete.explanation;
  input.cards.push(incomplete);
  const imported = await service.call("draft.import", { text: JSON.stringify(input) });
  assert.match(imported.quality.errors.join(), /Card 2: explanation is required/);
  const published = await service.call("draft.publish", { id: imported.id, draftVersion: imported.draftVersion });
  assert.deepEqual({ accepted: published.accepted, rejected: published.rejected }, { accepted: 1, rejected: 1 });
  assert.equal((await service.call("export")).decks[0].cards.length, 1);
  assert.equal(published.rejectedDraft.cards[0].explanation, "");
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

test("decks above 100 cards can be imported, published, and extended through capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "large-deck-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const input = JSON.parse(importExample("flashcard"));
  input.cards = Array.from({ length: 101 }, (_, i) => ({ ...input.cards[0],
    prompt: `Question ${i}: when is this algorithm useful?`, objective: `Explain case ${i}` }));
  const draft = await service.call("draft.import", { text: JSON.stringify(input) });
  await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  const deck = await service.call("deck.get", { id: draft.id });
  assert.equal(deck.cards.length, 101);
  service.complete = async () => JSON.stringify({ grounded: true, card: {
    ...deck.cards[0], prompt: "Why does sorted order matter for binary search?", objective: "Explain the sorted-order prerequisite",
  } });
  await service.call("capture", { deckId: deck.id, question: "Why does sorted order matter for binary search?", answer: "It allows discarding half the search interval." });
  const expanded = await service.call("deck.get", { id: deck.id });
  assert.equal(expanded.cards.length, 102);
  await service.call("card.update", { deckId: deck.id, cardId: expanded.cards[0].id, patch: { explanation: "Updated explanation." } });
});
