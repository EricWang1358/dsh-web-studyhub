import { authorPrompts, salvageAuthoredCards } from '../../lib/generation.js';

// Fixture adapter for evidence, concrete answers, author and independent review calls.
// Changed cards require a fresh review; unchanged cards retain their receipt.
export function qualityReview(deck, issues = []) {
  return { issues, summary: "Reviewed fixture", checks: (deck?.cards || []).map((card) => ({ cardId: card.id,
    selfContained: "pass", answerLeak: "pass", optionQuality: ["quiz", "multi"].includes(card.kind) ? "pass" : "na",
    learningValue: "pass", sourceSupport: "pass", explanationQuality: "pass", explanation: "The supplied evidence supports this distinct fixture question." })) };
}
export function qualityPlan(request) {
  return { targets: Array.from({ length: request.count }, (_, i) => ({ targetId: `target-${i + 1}`,
    objective: `Planned target ${(request.existing?.length || 0) + i} ${request.kind} ${request.sources[0].text.slice(0, 24)}`,
    knowledge: request.sources[0].text.trim().slice(0, 120),
    answerBoundary: "Only the source statement", comparisonAxis: "One scope distinction", misconception: "Swapping scopes", contextNeeded: "All relevant conditions in the stem",
    answerability: { mode: 'recall', requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
    citations: [{ sourceId: request.sources[0].id, quote: request.sources[0].text.trim().slice(0, 40) }] })) };
}
/** An authored reply: the deck plus its self-check, as one call now returns. */
export const authored = (deck, changes = [], plan) => {
  const referenced = { ...deck, cards: deck.cards.map((card, index) => ({ ...card,
    targetId: card.targetId || plan?.targets[index]?.targetId || `target-${index + 1}` })) };
  return { deck: referenced, changes, checks: qualityReview(referenced).checks };
};

export function qualityBlueprint(request, plan, deck) {
  return { items: (deck?.cards || plan.targets).slice(0, plan.targets.length).map((card, index) => ({
    targetId: plan.targets[index].targetId || `target-${index + 1}`,
    answer: card.answer || plan.targets[index].knowledge || plan.targets[index].answerBoundary,
    reasoning: card.explanation || 'The selected original statement supplies the rule and its scope.',
    scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'The supported scope of this rule',
    ...(['quiz', 'multi'].includes(request.kind) ? { options: card.options } : {}),
    ...(request.kind === 'open' ? { rubric: card.rubric } : {}),
    ...(request.kind === 'cloze' ? { cloze: card.cloze } : {}),
  })) };
}

export function withQualityStages(complete) {
  const pending = new Map();
  const keyFor = request => JSON.stringify([request.kind, request.assessmentPlan?.targets.map(target => [target.targetId, target.objective])]);
  return async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment"))
      return JSON.stringify(qualityPlan(JSON.parse(prompt.split("REQUEST DATA:\n")[1])));
    if (system.startsWith('Prepare supported answers')) {
      // Existing fixtures describe one authored deck. Read that fixture once
      // for its concrete answers and reuse it for the real author stage; this
      // adapter never grants review approval. Workflow tests mock all stages.
      const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
      const authorRequest = { ...request };
      const author = authorPrompts(authorRequest, request.assessmentPlan);
      const response = await complete(author.system, author.prompt);
      let value;
      try { value = JSON.parse(response); } catch { value = salvageAuthoredCards(response); }
      if (value?.error) return response;
      const deck = value?.deck || value;
      pending.set(keyFor(request), response);
      return JSON.stringify(qualityBlueprint(request, request.assessmentPlan, deck));
    }
    if (system.startsWith('You author')) {
      const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]), key = keyFor(request);
      if (pending.has(key)) {
        const response = pending.get(key); pending.delete(key);
        let value;
        try { value = JSON.parse(response); } catch { return response; }
        const deck = value?.deck || value;
        if (Array.isArray(deck?.cards)) return JSON.stringify({ ...authored(deck, value?.changes || [], request.assessmentPlan),
          ...(value?.checks ? { checks: value.checks } : {}) });
        return response;
      }
    }
    const response = await complete(system, prompt);
    const value = JSON.parse(response);
    if (system.startsWith("Act as a strict assessment editor"))
      return JSON.stringify({ ...qualityReview(JSON.parse(prompt).candidate, value.issues), ...value });
    // The author call returns its own self-check alongside the deck.
    if (Array.isArray(value?.cards)) return JSON.stringify(authored(value));
    return response;
  };
}
