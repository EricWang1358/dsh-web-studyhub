/**
 * Proactive Round Completion Next-Step Suggestion (Round 89 Track D5).
 *
 * Computes a calm, actionable next-step recommendation after finishing a review round
 * based on accuracy, missed count, weak topics, and remaining due cards.
 * Enforces all 3 proactive guardrails:
 *   1. Disable toggle (`proactiveHints !== false`)
 *   2. Rate limit (at most 1 inline suggestion per round; dismissible)
 *   3. Non-interrupting (calm inline line inside RoundSummary; zero modals, zero idle polling)
 */
import type { UiLanguage } from '../../types/contracts.js';

export interface RoundNextStepInput {
  answered: number;
  correct: number;
  weakCount: number;
  weakTopics: readonly string[];
  remainingDue: number;
  lang: UiLanguage;
  asciiMode: boolean;
  proactiveHints?: boolean;
  dismissed?: boolean;
}

export interface RoundNextStepSuggestion {
  kind: 'retry_weak' | 'continue_due' | 'daily_recap' | 'all_clear';
  key: 'w' | 'R' | 'g' | 'b';
  text: string;
}

export function buildRoundNextStepSuggestion(opts: RoundNextStepInput): RoundNextStepSuggestion | null {
  if (opts.proactiveHints === false || opts.dismissed) return null;
  if (opts.answered <= 0) return null;

  const zh = opts.lang !== 'en';
  const icon = opts.asciiMode ? '*' : '✦';
  const accuracy = Math.round((opts.correct / Math.max(1, opts.answered)) * 100);
  const topicHint = opts.weakTopics.length > 0 ? `（${opts.weakTopics.slice(0, 2).join('、')}）` : '';
  const topicHintEn = opts.weakTopics.length > 0 ? ` (${opts.weakTopics.slice(0, 2).join(', ')})` : '';

  if (opts.weakCount >= 2 || (opts.weakCount > 0 && accuracy < 70)) {
    return {
      kind: 'retry_weak',
      key: 'w',
      text: zh
        ? `${icon} 下一步建议：[w] 趁热重练 ${opts.weakCount} 道错题${topicHint}，当场消除薄弱点`
        : `${icon} Next step: [w] Retry ${opts.weakCount} missed card(s)${topicHintEn} while fresh`,
    };
  }

  if (opts.remainingDue > 0) {
    return {
      kind: 'continue_due',
      key: 'R',
      text: zh
        ? `${icon} 下一步建议：本轮正确率 ${accuracy}%，按 [R] 继续清完剩余 ${opts.remainingDue} 道到期题`
        : `${icon} Next step: ${accuracy}% accuracy — press [R] to clear ${opts.remainingDue} remaining due card(s)`,
    };
  }

  if (opts.answered >= 10) {
    return {
      kind: 'daily_recap',
      key: 'g',
      text: zh
        ? `${icon} 下一步建议：今日到期题已清空，按 [g] 生成今日复盘笔记固化记忆`
        : `${icon} Next step: Due queue cleared — press [g] to generate today's recap note`,
    };
  }

  return {
    kind: 'all_clear',
    key: 'b',
    text: zh
      ? `${icon} 下一步建议：本轮正确率 ${accuracy}%，按 [b] 回学习库选下一组或休息巩固`
      : `${icon} Next step: ${accuracy}% accuracy — press [b] for Library or take a short break`,
  };
}
