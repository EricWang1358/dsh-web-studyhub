import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { Modal } from '../../components/Modal.js';
import { clampModalFrame } from '../../components/layout-tokens.js';
import { sideNavWidth } from '../../shell/SideNav.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useTheme, type Tone } from '../../theme/tokens.js';
import { useShellActions } from '../../shell/actions.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { DocumentGroup } from './source-helpers.js';

export interface SourceCoverageModalProps {
  host: HostClient;
  item: DocumentGroup;
  defaultCourse?: string | null;
  isActive: boolean;
  onGenerate: (sourceIds: string[], course?: string) => void;
  onClose: () => void;
}

type CoverageModalTab = 'coverage' | 'linked';
type ReviewLevel = 'new' | 'weak' | 'learning' | 'familiar' | 'mastered';

interface CoverageSection {
  id: string;
  key: string;
  sourceId: string;
  kind?: string;
  title?: string;
  state: 'covered' | 'planned-failed' | 'never-planned' | string;
  cards?: number;
  reason?: string;
  page?: number;
}

interface CoverageReport {
  sections?: CoverageSection[];
  covered?: number;
  plannedFailed?: number;
  neverPlanned?: number;
  leaves?: number;
  percentLeaves?: number;
  percentChars?: number;
  cards?: number;
  units?: string;
}

interface CoverageGetResponse {
  status?: string;
  scope?: string;
  coverage?: CoverageReport;
}

interface CoverageTargetDeck {
  id: string;
  title?: string;
  course?: string;
  cards?: number;
  directCitedCards?: number;
  cardIndex?: { total?: number };
}

interface SourceCoverageResponse {
  directReferences?: {
    numerator?: number;
    denominator?: number;
    unit?: string;
  };
  targets?: {
    active?: CoverageTargetDeck[];
    archived?: CoverageTargetDeck[];
    drafts?: CoverageTargetDeck[];
  };
}

type LinkedTargetKind = 'active' | 'draft' | 'archived';

interface LinkedTargetItem {
  id: string;
  kind: LinkedTargetKind;
  title: string;
  course: string;
  directCitedCards: number;
  totalCards: number;
}

type CoverageRow =
  | { kind: 'section'; key: string; section: CoverageSection; index: number }
  | { kind: 'header'; key: string; label: string }
  | { kind: 'target'; key: string; target: LinkedTargetItem };

interface PagesCardLink {
  sourceId: string;
  start?: number | null;
  end?: number | null;
  selection?: {
    sourceId?: string;
    page?: number;
    quote?: string;
    stale?: boolean;
  };
}

interface PagesCardEntry {
  deckId: string;
  deckTitle?: string;
  course?: string;
  cardId: string;
  kind?: string;
  sourceQa?: boolean;
  prompt?: string;
  level?: ReviewLevel | string;
  due?: boolean;
  inactive?: boolean;
  otherVersion?: boolean;
  otherMaterial?: string;
  links?: PagesCardLink[];
}

interface PagesCardsSummary {
  total: number;
  counts?: {
    new?: number;
    weak?: number;
    learning?: number;
    familiar?: number;
    mastered?: number;
  };
  due?: number;
  weak?: number;
  fresh?: number;
  inactive?: number;
  percent?: number | null;
  state?: 'none' | 'unlearned' | 'learning' | 'familiar' | 'mastered' | string;
}

interface PagesCardsResponse {
  status?: string;
  documentId?: string;
  key?: string;
  sourceIds?: string[];
  cards?: PagesCardEntry[];
  summary?: PagesCardsSummary;
  inactiveCourses?: string[];
  olderCards?: number;
  sameRecordingCards?: number;
  partCards?: number;
  draftCards?: number;
}

interface MaterialLinkEntry {
  deckId?: string;
  deckTitle?: string;
  cardId?: string;
  prompt?: string;
  selection?: {
    documentId?: string;
    sourceId?: string;
    page?: number;
    start?: number;
    end?: number;
    quote?: string;
    stale?: boolean;
  };
  status?: string;
  stale?: boolean;
}

interface MaterialLinksListResponse {
  links?: MaterialLinkEntry[];
  total?: number;
  status?: string;
}

interface LinkedCardRow {
  key: string;
  deckId: string;
  cardId: string;
  deckTitle: string;
  course: string;
  prompt: string;
  level: ReviewLevel;
  due: boolean;
  inactive: boolean;
  page?: number;
  quote: string;
  stale: boolean;
  otherOrigin?: string;
}

const PRACTICE_SCOPE_LIMIT = 200;

const LEVEL_RANK: Record<ReviewLevel, number> = {
  weak: 0,
  new: 2,
  learning: 3,
  familiar: 4,
  mastered: 5,
};

function normalizeLevel(raw: unknown): ReviewLevel {
  const s = String(raw || 'new');
  if (s === 'weak' || s === 'learning' || s === 'familiar' || s === 'mastered') return s;
  return 'new';
}

function levelBadgeTone(level: ReviewLevel): Tone {
  switch (level) {
    case 'mastered':
      return 'success';
    case 'familiar':
      return 'primary';
    case 'learning':
      return 'info';
    case 'weak':
      return 'error';
    default:
      return 'muted';
  }
}

