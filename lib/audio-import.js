import { parseStoredJson } from "./util.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseJson } from "./generation.js";
import { withModelRetry, isModelFailure, isPermanentModelError } from "./model-retry.js";
import {
  PROOFREAD_SYSTEM, TITLE_SYSTEM, TRANSLATE_SYSTEM, TRANSLATE_TO_ENGLISH_SYSTEM,
  applyCorrections, buildDocuments, cjkShare, joinChunks, normalizeTranslation, paragraphize,
  parseCorrections, proofreadPrompt, translatePrompt, windowsOf,
} from "./transcript.js";

/* The audio pipeline: transcribe chunks, proofread the joined transcript,
   translate it part by part, assemble the bilingual document.

   Transcription is the paid step, so each finished chunk (and each proofread
   or translated window) is checkpointed under the library's audio-cache/. A
   failed or cancelled run resumes from the checkpoints instead of paying for
   the audio again. Raw transcripts are keyed by what changes the audio result
   (model, mode, language) but not by the vocabulary: adding a term later
   redoes only the cheap proofreading and translation. */

const PROOF_WINDOW = 6000;
const TRANSLATE_WINDOW = 3500;

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
// The cut points are part of the key: chunk 2 of one plan is not chunk 2 of another.
export const rawKey = (settings, audio) => digest({ v: 2, model: settings.transcribeModel, mode: settings.mode, languages: settings.languageCodes, plan: audio?.chunks.map((c) => c.bytes.length) });
export const textKey = ({ settings, subject, vocabulary }) =>
  digest({ v: 3, provider: settings.textProvider, model: settings.textModel,
    proofreadReasoning: settings.proofreadReasoning || 'default', translateReasoning: settings.translateReasoning || 'low', subject, vocabulary });
/** Sources made from one recording; long recordings continue as -p2, -p3 … */
export const audioSourceId = (hash, key, index = 0) => `audio-${hash.slice(0, 16)}-${key}${index ? `-p${index + 1}` : ""}`;

export function checkpoints(dir) {
  return {
    async get(name) {
      if (!dir) return null;
      try { return parseStoredJson(await readFile(join(dir, name), "utf8")); } catch { return null; }
    },
    async set(name, value) {
      if (!dir) return;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), JSON.stringify(value), "utf8");
    },
  };
}
/**
 * The study model route as a plain text-in, text-out function. The host reads ANY third argument as the execution of a
 * generation job (it needs a job id and event hooks, and may start a sub-agent), so a bounded task like proofreading passes
 * none; cancellation is checked around the call instead.
 */
export const plainModel = (complete) => async (system, prompt, options = {}) => {
  options.signal?.throwIfAborted();
  const text = await complete(system, prompt);
  options.signal?.throwIfAborted();
  return text;
};
/** A model reply that is not JSON, described so the learner can tell what happened (not "Unexpected token S"). */
const asJson = (reply, read) => {
  try { return read(reply); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`模型没有按要求返回 JSON（回复开头是「${String(reply).replace(/\s+/g, " ").trim().slice(0, 40)}」）`);
    throw error;
  }
};
/** Errors that retrying the next window cannot fix: cancellation, a dead key, no money. */
const stops = (error, signal) => !!signal?.aborted || error?.name === "AbortError" || error?.fatal === true || isPermanentModelError(error);

async function proofreadWindow({ window, index, total, ctx, known }) {
  const text = window.join("\n\n");
  const ask = async (suffix = "") => asJson(await withModelRetry(() =>
    ctx.complete(PROOFREAD_SYSTEM, proofreadPrompt({ subject: ctx.subject, vocabulary: ctx.vocabulary, known, text }) + suffix,
      { signal: ctx.signal, task: "audio.proofread", kind: "proofread", part: index + 1, parts: total, stage: `校对 ${index + 1}/${total}` })), parseCorrections);
  let proposed;
  try {
    try { proposed = await ask(); }
    catch (error) {
      if (stops(error, ctx.signal) || isModelFailure(error)) throw error;
      proposed = await ask("\n\nYour previous reply was not the required JSON. Reply again with the JSON object only.");
    }
  } catch (error) {
    if (stops(error, ctx.signal) || isModelFailure(error)) throw error;
    ctx.warn(`第 ${index + 1} 段校对失败，这一段保留原转写：${String(error.message).slice(0, 120)}`);
    return { failed: true, error: String(error.message).slice(0, 120), paragraphs: window, applied: [], skipped: [] };
  }
  const result = applyCorrections(text, proposed), paragraphs = result.text.split("\n\n");
  // Corrections never contain line breaks, so the paragraph count must not move.
  if (paragraphs.length !== window.length) return { paragraphs: window, applied: [], skipped: result.skipped };
  return { paragraphs, applied: result.applied, skipped: result.skipped };
}

