/**
 * Context-aware action chips & adaptive 3x-repetition promotion (#1315 UX Gate).
 *
 * Rules:
 * - Always render 2–4 highest-relevance chips ABOVE the input box.
 * - Knows current page, active card state (wrong/unanswered/revealed), and practice context stack.
 * - Any instruction executed >= 3 times on a page is promoted to a permanent chip for that page,
 *   and recently used chips are pinned to the top.
 * - Zero external dependencies (`marked`-free).
 */
import type { AssistantCommandStat, PageId, UiLanguage } from '../types/contracts.js';
import type { AssistantCardContext } from '../state/store.js';
import { formatReturnHintLabel, type PracticeContextFrame } from '../state/practice-stack.js';

export const PROMOTION_THRESHOLD = 3;
export const MAX_CHIPS_SHOWN = 4;

export interface AssistantChip {
  id: string;
  label: string;
  /** Natural-language or structured command executed when selected. */
  command: string;
  /** Optional direct action shortcut instead of text command. */
  kind: 'command' | 'guided' | 'return_practice' | 'open_source' | 'copy_prompt';
  promoted?: boolean;
  recent?: boolean;
}

export interface BuildContextChipsInput {
  page: PageId;
  card?: AssistantCardContext | null;
  practiceStack: readonly PracticeContextFrame[];
  statsByPage?: Record<string, Record<string, AssistantCommandStat>>;
  lang?: UiLanguage;
}

/** Normalize a user instruction key for frequency counting (trimmed, collapsed spaces, capped). */
export function normalizeCommandKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

/**
 * Record one execution of `command` on `page` in a pure immutable stats map.
 * Capped at 16 pages × 20 commands to bound memory & `tui.json` size.
 */
export function recordCommandStat(
  statsByPage: Record<string, Record<string, AssistantCommandStat>> | undefined,
  page: PageId,
  rawCommand: string,
  now = Date.now(),
): Record<string, Record<string, AssistantCommandStat>> {
  const key = normalizeCommandKey(rawCommand);
  if (!key) return statsByPage ? { ...statsByPage } : {};

  const nextAll: Record<string, Record<string, AssistantCommandStat>> = {};
  if (statsByPage) {
    for (const [p, map] of Object.entries(statsByPage)) {
      nextAll[p] = { ...map };
    }
  }
  const pageMap = { ...(nextAll[page] ?? {}) };
  const prev = pageMap[key];
  pageMap[key] = {
    count: (prev?.count ?? 0) + 1,
    lastUsedAt: now,
  };

  // Bound per-page entries to top 20 by (count >= 3, lastUsedAt desc)
  const entries = Object.entries(pageMap).sort(
    (a, b) => Number(b[1].count >= PROMOTION_THRESHOLD) - Number(a[1].count >= PROMOTION_THRESHOLD) || b[1].lastUsedAt - a[1].lastUsedAt,
  );
  nextAll[page] = Object.fromEntries(entries.slice(0, 20));
  return nextAll;
}

/**
 * Build the 2–4 most relevant context chips for the top of the docked Assistant panel.
 * Order:
 * 1. Practice context stack return chip (`回到第 N 题`) when on a non-review page with active stack.
 * 2. Promoted frequent chips (`count >= 3` on current page), ordered by most recently used.
 * 3. Context-matched default chips for the current page / card state (recent ones floated first).
 */
