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

export interface AssistantChipCatalogEntry {
  id: string;
  labelZh: string;
  labelEn: string;
  command: string;
  kind: AssistantChip['kind'];
  pages: readonly PageId[] | 'default';
  wrongCardOnly?: boolean;
  normalCardOnly?: boolean;
}

/**
 * Single canonical registry of recommended assistant chips (#1354 D11 / [C24]).
 * Usage persistence stores ONLY these stable `id` values — never raw user-typed text.
 */
export const ASSISTANT_CHIP_CATALOG: readonly AssistantChipCatalogEntry[] = Object.freeze([
  // Review (wrong card)
  { id: 'chip:plain-explain', labelZh: '通俗讲解', labelEn: 'Plain explain', command: '讲解新增通俗讲解', kind: 'command', pages: ['review'] },
  // #1439: the chip names no reason; the panel lists the six reasons for the learner to pick.
  { id: 'chip:mark-wrong', labelZh: '标记错因', labelEn: 'Mark reason', command: '标记错因', kind: 'command', pages: ['review'], wrongCardOnly: true },
  { id: 'chip:guided-retell', labelZh: '带学复述', labelEn: 'Guided & Retell', command: '进入带学', kind: 'guided', pages: ['review'], wrongCardOnly: true },
  { id: 'chip:guided-help', labelZh: '苏格拉底带学', labelEn: 'Guided hint', command: '进入带学', kind: 'guided', pages: ['review'], normalCardOnly: true },
  { id: 'chip:stats', labelZh: '查看统计', labelEn: 'Today stats', command: '查看统计', kind: 'command', pages: ['review'] },
  { id: 'chip:goto-source', labelZh: '看资料原文', labelEn: 'Open source', command: '跳到资料库', kind: 'command', pages: ['review'], normalCardOnly: true },
  // Wrongbook
  { id: 'chip:export-wb', labelZh: '导出本课错题', labelEn: 'Export mistakes', command: '导出本课错题 Markdown', kind: 'command', pages: ['wrongbook'] },
  { id: 'chip:wb-stats', labelZh: '查看统计', labelEn: 'View stats', command: '查看统计', kind: 'command', pages: ['wrongbook'] },
  { id: 'chip:wb-review', labelZh: '开始刷题', labelEn: 'Go review', command: '跳到刷题', kind: 'command', pages: ['wrongbook'] },
  { id: 'chip:wb-guided', labelZh: '进入带学', labelEn: 'Guided study', command: '进入带学', kind: 'guided', pages: ['wrongbook'] },
  // Sources
  { id: 'chip:src-gen', labelZh: '去创建题组', labelEn: 'Go generate', command: '跳到创建题组', kind: 'command', pages: ['sources'] },
  { id: 'chip:src-stats', labelZh: '查看统计', labelEn: 'View stats', command: '查看统计', kind: 'command', pages: ['sources'] },
  { id: 'chip:src-wb', labelZh: '打开错题本', labelEn: 'Mistakes', command: '打开错题本', kind: 'command', pages: ['sources'] },
  { id: 'chip:src-guided', labelZh: '进入带学', labelEn: 'Guided study', command: '进入带学', kind: 'guided', pages: ['sources'] },
  // Default / other pages
  { id: 'chip:wrongbook', labelZh: '打开错题本', labelEn: 'Mistakes', command: '打开错题本', kind: 'command', pages: 'default' },
  { id: 'chip:sources', labelZh: '打开资料库', labelEn: 'Sources', command: '跳到资料库', kind: 'command', pages: 'default' },
  { id: 'chip:guided', labelZh: '进入带学', labelEn: 'Guided study', command: '进入带学', kind: 'guided', pages: 'default' },
]);

const CHIP_BY_ID = new Map<string, AssistantChipCatalogEntry>(
  ASSISTANT_CHIP_CATALOG.map((entry) => [entry.id, entry]),
);

export const KNOWN_ASSISTANT_CHIP_IDS: ReadonlySet<string> = new Set<string>(CHIP_BY_ID.keys());

export function isKnownAssistantChipId(value: string): boolean {
  return KNOWN_ASSISTANT_CHIP_IDS.has(value);
}

/** Normalize a user instruction key for frequency counting (trimmed, collapsed spaces, capped). */
export function normalizeCommandKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

/**
 * Resolve a recommended chip ID from either a chip ID or a matching chip command (#1354 D11).
 * Returns `null` for arbitrary free-text user input so raw user prose is never persisted to disk.
 */
export function resolveAssistantChipId(rawInput: string, page?: PageId): string | null {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) return null;
  if (KNOWN_ASSISTANT_CHIP_IDS.has(trimmed)) return trimmed;

  const normCmd = normalizeCommandKey(trimmed);
  if (!normCmd) return null;

  // Prefer entries scoped to the current page first.
  if (page) {
    for (const entry of ASSISTANT_CHIP_CATALOG) {
      if (Array.isArray(entry.pages) && entry.pages.includes(page) && normalizeCommandKey(entry.command) === normCmd) {
        return entry.id;
      }
    }
    for (const entry of ASSISTANT_CHIP_CATALOG) {
      if (entry.pages === 'default' && normalizeCommandKey(entry.command) === normCmd) {
        return entry.id;
      }
    }
  }

  for (const entry of ASSISTANT_CHIP_CATALOG) {
    if (normalizeCommandKey(entry.command) === normCmd) {
      return entry.id;
    }
  }
  return null;
}

/**
 * Filter a stats map down to ONLY registered chip IDs suitable for disk persistence (#1354 D11).
 * Any arbitrary user-typed free text is dropped completely.
 */
