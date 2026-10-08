import { courseKey } from '../lib/courses.js';

/* Which course a new material is filed under, and why. The learner's own choice always wins; the current course is the default; only when
   both are empty may a file's name fill the course in, and only when it names exactly one course (a name or an alias, as a whole word). A guess
   that could be wrong is said where the learner sees it (the toast), never used when two courses fit. */

const SEPARATORS = /[\s_\-–—./\\,;:()（）【】[\]{}《》·+]+/;
const LATIN_MIN = 3, CJK_MIN = 2;
const CJK = /[㐀-鿿]/;

const stemOf = name => String(name ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
const tokensOf = text => courseKey(text).toLowerCase().split(SEPARATORS).filter(Boolean);

function holds(tokens, stem, term) {
  if (!term.length) return false;
  for (let at = 0; at + term.length <= tokens.length; at++) if (term.every((token, offset) => tokens[at + offset] === token)) return true;
  return CJK.test(stem) && CJK.test(term.join('')) && term.join('').length >= CJK_MIN && stem.replace(SEPARATORS, '').includes(term.join(''));
}

/** Can this name be told apart in a file name? Too short a name (one letter, "OS" inside other words) would match anything. */
const usable = term => {
  const text = term.join('');
  return CJK.test(text) ? text.length >= CJK_MIN : text.length >= LATIN_MIN;
};

/**
 * The one course a file name names: { course, term } when exactly one course's name or alias is in the name as a whole word
 * ("CS2105 week 3.pdf" names CS2105), else null (no course, or two of them). `courses` are the snapshot's course records ({ name, aliases }) or names.
 */
export function courseNamedBy(fileName, courses = []) {
  const stem = courseKey(stemOf(fileName)).toLowerCase();
  if (!stem) return null;
  const tokens = tokensOf(stem), hits = [];
  for (const course of courses) {
    const name = typeof course === 'string' ? course : course?.name;
    if (typeof name !== 'string' || !courseKey(name)) continue;
    const found = [name, ...(typeof course === 'object' ? course.aliases || [] : [])].map(term => ({ term, parts: tokensOf(term) }))
      .find(({ parts }) => usable(parts) && holds(tokens, stem, parts));
    if (found) hits.push({ course: name, term: found.term });
  }
  const names = new Set(hits.map(hit => hit.course));
  return names.size === 1 ? hits[0] : null;
}

/**
 * The courses a file is imported under and the reason: { courses, how } where how is 'chosen' (the field holds a course: the learner's
 * choice or the current course), 'file-name' (the field is empty and the name of the file names one course) or 'none'.
 */
export function coursesForFile(file, { chosen = [], known = [] } = {}) {
  if (chosen.length) return { courses: chosen, how: 'chosen' };
  const named = courseNamedBy(file?.name, known);
  return named ? { courses: [named.course], how: 'file-name', term: named.term } : { courses: [], how: 'none' };
}
