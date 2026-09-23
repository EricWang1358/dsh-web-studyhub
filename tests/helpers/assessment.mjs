// Fixture adapter for plan, author and independent editorial review calls.
// Repairs and retained subsets each require a fresh review.
export function qualityReview(deck, issues = []) {
  return { issues, summary: "Reviewed fixture", checks: (deck?.cards || []).map((card) => ({ cardId: card.id,
    selfContained: "pass", answerLeak: "pass", optionQuality: ["quiz", "multi"].includes(card.kind) ? "pass" : "na",
    learningValue: "pass", sourceSupport: "pass", explanationQuality: "pass", explanation: "The supplied evidence supports this distinct fixture question." })) };
}
export function qualityPlan(request) {
  return { targets: Array.from({ length: request.count }, (_, i) => ({ objective: `Planned target ${i} ${request.kind} ${request.sources[0].text.slice(0, 24)}`,
    answerBoundary: "Only the source statement", comparisonAxis: "One scope distinction", misconception: "Swapping scopes", contextNeeded: "All relevant conditions in the stem",
    citations: [{ sourceId: request.sources[0].id, quote: request.sources[0].text.trim().slice(0, 40) }] })) };
}
/** An authored reply: the deck plus its self-check, as one call now returns. */
export const authored = (deck, changes = []) => ({ deck, changes, checks: qualityReview(deck).checks });

export function withQualityStages(complete) {
  return async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment"))
      return JSON.stringify(qualityPlan(JSON.parse(prompt.split("REQUEST DATA:\n")[1])));
    const response = await complete(system, prompt);
    const value = JSON.parse(response);
    if (system.startsWith("Act as a strict assessment editor"))
      return JSON.stringify({ ...qualityReview(JSON.parse(prompt).candidate, value.issues), ...value });
    // The author call returns its own self-check alongside the deck.
    if (Array.isArray(value?.cards)) return JSON.stringify(authored(value));
    return response;
  };
}
