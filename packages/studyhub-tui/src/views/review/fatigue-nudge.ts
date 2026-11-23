/**
 * Proactive Study Fatigue / Pacing Rest Nudge (Round 95 Track D9).
 *
 * Detects sustained intensive practice (>= 25 answered cards in one round) and offers a calm,
 * non-interrupting inline rest suggestion for memory consolidation.
 * Strictly enforces all 3 proactive guardrails:
 *   1. Disable toggle (`proactiveHints !== false`)
 *   2. Rate limit (fires at most ONCE per round; never repeats once shown/dismissed)
 *   3. Non-interrupting (never fires while typing or inside modals; zero idle polling)
 */
import type { UiLanguage } from '../../types/contracts.js';

export const FATIGUE_NUDGE_THRESHOLD = 25;

export interface FatigueNudgeInput {
  enabled: boolean;
  isActive: boolean;
  isEditing: boolean;
  anyModalOpen: boolean;
  answeredInRound: number;
  alreadyShownInRound: boolean;
  threshold?: number;
}

export function shouldShowFatigueNudge(opts: FatigueNudgeInput): boolean {
  if (!opts.enabled || !opts.isActive || opts.isEditing || opts.anyModalOpen) return false;
  if (opts.alreadyShownInRound) return false;
  const threshold = opts.threshold ?? FATIGUE_NUDGE_THRESHOLD;
  return opts.answeredInRound >= threshold;
}

export function buildFatigueNudgeBanner(
  answeredInRound: number,
  lang: UiLanguage,
  asciiMode: boolean,
): string {
  const icon = asciiMode ? '*' : '✦';
  return lang === 'en'
    ? `${icon} ${answeredInRound} cards done this round — consider a 3-min break to lock in memory`
    : `${icon} 本轮已连续作答 ${answeredInRound} 题，建议小休 3 分钟巩固记忆（不打断继续刷题）`;
}
