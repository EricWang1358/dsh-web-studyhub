// Fixture adapter for legacy author/editor tests. Dedicated quality tests use
// explicit plans and self-check responses to exercise the new gates themselves.
export function qualityReview(deck, issues = []) {
  return { issues, summary: "Reviewed fixture", checks: (deck?.cards || []).map((card) => ({ cardId: card.id,
    selfContained: "pass", answerLeak: "pass", optionQuality: ["quiz", "multi"].includes(card.kind) ? "pass" : "na",
    learningValue: "pass", sourceSupport: "pass", explanation: "The supplied evidence supports this distinct fixture question." })) };
}
export function qualityPlan(request) {
  return { targets: Array.from({ length: request.count }, (_, i) => ({ objective: `Planned target ${i} ${request.kind} ${request.sources[0].text.slice(0, 24)}`,
    answerBoundary: "Only the source statement", comparisonAxis: "One scope distinction", misconception: "Swapping scopes", contextNeeded: "All relevant conditions in the stem",
    citations: [{ sourceId: request.sources[0].id, quote: request.sources[0].text.trim().slice(0, 40) }] })) };
}
export function withQualityStages(complete) {
  return async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment"))
      return JSON.stringify(qualityPlan(JSON.parse(prompt.split("REQUEST DATA:\n")[1])));
    if (system.startsWith("Self-check and improve")) {
      const revised = JSON.parse(prompt).candidate;
      return JSON.stringify({ ...qualityReview(revised), deck: revised, changes: [] });
    }
    const response = await complete(system, prompt);
    const value = JSON.parse(response);
    if (system.startsWith("Act as a strict assessment editor") || system.startsWith("Strict assessment editor"))
      return JSON.stringify({ ...qualityReview(JSON.parse(prompt).candidate, value.issues), ...value });
    return response;
  };
}
