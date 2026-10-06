import test from "node:test";
import assert from "node:assert/strict";
import { scopeExisting, EXISTING_LIMIT } from "../lib/existing-scope.js";
import { generateBatched, planGeneration } from "../lib/batch.js";
import { estimateRun } from "../lib/token-estimate.js";
import { authored, qualityPlan, qualityBlueprint, qualityReview } from "./helpers/assessment.mjs";

/* One real library held 2,900 learning targets (about 55K tokens). Every plan
   and author call of a 20-question run repeated all of them: 8 of the 14 calls
   of a 765K-token run, more than half of what it used, most of it targets of
   other courses. The list a call carries is now narrowed to the targets that
   share wording with the materials, plus the ones the caller pins. */

const material = { id: "s1", title: "微服务", text: "微服务边界由业务能力决定。Event sourcing stores state as events; CQRS separates the read model from the write model. 服务间通信可以同步，也可以异步。" };
const related = ["解释微服务边界如何由业务能力决定", "Explain how CQRS separates the read model from the write model", "判断服务间通信何时应该异步"];
const unrelated = (n) => Array.from({ length: n }, (_, i) => `Recipe ${i}: knead the dough ${i} minutes, then proof it. 烘焙第 ${i} 步：揉面`);

test("only targets that share wording with the materials are kept, pinned ones always", () => {
  const library = [...unrelated(300), ...related, ...unrelated(300)];
  const kept = scopeExisting(library, [material], { pinned: ["Pinned: the deck being added to"] });
  assert.equal(kept[0], "Pinned: the deck being added to");
  for (const objective of related) assert.ok(kept.includes(objective), objective);
  assert.ok(!kept.some((objective) => objective.startsWith("Recipe")), "unrelated targets cannot repeat anything in these materials");
  assert.equal(new Set(kept).size, kept.length);
});

test("the list is bounded however large the library is, and a pinned target is never dropped by the bound", () => {
  const library = Array.from({ length: 3000 }, (_, i) => `Explain CQRS read model number ${i} and the write model`);
  const kept = scopeExisting(library, [material], { pinned: library.slice(0, 3) });
  assert.equal(kept.length, 3 + EXISTING_LIMIT);
  assert.deepEqual(kept.slice(0, 3), library.slice(0, 3));
  // Among equally alike targets the newer ones come first.
  assert.ok(kept.includes(library[2999]));
});

test("no materials, no library or a zero limit leave only what is pinned", () => {
  assert.deepEqual(scopeExisting(related, [], { pinned: ["p"] }), ["p"]);
  assert.deepEqual(scopeExisting([], [material], { pinned: ["p"] }), ["p"]);
  assert.deepEqual(scopeExisting(related, [material], { pinned: [], limit: 0 }), []);
  assert.deepEqual(scopeExisting(undefined, undefined), []);
});

function recordingModel(requests) {
  return async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment")) {
      const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
      requests.push({ stage: "plan", existing: request.existing });
      return JSON.stringify(qualityPlan(request));
    }
    if (system.startsWith("Act as a strict assessment editor")) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    if (system.startsWith('Prepare supported answers')) {
      requests.push({ stage: 'blueprint', existing: request.alreadyCovered });
      return JSON.stringify(qualityBlueprint(request, request.assessmentPlan, { cards: request.assessmentPlan.targets.map(() => ({ answer: 'a', explanation: 'because of the decisive condition in the source' })) }));
    }
    requests.push({ stage: "author", existing: request.alreadyCovered });
    const cards = Array.from({ length: request.count }, (_, i) => ({ id: `q${i + 1}`, kind: request.kind, topic: "t", objective: `New objective ${requests.length} ${i}`,
      prompt: `Question ${requests.length} ${i}?`, answer: "a", hint: "h", explanation: "because of the decisive condition in the source",
      misconception: "m", citations: [{ sourceId: "s1", quote: material.text.slice(0, 30) }] }));
    const deck = { title: "D", cards };
    return JSON.stringify(authored(deck, [], request.assessmentPlan));
  };
}

test("generation tells the plan call only the targets that matter; the answer and author calls get the planned targets and no list of covered ones", async () => {
  const requests = [];
  const library = [...unrelated(500), ...related];
  await generateBatched(recordingModel(requests), { count: 3, kind: "flashcard", sources: [material], existing: library,
    pinnedExisting: ["Pinned: from the draft being continued"] });
  for (const stage of ['plan', 'blueprint', 'author']) assert.ok(requests.some(request => request.stage === stage), stage);
  for (const { stage, existing } of requests) {
    // The plan de-duplicates its targets against the library; the stages after it work from those targets, so they are not sent the list again.
    if (stage !== 'plan') { assert.equal(existing, undefined, `${stage} is not sent the covered targets`); continue; }
    assert.ok(existing.length < 60, `${stage} carried ${existing.length} targets`);
    assert.ok(existing.includes("Pinned: from the draft being continued"), stage);
    for (const objective of related) assert.ok(existing.includes(objective), `${stage}: ${objective}`);
  }
});

test("a library ten times larger does not make the estimate larger", () => {
  const request = { sources: [material], count: 5, kind: "flashcard", language: "中文" };
  const small = estimateRun("generate", { ...request, existing: [...unrelated(50), ...related] });
  const large = estimateRun("generate", { ...request, existing: [...unrelated(2500), ...related] });
  assert.equal(large.inputTokens.high, small.inputTokens.high, "the estimate prices what the run sends");
  assert.ok(planGeneration({ ...request }).length >= 1);
});
