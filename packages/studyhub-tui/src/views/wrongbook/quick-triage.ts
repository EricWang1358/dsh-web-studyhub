/**
 * Top Wrong-Card Cluster Quick-Drill selector (Round 92 Track B7).
 *
 * Scans visible wrong items in O(n) to identify the single highest-impact weak topic
 * (or error reason fallback) with >= 2 cards so learners can launch a 1-key targeted drill `[Q]`.
 */
import type { UiLanguage } from '../../types/contracts.js';
import type { WrongBookItem } from './types.js';

export interface TopWrongCluster {
  kind: 'topic' | 'reason';
  key: string;
  label: string;
  count: number;
  scope: Array<{ deckId: string; cardId: string }>;
}

const MAX_CLUSTER_SCOPE = 25;

export function buildTopWrongCluster(
  items: readonly WrongBookItem[],
  lang: UiLanguage,
): TopWrongCluster | null {
  if (!Array.isArray(items) || items.length < 2) return null;

  const byTopic = new Map<string, WrongBookItem[]>();
  const byReason = new Map<string, WrongBookItem[]>();

  for (const it of items) {
    if (!it.deckId || !it.cardId) continue;
    const topic = String(it.topic ?? '').trim();
    if (topic) {
      const bucket = byTopic.get(topic);
      if (bucket) bucket.push(it);
      else byTopic.set(topic, [it]);
    }
    if (it.errorReason) {
      const rBucket = byReason.get(it.errorReason);
      if (rBucket) rBucket.push(it);
      else byReason.set(it.errorReason, [it]);
    }
  }

  let bestTopic: { key: string; list: WrongBookItem[] } | null = null;
  for (const [key, list] of byTopic.entries()) {
    if (list.length >= 2 && (!bestTopic || list.length > bestTopic.list.length)) {
      bestTopic = { key, list };
    }
  }
  if (bestTopic) {
    const scope = bestTopic.list.slice(0, MAX_CLUSTER_SCOPE).map((x) => ({ deckId: x.deckId, cardId: x.cardId }));
    return {
      kind: 'topic',
      key: bestTopic.key,
      label: lang === 'en' ? `Top weak: ${bestTopic.key} (${bestTopic.list.length})` : `高频薄弱：${bestTopic.key} (${bestTopic.list.length}题)`,
      count: bestTopic.list.length,
      scope,
    };
  }

  let bestReason: { key: string; list: WrongBookItem[] } | null = null;
  for (const [key, list] of byReason.entries()) {
    if (list.length >= 2 && (!bestReason || list.length > bestReason.list.length)) {
      bestReason = { key, list };
    }
  }
  if (bestReason) {
    const scope = bestReason.list.slice(0, MAX_CLUSTER_SCOPE).map((x) => ({ deckId: x.deckId, cardId: x.cardId }));
    return {
      kind: 'reason',
      key: bestReason.key,
      label: lang === 'en' ? `Top reason: ${bestReason.key} (${bestReason.list.length})` : `高频错因：${bestReason.key} (${bestReason.list.length}题)`,
      count: bestReason.list.length,
      scope,
    };
  }

  return null;
}
