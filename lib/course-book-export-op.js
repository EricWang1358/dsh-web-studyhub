/* course.book.export (复习全书 M6, docs/plans/review-book.md): the book of a course as the learner's printable CP. Read only: the book as
   course.book.open would give it (nothing is written, not even when opening would create the files), with ALL of every point's questions, resolved
   against the live cards; the Markdown is lib/course-book-export.js.

   course.book.export { course?, form?: 'single' | 'folder', answerKey?: boolean, questions?: 'linked' | 'all' | 'none', estimateOnly?: boolean }
     -> { status: 'ok', course, form, title, language, filename, text? | files + manifest, questionMode, questions, estimate } | { status: 'empty', course, reason }
     questions: which are printed (default 'linked': only those the book's text links). estimateOnly: only { status, course, estimate } (the page's
     quiet line about the page limit). */
import { openCourseBook } from './course-book-files.js';
import { bookCardsOf } from './course-book-cards.js';
import { EXPORT_FORMS, QUESTION_MODES, exportBook } from './course-book-export.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'course-book-export-args' }); };

export function courseBookExport(state, args = {}) {
  const form = args.form ?? 'single', questions = args.questions ?? 'linked';
  if (!EXPORT_FORMS.includes(form)) fail(`course.book.export: form must be ${EXPORT_FORMS.join(' or ')}`);
  if (!QUESTION_MODES.includes(questions)) fail(`course.book.export: questions must be ${QUESTION_MODES.join(', ')}`);
  if (args.answerKey !== undefined && typeof args.answerKey !== 'boolean') fail('course.book.export: answerKey must be true or false');
  const book = openCourseBook(state, args, { write: false, applyRebuild: true, questions: questions === 'all' ? Number.POSITIVE_INFINITY : 0 });
  if (book.status !== 'ok') return { status: 'empty', course: book.course, reason: book.reason };
  const { cardOf } = bookCardsOf(state, { course: book.course, fileNames: () => [] });
  const done = exportBook(book, { cardOf, form, questions, answerKey: args.answerKey === true });
  if (args.estimateOnly === true) return { status: 'ok', course: book.course, estimate: done.estimate };
  return { status: 'ok', course: book.course, ...done };
}
