/**
 * Structured session memory pruning & condensation for Persistent AI Assistant (Round 98 Track D11).
 *
 * When a long conversation exceeds `maxTurns`, evicted turns are deterministically condensed
 * into a single compact summary header (0 LLM tokens, bounded length) rather than silently
 * losing earlier actions, stages, and questions.
 */
import type { UiLanguage } from '../types/contracts.js';

export interface PrunableTurn {
  id: string;
  at: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  stage?: string;
  actionSummary?: string;
  isSummary?: boolean;
}

const SUMMARY_TURN_ID = 'assistant-memory-summary';
const MAX_SUMMARY_CHARS = 220;

function clipSnippet(raw: string, maxLen: number): string {
  const clean = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

/**
 * Condense evicted turns into a compact, deterministic 1-turn summary header and keep the
 * most recent `maxTurns - 1` active turns so total length never exceeds `maxTurns`.
 */
export function pruneTurnsWithSummary<T extends PrunableTurn>(
  turns: readonly T[],
  maxTurns: number,
  lang: UiLanguage = 'zh',
): T[] {
  const cap = Math.max(2, Math.floor(maxTurns));
  if (turns.length <= cap) return [...turns];

  const existingSummary = turns[0]?.id === SUMMARY_TURN_ID ? turns[0] : null;
  const active = existingSummary ? turns.slice(1) : [...turns];
  const keepCount = Math.max(1, cap - 1);
  if (active.length <= keepCount) {
    return existingSummary ? [existingSummary, ...active] : active;
  }

  const evicted = active.slice(0, active.length - keepCount);
  const kept = active.slice(-keepCount);

  const actions: string[] = [];
  const topics: string[] = [];
  const stages = new Set<string>();
  for (const t of evicted) {
    if (t.stage) stages.add(t.stage);
    if (t.actionSummary && actions.length < 3) {
      actions.push(clipSnippet(t.actionSummary, 28));
    } else if (t.role === 'user' && topics.length < 2) {
      topics.push(clipSnippet(t.text, 24));
    }
  }

  const prevCountMatch = existingSummary?.actionSummary?.match(/(\d+)/);
  const prevEvictedCount = prevCountMatch ? Number.parseInt(prevCountMatch[1], 10) : 0;
  const totalCondensed = prevEvictedCount + evicted.length;

  const parts: string[] = [];
  if (stages.size > 0) {
    parts.push(`${lang === 'en' ? 'Stages' : '阶段'}: ${[...stages].join('/')}`);
  }
  if (actions.length > 0) {
    parts.push(`${lang === 'en' ? 'Actions' : '动作'}: ${actions.join(' · ')}`);
  }
  if (topics.length > 0) {
    parts.push(`${lang === 'en' ? 'Asked' : '提问'}: ${topics.join(' / ')}`);
  }
  const detail = clipSnippet(
    parts.join(' | ') || (lang === 'en' ? 'Earlier context preserved' : '已保留早期对话要点'),
    MAX_SUMMARY_CHARS,
  );

  const summaryTurn = {
    id: SUMMARY_TURN_ID,
    at: evicted[evicted.length - 1]?.at ?? Date.now(),
    role: 'system' as const,
    isSummary: true,
    actionSummary:
      lang === 'en'
        ? `Memory condensed (${totalCondensed} earlier turns)`
        : `早期记忆摘要（已压缩 ${totalCondensed} 条）`,
    text: detail,
  } as unknown as T;

  return [summaryTurn, ...kept];
}