/** English speech is translated into Chinese; Chinese speech into English (`target` "en"). */
async function translateWindow({ window, index, total, previousTitles, ctx, target = "zh" }) {
  const ask = async (suffix = "") => normalizeTranslation(asJson(await withModelRetry(() =>
    ctx.complete(target === "en" ? TRANSLATE_TO_ENGLISH_SYSTEM : TRANSLATE_SYSTEM,
      translatePrompt({ subject: ctx.subject, vocabulary: ctx.vocabulary, previousTitles, paragraphs: window }) + suffix,
      { signal: ctx.signal, task: "audio.translate", kind: "translate", part: index + 1, parts: total, stage: `翻译 ${index + 1}/${total}` })), parseJson), window.length, target);
  let value;
  try { value = await ask(); }
  catch (error) {
    if (stops(error, ctx.signal) || isModelFailure(error)) throw error;
    value = await ask(`\n\nYour previous reply failed validation: ${error.message}. Reply again with a valid JSON object only.`);
  }
  return { titleZh: value.titleZh, titleEn: value.titleEn, translated: value.paragraphs };
}
/** A failure message that says which step of the import it came from. */
const inStep = (error, label) => Object.assign(new Error(`${label}失败：${error.message}`, { cause: error }),
  { ...error, name: error.name || 'Error' });

/** Small waves share one stable context; completed work is checkpointed immediately,
 * but collected in source order. Fatal failures cancel and settle sibling calls. */
async function orderedWindows(windows, concurrency, { signal, phase, progress, context, work, collect }) {
  const controller = new AbortController();
  const stageSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let done = 0;
  progress({ phase, done, total: windows.length });
  for (let offset = 0; offset < windows.length; offset += concurrency) {
    stageSignal.throwIfAborted();
    const shared = context();
    let failure;
    const outcomes = await Promise.allSettled(windows.slice(offset, offset + concurrency).map(async (window, at) => {
      try {
        stageSignal.throwIfAborted();
        const entry = await work(window, offset + at, shared, stageSignal);
        progress({ phase, done: ++done, total: windows.length });
        return entry;
      } catch (error) {
        if (!failure) { failure = error; controller.abort(error); }
        throw error;
      }
    }));
    if (failure) throw failure;
    stageSignal.throwIfAborted();
    for (const [at, outcome] of outcomes.entries()) collect(outcome.value, offset + at);
  }
}

/**
 * @param audio      result of loadAudio()
 * @param tiers      GeminiTiers (transcription, and text when the provider is gemini)
 * @param complete   (system, prompt, { signal, task }) → reply text, for proofreading and translation
 * @param settings   effective audio settings
 * @param progress   ({ phase, done, total }) called as work advances
 * @param track      (meta, run) → run(): wraps each transcription request so the job can list it as a task
 * @param warn       (text) collects learner-facing warnings
 */
export async function runAudioImport({ audio, tiers, complete, settings, vocabulary = [], subject = "", cacheDir, signal, progress = () => {}, warn = () => {}, milestone = async () => {}, track = (meta, run) => run() }) {
  const saved = checkpoints(cacheDir), keys = { raw: rawKey(settings, audio), text: textKey({ settings, subject, vocabulary }) };

  const texts = [];
  let transcribed = false;
  for (const [index, chunk] of audio.chunks.entries()) {
    signal?.throwIfAborted();
    progress({ phase: "transcribe", done: index, total: audio.chunks.length });
    const name = `raw-${keys.raw}-${index}.json`;
    let entry = await saved.get(name);
    if (!entry) {
      let result;
      try {
        result = await track({ kind: "transcribe", part: index + 1, parts: audio.chunks.length, stage: `转写 ${index + 1}/${audio.chunks.length}`, runtime: "gemini" }, () => tiers.transcribe({
          bytes: chunk.bytes, mimeType: audio.mimeType, kind: audio.ext, seconds: chunk.seconds, model: settings.transcribeModel, signal,
          config: { languageCodes: settings.languageCodes, mode: settings.mode, vocabulary },
        }));
      } catch (error) {
        throw inStep(error, `转写第 ${index + 1}/${audio.chunks.length} 段（约 ${Math.max(1, Math.round(chunk.seconds / 60))} 分钟，${(chunk.bytes.length / 1048576).toFixed(1)} MB）`);
      }
      entry = { text: result.text, tier: result.tier, seconds: chunk.seconds };
      await saved.set(name, entry);
      transcribed = true;
    }
    texts.push(entry.text);
  }
  progress({ phase: "transcribe", done: audio.chunks.length, total: audio.chunks.length });
  const raw = joinChunks(texts);
  if (!raw.trim()) throw new Error("没有转写出任何文字");
  // A resumed run finds the transcript already saved and paid for: it was announced the first time.
  if (transcribed) await milestone('transcribe');

  const finished = await finishTranscript({
    paragraphs: paragraphize(raw), filename: audio.filename, complete, settings, vocabulary, subject, saved, keys, signal, progress, warn, milestone,
  });
  return { ...finished, keys, transcriptChars: raw.length };
}