function levelBadgeLabel(level: ReviewLevel, lang: 'zh' | 'en'): string {
  switch (level) {
    case 'mastered':
      return t(lang, '掌握', 'mastered');
    case 'familiar':
      return t(lang, '熟悉', 'familiar');
    case 'learning':
      return t(lang, '学习', 'learning');
    case 'weak':
      return t(lang, '薄弱', 'weak');
    default:
      return t(lang, '新题', 'new');
  }
}

function masteryStateInfo(state: string | undefined, lang: 'zh' | 'en'): { label: string; tone: Tone } {
  switch (state) {
    case 'mastered':
      return { label: t(lang, '已掌握', 'Mastered'), tone: 'success' };
    case 'familiar':
      return { label: t(lang, '熟悉', 'Familiar'), tone: 'primary' };
    case 'learning':
      return { label: t(lang, '学习中', 'Learning'), tone: 'info' };
    case 'unlearned':
      return { label: t(lang, '未学', 'Unlearned'), tone: 'muted' };
    default:
      return { label: t(lang, '未出题', 'No cards'), tone: 'neutral' };
  }
}

function cardPriorityRank(card: LinkedCardRow): number {
  if (card.level === 'weak') return 0;
  if (card.due) return 1;
  return LEVEL_RANK[card.level] ?? 3;
}

