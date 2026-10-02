import { choice } from './jev.js';
import { createBreaker, mapLimit } from './jev-runtime.js';
import { cognitiveLevel } from './coach.js';

/* EXPERIMENTAL. 题目认知层次对照: Jev's reading of a question next to the code's own.

   The 本轮小结 (lib/coach.js `cognitiveLevel`) sorts a question into 记忆 (recall), 概念辨析 (concept) or 应用分析 (apply) with a keyword
   heuristic that costs nothing. This asks Jev the same thing, one `choice` per question, and counts where the two agree. It is a
   CROSS-CHECK for the developer panel: nothing replaces the heuristic, nothing is stored, and the learner's own level overrides are
   not touched. Whether Jev is the better judge is for scripts/eval-jev.mjs to measure on labelled questions; nothing here claims it. */

export const LEVEL_LABELS = Object.freeze({
  recall: 'Recall: remembering a definition, name, list or fact, stated more or less as it was learned.',
  concept: 'Concept discrimination: explaining why, or telling similar concepts apart, without a concrete situation to act in.',
  apply: 'Application or analysis: using the concept in a concrete scenario, to design, choose between trade-offs, diagnose or decide.',
});
const LEVEL_ORDER = ['recall', 'concept', 'apply'];
const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The request for one card. */
export function buildLevelRequest(card) {
  const options = Array.isArray(card.options) && ['quiz', 'multi'].includes(card.kind) ? { options: card.options.map(option => clip(option.text, 200)) } : {};
  return { state: { question: clip(card.prompt, 1200), kind: card.kind, ...options, answer: clip(card.answer, 400) },
    questions: { level: choice('What cognitive level does answering this question require?', { ...LEVEL_LABELS }) } };
}

/** At most `limit` cards, evenly spread over the list (all of them when there are fewer). */
export function sampleCards(cards, limit) {
  if (cards.length <= limit) return cards;
  return Array.from({ length: limit }, (_, index) => cards[Math.floor(index * cards.length / limit)]);
}

/** Counts over rows: total, agree, disagree (a confident disagreement), unsure (Jev's top label under the threshold). */
export function summarize(rows) {
  const counts = { total: rows.length, agree: 0, disagree: 0, unsure: 0 };
  for (const row of rows) {
    if (!row.confident) counts.unsure++; else if (row.agree) counts.agree++; else counts.disagree++;
  }
  return counts;
}

/**
 * Compare Jev with the heuristic on `cards`. Resolves { rows, counts, matrix, usage, unavailable?, partial? }; `matrix[heuristic][jev]` counts
 * the confident rows. Never throws (except an aborted signal); with Jev off or failing there are no rows and a note.
 */
export async function checkLevels({ runtime, cards, threshold = 0.8, language = 'zh', signal, concurrency = 4 }) {
  const rows = [], failures = [], usage = { calls: 0, inputTokens: 0, outputTokens: 0 }, breaker = createBreaker();
  const slots = new Array(cards.length);
  await mapLimit(cards, concurrency, async (card, index) => {
    const request = buildLevelRequest(card);
    const result = await runtime.run('levelCheck', request.state, request.questions, { signal, language });
    breaker.note(result);
    if (!result.ok) { failures.push(result); return; }
    usage.calls++; usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
    const probabilities = result.answers.level.probabilities, jev = LEVEL_ORDER.slice().sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0];
    const probability = Math.round((probabilities[jev] ?? 0) * 1e4) / 1e4, heuristic = cognitiveLevel(card);
    slots[index] = { id: card.id, prompt: clip(card.prompt, 120), heuristic, jev, probability, agree: jev === heuristic, confident: probability >= threshold };
  }, { stop: () => breaker.open });
  for (const row of slots) if (row) rows.push(row);
  const matrix = Object.fromEntries(LEVEL_ORDER.map(level => [level, {}]));
  for (const row of rows) if (row.confident) matrix[row.heuristic][row.jev] = (matrix[row.heuristic][row.jev] || 0) + 1;
  const out = { rows, counts: summarize(rows), matrix, usage };
  if (failures.length) {
    const note = { reason: failures[0].reason, message: failures[0].message };
    if (rows.length) out.partial = { ...note, failed: failures.length }; else out.unavailable = note;
  }
  return out;
}
