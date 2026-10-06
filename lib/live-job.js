import { join } from "node:path";
import { finishedJob, storeDocuments, taskTracker } from "./audio-job.js";
import { audioReasoning } from './audio-dashboard.js';
import { checkpoints, finishTranscript, textKey } from "./audio-import.js";
import { tiersFromSettings } from "./gemini.js";
import { clock, digest, paragraphsOf } from "./live-save.js";
import { addSourceCourses, importCourses } from './source-courses.js';
import { languageSystem } from './language.js';

/* "Proofread and save" for a live class: the transcript is already here, so
   the audio pipeline starts at the proofreading pass. The live translations
   are not reused (proofreading can change the English, and the document is
   translated part by part), which means one more translation pass. */

const liveSourceId = (session, key, content, index = 0) => `live-${session.id.slice(0, 8)}-${digest(content + key)}${index ? `-p${index + 1}` : ""}`;

/**
 * What one proofread save is: the paragraphs of the class as it stands, the context it was asked in and the key that makes its result reusable.
 * Two saves of the same class under the same settings make the same sources.
 */
export function livePlan({ session, settings }) {
  const segments = session.segments.filter((s) => s.en), paragraphs = paragraphsOf(segments), vocabulary = session.vocabulary, subject = session.subject;
  const key = textKey({ settings, subject, vocabulary });
  return { session, segments, paragraphs, vocabulary, subject, key, content: paragraphs.join("\n"), courses: importCourses({ course: session.course }),
    cache: `live-${session.id.slice(0, 16)}` };
}

/** The sources an earlier save of the same plan already made (none when it was never saved). */
export function existingLiveSources(state, plan) {
  const existing = [];
  while (state.sources.some((s) => s.id === liveSourceId(plan.session, plan.key, plan.content, existing.length))) existing.push(liveSourceId(plan.session, plan.key, plan.content, existing.length));
  return existing;
}

/** Proofread, translate and title the class. `complete` is the audio text model (host or Gemini); progress and warnings land on `job`. */
export function translateLive({ plan, job, settings, root, complete, signal, pools }) {
  job.warnings ||= [];
  return finishTranscript({
    paragraphs: plan.paragraphs, filename: plan.session.title, complete, settings, vocabulary: plan.vocabulary, subject: plan.subject, signal, language: job.language, pools,
    saved: checkpoints(join(root, "audio-cache", plan.cache)), keys: { raw: `live${plan.segments.length}`, text: plan.key },
    progress: ({ phase, done, total }) => { Object.assign(job, { phase, done, total }); job.steps = { ...job.steps, [phase]: { done, total } }; },
    warn: (text) => { if (!job.warnings.includes(text)) job.warnings.push(text); },
  });
}

/** The documents of a finished save as sources (`store.publishSources` or `store.update` writes them), with what the save spent. */
export async function storeLive({ store, plan, result, settings, usage, job }) {
  const { session } = plan, ids = result.documents.map((_, index) => liveSourceId(session, plan.key, plan.content, index));
  const meta = {
    live: true, sessionId: session.id, filename: session.title, seconds: Math.round(session.elapsedMs / 1000),
    titleEn: result.titleEn, partCount: result.parts, textProvider: settings.textProvider, textModel: settings.textModel,
    subject: plan.subject, vocabularyTerms: plan.vocabulary.length, usage, proofread: true,
  };
  await storeDocuments({ store, ids, documents: result.documents, title: session.title, meta, corrections: result.corrections, courses: plan.courses, language: job.language });
  finishedJob(job, { ids, usage, result });
}

