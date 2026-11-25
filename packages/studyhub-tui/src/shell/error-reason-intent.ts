/**
 * Mistake reasons for the assistant (#1439).
 *
 * The backend stores a reason as one of six ids (`attempt.errorReason.set`); the wrong-book shows
 * them by name. A learner types a name or an everyday word for it, so this maps words to ids and
 * never guesses: text that names no known reason yields null and the assistant asks instead.
 */
import type { UiLanguage } from '../types/contracts.js';
import { ERROR_REASONS, reasonLabel } from '../views/wrongbook/helpers.js';
import type { ErrorReasonId } from '../views/wrongbook/types.js';

export const SET_ERROR_REASON_ACTION = 'attempt.errorReason.set';

/** Everyday words for each reason, beyond the names the wrong-book shows. */
const EVERYDAY_WORDS: Record<ErrorReasonId, readonly string[]> = {
  concept: ['概念不清', '概念没懂', '概念'],
  condition: ['漏条件', '看漏', '审题', '条件'],
  derivation: ['推导', '不会推', '算错'],
  slip: ['粗心', '手滑', '马虎', '大意', 'careless'],
  prerequisite: ['前置', '基础不牢', '基础'],
  bad_question: ['题目有问题', '题有问题', '题目错', '存疑'],
};

function wordsFor(reason: (typeof ERROR_REASONS)[number]): string[] {
  return [reason.id, reason.zh, reason.en, ...EVERYDAY_WORDS[reason.id]].map((word) => word.toLowerCase());
}

/** The reason `text` names, or null when it names none. The longest matching word wins. */
export function errorReasonFromText(text: string): ErrorReasonId | null {
  const haystack = text.toLowerCase();
  let best: { id: ErrorReasonId; length: number } | null = null;
  for (const reason of ERROR_REASONS) {
    for (const word of wordsFor(reason)) {
      if (haystack.includes(word) && (!best || word.length > best.length)) best = { id: reason.id, length: word.length };
    }
  }
  return best?.id ?? null;
}

export interface ErrorReasonTarget {
  deckId?: string | null;
  cardId?: string | null;
}

/** Arguments for the backend action; `reason` null clears the mark. */
export function errorReasonArgs(target: ErrorReasonTarget, reason: ErrorReasonId | null): Record<string, unknown> {
  return {
    ...(target.deckId ? { deckId: target.deckId } : {}),
    ...(target.cardId ? { cardId: target.cardId } : {}),
    errorReason: reason,
  };
}

export function errorReasonName(reason: ErrorReasonId, lang: UiLanguage): string {
  return reasonLabel(reason, lang);
}