export const SourceCoverageModal = memo(function SourceCoverageModal({
  host,
  item,
  defaultCourse,
  isActive,
  onGenerate,
  onClose,
}: SourceCoverageModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const sidebarCollapsed = useTuiStore((s) => Boolean(s.preferences.sidebarCollapsed));
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const setActiveRunId = useTuiStore((s) => s.setActiveRunId);
  const { refresh: refreshSnapshot } = useShellActions();
  const { columns, rows: termRows } = useWindowSize();

  const [activeTab, setActiveTab] = useState<CoverageModalTab>('coverage');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docCoverage, setDocCoverage] = useState<CoverageReport | null>(null);
  const [srcCoverage, setSrcCoverage] = useState<SourceCoverageResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);

  const [linkedLoading, setLinkedLoading] = useState(false);
  const [linkedError, setLinkedError] = useState<string | null>(null);
  const [pagesCardsData, setPagesCardsData] = useState<PagesCardsResponse | null>(null);
  const [linksListData, setLinksListData] = useState<MaterialLinksListResponse | null>(null);
  const [linkedSelectedIndex, setLinkedSelectedIndex] = useState(0);
  const [linkedReloadSeq, setLinkedReloadSeq] = useState(0);
  const [starting, setStarting] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const covReqSeqRef = useRef(0);
  const linkedReqSeqRef = useRef(0);
  const linkedDirtyRef = useRef(true);
  const linkedLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    linkedDirtyRef.current = true;
    linkedLoadedRef.current = false;
  }, [item.key]);

  useEffect(() => {
    if (!isActive) {
      linkedDirtyRef.current = true;
      linkedLoadedRef.current = false;
      return;
    }
    let cancelled = false;
    const seq = ++covReqSeqRef.current;
    setLoading(true);
    setError(null);

    const covGetArgs: Record<string, unknown> = {
      ...(item.documentId ? { documentId: item.documentId } : {}),
      ...(item.sourceIds[0] ? { sourceId: item.sourceIds[0] } : {}),
    };

    void Promise.allSettled([
      tryAction<CoverageGetResponse>(host, 'coverage.get', covGetArgs),
      tryAction<SourceCoverageResponse>(host, 'source.coverage', { sourceIds: item.sourceIds }),
    ]).then(([covRes, srcRes]) => {
      if (cancelled || !mountedRef.current || covReqSeqRef.current !== seq) return;
      setLoading(false);

      const covOk =
        covRes.status === 'fulfilled' &&
        covRes.value.ok &&
        covRes.value.value?.status === 'ok' &&
        covRes.value.value.coverage;
      const srcOk = srcRes.status === 'fulfilled' && srcRes.value.ok && srcRes.value.value;

      setDocCoverage(covOk ? (covRes.value.value?.coverage ?? null) : null);
      setSrcCoverage(srcOk ? (srcRes.value.value ?? null) : null);

      if (!covOk && !srcOk) {
        const covErr = covRes.status === 'fulfilled' ? covRes.value.error?.message : undefined;
        const srcErr = srcRes.status === 'fulfilled' ? srcRes.value.error?.message : undefined;
        setError(covErr || srcErr || t(lang, '获取覆盖率数据失败', 'Failed to load coverage data'));
      }
      setSelectedIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [host, isActive, item.documentId, item.sourceIds, lang, reloadSeq]);

  useEffect(() => {
    if (!isActive || activeTab !== 'linked') return;
    if (!linkedDirtyRef.current && linkedLoadedRef.current) return;

    let cancelled = false;
    const seq = ++linkedReqSeqRef.current;
    linkedDirtyRef.current = false;
    linkedLoadedRef.current = true;
    setLinkedLoading(true);
    setLinkedError(null);

    const pagesArgs: Record<string, unknown> = {
      ...(item.documentId ? { documentId: item.documentId } : {}),
      ...(item.sourceIds[0] ? { sourceId: item.sourceIds[0] } : {}),
    };
    const linksArgs: Record<string, unknown> = item.documentId
      ? { documentId: item.documentId }
      : item.sourceIds[0]
        ? { sourceId: item.sourceIds[0] }
        : {};

    void Promise.allSettled([
      tryAction<PagesCardsResponse>(host, 'materials.pages.cards', pagesArgs),
      tryAction<MaterialLinksListResponse>(host, 'materials.links.list', linksArgs),
    ]).then(([pagesRes, linksRes]) => {
      if (cancelled || !mountedRef.current || linkedReqSeqRef.current !== seq) return;
      setLinkedLoading(false);

      const pagesOk =
        pagesRes.status === 'fulfilled' &&
        pagesRes.value.ok &&
        pagesRes.value.value &&
        pagesRes.value.value.status !== 'unavailable';
      const linksOk =
        linksRes.status === 'fulfilled' &&
        linksRes.value.ok &&
        linksRes.value.value &&
        linksRes.value.value.status !== 'unavailable';

      setPagesCardsData(pagesOk ? (pagesRes.value.value ?? null) : null);
      setLinksListData(linksOk ? (linksRes.value.value ?? null) : null);

      if (!pagesOk && !linksOk) {
        const pErr = pagesRes.status === 'fulfilled' ? pagesRes.value.error?.message : undefined;
        setLinkedError(pErr || t(lang, '获取关联题卡失败', 'Failed to load linked cards'));
      }
      setLinkedSelectedIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [activeTab, host, isActive, item.documentId, item.sourceIds, lang, linkedReloadSeq]);

  const sections = useMemo(
    () => (Array.isArray(docCoverage?.sections) ? docCoverage.sections : []),
    [docCoverage],
  );

  const linkedTargets = useMemo<LinkedTargetItem[]>(() => {
    const tData = srcCoverage?.targets;
    if (!tData) return [];
    const out: LinkedTargetItem[] = [];
    const pushList = (list: CoverageTargetDeck[] | undefined, kind: LinkedTargetKind) => {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        if (!entry || typeof entry.id !== 'string') continue;
        const directCited = Number(entry.directCitedCards ?? 0);
        const totalCited = Number(entry.cardIndex?.total ?? 0);
        if (directCited <= 0 && totalCited <= 0) continue;
        out.push({
          id: entry.id,
          kind,
          title: entry.title || entry.id,
          course: entry.course || '',
          directCitedCards: directCited || totalCited,
          totalCards: Number(entry.cards ?? 0),
        });
      }
    };
    pushList(tData.active, 'active');
    pushList(tData.drafts, 'draft');
    pushList(tData.archived, 'archived');
    return out;
  }, [srcCoverage]);

  const rows = useMemo<CoverageRow[]>(() => {
    const out: CoverageRow[] = sections.map((section, idx) => ({
      kind: 'section',
      key: `sec:${section.key || section.id || idx}`,
      section,
      index: idx,
    }));
    if (linkedTargets.length > 0) {
      const dash = asciiMode ? '--' : '──';
      out.push({
        kind: 'header',
        key: 'hdr:targets',
        label: `${dash} ${t(lang, `关联题组与草稿 (${linkedTargets.length})`, `Linked Decks & Drafts (${linkedTargets.length})`)} ${dash}`,
      });
      for (const target of linkedTargets) {
        out.push({
          kind: 'target',
          key: `tgt:${target.kind}:${target.id}`,
          target,
        });
      }
    }
    return out;
  }, [asciiMode, lang, linkedTargets, sections]);

  const sourcePageMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of item.pages ?? []) {
      if (p.sourceId && Number.isFinite(p.page)) {
        map.set(p.sourceId, p.page);
      }
    }
    return map;
  }, [item.pages]);

  const linkedCardRows = useMemo<LinkedCardRow[]>(() => {
    const linksByCard = new Map<string, MaterialLinkEntry[]>();
    for (const entry of linksListData?.links ?? []) {
      if (!entry?.deckId || !entry?.cardId) continue;
      const k = `${entry.deckId}\0${entry.cardId}`;
      const list = linksByCard.get(k);
      if (list) list.push(entry);
      else linksByCard.set(k, [entry]);
    }

    const pagesCards = pagesCardsData?.cards;
    if (Array.isArray(pagesCards)) {
      return pagesCards
        .filter((c) => c && c.deckId && c.cardId)
        .map((c, idx) => {
          const k = `${c.deckId}\0${c.cardId}`;
          const extraLinks = linksByCard.get(k) ?? [];
          const firstLink = Array.isArray(c.links) ? c.links[0] : undefined;
          const firstExtra = extraLinks[0];
          const linkSourceId = firstLink?.sourceId || firstExtra?.selection?.sourceId;
          const page =
            firstLink?.selection?.page ??
            firstExtra?.selection?.page ??
            (linkSourceId ? sourcePageMap.get(linkSourceId) : undefined);
          const quote = (firstLink?.selection?.quote || firstExtra?.selection?.quote || '')
            .replace(/\s+/g, ' ')
            .trim();
          const stale = Boolean(
            firstLink?.selection?.stale ||
              extraLinks.some((l) => l.stale || l.status === 'stale' || l.selection?.stale),
          );
          const otherOrigin = c.otherVersion
            ? t(lang, '旧版', 'old-ver')
            : c.otherMaterial === 'same'
              ? t(lang, '同录', 'same-rec')
              : c.otherMaterial === 'part'
                ? t(lang, '分录', 'part')
                : undefined;

          return {
            key: `lc:${c.deckId}:${c.cardId}:${idx}`,
            deckId: c.deckId,
            cardId: c.cardId,
            deckTitle: c.deckTitle || '',
            course: c.course || '',
            prompt: String(c.prompt || firstExtra?.prompt || c.cardId).replace(/\s+/g, ' ').trim(),
            level: normalizeLevel(c.level),
            due: Boolean(c.due),
            inactive: Boolean(c.inactive),
            page,
            quote,
            stale,
            otherOrigin,
          };
        });
    }

    // Fail-soft fallback if pages.cards is unavailable but links.list returned links.
    if (linksByCard.size === 0) return [];
    const fallback: LinkedCardRow[] = [];
    for (const [k, entries] of linksByCard.entries()) {
      const first = entries[0];
      if (!first?.deckId || !first?.cardId) continue;
      const srcId = first.selection?.sourceId;
      fallback.push({
        key: `lc:${k}`,
        deckId: first.deckId,
        cardId: first.cardId,
        deckTitle: first.deckTitle || '',
        course: item.courses[0] || '',
        prompt: String(first.prompt || first.cardId).replace(/\s+/g, ' ').trim(),
        level: 'new',
        due: false,
        inactive: false,
        page: first.selection?.page ?? (srcId ? sourcePageMap.get(srcId) : undefined),
        quote: String(first.selection?.quote || '').replace(/\s+/g, ' ').trim(),
        stale: entries.some((l) => Boolean(l.stale || l.status === 'stale' || l.selection?.stale)),
      });
    }
    return fallback;
  }, [item.courses, lang, linksListData?.links, pagesCardsData?.cards, sourcePageMap]);

  useEffect(() => {
    if (selectedIndex >= rows.length) {
      setSelectedIndex(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIndex]);

  useEffect(() => {
    if (linkedSelectedIndex >= linkedCardRows.length) {
      setLinkedSelectedIndex(Math.max(0, linkedCardRows.length - 1));
    }
  }, [linkedCardRows.length, linkedSelectedIndex]);

  const uncoveredSourceIds = useMemo(() => {
    const valid = new Set(item.sourceIds);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of sections) {
      if (s.state !== 'covered' && valid.has(s.sourceId) && !seen.has(s.sourceId)) {
        seen.add(s.sourceId);
        out.push(s.sourceId);
      }
    }
    return out.length > 0 ? out : [...item.sourceIds];
  }, [item.sourceIds, sections]);

  const triggerGenerate = useCallback(() => {
    const course = item.courses[0] || defaultCourse || undefined;
    onClose();
    onGenerate(uncoveredSourceIds, course);
  }, [defaultCourse, item.courses, onClose, onGenerate, uncoveredSourceIds]);

  const launchPractice = useCallback(
    async (cardsToPractice: LinkedCardRow[]) => {
      if (busyRef.current) return;
      if (cardsToPractice.length === 0) {
        notify(t(lang, '当前资料暂无可练习的关联题卡', 'No linked cards available to practise'), 'info');
        return;
      }

      const unique = new Map<string, { deckId: string; cardId: string; rank: number; inactive: boolean; order: number }>();
      for (let i = 0; i < cardsToPractice.length; i += 1) {
        const c = cardsToPractice[i];
        if (!c?.deckId || !c?.cardId) continue;
        const k = `${c.deckId}\0${c.cardId}`;
        if (!unique.has(k)) {
          unique.set(k, {
            deckId: c.deckId,
            cardId: c.cardId,
            rank: cardPriorityRank(c),
            inactive: c.inactive,
            order: i,
          });
        }
      }

      const sorted = [...unique.values()]
        .sort((a, b) => a.rank - b.rank || Number(a.inactive) - Number(b.inactive) || a.order - b.order)
        .slice(0, PRACTICE_SCOPE_LIMIT);
      const scope = sorted.map(({ deckId, cardId }) => ({ deckId, cardId }));
      if (scope.length === 0) {
        notify(t(lang, '当前资料暂无可练习的关联题卡', 'No linked cards available to practise'), 'info');
        return;
      }

      busyRef.current = true;
      setStarting(true);
      try {
        const res = await tryAction<{ id?: string }>(host, 'review.start', {
          mode: 'path',
          scope,
          fresh: true,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value?.id) {
          notify(res.error?.message || t(lang, '启动关联练习失败', 'Failed to start linked practice'), 'error');
          return;
        }
        const runId = res.value.id;
        await refreshSnapshot();
        if (!mountedRef.current) return;
        setActiveRunId(runId);
        const launchCourse = cardsToPractice[0]?.course || item.courses[0] || defaultCourse || undefined;
        onClose();
        navigate('review', {
          runId,
          ...(launchCourse ? { course: launchCourse } : {}),
        });
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setStarting(false);
      }
    },
    [defaultCourse, host, item.courses, lang, navigate, notify, onClose, refreshSnapshot, setActiveRunId],
  );

  const switchTab = useCallback((next: CoverageModalTab) => {
    setActiveTab(next);
  }, []);

  useInput(
    (input, key) => {
      if (!isActive || busyRef.current || starting) return;
      if (key.tab) {
        switchTab(activeTab === 'coverage' ? 'linked' : 'coverage');
        return;
      }
      if (input === '1') {
        if (activeTab !== 'coverage') switchTab('coverage');
        return;
      }
      if (input === '2') {
        if (activeTab !== 'linked') switchTab('linked');
        return;
      }

      if (activeTab === 'coverage') {
        if (loading) return;
        if (input === 'g') {
          triggerGenerate();
        } else if (input === 'r') {
          setReloadSeq((n) => n + 1);
        }
        return;
      }

      // Tab 2: Linked Cards
      if (linkedLoading) return;
      if (input === 'p') {
        void launchPractice(linkedCardRows);
      } else if (input === 'g') {
        triggerGenerate();
      } else if (input === 'r') {
        linkedDirtyRef.current = true;
        setLinkedReloadSeq((n) => n + 1);
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (activeTab === 'coverage') {
      if (loading) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
      return [
        { key: '1/2', label: t(lang, '切页', 'Tab') },
        { key: 'g', label: t(lang, '为未覆盖出题', 'Generate') },
        { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    if (linkedLoading) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    const out: KeyHint[] = [{ key: '1/2', label: t(lang, '切页', 'Tab') }];
    if (linkedCardRows.length > 0) {
      out.push({ key: 'p', label: t(lang, '全练', 'All') });
      out.push({ key: 'Enter', label: t(lang, '练习', 'Run') });
      out.push({ key: 'j/k', label: t(lang, '滚动', 'Nav') });
    } else {
      out.push({ key: 'g', label: t(lang, '出题', 'Gen') });
    }
    out.push({ key: 'r', label: t(lang, '刷新', 'Reload') });
    out.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return out;
  }, [activeTab, lang, linkedCardRows.length, linkedLoading, loading]);

  const approxNavW = sideNavWidth(columns, sidebarCollapsed);
  const maxContentW = Math.max(48, columns - approxNavW - 2);
  const { frameWidth, frameHeight, innerWidth, innerHeight } = clampModalFrame(columns, termRows, {
    maxWidth: Math.min(88, maxContentW - 2),
    minWidth: 48,
    maxHeight: 30,
    minHeight: 15,
    headerFooterRows: 5,
  });
  const bodyHeight = Math.max(6, innerHeight - 1);

  const ell = asciiMode ? '...' : '…';
  const errMark = asciiMode ? 'x' : '✕';
  const sep = asciiMode ? ' | ' : ' · ';

  const covered = docCoverage?.covered ?? 0;
  const plannedFailed = docCoverage?.plannedFailed ?? 0;
  const neverPlanned = docCoverage?.neverPlanned ?? 0;
  const leaves = docCoverage?.leaves ?? sections.length;
  const uncoveredCount = plannedFailed + neverPlanned;
  const percentLeaves = docCoverage?.percentLeaves ?? (leaves > 0 ? Math.round((covered / leaves) * 100) : 0);
  const percentChars = docCoverage?.percentChars ?? 0;

  const directNum = srcCoverage?.directReferences?.numerator ?? 0;
  const directDenom = srcCoverage?.directReferences?.denominator ?? item.sourceIds.length;
  const progressRatio = leaves > 0 ? covered / leaves : directDenom > 0 ? directNum / directDenom : 0;

  const covSummaryRows = 3;
  const covListHeight = Math.max(3, bodyHeight - covSummaryRows);

  const linkedSummary = pagesCardsData?.summary;
  const linkedTotal = linkedSummary?.total ?? linkedCardRows.length;
  const linkedPercent = linkedSummary?.percent ?? 0;
  const linkedDue = linkedSummary?.due ?? linkedCardRows.filter((c) => c.due).length;
  const linkedWeak = linkedSummary?.weak ?? linkedCardRows.filter((c) => c.level === 'weak').length;
  const linkedFresh = linkedSummary?.fresh ?? linkedCardRows.filter((c) => c.level === 'new').length;
  const linkedMastered = linkedSummary?.counts?.mastered ?? linkedCardRows.filter((c) => c.level === 'mastered').length;
  const linkedDraftCards = pagesCardsData?.draftCards ?? 0;
  const docState = masteryStateInfo(linkedSummary?.state ?? (linkedTotal > 0 ? 'learning' : 'none'), lang);

  const linkedSummaryRows = 2;
  const linkedListHeight = Math.max(3, bodyHeight - linkedSummaryRows);

  const renderLinkedCardRow = useCallback(
    (row: LinkedCardRow, ctx: VirtualListRenderContext) => {
      const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
      const stateLabel = levelBadgeLabel(row.level, lang);
      const stateTone = levelBadgeTone(row.level);
      const dueStr = row.due ? t(lang, ' [到期]', ' [due]') : '';

      const citeParts: string[] = [];
      if (row.page !== undefined) {
        citeParts.push(`p.${row.page}`);
      }
      if (row.stale) {
        citeParts.push(t(lang, '失效', 'stale'));
      } else if (row.otherOrigin) {
        citeParts.push(row.otherOrigin);
      }
      if (row.quote && ctx.width >= 58) {
        const maxQuoteW = Math.min(20, Math.max(8, Math.floor(ctx.width * 0.24)));
        citeParts.push(`"${truncateDisplay(row.quote, maxQuoteW, ell)}"`);
      }
      const citeStr = citeParts.length > 0 ? ` ${citeParts.join(asciiMode ? ' ' : ' · ')}` : '';

      const badgeW = displayWidth(stateLabel) + 2;
      const dueW = displayWidth(dueStr);
      const citeW = displayWidth(citeStr);
      const maxPromptW = Math.max(8, ctx.width - displayWidth(cursor) - badgeW - 1 - dueW - citeW - 1);
      const promptText = padDisplay(truncateDisplay(row.prompt, maxPromptW, ell), maxPromptW);

      return (
        <Box flexDirection="row" width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
            {cursor}
          </Text>
          <Badge label={stateLabel} tone={stateTone} variant="outline" />
          <Text> </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {promptText}
          </Text>
          {dueStr ? (
            <Text color={ctx.selected ? theme.selectionFg : theme.warning} bold>
              {dueStr}
            </Text>
          ) : null}
          {citeStr ? (
            <Text color={ctx.selected ? theme.selectionFg : row.stale ? theme.error : theme.dim}>
              {citeStr}
            </Text>
          ) : null}
        </Box>
      );
    },
    [asciiMode, ell, lang, theme],
  );

  const linkedBreakdown = useMemo(() => {
    const parts: string[] = [`${linkedTotal}${t(lang, '题', 'c')}`];
    if (linkedDue > 0) parts.push(t(lang, `到期 ${linkedDue}`, `due ${linkedDue}`));
    if (linkedWeak > 0) parts.push(t(lang, `薄弱 ${linkedWeak}`, `weak ${linkedWeak}`));
    if (linkedFresh > 0) parts.push(t(lang, `新题 ${linkedFresh}`, `new ${linkedFresh}`));
    if (linkedMastered > 0) parts.push(t(lang, `掌握 ${linkedMastered}`, `mast ${linkedMastered}`));
    if (linkedDraftCards > 0) parts.push(t(lang, `草稿 ${linkedDraftCards}`, `draft ${linkedDraftCards}`));
    return parts.join(sep);
  }, [lang, linkedDraftCards, linkedDue, linkedFresh, linkedMastered, linkedTotal, linkedWeak, sep]);

  return (
    <Modal
      title={t(lang, '资料引用与章节覆盖率', 'Source Coverage')}
      subtitle={item.title}
      icon={asciiMode ? '%' : '◔'}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive && !starting}
      onClose={onClose}
      hints={hints}
    >
      <Box flexDirection="column" height={innerHeight} width={innerWidth}>
        {/* Tab Bar */}
        <Box flexDirection="row" height={1} width={innerWidth} flexShrink={0} overflow="hidden">
          <Badge
            label={`1:${t(lang, '章节覆盖', 'Coverage')}`}
            tone={activeTab === 'coverage' ? 'primary' : 'neutral'}
            variant={activeTab === 'coverage' ? 'solid' : 'outline'}
          />
          <Text> </Text>
          <Badge
            label={`2:${t(lang, '关联题卡', 'Linked Cards')}`}
            tone={activeTab === 'linked' ? 'primary' : 'neutral'}
            variant={activeTab === 'linked' ? 'solid' : 'outline'}
          />
          <Box flexGrow={1} />
          {innerWidth >= 54 ? <Text color={theme.dim}>1-2 / Tab</Text> : null}
        </Box>

        {activeTab === 'coverage' ? (
          loading ? (
            <Box height={bodyHeight} width={innerWidth} alignItems="center" justifyContent="center">
              <Spinner
                label={t(lang, `正在统计章节与引用覆盖率${ell}`, `Loading citation & section coverage${ell}`)}
                active={isActive}
              />
            </Box>
          ) : error ? (
            <Box height={bodyHeight} width={innerWidth} flexDirection="column" justifyContent="center" alignItems="center">
              <Text color={theme.error} bold>
                {`${errMark} ${error}`}
              </Text>
              <Box marginTop={1}>
                <Text color={theme.muted}>
                  {t(lang, '按 [r] 重试，或按 [g] 直接为该资料出题', 'Press [r] to retry, or [g] to generate questions')}
                </Text>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" height={bodyHeight} width={innerWidth}>
              {/* Progress Bar */}
              <Box height={1} width={innerWidth} flexShrink={0}>
                <ProgressBar
                  ratio={progressRatio}
                  width={innerWidth}
                  style="block"
                  showPercent
                  label={leaves > 0 ? t(lang, '章节覆盖', 'Sections') : t(lang, '直接引用', 'Citations')}
                />
              </Box>

              {/* Coverage Stats Row */}
              <Box height={1} width={innerWidth} flexDirection="row" alignItems="center" flexShrink={0} overflow="hidden">
                {docCoverage ? (
                  <Text wrap="truncate-end">
                    <Text color={theme.success}>{`${t(lang, '已覆盖', 'Covered')} ${covered}/${leaves}`}</Text>
                    <Text color={theme.dim}>{sep}</Text>
                    <Text color={uncoveredCount > 0 ? theme.warning : theme.muted}>
                      {`${t(lang, '未覆盖', 'Uncovered')} ${uncoveredCount}`}
                    </Text>
                    {plannedFailed > 0 ? (
                      <Text color={theme.error}>{` (${t(lang, '失败', 'failed')} ${plannedFailed})`}</Text>
                    ) : null}
                    <Text color={theme.dim}>{sep}</Text>
                    <Text color={theme.muted}>{`${t(lang, '章节', 'Sec')} ${percentLeaves}%`}</Text>
                    <Text color={theme.dim}>{sep}</Text>
                    <Text color={theme.muted}>{`${t(lang, '字数', 'Chars')} ${percentChars}%`}</Text>
                    {srcCoverage?.directReferences ? (
                      <>
                        <Text color={theme.dim}>{sep}</Text>
                        <Text color={theme.dim}>{`${t(lang, '引用源', 'Refs')} ${directNum}/${directDenom}`}</Text>
                      </>
                    ) : null}
                  </Text>
                ) : (
                  <Text color={theme.muted} wrap="truncate-end">
                    {t(
                      lang,
                      `直接引用来源: ${directNum}/${directDenom}${sep}关联题组/草稿: ${linkedTargets.length}`,
                      `Direct cited sources: ${directNum}/${directDenom}${sep}Linked decks/drafts: ${linkedTargets.length}`,
                    )}
                  </Text>
                )}
              </Box>

              {/* List Header / Quick Action Hint */}
              <Box height={1} width={innerWidth} flexDirection="row" alignItems="center" flexShrink={0} overflow="hidden">
                <Badge
                  label={`${t(lang, '章节', 'Sections')} ${sections.length}`}
                  tone="info"
                  variant="soft"
                />
                <Text> </Text>
                <Badge
                  label={`${t(lang, '题组/草稿', 'Decks/Drafts')} ${linkedTargets.length}`}
                  tone="accent"
                  variant="soft"
                />
                <Box flexGrow={1} />
                <Text color={theme.dim} wrap="truncate-end">
                  {t(lang, '[g] 为未覆盖出题', '[g] Generate uncovered')}
                </Text>
              </Box>

              {rows.length === 0 ? (
                <EmptyState
                  title={t(lang, '暂无章节或引用记录', 'No sections or citations yet')}
                  hint={t(lang, '按 [g] 立即基于该资料生成题目', 'Press [g] to generate questions from this source')}
                  width={innerWidth}
                  height={covListHeight}
                />
              ) : (
                <VirtualList
                  items={rows}
                  height={covListHeight}
                  width={innerWidth}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  isActive={isActive}
                  ascii={asciiMode}
                  keyExtractor={(row) => row.key}
                  renderItem={(row, ctx) => {
                    if (row.kind === 'header') {
                      return (
                        <Box flexDirection="row" width={ctx.width}>
                          <Text color={theme.accent} bold>
                            {truncateDisplay(row.label, ctx.width, ell)}
                          </Text>
                        </Box>
                      );
                    }

                    const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                    if (row.kind === 'section') {
                      const s = row.section;
                      const isCov = s.state === 'covered';
                      const isFail = s.state === 'planned-failed';
                      const mark = isCov
                        ? asciiMode ? '[+] ' : '[✓] '
                        : isFail
                          ? '[!] '
                          : asciiMode ? '[ ] ' : '[○] ';
                      const markColor = isCov ? theme.success : isFail ? theme.warning : theme.dim;
                      const meta = isCov
                        ? `${s.cards ?? 0}${t(lang, '题', 'c')}`
                        : isFail
                          ? `${t(lang, '失败', 'fail')}${s.reason ? `:${s.reason}` : ''}`
                          : t(lang, '未覆盖', 'uncovered');
                      const fallbackName = s.page
                        ? t(lang, `第 ${s.page} 页`, `Page ${s.page}`)
                        : t(lang, `章节 ${row.index + 1}`, `Section ${row.index + 1}`);
                      const label = (s.title || '').trim() || fallbackName;
                      const metaStr = truncateDisplay(meta, Math.max(6, Math.floor(ctx.width * 0.32)), ell);
                      const maxTitle = Math.max(8, ctx.width - displayWidth(cursor) - displayWidth(mark) - displayWidth(metaStr) - 2);
                      return (
                        <Box flexDirection="row" width={ctx.width}>
                          <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                          <Text color={markColor} bold={isCov || isFail}>
                            {mark}
                          </Text>
                          <Text color={theme.text} bold={ctx.selected}>
                            {truncateDisplay(label, maxTitle, ell)}
                          </Text>
                          <Box flexGrow={1} />
                          <Text color={isCov ? theme.success : isFail ? theme.warning : theme.dim}>{metaStr}</Text>
                        </Box>
                      );
                    }

                    const tgt = row.target;
                    const tag =
                      tgt.kind === 'draft'
                        ? t(lang, '[草稿] ', '[Draft] ')
                        : tgt.kind === 'archived'
                          ? t(lang, '[归档] ', '[Arch] ')
                          : t(lang, '[题组] ', '[Deck] ');
                    const tagColor = tgt.kind === 'draft' ? theme.warning : tgt.kind === 'archived' ? theme.dim : theme.info;
                    const countStr = `${tgt.directCitedCards}${t(lang, '引', 'c')}/${tgt.totalCards}${t(lang, '题', 't')}`;
                    const titleWithCourse = tgt.course ? `${tgt.title} (${tgt.course})` : tgt.title;
                    const maxTitle = Math.max(8, ctx.width - displayWidth(cursor) - displayWidth(tag) - displayWidth(countStr) - 2);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                        <Text color={tagColor}>{tag}</Text>
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(titleWithCourse, maxTitle, ell)}
                        </Text>
                        <Box flexGrow={1} />
                        <Text color={theme.dim}>{countStr}</Text>
                      </Box>
                    );
                  }}
                />
              )}
            </Box>
          )
        ) : linkedLoading ? (
          <Box height={bodyHeight} width={innerWidth} alignItems="center" justifyContent="center">
            <Spinner
              label={t(lang, `正在加载关联题卡与掌握度${ell}`, `Loading linked cards & mastery${ell}`)}
              active={isActive}
            />
          </Box>
        ) : linkedError ? (
          <Box height={bodyHeight} width={innerWidth} flexDirection="column" justifyContent="center" alignItems="center">
            <Text color={theme.error} bold wrap="wrap">
              {`${errMark} ${linkedError}`}
            </Text>
            <Box marginTop={1}>
              <Text color={theme.muted}>
                {t(lang, '按 [r] 重试，或按 [g] 直接为该资料出题', 'Press [r] to retry, or [g] to generate questions')}
              </Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" height={bodyHeight} width={innerWidth}>
            {/* Document Mastery Progress Bar */}
            <Box height={1} width={innerWidth} flexShrink={0}>
              <ProgressBar
                ratio={Math.max(0, Math.min(1, linkedPercent / 100))}
                width={innerWidth}
                style="block"
                showPercent
                label={t(lang, '题卡掌握', 'Mastery')}
              />
            </Box>

            {/* Mastery State & Breakdown Row */}
            <Box height={1} width={innerWidth} flexDirection="row" alignItems="center" flexShrink={0} overflow="hidden">
              <Badge label={docState.label} tone={docState.tone} variant="soft" />
              <Text> </Text>
              {(() => {
                const pracHint =
                  linkedCardRows.length > 0 && innerWidth >= 56
                    ? innerWidth >= 68
                      ? t(lang, '[p] 练习全部', '[p] Practise all')
                      : t(lang, '[p] 全练', '[p] All')
                    : '';
                const rightReserve = starting ? 14 : pracHint ? displayWidth(pracHint) + 1 : 0;
                const breakdownMaxW = Math.max(10, innerWidth - displayWidth(docState.label) - 3 - rightReserve);
                return (
                  <>
                    <Text color={theme.muted} wrap="truncate-end">
                      {truncateDisplay(linkedBreakdown, breakdownMaxW, ell)}
                    </Text>
                    <Box flexGrow={1} />
                    {starting ? (
                      <Spinner label={t(lang, `启动中${ell}`, `Starting${ell}`)} active={isActive} />
                    ) : pracHint ? (
                      <Text color={theme.dim}>{pracHint}</Text>
                    ) : null}
                  </>
                );
              })()}
            </Box>

            {linkedCardRows.length === 0 ? (
              <EmptyState
                title={t(lang, '暂无引用该资料的题卡', 'No cards linked to this source yet')}
                hint={t(lang, '按 [g] 基于该资料生成题目', 'Press [g] to generate questions from this source')}
                width={innerWidth}
                height={linkedListHeight}
              />
            ) : (
              <VirtualList
                items={linkedCardRows}
                height={linkedListHeight}
                width={innerWidth}
                selectedIndex={linkedSelectedIndex}
                onChange={(idx) => setLinkedSelectedIndex(idx)}
                onSelect={(row) => {
                  void launchPractice([row]);
                }}
                isActive={isActive && !starting}
                ascii={asciiMode}
                keyExtractor={(row) => row.key}
                renderItem={renderLinkedCardRow}
              />
            )}
          </Box>
        )}
      </Box>
    </Modal>
  );
});
