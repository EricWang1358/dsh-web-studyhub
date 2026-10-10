/* The replies of an answer-card task, read by the program: the JSON object (a fenced block is fine), or null when it cannot be read or misses what a
   card needs (steps and a conclusion) or a review needs (an issues list). What is trusted is decided in lib/answer-card.js. Pure. */

function json(text) {
  const body = String(text ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  try { return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); } catch { return null; }
}

/** A written (or repaired) card: an object with at least one step and a conclusion. */
export function readCard(text) {
  const data = json(text);
  return data && typeof data === 'object' && Array.isArray(data.steps) && data.steps.some(step => typeof step === 'string' && step.trim())
    && typeof data.conclusion === 'string' && data.conclusion.trim() ? data : null;
}

/** A review: an object with an issues list (empty is a clean review). */
export function readReview(text) {
  const data = json(text);
  return data && typeof data === 'object' && Array.isArray(data.issues) ? data : null;
}
