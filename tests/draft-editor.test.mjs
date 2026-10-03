import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["ui/draft-editor.js"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["react"], logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { parseDraft } = module.exports;
const card = kind => ({ id: "q", kind, topic: "Topic", objective: "Target", prompt: "Question?", answer: "Answer",
  hint: "Hint", explanation: "Explanation", misconception: "Mistake", citations: [{ sourceId: "s", quote: "Source passage" }] });
const raw = value => JSON.stringify({ title: "Draft", cards: [value] });

test("draft JSON omits only null fields that do not apply to the question kind", () => {
  for (const kind of ["flashcard", "quiz", "multi", "open", "cloze"]) {
    const value = { ...card(kind), options: null, rubric: null, cloze: null };
    if (["quiz", "multi"].includes(kind)) value.options = [];
    if (kind === "open") value.rubric = "A scoring rubric";
    if (kind === "cloze") value.cloze = { text: "A {{b1}}", answers: [{ id: "b1", value: "blank" }] };
    const parsed = parseDraft(raw(value)).cards[0];
    for (const field of ["options", "rubric", "cloze"])
      if (value[field] === null) assert.equal(Object.hasOwn(parsed, field), false, `${kind}: ${field}`);
      else assert.deepEqual(parsed[field], value[field]);
  }
});

test("draft JSON preserves non-null extra fields and rejects invalid active answer fields", () => {
  const extra = { ...card("flashcard"), options: [], rubric: "Keep this text",
    cloze: { text: "An extra {{b1}}", answers: [{ id: "b1", value: "attribute" }] }, custom: "Keep metadata" };
  assert.deepEqual(parseDraft(raw(extra)).cards[0], extra);
  for (const [kind, field] of [["quiz", "options"], ["multi", "options"], ["open", "rubric"], ["cloze", "cloze"]])
    assert.throws(() => parseDraft(raw({ ...card(kind), [field]: null })));
  for (const [field, value] of [["options", {}], ["rubric", false], ["cloze", { text: "Bad", answers: null }]])
    assert.throws(() => parseDraft(raw({ ...card("flashcard"), [field]: value })));
});
