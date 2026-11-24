/**
 * Proactive Exam Gap Alert (Round 92 Track D7).
 *
 * Surfaces a calm inline warning inside ExamPrepView when the exam is <= 14 days away and
 * uncovered (`none`) or weak topics remain. Enforces all 3 proactive guardrails:
 *   1. Disable toggle (`proactiveHints !== false`)
 *   2. Rate limit (at most 1 inline alert per session; dismissible via `[Z]`)
 *   3. Non-interrupting (never opens a modal, never steals focus, zero idle polling)
 */
import type { UiLanguage } from '../../types/contracts.js';
import type { ExamCoverage } from './exam-coverage.js';

export const EXAM_GAP_ALERT_WINDOW_DAYS = 14;

export interface ExamGapAlertInput {
  plan: ExamCoverage | null;
  proactiveHints?: boolean;
  dismissed?: boolean;
  lang: UiLanguage;
  asciiMode: boolean;
}

export interface ExamGapAlert {
  urgent: boolean;
  gapCount: number;
  weakCount: number;
  message: string;
}

export function buildExamGapAlert(opts: ExamGapAlertInput): ExamGapAlert | null {
  if (opts.proactiveHints === false || opts.dismissed) return null;
  const plan = opts.plan;
  if (!plan || plan.status === 'past') return null;
  if (plan.daysLeft < 0 || plan.daysLeft > EXAM_GAP_ALERT_WINDOW_DAYS) return null;

  const gapCount = plan.gapTopics.length;
  const weakCount = plan.weakTopics.length;
  if (gapCount === 0 && weakCount < 2) return null;

  const urgent = plan.daysLeft <= 7;
  const icon = opts.asciiMode ? '!' : '⚠';
  const zh = opts.lang !== 'en';
  const partsZh: string[] = [];
  if (gapCount > 0) partsZh.push(`缺题 ${gapCount} 项（按 [g] 自动补齐）`);
  if (weakCount > 0) partsZh.push(`薄弱 ${weakCount} 项（按 [p] 专项巩固）`);
  const partsEn: string[] = [];
  if (gapCount > 0) partsEn.push(`${gapCount} uncovered ([g] gap-fill)`);
  if (weakCount > 0) partsEn.push(`${weakCount} weak ([p] drill)`);

  return {
    urgent,
    gapCount,
    weakCount,
    message: zh
      ? `${icon} 考期预警（剩 ${plan.daysLeft} 天）：${partsZh.join('，')}  [Z]忽略`
      : `${icon} Exam Alert (${plan.daysLeft}d left): ${partsEn.join(', ')}  [Z]Hide`,
  };
}
