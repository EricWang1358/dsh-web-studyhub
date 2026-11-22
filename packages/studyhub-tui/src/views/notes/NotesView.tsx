import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Box, Text, useInput } from 'ink';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  MarkdownView,
  Modal,
  modalContentWidth,
  Panel,
  Spinner,
  SplitPane,
  StatusPill,
  TextInput,
  useClaimKeys,
  useFooterHints,
  useTheme,
  VirtualList,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';
import { currentCourse, useShellActions } from '../../shell/index.js';
import { t, useTuiStore } from '../../state/store.js';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import {
  defaultExportPath,
  expandUserPath,
  formatShortDate,
  isDailyNote,
  isNoteWritable,
  resolveRecapTimeZone,
  todayInTimeZone,
  type DailyRecapGroup,
  type DailyRecapStatus,
  type NoteItem,
} from './notes-types.js';

const NoteEditorModal = lazy(() => import('./NoteEditorModal.js').then((m) => ({ default: m.NoteEditorModal })));

type ActiveModal =
  | null
  | { type: 'create' }
  | { type: 'edit'; note: NoteItem }
  | { type: 'export'; note: NoteItem }
  | { type: 'delete'; note: NoteItem };

const CLAIMED_KEYS = ['a', 'o', 'R'] as const;

interface LinkedCardTarget {
  deckId: string;
  cardId: string;
  label: string;
  course?: string;
}

interface LinkedSourceTarget {
  sourceId: string;
  pageNumber?: number;
  label: string;
}

interface NoteLinkedRefs {
  card: LinkedCardTarget | null;
  cardCount: number;
  source: LinkedSourceTarget | null;
}

function asNonEmptyString(val: unknown): string {
  return typeof val === 'string' && val.trim() ? val.trim() : '';
}

function asPositiveInt(val: unknown): number | undefined {
  const num = Number(val);
  return Number.isFinite(num) && num >= 1 ? Math.floor(num) : undefined;
}

function extractLinkedRefs(
  note: NoteItem | null | undefined,
  decks: ReadonlyArray<{ id: string; title?: string; course?: string; [k: string]: unknown }> | undefined,
  sources: ReadonlyArray<{ id: string; title?: string; name?: string; filename?: string; [k: string]: unknown }> | undefined,
): NoteLinkedRefs {
  if (!note) return { card: null, cardCount: 0, source: null };
  const raw = note as unknown as Record<string, unknown>;

  const validCards = (note.cards ?? []).filter((c) => !c.missing && Boolean(c.deckId) && Boolean(c.cardId));
  let card: LinkedCardTarget | null = null;
  if (validCards.length > 0) {
    const first = validCards[0];
    let fallbackPrompt = '';
    let fallbackCourse = first.course || '';
    if (!first.prompt || !fallbackCourse) {
      for (const d of decks ?? []) {
        if (d.id !== first.deckId) continue;
        if (!fallbackCourse && typeof d.course === 'string') fallbackCourse = d.course;
        const deckCards = Array.isArray(d.cards) ? (d.cards as Array<Record<string, unknown>>) : [];
        const found = deckCards.find((c) => c.id === first.cardId);
        if (found && typeof found.prompt === 'string') {
          fallbackPrompt = found.prompt.replace(/\s+/g, ' ').trim();
        }
        break;
      }
    }
    card = {
      deckId: first.deckId,
      cardId: first.cardId,
      label: (first.prompt || fallbackPrompt || first.deckTitle || first.cardId).replace(/\s+/g, ' ').trim(),
      ...(fallbackCourse ? { course: fallbackCourse } : {}),
    };
  } else {
    const topCardId = asNonEmptyString(raw.cardId);
    let topDeckId = asNonEmptyString(raw.deckId);
    let topLabel = asNonEmptyString(raw.cardPrompt) || topCardId;
    let topCourse = '';
    if (topCardId && (!topDeckId || topLabel === topCardId)) {
      for (const d of decks ?? []) {
        const deckCards = Array.isArray(d.cards) ? (d.cards as Array<Record<string, unknown>>) : [];
        const found = deckCards.find((c) => c.id === topCardId);
        if (found) {
          if (!topDeckId) topDeckId = d.id;
          if (typeof found.prompt === 'string' && found.prompt.trim()) {
            topLabel = found.prompt.replace(/\s+/g, ' ').trim();
          }
          if (typeof d.course === 'string') topCourse = d.course;
          break;
        }
      }
    }
    if (topCardId && topDeckId) {
      card = {
        deckId: topDeckId,
        cardId: topCardId,
        label: topLabel,
        ...(topCourse ? { course: topCourse } : {}),
      };
    }
  }

  let source: LinkedSourceTarget | null = null;
  const nestedSource =
    (raw.source && typeof raw.source === 'object' ? (raw.source as Record<string, unknown>) : null) ??
    (Array.isArray(raw.sources) && raw.sources[0] && typeof raw.sources[0] === 'object'
      ? (raw.sources[0] as Record<string, unknown>)
      : null) ??
    (Array.isArray(raw.sourceRefs) && raw.sourceRefs[0] && typeof raw.sourceRefs[0] === 'object'
      ? (raw.sourceRefs[0] as Record<string, unknown>)
      : null);

  const sourceId = asNonEmptyString(raw.sourceId) || asNonEmptyString(nestedSource?.sourceId) || asNonEmptyString(nestedSource?.id);
  if (sourceId) {
    const pageNumber =
      asPositiveInt(raw.pageNumber) ??
      asPositiveInt(raw.page) ??
      asPositiveInt(nestedSource?.pageNumber) ??
      asPositiveInt(nestedSource?.page);
    const matchedSrc = (sources ?? []).find((s) => s.id === sourceId);
    const label =
      asNonEmptyString(raw.sourceTitle) ||
      asNonEmptyString(nestedSource?.title) ||
      asNonEmptyString(matchedSrc?.title) ||
      asNonEmptyString(matchedSrc?.name) ||
      asNonEmptyString(matchedSrc?.filename) ||
      sourceId;
    source = { sourceId, ...(pageNumber !== undefined ? { pageNumber } : {}), label };
  }

  return {
    card,
    cardCount: validCards.length > 0 ? validCards.length : card ? 1 : 0,
    source,
  };
}

