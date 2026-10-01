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

export async function executeLiveSaveJob({ job, session, args, settings, store, complete, fetch, signal }) {
  const segments = session.segments.filter((s) => s.en);
  const paragraphs = paragraphsOf(segments);
  const vocabulary = session.vocabulary, subject = session.subject;
  Object.assign(job, { minutes: Math.round(session.elapsedMs / 6000) / 10, chunks: 1 });
  job.warnings ||= [];

  const key = textKey({ settings, subject, vocabulary });
  const content = paragraphs.join("\n");
  const state = await store.read();
  const existing = [];
  while (state.sources.some((s) => s.id === liveSourceId(session, key, content, existing.length))) existing.push(liveSourceId(session, key, content, existing.length));
  if (existing.length) {
    await store.update(s => addSourceCourses(s, existing, importCourses({ course: session.course })));
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
  const result = await finishTranscript({
    paragraphs, filename: session.title, complete: provider, settings, vocabulary, subject, signal, language: job.language,
    saved: checkpoints(join(store.root, "audio-cache", `live-${session.id.slice(0, 16)}`)),
    keys: { raw: `live${segments.length}`, text: key },
    progress: ({ phase, done, total }) => { Object.assign(job, { phase, done, total }); job.steps = { ...job.steps, [phase]: { done, total } }; },
    warn: (text) => { if (!job.warnings.includes(text)) job.warnings.push(text); },
  });
  signal.throwIfAborted();

  const usage = tiers.summary();
  for (const text of tiers.warnings) if (!job.warnings.includes(text)) job.warnings.push(text);
  const ids = result.documents.map((_, index) => liveSourceId(session, key, content, index));
  const meta = {
    live: true, sessionId: session.id, filename: session.title, seconds: Math.round(session.elapsedMs / 1000),
    titleEn: result.titleEn, partCount: result.parts, textProvider: settings.textProvider, textModel: settings.textModel,
    subject, vocabularyTerms: vocabulary.length, usage, proofread: true,
  };
  await storeDocuments({ store, ids, documents: result.documents, title: session.title, meta, corrections: result.corrections, courses: importCourses({ course: session.course }), language: job.language });
  finishedJob(job, { ids, usage, result });
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
