import { getUiLanguage, uiFormat } from '../i18n.js';
import { formatDateTime } from '../format.js';

/* The note of the question on screen (写笔记, 存进笔记 under a Q&A, #1017): which question it is about and the title a new one gets. One place for the
   practice page (ui/app/page-views.jsx) and the reader's 本节题目 round (ui/app/modals/ReaderRun.jsx). */

/** The question a run shows, as note.create / note.qa.add name it. */
export const questionNoteRef = run => ({ deckId: run.deckId || run.card?.deckId, cardId: run.card?.id });

/** The title of a note made from a question today: 学习笔记 · <date>. */
export const questionNoteTitle = () => uiFormat('学习笔记 · {0}', [formatDateTime(Date.now(), 'date')]);

/** note.qa.add: one Q&A of the question on screen into its note (made when there is none), in the page's language. */
export const qaToNoteArgs = (run, followupId) => ({ ...questionNoteRef(run), followupId, title: questionNoteTitle(), language: getUiLanguage() });
