import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-search-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", { id: "web", title: "Web", text: "An iframe embeds another document. Shadow DOM provides encapsulation." });
  await service.store.update((s) => {
    s.decks.push({ id: "web-deck", title: "Web cards", cards: [
      { id: "iframe-card", kind: "flashcard", topic: "Web", prompt: "What does an iframe embed?", answer: "Another document." },
    ] });
  });
  return service;
}

test("source and card searches accept common payload names and find aliases", async (t) => {
  const service = await setup(t);
  for (const domain of ["source", "card"]) {
    const canonical = await service.call(`${domain}.search`, { query: "iframe" });
    assert.equal(canonical.results.length, 1);
    for (const action of [`${domain}.search`, `${domain}.find`]) {
      for (const field of ["query", "terms", "q", "keywords"]) {
        for (const value of ["IFRAME", [" iframe ", "IFRAME"]]) {
          assert.deepEqual(await service.call(action, { [field]: value }), canonical, `${action} with ${field}`);
        }
      }
    }
  }
});

test("query precedence, phrase arrays, and source scope survive normalization", async (t) => {
  const service = await setup(t);
  assert.deepEqual((await service.call("source.find", { query: "iframe", q: "missing" })).terms, ["iframe"]);
  const found = await service.call("source.search", { keywords: ["Shadow DOM"], sourceIds: ["web"], context: 20, limit: 1 });
  assert.deepEqual(found.terms, ["shadow dom"]);
  assert.equal(found.results[0].sourceId, "web");
  assert.equal((await service.call("source.find", { q: "iframe", sourceIds: ["other"] })).matchedSources, 0);
});

test("invalid queries explain valid payloads rather than searching coerced objects", async (t) => {
  const service = await setup(t);
  for (const action of ["source.search", "card.search", "source.find", "card.find"]) {
    for (const payload of [{}, { q: " " }, { keywords: ["x"] }, { query: {} }, { query: 42 }, { terms: [null] }]) {
      await assert.rejects(service.call(action, payload), /at least one term.*\{"query":"iframe"\}.*keywords/);
    }
  }
});
