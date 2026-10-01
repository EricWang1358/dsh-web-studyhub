import { join } from "node:path";
import { localizeAppMessage } from './application-messages.js';
import { languageSystem } from './language.js';
import { loadAudio } from "./audio-file.js";
import { audioSourceId, checkpoints, runAudioImport, textKey } from "./audio-import.js";
import { addUsage, usageBefore } from "./audio-usage.js";
import { audioReasoning, recordAudioUsage } from './audio-dashboard.js';
import { courseOf, currentCourse } from "./focus.js";
import { addSourceCourses, importCourses } from './source-courses.js';
import { TRANSCRIBE_USD_PER_MINUTE, tiersFromSettings } from "./gemini.js";
import { buildVocabulary, termList } from "./transcript.js";
import { notify } from './inbox.js';
import { id } from "./util.js";
import { withJobUsage } from "./token-usage.js";

/* One audio import, run by the service as a background job. The job object is
   the public progress record (phase, done/total, warnings, usage); this file
   fills it in and saves the finished bilingual transcript as study sources. */

const MAX_LISTED = 300;
const MAX_TASKS = 150;
// An item that finished sooner than this came from the checkpoints, and says nothing about how fast the model is.
const SLOW_ITEM_MS = 1500;

/** Deck titles and card topics of a course: the vocabulary its lectures are likely to use. */
export function courseTopics(state, course) {
  if (course == null) return [];
  const topics = new Set();
  for (const deck of state.decks.filter((d) => courseOf(d) === course)) {
    topics.add(deck.title);
    for (const card of deck.cards || []) if (card.topic) topics.add(card.topic);
  }
  return [...topics];
}

/** The service calls this before queueing; retries retain exactly this context. */
export function audioContext(state, args) {
  const courses = importCourses(args, currentCourse(state));
  const course = courses.includes(currentCourse(state)) ? currentCourse(state) : courses.length === 1 ? courses[0] : '';
  return { ...args, course, courses,
    vocabulary: buildVocabulary({ terms: termList(args.terms), topics: courses.flatMap(name => courseTopics(state, name)) }) };
}

/**
 * Save the finished documents as sources. `corrections` (what proofreading
 * changed) rides on the first source only; a source that already exists is left alone.
 */
export async function storeDocuments({ store, ids, documents, title, meta, corrections, courses = [], language }) {
  const createdAt = new Date().toISOString(), count = documents.length;
  const suffix = language === 'en' ? 'Bilingual transcript' : '中英对照逐字稿';
  if (store.publishSources) return store.publishSources(documents.map((text, index) => ({
    id: ids[index], createdAt, text, courses,
    title: count > 1 ? `${title} · ${suffix} (${index + 1}/${count})` : `${title} · ${suffix}`,
    audio: { ...meta, sourceIds: ids, ...(meta.batch ? { batch: { ...meta.batch, volume: index + 1, volumes: count, sourceIds: ids } } : {}), importedAt: createdAt,
      ...(index ? {} : { corrections: { applied: corrections.applied.slice(0, MAX_LISTED), appliedCount: corrections.applied.length,
        skipped: corrections.skipped.slice(0, MAX_LISTED), skippedCount: corrections.skipped.length } }) },
  })));
  await store.update((s) => {
    documents.forEach((text, index) => {
      if (s.sources.some((x) => x.id === ids[index])) return;
      s.sources.push({
        id: ids[index], createdAt, text, courses,
        title: count > 1 ? `${title} · ${suffix} (${index + 1}/${count})` : `${title} · ${suffix}`,
        audio: { ...meta, sourceIds: ids, ...(meta.batch ? { batch: { ...meta.batch, volume: index + 1, volumes: count, sourceIds: ids } } : {}), importedAt: createdAt, ...(index ? {} : { corrections: {
          applied: corrections.applied.slice(0, MAX_LISTED), appliedCount: corrections.applied.length,
          skipped: corrections.skipped.slice(0, MAX_LISTED), skippedCount: corrections.skipped.length,
        } }) },
      });
    });
    addSourceCourses(s, ids, courses);
  });
}
/** The job fields the panel shows once sources are saved. */
export const finishedJob = (job, { ids, usage, result }) => Object.assign(job, {
  sourceIds: ids, usage, titleEn: result.titleEn, partCount: result.parts,
  corrected: result.corrections.applied.length, uncertain: result.corrections.skipped.filter((c) => c.skipped === "low-confidence").length,
});

/**
 * Every model request of the job as a task ({ kind, part, parts, stage, status, runtime, childId, startedAt, finishedAt }):
 * the panel lists them, and when the host runs one as a DSH sub-agent its childId opens that agent's output and tool calls.
 */
