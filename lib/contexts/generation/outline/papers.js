import { suggestRoles } from '../../../exam-prep-roles.js';

/* Which materials of a course are its sample papers, decided without the learner opening anything: the ones the exam point list's own rule recognises
   (lib/exam-prep-roles.js: a short document whose name says sample paper / past paper / sample paper / past paper / exam paper ...) are used BY DEFAULT. The learner's own
   choice wins and is remembered on the outline (`papersBy: 'learner'`, also an empty one: "no paper"); a later build then keeps it until the learner changes it. */

export const MAX_PAPERS = 20;

/** The documents the rule takes for sample papers, in the course's order (at most MAX_PAPERS). */
export const detectedPapers = documents => suggestRoles(documents).map((suggestion, at) => (suggestion.role === 'past-paper' ? documents[at].key : null)).filter(Boolean)
  .slice(0, MAX_PAPERS);

/**
 * The papers a build uses: `asked` (an explicit list) is the learner's; else the outline's own when the learner chose them; else the detected ones (those still in
 * the course). -> { keys, by: 'learner' | 'auto' }
 */
export function choosePapers(documents, { asked = null, outline = null } = {}) {
  if (Array.isArray(asked)) return { keys: [...new Set(asked)], by: 'learner' };
  const known = new Set(documents.map(item => item.key));
  if (outline?.papersBy === 'learner') return { keys: (outline.papers || []).map(paper => paper.key).filter(key => known.has(key)), by: 'learner' };
  return { keys: detectedPapers(documents), by: 'auto' };
}
