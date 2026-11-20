// @ts-check
import { capPracticeScope } from './wrongbook-model.js';

/**
 * Pure 0-token prescription builder for WrongBook's opt-in 「靶向清零处方」 (`settings.practice.wrongbookClinic`).
 * Clusters already-loaded weak rows without model calls or extra RPCs (requires >= 2 weak rows):
 * 1) `cluster`: 2+ weak items sharing the same companion slide or non-JSON material page/document;
 * 2) `leech`: stubborn questions flagged by `item.leech`;
 * 3) `singleSlip`: non-leech questions missed once so far (2+ items when narrower than the full list or total >= 3).
 *
 * @typedef {{ deckId: string, cardId: string }} CardRef
 * @typedef {{ scope: CardRef[], total: number, capped: boolean, limit: number }} CappedScope
 * @param {object} [input]
 * @param {Array<Record<string, any>>} [input.rows]
 * @param {Map<string, any>} [input.sourceTargetByCard]
 * @param {Map<string, any>} [input.companionTargetByCard]
 * @param {Map<string, any>} [input.hidTargetByCard]
 * @param {Map<string, number> | null} [input.wrongCounts]
 * @returns {Array<Record<string, any>>}
 */
export function buildWrongbookClinic({
  rows = [],
  sourceTargetByCard = new Map(),
  companionTargetByCard = new Map(),
  hidTargetByCard = new Map(),
  wrongCounts = null,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];

  /** @type {Array<Record<string, any>>} */
  const lanes = [];
  const refOf = (item) => ({ deckId: item.deckId, cardId: item.cardId });

  // 1. Companion slide, knowledge-point `hid`, or source page cluster (>= 2 cards pointing at the same anchor).
  /** @type {Map<string, { key: string, kind: 'companion' | 'hid' | 'source', target: any, sourceTarget: any, hid: string, pointTitle: string, items: Array<Record<string, any>>, latest: string }>} */
  const clusters = new Map();
  for (const item of rows) {
    if (!item?.deckId || !item?.cardId) continue;
    const comp = companionTargetByCard instanceof Map ? companionTargetByCard.get(item.cardId) : null;
    const src = sourceTargetByCard instanceof Map ? sourceTargetByCard.get(item.cardId) : null;
    const hidInfo = hidTargetByCard instanceof Map ? hidTargetByCard.get(item.cardId) : null;
    const cardHid = typeof hidInfo?.hid === 'string' && hidInfo.hid.trim()
      ? hidInfo.hid.trim()
      : (typeof item.hid === 'string' && item.hid.trim() ? item.hid.trim() : '');
    let key = '';
    /** @type {'companion' | 'hid' | 'source' | null} */
    let kind = null;
    let target = null;
    let sourceTarget = null;
    let hid = '';
    let pointTitle = '';
    if (comp?.companionId) {
      key = `comp:${comp.companionId}:${comp.slide || 0}`;
      kind = 'companion';
      target = comp;
    } else if (cardHid) {
      key = `hid:${cardHid}`;
      kind = 'hid';
      hid = cardHid;
      pointTitle = String(hidInfo?.title || item.pointTitle || item.topic || '').trim();
      sourceTarget = src?.source?.id ? src : null;
      target = sourceTarget || { hid: cardHid, title: pointTitle };
    } else if (src?.source?.id) {
      key = `src:${src.source.id}:${src.peekPage ?? ''}`;
      kind = 'source';
      target = src;
      sourceTarget = src;
    }
    if (!key || !kind) continue;
    let bucket = clusters.get(key);
    if (!bucket) {
      bucket = { key, kind, target, sourceTarget, hid, pointTitle, items: [], latest: '' };
      clusters.set(key, bucket);
    }
    if (!bucket.sourceTarget && sourceTarget) bucket.sourceTarget = sourceTarget;
    if (!bucket.pointTitle && pointTitle) bucket.pointTitle = pointTitle;
    bucket.items.push(item);
    const at = String(item.lastWrongAt || item.lastAt || '');
    if (at > bucket.latest) bucket.latest = at;
  }

  const bestCluster = [...clusters.values()]
    .filter((bucket) => bucket.items.length >= 2)
    .sort((a, b) => (b.items.length - a.items.length) || (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))[0];

  if (bestCluster) {
    const refs = bestCluster.items.map(refOf);
    const scope = capPracticeScope(refs);
    const srcTarget = bestCluster.sourceTarget || (bestCluster.kind === 'source' ? bestCluster.target : null);
    const sourceTitle = srcTarget?.source?.title || '';
    const page = srcTarget?.peekPage ?? null;
    const companionTitle = bestCluster.target?.companionTitle || bestCluster.target?.label || '';
    const slide = bestCluster.target?.slide >= 1 ? bestCluster.target.slide : null;
    lanes.push({
      id: 'cluster',
      kind: bestCluster.kind,
      clusterKey: bestCluster.key,
      count: bestCluster.items.length,
      refs,
      cardIds: bestCluster.items.map((item) => item.cardId),
      deckIds: [...new Set(bestCluster.items.map((item) => item.deckId))],
      scope,
      target: bestCluster.target,
      sourceTarget: srcTarget,
      sourceTitle,
      page,
      companionTitle,
      slide,
      hid: bestCluster.hid || '',
      pointTitle: bestCluster.pointTitle || '',
      recommendRescue: bestCluster.kind !== 'companion',
    });
  }

  // 2. Stubborn leeches needing focused drill or filtering into rescue tools.
  const leeches = rows.filter((item) => Boolean(item?.leech));
  if (leeches.length > 0) {
    const refs = leeches.map(refOf);
    lanes.push({
      id: 'leech',
      count: leeches.length,
      partial: leeches.length < rows.length,
      refs,
      scope: capPracticeScope(refs),
    });
  }

  // 3. Single-slip mistakes (not leech, missed at most once) for quick clearing.
  const slips = rows.filter((item) => {
    if (!item || item.leech) return false;
    const count = Number.isFinite(item.wrongCount)
      ? item.wrongCount
      : wrongCounts?.get(`${item.deckId}\0${item.cardId}`);
    return (count ?? 1) <= 1;
  });
  if (slips.length >= 2 && (slips.length < rows.length || rows.length >= 3)) {
    const refs = slips.map(refOf);
    lanes.push({
      id: 'singleSlip',
      count: slips.length,
      refs,
      scope: capPracticeScope(refs),
    });
  }

  return lanes;
}