export function taskTracker(job) {
  job.tasks ||= [];
  return async (meta, run) => {
    const task = { id: id(), ...meta, status: "starting", startedAt: new Date().toISOString() };
    task.stage = localizeAppMessage(task.stage, job.language || 'zh');
    job.tasks.push(task);
    if (job.tasks.length > MAX_TASKS) job.tasks.splice(0, job.tasks.length - MAX_TASKS);
    try {
      const value = await run(task);
      task.runtime ||= "direct";
      task.status = "complete";
      return value;
    } catch (error) {
      task.status = error?.name === "AbortError" ? "cancelled" : "failed";
      throw error;
    } finally {
      task.finishedAt = new Date().toISOString();
      if (['proofread', 'translate'].includes(task.kind)) await recordAudioUsage({ type: 'stage', at: Date.now(),
        stage: task.kind, reasoning: task.reasoningEffort || task.reasoning || 'default', success: task.status === 'complete',
        elapsedMs: Date.parse(task.finishedAt) - Date.parse(task.startedAt) }).catch(() => {});
    }
  };
}

/**
 * The text model of a job that has no audio to transcribe (subtitles, a second look at unsure fixes): the DSH model
 * when the settings say host, else Gemini's text model. Every call is a tracked task of the job.
 */
export function jobTextModel(job, settings, { complete, fetch, paidOnly = false }) {
  const tiers = tiersFromSettings(settings, { fetch, skipFree: paidOnly === true });
  const track = taskTracker(job);
  const model = (system, prompt, options = {}) => track({ kind: options.kind, stage: options.stage, part: options.part, parts: options.parts,
    reasoning: audioReasoning(settings, options.kind) }, async task => {
    if (settings.textProvider === 'host' && complete) return withJobUsage(job, task, () => complete(system, prompt, { jobId: job.id,
      stage: task.stage, reasoningEffort: task.reasoning, resultOwner: 'plugin', signal: options.signal,
      onEvent: event => Object.assign(task, event) }));
    return tiers.complete(settings.textModel, languageSystem(system, job.language), prompt, { signal: options.signal, stage: options.kind,
      thinkingLevel: task.reasoning, label: '文本处理', onReasoning: reasoning => { task.reasoningEffort = reasoning; } });
  });
  return { model, tiers };
}

/** A job without transcription needs a text model: the DSH model, or a Gemini key for Gemini text. */
export function assertTextModel(settings, complete) {
  if (settings.textProvider === 'host' ? !complete : !settings.freeKey && !settings.paidKey && !settings.groqKey)
    throw new Error(settings.textProvider === 'host' ? '当前没有可用的对话模型' : '还没有配置 Gemini API 密钥（或 Groq 密钥）：请在「设置 › 音频转写」里填写');
}

/**
 * How long the items of each phase take, so the panel can say roughly how long the phase has left:
 * job.pace[phase] = { at: when the current item started, since, each: average ms of the slow items so far }.
 */
export function paceTracker(job) {
  const seen = {};
  return ({ phase, done }) => {
    const now = Date.now(), entry = (seen[phase] ||= { done, at: now, since: now, took: [] });
    if (done > entry.done) {
      if (done - entry.done === 1 && now - entry.at > SLOW_ITEM_MS) entry.took = [...entry.took, now - entry.at].slice(-5);
      Object.assign(entry, { done, at: now });
    }
    const each = entry.took.length ? Math.round(entry.took.reduce((sum, ms) => sum + ms, 0) / entry.took.length) : null;
    job.pace = { ...job.pace, [phase]: { at: entry.at, since: entry.since, each } };
  };
}

const turns = new Map(); // audio hash → when the last import of that recording in line will be over
/**
 * Run `work` when no other import of the same recording is running. The same file under two names must not be transcribed,
 * and paid for, twice at once: the second waits, then finds the first one's work (or its saved source).
 */
export async function exclusive(hash, signal, work, { waiting = () => {}, resumed = () => {} } = {}) {
  const before = turns.get(hash) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  const queued = turns.has(hash);
  turns.set(hash, tail);
  let onAbort;
  try {
    if (queued) {
      waiting();
      await new Promise((resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
        before.then(resolve);
      });
      resumed();
    }
    signal?.throwIfAborted();
    return await work();
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    release();
    if (turns.get(hash) === tail) turns.delete(hash);
  }
}

export async function executeAudioJob({ job, args, settings, store, complete, fetch, signal, publish = true }) {
  job.phase = "read";
  const audio = await loadAudio({ path: args.path, partSeconds: (settings.partMinutes || 59) * 60 });
  if (args.inputHash && audio.hash !== args.inputHash) throw new Error(`音频文件已改变：${audio.filename}。请作为新批次重新提交`);
  job.warnings ||= [];
  for (const text of audio.warnings) if (!job.warnings.includes(text)) job.warnings.push(text);
  Object.assign(job, {
    minutes: audio.seconds ? Math.round(audio.seconds / 6) / 10 : null, chunks: audio.chunks.length,
    estimatedUsd: audio.seconds ? Math.round(audio.seconds / 60 * TRANSCRIBE_USD_PER_MINUTE * 1000) / 1000 : null,
  });
  signal.throwIfAborted();
  return exclusive(audio.hash, signal, () => importAudio({ job, args, settings, store, complete, fetch, signal, audio, publish }),
    { waiting: () => { job.phase = "queued"; }, resumed: () => { job.phase = "read"; } });
}

