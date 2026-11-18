/* 资料库与靶向练习衔接（pure, browser-safe）：计算文档级待巩固紧迫度（避免将可重叠的 due 与 weak 重复相加）、
   「待巩固优先」稳定排序比较器，以及对 materials.pages.cards 返回集合去重、按紧迫度排位并截断至 SCOPE_LIMIT=200。 */

export const MATERIAL_SCOPE_LIMIT = 200;

const LEVEL_RANK = Object.freeze({
  weak: 0,
  new: 2,
  learning: 3,
  familiar: 4,
  mastered: 5,
});

/**
 * Extract separate non-summed review urgency metrics from a materialMastery summary object
 * (note: a `weak` card can also carry `due: true`, so `weak` and `due` are never added blindly).
 */
export function reviewUrgencyOf(summary) {
  const total = Number(summary?.total) || 0;
  const weak = Number(summary?.weak ?? summary?.counts?.weak) || 0;
  const due = Number(summary?.due) || 0;
  const fresh = Number(summary?.fresh ?? summary?.counts?.new) || 0;
  const draftCards = Number(summary?.draftCards) || 0;
  const percent = Number.isFinite(summary?.percent) ? summary.percent : null;
  return {
    total,
    weak,
    due,
    fresh,
    draftCards,
    percent,
    hasUrgent: weak > 0 || due > 0,
  };
}

function reviewTierOf(urgency) {
  if (urgency.hasUrgent) return 0;
  if (urgency.total > 0 && (urgency.percent === null || urgency.percent < 80)) return 1;
  if (urgency.draftCards > 0 && urgency.total === 0) return 2;
  if (urgency.total > 0) return 3;
  return 4;
}

/**
 * Deterministic comparator for 资料 list sorting (`sortBy === 'review'`):
 * urgent (`weak || due`) -> unmastered published -> unpublished drafts -> mastered -> none.
 */
export function compareMaterialReview(a, b, materialMastery = null, locale = 'zh-CN') {
  const ua = reviewUrgencyOf(materialMastery?.[a?.key]?.document);
  const ub = reviewUrgencyOf(materialMastery?.[b?.key]?.document);
  const ta = reviewTierOf(ua), tb = reviewTierOf(ub);
  if (ta !== tb) return ta - tb;
  if (ta === 0) {
    const scoreDiff = (ub.weak * 3 + ub.due * 2) - (ua.weak * 3 + ua.due * 2);
    if (scoreDiff !== 0) return scoreDiff;
    if (ub.weak !== ua.weak) return ub.weak - ua.weak;
    if (ub.due !== ua.due) return ub.due - ua.due;
    const pa = ua.percent ?? 0, pb = ub.percent ?? 0;
    if (pa !== pb) return pa - pb;
  } else if (ta === 1 || ta === 3) {
    const pa = ua.percent ?? -1, pb = ub.percent ?? -1;
    if (pa !== pb) return pa - pb;
    if (ub.total !== ua.total) return ub.total - ua.total;
  } else if (ta === 2 && ub.draftCards !== ua.draftCards) {
    return ub.draftCards - ua.draftCards;
  }
  const dateDiff = String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
  if (dateDiff !== 0) return dateDiff;
  return String(a?.title ?? '').localeCompare(String(b?.title ?? ''), locale, { numeric: true });
}

function rankCardEntry(card) {
  if (card?.level === 'weak') return 0;
  if (card?.due) return 1;
  return LEVEL_RANK[card?.level] ?? 3;
}

/**
 * Deduplicate `materials.pages.cards` items by `(deckId, cardId)`, optionally narrow to urgent (`weak || due`) cards,
 * prioritize `weak -> due -> new -> learning -> familiar -> mastered` (active courses before parked), and cap at `limit` (<= 200).
 */
export function pickPracticeRefs(cards = [], { only = 'all', limit = MATERIAL_SCOPE_LIMIT } = {}) {
  const cap = Math.max(1, Math.min(MATERIAL_SCOPE_LIMIT, Number(limit) || MATERIAL_SCOPE_LIMIT));
  const unique = new Map();
  for (let i = 0; i < (cards || []).length; i++) {
    const card = cards[i];
    if (!card?.deckId || !card?.cardId) continue;
    const key = `${card.deckId}\u0000${card.cardId}`;
    const rank = rankCardEntry(card);
    const urgent = card.level === 'weak' || Boolean(card.due);
    const inactive = Boolean(card.inactive);
    const prev = unique.get(key);
    if (!prev) {
      unique.set(key, { deckId: card.deckId, cardId: card.cardId, rank, urgent, inactive, order: i });
    } else {
      prev.rank = Math.min(prev.rank, rank);
      prev.urgent = prev.urgent || urgent;
      prev.inactive = prev.inactive && inactive;
    }
  }
  let pool = [...unique.values()];
  if (only === 'urgent') pool = pool.filter(entry => entry.urgent);
  pool.sort((a, b) =>
    a.rank - b.rank
    || (Number(a.inactive) - Number(b.inactive))
    || (a.order - b.order));
  const totalUnique = pool.length;
  const sliced = pool.slice(0, cap);
  return {
    refs: sliced.map(({ deckId, cardId }) => ({ deckId, cardId })),
    totalUnique,
    capped: totalUnique > sliced.length,
  };
}
