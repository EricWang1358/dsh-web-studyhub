import { ui, uiFormat } from './i18n.js';

/* A finished import's second step, as one more action of its own card: make questions from the materials it saved. The same words as the toast of a
   finished document import (用它出题), for a PDF conversion and a transcription that ran in the background. It is a link of the compact job card
   (ui/tasks/CompactJobCard.jsx `links`, drawn as the card's one kind of quiet button), so it sits inside the row it belongs to. It exists only once the
   job is complete, saved something, and the page can make questions (onGenerate(sourceIds)); otherwise null. */
export function followUpLink(job, sourceIds, onGenerate) {
  if (job?.status !== 'complete' || !(sourceIds?.length > 0) || typeof onGenerate !== 'function') return null;
  return { label: ui('用它出题'), aria: uiFormat('用它出题：{0}', [job.filename || job.title || '']), run: () => onGenerate(sourceIds) };
}
