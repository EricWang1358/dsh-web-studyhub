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

/**
 * What one subtitle import is: its paragraphs, the context it was asked in (`args` is the resolved import context of audioContext: courses, course,
 * vocabulary) and the key that makes its result reusable. Two imports with the same plan make the same sources.
 */
export function subtitlePlan({ input, args, settings }) {
  const { paragraphs, labels, seconds, filename } = input, subject = String(args.subject || "").trim();
  const vocabulary = args.vocabulary || [], courses = args.courses || [];
  const key = textKey({ settings, subject, vocabulary }), content = JSON.stringify({ paragraphs, labels, seconds });
  return { paragraphs, labels, seconds, filename, subject, vocabulary, courses, course: args.course, key, content,
    title: String(args.title || "").trim() || filename.replace(/\.[^.]+$/, ""), cache: `subtitle-${digest(content).slice(0, 16)}` };
}

/** What names one import while it runs: the same cues under the same settings are the same import, whatever the file is called. */
export const subtitleKey = plan => `${plan.cache}:${plan.key}`;

/** The sources an earlier import of the same plan already made (none when it was never imported). */
export function existingSubtitleSources(state, plan) {
  const existing = [];
  while (state.sources.some(source => source.id === subtitleSourceId(plan.content, plan.key, existing.length))) existing.push(subtitleSourceId(plan.content, plan.key, existing.length));
  return existing;
}

/** Proofread, translate and title the paragraphs. `complete` is the audio text model (host or Gemini); progress and warnings land on `job`. */
export function translateSubtitle({ plan, job, settings, root, complete, signal, pools }) {
  job.warnings ||= [];
  return finishTranscript({
    paragraphs: plan.paragraphs, labels: plan.labels, filename: plan.title, complete, settings, vocabulary: plan.vocabulary, subject: plan.subject, signal,
    language: job.language, pools, saved: checkpoints(join(root, "audio-cache", plan.cache)), keys: { raw: `sub${plan.paragraphs.length}`, text: plan.key },
    progress: ({ phase, done, total }) => { Object.assign(job, { phase, done, total }); job.steps = { ...job.steps, [phase]: { done, total } }; },
    warn: (text) => { if (!job.warnings.includes(text)) job.warnings.push(text); },
  });
}

/** The documents of a finished import as sources (`store.publishSources` or `store.update` writes them), with what the import spent. */
export async function storeSubtitle({ store, plan, result, settings, usage, job }) {
  const ids = result.documents.map((_, index) => subtitleSourceId(plan.content, plan.key, index));
  const meta = {
    subtitle: true, filename: plan.filename, seconds: plan.seconds, titleEn: result.titleEn, partCount: result.parts,
    textProvider: settings.textProvider, textModel: settings.textModel, subject: plan.subject, course: plan.course,
    vocabularyTerms: plan.vocabulary.length, usage, proofread: true,
  };
  await storeDocuments({ store, ids, documents: result.documents, title: plan.title, meta, corrections: result.corrections, courses: plan.courses, language: job.language });
  finishedJob(job, { ids, usage, result });
}

/** The old path: `complete`/`fetch` are the service's own model and network; every request is a task of `job`. */
export async function executeSubtitleJob({ job, input, args, settings, store, complete, fetch, signal }) {
  const plan = subtitlePlan({ input, args, settings });
  Object.assign(job, { minutes: Math.round(plan.seconds / 6) / 10, chunks: 1, phase: "proofread", stage: "校对字幕" });
  job.warnings ||= [];
  const existing = existingSubtitleSources(await store.read(), plan);
  if (existing.length) {
    await store.update(s => addSourceCourses(s, existing, plan.courses));
    Object.assign(job, { reused: true, sourceIds: existing }); return;
  }
  const { model, tiers } = jobTextModel(job, settings, { complete, fetch, paidOnly: args.paidOnly });
  const result = await translateSubtitle({ plan, job, settings, root: store.root, complete: model, signal });
  signal.throwIfAborted();
  const usage = tiers.summary();
  for (const text of tiers.warnings) if (!job.warnings.includes(text)) job.warnings.push(text);
  await storeSubtitle({ store, plan, result, settings, usage, job });
}
