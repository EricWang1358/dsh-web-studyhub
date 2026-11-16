import { getUiLanguage, uiFormat } from '../i18n.js';
import { isoDay } from '../format.js';

/* The note of the question on screen (写笔记, 存进笔记 under a Q&A, #1017): which question it is about and the title a new daily course study note gets.
   One place for the practice page (ui/app/page-views.jsx), the reader's 本节题目 round (ui/app/modals/ReaderRun.jsx), and source quote append. */

/** The question a run shows, as note.create / note.qa.add name it. */
export const questionNoteRef = run => ({ deckId: run.deckId || run.card?.deckId, cardId: run.card?.id });

/** Resolve the course name of a run's current question from snapshot decks (or run metadata). */
export function questionNoteCourse(run, decks) {
  const deckId = run?.deckId || run?.card?.deckId;
  const deck = Array.isArray(decks) ? decks.find(item => item.id === deckId) : null;
  return String(deck?.course ?? deck?.folder ?? run?.card?.course ?? run?.course ?? '').trim();
}

/** The title of today's daily course study note: `YYYY-MM-DD · <course> · 学习笔记` (or `学习笔记 · YYYY-MM-DD` without a course). */
export function questionNoteTitle(course = '') {
  const day = isoDay(new Date());
  const cleanCourse = String(course ?? '').trim();
  return cleanCourse ? uiFormat('{0} · {1} · 学习笔记', [day, cleanCourse]) : uiFormat('学习笔记 · {0}', [day]);
}

/** note.qa.add: one Q&A of the question on screen into today's course study note (made when there is none), in the page's language. */
export const qaToNoteArgs = (run, followupId, decks) => ({
  ...questionNoteRef(run),
  followupId,
  title: questionNoteTitle(questionNoteCourse(run, decks)),
  language: getUiLanguage(),
});

/** Format a document passage as a blockquote with book title and page/slide citation for appending to a question note. */
export function formatQuoteForNote({ quote, title, page, slides = false } = {}) {
  const text = String(quote ?? '').trim();
  if (!text) return '';
  const body = text.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  const book = String(title ?? '').trim();
  const pageNum = Number(page);
  const loc = Number.isInteger(pageNum) && pageNum > 0 ? uiFormat(slides ? '第 {0} 张' : '第 {0} 页', [pageNum]) : '';
  const cite = `${book ? `《${book}》` : ''}${loc}`;
  return cite ? `${body}\n\n——${cite}` : body;
}
