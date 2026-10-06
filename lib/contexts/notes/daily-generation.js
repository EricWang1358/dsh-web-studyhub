import { notify } from '../../inbox.js';
import { normalizeDailyRecapSettings } from '../../daily-recap-settings.js';
import { recapPrompt, checkedRecapMarkdown, recapFingerprint, polishRecapMarkdown } from '../../daily-recap.js';

export const RECAP_BATCH_SIZE = 30;
export const recapTitle = (daily, language) => `${daily.day} · ${daily.course} · ${language === 'en' ? 'Daily study recap' : '每日学习总结'}`.slice(0, 200);

function activeGeneration(state, job) {
  const note = state.notes.find(item => item.id === job.noteId);
  return note?.generation?.id === job.id && note.generation.status === 'running' ? note : undefined;
}

// Every progress, batch and final write belongs to the same job and revision.
function updateGeneration(store, job, update) {
  return store.update(state => {
    const note = activeGeneration(state, job);
    if (!note || (note.revision || 0) !== note.generation.revision) return false;
    if (job.automatic && (!normalizeDailyRecapSettings(state.settings?.dailyRecap).automatic || note.daily.manualEditedAt)) {
      note.generation.status = 'cancelled';
      delete note.generation.progress;
      return false;
    }
    update(note, state);
    return true;
  });
}

async function draftDailyRecap({ complete, language, job, saveBatches, organize }) {
  const { group, tone, final, force, signal } = job;
  const base = { day: group.day, course: group.course, courseId: group.courseId, tone, final,
    answeredCount: group.answeredCount, wrongCount: group.wrongCount, unassessedCount: group.unassessedCount };
  const system = recapPrompt(tone, language);
  const stage = group.questions.length > RECAP_BATCH_SIZE ? 'prepare' : 'recap';
  const chunks = [], cached = job.fragments;
  for (let offset = 0; offset < group.questions.length; offset += RECAP_BATCH_SIZE) {
    const questions = group.questions.slice(offset, offset + RECAP_BATCH_SIZE);
    const fingerprint = recapFingerprint({ questions, tone, language, ...(stage === 'recap' ? { final } : {}) });
    let markdown = force ? undefined : cached.find(fragment => fragment.fingerprint === fingerprint)?.markdown;
    if (!markdown) markdown = checkedRecapMarkdown(await complete(system, JSON.stringify({ ...base, stage, questions }), { signal }));
    signal.throwIfAborted();
    chunks.push({ fingerprint, markdown });
    if (stage === 'prepare' && !await saveBatches(chunks)) return null;
    signal.throwIfAborted();
  }
  const polish = markdown => polishRecapMarkdown(markdown, { complete, system, base, signal });
  if (chunks.length === 1) return { markdown: await polish(chunks[0].markdown), chunks };
  if (!await organize()) return null;
  const markdown = await polish(checkedRecapMarkdown(await complete(system,
    JSON.stringify({ ...base, stage: 'consolidate', sections: chunks.map(chunk => chunk.markdown) }), { signal })));
  signal.throwIfAborted();
  return { markdown, chunks };
}

/** The generation ended badly: say so on the note, unless the note no longer belongs to this generation (the plugin may be unloaded; prior writing is safe). */
export function recordGenerationFailure(store, job, error) {
  return store.update(state => {
    const note = activeGeneration(state, job);
    if (!note) return;
    note.generation = { ...note.generation, status: job.signal.aborted ? 'cancelled' : 'failed', message: String(error.message).slice(0, 300) };
    delete note.generation.progress;
  }).catch(() => {});
}

/** Prepare resumable batches, consolidate once, and commit the complete writing atomically.
 * `{ written }` says whether this generation wrote the note; `error` is why not when it failed (already recorded on the note).
 * The letter for the learner is handed to `job.letter` when there is one (a Job sends it when it settles), else written with the note. */
export async function runDailyGeneration({ store, complete, language, job }) {
  const { group, final, force, pending, signal } = job;
  const total = Math.ceil(group.questions.length / RECAP_BATCH_SIZE);
  try {
    const result = await draftDailyRecap({ complete, language, job,
      saveBatches: chunks => updateGeneration(store, job, note => {
        // Preserve the readable article while each completed explanation becomes resumable.
        const fragments = [...(note.daily.fragments || []).filter(fragment => !chunks.some(chunk => chunk.fingerprint === fragment.fingerprint)), ...chunks];
        note.daily.fragments = fragments.slice(-total * 2);
        note.generation.progress = { phase: 'explaining', completed: chunks.length, total };
        job.onProgress?.(note.generation.progress);
      }),
      organize: () => updateGeneration(store, job, note => {
        note.generation.progress = { phase: 'organizing', completed: total, total };
        job.onProgress?.(note.generation.progress);
      }),
    });
    if (!result) return { written: false };
    signal.throwIfAborted();
    const written = await updateGeneration(store, job, (note, state) => {
      pending.next = note.generation.next || pending.next;
      note.markdown = result.markdown;
      note.revision = (note.revision || 0) + 1;
      note.updatedAt = new Date().toISOString();
      const firstContent = !note.daily.fingerprint;
      note.daily = { ...note.daily, fingerprint: group.fingerprint, final, fragments: result.chunks };
      if (force) { note.title = recapTitle(group, language); delete note.daily.manualEditedAt; }
      note.generation = { id: job.id, status: 'done', fingerprint: group.fingerprint, final, finishedAt: note.updatedAt };
      if (firstContent || final) {
        const letter = { kind: 'note', ...note.cards[0], noteId: note.id, detail: `「${note.daily.course}」今日学习总结已${firstContent ? '生成' : '整理'}，可直接阅读` };
        if (job.letter) job.letter(letter); else notify(state, letter);
      }
    });
    return { written };
  } catch (error) {
    await recordGenerationFailure(store, job, error);
    return { written: false, error };
  }
}
