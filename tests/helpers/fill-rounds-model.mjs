import { qualityPlan, qualityReview } from "./assessment.mjs";

/* The fake model of the fill-round characterization (#197): plans number their objectives globally, `rejectObjectives` fail source support once seen. */

export const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const number = (id) => Number(String(id).replace(/\D+/g, ""));
const quizCard = (n, index, targetId) => ({ id: `q${index + 1}`, targetId, kind: "quiz", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `Which statement about architecture principle ${n} follows from the definition?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.", explanation: `The definition ties principle ${n} to design and evolution, so later choices must follow it.`,
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }],
  options: [{ id: "a", text: `Principles guide later choices ${n}.`, correct: true, explanation: "The definition says principles guide design and evolution." },
    { id: "b", text: `Architecture is only today's diagram ${n}.`, correct: false, explanation: "Ignores the evolution part of the definition." },
    { id: "c", text: `Principles never constrain design ${n}.`, correct: false, explanation: "Contradicts the definition." }] });

/** Plans number their objectives globally (Planned 1, 2, 3 ...) like a planner told what exists; `rejectObjectives` fail source support once seen. */
export function fakeModel({ rejectObjectives = new Set(), onAuthor, onPlan, onCall } = {}) {
  let next = 0;
  const log = { calls: [], plans: [], authors: [], seen: new Set() };
  const complete = async (system, prompt, context) => {
    onCall?.(system, context);
    const data = () => JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    if (system.startsWith("Plan a source-grounded assessment")) {
      const request = data();
      log.calls.push("plan"); log.plans.push({ count: request.count, existing: request.existing });
      onPlan?.(request);
      const targets = qualityPlan({ ...request, kind: "quiz" }).targets.map((target) => ({ ...target, objective: `Planned ${++next}` }));
      return JSON.stringify({ targets });
    }
    if (system.startsWith("Prepare supported answers")) {
      log.calls.push("blueprint");
      const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => quizCard(number(target.objective), index, target.targetId));
      return JSON.stringify({ items: cards.map((card, index) => ({ targetId: plan.targets[index].targetId, answer: card.answer, reasoning: card.explanation,
        scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope", options: card.options })) });
    }
    if (system.startsWith("You author")) {
      log.calls.push("author");
      const request = data(), plan = request.assessmentPlan;
      log.authors.push({ objectives: plan.targets.map((target) => target.objective), priorRound: request.priorRound, count: request.count });
      onAuthor?.(request);
      const cards = plan.targets.map((target, index) => quizCard(number(target.objective), index, target.targetId));
      return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    if (system.startsWith("Act as a strict assessment editor")) {
      log.calls.push("review");
      const candidate = JSON.parse(prompt).candidate, review = qualityReview(candidate), issues = [];
      for (const check of review.checks) {
        const card = candidate.cards.find((item) => item.id === check.cardId);
        if (!rejectObjectives.has(card.objective)) continue;
        log.seen.add(card.objective);
        check.sourceSupport = "fail"; check.explanation = `${card.objective} is not supported by the quoted source.`;
        issues.push(`${card.id}: sourceSupport needs work`);
      }
      return JSON.stringify({ ...review, issues });
    }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, log };
}