async function importAudio({ job, args, settings, store, complete, fetch, signal, audio, publish }) {
  const state = await store.read();
  const subject = String(args.subject || "").trim();
  const vocabulary = args.vocabulary || buildVocabulary({ terms: termList(args.terms), topics: courseTopics(state, args.course) });
  job.vocabulary = vocabulary.length;

  const key = textKey({ settings, subject, vocabulary });
  const existing = [];
  while (state.sources.some((s) => s.id === audioSourceId(audio.hash, key, existing.length))) existing.push(audioSourceId(audio.hash, key, existing.length));
  if (publish && existing.length) {
    await store.update(s => addSourceCourses(s, existing, args.courses || importCourses(args)));
    Object.assign(job, { reused: true, sourceIds: existing }); return;
  }
  if (!publish && existing.length) {
    const sources = existing.map(sourceId => state.sources.find(source => source.id === sourceId));
    const meta = sources[0].audio || {}, corrections = meta.corrections || { applied: [], skipped: [] };
    const result = { documents: sources.map(source => source.text), meta, corrections,
      titleEn: meta.titleEn || audio.filename, parts: meta.partCount || sources.length };
    finishedJob(job, { ids: [], usage: meta.usage, result });
    job.reused = true;
    return result;
  }

  const tiers = tiersFromSettings(settings, { fetch, skipFree: args.paidOnly === true });
  const track = taskTracker(job), pace = paceTracker(job);
  const describe = (options = {}) => ({ kind: options.kind, part: options.part, parts: options.parts, stage: options.stage || "文本处理" });
  // With the host model each request is a DSH sub-agent; its events (child id, status) land on the task.
  const provider = settings.textProvider === "host" && complete
    ? (system, prompt, options = {}) => track({ ...describe(options), reasoning: audioReasoning(settings, options.kind) }, (task) =>
      withJobUsage(job, task, () => complete(system, prompt, { jobId: job.id, stage: task.stage, resultOwner: 'plugin', reasoningEffort: task.reasoning,
        signal: options.signal, onEvent: (event) => Object.assign(task, event) })))
    : (system, prompt, options = {}) => track({ ...describe(options), runtime: "gemini", reasoning: audioReasoning(settings, options.kind) }, async task => {
      const text = await tiers.complete(settings.textModel, languageSystem(system, job.language), prompt, { signal: options.signal, stage: options.kind, thinkingLevel: task.reasoning, label: "文本处理",
        onReasoning: reasoning => { task.reasoningEffort = reasoning; } });
      return text;
    });
  const cacheDir = join(store.root, "audio-cache", audio.hash.slice(0, 16)), saved = checkpoints(cacheDir);
  // What earlier attempts at this recording spent stays in the tally; this run adds to it whether it finishes or not.
  const earlier = await usageBefore(saved, audio, settings);
  job.textProvider = settings.textProvider;
  const importing = () => runAudioImport({
    audio, tiers, settings, vocabulary, subject, signal, track, language: job.language,
    complete: provider,
    cacheDir,
    progress: ({ phase, done, total }) => { Object.assign(job, { phase, done, total }); job.steps = { ...job.steps, [phase]: { done, total } }; pace({ phase, done }); },
    milestone: (phase, { partial = false } = {}) => publish ? store.update(s => notify(s, {
      kind: `audio-${phase}${partial ? '-warning' : ''}`, jobId: job.id, filename: audio.filename,
      detail: partial ? '部分段落校对失败，已保留原转写；其余步骤继续。' : '后台处理继续进行；全部完成后可打开中英对照资料。',
    })) : Promise.resolve(),
    warn: (text) => { if (!job.warnings.includes(text)) job.warnings.push(text); },
  });
  let result;
  try { result = await importing(); } finally {
    const now = tiers.summary();
    job.usage = addUsage(earlier, now);
    job.usageRun = now;
    try { await saved.set("usage.json", job.usage); } catch { /* the card still shows it */ }
  }
  signal.throwIfAborted();

  const usage = job.usage, title = String(args.title || "").trim() || audio.filename;
  for (const text of tiers.warnings) if (!job.warnings.includes(text)) job.warnings.push(text);
  const meta = {
    hash: audio.hash, filename: audio.filename, seconds: audio.seconds, chunks: audio.chunks.length,
    titleEn: result.titleEn, partCount: result.parts, transcribeModel: settings.transcribeModel, mode: settings.mode,
    textProvider: settings.textProvider, textModel: settings.textModel, subject, course: args.course, vocabularyTerms: vocabulary.length, usage,
  };
  const ids = result.documents.map((_, index) => audioSourceId(audio.hash, key, index));
  if (publish) await storeDocuments({ store, ids, documents: result.documents, title, meta, corrections: result.corrections, courses: args.courses || importCourses(args), language: job.language });
  finishedJob(job, { ids: publish ? ids : [], usage, result });
  return { documents: result.documents, meta, corrections: result.corrections, titleEn: result.titleEn, parts: result.parts };
}
