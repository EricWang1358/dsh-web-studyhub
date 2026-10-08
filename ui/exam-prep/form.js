import { displayTitle } from '../../lib/document-title.js';
import { suggestRoles } from '../../lib/exam-prep-roles.js';
import { resolveExamPrepSettings } from '../../lib/exam-prep-settings.js';
import { courseForSources, sourceMatchesCourse } from '../../lib/source-courses.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { isoDay } from '../format.js';
import { defaultTitleWords } from './form-words.js';
import { ROLES } from './model.js';

/* 备考补习, the create form's state as plain data (no React): the documents it offers, the role of each, and the opening state that
   fills the form in before the learner has done anything. A role is not stored per document: the form keeps the source ids picked for
   each role (`picks`, as the request needs them), and a document's role is the role its ids are picked for. */

const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const nameOf = course => typeof course === 'string' ? course : course?.name;

export const emptyPicks = () => Object.fromEntries(ROLES.map(role => [role, []]));

/** The documents of the library (a 考点清单 is not one; archived ones are kept here so a rebuild still finds what it was made from, and `poolOf` hides them). */
export const documentsOf = sources => groupSourcesByDocument(sources);

/** The role a document has in `picks`: 'lecture' | 'past-paper' | 'syllabus', or 'none'. */
export const roleOf = (item, picks) => ROLES.find(role => item.sourceIds.some(id => picks?.[role]?.includes(id))) || 'none';

/** How many documents have each role. */
export function roleCounts(items, picks) {
  const counts = Object.fromEntries(ROLES.map(role => [role, 0]));
  for (const item of items) { const role = roleOf(item, picks); if (role !== 'none') counts[role] += 1; }
  return counts;
}

/** `picks` with the document in `role` ('none' takes it out of every role). `ids` are the pages of it to use (all of them by default). */
export function assignRole(picks, item, role, ids = item.sourceIds) {
  const mine = new Set(item.sourceIds);
  const next = Object.fromEntries(ROLES.map(other => [other, (picks?.[other] || []).filter(id => !mine.has(id))]));
  if (ROLES.includes(role)) next[role].push(...ids.filter(id => mine.has(id)));
  return next;
}

/** `picks` with these source ids in `role` (what an import hands back: ids, not documents). */
export function assignIds(picks, ids, role) {
  const moved = [...new Set(ids)], gone = new Set(moved);
  const next = Object.fromEntries(ROLES.map(other => [other, (picks?.[other] || []).filter(id => !gone.has(id))]));
  if (ROLES.includes(role)) next[role].push(...moved);
  return next;
}

/** Is the document the course's own (the course's or nobody's)? With no course everything is. */
const ownTo = (course, known) => item => !course || !item.courses.length || sourceMatchesCourse({ courses: item.courses }, course, known);

/** The documents offered: the course's and the unfiled ones, every course's on request, and whatever is picked whatever its course; archived ones only when picked. */
export function poolOf(items, { course = '', others = false, picked = new Set(), known = [] } = {}) {
  const own = ownTo(course, known);
  const chosen = item => item.sourceIds.some(id => picked.has(id));
  return items.filter(item => (!item.archived || chosen(item)) && (others || own(item) || chosen(item)));
}

/** The course's guidance materials (the ones it marks as its exam syllabus), from the snapshot's course records. */
export const guidanceOf = (data, course) => (course && (data?.courses || []).find(record => record?.name === course)?.guidanceSourceIds) || [];

/** The suggestion for each document (by its key): lib/exam-prep-roles.js, except that another course's material is never suggested. */
export function suggestionsOf(items, { course = '', known = [], guidance = [], paperWords = [], autoRoles = true } = {}) {
  const own = ownTo(course, known);
  const list = suggestRoles(items, { guidanceSourceIds: guidance, paperWords, autoRoles });
  return new Map(items.map((item, at) => [item.key, own(item) ? list[at] : { id: item.key, role: 'none', reason: { code: 'other-course' } }]));
}

/** The learner's defaults for the form (Settings > 备考补习), whole whether or not anything was saved. */
export const settingsOf = data => resolveExamPrepSettings(data?.settings?.examPrep);

const blankReading = () => ({ title: '', author: '', url: '', note: '' });

/** The picks that follow from the suggestions for `course`: every document of the course (and the unfiled ones) in the role suggested for it. */
export function picksFor(data, course, known = []) {
  const settings = settingsOf(data);
  const items = documentsOf(data?.sources).filter(item => !item.archived);
  const suggestions = suggestionsOf(items, { course, known, guidance: guidanceOf(data, course), paperWords: settings.paperWords, autoRoles: settings.autoRoles });
  const picks = emptyPicks();
  for (const item of items) { const role = suggestions.get(item.key).role; if (role !== 'none') picks[role].push(...item.sourceIds); }
  return picks;
}

/**
 * The form as it opens: the course of the page (else the common course of the slides, else the library's only course), the documents of
 * that course with the roles suggested for them, the learner's defaults. `askCourse` says the course could not be told and the form asks once.
 */
export function openingForm(data, { scope = '*', known = [] } = {}) {
  const settings = settingsOf(data);
  const named = (data?.focus?.courses || []).map(nameOf).filter(name => typeof name === 'string' && name);
  const focus = data?.focus?.course;
  let course = scope && scope !== '*' ? scope : focus && focus !== '*' ? focus : '';
  let picks = picksFor(data, course, known);
  if (!course) {
    // No course yet: the suggestions cover every material; the course is the one the slides share (else the only one the library has).
    const items = documentsOf(data?.sources);
    course = courseForSources(data, items.filter(item => roleOf(item, picks) === 'lecture').flatMap(item => item.sourceIds), '', known) || (named.length === 1 ? named[0] : '');
    if (course) picks = picksFor(data, course, known);
  }
  return { title: '', scope: '', course, supersedes: undefined, picks, reading: blankReading(), language: settings.language, others: settings.showOtherCourses,
    askCourse: !course && named.length > 0 };
}

/** The form of a rebuild (model.js formFromList) with the learner's defaults for what a list does not remember. */
export function rebuildForm(base, data) {
  const settings = settingsOf(data);
  return { ...base, language: settings.language, others: settings.showOtherCourses, askCourse: false };
}

/** Does the form carry values of the 更多设置 fold (a name, a scope, a textbook note)? Then the fold opens at once. */
export const hasMoreValues = form => !!(clean(form.title) || clean(form.scope) || Object.values(form.reading || {}).some(clean));

/** The name when the learner types none: the course name (else the first slides) plus 考点清单, with the date when the course has a list of that name. */
export function defaultTitle(form, items, data, now = new Date()) {
  const first = items.find(item => roleOf(item, form.picks) === 'lecture') || items.find(item => roleOf(item, form.picks) === 'syllabus');
  const name = clean(form.course) || (first ? clean(displayTitle(first.title)) : '');
  const base = defaultTitleWords(name);
  const course = clean(form.course);
  const taken = (data?.examPointLists || []).some(list => list && list.archived !== true && list.title === base &&
    (course ? (list.courses || []).includes(course) : !(list.courses || []).length));
  return taken ? defaultTitleWords(name, isoDay(now)) : base;
}

/** The language the request asks for: the form's own choice, else (auto) the interface language. */
export const languageOf = (form, interfaceLanguage) => ['zh', 'en'].includes(form.language) ? form.language : interfaceLanguage;
