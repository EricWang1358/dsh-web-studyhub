import { ui, uiFormat } from './i18n.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { sourceMatchesCourse } from '../lib/source-courses.js';
import { LARGE_DOCUMENT_LIMITS, bigDocuments } from '../lib/large-documents.js';

/* 创建题组, the form as it opens (the way ui/exam-prep/form.js opens 备考补习): the documents of the current course that have no question yet are ticked, so the
   main path is one press of 生成. Pure, no React. The guess is conservative on purpose: it ticks only what it can say a reason for ("还没出过题"), leaves a whole book
   for the chapter picker and anything too long for one request, never guesses a course when the library has several and none is current, and ticks nothing when
   every document already has questions. A wrong tick is one click to undo (the picker's own checkbox or 清空选择); a wrong claim would not be. */

const nameOf = course => (typeof course === 'string' ? course : course?.name);

/** Does the document already have questions (published or in a draft)? Any deck or draft that cites it counts, an archived deck too: it was asked once, so "还没出过题" would be false. */
export function hasQuestions(item, materialCoverage) {
  return !!materialCoverage?.[item.key] || (item.usedBy || []).length > 0;
}

/**
 * Which documents the form opens with ticked, and why: `{ sourceIds, reason }`. `scope` is the page's course scope ('*' all courses, '' the unassigned ones, else a course
 * name; a parent takes in its chapters), `known` the library's course names, `exclude` source ids that are not evidence (the reference questions).
 * `reason` is null when nothing is ticked, else `{ code: 'single' | 'unused', course, count, used, big }`: how many documents were ticked, and how many of the course's were left
 * out because they already have questions (`used`) or are too long to tick blindly (`big`: a book, or what would not fit in the one request after the others).
 */
export function openingSelection(data, { scope = '*', known = [], exclude = [] } = {}) {
  const skip = new Set(exclude);
  const items = groupSourcesByDocument((data?.sources || []).filter(source => !skip.has(source.id))).filter(item => !item.archived);
  const named = (data?.focus?.courses || []).map(nameOf).filter(name => typeof name === 'string' && name);
  let course = typeof scope === 'string' ? scope : '*';
  if (course === '*') {
    // No course is current: a library of one document has nothing to choose, the library's only course is the course, a library without courses is one pile, and several courses are not guessed.
    if (items.length === 1) return { sourceIds: [...items[0].sourceIds], reason: { code: 'single', course: '', count: 1, used: 0, big: 0 } };
    if (named.length > 1) return { sourceIds: [], reason: null };
    course = named.length === 1 ? named[0] : '*';
  }
  const inCourse = items.filter(item => sourceMatchesCourse({ courses: item.courses }, course, known));
  const label = course === '*' ? '' : course;
  if (inCourse.length === 1) return { sourceIds: [...inCourse[0].sourceIds], reason: { code: 'single', course: label, count: 1, used: 0, big: 0 } };
  const fresh = inCourse.filter(item => !hasQuestions(item, data?.materialCoverage));
  const books = new Set(bigDocuments(fresh).map(item => item.key));
  const chosen = [];
  let chars = 0, big = 0;
  for (const item of fresh) {
    if (books.has(item.key) || chars + item.chars > LARGE_DOCUMENT_LIMITS.selectionChars) { big += 1; continue; }
    chosen.push(item);
    chars += item.chars;
  }
  if (!chosen.length) return { sourceIds: [], reason: null };
  return { sourceIds: chosen.flatMap(item => item.sourceIds), reason: { code: 'unused', course: label, count: chosen.length, used: inCourse.length - fresh.length, big } };
}

/** The one sentence under 「01 / 选择资料」 that says why these are ticked, and what was left out. */
export function openingLine(reason) {
  if (!reason) return '';
  if (reason.code === 'single') return ui('这里只有这一份资料，已替你选中。');
  const { course, count, used, big } = reason;
  const head = course
    ? count === 1 ? uiFormat('已选中「{0}」里还没出过题的 1 份资料。', [course]) : uiFormat('已选中「{0}」里还没出过题的 {1} 份资料。', [course, count])
    : count === 1 ? ui('已选中还没出过题的 1 份资料。') : uiFormat('已选中还没出过题的 {0} 份资料。', [count]);
  const left = [used > 0 && uiFormat('已出过题的 {0} 份', [used]), big > 0 && uiFormat('太长的 {0} 份', [big])].filter(Boolean);
  return [head, left.length ? uiFormat('没选：{0}。', [left.join(ui('、'))]) : '', big > 0 ? ui('整本教材请在列表里按章节选。') : ''].filter(Boolean).join(' ');
}

/** Does the opening still describe the selection on the page? The line is shown only then: once the learner changes the ticks it would be about something else. */
export function openingStands(opening, selectedIds = []) {
  const ids = opening?.sourceIds;
  if (!Array.isArray(ids) || !ids.length || ids.length !== selectedIds.length) return false;
  const now = new Set(selectedIds);
  return ids.every(id => now.has(id));
}