/** The old path: every request is a task of `job`; the host model is called as it always was (its tokens reach the daily ledger, not the task). */
export async function executeLiveSaveJob({ job, session, args, settings, store, complete, fetch, signal }) {
  const plan = livePlan({ session, settings });
  Object.assign(job, { minutes: Math.round(session.elapsedMs / 6000) / 10, chunks: 1 });
  job.warnings ||= [];
  const existing = existingLiveSources(await store.read(), plan);
  if (existing.length) {
    await store.update(s => addSourceCourses(s, existing, plan.courses));
    const noteId = await storeLiveNotes(store, session, job.language);
    Object.assign(job, { reused: true, sourceIds: [...existing, ...(noteId ? [noteId] : [])] }); return;
  }

  const tiers = tiersFromSettings(settings, { fetch, skipFree: args.paidOnly === true });
  const track = taskTracker(job);
  const provider = (system, prompt, options = {}) => track({ kind: options.kind, stage: options.stage,
    reasoning: audioReasoning(settings, options.kind) }, async task => {
    if (settings.textProvider === 'host' && complete) return complete(system, prompt, { jobId: job.id,
      stage: task.stage, reasoningEffort: task.reasoning, resultOwner: 'plugin', signal: options.signal,
      onEvent: event => Object.assign(task, event) });
    const text = await tiers.complete(settings.textModel, languageSystem(system, job.language), prompt, { signal: options.signal, stage: options.kind,
      thinkingLevel: task.reasoning, label: '文本处理', onReasoning: reasoning => { task.reasoningEffort = reasoning; } });
    return text;
  });
  const result = await translateLive({ plan, job, settings, root: store.root, complete: provider, signal });
  signal.throwIfAborted();
  const usage = tiers.summary();
  for (const text of tiers.warnings) if (!job.warnings.includes(text)) job.warnings.push(text);
  await storeLive({ store, plan, result, settings, usage, job });
  const noteId = await storeLiveNotes(store, session, job.language);
  if (noteId) job.sourceIds.push(noteId);
}

export async function storeLiveNotes(store, session, language) {
  const correction = session.correction?.snapshot();
  if (!correction || (!correction.memory.text && !correction.notes.length)) return null;
  const refs = ids => ids.map(id => {
    const segment = session.segments.find(item => item.id === id);
    return `${language === 'en' ? 'Sentence' : '句'} ${id}${segment ? ` · ${clock(segment.t)}` : ''}`;
  }).join('；');
  const label = language === 'en' ? 'Class notes' : '课堂笔记';
  const noteTitles = language === 'en' ? { amendment: 'Historical correction', record: 'Class record' }
    : { amendment: '历史校正补记', record: '课堂记录' };
  const lines = [`# ${session.title} · ${label}`, '', language === 'en' ? 'Generated from the live recording. This summary does not replace the transcript; verify uncertain points against the original speech.' : '依据实录生成；摘要不能代替逐字稿，存在疑义时请核对原话。', '', language === 'en' ? '## Cumulative summary' : '## 累计摘要', '',
    correction.memory.text, '', `${language === 'en' ? 'References: ' : '引用：'}${refs(correction.memory.refs)}`, '', language === 'en' ? '## Batch notes' : '## 分批笔记', ''];
  for (const note of correction.notes) lines.push(`### ${noteTitles[note.kind === 'amendment' ? 'amendment' : 'record']} · ${refs(note.refs)}`, '', note.text, '');
  if (correction.background.failed) lines.push(language === 'en' ? '## Needs verification' : '## 待核对', '', ...session.correction.tasks.filter(task => task.status === 'failed').map(task => `- ${refs(task.ids)}：${task.reason}（${task.error}）`), '');
  const text = lines.join('\n'), id = `live-${session.id.slice(0, 8)}-notes-${digest(text)}`;
  if (store.publishSources) {
    await store.publishSources([{ id, title: `${session.title} · ${label}`, text, createdAt: new Date().toISOString(),
      courses: importCourses({ course: session.course }), live: { sessionId: session.id, kind: 'notes' } }]);
    return id;
  }
  await store.update(state => {
    if (!state.sources.some(source => source.id === id)) state.sources.push({ id, title: `${session.title} · ${label}`, text,
      createdAt: new Date().toISOString(), courses: importCourses({ course: session.course }), live: { sessionId: session.id, kind: 'notes' } });
  });
  return id;
}

export { liveSourceId };
