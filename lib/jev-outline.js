import { choice } from './jev.js';
import { createBreaker, mapLimit } from './jev-runtime.js';

/* EXPERIMENTAL. 目录噪声判断: is an outline entry a real chapter heading, or noise?

   Headings pulled out of a PDF or a converted book are mixed: real chapter titles, small labels the typesetting turned into headings
   ("English original", "中文对照"), and running headers or footers repeated on every page. One `choice` question per heading decides which,
   with a small window of its neighbours as context. The answer is a SIGNAL for the reader's outline (a pure function in
   ui/jev-outline.js demotes or drops confident noise); nothing is ever deleted from a document, and with Jev off or failing the
   outline is exactly what it was. The reader is another work package's: see docs/jev-experimental.md for the hook. */

/** The labels and what each means to the model. `chapter` and `other` are never noise. */
export const OUTLINE_LABELS = Object.freeze({
  chapter: 'A real chapter, section or topic heading that a reader would want in a table of contents.',
  label: 'A small label or tag that merely marks a part of the page, such as "English original", "Chinese translation", "Example" or "Answer".',
  running: 'A running header or footer, page number, copyright line or other text repeated on many pages.',
  other: 'Something else, or it cannot be told.',
});
export const OUTLINE_CHUNK = 8;
const CONTEXT = 2, TITLE_CHARS = 160;
const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);

/** The request for `chunk` (a slice of `all` starting at `start`): the window of headings and one question per heading of the chunk. */
export function buildOutlineRequest(chunk, all, start) {
  const from = Math.max(0, start - CONTEXT), to = Math.min(all.length, start + chunk.length + CONTEXT);
  const headings = all.slice(from, to).map((entry, offset) => ({ n: from + offset, level: Number(entry.level) || 1, text: clip(entry.title) }));
  const questions = Object.fromEntries(chunk.map((_, offset) => [`h${start + offset}`, choice(
    `What kind of outline entry is heading number ${start + offset} in this list of headings taken from one document?`, { ...OUTLINE_LABELS })]));
  return { state: { headings }, questions };
}

/** One answer as { label, probability } (the probability of the label that was picked). */
export function readOutlineAnswer(answer) {
  const label = Object.keys(answer.probabilities).sort((a, b) => answer.probabilities[b] - answer.probabilities[a])[0];
  return { label, probability: Math.round(answer.probabilities[label] * 1e4) / 1e4 };
}

/**
 * Classify `entries` ([{ id, level, title }]) in chunks. Resolves { labels: { [id]: { label, probability } }, failed, usage, unavailable?, partial? }.
 * Never throws (except an aborted signal). `threshold` is not applied here: the page applies it, so a learner moving the line needs no new call.
 */
export async function classifyOutline({ runtime, entries, language = 'zh', signal, concurrency = 3 }) {
  const chunks = [];
  for (let start = 0; start < entries.length; start += OUTLINE_CHUNK) chunks.push(start);
  const labels = {}, failures = [], usage = { calls: 0, inputTokens: 0, outputTokens: 0 }, breaker = createBreaker();
  await mapLimit(chunks, concurrency, async start => {
    const chunk = entries.slice(start, start + OUTLINE_CHUNK), request = buildOutlineRequest(chunk, entries, start);
    const result = await runtime.run('outlineNoise', request.state, request.questions, { signal, language });
    breaker.note(result);
    if (!result.ok) { failures.push(result); return; }
    usage.calls++; usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
    chunk.forEach((entry, offset) => { labels[entry.id] = readOutlineAnswer(result.answers[`h${start + offset}`]); });
  }, { stop: () => breaker.open });
  const out = { labels, failed: failures.length, usage };
  if (failures.length) {
    const note = { reason: failures[0].reason, message: failures[0].message };
    if (Object.keys(labels).length) out.partial = { ...note, failed: failures.length }; else out.unavailable = note;
  }
  return out;
}
