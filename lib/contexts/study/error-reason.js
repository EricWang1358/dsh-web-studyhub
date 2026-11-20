import { TRIAGE_REASONS } from '../../evidence/mistake-triage.js';
import { isActiveAttempt } from './active-attempts.js';

export const ERROR_REASONS = TRIAGE_REASONS;
export const ERROR_REASON_SET = new Set(ERROR_REASONS);
export const THINKING_NOTE_MAX_CHARS = 200;

/** Validate and normalize an error reason (`concept | condition | derivation | slip | prerequisite | bad_question | null`). */
export function normalizeErrorReason(raw) {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw Object.assign(new Error(`errorReason must be ${ERROR_REASONS.join(', ')}, or null`), { code: 'invalid-error-reason' });
  }
  const clean = raw.trim();
  if (!clean) return null;
  if (!ERROR_REASON_SET.has(clean)) {
    throw Object.assign(new Error(`Invalid errorReason "${clean}": expected one of ${ERROR_REASONS.join(', ')}`), { code: 'invalid-error-reason' });
  }
  return clean;
}

/** Validate, collapse whitespace, and cap an optional 1-sentence thinking note to 200 chars. */
export function normalizeThinkingNote(raw) {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw Object.assign(new Error('thinkingNote must be a string or null'), { code: 'invalid-thinking-note' });
  }
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.slice(0, THINKING_NOTE_MAX_CHARS);
}

/**
 * Locate the newest active non-implicit attempt for `(deckId, cardId)` (scoped to `runId` first when given).
 * Prefers non-retry entries inside a run, and prefers failed attempts (`grade < 3`) when tagging an error reason without a runId.
 */
export function findTargetAttempt(attempts, { deckId, cardId, runId = '', preferFailed = false } = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  let runMatch = null;
  let runNonRetryMatch = null;
  let cardFailedMatch = null;
  let cardLatestMatch = null;

  for (let i = list.length - 1; i >= 0; i--) {
    const att = list[i];
    if (!att || att.implicit || !isActiveAttempt(att)) continue;
    if (att.deckId !== deckId) continue;
    const attCardId = att.quiz_id ?? att.cardId;
    if (attCardId !== cardId) continue;

    if (runId && att.runId === runId) {
      if (!att.retry && !runNonRetryMatch) {
        runNonRetryMatch = att;
        break;
      }
      if (!runMatch) runMatch = att;
    }
    if (!cardLatestMatch) cardLatestMatch = att;
    if (preferFailed && !cardFailedMatch && Number(att.grade) < 3) cardFailedMatch = att;
  }

  return runNonRetryMatch || runMatch || (preferFailed ? cardFailedMatch : null) || cardLatestMatch;
}

/** Narrow `attempts`-only mutation persisting `#1156` error reasons & optional 1-sentence thinking notes. */
export const errorReasonMutations = {
  'attempt.errorReason.set': (s, a = {}) => {
    const deckId = typeof a.deckId === 'string' ? a.deckId.trim() : '';
    const cardId = typeof a.cardId === 'string' ? a.cardId.trim() : '';
    const runId = typeof a.runId === 'string' ? a.runId.trim() : '';
    if (!deckId || !cardId) {
      throw Object.assign(new Error('deckId and cardId are required'), { code: 'invalid-attempt-ref' });
    }
    const hasReason = Object.hasOwn(a, 'errorReason') && a.errorReason !== undefined;
    const hasNote = Object.hasOwn(a, 'thinkingNote') && a.thinkingNote !== undefined;
    if (!hasReason && !hasNote) {
      throw Object.assign(new Error('Provide errorReason or thinkingNote'), { code: 'missing-error-reason-fields' });
    }
    const nextReason = hasReason ? normalizeErrorReason(a.errorReason) : undefined;
    const nextNote = hasNote ? normalizeThinkingNote(a.thinkingNote) : undefined;

    const target = findTargetAttempt(s.attempts, {
      deckId,
      cardId,
      runId,
      preferFailed: hasReason && nextReason !== null,
    });
    if (!target) {
      throw Object.assign(new Error('Attempt not found'), {
        noWrite: { ok: false, updated: false, reason: 'attempt-not-found', deckId, cardId },
      });
    }

    if (hasReason) {
      if (nextReason === null) delete target.errorReason;
      else target.errorReason = nextReason;
    }
    if (hasNote) {
      if (nextNote === null) delete target.thinkingNote;
      else target.thinkingNote = nextNote;
    }
    target.errorReasonUpdatedAt = new Date().toISOString();

    return {
      ok: true,
      updated: true,
      deckId,
      cardId,
      runId: target.runId || null,
      errorReason: target.errorReason ?? null,
      thinkingNote: target.thinkingNote ?? null,
    };
  },
};
