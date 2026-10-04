import { LARGE_DOCUMENT_LIMITS } from './large-documents.js';

/* Limits the panel shows and the host enforces. One definition each: an input's max, its hint and the validation all
   read these. Pure data (no Node imports). */

/** How many questions one practice step, exam or course batch holds. */
export const QUESTION_COUNT = Object.freeze({ min: 1, max: 50 });
export const isQuestionCount = (value) => Number.isInteger(value) && value >= QUESTION_COUNT.min && value <= QUESTION_COUNT.max;

/** The most text one generation request may carry from the selected sources (characters). */
export const SELECTION_CHARS = LARGE_DOCUMENT_LIMITS.selectionChars;
