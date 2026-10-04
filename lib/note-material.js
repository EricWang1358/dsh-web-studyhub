import { createHash } from 'node:crypto';

/** One content identity for both the reader and agent callers; revisions do not duplicate a saved copy. */
export function noteMaterial(note) {
  const text = String(note.markdown || '').trim(), title = String(note.title || '').trim();
  if (!text || !title) throw new Error('请先生成或填写正文。');
  const fingerprint = createHash('sha256').update(JSON.stringify([note.id, title, text])).digest('hex');
  return { id: `note-material-${fingerprint}`, title, text, format: 'md',
    courses: note.daily?.course ? [note.daily.course] : note.courses || [] };
}
