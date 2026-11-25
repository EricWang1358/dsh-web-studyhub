import type { UiLanguage } from './types/contracts.js';

/**
 * The one place the 0–5 grade scale is described for learners (#1459).
 *
 * These words are display-only. The pass line is still `grade >= 3`, decided in the backend
 * (`lib/contexts/study/grading-ops.js`, `lib/insights.js`): 0, 1 and 2 count as not passed, 3, 4 and 5
 * as passed. Nothing here reschedules a review, rewrites a stored grade or moves a statistic, so an
 * existing library keeps the verdicts and numbers it already had.
 *
 * Shared by the assistant's grade-adjust confirm/preview, the review page's grade panel, the wrong
 * book and the exam coach — the same sentence in every surface, never hard-coded per view.
 */

export type GradeValue = 0 | 1 | 2 | 3 | 4 | 5;

/** The backend's unchanged pass line: this grade and above count as correct. */
export const GRADE_PASS_LINE = 3;

export interface GradeSemantics {
  grade: GradeValue;
  /** What the grade means, as the learner reads it. */
  labelZh: string;
  labelEn: string;
  /** A compact form for a narrow row or badge. */
  shortZh: string;
  shortEn: string;
  /** `grade >= 3` — the backend's line, repeated here so the words and the verdict agree. */
  countsCorrect: boolean;
}

export const GRADE_SEMANTICS: readonly GradeSemantics[] = Object.freeze([
  {
    grade: 0,
    labelZh: '没有作答 / 完全不对',
    labelEn: 'No answer / completely wrong',
    shortZh: '未作答/完全不会',
    shortEn: 'No answer',
    countsCorrect: false,
  },
  {
    grade: 1,
    labelZh: '答对一小部分（关键点缺失）',
    labelEn: 'A small part right (key points missing)',
    shortZh: '部分对',
    shortEn: 'Partly',
    countsCorrect: false,
  },
  {
    grade: 2,
    labelZh: '接近正确（缺一个关键点）',
    labelEn: 'Close (one key point missing)',
    shortZh: '接近正确',
    shortEn: 'Close',
    countsCorrect: false,
  },
  {
    grade: 3,
    labelZh: '正确（及格）',
    labelEn: 'Correct (pass)',
    shortZh: '正确',
    shortEn: 'Correct',
    countsCorrect: true,
  },
  {
    grade: 4,
    labelZh: '良好',
    labelEn: 'Good',
    shortZh: '良好',
    shortEn: 'Good',
    countsCorrect: true,
  },
  {
    grade: 5,
    labelZh: '完整',
    labelEn: 'Complete',
    shortZh: '完整',
    shortEn: 'Complete',
    countsCorrect: true,
  },
]);

const BY_GRADE = new Map<number, GradeSemantics>(GRADE_SEMANTICS.map((item) => [item.grade, item]));

/** The semantics of a stored grade, or `undefined` for a missing/out-of-range value (old or odd data reads as unknown, never throws). */
export function gradeSemantics(grade: number | null | undefined): GradeSemantics | undefined {
  return typeof grade === 'number' && Number.isInteger(grade) ? BY_GRADE.get(grade) : undefined;
}

/** The full meaning ("接近正确（缺一个关键点）"), empty when the grade is unknown. */
export function gradeLabel(grade: number | null | undefined, lang: UiLanguage): string {
  const semantics = gradeSemantics(grade);
  if (!semantics) return '';
  return lang === 'en' ? semantics.labelEn : semantics.labelZh;
}

/** The compact meaning ("部分对"), empty when the grade is unknown. */
export function gradeShortLabel(grade: number | null | undefined, lang: UiLanguage): string {
  const semantics = gradeSemantics(grade);
  if (!semantics) return '';
  return lang === 'en' ? semantics.shortEn : semantics.shortZh;
}

/** The backend's verdict as learner-facing words: passed at 3 and above. */
export function gradeVerdictLabel(grade: number | null | undefined, lang: UiLanguage): string {
  return countsAsCorrect(grade)
    ? lang === 'en' ? 'counts as correct' : '判定为掌握'
    : lang === 'en' ? 'still not mastered' : '仍算未掌握';
}

/** `grade >= 3`, matching `lib/contexts/study/grading-ops.js`; a missing or unknown grade is not a pass. */
export function countsAsCorrect(grade: number | null | undefined): boolean {
  return gradeSemantics(grade)?.countsCorrect === true;
}
