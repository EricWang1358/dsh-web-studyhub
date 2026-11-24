import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { getReview, tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { kindLabel, normalizeCardKind, type NormalizedKind } from './review-helpers.js';

export interface QueueModalProps {
  host: HostClient;
  run: ReviewRun;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
  onRunUpdated: (nextRun: ReviewRun) => void;
}

type QueueMode = 'list' | 'add';
type AddPosition = 'next' | 'end';
type QueueItemStatus = 'current' | 'answered-pass' | 'answered-fail' | 'answered' | 'upcoming';

interface QueueEntryItem {
  index: number;
  cardId: string;
  deckId: string;
  topic: string;
  kind: string;
  prompt: string;
  answered: boolean;
  passed?: boolean;
  grading?: boolean;
  retry?: boolean;
  status: QueueItemStatus;
}

interface CardSearchHit {
  deckId: string;
  deckTitle?: string;
  course?: string;
  cardId: string;
  kind?: string;
  topic?: string;
  prompt: string;
}

interface CachedCardMeta {
  kind?: string;
  topic?: string;
  prompt?: string;
}

interface QueueEditResponse extends ReviewRun {
  added?: Array<{ deckId?: string; cardId?: string }>;
  removed?: Array<{ deckId?: string; cardId?: string }>;
  kept?: Array<{ cardId?: string; reason?: string }>;
}

function cleanSnippet(raw: string, asciiMode: boolean): string {
  return String(raw || '')
    .replace(/\{\{[^{}]+\}\}/g, asciiMode ? '___' : '＿＿')
    .replace(/[#*_`>$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatKindTag(rawKind: string, lang: UiLanguage): string {
  if (!rawKind) return '';
  const norm: NormalizedKind = normalizeCardKind({ id: 'tmp', index: 0, total: 1, card: { id: 'tmp', kind: rawKind } });
  return kindLabel(norm, lang);
}

function statusIconFor(status: QueueItemStatus, asciiMode: boolean): string {
  if (status === 'current') return asciiMode ? '[>]' : '[▶]';
  if (status === 'answered-fail') return '[x]';
  if (status === 'answered-pass' || status === 'answered') return asciiMode ? '[+]' : '[✓]';
  return '[ ]';
}

function extractQueueEntries(
  run: ReviewRun,
  cardMetaMap: ReadonlyMap<string, CachedCardMeta>,
): QueueEntryItem[] {
  const currentIndex = typeof run.index === 'number' ? run.index : 0;
  const isRoundFinished = Boolean(run.complete || run.closed);
  const rawEntries = (run as { entries?: unknown }).entries;

  if (Array.isArray(rawEntries) && rawEntries.length > 0) {
    return (rawEntries as Array<Record<string, unknown>>).map((entry, idx) => {
      const cardObj = (entry.card && typeof entry.card === 'object' ? entry.card : {}) as Record<string, unknown>;
      const cardId = String(cardObj.id ?? entry.cardId ?? `card-${idx}`);
      const deckId = String(entry.deckId ?? run.deckId ?? '');
      const meta = cardMetaMap.get(`${deckId}\0${cardId}`) ?? cardMetaMap.get(cardId);
      const fb = entry.feedback && typeof entry.feedback === 'object'
        ? (entry.feedback as { correct?: boolean; grade?: number; selfReported?: boolean; assessment?: string })
        : null;
      const grading = Boolean(entry.grading);
      const answered = Boolean(fb || entry.answered || grading);
      let passed: boolean | undefined;
      if (typeof entry.passed === 'boolean') {
        passed = entry.passed;
      } else if (fb && !fb.selfReported && fb.assessment !== 'self-report') {
        if (typeof fb.grade === 'number') passed = fb.grade >= 3;
        else if (typeof fb.correct === 'boolean') passed = fb.correct;
      }
      const status: QueueItemStatus =
        idx === currentIndex && !isRoundFinished
          ? 'current'
          : answered
            ? passed === true
              ? 'answered-pass'
              : passed === false
                ? 'answered-fail'
                : 'answered'
            : 'upcoming';
      const fallbackCard = idx === currentIndex ? run.card : null;
      return {
        index: idx,
        cardId,
        deckId,
        topic: String(cardObj.topic ?? entry.topic ?? meta?.topic ?? (fallbackCard?.topic as string | undefined) ?? ''),
        kind: String(cardObj.kind ?? entry.kind ?? meta?.kind ?? fallbackCard?.kind ?? ''),
        prompt: String(cardObj.prompt ?? entry.prompt ?? meta?.prompt ?? fallbackCard?.prompt ?? ''),
        answered,
        passed,
        grading,
        retry: Boolean(entry.retry),
        status,
      };
    });
  }

  const nav = Array.isArray(run.navigation) ? run.navigation : [];
  return nav.map((item, i) => {
    const idx = typeof item.index === 'number' ? item.index : i;
    const cardId = String(item.cardId ?? `card-${idx}`);
    const deckId = String(item.deckId ?? run.deckId ?? '');
    const meta = cardMetaMap.get(`${deckId}\0${cardId}`) ?? cardMetaMap.get(cardId);
    const fallbackCard = idx === currentIndex ? run.card : null;
    const answered = Boolean(item.answered);
    const passed = typeof item.passed === 'boolean' ? item.passed : undefined;
    const grading = Boolean((item as { grading?: unknown }).grading);
    const status: QueueItemStatus =
      idx === currentIndex && !isRoundFinished
        ? 'current'
        : answered
          ? passed === true
            ? 'answered-pass'
            : passed === false
              ? 'answered-fail'
              : 'answered'
          : 'upcoming';
    return {
      index: idx,
      cardId,
      deckId,
      topic: String(item.topic ?? meta?.topic ?? (fallbackCard?.topic as string | undefined) ?? ''),
      kind: String(meta?.kind ?? fallbackCard?.kind ?? ''),
      prompt: String(meta?.prompt ?? fallbackCard?.prompt ?? ''),
      answered,
      passed,
      grading,
      retry: Boolean((item as { retry?: unknown }).retry),
      status,
    };
  });
}

export const QueueModal = memo(function QueueModal({
  host,
  run,
  width,
  height,
  isActive,
  onClose,
  onRunUpdated,
}: QueueModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);

  const [liveRun, setLiveRun] = useState<ReviewRun>(run);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mode, setMode] = useState<QueueMode>('list');
  const [cursor, setCursor] = useState(() => Math.max(0, run.index || 0));
  const [cardMetaTick, setCardMetaTick] = useState(0);

  // Add-card inline search state
  const [addPosition, setAddPosition] = useState<AddPosition>('next');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHits, setSearchHits] = useState<CardSearchHit[]>([]);
  const [hitCursor, setHitCursor] = useState(0);

  const mountedRef = useRef(true);
  const searchSeqRef = useRef(0);
  const lastSearchedQueryRef = useRef('');
  const cardMetaRef = useRef<Map<string, CachedCardMeta>>(new Map());
  const loadedDecksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hydrateMissingDeckMeta = useCallback(
    async (targetRun: ReviewRun) => {
      const rawEntries = (targetRun as { entries?: unknown }).entries;
      if (Array.isArray(rawEntries) && rawEntries.length > 0) return;

      const nav = Array.isArray(targetRun.navigation) ? targetRun.navigation : [];
      if (targetRun.card?.id) {
        const curDeckId = String(targetRun.deckId ?? '');
        const meta: CachedCardMeta = {
          kind: typeof targetRun.card.kind === 'string' ? targetRun.card.kind : undefined,
          topic: typeof targetRun.card.topic === 'string' ? targetRun.card.topic : undefined,
          prompt: typeof targetRun.card.prompt === 'string' ? targetRun.card.prompt : undefined,
        };
        if (curDeckId) cardMetaRef.current.set(`${curDeckId}\0${targetRun.card.id}`, meta);
        cardMetaRef.current.set(targetRun.card.id, meta);
      }

      const missingDecks = new Set<string>();
      for (const item of nav) {
        const dId = String(item.deckId ?? targetRun.deckId ?? '').trim();
        if (dId && !loadedDecksRef.current.has(dId)) {
          missingDecks.add(dId);
        }
      }
      if (missingDecks.size === 0) return;

      await Promise.all(
        [...missingDecks].map(async (deckId) => {
          loadedDecksRef.current.add(deckId);
          const res = await tryAction<{
            cards?: Array<{ id?: string; kind?: string; topic?: string; prompt?: string }>;
          }>(host, 'deck.get', { id: deckId });
          if (!mountedRef.current || !res.ok || !Array.isArray(res.value?.cards)) return;
          for (const c of res.value.cards) {
            if (!c?.id) continue;
            const meta: CachedCardMeta = {
              kind: typeof c.kind === 'string' ? c.kind : undefined,
              topic: typeof c.topic === 'string' ? c.topic : undefined,
              prompt: typeof c.prompt === 'string' ? c.prompt : undefined,
            };
            cardMetaRef.current.set(`${deckId}\0${c.id}`, meta);
            if (!cardMetaRef.current.has(c.id)) cardMetaRef.current.set(c.id, meta);
          }
        }),
      );
      if (mountedRef.current) setCardMetaTick((v) => v + 1);
    },
    [host],
  );

  const reloadRun = useCallback(
    async (opts?: { notifyParent?: boolean; syncCursorToCurrent?: boolean }) => {
      try {
        const latest = await getReview(host, run.id);
        if (!mountedRef.current) return null;
        setLiveRun(latest);
        setErrorText(null);
        void hydrateMissingDeckMeta(latest);
        if (opts?.syncCursorToCurrent) {
          setCursor(Math.max(0, latest.index || 0));
        }
        if (opts?.notifyParent) {
          onRunUpdated(latest);
        }
        return latest;
      } catch (err) {
        if (!mountedRef.current) return null;
        setErrorText(err instanceof Error ? err.message : t(lang, '刷新队列失败', 'Failed to refresh queue'));
        return null;
      }
    },
    [host, run.id, hydrateMissingDeckMeta, onRunUpdated, lang],
  );

  useEffect(() => {
    setLoading(true);
    void reloadRun({ syncCursorToCurrent: true }).finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    // Only fetch on mount / run id change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const queueEntries = useMemo(() => {
    void cardMetaTick;
    return extractQueueEntries(liveRun, cardMetaRef.current);
  }, [liveRun, cardMetaTick]);

  // Keep cursor bounded if queue shrinks
  useEffect(() => {
    setCursor((prev) => Math.max(0, Math.min(prev, Math.max(0, queueEntries.length - 1))));
  }, [queueEntries.length]);

  const currentIndex = typeof liveRun.index === 'number' ? liveRun.index : 0;
  const queueVersion = typeof liveRun.queueVersion === 'number' ? liveRun.queueVersion : 0;

  const performSearch = useCallback(
    async (rawQuery: string, opts?: { focusResultsOnDone?: boolean }) => {
      const trimmed = rawQuery.trim();
      const seq = ++searchSeqRef.current;
      if (!trimmed) {
        setSearchLoading(false);
        setSearchHits([]);
        setHitCursor(0);
        lastSearchedQueryRef.current = '';
        return;
      }
      setSearchLoading(true);
      setErrorText(null);
      const res = await tryAction<{ results?: CardSearchHit[] }>(host, 'card.search', {
        query: trimmed,
        limit: 8,
      });
      if (!mountedRef.current || seq !== searchSeqRef.current) return;
      setSearchLoading(false);
      if (!res.ok) {
        setErrorText(res.error?.message || t(lang, '搜索题目失败', 'Failed to search cards'));
        return;
      }
      const list = Array.isArray(res.value?.results) ? res.value.results.filter((x) => x && typeof x.cardId === 'string') : [];
      lastSearchedQueryRef.current = trimmed;
      setSearchHits(list);
      setHitCursor(0);
      if (opts?.focusResultsOnDone && list.length > 0) {
        setSearchFocused(false);
      }
    },
    [host, lang],
  );

  useEffect(() => {
    if (mode !== 'add') return;
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchSeqRef.current += 1;
      lastSearchedQueryRef.current = '';
      setSearchLoading(false);
      setSearchHits([]);
      setHitCursor(0);
      return;
    }
    const timer = setTimeout(() => {
      void performSearch(trimmed);
    }, 180);
    return () => clearTimeout(timer);
  }, [mode, searchQuery, performSearch]);

  const handleRemoveEntry = useCallback(
    async (item: QueueEntryItem | undefined) => {
      if (!item || busy) return;
      if (item.index === currentIndex && !liveRun.complete && !liveRun.closed) {
        const msg = t(lang, '当前正在作答的题目不能移除', 'Cannot remove the current question on screen');
        setErrorText(msg);
        notify(msg, 'warning');
        return;
      }
      if (item.answered || item.index < currentIndex) {
        const msg = t(lang, '已作答或已看过的题目不能从本轮移除', 'Cannot remove already answered or past questions');
        setErrorText(msg);
        notify(msg, 'warning');
        return;
      }
      if (item.retry) {
        const msg = t(lang, '错题再练条目不支持移除', 'Cannot remove a scheduled retry entry');
        setErrorText(msg);
        notify(msg, 'warning');
        return;
      }

      setBusy(true);
      setErrorText(null);
      const res = await tryAction<QueueEditResponse>(host, 'review.queue.edit', {
        runId: liveRun.id,
        remove: [
          {
            ...(item.deckId ? { deckId: item.deckId } : {}),
            cardId: item.cardId,
          },
        ],
        queueVersion,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setBusy(false);
        const msg = res.error?.message || t(lang, '移除队列题目失败', 'Failed to remove card from queue');
        setErrorText(msg);
        notify(msg, 'error');
        if (res.error?.code === 'queue-version') {
          void reloadRun({ notifyParent: true });
        }
        return;
      }

      const wasKept =
        Array.isArray(res.value?.removed) &&
        res.value.removed.length === 0 &&
        Array.isArray(res.value?.kept) &&
        res.value.kept.length > 0;

      const refreshed = await reloadRun({ notifyParent: true });
      if (!mountedRef.current) return;
      if (!refreshed && res.value && typeof res.value === 'object' && 'id' in res.value) {
        setLiveRun(res.value);
        onRunUpdated(res.value);
      }
      setBusy(false);

      if (wasKept) {
        const reason = res.value?.kept?.[0]?.reason || t(lang, '当前不可移除', 'kept in queue');
        const msg = t(lang, `未移除该题（${reason}）`, `Kept in queue (${reason})`);
        setErrorText(msg);
        notify(msg, 'warning');
        return;
      }
      notify(t(lang, '已从本轮队列移除该题（仅影响本轮）', 'Removed card from this round queue'), 'success');
    },
    [busy, currentIndex, liveRun.complete, liveRun.closed, liveRun.id, lang, notify, host, queueVersion, reloadRun, onRunUpdated],
  );

  const handleAddHit = useCallback(
    async (hit: CardSearchHit | undefined) => {
      if (!hit || busy) return;
      setBusy(true);
      setErrorText(null);
      const res = await tryAction<QueueEditResponse>(host, 'review.queue.edit', {
        runId: liveRun.id,
        add: [{ deckId: hit.deckId, cardId: hit.cardId }],
        position: addPosition,
        queueVersion,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setBusy(false);
        const msg = res.error?.message || t(lang, '加入队列失败', 'Failed to add card to queue');
        setErrorText(msg);
        notify(msg, 'error');
        if (res.error?.code === 'queue-version') {
          void reloadRun({ notifyParent: true });
        }
        return;
      }

      const alreadyPending = Array.isArray(res.value?.added) && res.value.added.length === 0;
      const refreshed = await reloadRun({ notifyParent: true });
      if (!mountedRef.current) return;
      if (!refreshed && res.value && typeof res.value === 'object' && 'id' in res.value) {
        setLiveRun(res.value);
        onRunUpdated(res.value);
      }
      setBusy(false);
      setMode('list');
      setSearchFocused(true);

      if (alreadyPending) {
        notify(t(lang, '该题已在后续待答队列中', 'Card is already in the upcoming queue'), 'info');
      } else {
        notify(
          addPosition === 'next'
            ? t(lang, '已插入到下一题位置', 'Added card as next question')
            : t(lang, '已追加到本轮队尾', 'Added card to end of round'),
          'success',
        );
      }
    },
    [busy, host, liveRun.id, addPosition, queueVersion, lang, notify, reloadRun, onRunUpdated],
  );

  const togglePosition = useCallback(() => {
    setAddPosition((prev) => (prev === 'next' ? 'end' : 'next'));
  }, []);

  const openAddMode = useCallback(() => {
    setMode('add');
    setErrorText(null);
    setSearchQuery('');
    setSearchHits([]);
    setHitCursor(0);
    setSearchFocused(true);
    lastSearchedQueryRef.current = '';
  }, []);

  // List mode keyboard shortcuts
  useInput(
    (input, key) => {
      if (loading || busy) return;
      if (input === 'a' || input === '/') {
        openAddMode();
      } else if (input === 'd' || key.delete || key.backspace) {
        void handleRemoveEntry(queueEntries[cursor]);
      } else if (input === 'r') {
        void reloadRun({ notifyParent: true });
      }
    },
    { isActive: isActive && mode === 'list' && !loading && !busy },
  );

  // Add mode keyboard navigation while search input is focused
  useInput(
    (_input, key) => {
      if (key.downArrow && searchHits.length > 0) {
        setSearchFocused(false);
        setHitCursor(0);
      }
    },
    { isActive: isActive && mode === 'add' && searchFocused && !busy },
  );

  // Add mode keyboard navigation while hit list is focused
  useInput(
    (input, key) => {
      if (busy) return;
      if (input === 'p' || key.tab) {
        togglePosition();
      } else if (input === '/') {
        setSearchFocused(true);
      } else if (key.upArrow && hitCursor === 0) {
        setSearchFocused(true);
      }
    },
    { isActive: isActive && mode === 'add' && !searchFocused && !busy },
  );

  // Responsive Modal sizing (respecting 5-row Modal chrome)
  const frameW = Math.max(52, Math.min(88, width - 4));
  const frameH = Math.max(14, Math.min(30, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(7, Math.min(frameH, height - 2) - 5);
  const searchInputW = Math.max(12, modalContentWidth(frameW) - 4);

  const statusRows = 2 + (busy ? 1 : 0) + (errorText ? 1 : 0);
  const contentH = Math.max(3, bodyH - statusRows);

  const showDetailRow = mode === 'list' && contentH >= 6 && queueEntries.length > 0;
  const listH = mode === 'list' ? Math.max(3, contentH - (showDetailRow ? 1 : 0)) : contentH;
  const addResultsH = Math.max(3, contentH - 4); // 1 row position toggle + 3 rows TextInput box

  const answeredCount = queueEntries.filter((e) => e.answered).length;
  const upcomingCount = queueEntries.filter((e) => !e.answered && e.index > currentIndex).length;
  const pendingSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of queueEntries) {
      if (!e.answered && e.index >= currentIndex) {
        s.add(`${e.deckId}\0${e.cardId}`);
        s.add(e.cardId);
      }
    }
    return s;
  }, [queueEntries, currentIndex]);

  const hints = useMemo<KeyHint[]>(() => {
    if (mode === 'add') {
      if (searchFocused) {
        return [
          { key: 'Enter', label: t(lang, '搜索', 'Search') },
          { key: 'Tab', label: addPosition === 'next' ? t(lang, '插到下一题', 'Pos:Next') : t(lang, '加到队尾', 'Pos:End') },
          { key: asciiMode ? 'Down' : '↓', label: t(lang, '选结果', 'Hits') },
          { key: 'Esc', label: t(lang, '返回', 'Back') },
        ];
      }
      return [
        { key: 'Enter', label: t(lang, '加入队列', 'Add') },
        { key: 'p/Tab', label: addPosition === 'next' ? t(lang, '插到下一题', 'Pos:Next') : t(lang, '加到队尾', 'Pos:End') },
        { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '移动', 'Move') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    return [
      { key: 'a', label: t(lang, '加题', 'Add') },
      { key: 'd', label: t(lang, '移除待答', 'Remove') },
      { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '浏览', 'Nav') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [mode, searchFocused, addPosition, lang, asciiMode]);

  const handleModalClose = useCallback(() => {
    if (mode === 'add') {
      setMode('list');
      setSearchFocused(true);
      setErrorText(null);
      return;
    }
    onClose();
  }, [mode, onClose]);

  const renderQueueItem = useCallback(
    (item: QueueEntryItem, ctx: VirtualListRenderContext) => {
      const icon = statusIconFor(item.status, asciiMode);
      const cursorMark = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
      const numTag = String(item.index + 1).padStart(2, ' ');
      const kindText = formatKindTag(item.kind, lang);
      const topicText = item.topic ? truncateDisplay(item.topic, width >= 110 ? 16 : 10) : '';
      const sep = asciiMode ? '|' : '·';
      const retryTag = item.retry ? (lang === 'en' ? 'Retry' : '再练') : '';
      const badgeParts = [kindText, topicText, retryTag].filter(Boolean);
      const rightTag = badgeParts.length > 0 ? `[${badgeParts.join(sep)}]` : '';

      const prefix = `${cursorMark}${numTag} ${icon} `;
      const rightW = rightTag ? displayWidth(rightTag) + 1 : 0;
      const snippetW = Math.max(6, ctx.width - displayWidth(prefix) - rightW);
      const rawSnippet = cleanSnippet(item.prompt, asciiMode) || item.topic || item.cardId;
      const snippet = truncateDisplay(rawSnippet, snippetW);

      const statusColor = ctx.selected
        ? theme.selectionFg
        : item.status === 'current'
          ? theme.primary
          : item.status === 'answered-pass'
            ? theme.success
            : item.status === 'answered-fail'
              ? theme.error
              : item.status === 'answered'
                ? theme.muted
                : theme.text;

      return (
        <Box flexDirection="row" justifyContent="space-between" width={ctx.width}>
          <Text color={statusColor} bold={ctx.selected || item.status === 'current'} wrap="truncate">
            {`${prefix}${snippet}`}
          </Text>
          {rightTag ? (
            <Text color={ctx.selected ? theme.selectionFg : item.status === 'current' ? theme.accent : theme.muted}>
              {rightTag}
            </Text>
          ) : null}
        </Box>
      );
    },
    [asciiMode, lang, width, theme],
  );

  const renderSearchHit = useCallback(
    (hit: CardSearchHit, ctx: VirtualListRenderContext) => {
      const cursorMark = ctx.selected && !searchFocused ? (asciiMode ? '> ' : '▸ ') : '  ';
      const inQueue = pendingSet.has(`${hit.deckId}\0${hit.cardId}`) || pendingSet.has(hit.cardId);
      const kindText = hit.kind ? formatKindTag(hit.kind, lang) : '';
      const topicText = hit.topic ? truncateDisplay(hit.topic, 12) : '';
      const sep = asciiMode ? '|' : '·';
      const tagText = inQueue
        ? t(lang, '[已在队列]', '[in queue]')
        : [kindText, topicText].filter(Boolean).length > 0
          ? `[${[kindText, topicText].filter(Boolean).join(sep)}]`
          : '';
      const rightW = tagText ? displayWidth(tagText) + 1 : 0;
      const promptW = Math.max(8, ctx.width - displayWidth(cursorMark) - rightW);
      const snippet = truncateDisplay(cleanSnippet(hit.prompt, asciiMode) || hit.cardId, promptW);

      return (
        <Box flexDirection="row" justifyContent="space-between" width={ctx.width}>
          <Text color={ctx.selected && !searchFocused ? theme.selectionFg : theme.text} bold={ctx.selected && !searchFocused} wrap="truncate">
            {`${cursorMark}${snippet}`}
          </Text>
          {tagText ? (
            <Text color={ctx.selected && !searchFocused ? theme.selectionFg : inQueue ? theme.warning : theme.muted}>
              {tagText}
            </Text>
          ) : null}
        </Box>
      );
    },
    [searchFocused, asciiMode, pendingSet, lang, theme],
  );

  const selectedEntry = queueEntries[cursor];
  const canRemoveSelected = Boolean(
    selectedEntry &&
      selectedEntry.index > currentIndex &&
      !selectedEntry.answered &&
      !selectedEntry.retry,
  );

  return (
    <Modal
      title={mode === 'add' ? t(lang, '向本轮队列加题', 'Add Card to Queue') : t(lang, '本轮复习队列', 'Review Queue')}
      icon={asciiMode ? '#' : '☰'}
      tone="primary"
      subtitle={`${queueEntries.length} ${t(lang, '题', 'cards')}${asciiMode ? ' | ' : ' · '}v${queueVersion}`}
      width={frameW}
      height={frameH}
      onClose={handleModalClose}
      isActive={isActive && !(mode === 'add' && searchFocused)}
      hints={hints}
    >
      {/* Status Header */}
      <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1}>
        <Box flexDirection="row" gap={1}>
          <Badge
            label={t(lang, `已答 ${answeredCount}/${queueEntries.length}`, `${answeredCount}/${queueEntries.length} done`)}
            tone="primary"
            variant="soft"
          />
          <Badge
            label={t(lang, `待答 ${upcomingCount}`, `${upcomingCount} upcoming`)}
            tone="accent"
            variant="soft"
          />
        </Box>
        <Text color={theme.dim}>
          {mode === 'add'
            ? t(lang, '[Esc] 返回队列', '[Esc] Queue')
            : t(lang, '[a] 加题  [d] 移除', '[a] Add  [d] Remove')}
        </Text>
      </Box>

      <Divider width={innerW} />

      {busy ? (
        <Box height={1}>
          <Spinner label={t(lang, '正在更新本轮队列…', 'Updating round queue…')} active={isActive} />
        </Box>
      ) : null}

      {errorText ? (
        <Box height={1}>
          <Text color={theme.error} wrap="truncate">
            {`${asciiMode ? 'x' : '✕'} ${errorText}`}
          </Text>
        </Box>
      ) : null}

      {mode === 'list' ? (
        loading ? (
          <Box height={contentH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, '正在读取队列…', 'Loading queue…')} active={isActive} />
          </Box>
        ) : queueEntries.length === 0 ? (
          <EmptyState
            icon={asciiMode ? 'o' : '◌'}
            title={t(lang, '当前队列为空', 'Queue is empty')}
            hint={t(lang, '按 [a] 搜索题库并加入题目到本轮队列', 'Press [a] to search and add cards to this round')}
            width={innerW}
            height={contentH}
          />
        ) : (
          <Box flexDirection="column" width={innerW} height={contentH} overflow="hidden">
            <VirtualList
              items={queueEntries}
              height={listH}
              width={innerW}
              selectedIndex={cursor}
              onChange={(idx) => {
                setCursor(idx);
                setErrorText(null);
              }}
              keyExtractor={(item) => `${item.index}:${item.deckId}:${item.cardId}`}
              renderItem={renderQueueItem}
              isActive={isActive && mode === 'list' && !loading && !busy}
              ascii={asciiMode}
            />
            {showDetailRow && selectedEntry ? (
              <Box height={1} width={innerW} flexDirection="row" justifyContent="space-between" overflow="hidden">
                <Text color={theme.dim} wrap="truncate">
                  {truncateDisplay(
                    `${selectedEntry.status === 'current' ? t(lang, '当前题', 'Current') : selectedEntry.answered ? t(lang, '已作答', 'Answered') : t(lang, '待答', 'Upcoming')}${asciiMode ? ' | ' : ' · '}${canRemoveSelected ? t(lang, '[d] 可移除', '[d] Removable') : t(lang, '已锁定', 'Locked')}`,
                    innerW,
                  )}
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      ) : (
        <Box flexDirection="column" width={innerW} height={contentH} overflow="hidden">
          {/* Position selector row */}
          <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={theme.muted}>{t(lang, '插入位置:', 'Insert at:')}</Text>
              <Badge
                label={addPosition === 'next' ? t(lang, '下一题 (next)', 'Next (next)') : t(lang, '队尾 (end)', 'End (end)')}
                tone={addPosition === 'next' ? 'primary' : 'accent'}
                variant="soft"
              />
            </Box>
            <Text color={theme.dim}>
              {searchFocused ? t(lang, '[Tab] 切换位置', '[Tab] Toggle') : t(lang, '[p/Tab] 切换位置  [/] 搜索', '[p/Tab] Pos  [/] Search')}
            </Text>
          </Box>

          {/* Inline card search input */}
          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={searchFocused ? theme.primary : theme.border}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t(lang, '输入关键词搜索题库（Enter 搜索, Tab 切换位置）…', 'Search cards (Enter search, Tab toggle pos)…')}
              width={searchInputW}
              isActive={isActive && mode === 'add' && searchFocused && !busy}
              onTab={() => {
                togglePosition();
                return undefined;
              }}
              onSubmit={(val) => {
                const trimmed = val.trim();
                if (!trimmed) return;
                if (lastSearchedQueryRef.current === trimmed && searchHits.length > 0 && !searchLoading) {
                  setSearchFocused(false);
                  setHitCursor(0);
                } else {
                  void performSearch(trimmed, { focusResultsOnDone: true });
                }
              }}
              onCancel={() => {
                setMode('list');
                setSearchFocused(true);
                setErrorText(null);
              }}
            />
          </Box>

          {searchLoading ? (
            <Box height={addResultsH} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, '正在搜索题库…', 'Searching cards…')} active={isActive} />
            </Box>
          ) : searchQuery.trim().length === 0 ? (
            <EmptyState
              icon={asciiMode ? '?' : '⌕'}
              title={t(lang, '输入关键词搜索要加入本轮的题目', 'Type keywords to search cards')}
              hint={t(lang, '支持按题干/知识点/答案搜索，最多显示 8 条结果', 'Matches prompt/topic/answer (up to 8 results)')}
              width={innerW}
              height={addResultsH}
            />
          ) : searchHits.length === 0 ? (
            <EmptyState
              icon={asciiMode ? 'o' : '◌'}
              title={t(lang, '未找到匹配题目', 'No matching cards found')}
              hint={t(lang, '请更换关键词重试，或按 Esc 返回队列', 'Try another query or press Esc to go back')}
              width={innerW}
              height={addResultsH}
            />
          ) : (
            <VirtualList
              items={searchHits}
              height={addResultsH}
              width={innerW}
              selectedIndex={hitCursor}
              onChange={(idx) => setHitCursor(idx)}
              onSelect={(hit) => void handleAddHit(hit)}
              keyExtractor={(hit) => `${hit.deckId}:${hit.cardId}`}
              renderItem={renderSearchHit}
              isActive={isActive && mode === 'add' && !searchFocused && !busy}
              highlightSelected={!searchFocused}
              ascii={asciiMode}
            />
          )}
        </Box>
      )}
    </Modal>
  );
});
