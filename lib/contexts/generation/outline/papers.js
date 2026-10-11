import { silentPaper, suggestRoles } from '../../../exam-prep-roles.js';

/* Which materials of a course are its sample papers, decided without the learner opening anything: a short document the exam point list's rule takes for a
   paper (lib/exam-prep-roles.js) AND whose name carries a paper-like marker (exam-prep-roles silentPaper) is used BY DEFAULT. A bare word for the final or
   the midterm is not enough to use a material silently (a final review handout or a Midterm Review Lecture is teaching). The learner's own choice wins and is remembered on the outline
   (`papersBy: 'learner'`, also an empty one: "no paper"); an outline of 3.4, which has papers but no `papersBy`, was the learner's choice too. */

export const MAX_PAPERS = 20;
/** The documents used as sample papers without asking, in the course's order (at most MAX_PAPERS). */
export const detectedPapers = documents => suggestRoles(documents).map((suggestion, at) => (suggestion.role === 'past-paper' && silentPaper(documents[at]) ? documents[at].key : null))
  .filter(Boolean).slice(0, MAX_PAPERS);

/** Did the learner choose the outline's papers? Said so (`papersBy: 'learner'`), or an outline of 3.4 that rests on papers (only the learner could pick them). */
const learnerChose = outline => outline?.papersBy === 'learner' || (!!outline && !outline.papersBy && !!outline.papers?.length);

/**
 * The papers a build uses: `asked` (an explicit list) is the learner's; else the outline's own when the learner chose them; else the detected ones.
 * -> { keys, by: 'learner' | 'auto' }
 */
export function choosePapers(documents, { asked = null, outline = null } = {}) {
  if (Array.isArray(asked)) return { keys: [...new Set(asked)], by: 'learner' };
  const known = new Set(documents.map(item => item.key));
  if (learnerChose(outline)) return { keys: (outline.papers || []).map(paper => paper.key).filter(key => known.has(key)), by: 'learner' };
  return { keys: detectedPapers(documents), by: 'auto' };
}
