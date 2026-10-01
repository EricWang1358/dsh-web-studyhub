import { TRANSCRIBE_USD_PER_MINUTE } from "./gemini.js";
import { rawKey } from "./audio-import.js";

/* What a recording has cost. A run only knows its own Gemini requests, so a retry that finds the transcript already
   saved reports "0 requests" while the attempt before it paid for the audio. The tally is therefore kept next to the
   saved work (usage.json in the recording's cache folder) and each run adds to it. */

const FIELDS = ["requests", "inputTokens", "outputTokens", "cachedInputTokens", "audioSeconds"];
const sum = (a = {}, b = {}) => Object.fromEntries(FIELDS.map((field) => [field, (Number(a[field]) || 0) + (Number(b[field]) || 0)]));

/** Two usage summaries ({ free, groq, paid }, as GeminiTiers.summary() makes them) added together. */
export function addUsage(a, b) {
  const free = sum(a?.free, b?.free), groq = sum(a?.groq, b?.groq), paid = sum(a?.paid, b?.paid);
  return { free, groq, paid, estimatedPaidTranscribeUsd: Math.round(paid.audioSeconds / 60 * TRANSCRIBE_USD_PER_MINUTE * 1000) / 1000 };
}
export const requestsOf = (usage) => (usage?.free?.requests || 0) + (usage?.groq?.requests || 0) + (usage?.paid?.requests || 0);

/**
 * The tally so far for this recording: the saved one, or, for work saved before tallies were kept, what the saved
 * transcripts cost (one request each, on the key that answered).
 */
export async function usageBefore(saved, audio, settings) {
  const known = await saved.get("usage.json");
  if (known) return addUsage(known, {});
  let seeded = addUsage({}, {});
  for (const [index, chunk] of audio.chunks.entries()) {
    const entry = await saved.get(`raw-${rawKey(settings, audio)}-${index}.json`);
    if (entry?.tier === "free" || entry?.tier === "groq" || entry?.tier === "paid")
      seeded = addUsage(seeded, { [entry.tier]: { requests: 1, audioSeconds: entry.seconds || chunk.seconds } });
  }
  return seeded;
}
