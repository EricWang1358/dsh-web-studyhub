import { join } from "node:path";
import { finishedJob, jobTextModel, storeDocuments } from "./audio-job.js";
import { checkpoints, finishTranscript, textKey } from "./audio-import.js";
import { digest } from "./live-save.js";
import { addSourceCourses } from './source-courses.js';
import { cueParagraphs, parseSubtitles } from "./subtitles.js";

/* Proofread and translate a downloaded subtitle file (a Bilibili lecture, say).
   The text already exists, so like a live class the audio pipeline starts at
   proofreading: no transcription and no Gemini audio quota. Subtitle start
   times are kept in front of each paragraph of the finished document. */

export const subtitleSourceId = (content, key, index = 0) => `subtitle-${digest(content + key)}${index ? `-p${index + 1}` : ""}`;

/** Cues of an uploaded subtitle file as the job input; throws before a job starts when the file is not usable. */
export function prepareSubtitles({ text, filename }) {
  const cues = parseSubtitles(text, filename), { paragraphs, labels, seconds } = cueParagraphs(cues);
  return { filename, paragraphs, labels, seconds, cues: cues.length };
}

/** `args` is the resolved import context (audioContext): courses, course and vocabulary. */
export async function executeSubtitleJob({ job, input, args, settings, store, complete, fetch, signal }) {
  const { paragraphs, labels, seconds, filename } = input, subject = String(args.subject || "").trim();
  const vocabulary = args.vocabulary || [], courses = args.courses || [];
  const title = String(args.title || "").trim() || filename.replace(/\.[^.]+$/, "");
  Object.assign(job, { minutes: Math.round(seconds / 6) / 10, chunks: 1, phase: "proofread", stage: "校对字幕" });
  job.warnings ||= [];

  const key = textKey({ settings, subject, vocabulary });
  const content = JSON.stringify({ paragraphs, labels, seconds });
  const state = await store.read(), existing = [];
  while (state.sources.some((s) => s.id === subtitleSourceId(content, key, existing.length))) existing.push(subtitleSourceId(content, key, existing.length));
  if (existing.length) {
    await store.update(s => addSourceCourses(s, existing, courses));
    Object.assign(job, { reused: true, sourceIds: existing }); return;
  }

  const { model, tiers } = jobTextModel(job, settings, { complete, fetch, paidOnly: args.paidOnly });
  const result = await finishTranscript({
    paragraphs, labels, filename: title, complete: model, settings, vocabulary, subject, signal, language: job.language,
    saved: checkpoints(join(store.root, "audio-cache", `subtitle-${digest(content).slice(0, 16)}`)),
    keys: { raw: `sub${paragraphs.length}`, text: key },
    progress: ({ phase, done, total }) => { Object.assign(job, { phase, done, total }); job.steps = { ...job.steps, [phase]: { done, total } }; },
    warn: (text) => { if (!job.warnings.includes(text)) job.warnings.push(text); },
  });
  signal.throwIfAborted();

  const usage = tiers.summary();
  for (const text of tiers.warnings) if (!job.warnings.includes(text)) job.warnings.push(text);
  const ids = result.documents.map((_, index) => subtitleSourceId(content, key, index));
  const meta = {
    subtitle: true, filename, seconds, titleEn: result.titleEn, partCount: result.parts,
    textProvider: settings.textProvider, textModel: settings.textModel, subject, course: args.course,
    vocabularyTerms: vocabulary.length, usage, proofread: true,
  };
  await storeDocuments({ store, ids, documents: result.documents, title, meta, corrections: result.corrections, courses, language: job.language });
  finishedJob(job, { ids, usage, result });
}
