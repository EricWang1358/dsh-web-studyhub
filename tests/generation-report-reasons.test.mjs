import test from "node:test";
import assert from "node:assert/strict";
import { failureReason, summarizePartOutcomes } from "../lib/generation-report.js";

/* A part whose questions were dropped for a formula, a source-voice stem, a missing field or a broken option list did not fail for an unknown reason:
   the quality gate rejected its text, and the report must say so instead of "another reason". */

test("formula, source-voice, missing-field and option-shape lines are quality problems, not 'other'", () => {
  for (const line of [
    'Card 2: formula outside math delimiters (["x^2"]); wrap every formula in $…$',
    "Card 2: the stem asks what the source says (recall of a document's wording); rewrite it",
    "Card 3: hint is required",
    "Card 3: misconception must be text",
    "Card 1: need 3–6 options",
    "Card 1: invalid correct option count",
    "Card 1: duplicate option id",
    "Card 1: each option requires id, text, correct and explanation",
    "Card 1: hint reveals the answer",
  ]) assert.equal(failureReason(line), "quality", line);
  assert.equal(failureReason("Card 4: unsupported kind"), "other", "unrelated lines are still other");
  assert.equal(failureReason("Part 1: quote is not in source"), "quote", "a quote problem stays a quote problem");
});

test("a part that lost cards to such lines is counted as a quality part", () => {
  const deck = { cards: [{ id: "a" }], editorial: { omitted: [{ reasons: ["Card 2: formula outside math delimiters (x)"] }, { reasons: ["Card 3: hint is required"] }] } };
  const report = summarizePartOutcomes({ planned: [{ count: 3 }], outcomes: [{ deck }] });
  assert.equal(report.partial, 1);
  assert.deepEqual(report.reasons, { quality: 1 });
});