export function extractPersistableChipStats(
  statsByPage: Record<string, Record<string, AssistantCommandStat>> | undefined,
): Record<string, Record<string, AssistantCommandStat>> | undefined {
  if (!statsByPage || typeof statsByPage !== 'object' || Array.isArray(statsByPage)) {
    return undefined;
  }
  const out: Record<string, Record<string, AssistantCommandStat>> = {};
  let pageCount = 0;
  for (const [rawPage, rawMap] of Object.entries(statsByPage)) {
    if (pageCount >= 16) break;
    const pageKey = rawPage.trim().slice(0, 32);
    if (!pageKey || !rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) continue;
    const cleanMap: Record<string, AssistantCommandStat> = {};
    for (const [rawKey, rawStat] of Object.entries(rawMap)) {
      if (!rawStat || typeof rawStat !== 'object') continue;
      const chipId = resolveAssistantChipId(rawKey, pageKey as PageId);
      if (!chipId) continue;
      const count =
        typeof rawStat.count === 'number' && Number.isFinite(rawStat.count) && rawStat.count > 0
          ? Math.floor(rawStat.count)
          : 0;
      const lastUsedAt =
        typeof rawStat.lastUsedAt === 'number' && Number.isFinite(rawStat.lastUsedAt) && rawStat.lastUsedAt > 0
          ? Math.floor(rawStat.lastUsedAt)
          : 0;
      if (count <= 0) continue;
      const prev = cleanMap[chipId];
      cleanMap[chipId] = prev
        ? { count: prev.count + count, lastUsedAt: Math.max(prev.lastUsedAt, lastUsedAt) }
        : { count, lastUsedAt };
    }
    const entries = Object.entries(cleanMap)
      .sort(
        (a, b) =>
          Number(b[1].count >= PROMOTION_THRESHOLD) - Number(a[1].count >= PROMOTION_THRESHOLD) ||
          b[1].lastUsedAt - a[1].lastUsedAt,
      )
      .slice(0, 20);
    if (entries.length > 0) {
      out[pageKey] = Object.fromEntries(entries);
      pageCount += 1;
    }
  }
  return pageCount > 0 ? out : undefined;
}

function chipFromCatalog(entry: AssistantChipCatalogEntry, lang: UiLanguage, page?: PageId): AssistantChip {
  const labelEn = entry.id === 'chip:stats' && page && page !== 'review' ? 'View stats' : entry.labelEn;
  return {
    id: entry.id,
    label: lang === 'en' ? labelEn : entry.labelZh,
    command: entry.command,
    kind: entry.kind,
  };
}

function defaultChipsForContext(page: PageId, card: AssistantCardContext | null | undefined, lang: UiLanguage): AssistantChip[] {
  if (page === 'review') {
    const isWrong = Boolean(card?.isWrong);
    const ids = isWrong
      ? ['chip:plain-explain', 'chip:mark-wrong', 'chip:guided-retell', 'chip:stats']
      : ['chip:guided-help', 'chip:plain-explain', 'chip:stats', 'chip:goto-source'];
    return ids.map((id) => chipFromCatalog(CHIP_BY_ID.get(id)!, lang, page));
  }
  if (page === 'wrongbook') {
    return ['chip:export-wb', 'chip:wb-stats', 'chip:wb-review', 'chip:wb-guided'].map((id) =>
      chipFromCatalog(CHIP_BY_ID.get(id)!, lang, page),
    );
  }
  if (page === 'sources') {
    return ['chip:src-gen', 'chip:src-stats', 'chip:src-wb', 'chip:src-guided'].map((id) =>
      chipFromCatalog(CHIP_BY_ID.get(id)!, lang, page),
    );
  }
  return ['chip:stats', 'chip:wrongbook', 'chip:sources', 'chip:guided'].map((id) =>
    chipFromCatalog(CHIP_BY_ID.get(id)!, lang, page),
  );
}

function statForChip(pageStats: Record<string, AssistantCommandStat>, chip: AssistantChip): AssistantCommandStat | undefined {
  const byId = pageStats[chip.id];
  const byCmd = pageStats[normalizeCommandKey(chip.command)];
  if (byId && byCmd) {
    return {
      count: Math.max(byId.count, byCmd.count),
      lastUsedAt: Math.max(byId.lastUsedAt, byCmd.lastUsedAt),
    };
  }
  return byId ?? byCmd;
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

  for (const [statKey] of promotedEntries) {
    const catalogEntry = CHIP_BY_ID.get(statKey);
    if (catalogEntry) {
      const chip = chipFromCatalog(catalogEntry, lang, page);
      pushUnique({
        ...chip,
        promoted: true,
        recent: true,
      });
    } else {
      pushUnique({
        id: `chip:promoted:${statKey}`,
        label: statKey.length > 16 ? `${statKey.slice(0, 15)}…` : statKey,
        command: statKey,
        kind: 'command',
        promoted: true,
        recent: true,
      });
    }
  }

  // 3) Context-matched base chips
  const defaults = defaultChipsForContext(page, card, lang);

  // Float recently used defaults to the top
  defaults.sort((a, b) => {
    const aTime = statForChip(pageStats, a)?.lastUsedAt ?? 0;
    const bTime = statForChip(pageStats, b)?.lastUsedAt ?? 0;
    return bTime - aTime;
  });

  for (const d of defaults) {
    const stat = statForChip(pageStats, d);
    pushUnique({ ...d, recent: Boolean(stat && stat.lastUsedAt > 0) });
  }

  return chips.slice(0, MAX_CHIPS_SHOWN);
}
