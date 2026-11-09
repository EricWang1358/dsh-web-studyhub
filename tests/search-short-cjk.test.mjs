import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";
import { foldText, searchTerms } from "../lib/query-input.js";

const PREFIX = "㈱ﬁ".repeat(30); // each of these changes length under a plain NFKC fold
const LONG = `${PREFIX}熵是系统混乱程度的度量。`;
const HELP = /at least one term.*2\+ characters.*one Chinese.*\{"query":"iframe"\}/s;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-search-cjk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", { id: "cn", title: "热力学", text: "第一章 熵是系统混乱程度的度量。酶是催化剂。" });
  await service.call("source.add", { id: "wide", title: "Wide", text: "ＡＢＣ１２３ is typed in full-width letters. Later ＩＦＲＡＭＥ appears." });
  await service.call("source.add", { id: "long", title: "Long", text: LONG });
  await service.store.update((s) => {
    s.decks.push({ id: "cn-deck", title: "热力学题", cards: [
      { id: "c1", kind: "flashcard", topic: "熵", prompt: "什么是熵？", answer: "混乱程度的度量。" },
      { id: "c2", kind: "flashcard", topic: "Wide", prompt: "ＡＢＣ１２３ in full width", answer: "Full-width form." },
      { id: "c3", kind: "flashcard", topic: "Other", prompt: "Unrelated", answer: "Nothing." },
    ] });
  });
  return service;
}

test("foldText folds width and case without changing the length", () => {
  assert.equal(foldText("ＡＢＣ１２３ Abc"), "abc123 abc");
  for (const text of ["熵", `${PREFIX}x`, "𝐀 ﬁ ㈱ İ é 한", "plain ASCII"])
    assert.equal(foldText(text).length, text.length, text);
});

test("foldText keeps the length of every single Unicode character, so positions never shift", () => {
  const all = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) if (cp < 0xd800 || cp > 0xdfff) all.push(String.fromCodePoint(cp));
  const text = all.join("");
  const folded = foldText(text);
  assert.equal(folded.length, text.length);
  for (const char of all) assert.equal(foldText(char).length, char.length, `U+${char.codePointAt(0).toString(16)}`);
});

test("searchTerms keeps one CJK character and drops one Latin letter or digit", () => {
  assert.deepEqual(searchTerms({ query: "熵" }), ["熵"]);
  assert.deepEqual(searchTerms({ query: "酶 の 한 ア" }), ["酶", "の", "한", "ア"]);
  assert.deepEqual(searchTerms({ query: "Ａ熵" }), ["a熵"]);
  assert.deepEqual(searchTerms({ query: ["ＩＦＲＡＭＥ"] }), ["iframe"]);
  for (const query of ["a", "7", "Ａ", "１", "a 7", "!"])
    assert.throws(() => searchTerms({ query }), HELP, query);
});

test("source.search finds a one-character Han query", async (t) => {
  const service = await setup(t);
  const found = await service.call("source.search", { query: "熵" });
  assert.deepEqual(found.terms, ["熵"]);
  const hit = found.results.find((r) => r.sourceId === "cn");
  assert.ok(hit);
  assert.equal(hit.hits, 1);
  assert.ok(hit.snippets[0].text.includes("熵"));
  assert.equal((await service.call("source.search", { query: "酶" })).results[0].sourceId, "cn");
});

test("card.search finds a one-character Han query", async (t) => {
  const service = await setup(t);
  const found = await service.call("card.search", { query: "熵" });
  assert.deepEqual(found.terms, ["熵"]);
  assert.deepEqual(found.results.map((r) => r.cardId), ["c1"]);
});

test("full-width letters and digits match their half-width form in both operations", async (t) => {
  const service = await setup(t);
  for (const query of ["abc123", "ＡＢＣ１２３", "Abc１２3"]) {
    const src = await service.call("source.search", { query, sourceIds: ["wide"] });
    assert.equal(src.results[0]?.sourceId, "wide", query);
    const card = await service.call("card.search", { query });
    assert.deepEqual(card.results.map((r) => r.cardId), ["c2"], query);
  }
  // and the other way round: a full-width text hit by a half-width query
  const iframe = await service.call("source.search", { query: "iframe", sourceIds: ["wide"] });
  assert.equal(iframe.results[0].hits, 1);
  assert.ok(iframe.results[0].snippets[0].text.includes("ＩＦＲＡＭＥ"));
});

test("snippets point at the right place in the original text after length-changing characters", async (t) => {
  const service = await setup(t);
  const found = await service.call("source.search", { query: "熵", sourceIds: ["long"], context: 20 });
  const [snippet] = found.results[0].snippets;
  const at = LONG.indexOf("熵");
  assert.equal(snippet.offset, at - 20);
  assert.equal(snippet.text, LONG.slice(at - 20, at + 1 + 20));
  assert.ok(snippet.text.includes("熵"));
});

test("a single Latin letter on its own is still rejected with the helpful message", async (t) => {
  const service = await setup(t);
  for (const action of ["source.search", "card.search"])
    await assert.rejects(service.call(action, { query: "a" }), HELP);
});
