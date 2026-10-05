import { LARGE_DOCUMENT_LIMITS } from './large-documents.js';

/* Limits the panel shows and the host enforces. One definition each: an input's max, its hint and the validation all
   read these. Pure data (no Node imports). */

/** How many questions one practice step, exam or course batch holds. */
export const QUESTION_COUNT = Object.freeze({ min: 1, max: 50 });
export const isQuestionCount = (value) => Number.isInteger(value) && value >= QUESTION_COUNT.min && value <= QUESTION_COUNT.max;

/** The most text one generation request may carry from the selected sources (characters), and the sanity bound of a request that has a coverage plan (lib/large-documents.js says why they differ). */
export const SELECTION_CHARS = LARGE_DOCUMENT_LIMITS.selectionChars;
export const COVERAGE_SELECTION_CHARS = LARGE_DOCUMENT_LIMITS.coverageSelectionChars;

/** The most questions one coverage run is planned for (a custom total, the plan's own goal): the sanity bound; one ROUND of it is lib/coverage-round.js ROUND_LIMIT (30). */
export const GOAL_QUESTIONS_MAX = 500;

/** The most text one model call is given (a group of pages, the sections of one planning call), and the most knowledge points one planning call is asked for. lib/batch.js and lib/assigned-plan.js read these. */
export const CALL_CHARS = 60000;
export const CALL_TARGETS = 10;
