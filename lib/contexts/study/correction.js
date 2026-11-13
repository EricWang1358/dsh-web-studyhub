/* The correction that comes with an AI grade (#1031), kept apart from the grade: how the learner's own words become a complete, professional answer.
   It never changes the marks; `fragmentsOnly` (disconnected keywords) only ever lowers the grade (lib/rubric-grading.js caps it at 2). One reader for
   every grader that returns it: practice grading (lib/assist-content.js) and the oral mock interview (lib/oral-exam.js). */

const line = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What the grade prompt adds to the examiner's rules (lib/assist-content.js assistInstruction). */
export const GRADE_EXTRAS = Object.freeze([
  'deriveCriteria: a question with deriveCriteria true has no criteria yet. First write 2 to 4 marking criteria from its referenceAnswer only (never from the learner\'s answer), as that question\'s "rubric": [{"id":"c1","label":"short name","marks":2,"keyPoints":["what earns these marks"]}] (marks 1 to 5 each), then score the answer against exactly those criteria under "criteria" with the same ids. They are reused for every later attempt at this question.',
  'fragmentsOnly: true on a question whose answer is only disconnected keywords or a list of terms, without the mechanism or reasoning that connects them.',
  'correction (it never changes the marks): on each answered question, {"keywordExpansion":"how the learner\'s own keywords become one connected explanation","phrasingUpgrade":{"informal":"a phrase the learner used","professional":"how an examiner would want it said"},"missingLinks":["a step or condition the answer left out"]}; leave out a part that does not apply.',
]);

/** The correction of one graded answer, strictly read; null when the grader gave none. `answer` fills in the learner's phrase when the grader quoted none. */
export function gradingCorrection(raw, answer = '') {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.correction && typeof raw.correction === 'object' && !Array.isArray(raw.correction) ? raw.correction : {};
  const keywordExpansion = line(source.keywordExpansion, 1200);
  const upgrade = source.phrasingUpgrade && typeof source.phrasingUpgrade === 'object' ? source.phrasingUpgrade : {};
  const professional = line(upgrade.professional, 900);
  const informal = professional ? line(upgrade.informal, 400) || line(answer, 300) : '';
  const missingLinks = Array.isArray(source.missingLinks) ? source.missingLinks.map((item) => line(item, 240)).filter(Boolean).slice(0, 6) : [];
  const fragmentsOnly = raw.fragmentsOnly === true || source.fragmentsOnly === true;
  if (!keywordExpansion && !professional && !missingLinks.length && !fragmentsOnly) return null;
  return {
    ...(keywordExpansion ? { keywordExpansion } : {}),
    ...(professional ? { phrasingUpgrade: { ...(informal ? { informal } : {}), professional } } : {}),
    ...(missingLinks.length ? { missingLinks } : {}),
    ...(fragmentsOnly ? { fragmentsOnly: true } : {}),
  };
}

/** A grade under the fragments rule: disconnected keywords stay at 2 or below. */
export const cappedGrade = (grade, correction) => (correction?.fragmentsOnly ? Math.min(2, grade) : grade);
