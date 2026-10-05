/* node scripts/benchmark-repair.mjs [--root <dir with lib/>] [--count 10]
   First-pass yield and token use of ONE part of ten questions on a fake model whose review flags a fixed mix of defects (#202):
     3 hints that give the answer, 2 weak distractors, 1 unclear explanation, 1 unsupported answer, 1 low-value question, 2 clean.
   The same script runs against another checkout's lib (--root) to compare: `git archive <ref> lib references | tar -x -C <dir>`.
   Tokens are DSH's estimate of every prompt and reply (lib/token-estimate.js). No network, no files outside memory. */
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const root = resolve(args.root || here), count = Number(args.count || 10);
const load = (file) => import(pathToFileURL(join(root, file)).href);
const { generateBatched } = await load("lib/batch.js");
const { dshSystemTokens, dshUserTokens } = await load("lib/token-estimate.js");

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const card = (n, index) => ({ id: `q${index + 1}`, targetId: `target-${n}`, kind: "quiz", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `Which statement about architecture principle ${n} follows from the definition?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.", explanation: `The definition ties principle ${n} to design and evolution, so later choices must follow it.`,
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }],
  options: [{ id: "a", text: `Principles guide later choices ${n}.`, correct: true, explanation: "The definition says principles guide design and evolution." },
    { id: "b", text: `Architecture is only today's diagram ${n}.`, correct: false, explanation: "Ignores the evolution part of the definition." },
    { id: "c", text: `Principles never constrain design ${n}.`, correct: false, explanation: "Contradicts the definition." }] });
const FLAWS = { 1: ["answerLeak"], 2: ["answerLeak"], 3: ["answerLeak"], 4: ["optionQuality"], 5: ["optionQuality"], 6: ["explanationQuality"], 7: ["sourceSupport"], 8: ["learningValue"] };
const flawed = new Set();
const meter = { calls: 0, input: 0, output: 0, byStage: {} };
const note = (stage, system, prompt, reply) => {
  const input = dshSystemTokens(system) + dshUserTokens(prompt), output = dshUserTokens(reply);
  meter.calls++; meter.input += input; meter.output += output;
  const row = (meter.byStage[stage] ||= { calls: 0, tokens: 0 }); row.calls++; row.tokens += input + output;
  return reply;
};
const number = (id) => Number(String(id).replace("target-", ""));
const complete = async (system, prompt) => {
  const body = () => JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
  const review = (candidate) => ({ issues: [], summary: "r", checks: candidate.cards.map((item) => ({ cardId: item.id, selfContained: "pass", answerLeak: "pass", optionQuality: "pass",
    learningValue: "pass", sourceSupport: "pass", explanationQuality: "pass", explanation: "The supplied evidence supports this distinct question." })) });
  if (system.startsWith("Plan a source-grounded assessment")) {
    const request = body();
    const targets = Array.from({ length: request.count }, (_, index) => ({ targetId: `target-${index + 1}`, objective: `Planned ${index + 1}`, knowledge: source.text, answerBoundary: "b", comparisonAxis: "a",
      misconception: "m", contextNeeded: "c", answerability: { mode: "recall", requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
      citations: [{ sourceId: "s", quote: source.text.slice(0, 40) }] }));
    return note("plan", system, prompt, JSON.stringify({ targets }));
  }
  if (system.startsWith("Prepare supported answers")) {
    const plan = body().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.targetId), index));
    return note("blueprint", system, prompt, JSON.stringify({ items: cards.map((item, index) => ({ targetId: plan.targets[index].targetId, answer: item.answer, reasoning: item.explanation,
      scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope", options: item.options })) }));
  }
  if (system.startsWith("You author")) {
    const plan = body().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.targetId), index));
    return note("author", system, prompt, JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: review({ cards }).checks }));
  }
  if (system.startsWith("Act as a strict assessment editor")) {
    const candidate = JSON.parse(prompt).candidate, result = review(candidate);
    for (const check of result.checks) {
      const n = number(candidate.cards.find((item) => item.id === check.cardId).targetId), keys = FLAWS[n];
      if (!keys || flawed.has(n)) continue;
      flawed.add(n);
      for (const key of keys) check[key] = "fail";
      check.explanation = `Card ${n}: ${keys.join(", ")} needs work.`;
      result.issues.push(`${check.cardId}: ${keys.join(", ")} needs work`);
    }
    return note("review", system, prompt, JSON.stringify(result));
  }
  if (system.startsWith("Rewrite only the wording")) {
    const cards = body().cards.map((entry) => ({ id: entry.id, hint: "Ask what a rule about permitted future change would add to a plain description.",
      explanation: "Rewritten: the decisive condition, the result, then the nearest wrong path.",
      options: [{ id: "c", text: "Principles apply only at the first release and never afterwards.", explanation: "Mistakes a one-time rule for lasting guidance." }] }));
    return note("repair", system, prompt, JSON.stringify({ cards }));
  }
  throw new Error(`unexpected call: ${system.slice(0, 40)}`);
};

const result = await generateBatched(complete, { count, kind: "quiz", sources: [source], performance: { concurrency: 1, batchSize: 10 } });
const firstBatch = result.cards.filter((item) => number(item.targetId ?? "target-0") <= count).length;
const out = { root, requested: count, kept: result.cards.length, fromFirstBatch: firstBatch, firstPassYield: Number((firstBatch / count).toFixed(2)), finalYield: Number((result.cards.length / count).toFixed(2)),
  repairedInRun: result.editorial.repairedInRun || 0, repairTried: result.editorial.repairTried || 0, reserveUsed: result.editorial.reserveUsed || 0,
  modelCalls: meter.calls, tokens: meter.input + meter.output, byStage: meter.byStage };
console.log(JSON.stringify(out, null, 2));
