import { loadAudio } from "./audio-file.js";
import { GROQ_FILE_LIMIT } from "./groq.js";
import { SILICONFLOW_FILE_LIMIT } from "./siliconflow.js";

/* The check before any effort (P44/P46): is a transcription provider configured, and can every chosen file be
   imported, in how many requests? It reads the files the way the import will (same format detection, same limits,
   same lossless split plan) but sends nothing anywhere and keeps no copy. */

export const TRANSCRIPTION_TIERS = Object.freeze(["free", "siliconflow", "groq", "paid"]);

/**
 * Which providers are configured and what that allows. `settings` are the effective audio settings (textProvider
 * already resolved from "auto"); `hostModel` says whether the DSH model can do the text steps.
 */
export function providerStatus(settings, { paidOnly = false, hostModel = false } = {}) {
  const providers = Object.fromEntries(TRANSCRIPTION_TIERS.map((tier) => [tier, !!settings[`${tier}Key`]]));
  const usable = TRANSCRIPTION_TIERS.filter((tier) => providers[tier] && (!paidOnly || tier === "paid"));
  const reason = usable.length ? null : paidOnly && Object.values(providers).some(Boolean) ? "paid-missing" : "no-provider";
  const text = settings.textProvider === "host" ? !!hostModel : paidOnly ? providers.paid : providers.free || providers.paid || providers.groq;
  return { providers, transcription: usable.length > 0, first: usable[0] ?? null, reason, text, textProvider: settings.textProvider,
    // Live class transcription is Gemini Live only.
    live: providers.free || providers.paid };
}

/** Requests one file is likely to take on the first provider: the one-hour parts, and the free services' size limits. */
function requestsFor(probe, first) {
  if (first !== "siliconflow" && first !== "groq") return probe.parts;
  const limit = (first === "siliconflow" ? SILICONFLOW_FILE_LIMIT : GROQ_FILE_LIMIT) * 0.95;
  // WAV is sent as 16 kHz mono (32 kB a second); other formats as they are.
  const bytes = probe.format === "wav" && probe.seconds ? probe.seconds * 32_000 : probe.bytes;
  return Math.max(probe.parts, Math.ceil(bytes / limit));
}

/**
 * One file's pre-flight: { name, format, bytes, seconds, parts, requests, warnings, blocked, issue }. `issue` is null,
 * { code: 'long-split', minutes, parts, requests } (it will be split losslessly: the learner confirms), or a blocking
 * { code, message } from the loader (AUDIO_CORRUPT, AUDIO_UNSPLITTABLE, AUDIO_TOO_LARGE, AUDIO_TOO_LONG, …).
 */
export async function probeAudioFile(path, { partSeconds, first = null, name } = {}) {
  try {
    const audio = await loadAudio({ path, partSeconds, measureOnly: true });
    const probe = { name: name || audio.filename, format: audio.ext.replace(/^\./, ""), bytes: audio.bytes, seconds: audio.seconds,
      parts: audio.parts, warnings: audio.warnings, blocked: false, issue: null };
    probe.requests = requestsFor(probe, first);
    if (probe.parts > 1) probe.issue = { code: "long-split", minutes: Math.round(probe.seconds / 60), parts: probe.parts, requests: probe.requests };
    return probe;
  } catch (error) {
    return { name: name || String(path).replace(/^.*[\\/]/, ""), blocked: true, issue: { code: error.code || "AUDIO_UNREADABLE", message: String(error.message || error).slice(0, 400) } };
  }
}

/** The whole check: provider status plus every file, and the index of the first file that cannot be imported. */
export async function preflightAudio({ settings, files = [], paidOnly = false, hostModel = false }) {
  const status = providerStatus(settings, { paidOnly, hostModel });
  const partSeconds = (settings.partMinutes || 59) * 60, checked = [];
  for (const [index, file] of files.entries()) {
    checked.push({ index, ...(file.failure ? { name: file.name || "", blocked: true, issue: { code: "AUDIO_UNREADABLE", message: file.failure } }
      : await probeAudioFile(file.path, { partSeconds, first: status.first, name: file.name })) });
  }
  const blocked = checked.find((file) => file.blocked);
  return { ...status, files: checked, blockedBy: blocked ? blocked.index : null };
}
