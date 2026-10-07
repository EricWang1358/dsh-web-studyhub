import { get } from '../../util.js';
import { notify } from '../../inbox.js';
import { blogGenerationSystem, checkedBlogMarkdown } from '../../blog-generation.js';

/* The body of one AI draft of a note (note.generate): ask the model once, check what it wrote, and put it in the note only while the note is still the one the draft was asked for.
   Both ways of carrying it out run this: in process, or as the Job `note-generate` (jobs/note-generate.js). `complete(system, prompt)` is the model; `job.signal` stops it. */

/** The note says why a draft did not come: only while it is still waiting for exactly this draft. */
export const recordNoteFailure = (store, { noteId, jobId }, error) => store.update(current => {
  const latest = get(current.notes, noteId, '笔记');
  if (latest.generation?.id === jobId && latest.generation.status === 'running') latest.generation = { id: jobId, status: 'failed', message: String(error.message).slice(0, 300) };
});

/** Resolves `{ written }` when the draft ended with the note's own record dealt with; `{ written: false, error }` when the model or the check failed (the note says so); a stop leaves the note as its stopper left it. */
export async function runNoteGeneration({ store, complete, job }) {
  const { noteId, jobId, revision, title, cards, signal } = job;
  try {
    const raw = await complete(blogGenerationSystem, JSON.stringify({ articleTitle: title, cards }), { signal });
    signal.throwIfAborted();
    const markdown = checkedBlogMarkdown(raw);
    let written = false;
    await store.update(current => {
      const latest = get(current.notes, noteId, '笔记');
      if (latest.status !== 'draft' || latest.generation?.id !== jobId || (latest.revision || 0) !== revision) return;
      latest.markdown = markdown;
      latest.revision = revision + 1;
      latest.updatedAt = new Date().toISOString();
      latest.generation = { id: jobId, status: 'done', finishedAt: latest.updatedAt };
      notify(current, { kind: 'note', ...latest.cards[0], noteId, detail: `笔记草稿「${title}」已生成，请审阅后发布` });
      written = true;
    });
    return { written };
  } catch (error) {
    if (signal.aborted) return { written: false, stopped: true };
    await recordNoteFailure(store, job, error);
    return { written: false, error };
  }
}
