/* node scripts/benchmark-throughput.mjs [--root <dir with lib/>] [--count 15] [--latency 300] [--concurrency <n>] [--limit <n>] [--sources 4]
   Wall time of ONE job on a fake provider with a fixed latency per model call (#198): the same sources, the same fake answers, the same number of
   independent reviews. Run it against another checkout's lib (--root, e.g. `git archive origin/main lib references | tar -x -C <dir>`) for the
   "before" figure. --limit makes the provider answer 429 above that many simultaneous calls (the new lib slows down and recovers; an old one fails
   the part). Defaults of each lib are used unless --concurrency is given. No network. */
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const root = resolve(args.root || here), count = Number(args.count || 15), latency = Number(args.latency || 300), limit = args.limit ? Number(args.limit) : Infinity;
const load = (file) => import(pathToFileURL(join(root, file)).href);
const { generateBatched } = await load("lib/batch.js");

const paragraph = (n) => `Section ${n}. Architecture includes the principles guiding a system's design and evolution, number ${n}. `.repeat(2);
const sources = Array.from({ length: Number(args.sources || 4) }, (_, index) => ({ id: `s${index + 1}`, title: `Page ${index + 1}`, text: paragraph(index + 1) }));
const number = (id) => Number(String(id).replace(/\D+/g, ""));
const card = (n, index, targetId, sourceId) => ({ id: `q${index + 1}`, targetId, kind: "flashcard", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `What does section ${n} say about architecture principle ${n}?`, answer: `Principles guide later choices ${n}.`, hint: "Think about change over time.",
  explanation: `The passage ties principle ${n} to design and evolution.`, misconception: "Architecture only describes components.",
  citations: [{ sourceId, quote: paragraph(number(sourceId)).slice(0, 60) }] });
const review = (candidate) => ({ issues: [], summary: "r", checks: candidate.cards.map((item) => ({ cardId: item.id, selfContained: "pass", answerLeak: "pass", optionQuality: "na",
  learningValue: "pass", sourceSupport: "pass", explanationQuality: "pass", explanation: "The supplied evidence supports this distinct question." })) });

const stats = { calls: 0, reviews: 0, plans: 0, active: 0, peak: 0, planPeak: 0, planning: 0, rateLimited: 0 };
let next = 0;
const complete = async (system, prompt) => {
  stats.calls++; stats.active++; stats.peak = Math.max(stats.peak, stats.active);
  const isPlan = system.startsWith("Plan a source-grounded assessment");
  if (isPlan) { stats.plans++; stats.planning++; stats.planPeak = Math.max(stats.planPeak, stats.planning); }
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, latency));
    if (stats.active > limit) { stats.rateLimited++; throw new Error("429 Too Many Requests: rate limit exceeded"); }
    const data = () => JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    if (isPlan) {
      const request = data(), source = request.sources[0];
      const targets = Array.from({ length: request.count }, () => { const n = ++next; return { targetId: `target-${n}`, objective: `Planned ${n}`, knowledge: source.text.slice(0, 100), answerBoundary: "b", comparisonAxis: "a",
        misconception: "m", contextNeeded: "c", answerability: { mode: "recall", requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
        citations: [{ sourceId: source.id, quote: paragraph(number(source.id)).slice(0, 60) }] }; });
      return JSON.stringify({ targets });
    }
    if (system.startsWith("Prepare supported answers")) {
      const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.objective), index, target.targetId, target.citations[0].sourceId));
      return JSON.stringify({ items: cards.map((item, index) => ({ targetId: plan.targets[index].targetId, answer: item.answer, reasoning: item.explanation,
        scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope" })) });
    }
    if (system.startsWith("You author")) {
      const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.objective), index, target.targetId, target.citations[0].sourceId));
      return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: review({ cards }).checks });
    }
    if (system.startsWith("Act as a strict assessment editor")) { stats.reviews++; return JSON.stringify(review(JSON.parse(prompt).candidate)); }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  } finally { stats.active--; if (isPlan) stats.planning--; }
};

const performance = args.concurrency ? { concurrency: Number(args.concurrency) } : {};
const started = Date.now();
let outcome;
try {
  const result = await generateBatched(complete, { count, kind: "flashcard", sources, performance, rateLimitBackoffMs: 50 });
  outcome = { cards: result.cards.length, failures: result.editorial.failures.length };
} catch (error) { outcome = { error: String(error.message).slice(0, 120) }; }
console.log(JSON.stringify({ root, count, latencyMs: latency, wallMs: Date.now() - started, ...outcome, modelCalls: stats.calls, independentReviews: stats.reviews,
  planCalls: stats.plans, peakConcurrentCalls: stats.peak, peakConcurrentPlans: stats.planPeak, rateLimited: stats.rateLimited, ...(limit < Infinity ? { providerLimit: limit } : {}) }, null, 2));