export const NotesView: React.FC<ViewProps> = memo(function NotesView({ host, width, height, isActive }) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const mathPref = useTuiStore((s) => s.preferences.mathUnicode);
  const snapshot = useTuiStore((s) => s.snapshot);
  const navNoteId = useTuiStore((s) => s.navContext.noteId);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const focusCourse = currentCourse(snapshot);
  const timeZone = useMemo(() => resolveRecapTimeZone(snapshot?.settings), [snapshot?.settings]);
  const today = useMemo(() => todayInTimeZone(timeZone), [timeZone]);

  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [dailyStatus, setDailyStatus] = useState<DailyRecapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string>(navNoteId || '');
  const [activeNote, setActiveNote] = useState<NoteItem | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [filterCourseOnly, setFilterCourseOnly] = useState(false);
  const [mathOverride, setMathOverride] = useState<boolean | null>(null);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [openingRef, setOpeningRef] = useState(false);

  const [modal, setModal] = useState<ActiveModal>(null);
  const [exportPath, setExportPath] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);

  const mountedRef = useRef(true);
  const listReqRef = useRef(0);
  const detailReqRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSelectIdRef = useRef<string | null>(navNoteId || null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const fetchNotesAndDaily = useCallback(
    async (silent = false) => {
      const reqId = ++listReqRef.current;
      if (!silent) setLoading(true);
      try {
        const [listRes, dailyRes] = await Promise.all([
          host.call<{ home?: string; notes?: NoteItem[] }>('note.list', {}),
          host.call<DailyRecapStatus>('note.daily.status', {
            timeZone,
            ...(focusCourse ? { course: focusCourse } : {}),
          }),
        ]);
        if (!mountedRef.current || listReqRef.current !== reqId) return;
        if (listRes.ok && Array.isArray(listRes.value?.notes)) {
          const fetchedNotes = listRes.value.notes;
          setNotes(fetchedNotes);
          setError('');
          const pendingId = pendingSelectIdRef.current;
          if (pendingId) {
            if (fetchedNotes.some((n) => n.id === pendingId)) {
              setSelectedId(pendingId);
            } else {
              pendingSelectIdRef.current = null;
            }
          }
        } else if (!listRes.ok) {
          setError(listRes.error?.message || t(lang, '无法读取笔记列表', 'Failed to load notes'));
        }
        if (dailyRes.ok && dailyRes.value) {
          setDailyStatus(dailyRes.value);
        }
      } catch (err) {
        if (!mountedRef.current || listReqRef.current !== reqId) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current && listReqRef.current === reqId) setLoading(false);
      }
    },
    [host, timeZone, focusCourse, lang],
  );

  useEffect(() => {
    void fetchNotesAndDaily(false);
  }, [fetchNotesAndDaily, snapshot?.revision]);

  // Subscribe to library changes so background recap/note updates appear automatically
  useEffect(() => {
    const unsub = host.subscribeEvents((evt) => {
      if (!mountedRef.current) return;
      const areas = evt.payload?.changedAreas;
      if (!Array.isArray(areas) || areas.includes('notes') || evt.type.includes('note')) {
        void fetchNotesAndDaily(true);
      }
    });
    return unsub;
  }, [host, fetchNotesAndDaily]);

  // Poll daily recap status while any group is running
  const anyRecapRunning = useMemo(
    () => Boolean(dailyStatus?.groups?.some((g) => g.generation?.status === 'running')),
    [dailyStatus],
  );
  useEffect(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!isActive || !anyRecapRunning) return undefined;
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      if (mountedRef.current) void fetchNotesAndDaily(true);
    }, 3000);
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isActive, anyRecapRunning, fetchNotesAndDaily]);

  // Sync navigation target noteId
  useEffect(() => {
    if (navNoteId) {
      pendingSelectIdRef.current = navNoteId;
      setSelectedId(navNoteId);
    }
  }, [navNoteId]);

  const sortedNotes = useMemo(() => {
    const filtered =
      filterCourseOnly && focusCourse
        ? notes.filter((n) => (n.courses || []).includes(focusCourse) || n.daily?.course === focusCourse)
        : notes;
    return [...filtered].sort((a, b) => {
      const aToday = Number(a.kind === 'daily-recap' && a.daily?.day === today);
      const bToday = Number(b.kind === 'daily-recap' && b.daily?.day === today);
      if (aToday !== bToday) return bToday - aToday;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  }, [notes, filterCourseOnly, focusCourse, today]);

  const selectedIndex = useMemo(() => {
    if (sortedNotes.length === 0) return -1;
    const idx = sortedNotes.findIndex((n) => n.id === selectedId);
    return idx >= 0 ? idx : 0;
  }, [sortedNotes, selectedId]);

  const selectedSummary = selectedIndex >= 0 ? sortedNotes[selectedIndex] : null;
  const isPendingSelection = Boolean(
    pendingSelectIdRef.current &&
      pendingSelectIdRef.current === selectedId &&
      !sortedNotes.some((n) => n.id === selectedId),
  );

  useEffect(() => {
    if (pendingSelectIdRef.current && pendingSelectIdRef.current === selectedId) {
      if (sortedNotes.some((n) => n.id === selectedId)) {
        pendingSelectIdRef.current = null;
        return;
      }
      if (!notes.some((n) => n.id === selectedId)) {
        return;
      }
      pendingSelectIdRef.current = null;
    }
    if (selectedSummary && selectedSummary.id !== selectedId) {
      setSelectedId(selectedSummary.id);
    }
  }, [notes, sortedNotes, selectedSummary, selectedId]);

  // Fetch full note detail when selection or revision changes
  const fetchDetail = useCallback(
    async (id: string) => {
      const reqId = ++detailReqRef.current;
      setLoadingDetail(true);
      try {
        const res = await host.call<NoteItem>('note.get', { id });
        if (!mountedRef.current || detailReqRef.current !== reqId) return;
        if (res.ok && res.value) {
          setActiveNote(res.value);
        }
      } finally {
        if (mountedRef.current && detailReqRef.current === reqId) setLoadingDetail(false);
      }
    },
    [host],
  );

  useEffect(() => {
    if (isPendingSelection) return;
    if (!selectedSummary?.id) {
      setActiveNote(null);
      return;
    }
    void fetchDetail(selectedSummary.id);
  }, [isPendingSelection, selectedSummary?.id, selectedSummary?.revision, selectedSummary?.updatedAt, fetchDetail]);

  const displayedNote = isPendingSelection
    ? activeNote?.id === selectedId
      ? activeNote
      : null
    : activeNote?.id === selectedSummary?.id
      ? activeNote
      : selectedSummary;

  const primaryRecapGroup: DailyRecapGroup | null = useMemo(() => {
    const groups = dailyStatus?.groups || [];
    if (groups.length === 0) return null;
    return groups.find((g) => g.eligible) || groups[0];
  }, [dailyStatus]);

  const triggerDailyRecap = useCallback(async () => {
    if (generatingRecap) return;
    const group = primaryRecapGroup;
    if (!group) {
      notify(t(lang, '今日暂无练习记录，完成同课程 10 题后可生成每日总结', 'No practice records today; complete 10 cards in a course to generate a daily recap'), 'info');
      return;
    }
    if (!group.eligible) {
      notify(
        t(
          lang,
          `「${group.course}」今日已练 ${group.answeredCount}/10 题，满 10 题可生成每日总结`,
          `"${group.course}": ${group.answeredCount}/10 answered today (10 needed for daily recap)`,
        ),
        'info',
      );
      return;
    }
    if (group.noteId && group.hasContent && !group.stale && group.generation?.status !== 'failed') {
      setSelectedId(group.noteId);
      setActivePane('right');
      notify(t(lang, '已定位到今日学习总结', 'Opened today’s daily recap'), 'info');
      return;
    }
    setGeneratingRecap(true);
    try {
      const res = await host.call<{ id?: string; status?: string }>('note.daily.generate', {
        course: group.courseId || group.course,
        day: group.day,
        timeZone: group.timeZone || timeZone,
        tone: group.tone || dailyStatus?.tone || 'friendly',
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '生成每日总结失败', 'Failed to generate daily recap'), 'error');
        return;
      }
      if (res.value?.id) {
        pendingSelectIdRef.current = res.value.id;
        setSelectedId(res.value.id);
      }
      if (res.value?.status === 'protected') {
        notify(t(lang, '该总结已被手动编辑保护，已打开现有内容', 'Recap has manual edits and is protected'), 'info');
      } else {
        notify(t(lang, '已启动今日学习总结生成', 'Started daily recap generation'), 'success');
      }
      await fetchNotesAndDaily(true);
    } finally {
      if (mountedRef.current) setGeneratingRecap(false);
    }
  }, [generatingRecap, primaryRecapGroup, notify, lang, host, timeZone, dailyStatus?.tone, fetchNotesAndDaily]);

  const handleDeleteNote = useCallback(
    async (target: NoteItem) => {
      setModal(null);
      const res = await host.call('note.delete', { id: target.id });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '删除笔记失败', 'Failed to delete note'), 'error');
        return;
      }
      notify(t(lang, `已删除「${target.title}」`, `Deleted "${target.title}"`), 'success');
      if (pendingSelectIdRef.current === target.id) pendingSelectIdRef.current = null;
      if (activeNote?.id === target.id) setActiveNote(null);
      await fetchNotesAndDaily(true);
      void refreshSnapshot();
    },
    [host, notify, lang, activeNote?.id, fetchNotesAndDaily, refreshSnapshot],
  );

  const handleExportConfirm = useCallback(async () => {
    if (!modal || modal.type !== 'export' || exporting) return;
    const resolved = expandUserPath(exportPath, host.getLibraryRoot());
    if (!resolved) {
      setExportError(t(lang, '请输入导出文件路径', 'Please enter a file path'));
      return;
    }
    setExporting(true);
    setExportError('');
    try {
      await mkdir(dirname(resolved), { recursive: true });
      const content = displayedNote?.markdown || `# ${modal.note.title}\n`;
      await writeFile(resolved, content, 'utf8');
      if (!mountedRef.current) return;
      setModal(null);
      notify(t(lang, `已导出到 ${resolved}`, `Exported to ${resolved}`), 'success');
    } catch (err) {
      if (mountedRef.current) {
        setExportError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) setExporting(false);
    }
  }, [modal, exporting, exportPath, host, lang, displayedNote?.markdown, notify]);

  const linkedRefs = useMemo(
    () => extractLinkedRefs(displayedNote, snapshot?.decks, snapshot?.sources),
    [displayedNote, snapshot?.decks, snapshot?.sources],
  );

  const openLinkedRef = useCallback(
    async (preferSource = false) => {
      if (!displayedNote || openingRef) return;
      if (!linkedRefs.card && !linkedRefs.source) {
        notify(t(lang, '该笔记暂未关联题卡或资料', 'This note has no linked card or source'), 'info');
        return;
      }
      if ((preferSource || !linkedRefs.card) && linkedRefs.source) {
        useTuiStore.getState().navigate('sources', {
          sourceId: linkedRefs.source.sourceId,
          ...(linkedRefs.source.pageNumber !== undefined ? { pageNumber: linkedRefs.source.pageNumber } : {}),
        });
        return;
      }
      if (linkedRefs.card) {
        setOpeningRef(true);
        try {
          const res = await host.call<{ id?: string }>('review.start', {
            mode: 'path',
            scope: [{ deckId: linkedRefs.card.deckId, cardId: linkedRefs.card.cardId }],
            fresh: true,
          });
          if (!mountedRef.current) return;
          if (!res.ok || !res.value?.id) {
            notify(res.error?.message || t(lang, '启动题卡练习失败', 'Failed to start card review'), 'error');
            return;
          }
          useTuiStore.getState().navigate('review', {
            runId: res.value.id,
            ...(linkedRefs.card.course ? { course: linkedRefs.card.course } : focusCourse ? { course: focusCourse } : {}),
          });
        } finally {
          if (mountedRef.current) setOpeningRef(false);
        }
      }
    },
    [displayedNote, openingRef, linkedRefs, notify, lang, host, focusCourse],
  );

  const noModalActive = isActive && modal === null;
  useClaimKeys(CLAIMED_KEYS, noModalActive);

  useInput(
    (input, key) => {
      if (key.tab) {
        setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if ((key.rightArrow || input === 'l') && activePane === 'left' && displayedNote) {
        setActivePane('right');
        return;
      }
      if ((key.leftArrow || input === 'h' || key.escape) && activePane === 'right') {
        setActivePane('left');
        return;
      }
      if (input === 'a') {
        setModal({ type: 'create' });
        return;
      }
      if (input === 'R') {
        void triggerDailyRecap();
        return;
      }
      if (input === 'f' && focusCourse) {
        setFilterCourseOnly((v) => !v);
        return;
      }
      if (input === 'm') {
        setMathOverride((prev) => !(prev ?? mathPref));
        return;
      }
      if (!displayedNote) return;
      if (input === 'o') {
        void openLinkedRef(false);
        return;
      }
      if (input === 'O' && linkedRefs.source) {
        void openLinkedRef(true);
        return;
      }
      if (input === 'e') {
        if (!isNoteWritable(displayedNote)) {
          notify(t(lang, '已发布笔记不能直接修改，请新建草稿', 'Published notes cannot be overwritten; create a new draft'), 'warning');
          return;
        }
        setModal({ type: 'edit', note: displayedNote });
        return;
      }
      if (input === 'x') {
        setExportPath(defaultExportPath(host.getLibraryRoot(), displayedNote.title));
        setExportError('');
        setModal({ type: 'export', note: displayedNote });
        return;
      }
      if (input === 'd') {
        setModal({ type: 'delete', note: displayedNote });
      }
    },
    { isActive: noModalActive },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'a', label: t(lang, '新建', 'New') },
      { key: 'e', label: t(lang, '编辑', 'Edit') },
      { key: 'o', label: t(lang, '打开关联', 'Open Ref') },
      { key: 'R', label: t(lang, '日结', 'Recap') },
      { key: 'x', label: t(lang, '导出', 'Export') },
      { key: 'd', label: t(lang, '删除', 'Del') },
      { key: 'm', label: t(lang, '公式', 'Math') },
      { key: 'Tab', label: t(lang, '切栏', 'Pane') },
    ],
    [lang],
  );
  useFooterHints(hints, isActive);

  const decksForModal = useMemo(
    () => (snapshot?.decks || []).filter((d) => !d.archived).map((d) => ({ id: d.id, title: d.title, course: d.course })),
    [snapshot?.decks],
  );

  const renderNoteRow = useCallback(
    (item: NoteItem, ctx: VirtualListRenderContext) => {
      const ell = asciiMode ? '...' : '…';
      const daily = isDailyNote(item);
      const isToday = daily && item.daily?.day === today;
      const icon = asciiMode
        ? item.generation?.status === 'running'
          ? '~'
          : daily
            ? '*'
            : item.status === 'published'
              ? '+'
              : '-'
        : item.generation?.status === 'running'
          ? '⟳'
          : daily
            ? '★'
            : item.status === 'published'
              ? '◈'
              : '✎';
      const dateStr = formatShortDate(item.updatedAt, lang);
      const countStr = daily
        ? `${item.daily?.answeredCount ?? item.cardCount ?? 0}${t(lang, '题', 'c')}`
        : `${item.cardCount ?? item.cards?.length ?? 0}${t(lang, '题', 'c')}`;
      const meta = lang === 'en' ? `${item.cardCount ?? item.cards?.length ?? 0}c ${dateStr}` : `${countStr} ${dateStr}`;
      const metaW = displayWidth(meta);
      const lead = `${ctx.selected ? (asciiMode ? '>' : '❯') : ' '} ${icon} `;
      const titleBudget = Math.max(6, ctx.width - displayWidth(lead) - metaW - 2);
      const titleText = padDisplay(truncateDisplay(item.title || t(lang, '无标题笔记', 'Untitled'), titleBudget, ell), titleBudget);
      const fg = ctx.selected ? (ctx.focused ? theme.selectionFg : theme.text) : theme.text;
      return (
        <Box width={ctx.width} height={1}>
          <Text color={ctx.selected ? theme.primary : isToday ? theme.warning : daily ? theme.accent : theme.dim}>{lead}</Text>
          <Text color={fg} bold={ctx.selected || isToday}>
            {titleText}
          </Text>
          <Text color={ctx.selected ? fg : theme.muted}>{` ${meta}`}</Text>
        </Box>
      );
    },
    [today, lang, asciiMode, theme],
  );

  const recapBannerText = useMemo(() => {
    if (!primaryRecapGroup) {
      return {
        status: 'idle' as const,
        title: t(lang, '今日总结：完成同课程 10 题后可生成 [R]', 'Daily Recap: answer 10 cards in a course [R]'),
      };
    }
    if (primaryRecapGroup.generation?.status === 'running') {
      const prog = primaryRecapGroup.generation.progress;
      const suffix = prog?.total ? ` (${prog.completed ?? 0}/${prog.total})` : '';
      return {
        status: 'busy' as const,
        title: t(lang, `正在整理「${primaryRecapGroup.course}」今日总结${suffix}…`, `Generating "${primaryRecapGroup.course}" recap${suffix}…`),
      };
    }
    if (!primaryRecapGroup.eligible) {
      return {
        status: 'idle' as const,
        title: t(
          lang,
          `${primaryRecapGroup.course} · 今日 ${primaryRecapGroup.answeredCount}/10 题`,
          `${primaryRecapGroup.course} · ${primaryRecapGroup.answeredCount}/10 today`,
        ),
      };
    }
    if (primaryRecapGroup.hasContent && !primaryRecapGroup.stale) {
      return {
        status: 'ok' as const,
        title: t(lang, `今日总结已就绪 · ${primaryRecapGroup.course} [R]`, `Recap ready · ${primaryRecapGroup.course} [R]`),
      };
    }
    return {
      status: 'ai' as const,
      title: t(
        lang,
        `[R] 生成「${primaryRecapGroup.course}」今日总结 (${primaryRecapGroup.answeredCount}题)`,
        `[R] Generate "${primaryRecapGroup.course}" recap (${primaryRecapGroup.answeredCount}q)`,
      ),
    };
  }, [primaryRecapGroup, lang]);

  const effectiveMath = mathOverride ?? mathPref;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <SplitPane
        width={width}
        height={height}
        leftWidth={0.38}
        minLeft={28}
        minRight={34}
        breakpoint={86}
        activePane={activePane}
        leftLabel={t(lang, `笔记 (${sortedNotes.length})`, `Notes (${sortedNotes.length})`)}
        rightLabel={t(lang, '正文阅读', 'Reader')}
        left={({ width: paneW, height: paneH }) => {
          const listH = Math.max(3, paneH - 6);
          return (
            <Panel
              title={t(lang, '学习笔记', 'Notes')}
              icon={asciiMode ? '-' : '✎'}
              badge={sortedNotes.length}
              subtitle={focusCourse && filterCourseOnly ? `${focusCourse} [f]` : focusCourse ? t(lang, '[f]筛选课程', '[f]Filter') : undefined}
              focused={activePane === 'left'}
              width={paneW}
              height={paneH}
            >
              <Box height={1} marginBottom={0} overflow="hidden">
                <StatusPill status={recapBannerText.status} label={truncateDisplay(recapBannerText.title, Math.max(10, paneW - 8), asciiMode ? '...' : '…')} />
              </Box>
              <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, paneW - 4))}</Text>
              {loading && sortedNotes.length === 0 ? (
                <Box height={listH} alignItems="center" justifyContent="center">
                  <Spinner label={t(lang, '载入笔记中…', 'Loading notes…')} active={isActive} />
                </Box>
              ) : error && sortedNotes.length === 0 ? (
                <EmptyState
                  title={t(lang, '加载笔记失败', 'Failed to load notes')}
                  hint={truncateDisplay(error, Math.max(16, paneW - 6))}
                  icon="!"
                  width={paneW - 4}
                  height={listH}
                />
              ) : (
                <VirtualList
                  items={sortedNotes}
                  width={Math.max(12, paneW - 4)}
                  height={listH}
                  selectedIndex={selectedIndex}
                  isActive={noModalActive && activePane === 'left'}
                  keyExtractor={(item) => item.id}
                  onChange={(_idx, item) => {
                    pendingSelectIdRef.current = null;
                    if (item) setSelectedId(item.id);
                  }}
                  onSelect={(item) => {
                    pendingSelectIdRef.current = null;
                    setSelectedId(item.id);
                    setActivePane('right');
                  }}
                  renderItem={renderNoteRow}
                  emptyText={t(lang, '还没有学习笔记', 'No study notes yet')}
                  emptyHint={t(lang, '按 a 新建笔记，或做满 10 题按 R 生成每日总结', 'Press a to create, or R for daily recap')}
                />
              )}
            </Panel>
          );
        }}
        right={({ width: paneW, height: paneH }) => {
          const readerW = Math.max(12, paneW - 4);
          const hasLinkRow = Boolean(displayedNote && (linkedRefs.card || linkedRefs.source));
          const readerH = Math.max(3, paneH - (hasLinkRow ? 6 : 5));
          if (!displayedNote) {
            return (
              <Panel title={t(lang, '笔记正文', 'Note Reader')} focused={activePane === 'right'} width={paneW} height={paneH}>
                <EmptyState
                  title={t(lang, '选择一篇笔记阅读', 'Select a note to read')}
                  hint={t(lang, '按 a 新建笔记 · 按 R 生成今日学习总结', 'Press a to create · R for daily recap')}
                  icon={asciiMode ? '-' : '✎'}
                  width={readerW}
                  height={readerH}
                />
              </Panel>
            );
          }
          const daily = isDailyNote(displayedNote);
          const coursesLabel = (displayedNote.courses || []).join(', ') || displayedNote.daily?.course || '';
          const cardTotal = displayedNote.cards?.length ?? displayedNote.cardCount ?? 0;
          const subtitle = [coursesLabel, `${cardTotal}${t(lang, '题', 'q')}`, effectiveMath ? '∑' : 'TeX'].filter(Boolean).join(' · ');
          const ell = asciiMode ? '...' : '…';
          return (
            <Panel
              title={displayedNote.title || t(lang, '学习笔记', 'Study Note')}
              badge={daily ? t(lang, '日结', 'Recap') : displayedNote.status === 'published' ? t(lang, '已发布', 'Published') : t(lang, '草稿', 'Draft')}
              badgeTone={daily ? 'ai' : displayedNote.status === 'published' ? 'success' : 'accent'}
              subtitle={subtitle}
              focused={activePane === 'right'}
              width={paneW}
              height={paneH}
            >
              <Box height={1} justifyContent="space-between" overflow="hidden">
                <Box gap={1}>
                  {displayedNote.generation?.status === 'running' ? (
                    <Spinner label={t(lang, 'AI 正在生成内容…', 'Generating…')} active={isActive} />
                  ) : loadingDetail ? (
                    <Text color={theme.muted}>{t(lang, '刷新正文…', 'Loading…')}</Text>
                  ) : (
                    <Text color={theme.muted}>
                      {daily && displayedNote.daily
                        ? `${displayedNote.daily.day || ''} · ${t(lang, `已练 ${displayedNote.daily.answeredCount ?? 0} 题 / 待回顾 ${displayedNote.daily.wrongCount ?? 0}`, `${displayedNote.daily.answeredCount ?? 0} answered / ${displayedNote.daily.wrongCount ?? 0} to review`)}`
                        : `${t(lang, '更新于', 'Updated')} ${formatShortDate(displayedNote.updatedAt, lang)}`}
                    </Text>
                  )}
                </Box>
                <Badge label={effectiveMath ? 'Unicode Math' : 'Raw LaTeX'} tone="info" variant="soft" />
              </Box>
              {hasLinkRow ? (
                <Box height={1} overflow="hidden" gap={1}>
                  {linkedRefs.card ? (
                    <Text color={theme.accent}>
                      {truncateDisplay(
                        `[o] ${t(lang, '关联题卡', 'Card')}: ${linkedRefs.card.label}${linkedRefs.cardCount > 1 ? ` (+${linkedRefs.cardCount - 1})` : ''}`,
                        linkedRefs.source ? Math.max(16, Math.floor(readerW * 0.55)) : readerW,
                        ell,
                      )}
                    </Text>
                  ) : null}
                  {linkedRefs.source ? (
                    <Text color={theme.info}>
                      {truncateDisplay(
                        `[${linkedRefs.card ? 'O' : 'o'}] ${t(lang, '关联资料', 'Source')}: ${linkedRefs.source.label}${linkedRefs.source.pageNumber !== undefined ? ` p.${linkedRefs.source.pageNumber}` : ''}`,
                        linkedRefs.card ? Math.max(14, Math.floor(readerW * 0.42)) : readerW,
                        ell,
                      )}
                    </Text>
                  ) : null}
                </Box>
              ) : null}
              <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, readerW))}</Text>
              <MarkdownView
                markdown={displayedNote.markdown || t(lang, '_（暂无正文内容，按 `e` 编辑）_', '_Empty note — press `e` to edit_')}
                width={readerW}
                height={readerH}
                isActive={noModalActive && activePane === 'right'}
                mathUnicode={effectiveMath}
              />
            </Panel>
          );
        }}
      />

      <Suspense fallback={null}>
        {modal?.type === 'create' || modal?.type === 'edit' ? (
          <NoteEditorModal
            mode={modal.type}
            host={host}
            lang={lang}
            note={modal.type === 'edit' ? modal.note : null}
            focusCourse={focusCourse}
            availableDecks={decksForModal}
            terminalRows={height}
            terminalCols={width}
            onClose={() => setModal(null)}
            onSaved={(saved, created) => {
              setModal(null);
              pendingSelectIdRef.current = saved.id;
              setSelectedId(saved.id);
              setActiveNote(saved);
              notify(
                created ? t(lang, `已创建笔记「${saved.title}」`, `Created "${saved.title}"`) : t(lang, '笔记已保存', 'Note saved'),
                'success',
              );
              void fetchNotesAndDaily(true);
              void refreshSnapshot();
            }}
          />
        ) : null}
      </Suspense>

      {modal?.type === 'export' ? (
        <Modal
          title={t(lang, '导出 Markdown 笔记', 'Export Note as Markdown')}
          icon={asciiMode ? '>' : '↗'}
          tone="accent"
          width={Math.max(50, Math.min(76, width - 6))}
          onClose={exporting ? undefined : () => setModal(null)}
          hints={[
            { key: 'Enter', label: t(lang, '导出', 'Export') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Box flexDirection="column" gap={1}>
            <Text color={theme.muted}>
              {t(lang, `笔记：${modal.note.title}`, `Note: ${modal.note.title}`)}
            </Text>
            <Text color={theme.text} bold>
              {t(lang, '保存路径（支持相对路径或 ~）：', 'Destination path (relative or ~ supported):')}
            </Text>
            <TextInput
              value={exportPath}
              onChange={setExportPath}
              onSubmit={() => void handleExportConfirm()}
              onCancel={() => setModal(null)}
              isActive={!exporting}
              width={modalContentWidth(Math.max(50, Math.min(76, width - 6))) - 2}
              prompt="› "
              captureInput={false}
            />
            {exportError ? <Text color={theme.error}>{`${asciiMode ? 'x' : '✕'} ${exportError}`}</Text> : null}
          </Box>
        </Modal>
      ) : null}

      {modal?.type === 'delete' ? (
        <ConfirmDialog
          title={t(lang, '删除笔记', 'Delete Note')}
          message={t(
            lang,
            `确定永久删除笔记「${modal.note.title}」吗？此操作不可恢复。`,
            `Permanently delete note "${modal.note.title}"? This cannot be undone.`,
          )}
          confirmLabel={t(lang, '删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          onConfirm={() => void handleDeleteNote(modal.note)}
          onCancel={() => setModal(null)}
        />
      ) : null}
    </Box>
  );
});
