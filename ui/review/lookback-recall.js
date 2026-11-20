// @ts-check
/* Pure helpers for opt-in blind-recall veil & mistake-reason tagging in RoundLookBack:
   zero model calls, zero FSRS side effects, deterministic ref deduplication. */

export const MAX_REASON_PRACTICE_REFS = 200;

export const LOOKBACK_ERROR_REASONS = Object.freeze([
  Object.freeze({ id: 'concept', label: '概念混淆' }),
  Object.freeze({ id: 'condition', label: '漏看条件' }),
  Object.freeze({ id: 'derivation', label: '推导卡住' }),
  Object.freeze({ id: 'slip', label: '粗心手滑' }),
]);

/** Stable per-row key within a round result (deckId:cardId when present, else row number). */
export function rowReasonKey(row) {
  if (row?.deckId && row?.cardId) return `${row.deckId}:${row.cardId}`;
  return row?.number != null ? `#${row.number}` : '';
}

/** Resolve the Chinese source label for a stored reason id, or '' when unknown. */
export function reasonLabelOf(reasonId) {
  return LOOKBACK_ERROR_REASONS.find((item) => item.id === reasonId)?.label || '';
}

const maskBlanks = (text) => String(text ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿');

/** Prompt text safe for blind recall: strips `{{id}}` cloze markers so answers never leak before reveal. */
export function maskedPromptOf(row) {
  return maskBlanks(row?.card?.prompt ?? row?.prompt ?? '');
}

/** Masked cloze body for fill-in-the-blank rows when veiled, or '' when absent or identical to prompt. */
export function maskedClozeTextOf(row) {
  if (row?.card?.kind !== 'cloze') return '';
  const text = maskBlanks(row?.card?.cloze?.text ?? '');
  if (!text.trim() || text === maskedPromptOf(row)) return '';
  return text;
}

/** Pure toggle for a wrong question's mistake reason tag. */
export function toggleRowReason(map, key, reasonId) {
  const current = map && typeof map === 'object' ? { ...map } : {};
  if (!key || !reasonLabelOf(reasonId)) return current;
  if (current[key] === reasonId) delete current[key];
  else current[key] = reasonId;
  return current;
}

/** Seed initial mistake-reason map from persisted `attempt.errorReason` values projected onto look-back rows. */
export function seedReasonsFromRows(rows = []) {
  /** @type {Record<string, string>} */
  const map = {};
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || row.status !== 'wrong') continue;
    const reasonId = typeof row.errorReason === 'string' ? row.errorReason.trim() : '';
    if (!reasonLabelOf(reasonId)) continue;
    const key = rowReasonKey(row);
    if (key) map[key] = reasonId;
  }
  return map;
}

/** Persist a toggled mistake reason onto the underlying attempt via `attempt.errorReason.set` (narrow `attempts` lock). */
export function persistRowReason(call, row, runId, reasonId) {
  if (typeof call !== 'function' || !row?.deckId || !row?.cardId) return Promise.resolve(null);
  return Promise.resolve(call('attempt.errorReason.set', {
    deckId: row.deckId,
    cardId: row.cardId,
    ...(runId ? { runId } : {}),
    errorReason: reasonId || null,
  })).catch(() => null);
}

/** Unique playable `{ deckId, cardId }` refs for wrong rows tagged with `reasonId`. */
export function refsForReason(rows = [], map = {}, reasonId) {
  if (!Array.isArray(rows) || !map || !reasonLabelOf(reasonId)) return [];
  const refs = [], seen = new Set();
  for (const row of rows) {
    if (!row || row.status !== 'wrong' || !row.deckId || !row.cardId) continue;
    if (map[rowReasonKey(row)] !== reasonId) continue;
    const dedup = `${row.deckId}\0${row.cardId}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    refs.push({ deckId: row.deckId, cardId: row.cardId });
    if (refs.length >= MAX_REASON_PRACTICE_REFS) break;
  }
  return refs;
}

/** Non-empty mistake-reason buckets in display order for quick targeted retraining. */
export function reasonGroups(rows = [], map = {}) {
  return LOOKBACK_ERROR_REASONS
    .map((item) => ({ ...item, refs: refsForReason(rows, map, item.id) }))
    .filter((group) => group.refs.length > 0);
}

/** Resolve the active 0-token triage route for a missed look-back row, updating reactively as `#1156` reasons toggle. */
export function resolveRowTriage(row, activeReasonId = '') {
  if (!row || row.status !== 'wrong') return null;
  const reason = typeof activeReasonId === 'string' ? activeReasonId.trim() : '';
  const byReason = row.triageByReason && typeof row.triageByReason === 'object' ? row.triageByReason : null;
  if (byReason) {
    if (reason && byReason[reason]) return byReason[reason];
    if (!reason) {
      const persisted = typeof row.errorReason === 'string' ? row.errorReason.trim() : '';
      if (persisted && !reasonLabelOf(persisted) && row.triage && typeof row.triage === 'object') return row.triage;
      if (byReason.default) return byReason.default;
    }
  }
  if (row.triage && typeof row.triage === 'object') {
    if (reason === 'slip') return { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' };
    if (reason === 'condition' || reason === 'derivation') {
      return {
        route: 'rescue_companion',
        reason,
        source: 'explicit',
        tokens: 'light',
        rescueFocus: reason,
        ...(row.triage.course ? { course: row.triage.course } : {}),
        ...(row.triage.hid || row.hid ? { hid: row.triage.hid || row.hid } : {}),
      };
    }
    return row.triage;
  }
  return null;
}

/** Whether a triage decision calls for a conditional inline next-step action (false for `fsrs_only`). */
export const isActionableTriage = (triage) => Boolean(triage && triage.route && triage.route !== 'fsrs_only');
