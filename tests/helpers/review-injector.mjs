import { parseJson } from "../../lib/generation.js";
import { qualityPlan, qualityReview } from "./assessment.mjs";

/* A fake model for the whole generation pipeline with a FAILURE INJECTOR on its replies (the idea of the flow audit's harness): the review reply, the
   author reply and the plan reply of any part can be damaged on any call. Everything is deterministic and local; no network.

     injector.review  ({ part, nth, candidate, reply, prompt, context }) -> undefined (keep) | string (raw reply) | object (JSON)
     injector.author  ({ part, nth, reply }) -> same;  injector.plan -> same.
   `nth` counts the calls of that stage for that part (1-based); `part` comes from the call context (the batch gives it), else null.
   `log.calls` records { stage, part, nth, retry, kind } of every call so a test can count them exactly. */
export const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const number = (id) => Number(String(id).replace(/\D+/g, ""));
export const quizCard = (n, index, targetId, id = `q${index + 1}`) => ({ id, targetId, kind: "quiz", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `Which statement about architecture principle ${n} follows from the definition?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.", explanation: `The definition ties principle ${n} to design and evolution, so later choices must follow it.`,
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }],
  options: [{ id: "a", text: `Principles guide later choices ${n}.`, correct: true, explanation: "The definition says principles guide design and evolution." },
    { id: "b", text: `Architecture is only today's diagram ${n}.`, correct: false, explanation: "Ignores the evolution part of the definition." },
    { id: "c", text: `Principles never constrain design ${n}.`, correct: false, explanation: "Contradicts the definition." }] });

const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value));
/** The reply cut off after `fraction` of its characters (a model that ran out of output). */
export const cut = (reply, fraction = 0.6) => asText(reply).slice(0, Math.floor(asText(reply).length * fraction));
/** The review reply with only the first `keep` per-card checks (valid JSON, but incomplete). */
export const keepChecks = (reply, keep) => { const value = JSON.parse(asText(reply)); value.checks = value.checks.slice(0, keep); return value; };
/** The review reply cut off in the middle of check number `at` (1-based): checks before it are complete JSON, the rest is lost. */
export const cutInCheck = (reply, at) => { const text = asText(reply), marks = [...text.matchAll(/\{"cardId"/g)].map((match) => match.index); return text.slice(0, marks[at - 1] + 30); };

export function injectedModel({ review, author, plan, title = "D" } = {}) {
  let next = 0;
  const log = { calls: [], plans: [], authors: [], reviews: [] };
  const counts = new Map();
  const nth = (stage, part) => { const key = `${stage}:${part}`; counts.set(key, (counts.get(key) || 0) + 1); return counts.get(key); };
  const complete = async (system, prompt, context = {}) => {
    const part = context.part ?? null, data = () => parseJson(prompt.split("REQUEST DATA:\n")[1]);
    const note = (stage, n) => log.calls.push({ stage, part, nth: n, retry: context.retry ?? 0, kind: context.kind ?? null });
    const inject = async (hook, base, extra) => {
      const out = hook ? await hook({ ...extra, reply: base, prompt, context }) : undefined;
      return out === undefined ? base : asText(out);
    };
    if (system.startsWith("Plan a source-grounded assessment")) {
      const n = nth("plan", part); note("plan", n);
      const request = data(); log.plans.push({ count: request.count, part });
      const targets = qualityPlan({ ...request, kind: "quiz" }).targets.map((target) => ({ ...target, objective: `Planned ${++next}` }));
      return inject(plan, JSON.stringify({ targets }), { part, nth: n });
    }
    if (system.startsWith("Prepare supported answers")) {
      note("blueprint", nth("blueprint", part));
      const planned = data().assessmentPlan, cards = planned.targets.map((target, index) => quizCard(number(target.objective), index, target.targetId));
      return JSON.stringify({ items: cards.map((card, index) => ({ targetId: planned.targets[index].targetId, answer: card.answer, reasoning: card.explanation,
        scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope", options: card.options })) });
    }
    if (system.startsWith("You author")) {
      const n = nth("author", part); note("author", n);
      const planned = data().assessmentPlan;
      log.authors.push({ part, objectives: planned.targets.map((target) => target.objective) });
      const cards = planned.targets.map((target, index) => quizCard(number(target.objective), index, target.targetId));
      return inject(author, JSON.stringify({ deck: { title, cards }, changes: [], checks: qualityReview({ cards }).checks }), { part, nth: n });
    }
    if (system.startsWith("Act as a strict assessment editor")) {
      const n = nth("review", part); note("review", n);
      const candidate = parseJson(prompt).candidate;
      log.reviews.push({ part, nth: n, retry: context.retry ?? 0, prompt, cardIds: candidate.cards.map((card) => card.id) });
      return inject(review, JSON.stringify(qualityReview(candidate)), { part, nth: n, candidate });
    }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  const count = (stage, part) => log.calls.filter((call) => call.stage === stage && (part === undefined || call.part === part)).length;
  return { complete, log, count };
}