export function buildContextChips(input: BuildContextChipsInput): AssistantChip[] {
  const lang = input.lang ?? 'zh';
  const { page, card, practiceStack, statsByPage } = input;
  const chips: AssistantChip[] = [];
  const seenCommands = new Set<string>();

  const pushUnique = (chip: AssistantChip) => {
    const k = normalizeCommandKey(chip.command);
    if (!k || seenCommands.has(k) || chips.length >= MAX_CHIPS_SHOWN) return;
    seenCommands.add(k);
    chips.push(chip);
  };

  // 1) Practice context stack return chip (always #1 when away from original question)
  if (practiceStack.length > 0 && page !== 'review') {
    const retLabel = formatReturnHintLabel(practiceStack, lang) || (lang === 'en' ? 'Back to card' : '回到原题');
    pushUnique({
      id: 'chip:return-practice',
      label: retLabel,
      command: retLabel,
      kind: 'return_practice',
    });
  }

  // 2) Promoted frequent commands (`count >= 3` on this page), most recently used first
  const pageStats = statsByPage?.[page] ?? {};
  const promotedEntries = Object.entries(pageStats)
    .filter(([, st]) => st && st.count >= PROMOTION_THRESHOLD)
    .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);

  for (const [cmd] of promotedEntries) {
    pushUnique({
      id: `chip:promoted:${cmd}`,
      label: cmd.length > 16 ? `${cmd.slice(0, 15)}…` : cmd,
      command: cmd,
      kind: 'command',
      promoted: true,
      recent: true,
    });
  }

  // 3) Context-matched base chips
  const defaults: AssistantChip[] = [];
  if (page === 'review') {
    if (card?.isWrong) {
      defaults.push(
        { id: 'chip:plain-explain', label: lang === 'en' ? 'Plain explain' : '通俗讲解', command: '讲解新增通俗讲解', kind: 'command' },
        // #1439: the chip names no reason; the panel lists the six reasons for the learner to pick.
        { id: 'chip:mark-wrong', label: lang === 'en' ? 'Mark reason' : '标记错因', command: '标记错因', kind: 'command' },
        { id: 'chip:guided-retell', label: lang === 'en' ? 'Guided & Retell' : '带学复述', command: '进入带学', kind: 'guided' },
        { id: 'chip:stats', label: lang === 'en' ? 'Today stats' : '查看统计', command: '查看统计', kind: 'command' },
      );
    } else {
      defaults.push(
        { id: 'chip:guided-help', label: lang === 'en' ? 'Guided hint' : '苏格拉底带学', command: '进入带学', kind: 'guided' },
        { id: 'chip:plain-explain', label: lang === 'en' ? 'Plain explain' : '通俗讲解', command: '讲解新增通俗讲解', kind: 'command' },
        { id: 'chip:stats', label: lang === 'en' ? 'Today stats' : '查看统计', command: '查看统计', kind: 'command' },
        { id: 'chip:goto-source', label: lang === 'en' ? 'Open source' : '看资料原文', command: '跳到资料库', kind: 'command' },
      );
    }
  } else if (page === 'wrongbook') {
    defaults.push(
      { id: 'chip:export-wb', label: lang === 'en' ? 'Export mistakes' : '导出本课错题', command: '导出本课错题 Markdown', kind: 'command' },
      { id: 'chip:wb-stats', label: lang === 'en' ? 'View stats' : '查看统计', command: '查看统计', kind: 'command' },
      { id: 'chip:wb-review', label: lang === 'en' ? 'Go review' : '开始刷题', command: '跳到刷题', kind: 'command' },
      { id: 'chip:wb-guided', label: lang === 'en' ? 'Guided study' : '进入带学', command: '进入带学', kind: 'guided' },
    );
  } else if (page === 'sources') {
    defaults.push(
      { id: 'chip:src-gen', label: lang === 'en' ? 'Go generate' : '去创建题组', command: '跳到创建题组', kind: 'command' },
      { id: 'chip:src-stats', label: lang === 'en' ? 'View stats' : '查看统计', command: '查看统计', kind: 'command' },
      { id: 'chip:src-wb', label: lang === 'en' ? 'Mistakes' : '打开错题本', command: '打开错题本', kind: 'command' },
      { id: 'chip:src-guided', label: lang === 'en' ? 'Guided study' : '进入带学', command: '进入带学', kind: 'guided' },
    );
  } else {
    defaults.push(
      { id: 'chip:stats', label: lang === 'en' ? 'View stats' : '查看统计', command: '查看统计', kind: 'command' },
      { id: 'chip:wrongbook', label: lang === 'en' ? 'Mistakes' : '打开错题本', command: '打开错题本', kind: 'command' },
      { id: 'chip:sources', label: lang === 'en' ? 'Sources' : '打开资料库', command: '跳到资料库', kind: 'command' },
      { id: 'chip:guided', label: lang === 'en' ? 'Guided study' : '进入带学', command: '进入带学', kind: 'guided' },
    );
  }

  // Float recently used defaults to the top
  defaults.sort((a, b) => {
    const aTime = pageStats[normalizeCommandKey(a.command)]?.lastUsedAt ?? 0;
    const bTime = pageStats[normalizeCommandKey(b.command)]?.lastUsedAt ?? 0;
    return bTime - aTime;
  });

  for (const d of defaults) {
    const stat = pageStats[normalizeCommandKey(d.command)];
    pushUnique({ ...d, recent: Boolean(stat && stat.lastUsedAt > 0) });
  }

  return chips.slice(0, MAX_CHIPS_SHOWN);
}
