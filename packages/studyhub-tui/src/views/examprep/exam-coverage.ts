/**
 * Exam coverage gaps (missing-question and weak focus topics) and the remediation steps they suggest.
 *
 * This is not a schedule. The when and how-much of the 备考计划 belongs to the backend `course.plan`
 * (see course-plan-display.ts); this only sorts the focus topics by their coverage and takes the days left from a
 * backend answer (`course.plan` or `book.crunch`).
 */
import type { UiLanguage } from '../../types/contracts.js';
import type { FocusTopicProgress } from './types.js';

export interface ExamCoverage {
  daysLeft: number;
  status: 'ok' | 'today' | 'past';
  gapTopics: string[];
  weakTopics: string[];
}

/** Sort the focus topics into missing-question and weak ones; null when the backend gave no days left. */
export function buildExamCoverage(
  topics: readonly Pick<FocusTopicProgress, 'topic' | 'status' | 'cards' | 'weakCards'>[],
  daysLeft: number | null | undefined,
): ExamCoverage | null {
  if (typeof daysLeft !== 'number' || !Number.isFinite(daysLeft)) return null;
  const gapTopics: string[] = [];
  const weakTopics: string[] = [];
  for (const tp of topics) {
    const name = String(tp.topic || '').trim();
    if (!name) continue;
    const weakCount = Array.isArray(tp.weakCards) ? tp.weakCards.length : 0;
    if (tp.status === 'none' || (Number(tp.cards) || 0) === 0) gapTopics.push(name);
    else if (tp.status === 'weak' || weakCount > 0) weakTopics.push(name);
  }
  return { daysLeft, status: daysLeft < 0 ? 'past' : daysLeft === 0 ? 'today' : 'ok', gapTopics, weakTopics };
}

export interface GapFillWorkflowStep {
  index: number;
  kind: 'generate_gap' | 'drill_weak';
  topic: string;
  requiresConfirm: boolean;
  label: string;
}

/**
 * Ordered, P2-guarded remediation steps from the coverage gaps (Round 94 Track D8).
 * Generation steps always require P2 confirmation; practice steps execute directly. Mock exams are the saved plan's
 * (`mockDates`), so none is suggested here.
 */
export function buildGapFillWorkflowSteps(coverage: ExamCoverage | null, lang: UiLanguage): GapFillWorkflowStep[] {
  if (!coverage || coverage.status === 'past') return [];
  const zh = lang !== 'en';
  const steps: GapFillWorkflowStep[] = [];
  for (const topic of coverage.gapTopics.slice(0, 3)) {
    steps.push({
      index: steps.length,
      kind: 'generate_gap',
      topic,
      requiresConfirm: true,
      label: zh ? `补齐缺题：「${topic}」（AI 出题，需确认）` : `Gap-fill "${topic}" (AI generate, confirm)`,
    });
  }
  for (const topic of coverage.weakTopics.slice(0, 2)) {
    steps.push({
      index: steps.length,
      kind: 'drill_weak',
      topic,
      requiresConfirm: false,
      label: zh ? `专项巩固：「${topic}」（错题重练）` : `Drill weak "${topic}" (practice)`,
    });
  }
  return steps;
}
