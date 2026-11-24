import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner, StatusPill } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { computeProseLayout } from '../../components/Layout.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { formatReadingTimeLabel } from '../../render/longform.js';
import { buildFileHyperlinkUrl, formatOsc8Link } from '../../render/osc8.js';
import { useShellActions } from '../../shell/actions.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../../host/atomic-write.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import { currentCourse } from '../../shell/data.js';
import { t, useTuiStore } from '../../state/store.js';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import {
  expandUserPath,
  formatShortDate,
  getNotePublishUrl,
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
  | { type: 'delete'; note: NoteItem }
  | { type: 'link'; note: NoteItem }
  | { type: 'cancelRecap'; noteId: string; label: string }
  | { type: 'confirm-generate'; note: NoteItem }
  | { type: 'confirm-cancel-gen'; note: NoteItem };

const CLAIMED_KEYS = ['a', 'g', 'o', 'R', 'L', 'C', 'M', '/'] as const;

function matchesNoteFilter(note: NoteItem, normalizedQuery: string): boolean {
  const raw = note as unknown as Record<string, unknown>;
  const parts: string[] = [note.title || '', note.markdown || ''];
  if (typeof raw.content === 'string') parts.push(raw.content);
  if (typeof raw.body === 'string') parts.push(raw.body);
  if (typeof raw.course === 'string') parts.push(raw.course);
  if (note.daily?.course) parts.push(note.daily.course);
  if (Array.isArray(note.courses)) {
    for (const c of note.courses) {
      if (typeof c === 'string') parts.push(c);
    }
  }
  if (Array.isArray(raw.tags)) {
    for (const tag of raw.tags) {
      if (typeof tag === 'string') parts.push(tag);
    }
  } else if (typeof raw.tags === 'string') {
    parts.push(raw.tags);
  }
  return parts.some((part) => part.toLowerCase().includes(normalizedQuery));
}

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
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);

  const [modal, setModal] = useState<ActiveModal>(null);
  const [exportPath, setExportPath] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [csdnHome, setCsdnHome] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkHome, setLinkHome] = useState('');
  const [linkField, setLinkField] = useState<'url' | 'home'>('url');
  const [linkError, setLinkError] = useState('');
  const [linking, setLinking] = useState(false);
  const [cancellingRecap, setCancellingRecap] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [cancellingGen, setCancellingGen] = useState(false);

  const mountedRef = useRef(true);
  const listReqRef = useRef(0);
  const detailReqRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSelectIdRef = useRef<string | null>(navNoteId || null);
  const linkingRef = useRef(false);
  const cancellingRecapRef = useRef(false);
  const generatingRef = useRef(false);
  const cancellingGenRef = useRef(false);
  const importMaterialBusyRef = useRef(false);

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
          if (typeof listRes.value.home === 'string') setCsdnHome(listRes.value.home);
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

  // Poll recap / note generation status while any job is running
  const anyRecapRunning = useMemo(
    () => Boolean(dailyStatus?.groups?.some((g) => g.generation?.status === 'running')),
    [dailyStatus],
  );
  const anyGenRunning = useMemo(
    () => anyRecapRunning || notes.some((n) => n.generation?.status === 'running'),
    [anyRecapRunning, notes],
  );
  useEffect(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!isActive || !anyGenRunning) return undefined;
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
  }, [isActive, anyGenRunning, fetchNotesAndDaily]);

  // Sync navigation target noteId
  useEffect(() => {
    if (navNoteId) {
      pendingSelectIdRef.current = navNoteId;
      setSelectedId(navNoteId);
    }
  }, [navNoteId]);

  const courseScopedNotes = useMemo(() => {
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

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const sortedNotes = useMemo(() => {
    if (!normalizedFilter) return courseScopedNotes;
    return courseScopedNotes.filter((n) => matchesNoteFilter(n, normalizedFilter));
  }, [courseScopedNotes, normalizedFilter]);

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
  }, [
    isPendingSelection,
    selectedSummary?.id,
    selectedSummary?.revision,
    selectedSummary?.updatedAt,
    selectedSummary?.generation?.status,
    fetchDetail,
  ]);

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

  const runningRecapTarget = useMemo(() => {
    if (displayedNote && isDailyNote(displayedNote) && displayedNote.generation?.status === 'running') {
      return { id: displayedNote.id, label: displayedNote.title || displayedNote.daily?.course || '' };
    }
    const runningNote = notes.find((n) => isDailyNote(n) && n.generation?.status === 'running');
    if (runningNote) {
      return { id: runningNote.id, label: runningNote.title || runningNote.daily?.course || '' };
    }
    const runningGroup = dailyStatus?.groups?.find((g) => g.generation?.status === 'running' && g.noteId);
    if (runningGroup?.noteId) {
      return { id: runningGroup.noteId, label: runningGroup.course || runningGroup.day || '' };
    }
    return null;
  }, [displayedNote, notes, dailyStatus]);

  const handleSaveHome = useCallback(async () => {
    if (linkingRef.current || linking) return;
    const trimmed = linkHome.trim();
    if (!trimmed) {
      setLinkError(t(lang, '请输入 CSDN 公开博客主页', 'Please enter CSDN public blog home URL'));
      return;
    }
    linkingRef.current = true;
    setLinking(true);
    setLinkError('');
    try {
      const res = await host.call<{ home?: string }>('note.home', { home: trimmed });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setLinkError(res.error?.message || t(lang, '保存 CSDN 主页失败', 'Failed to save CSDN home'));
        return;
      }
      const savedHome = res.value?.home || trimmed;
      setCsdnHome(savedHome);
      setLinkHome(savedHome);
      setLinkField('url');
      notify(t(lang, 'CSDN 公开主页已保存', 'CSDN home saved'), 'success');
    } catch (err) {
      if (mountedRef.current) {
        setLinkError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      linkingRef.current = false;
      if (mountedRef.current) setLinking(false);
    }
  }, [linking, linkHome, lang, host, notify]);

  const handleLinkConfirm = useCallback(async () => {
    if (!modal || modal.type !== 'link' || linkingRef.current || linking) return;
    const trimmedUrl = linkUrl.trim();
    if (!trimmedUrl) {
      setLinkError(t(lang, '请输入公开文章链接', 'Please enter a published article URL'));
      return;
    }
    linkingRef.current = true;
    setLinking(true);
    setLinkError('');
    try {
      const res = await host.call<NoteItem>('note.link', {
        id: modal.note.id,
        url: trimmedUrl,
        expectedRevision: modal.note.revision ?? 0,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setLinkError(res.error?.message || t(lang, '关联公开链接失败', 'Failed to link published URL'));
        return;
      }
      if (res.value) {
        setActiveNote(res.value);
      }
      setModal(null);
      notify(t(lang, '公开文章链接已关联', 'Published link saved'), 'success');
      await fetchNotesAndDaily(true);
      void refreshSnapshot();
    } catch (err) {
      if (mountedRef.current) {
        setLinkError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      linkingRef.current = false;
      if (mountedRef.current) setLinking(false);
    }
  }, [modal, linking, linkUrl, lang, host, notify, fetchNotesAndDaily, refreshSnapshot]);

  const handlePreparePublish = useCallback(async () => {
    if (!modal || modal.type !== 'link' || linkingRef.current || linking) return;
    linkingRef.current = true;
    setLinking(true);
    setLinkError('');
    try {
      const res = await tryAction<{ autoLookupReady?: boolean; reason?: string }>(host, 'note.preparePublish', {
        id: modal.note.id,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setLinkError(errorMessage(res.error, lang) || t(lang, '准备发布失败', 'Failed to prepare publish'));
        return;
      }
      if (res.value?.autoLookupReady) {
        notify(
          t(
            lang,
            '已记录 CSDN 发布基线，发布后按 Ctrl+L 自动查找关联',
            'Baseline recorded; press Ctrl+L after publishing to auto-lookup',
          ),
          'success',
        );
        await fetchNotesAndDaily(true);
      } else {
        setLinkError(
          res.value?.reason ||
            t(lang, '尚未设置 CSDN 公开主页，发布后可手动关联', 'CSDN home not set; link manually after publishing'),
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        setLinkError(errorMessage(err, lang));
      }
    } finally {
      linkingRef.current = false;
      if (mountedRef.current) setLinking(false);
    }
  }, [modal, linking, host, lang, notify, fetchNotesAndDaily]);

  const handleLookupPublished = useCallback(async () => {
    if (!modal || modal.type !== 'link' || linkingRef.current || linking) return;
    linkingRef.current = true;
    setLinking(true);
    setLinkError('');
    try {
      const res = await tryAction<{
        linked?: NoteItem;
        matched?: boolean;
        matches?: string[];
        reason?: string;
      }>(host, 'note.lookup', {
        id: modal.note.id,
        expectedRevision: modal.note.revision ?? 0,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setLinkError(errorMessage(res.error, lang) || t(lang, '自动查找公开文章失败', 'Failed to lookup published article'));
        return;
      }
      if (res.value?.linked) {
        setActiveNote(res.value.linked);
        setModal(null);
        notify(t(lang, '已自动匹配并关联公开文章', 'Auto-matched and linked published article'), 'success');
        await fetchNotesAndDaily(true);
        if (mountedRef.current) void refreshSnapshot();
        return;
      }
      if (Array.isArray(res.value?.matches) && res.value.matches[0]) {
        setLinkUrl(res.value.matches[0]);
        setLinkField('url');
        setLinkError(
          res.value.reason ||
            t(lang, '找到候选文章，请核对链接后按 Enter 保存', 'Found candidate article; verify URL and press Enter to save'),
        );
        return;
      }
      setLinkError(
        res.value?.reason ||
          errorMessage(res.error, lang) ||
          t(lang, '未找到匹配的公开文章', 'No matching published article found'),
      );
    } catch (err) {
      if (mountedRef.current) {
        setLinkError(errorMessage(err, lang));
      }
    } finally {
      linkingRef.current = false;
      if (mountedRef.current) setLinking(false);
    }
  }, [modal, linking, host, lang, notify, fetchNotesAndDaily, refreshSnapshot]);

  const handleCancelRecapConfirm = useCallback(
    async (noteId: string) => {
      if (cancellingRecapRef.current || cancellingRecap) return;
      cancellingRecapRef.current = true;
      setCancellingRecap(true);
      setModal(null);
      try {
        const res = await host.call<NoteItem>('note.daily.cancel', { id: noteId });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '取消每日总结失败', 'Failed to cancel daily recap'), 'error');
          return;
        }
        if (res.value && activeNote?.id === noteId) {
          setActiveNote(res.value);
        }
        notify(t(lang, '已停止每日总结生成，已完成内容已保留', 'Daily recap generation cancelled; completed content kept'), 'info');
        await fetchNotesAndDaily(true);
        void refreshSnapshot();
      } catch (err) {
        if (mountedRef.current) {
          notify(err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        cancellingRecapRef.current = false;
        if (mountedRef.current) setCancellingRecap(false);
      }
    },
    [cancellingRecap, host, lang, notify, activeNote?.id, fetchNotesAndDaily, refreshSnapshot],
  );

  const handleGenerateConfirm = useCallback(
    async (note: NoteItem) => {
      if (generatingRef.current) return;
      generatingRef.current = true;
      setGeneratingDraft(true);
      setModal(null);
      try {
        const res = await tryAction<{ id?: string; jobId?: string; status?: string }>(host, 'note.generate', {
          id: note.id,
          expectedRevision: note.revision ?? 0,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(
            errorMessage(res.error, lang) || t(lang, '启动 AI 笔记起草失败', 'Failed to start AI note drafting'),
            'error',
          );
          return;
        }
        notify(t(lang, '已启动 AI 笔记起草任务', 'Started AI note drafting job'), 'success');
        await Promise.all([fetchNotesAndDaily(true), fetchDetail(note.id)]);
        if (!mountedRef.current) return;
        void refreshSnapshot();
      } catch (err) {
        if (mountedRef.current) {
          notify(errorMessage(err, lang), 'error');
        }
      } finally {
        generatingRef.current = false;
        if (mountedRef.current) setGeneratingDraft(false);
      }
    },
    [host, lang, notify, fetchNotesAndDaily, fetchDetail, refreshSnapshot],
  );

  const handleCancelGenConfirm = useCallback(
    async (note: NoteItem) => {
      if (cancellingGenRef.current || cancellingGen) return;
      cancellingGenRef.current = true;
      setCancellingGen(true);
      setModal(null);
      try {
        const res = await tryAction<NoteItem>(host, 'note.cancel', { id: note.id });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(
            errorMessage(res.error, lang) || t(lang, '停止笔记 AI 起草失败', 'Failed to stop note AI drafting'),
            'error',
          );
          return;
        }
        if (res.value && activeNote?.id === note.id) {
          setActiveNote(res.value);
        }
        notify(t(lang, '已停止笔记 AI 起草', 'Stopped note AI drafting'), 'info');
        await fetchNotesAndDaily(true);
        if (!mountedRef.current) return;
        void refreshSnapshot();
      } catch (err) {
        if (mountedRef.current) {
          notify(errorMessage(err, lang), 'error');
        }
      } finally {
        cancellingGenRef.current = false;
        if (mountedRef.current) setCancellingGen(false);
      }
    },
    [cancellingGen, host, lang, notify, activeNote?.id, fetchNotesAndDaily, refreshSnapshot],
  );

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

  const handleImportNoteToSources = useCallback(async () => {
    if (!displayedNote || importMaterialBusyRef.current) return;
    importMaterialBusyRef.current = true;
    try {
      const prep = await tryAction<{ id: string; title: string; text: string; format?: string; courses?: string[] }>(
        host,
        'note.material.prepare',
        { id: displayedNote.id, expectedRevision: displayedNote.revision ?? 0 },
      );
      if (!mountedRef.current) return;
      if (!prep.ok || !prep.value) {
        const rawMsg = prep.error?.message || '';
        const msg = rawMsg.includes('请先生成或填写正文')
          ? t(lang, '请先生成或填写正文。', 'Please generate or enter note content first.')
          : rawMsg || t(lang, '导入资料库失败', 'Failed to prepare note for Sources');
        notify(msg, 'error');
        return;
      }
      const material = prep.value;
      const existing = await tryAction<{ id: string }>(host, 'source.get', { id: material.id, limit: 1 });
      if (!mountedRef.current) return;
      if (existing.ok && existing.value) {
        notify(
          t(
            lang,
            `笔记「${material.title}」已在资料库中（无需重复导入）`,
            `Note "${material.title}" is already in Sources library`,
          ),
          'info',
        );
        return;
      }
      const added = await tryAction<{ id: string }>(host, 'source.add', {
        id: material.id,
        title: material.title,
        text: material.text,
        format: material.format ?? 'md',
        courses: Array.isArray(material.courses) ? material.courses : [],
      });
      if (!mountedRef.current) return;
      if (!added.ok) {
        const errMsg = added.error?.message || '';
        if (/already exists/i.test(errMsg)) {
          notify(
            t(
              lang,
              `笔记「${material.title}」已在资料库中（无需重复导入）`,
              `Note "${material.title}" is already in Sources library`,
            ),
            'info',
          );
          return;
        }
        notify(errMsg || t(lang, '导入资料库失败', 'Failed to import note to Sources'), 'error');
        return;
      }
      await refreshSnapshot();
      if (!mountedRef.current) return;
      notify(
        t(
          lang,
          `已将笔记「${material.title}」导入资料库（可在资料库阅读或据此出题）`,
          `Imported note "${material.title}" to Sources library`,
        ),
        'success',
      );
    } finally {
      importMaterialBusyRef.current = false;
    }
  }, [displayedNote, host, lang, notify, refreshSnapshot]);

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
      const content =
        (displayedNote?.id === modal.note.id ? displayedNote.markdown : undefined) ||
        modal.note.markdown ||
        `# ${modal.note.title}\n`;
      const written = await atomicWriteExportText(resolved, content);
      if (!mountedRef.current) return;
      setModal(null);
      notify(t(lang, `已导出到 ${written.path}`, `Exported to ${written.path}`), 'success');
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

  const busy = generatingRecap || generatingDraft || cancellingRecap || cancellingGen || openingRef || exporting || linking;
  const noModalActive = isActive && modal === null;
  useClaimKeys(CLAIMED_KEYS, noModalActive && !filterEditing);

  useInput(
    (input, key) => {
      if (key.ctrl && (input === 'p' || input === 'P')) {
        void handlePreparePublish();
        return;
      }
      if (key.ctrl && (input === 'l' || input === 'L')) {
        void handleLookupPublished();
      }
    },
    { isActive: isActive && modal?.type === 'link' },
  );

  useInput(
    (input, key) => {
      if (!noModalActive || filterEditing) return;
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
      if (key.escape && filterQuery) {
        setFilterQuery('');
        return;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setFilterEditing(true);
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
      if (input === 'C') {
        if (busy) return;
        if (displayedNote && !isDailyNote(displayedNote) && displayedNote.generation?.status === 'running') {
          setModal({ type: 'confirm-cancel-gen', note: displayedNote });
          return;
        }
        if (!runningRecapTarget) {
          notify(t(lang, '当前没有正在生成的每日总结', 'No daily recap is currently running'), 'info');
          return;
        }
        setModal({ type: 'cancelRecap', noteId: runningRecapTarget.id, label: runningRecapTarget.label });
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
      if (input === 'g') {
        if (busy) return;
        if (isDailyNote(displayedNote)) {
          notify(t(lang, '每日总结请按 [R] 更新今日总结', 'Use [R] to update Daily Recap'), 'info');
          return;
        }
        if (displayedNote.status !== 'draft') {
          notify(t(lang, '已发布笔记不能重新 AI 起草', 'Published notes cannot be re-drafted by AI'), 'warning');
          return;
        }
        if (displayedNote.generation?.status === 'running') {
          notify(t(lang, '该笔记正在 AI 起草中（按 [C] 可停止）', 'Note draft is already running (press [C] to stop)'), 'info');
          return;
        }
        setModal({ type: 'confirm-generate', note: displayedNote });
        return;
      }
      if (input === 'o') {
        void openLinkedRef(false);
        return;
      }
      if (input === 'O' && linkedRefs.source) {
        void openLinkedRef(true);
        return;
      }
      if (input === 'L') {
        setLinkUrl(getNotePublishUrl(displayedNote));
        setLinkHome(csdnHome);
        setLinkField('url');
        setLinkError('');
        setModal({ type: 'link', note: displayedNote });
        return;
      }
      if (input === 'M') {
        void handleImportNoteToSources();
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
        setExportPath(
          defaultBackupFilePath(
            host.getLibraryRoot(),
            'studyhub-note',
            'md',
            displayedNote.title || displayedNote.daily?.course,
          ),
        );
        setExportError('');
        setModal({ type: 'export', note: displayedNote });
        return;
      }
      if (input === 'd') {
        setModal({ type: 'delete', note: displayedNote });
      }
    },
    { isActive: noModalActive && !filterEditing },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'a', label: t(lang, '新建', 'New') },
      { key: 'e', label: t(lang, '编辑', 'Edit') },
      { key: 'g', label: t(lang, 'AI起草', 'AI Draft') },
      { key: 'o', label: t(lang, '打开关联', 'Open Ref') },
      { key: 'L', label: t(lang, '外链', 'Link') },
      { key: 'M', label: t(lang, '入资料库', 'To Sources') },
      { key: 'R', label: t(lang, '日结', 'Recap') },
      ...(anyRecapRunning || displayedNote?.generation?.status === 'running'
        ? [{ key: 'C', label: t(lang, '停生成', 'Stop Gen') }]
        : []),
      { key: 'x', label: t(lang, '导出', 'Export') },
      { key: 'd', label: t(lang, '删除', 'Del') },
      { key: 'm', label: t(lang, '公式', 'Math') },
      { key: 'Tab', label: t(lang, '切栏', 'Pane') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
    ],
    [lang, anyRecapRunning, displayedNote?.generation?.status],
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
      const ell = asciiMode ? '...' : '…';
      return {
        status: 'busy' as const,
        title: t(
          lang,
          `正在整理「${primaryRecapGroup.course}」今日总结${suffix}${ell}`,
          `Generating "${primaryRecapGroup.course}" recap${suffix}${ell}`,
        ),
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
  }, [primaryRecapGroup, lang, asciiMode]);

  const effectiveMath = mathOverride ?? mathPref;
  const ell = asciiMode ? '...' : '…';
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${sortedNotes.length}/${courseScopedNotes.length}] `;
  const filterRightHint =
    width >= 66
      ? ` ${filterEditing ? t(lang, 'Enter 确认 | Esc 清除', 'Enter apply | Esc clear') : t(lang, '/ 编辑 | Esc 清除', '/ edit | Esc clear')}`
      : width >= 46
        ? ' Esc'
        : '';
  const filterInputW = Math.max(8, width - 2 - displayWidth(filterBadge) - displayWidth(filterRightHint) - 3);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {showFilterBar ? (
        <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
          <Text color={filterEditing ? theme.primary : theme.accent} bold>
            {filterBadge}
          </Text>
          <Box flexGrow={1} overflow="hidden">
            <TextInput
              value={filterQuery}
              onChange={setFilterQuery}
              onSubmit={(val) => {
                if (!val.trim()) setFilterQuery('');
                setFilterEditing(false);
              }}
              onCancel={() => {
                setFilterQuery('');
                setFilterEditing(false);
              }}
              isActive={noModalActive && filterEditing}
              width={filterInputW}
              prompt="/"
              placeholder={t(lang, `标题/正文/课程/标签${ell}`, `title/content/course/tag${ell}`)}
              maxLength={120}
            />
          </Box>
          {filterRightHint ? (
            <Text color={theme.dim} wrap="truncate">
              {filterRightHint}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <SplitPane
        width={width}
        height={Math.max(8, height - filterBarH)}
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
                  <Spinner
                    label={asciiMode ? t(lang, '载入笔记中...', 'Loading notes...') : t(lang, '载入笔记中…', 'Loading notes…')}
                    active={isActive}
                  />
                </Box>
              ) : error && sortedNotes.length === 0 ? (
                <EmptyState
                  title={t(lang, '加载笔记失败', 'Failed to load notes')}
                  hint={error}
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
                  isActive={noModalActive && !filterEditing && activePane === 'left'}
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
                  emptyText={normalizedFilter ? t(lang, '没有匹配的笔记', 'No matching notes') : t(lang, '还没有学习笔记', 'No study notes yet')}
                  emptyHint={
                    normalizedFilter
                      ? t(lang, '按 Esc 清除筛选条件', 'Press Esc to clear filter')
                      : t(lang, '按 a 新建笔记，或做满 10 题按 R 生成每日总结', 'Press a to create, or R for daily recap')
                  }
                />
              )}
            </Panel>
          );
        }}
        right={({ width: paneW, height: paneH }) => {
          const readerW = Math.max(12, paneW - 4);
          const publishUrl = getNotePublishUrl(displayedNote);
          const hasLinkRow = Boolean(displayedNote && (linkedRefs.card || linkedRefs.source));
          const hasPublishRow = Boolean(displayedNote && publishUrl);
          const headerExtraRows = (hasLinkRow ? 1 : 0) + (hasPublishRow ? 1 : 0);
          const readerH = Math.max(3, paneH - (5 + headerExtraRows));
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
          const subtitle = [coursesLabel, `${cardTotal}${t(lang, '题', 'q')}`, effectiveMath ? (asciiMode ? 'Math' : '∑') : 'TeX'].filter(Boolean).join(' · ');
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
                    <Spinner
                      label={asciiMode ? t(lang, 'AI 正在生成内容...', 'Generating...') : t(lang, 'AI 正在生成内容…', 'Generating…')}
                      active={isActive}
                    />
                  ) : loadingDetail ? (
                    <Text color={theme.muted}>
                      {asciiMode ? t(lang, '刷新正文...', 'Loading...') : t(lang, '刷新正文…', 'Loading…')}
                    </Text>
                  ) : (
                    <Text color={theme.muted}>
                      {(() => {
                        const readTime = displayedNote.markdown ? formatReadingTimeLabel(displayedNote.markdown, lang) : '';
                        const sep = asciiMode ? ' - ' : ' · ';
                        const base =
                          daily && displayedNote.daily
                            ? `${displayedNote.daily.day || ''}${sep}${t(lang, `已练 ${displayedNote.daily.answeredCount ?? 0} 题 / 待回顾 ${displayedNote.daily.wrongCount ?? 0}`, `${displayedNote.daily.answeredCount ?? 0} answered / ${displayedNote.daily.wrongCount ?? 0} to review`)}`
                            : `${t(lang, '更新于', 'Updated')} ${formatShortDate(displayedNote.updatedAt, lang)}`;
                        return readTime ? `${base}${sep}${readTime}` : base;
                      })()}
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
                      {(() => {
                        const rawLabel = truncateDisplay(
                          `[${linkedRefs.card ? 'O' : 'o'}] ${t(lang, '关联资料', 'Source')}: ${linkedRefs.source.label}${linkedRefs.source.pageNumber !== undefined ? ` p.${linkedRefs.source.pageNumber}` : ''}`,
                          linkedRefs.card ? Math.max(14, Math.floor(readerW * 0.42)) : readerW,
                          ell,
                        );
                        const src = snapshot?.sources?.find((s) => s.id === linkedRefs.source?.sourceId);
                        const rawPath =
                          (typeof src?.filePath === 'string' && src.filePath) ||
                          (typeof src?.path === 'string' && src.path) ||
                          '';
                        const url = rawPath ? buildFileHyperlinkUrl(rawPath, linkedRefs.source.pageNumber) : '';
                        return formatOsc8Link(rawLabel, url, { asciiMode });
                      })()}
                    </Text>
                  ) : null}
                </Box>
              ) : null}
              {hasPublishRow ? (
                <Box height={1} overflow="hidden" gap={1}>
                  <Badge label={t(lang, '外链', 'Link')} tone="success" variant="soft" />
                  <Text color={theme.info}>
                    {formatOsc8Link(truncateDisplay(publishUrl, Math.max(10, readerW - 9), ell), publishUrl, { asciiMode })}
                  </Text>
                </Box>
              ) : null}
              <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, readerW))}</Text>
              {(() => {
                const { proseWidth, marginLeft } = computeProseLayout(readerW);
                return (
                  <Box width={readerW} height={readerH} paddingLeft={marginLeft} overflow="hidden">
                    <MarkdownView
                      markdown={
                        displayedNote.markdown ||
                        (displayedNote.status === 'published' && !daily
                          ? t(lang, '_（已关联公开文章，按 `L` 更新外链）_', '_Published externally — press `L` to update link_')
                          : t(lang, '_（暂无正文内容，按 `e` 编辑）_', '_Empty note — press `e` to edit_'))
                      }
                      width={proseWidth}
                      height={readerH}
                      isActive={noModalActive && !filterEditing && activePane === 'right'}
                      mathUnicode={effectiveMath}
                    />
                  </Box>
                );
              })()}
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
              prompt={asciiMode ? '> ' : '› '}
              captureInput={false}
            />
            {exportError ? <Text color={theme.error}>{`${asciiMode ? 'x' : '✕'} ${exportError}`}</Text> : null}
          </Box>
        </Modal>
      ) : null}

      {modal?.type === 'link' ? (
        (() => {
          const linkModalWidth = Math.max(50, Math.min(76, width - 6));
          const linkInnerWidth = modalContentWidth(linkModalWidth);
          const ell = asciiMode ? '...' : '…';
          return (
            <Modal
              title={t(lang, '关联公开文章链接', 'Link Published Article URL')}
              subtitle={linkField === 'home' ? t(lang, 'Tab 切到文章链接', 'Tab: Article URL') : t(lang, 'Tab 设置主页', 'Tab: CSDN Home')}
              icon={asciiMode ? '>' : '↗'}
              tone="accent"
              width={linkModalWidth}
              onClose={linking ? undefined : () => setModal(null)}
              hints={[
                { key: 'Ctrl+P', label: t(lang, '准备发布', 'Prepare') },
                { key: 'Ctrl+L', label: t(lang, '自动查找', 'Lookup') },
                { key: 'Enter', label: t(lang, '保存', 'Save') },
                { key: 'Esc', label: t(lang, '关闭', 'Close') },
              ]}
            >
              <Box flexDirection="column" gap={1}>
                <Text color={theme.muted}>
                  {truncateDisplay(t(lang, `笔记：${modal.note.title}`, `Note: ${modal.note.title}`), linkInnerWidth, ell)}
                </Text>
                {linkField === 'home' ? (
                  <>
                    <Text color={theme.text} bold>
                      {t(lang, 'CSDN 公开主页（如 https://blog.csdn.net/username）：', 'CSDN Public Home (e.g. https://blog.csdn.net/username):')}
                    </Text>
                    <TextInput
                      value={linkHome}
                      onChange={setLinkHome}
                      onSubmit={() => void handleSaveHome()}
                      onCancel={() => setModal(null)}
                      onTab={() => {
                        setLinkField('url');
                        setLinkError('');
                      }}
                      isActive={!linking}
                      width={linkInnerWidth - 2}
                      placeholder="https://blog.csdn.net/username"
                      prompt={asciiMode ? '> ' : '› '}
                      captureInput={false}
                    />
                  </>
                ) : (
                  <>
                    <Text color={theme.muted}>
                      {truncateDisplay(
                        csdnHome
                          ? t(lang, `CSDN 主页: ${csdnHome} (Tab 修改)`, `CSDN Home: ${csdnHome} (Tab to edit)`)
                          : t(lang, '未设置 CSDN 主页（按 Tab 填写主页）', 'CSDN Home not set (press Tab to configure)'),
                        linkInnerWidth,
                        ell,
                      )}
                    </Text>
                    <Text color={theme.text} bold>
                      {t(lang, '公开文章链接：', 'Published article URL:')}
                    </Text>
                    <TextInput
                      value={linkUrl}
                      onChange={setLinkUrl}
                      onSubmit={() => void handleLinkConfirm()}
                      onCancel={() => setModal(null)}
                      onTab={() => {
                        setLinkField('home');
                        setLinkError('');
                      }}
                      isActive={!linking}
                      width={linkInnerWidth - 2}
                      placeholder="https://blog.csdn.net/username/article/details/123456"
                      prompt={asciiMode ? '> ' : '› '}
                      captureInput={false}
                    />
                  </>
                )}
                {linkError ? <Text color={theme.error}>{`${asciiMode ? 'x' : '✕'} ${linkError}`}</Text> : null}
              </Box>
            </Modal>
          );
        })()
      ) : null}

      {modal?.type === 'confirm-generate' ? (
        <ConfirmDialog
          title={t(lang, 'AI 起草笔记正文', 'AI Draft Note')}
          message={(() => {
            const cardCount = modal.note.cardCount ?? modal.note.cards?.length ?? 0;
            return t(
              lang,
              `将调用已配置模型为笔记「${modal.note.title}」（关联 ${cardCount} 张题卡）起草正文。继续吗？`,
              `Invoke the configured model to draft "${modal.note.title}" (${cardCount} linked card${cardCount === 1 ? '' : 's'}). Continue?`,
            );
          })()}
          confirmLabel={t(lang, '开始起草', 'Generate')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          onConfirm={() => void handleGenerateConfirm(modal.note)}
          onCancel={() => setModal(null)}
        />
      ) : null}

      {modal?.type === 'confirm-cancel-gen' ? (
        <ConfirmDialog
          title={t(lang, '停止 AI 起草笔记', 'Stop AI Note Draft')}
          message={t(
            lang,
            `确定停止「${modal.note.title}」的 AI 起草吗？`,
            `Stop AI drafting for "${modal.note.title}"?`,
          )}
          confirmLabel={t(lang, '停止起草', 'Stop')}
          cancelLabel={t(lang, '继续生成', 'Keep Running')}
          danger
          onConfirm={() => void handleCancelGenConfirm(modal.note)}
          onCancel={() => setModal(null)}
        />
      ) : null}

      {modal?.type === 'cancelRecap' ? (
        <ConfirmDialog
          title={t(lang, '停止生成每日总结', 'Cancel Daily Recap')}
          message={t(
            lang,
            `确定停止「${modal.label || '今日学习总结'}」的生成吗？已完成的部分会保留。`,
            `Stop generating "${modal.label || 'Daily Recap'}"? Completed sections will be kept.`,
          )}
          confirmLabel={t(lang, '停止生成', 'Stop')}
          cancelLabel={t(lang, '继续生成', 'Keep Running')}
          danger
          onConfirm={() => void handleCancelRecapConfirm(modal.noteId)}
          onCancel={() => setModal(null)}
        />
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