/**
 * Everything after the words exist: proofread the paragraphs, translate them
 * part by part, title the document and assemble it. Shared by audio files and
 * live sessions, which arrive here with their own paragraphs.
 *
 * @param saved  checkpoint store for this source (see checkpoints())
 * @param keys   { raw, text } names that keep checkpoints of different inputs apart
 */
export async function finishTranscript({ paragraphs, filename, complete, settings, vocabulary = [], subject = "", saved, keys, signal, progress = () => {}, warn = () => {}, milestone = async () => {} }) {
  const ctx = { complete, subject, vocabulary, signal, warn };
  const proofWindows = windowsOf(paragraphs, PROOF_WINDOW);
  const corrected = [], applied = [], skipped = [];
  let proofFailed = false, proofWorked = false, streak = 0, streakError = "";
  const concurrency = settings.textConcurrency === 2 ? 2 : 3;
  await orderedWindows(proofWindows, concurrency, { signal, phase: 'proofread', progress,
    context: () => applied.slice(-30),
    work: async (window, index, known, stageSignal) => {
      const name = `proof-${keys.raw}-${keys.text}-${index}-${digest(window)}.json`;
      let entry = await saved.get(name);
      if (!entry) {
        try { entry = await proofreadWindow({ window, index, total: proofWindows.length, ctx: { ...ctx, signal: stageSignal }, known }); }
        catch (error) { throw inStep(error, `校对第 ${index + 1}/${proofWindows.length} 段`); }
        proofWorked = true;
        if (!entry.failed) await saved.set(name, entry);
      }
      return entry;
    },
    collect: (entry, index) => {
      if (!entry.failed) streak = 0;
      else {
        // Check in source order, independent of which child finishes first.
        streak = entry.error === streakError ? streak + 1 : 1;
        streakError = entry.error;
        if (streak >= 2) throw inStep(new Error(`连续 ${streak} 段用同样的错误失败（${entry.error}）。已停下，免得白白消耗额度；转写和已完成的部分都保留着，问题解决后点「接着做」`), `校对第 ${index + 1}/${proofWindows.length} 段`);
      }
      corrected.push(...entry.paragraphs);
      if (entry.failed) proofFailed = true;
      applied.push(...entry.applied);
      skipped.push(...entry.skipped);
    },
  });
  if (proofWorked) await milestone('proofread', { partial: proofFailed });

  const windows = windowsOf(corrected, TRANSLATE_WINDOW), parts = [];
  const target = cjkShare(corrected.join("")) >= 0.5 ? "en" : "zh";
  let translateWorked = false;
  await orderedWindows(windows, concurrency, { signal, phase: 'translate', progress,
    context: () => parts.slice(-8).map(part => part.titleEn),
    work: async (window, index, previousTitles, stageSignal) => {
      const name = `part-${keys.raw}-${keys.text}-${index}-${digest(window)}.json`;
      let entry = await saved.get(name);
      if (!entry) {
        translateWorked = true;
        try { entry = await translateWindow({ window, index, total: windows.length, previousTitles, ctx: { ...ctx, signal: stageSignal }, target }); }
        catch (error) { throw inStep(error, `翻译第 ${index + 1}/${windows.length} 部分`); }
        await saved.set(name, entry);
      }
      return { entry, window };
    },
    collect: ({ entry, window }) => {
      const translated = entry.translated ?? entry.chinese;
      parts.push({ titleZh: entry.titleZh, titleEn: entry.titleEn,
        ...(target === "en" ? { chinese: window, english: translated, sourceLanguage: "zh" } : { english: window, chinese: translated }) });
    },
  });
  if (translateWorked) await milestone('translate');

  let titleEn = filename.replace(/\.[^.]+$/, "");
  try {
    const partTitles = parts.slice(0, 40).map((p) => p.titleEn);
    const titleFile = `title-${keys.raw}-${keys.text}-${digest(partTitles)}.json`;
    let reply = await saved.get(titleFile);
    if (!reply) {
      reply = parseJson(await complete(TITLE_SYSTEM,
        JSON.stringify({ filename, subject, partTitles }), { signal, task: "audio.title", kind: "title", stage: "生成标题" }));
      if (String(reply?.titleEn || '').trim()) await saved.set(titleFile, reply);
    }
    titleEn = String(reply?.titleEn ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || titleEn;
  } catch (error) { if (stops(error, signal)) throw error; }

  return {
    documents: buildDocuments({ filename, titleEn, parts }),
    titleEn, parts: parts.length, transcriptChars: paragraphs.reduce((n, p) => n + p.length, 0),
    corrections: { applied, skipped },
  };
}
