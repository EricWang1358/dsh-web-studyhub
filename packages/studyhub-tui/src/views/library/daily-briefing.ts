/**
 * Proactive Daily Study Briefing selector (Round 85 Track D2).
 *
 * Produces a concise "today's priority + why" recommendation from the existing StudySnapshot
 * (due cards, weak/wrong items, daily goal, upcoming exams) with zero LLM call on boot and
 * strict adherence to all 3 proactive guardrails:
 *   1. Disable toggle (`proactiveHints !== false`)
 *   2. Rate limit (at most 1 per calendar day; dismissing persists `dismissedBriefingDate`)
 *   3. Non-interrupting inline banner (never opens a modal or steals focus; zero idle polling)
 */
import type { StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { getProgressMap, isActiveStudyDeck, selectDeckMetrics } from '../../selectors/study-metrics.js';

export type DailyBriefingTarget =
  | { kind: 'deck'; deckId: string; deckTitle: string }
  | { kind: 'wrongbook' }
  | { kind: 'plan' };

export interface DailyBriefing {
  dateKey: string;
  headline: string;
  reason: string;
  actionLabel: string;
  target: DailyBriefingTarget;
}

export interface BuildDailyBriefingOptions {
  snapshot: StudySnapshot | null | undefined;
  course: string | null;
  lang: UiLanguage;
  proactiveHints?: boolean;
  dismissedBriefingDate?: string;
  now?: Date;
}

export function formatLocalDateKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function buildDailyBriefing(opts: BuildDailyBriefingOptions): DailyBriefing | null {
  if (opts.proactiveHints === false) return null;
  const dateKey = formatLocalDateKey(opts.now);
  if (opts.dismissedBriefingDate === dateKey) return null;

  const snap = opts.snapshot;
  if (!snap) return null;

  const progressMap = getProgressMap(snap);
  const activeDecks = (snap.decks ?? []).filter((d) => isActiveStudyDeck(d, opts.course));
  if (activeDecks.length === 0) return null;

  const zh = opts.lang !== 'en';

  const ranked = activeDecks.map((d) => {
    const title = String(d.title ?? d.name ?? d.id);
    const m = selectDeckMetrics(d, progressMap);
    return { id: d.id, title, due: m.due, wrong: m.weak, newCount: m.newCount };
  });

  const totalDue = ranked.reduce((n, d) => n + d.due, 0);
  const totalWrong = ranked.reduce((n, d) => n + d.wrong, 0);
  const totalNew = ranked.reduce((n, d) => n + d.newCount, 0);

  // Priority 1: Highest-due deck to prevent forgetting-curve drop-off
  const topDue = [...ranked].sort((a, b) => b.due - a.due)[0];
  if (topDue && topDue.due > 0) {
    return {
      dateKey,
      headline: zh
        ? `今日简报：优先复习「${topDue.title}」(${topDue.due} 题到期)`
        : `Daily Brief: Review "${topDue.title}" (${topDue.due} due)`,
      reason: zh
        ? totalDue > topDue.due
          ? `共 ${totalDue} 题到期，先清到期题最稳记忆曲线`
          : '先清到期题可最大化稳固记忆曲线'
        : totalDue > topDue.due
          ? `${totalDue} total due today — clearing due cards first protects retention`
          : 'Clearing due cards first protects retention',
      actionLabel: zh ? '[B] 开始复习' : '[B] Start',
      target: { kind: 'deck', deckId: topDue.id, deckTitle: topDue.title },
    };
  }

  // Priority 2: Weak/wrong cards needing consolidation
  const topWrong = [...ranked].sort((a, b) => b.wrong - a.wrong)[0];
  if (topWrong && topWrong.wrong > 0) {
    return {
      dateKey,
      headline: zh
        ? `今日简报：先巩固「${topWrong.title}」(${topWrong.wrong} 道薄弱错题)`
        : `Daily Brief: Consolidate "${topWrong.title}" (${topWrong.wrong} weak)`,
      reason: zh
        ? totalWrong > topWrong.wrong
          ? `当前共 ${totalWrong} 道错题，消灭薄弱项提分最快`
          : '先攻克错题薄弱项提分最快'
        : `${totalWrong} weak card(s) — fixing weak spots boosts mastery fastest`,
      actionLabel: zh ? '[B] 去巩固' : '[B] Practice',
      target: { kind: 'deck', deckId: topWrong.id, deckTitle: topWrong.title },
    };
  }

  // Priority 3: New cards / daily goal progress
  const topNew = [...ranked].sort((a, b) => b.newCount - a.newCount)[0];
  if (topNew && topNew.newCount > 0) {
    const reviewed = Number(snap.today?.reviewed ?? 0) || 0;
    const goal = Number(snap.today?.goal ?? 0) || 0;
    const goalTextZh = goal > 0 ? `今日目标 ${reviewed}/${goal}，` : '';
    const goalTextEn = goal > 0 ? `Goal ${reviewed}/${goal} — ` : '';
    return {
      dateKey,
      headline: zh
        ? `今日简报：推进「${topNew.title}」新题 (${topNew.newCount} 题待学)`
        : `Daily Brief: Learn new cards in "${topNew.title}" (${topNew.newCount} new)`,
      reason: zh
        ? `${goalTextZh}到期题已清空，适合推进新知识 (${totalNew} 新题)`
        : `${goalTextEn}all due cards cleared, ready for ${totalNew} new card(s)`,
      actionLabel: zh ? '[B] 学新题' : '[B] Learn',
      target: { kind: 'deck', deckId: topNew.id, deckTitle: topNew.title },
    };
  }

  return null;
}
