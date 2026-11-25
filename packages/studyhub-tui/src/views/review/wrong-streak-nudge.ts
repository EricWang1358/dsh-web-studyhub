/**
 * Proactive 3-Wrong Consecutive Streak Attribution Nudge (Round 86 Track D3).
 *
 * Detects 3 consecutive incorrect/low-grade (< 3) answers in a review session and offers a
 * calm, non-interrupting inline root-cause attribution prompt. Enforces all 3 guardrails:
 *   1. Disable toggle (`proactiveHints !== false`)
 *   2. Rate limit (triggers on streak >= 3, max 2 per round, 90s cooldown, reset on correct)
 *   3. Non-interrupting (never fires during typing or modals; zero idle polling)
 */
import type { UiLanguage } from '../../types/contracts.js';

export const WRONG_STREAK_THRESHOLD = 3;
export const WRONG_STREAK_MAX_PER_ROUND = 2;
export const WRONG_STREAK_COOLDOWN_MS = 90_000;

export interface WrongStreakItem {
  cardId: string;
  prompt: string;
  userAnswer?: string;
  topic?: string;
}

export interface WrongStreakState {
  recentWrong: readonly WrongStreakItem[];
  roundNudgeCount: number;
  lastNudgeAt: number | null;
}

export function createWrongStreakState(): WrongStreakState {
  return { recentWrong: [], roundNudgeCount: 0, lastNudgeAt: null };
}

export function isWrongOutcome(outcome: { correct?: boolean; grade?: number } | null | undefined): boolean {
  if (!outcome) return false;
  if (outcome.correct === false) return true;
  if (typeof outcome.grade === 'number' && outcome.grade < 3) return true;
  return false;
}

/** Pure transition: record an answered card's outcome (dedupes same cardId; resets streak on pass). */
export function recordReviewOutcome(
  state: WrongStreakState,
  item: WrongStreakItem & { correct?: boolean; grade?: number },
): WrongStreakState {
  if (!item.cardId) return state;
  if (!isWrongOutcome(item)) {
    return state.recentWrong.length === 0 ? state : { ...state, recentWrong: [] };
  }
  if (state.recentWrong.some((x) => x.cardId === item.cardId)) return state;
  return {
    ...state,
    recentWrong: [
      ...state.recentWrong.slice(-(WRONG_STREAK_THRESHOLD - 1)),
      { cardId: item.cardId, prompt: item.prompt, userAnswer: item.userAnswer, topic: item.topic },
    ],
  };
}

export interface WrongStreakTriggerCheck {
  enabled: boolean;
  isActive: boolean;
  isEditing: boolean;
  anyModalOpen: boolean;
  state: WrongStreakState;
  threshold?: number;
  maxPerRound?: number;
  cooldownMs?: number;
  now?: number;
}

export function shouldTriggerWrongStreakNudge(opts: WrongStreakTriggerCheck): boolean {
  if (!opts.enabled || !opts.isActive || opts.isEditing || opts.anyModalOpen) return false;
  const threshold = opts.threshold ?? WRONG_STREAK_THRESHOLD;
  const maxPerRound = opts.maxPerRound ?? WRONG_STREAK_MAX_PER_ROUND;
  const cooldownMs = opts.cooldownMs ?? WRONG_STREAK_COOLDOWN_MS;
  if (opts.state.recentWrong.length < threshold) return false;
  if (opts.state.roundNudgeCount >= maxPerRound) return false;
  const now = opts.now ?? Date.now();
  if (opts.state.lastNudgeAt !== null && now - opts.state.lastNudgeAt < cooldownMs) return false;
  return true;
}

export function buildWrongStreakBanner(
  recentWrong: readonly WrongStreakItem[],
  lang: UiLanguage,
  asciiMode: boolean,
): string {
  const count = recentWrong.length;
  const icon = asciiMode ? '!' : '✦';
  const topics = [...new Set(recentWrong.map((x) => x.topic).filter(Boolean))].slice(0, 2);
  const topicHint = topics.length > 0 ? (lang === 'en' ? ` (${topics.join(', ')})` : `（${topics.join('、')}）`) : '';
  return lang === 'en'
    ? `${icon} ${count} wrong in a row${topicHint} — press [t] for AI root-cause diagnosis`
    : `${icon} 连续答错 ${count} 题${topicHint}，建议做一次共性归因 [t] 带学诊断`;
}
