import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { KeyHint, StudySnapshot, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, Divider, EmptyState, ProgressBar, StatusPill } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { ChromeLabel, LAYOUT_BP, Prose, computeFilterBarLayout } from '../../layout/index.js';
import { useFooterHints } from '../../components/hooks.js';
import { ClickableBox } from '../../components/mouse.js';
import { saveTuiPreferences } from '../../host/tui-prefs.js';
import { useTheme } from '../../theme/tokens.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { currentCourse, deckDueCount, dueToday, isActiveStudyDeck } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { getSampleStatus, removeSampleCourse, tryAction } from '../../host/sample-actions.js';
import type { DeckExportInput } from './deck-export.js';
import { buildDailyBriefing } from './daily-briefing.js';
import { buildTodayHubItems, buildTodayHubMetrics } from './today-hub.js';

const DeckManageModal = lazy(() => import('./DeckManageModal.js').then((m) => ({ default: m.DeckManageModal })));
const VoicePackModal = lazy(() => import('./VoicePackModal.js').then((m) => ({ default: m.VoicePackModal })));
const DailyPlanModal = lazy(() => import('./DailyPlanModal.js').then((m) => ({ default: m.DailyPlanModal })));
const CourseSettingsModal = lazy(() => import('./CourseSettingsModal.js').then((m) => ({ default: m.CourseSettingsModal })));
const DeckOpsModal = lazy(() => import('./DeckOpsModal.js').then((m) => ({ default: m.DeckOpsModal })));
const GuidedStudyModal = lazy(() => import('./GuidedStudyModal.js').then((m) => ({ default: m.GuidedStudyModal })));
const RoundConfigModal = lazy(() => import('./RoundConfigModal.js').then((m) => ({ default: m.RoundConfigModal })));

type DeckItem = NonNullable<StudySnapshot['decks']>[number];
type DraftItem = NonNullable<StudySnapshot['drafts']>[number];
type JobItem = NonNullable<StudySnapshot['jobs']>[number];

interface DeckProgressEntry {
  total?: number;
  mastery?: number;
  due?: number;
  counts?: {
    new?: number;
    weak?: number;
    learning?: number;
    familiar?: number;
    mastered?: number;
  };
  topics?: Array<{ name: string; total: number; mastery: number; due: number; status: string }>;
}

interface FocusProgressInfo {
  total: number;
  done: number;
  weak: number;
  none: number;
}

type WorkEntry =
  | { kind: 'draft'; id: string; title: string; course: string; count: number; draft: DraftItem }
  | { kind: 'job'; id: string; title: string; course: string; status: string; error: string; job: JobItem };

const CLAIMED_LIBRARY_KEYS = ['R', 'p', 'C', 'o', 'g', '[', ']', 'x', '/', 'B', 'Z'] as const;
const CLAIMED_DECK_ARCHIVE_KEYS = ['a'] as const;

function localDayKey(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateShort(raw: string | number | undefined | null, lang: 'zh' | 'en'): string {
  if (raw === undefined || raw === null || raw === '') return t(lang, '尚未学习', 'Never');
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return t(lang, '刚刚', 'Just now');
  if (diffMin < 60) return t(lang, `${diffMin} 分钟前`, `${diffMin}m ago`);
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t(lang, `${diffH} 小时前`, `${diffH}h ago`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deckStats(deck: DeckItem, progressMap: Record<string, DeckProgressEntry> | undefined) {
  const p = progressMap?.[deck.id];
  const total = Number(deck.count ?? p?.total ?? deck.cardCount ?? 0) || 0;
  const due = deckDueCount(deck, progressMap);
  const newCount = Number(p?.counts?.new ?? deck.newCount ?? 0) || 0;
  const wrong = Number(deck.wrong ?? p?.counts?.weak ?? deck.wrongCount ?? 0) || 0;
  const mastered = Number(p?.counts?.mastered ?? deck.masteredCount ?? 0) || 0;
  const familiar = Number(p?.counts?.familiar ?? 0) || 0;
  const learning = Number(p?.counts?.learning ?? 0) || 0;
  const mastery =
    typeof p?.mastery === 'number'
      ? Math.max(0, Math.min(100, Math.round(p.mastery)))
      : total > 0
        ? Math.round((mastered / total) * 100)
        : 0;
  const flagged = Number((deck as Record<string, unknown>).flagged ?? 0) || 0;
  const suspended = Number((deck as Record<string, unknown>).suspended ?? 0) || 0;
  const lastStudied = (deck.lastStudiedAt ?? deck.updatedAt ?? deck.publishedAt ?? deck.createdAt) as
    | string
    | number
    | undefined;
  return { total, due, newCount, wrong, mastered, familiar, learning, mastery, flagged, suspended, lastStudied, topics: p?.topics };
}

function isFailedJob(job: JobItem): boolean {
  const st = String(job.status ?? '').toLowerCase();
  return st === 'failed' || st === 'error' || st === 'cancelled' || st === 'interrupted';
}

export const LibraryView: React.FC<ViewProps> = memo(function LibraryView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const actions = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const proactiveHints = useTuiStore((s) => s.preferences.proactiveHints !== false);
  const dismissedBriefingDate = useTuiStore((s) => s.preferences.dismissedBriefingDate);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const snapshot = useTuiStore((s) => s.snapshot);
  const activeRunId = useTuiStore((s) => s.activeRunId);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const course = currentCourse(snapshot);
  const [showArchived, setShowArchived] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [focusSection, setFocusSection] = useState<'decks' | 'work'>('decks');
  const [deckIndex, setDeckIndex] = useState(0);
  const [workIndex, setWorkIndex] = useState(0);

  const [manageDeckId, setManageDeckId] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [dailyPlanOpen, setDailyPlanOpen] = useState(false);
  const [courseSettingsOpen, setCourseSettingsOpen] = useState(false);
  const [deckOpsOpen, setDeckOpsOpen] = useState(false);
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [roundConfigOpen, setRoundConfigOpen] = useState(false);
  const [confirmArchiveDeck, setConfirmArchiveDeck] = useState<DeckItem | null>(null);
  const [confirmDeleteDeck, setConfirmDeleteDeck] = useState<DeckItem | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);
  const pendingFocusDeckIdRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [streak, setStreak] = useState<number>(0);
  const [sampleLoaded, setSampleLoaded] = useState<boolean>(false);

  // Sync streak & sample status cleanly without polluting global store
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [statsRes, sampleRes] = await Promise.all([
        tryAction<{ totals?: { streak?: number } }>(host, 'stats', course ? { course } : {}),
        getSampleStatus(host).catch(() => null),
      ]);
      if (!alive) return;
      if (statsRes.ok && typeof statsRes.value?.totals?.streak === 'number') {
        setStreak(statsRes.value.totals.streak);
      } else if (typeof snapshot?.today?.streak === 'number') {
        setStreak(snapshot.today.streak);
      }
      if (sampleRes && typeof sampleRes.loaded === 'boolean') {
        setSampleLoaded(sampleRes.loaded);
      } else {
        setSampleLoaded(Boolean(snapshot?.sample?.loaded || snapshot?.decks?.some((d) => Boolean(d.sample))));
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, course, snapshot?.revision, snapshot?.today?.streak, snapshot?.sample?.loaded, snapshot?.decks]);

  const progressMap = snapshot?.progress as Record<string, DeckProgressEntry> | undefined;

  const scopedDecks = useMemo<DeckItem[]>(() => {
    const all = snapshot?.decks ?? [];
    return all.filter((d) => {
      if (!showArchived && d.archived) return false;
      if ((d as Record<string, unknown>).systemKind) return false;
      if (course && d.course !== course) return false;
      return true;
    });
  }, [snapshot?.decks, course, showArchived]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const filteredDecks = useMemo<DeckItem[]>(() => {
    if (!normalizedFilter) return scopedDecks;
    return scopedDecks.filter((d) => {
      const rec = d as Record<string, unknown>;
      const topics = Array.isArray(rec.topics) ? rec.topics.map((x) => String(x ?? '')).join(' ') : '';
      const haystack = [d.title, d.name, d.course, rec.description, topics]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase())
        .join('\n');
      return haystack.includes(normalizedFilter);
    });
  }, [scopedDecks, normalizedFilter]);

  const workEntries = useMemo<WorkEntry[]>(() => {
    const list: WorkEntry[] = [];
    for (const draft of snapshot?.drafts ?? []) {
      if (course && draft.course && draft.course !== course) continue;
      const count = Array.isArray(draft.cards) ? draft.cards.length : Number(draft.cardCount ?? 0) || 0;
      list.push({
        kind: 'draft',
        id: draft.id,
        title: String(draft.title || t(lang, '未命名草稿', 'Untitled Draft')),
        course: String(draft.course || ''),
        count,
        draft,
      });
    }
    for (const job of snapshot?.jobs ?? []) {
      if (!isFailedJob(job)) continue;
      if (course && job.course && job.course !== course) continue;
      list.push({
        kind: 'job',
        id: job.id,
        title: String(job.title || job.type || job.kind || job.id),
        course: String(job.course || ''),
        status: String(job.status || 'failed'),
        error: String(job.error || job.message || ''),
        job,
      });
    }
    return list;
  }, [snapshot?.drafts, snapshot?.jobs, course, lang]);

  useEffect(() => {
    const targetId = pendingFocusDeckIdRef.current;
    if (targetId && filteredDecks.length > 0) {
      const nextIdx = filteredDecks.findIndex((d) => d.id === targetId);
      if (nextIdx >= 0) {
        pendingFocusDeckIdRef.current = null;
        setDeckIndex(nextIdx);
        return;
      }
    }
    if (deckIndex >= filteredDecks.length) setDeckIndex(Math.max(0, filteredDecks.length - 1));
  }, [filteredDecks, deckIndex]);

  useEffect(() => {
    if (workIndex >= workEntries.length) setWorkIndex(Math.max(0, workEntries.length - 1));
    if (workEntries.length === 0 && focusSection === 'work') setFocusSection('decks');
  }, [workEntries.length, workIndex, focusSection]);

  const clampedDeckIndex = filteredDecks.length === 0 ? 0 : Math.min(deckIndex, filteredDecks.length - 1);
  const selectedDeck = filteredDecks[clampedDeckIndex] ?? null;
  const selectedWork = workEntries[workIndex] ?? null;
  const libraryKeys = useMemo(
    () =>
      focusSection === 'decks' && Boolean(selectedDeck)
        ? [...CLAIMED_LIBRARY_KEYS, ...CLAIMED_DECK_ARCHIVE_KEYS]
        : CLAIMED_LIBRARY_KEYS,
    [focusSection, selectedDeck],
  );

  // KPI metrics
  const kpi = useMemo(() => {
    const due = dueToday(snapshot, course);
    const todayKey = localDayKey(new Date());
    const reviewedDirect = Number(snapshot?.today?.reviewed);
    const reviewed = Number.isFinite(reviewedDirect)
      ? reviewedDirect
      : (snapshot?.attempts ?? []).filter((a) => {
          if (!a || (a as Record<string, unknown>).voidedAt) return false;
          const ts = (a as Record<string, unknown>).timestamp;
          return typeof ts === 'string' && localDayKey(ts) === todayKey;
        }).length;

    let totalCards = 0;
    let weightedMastery = 0;
    for (const d of scopedDecks) {
      if (d.archived) continue;
      const st = deckStats(d, progressMap);
      totalCards += st.total;
      weightedMastery += st.mastery * st.total;
    }
    const masteryPct = totalCards > 0 ? Math.round(weightedMastery / totalCards) : 0;

    const fpRaw = (snapshot?.focus as Record<string, unknown> | undefined)?.progress as FocusProgressInfo | undefined;
    const focusProgress = fpRaw && fpRaw.total > 0 ? fpRaw : null;

    return { due, reviewed, streak, masteryPct, focusProgress };
  }, [snapshot, course, scopedDecks, progressMap, streak]);

  const resumeRunForDeck = useMemo(() => {
    const runs = snapshot?.runs ?? [];
    if (selectedDeck) {
      const hit = runs.find(
        (r) =>
          r.deckId === selectedDeck.id ||
          (Array.isArray((r as Record<string, unknown>).deckIds) &&
            ((r as Record<string, unknown>).deckIds as string[]).includes(selectedDeck.id)),
      );
      if (hit) return hit.id;
    }
    if (activeRunId) return activeRunId;
    const lastId = (snapshot?.lastRun as Record<string, unknown> | null | undefined)?.id;
    return typeof lastId === 'string' && lastId ? lastId : null;
  }, [snapshot?.runs, snapshot?.lastRun, selectedDeck, activeRunId]);

  const handleStartReview = useCallback(
    (deck: DeckItem) => {
      if (deck.archived) {
        notify(t(lang, '请先按 [a] 恢复已归档题组再开始练习', 'Unarchive this deck ([a]) before practicing'), 'warning');
        return;
      }
      navigate('review', { deckId: deck.id, course: deck.course ?? course ?? undefined });
    },
    [navigate, notify, lang, course],
  );

  const handleArchiveToggle = useCallback(
    async (deck: DeckItem) => {
      if (busyAction) return;
      setBusyAction(true);
      const nextArchived = !deck.archived;
      const res = await tryAction<{ ok?: boolean; closedRuns?: number }>(host, 'deck.archive', {
        id: deck.id,
        archived: nextArchived,
      });
      setBusyAction(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '操作失败', 'Archive action failed'), 'error');
        return;
      }
      await actions.refresh();
      notify(
        nextArchived
          ? t(lang, `已归档「${deck.title ?? deck.id}」`, `Archived "${deck.title ?? deck.id}"`)
          : t(lang, `已恢复「${deck.title ?? deck.id}」`, `Restored "${deck.title ?? deck.id}"`),
        'success',
      );
    },
    [busyAction, host, actions, notify, lang],
  );

  const handleDeleteConfirmed = useCallback(async () => {
    const target = confirmDeleteDeck;
    setConfirmDeleteDeck(null);
    if (!target || busyAction) return;
    setBusyAction(true);
    try {
      let archivedByUs = false;
      if (!target.archived) {
        const archRes = await tryAction(host, 'deck.archive', { id: target.id, archived: true });
        if (!archRes.ok) {
          notify(archRes.error?.message || t(lang, '归档失败，无法删除', 'Could not archive before delete'), 'error');
          return;
        }
        archivedByUs = true;
      }
      const delRes = await tryAction(host, 'deck.remove', { id: target.id, confirm: true });
      if (!delRes.ok) {
        const errMsg = delRes.error?.message || t(lang, '删除题组失败', 'Failed to delete deck');
        if (archivedByUs) {
          const rollbackRes = await tryAction(host, 'deck.archive', { id: target.id, archived: false });
          await actions.refresh();
          if (rollbackRes.ok) {
            notify(
              t(lang, `删除失败（${errMsg}），已自动恢复未归档状态`, `Delete failed (${errMsg}); restored deck from archive`),
              'error',
            );
          } else {
            notify(
              t(
                lang,
                `删除失败（${errMsg}），注意：题组已被归档，可在归档中恢复`,
                `Delete failed (${errMsg}); note: deck was archived and can be restored`,
              ),
              'warning',
            );
          }
          return;
        }
        notify(errMsg, 'error');
        return;
      }
      await actions.refresh();
      notify(t(lang, `已永久删除「${target.title ?? target.id}」`, `Deleted "${target.title ?? target.id}"`), 'success');
    } finally {
      setBusyAction(false);
    }
  }, [confirmDeleteDeck, busyAction, host, actions, notify, lang]);

  const handleSampleToggle = useCallback(async () => {
    if (busyAction) return;
    if (sampleLoaded) {
      setBusyAction(true);
      try {
        await removeSampleCourse(host);
        await actions.refresh();
        setSampleLoaded(false);
        notify(t(lang, '已移除示例课程', 'Sample course removed'), 'success');
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setBusyAction(false);
      }
    } else {
      await actions.loadSample();
      setSampleLoaded(true);
    }
  }, [busyAction, sampleLoaded, host, actions, notify, lang]);

  const handleRetryJob = useCallback(
    async (job: JobItem) => {
      if (busyAction) return;
      setBusyAction(true);
      const res = await tryAction(host, 'job.control', { jobId: job.id, action: 'retry' });
      setBusyAction(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '重试任务失败', 'Job retry failed'), 'error');
        return;
      }
      await actions.refresh();
      notify(t(lang, `已重试任务：${job.title || job.id}`, `Retrying job: ${job.title || job.id}`), 'success');
    },
    [busyAction, host, actions, notify, lang],
  );

  const handleOpenWork = useCallback(
    (item: WorkEntry) => {
      if (item.kind === 'draft') {
        navigate('generate', { draftId: item.id });
      } else {
        navigate('tasks', { jobId: item.id });
      }
    },
    [navigate],
  );

  const handleMoveDeck = useCallback(
    async (direction: 'up' | 'down') => {
      if (busyRef.current || busyAction) return;
      if (focusSection !== 'decks') {
        notify(t(lang, '请先按 [Tab] 切回题组列表再调整顺序', 'Press [Tab] to focus the Decks list to reorder'), 'info');
        return;
      }
      if (filteredDecks.length === 0 || !selectedDeck) {
        notify(t(lang, '当前列表暂无可排序的题组', 'No decks available to reorder'), 'info');
        return;
      }
      if (filteredDecks.length === 1) {
        notify(t(lang, '当前列表只有一个题组，无需调整顺序', 'Only one deck in the current list; nothing to reorder'), 'info');
        return;
      }
      if (direction === 'up' && deckIndex <= 0) {
        notify(t(lang, '已经是第一个题组', 'Already the first deck'), 'info');
        return;
      }
      if (direction === 'down' && deckIndex >= filteredDecks.length - 1) {
        notify(t(lang, '已经是最后一个题组', 'Already the last deck'), 'info');
        return;
      }
      const neighbor = filteredDecks[direction === 'up' ? deckIndex - 1 : deckIndex + 1];
      const allIds = (snapshot?.decks ?? []).map((d) => d.id);
      const posA = allIds.indexOf(selectedDeck.id);
      const posB = allIds.indexOf(neighbor?.id ?? '');
      if (posA < 0 || posB < 0) {
        notify(t(lang, '未能定位题组顺序，请按 Ctrl+R 刷新后重试', 'Could not locate deck order; press Ctrl+R to refresh'), 'warning');
        return;
      }
      const nextIds = [...allIds];
      [nextIds[posA], nextIds[posB]] = [nextIds[posB], nextIds[posA]];

      busyRef.current = true;
      setBusyAction(true);
      try {
        const res = await tryAction<{ ids?: string[] }>(host, 'deck.reorder', { ids: nextIds });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '调整题组顺序失败', 'Failed to reorder decks'), 'error');
          return;
        }
        pendingFocusDeckIdRef.current = selectedDeck.id;
        await actions.refresh();
        if (!mountedRef.current) return;
        const deckTitle = String(selectedDeck.title ?? selectedDeck.name ?? selectedDeck.id);
        notify(
          direction === 'up'
            ? t(lang, `已上移「${deckTitle}」`, `Moved "${deckTitle}" up`)
            : t(lang, `已下移「${deckTitle}」`, `Moved "${deckTitle}" down`),
          'success',
        );
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyAction(false);
      }
    },
    [busyAction, focusSection, filteredDecks, selectedDeck, deckIndex, snapshot?.decks, host, actions, notify, lang],
  );

  const handleExportDeck = useCallback(
    async (deck: DeckItem) => {
      if (exportBusyRef.current) return;
      exportBusyRef.current = true;
      try {
        const res = await tryAction<DeckExportInput>(host, 'deck.get', { id: deck.id });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '读取题组失败', 'Failed to load deck'), 'error');
          return;
        }
        const { exportDeckToMarkdown } = await import('./deck-export.js');
        const { targetPath, count } = await exportDeckToMarkdown({
          libraryRoot: host.getLibraryRoot(),
          deck: res.value,
          lang,
        });
        if (!mountedRef.current) return;
        const arrow = asciiMode ? '->' : '→';
        notify(
          t(lang, `已导出 ${count} 题 ${arrow} ${targetPath}`, `Exported ${count} card(s) ${arrow} ${targetPath}`),
          'success',
        );
      } catch (err) {
        if (!mountedRef.current) return;
        notify(
          t(
            lang,
            `导出失败: ${err instanceof Error ? err.message : String(err)}`,
            `Export failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
          'error',
        );
      } finally {
        exportBusyRef.current = false;
      }
    },
    [asciiMode, host, lang, notify],
  );

  const lastPracticeContext = useTuiStore((s) => s.preferences.lastPracticeContext);
  const todayHubItems = useMemo(
    () =>
      buildTodayHubItems(
        buildTodayHubMetrics({ snapshot, course, activeRunId, lastPracticeContext }),
        lang,
      ),
    [snapshot, course, activeRunId, lastPracticeContext, lang],
  );

  const handleTodayHubClick = useCallback(
    (id: 'resume' | 'due' | 'wrong' | 'todo') => {
      if (id === 'resume') {
        if (activeRunId) navigate('review', { runId: activeRunId });
        else if (lastPracticeContext?.runId) navigate('review', { runId: lastPracticeContext.runId, deckId: lastPracticeContext.deckId });
        else if (selectedDeck) handleStartReview(selectedDeck);
        else navigate('review');
        return;
      }
      if (id === 'due') {
        const dueDeck =
          (snapshot?.decks ?? [])
            .filter((d) => isActiveStudyDeck(d, course))
            .sort((a, b) => deckDueCount(b, progressMap) - deckDueCount(a, progressMap))[0] ??
          selectedDeck;
        if (dueDeck) handleStartReview(dueDeck);
        else navigate('review');
        return;
      }
      if (id === 'wrong') {
        navigate('wrongbook');
        return;
      }
      navigate('board');
    },
    [activeRunId, lastPracticeContext, selectedDeck, snapshot?.decks, progressMap, course, handleStartReview, navigate],
  );

  const dailyBriefing = useMemo(
    () =>
      buildDailyBriefing({
        snapshot,
        course,
        lang,
        proactiveHints,
        dismissedBriefingDate,
      }),
    [snapshot, course, lang, proactiveHints, dismissedBriefingDate],
  );

  const handleDismissBriefing = useCallback(() => {
    if (!dailyBriefing) return;
    setPreferences({ dismissedBriefingDate: dailyBriefing.dateKey });
    void saveTuiPreferences({ dismissedBriefingDate: dailyBriefing.dateKey }).catch(() => {});
    notify(t(lang, '今日简报已收起（明日自动恢复）', 'Daily brief dismissed for today'), 'info');
  }, [dailyBriefing, setPreferences, notify, lang]);

  const handleAcceptBriefing = useCallback(() => {
    if (!dailyBriefing) return;
    const { target } = dailyBriefing;
    if (target.kind === 'deck') {
      const targetDeck = (snapshot?.decks ?? []).find((d) => d.id === target.deckId);
      if (targetDeck) {
        handleStartReview(targetDeck);
        return;
      }
    }
    if (target.kind === 'wrongbook') {
      navigate('wrongbook');
      return;
    }
    setDailyPlanOpen(true);
  }, [dailyBriefing, snapshot?.decks, handleStartReview, navigate]);

  const pageActive = useKeyScope({
    id: 'LibraryView:main',
    active: isActive,
    keys: libraryKeys,
    onKey: (input, key) => {
      if (busyRef.current || busyAction) return false;
      if (input === 'B' && dailyBriefing) {
        handleAcceptBriefing();
        return true;
      }
      if (input === 'Z' && dailyBriefing) {
        handleDismissBriefing();
        return true;
      }
      if (key.escape && filterQuery) {
        setFilterQuery('');
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setFocusSection('decks');
        setFilterEditing(true);
        return true;
      }
      if (key.tab && workEntries.length > 0) {
        setFocusSection((prev) => (prev === 'decks' ? 'work' : 'decks'));
        return true;
      }
      if (input === '[' || input === ']') {
        void handleMoveDeck(input === '[' ? 'up' : 'down');
        return true;
      }
      if (input === 'h') {
        setShowArchived((v) => !v);
        return true;
      }
      if (input === 's') {
        void handleSampleToggle();
        return true;
      }
      if (input === 'v') {
        setVoiceOpen(true);
        return true;
      }
      if (input === 'p') {
        setDailyPlanOpen(true);
        return true;
      }
      if (input === 'g') {
        setGuidedOpen(true);
        return true;
      }
      if (input === 'C') {
        setCourseSettingsOpen(true);
        return true;
      }
      if (input === 'R') {
        setRoundConfigOpen(true);
        return true;
      }
      if (focusSection === 'work' && selectedWork) {
        if (input === 'y' && selectedWork.kind === 'job') {
          void handleRetryJob(selectedWork.job);
          return true;
        }
        if (input === 'o') {
          handleOpenWork(selectedWork);
          return true;
        }
      }
      if (input === 'o') {
        setDeckOpsOpen(true);
        return true;
      }
      if (selectedDeck) {
        if (input === 'm') {
          setManageDeckId(selectedDeck.id);
          return true;
        }
        if (input === 'a' && focusSection === 'decks') {
          setConfirmArchiveDeck(selectedDeck);
          return true;
        }
        if (input === 'd') {
          setConfirmDeleteDeck(selectedDeck);
          return true;
        }
        if (input === 'x') {
          void handleExportDeck(selectedDeck);
          return true;
        }
      }
      return false;
    },
  });

  const hints = useMemo<KeyHint[]>(
    () => [
      { key: 'Enter', label: focusSection === 'work' ? t(lang, '打开', 'Open') : t(lang, '开始练习', 'Practice') },
      { key: 'R', label: t(lang, '定制本轮', 'Round') },
      { key: 'p', label: t(lang, '今日计划', 'Plan') },
      { key: 'g', label: t(lang, 'AI带学', 'Guided') },
      { key: 'C', label: t(lang, '课程设置', 'Course') },
      { key: 'r', label: t(lang, '继续上次', 'Resume') },
      { key: 'o', label: t(lang, '导/合/拆', 'Deck Ops') },
      { key: 'm', label: t(lang, '管理卡片', 'Manage') },
      { key: '[/]', label: t(lang, '排序', 'Reorder') },
      { key: 'v', label: t(lang, '语音包', 'Voice Pack') },
      { key: 'a', label: t(lang, '归档', 'Archive') },
      { key: 'd', label: t(lang, '删除', 'Delete') },
      { key: 's', label: sampleLoaded ? t(lang, '移示例', 'Rm Sample') : t(lang, '示例课', 'Sample') },
      { key: 'x', label: t(lang, '导出MD', 'Export') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
    ],
    [focusSection, lang, sampleLoaded],
  );
  useFooterHints(hints, pageActive);

  // Layout geometry
  const kpiHeight = kpi.focusProgress ? 3 : 2;
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarHeight = showFilterBar ? 1 : 0;
  const showBriefingBar = Boolean(dailyBriefing) && !showFilterBar;
  const briefingBarHeight = showBriefingBar ? 1 : 0;
  const bodyHeight = Math.max(6, height - kpiHeight - filterBarHeight - briefingBarHeight);

  const renderDeckRow = useCallback(
    (deck: DeckItem, ctx: VirtualListRenderContext) => {
      const ell = asciiMode ? '...' : '…';
      const sep = asciiMode ? '|' : '·';
      const st = deckStats(deck, progressMap);
      const titleRaw = String(deck.title ?? deck.name ?? deck.id);
      const showCoursePill = Boolean(deck.course) && ctx.width >= 52 && course == null;
      const courseTag = showCoursePill && deck.course ? ` [${truncateDisplay(deck.course, 10, ell)}]` : '';
      const archTag = deck.archived ? t(lang, ' [归档]', ' [Arch]') : '';
      const statsStr = ` ${st.mastery}% ${sep} ${t(lang, '待', 'D')}${st.due}/${t(lang, '新', 'N')}${st.newCount}/${t(lang, '错', 'W')}${st.wrong}`;
      const barW = ctx.width >= 52 ? 8 : 0;
      const barChunk = barW > 0 ? ' ' : '';
      const titleBudget = Math.max(8, ctx.width - displayWidth(courseTag) - displayWidth(archTag) - displayWidth(statsStr) - barW - barChunk.length);
      const titleText = padDisplay(truncateDisplay(titleRaw, titleBudget, ell), titleBudget);
      const fg = ctx.selected ? theme.selectionFg : deck.archived ? theme.dim : theme.text;
      return (
        <Text color={fg} bold={ctx.selected}>
          {titleText}
          {courseTag ? <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{courseTag}</Text> : null}
          {archTag ? <Text color={theme.dim}>{archTag}</Text> : null}
          {barW > 0 ? ' ' : ''}
          {barW > 0 ? <ProgressBar ratio={st.mastery / 100} width={barW} showPercent={false} /> : null}
          <Text color={ctx.selected ? theme.selectionFg : st.due > 0 ? theme.warning : theme.muted}>{statsStr}</Text>
        </Text>
      );
    },
    [progressMap, lang, asciiMode, theme, course],
  );

  const renderWorkRow = useCallback(
    (item: WorkEntry, ctx: VirtualListRenderContext) => {
      const ell = asciiMode ? '...' : '…';
      const tag = item.kind === 'draft' ? t(lang, '[草稿]', '[Draft]') : t(lang, '[失败]', '[Failed]');
      const meta =
        item.kind === 'draft'
          ? ` ${item.count}${t(lang, '题', 'q')}`
          : ` ${item.status}`;
      const avail = Math.max(8, ctx.width - displayWidth(tag) - displayWidth(meta) - 1);
      const title = padDisplay(truncateDisplay(item.title, avail, ell), avail);
      return (
        <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
          <Text color={ctx.selected ? theme.selectionFg : item.kind === 'draft' ? theme.info : theme.error}>{tag} </Text>
          {title}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{meta}</Text>
        </Text>
      );
    },
    [lang, asciiMode, theme],
  );

  const renderLeftPane = useCallback(
    (size: { width: number; height: number }) => {
      const hasWork = workEntries.length > 0;
      const workBoxH = hasWork ? Math.min(Math.max(4, workEntries.length + 3), Math.max(5, Math.floor(size.height * 0.35))) : 0;
      const deckBoxH = Math.max(4, size.height - workBoxH);
      const deckListH = Math.max(2, deckBoxH - 2);
      const deckListW = Math.max(10, size.width - 4);
      const workListH = Math.max(1, workBoxH - 3);

      return (
        <Box flexDirection="column" width={size.width} height={size.height}>
          <Panel
            title={t(lang, '题组列表', 'Decks')}
            icon={asciiMode ? '*' : '◈'}
            badge={filteredDecks.length}
            subtitle={showArchived ? t(lang, '含已归档 [h]', '+Archived [h]') : t(lang, '[h] 含归档', '[h] Archived')}
            focused={focusSection === 'decks'}
            width={size.width}
            height={deckBoxH}
          >
            {filteredDecks.length === 0 ? (
              <EmptyState
                title={normalizedFilter ? t(lang, '没有匹配的题组', 'No matching decks') : t(lang, '当前范围暂无题组', 'No decks in this scope')}
                hint={
                  normalizedFilter
                    ? t(lang, '按 [Esc] 清除筛选，或按 [/] 修改关键词', 'Press [Esc] to clear filter, or [/] to edit')
                    : t(lang, '按 [s] 载入示例课程，或按 [3] 从资料生成题目', 'Press [s] for sample course, or [3] to generate')
                }
                width={deckListW}
                height={deckListH}
              />
            ) : (
              <VirtualList
                items={filteredDecks}
                height={deckListH}
                width={deckListW}
                selectedIndex={clampedDeckIndex}
                onChange={setDeckIndex}
                onSelect={handleStartReview}
                isActive={pageActive && focusSection === 'decks'}
                keyExtractor={(d) => d.id}
                renderItem={renderDeckRow}
              />
            )}
          </Panel>

          {hasWork ? (
            <Panel
              title={t(lang, '草稿与异常任务', 'Drafts & Failed Jobs')}
              icon={asciiMode ? '!' : '⚑'}
              badge={workEntries.length}
              badgeTone="warning"
              subtitle={asciiMode ? t(lang, 'Tab 切换 - y 重试 - o 打开', 'Tab focus - y retry - o open') : t(lang, 'Tab 切换 · y 重试 · o 打开', 'Tab focus · y retry · o open')}
              focused={focusSection === 'work'}
              width={size.width}
              height={workBoxH}
            >
              <VirtualList
                items={workEntries}
                height={workListH}
                width={deckListW}
                selectedIndex={workIndex}
                onChange={setWorkIndex}
                onSelect={handleOpenWork}
                isActive={pageActive && focusSection === 'work'}
                keyExtractor={(w) => `${w.kind}:${w.id}`}
                renderItem={renderWorkRow}
              />
            </Panel>
          ) : null}
        </Box>
      );
    },
    [
      workEntries,
      lang,
      asciiMode,
      filteredDecks,
      normalizedFilter,
      showArchived,
      focusSection,
      clampedDeckIndex,
      handleStartReview,
      pageActive,
      renderDeckRow,
      workIndex,
      handleOpenWork,
      renderWorkRow,
    ],
  );

  const renderRightPane = useCallback(
    (size: { width: number; height: number }) => {
      const innerW = Math.max(16, size.width - 4);
      if (focusSection === 'work' && selectedWork) {
        return (
          <Panel
            title={selectedWork.kind === 'draft' ? t(lang, '草稿详情', 'Draft Detail') : t(lang, '异常任务详情', 'Failed Job Detail')}
            icon={selectedWork.kind === 'draft' ? (asciiMode ? '+' : '✦') : (asciiMode ? '!' : '▲')}
            tone={selectedWork.kind === 'draft' ? 'info' : 'error'}
            focused
            width={size.width}
            height={size.height}
          >
            <Box flexDirection="column" gap={1}>
              <Text color={theme.text} bold>{selectedWork.title}</Text>
              <Box flexDirection="row" gap={1}>
                {selectedWork.course ? <Badge label={selectedWork.course} tone="accent" variant="soft" /> : null}
                <StatusPill
                  label={selectedWork.kind === 'draft' ? `${selectedWork.count} ${t(lang, '道草稿题', 'draft cards')}` : selectedWork.status}
                  status={selectedWork.kind === 'draft' ? 'idle' : 'error'}
                />
              </Box>
              {selectedWork.kind === 'job' && selectedWork.error ? (
                <Text color={theme.error} wrap="wrap">{selectedWork.error}</Text>
              ) : null}
              <Divider width={innerW} />
              <Text color={theme.accent}>
                {selectedWork.kind === 'draft'
                  ? t(lang, '[Enter / o] 在创建页审核与发布草稿', '[Enter / o] Open draft in Generate view')
                  : t(lang, '[y] 立即重试该任务   [Enter / o] 打开任务监控', '[y] Retry job   [Enter / o] Open Tasks view')}
              </Text>
              <Text color={theme.muted}>{t(lang, '[Tab] 返回题组列表', '[Tab] Return to Decks list')}</Text>
            </Box>
          </Panel>
        );
      }

      if (!selectedDeck) {
        return (
          <Panel title={t(lang, '题组详情', 'Deck Detail')} width={size.width} height={size.height}>
            <EmptyState
              title={t(lang, '未选中题组', 'No deck selected')}
              hint={t(lang, '按 [s] 载入示例课 · [o] 导入 JSON · [p] 今日计划 · [g] AI带学 · [C] 课程设置', 'Press [s] sample · [o] import JSON · [p] Plan · [g] Guided · [C] Course')}
              width={innerW}
              height={Math.max(4, size.height - 4)}
            />
          </Panel>
        );
      }

      const st = deckStats(selectedDeck, progressMap);
      const topicsLine = (selectedDeck as { topics?: string[] }).topics?.slice(0, 5).join(asciiMode ? ' - ' : ' · ') || '';
      const innerH = Math.max(1, size.height - 2);
      const compactDetail = size.height <= 12;
      const showBreakdown = innerH >= 4;
      const showQuickLaunch = innerH >= 6;
      const showQuickActions = innerH >= 8;

      return (
        <Panel
          title={String(selectedDeck.title ?? selectedDeck.name ?? selectedDeck.id)}
          icon={asciiMode ? '#' : '▤'}
          subtitle={formatDateShort(st.lastStudied, lang)}
          focused={focusSection === 'decks'}
          width={size.width}
          height={size.height}
        >
          <Box flexDirection="column" gap={0} overflow="hidden">
            {/* Pills row */}
            <Box flexDirection="row" columnGap={1} flexWrap="wrap" flexShrink={0}>
              <Badge label={selectedDeck.course || t(lang, '未分课', 'General')} tone="accent" variant="soft" />
              {selectedDeck.archived ? <StatusPill label={t(lang, '已归档', 'Archived')} status="warn" /> : null}
              {(selectedDeck as Record<string, unknown>).sample ? (
                <StatusPill label={t(lang, '示例课', 'Sample')} status="ai" />
              ) : null}
              {st.due > 0 ? (
                <StatusPill label={`${st.due} ${t(lang, '题到期', 'due')}`} status="warn" />
              ) : (
                <StatusPill label={t(lang, '今日已清', 'Caught up')} status="ok" />
              )}
            </Box>

            <Box marginTop={compactDetail ? 0 : 1} flexShrink={0}>
              <ProgressBar
                ratio={st.mastery / 100}
                width={Math.min(44, innerW)}
                label={t(lang, '掌握度', 'Mastery')}
                style="block"
              />
            </Box>

            {showBreakdown ? (
              <>
                <Divider width={innerW} label={t(lang, '题量分布', 'Breakdown')} />

                <Box flexDirection="row" columnGap={compactDetail ? 1 : 2} flexWrap="wrap" flexShrink={0}>
                  <Text color={theme.text}>{t(lang, '总题数', 'Total')}: <Text bold>{st.total}</Text></Text>
                  <Text color={theme.success}>{t(lang, '已掌握', 'Mastered')}: <Text bold>{st.mastered}</Text></Text>
                  <Text color={theme.info}>{t(lang, compactDetail ? '学习中' : '熟悉/学习中', 'Learning')}: <Text bold>{st.familiar + st.learning}</Text></Text>
                  <Text color={theme.accent}>{t(lang, '新题', 'New')}: <Text bold>{st.newCount}</Text></Text>
                  <Text color={theme.error}>{t(lang, compactDetail ? '错题' : '薄弱/错题', 'Weak')}: <Text bold>{st.wrong}</Text></Text>
                  {st.flagged > 0 ? (
                    <Text color={theme.warning}>{t(lang, '待修标记', 'Flagged')}: <Text bold>{st.flagged}</Text></Text>
                  ) : null}
                </Box>
              </>
            ) : null}

            {!compactDetail ? (
              <Box marginTop={0} flexShrink={0}>
                <Text color={theme.muted}>
                  {t(lang, '最近学习', 'Last studied')}: <Text color={theme.text}>{formatDateShort(st.lastStudied, lang)}</Text>
                </Text>
              </Box>
            ) : null}

            {!compactDetail && topicsLine ? (
              <Box marginTop={0} flexShrink={0}>
                <Prose width={innerW} tone="muted" ascii={asciiMode}>
                  {t(lang, '涵盖主题', 'Topics')}: <Text color={theme.text}>{topicsLine}</Text>
                </Prose>
              </Box>
            ) : null}

            {showQuickLaunch ? (
              <>
                <Divider width={innerW} label={t(lang, '今日一键直达', 'Today Quick Launch')} />
                <Box flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={0}>
                  {todayHubItems.map((hub) => (
                    <ClickableBox
                      key={hub.id}
                      clickActive={pageActive}
                      onClick={() => handleTodayHubClick(hub.id)}
                    >
                      <Text>
                        <Text color={hub.tone === 'warning' ? theme.warning : hub.tone === 'error' ? theme.error : hub.tone === 'primary' ? theme.primary : theme.accent} bold>
                          {`[${hub.key}]`}
                        </Text>
                        <Text color={theme.text}>{` ${hub.label}`}</Text>
                      </Text>
                    </ClickableBox>
                  ))}
                </Box>
              </>
            ) : null}

            {showQuickActions ? (
              <>
                <Divider width={innerW} label={t(lang, '快捷操作', 'Quick Actions')} />

                {compactDetail ? (
                  <Box flexDirection="column" flexShrink={0}>
                    <Text wrap={asciiMode ? undefined : 'truncate-end'}>
                      <Text color={theme.primary} bold>[Enter]</Text>
                      <Text color={theme.text}> {t(lang, '练习', 'Practice')} </Text>
                      <Text color={theme.accent} bold>[R]</Text>
                      <Text color={theme.text}> {t(lang, '配轮', 'Round')} </Text>
                      <Text color={theme.primary} bold>[p]</Text>
                      <Text color={theme.text}> {t(lang, '计划', 'Plan')} </Text>
                      <Text color={theme.ai} bold>[g]</Text>
                      <Text color={theme.text}> {t(lang, 'AI带学', 'Guided')} </Text>
                      <Text color={theme.accent} bold>[C]</Text>
                      <Text color={theme.text}> {t(lang, '课程', 'Course')} </Text>
                      <Text color={theme.accent} bold>[r]</Text>
                      <Text color={theme.text}> {t(lang, '继续', 'Resume')}</Text>
                    </Text>
                    {innerH >= 9 ? (
                      <Text wrap={asciiMode ? undefined : 'truncate-end'}>
                        <Text color={theme.primary} bold>[o]</Text>
                        <Text color={theme.text}> {t(lang, '操作', 'Ops')}  </Text>
                        <Text color={theme.accent} bold>[m]</Text>
                        <Text color={theme.text}> {t(lang, '卡片', 'Cards')}  </Text>
                        <Text color={theme.accent} bold>[/]</Text>
                        <Text color={theme.text}> {t(lang, '排序', 'Order')}  </Text>
                        <Text color={theme.ai} bold>[v]</Text>
                        <Text color={theme.text}> {t(lang, '语音', 'Voice')}  </Text>
                        <Text color={theme.warning} bold>[a]</Text>
                        <Text color={theme.text}> {t(lang, '归档', 'Arch')}  </Text>
                        <Text color={theme.error} bold>[d]</Text>
                        <Text color={theme.text}> {t(lang, '删除', 'Del')}  </Text>
                        <Text color={theme.success} bold>[s]</Text>
                        <Text color={theme.text}> {t(lang, '示例', 'Sample')}</Text>
                      </Text>
                    ) : null}
                  </Box>
                ) : (
              <Box flexDirection="column">
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  <Text>
                    <Text color={theme.primary} bold>[Enter]</Text>
                    <Text color={theme.text}> {t(lang, '开始练习', 'Start practice')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.accent} bold>[R]</Text>
                    <Text color={theme.text}> {t(lang, '定制本轮', 'Configure round')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.accent} bold>[r]</Text>
                    <Text color={theme.text}> {t(lang, '继续上次', 'Resume last')}{resumeRunForDeck ? '' : t(lang, ' (新轮)', ' (new)')}</Text>
                  </Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  <Text>
                    <Text color={theme.primary} bold>[p]</Text>
                    <Text color={theme.text}> {t(lang, '今日计划', 'Daily Plan')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.ai} bold>[g]</Text>
                    <Text color={theme.text}> {t(lang, 'AI带学', 'Guided')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.accent} bold>[C]</Text>
                    <Text color={theme.text}> {t(lang, '课程设置', 'Course Settings')}</Text>
                  </Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  <Text>
                    <Text color={theme.accent} bold>[m]</Text>
                    <Text color={theme.text}> {t(lang, '管理题组 / 查看卡片', 'Manage deck / cards')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.ai} bold>[v]</Text>
                    <Text color={theme.text}> {t(lang, '导出语音包', 'Voice Pack')}</Text>
                  </Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  <Text>
                    <Text color={theme.primary} bold>[o]</Text>
                    <Text color={theme.text}> {t(lang, '导入 JSON / 合并 / 拆分题组', 'Import JSON / Merge / Split')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.accent} bold>[ / ]</Text>
                    <Text color={theme.text}> {t(lang, '上移 / 下移题组', 'Reorder deck')}</Text>
                  </Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  <Text>
                    <Text color={theme.warning} bold>[a]</Text>
                    <Text color={theme.text}> {selectedDeck.archived ? t(lang, '恢复题组', 'Unarchive') : t(lang, '归档', 'Archive')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.error} bold>[d]</Text>
                    <Text color={theme.text}> {t(lang, '删除题组', 'Delete')}</Text>
                  </Text>
                  <Text>
                    <Text color={theme.success} bold>[s]</Text>
                    <Text color={theme.text}> {sampleLoaded ? t(lang, '移除示例课', 'Remove sample') : t(lang, '载入示例课', 'Load sample')}</Text>
                  </Text>
                </Box>
              </Box>
                )}
              </>
            ) : null}
          </Box>
        </Panel>
      );
    },
    [focusSection, selectedWork, selectedDeck, lang, asciiMode, theme, progressMap, resumeRunForDeck, sampleLoaded, todayHubItems, handleTodayHubClick, pageActive],
  );

  const filterBadge = `[${t(lang, '筛选', filterEditing ? 'Filter' : 'Filtered')} ${filteredDecks.length}/${scopedDecks.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);
  const ell = asciiMode ? '...' : '…';

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* KPI Header Strip */}
      <Box flexDirection="column" width={width} height={kpiHeight} flexShrink={0} paddingX={1}>
        <Box flexDirection="row" gap={2} height={1} overflow="hidden">
          <Badge label={course ?? t(lang, '全部课程', 'All Courses')} tone="primary" variant="solid" />
          <Text color={theme.muted}>
            {t(lang, '今日到期', 'Due')}: <Text color={kpi.due > 0 ? theme.warning : theme.success} bold>{kpi.due}</Text>
          </Text>
          <Text color={theme.muted}>
            {t(lang, '今日已练', 'Reviewed')}: <Text color={theme.text} bold>{kpi.reviewed}</Text>
          </Text>
          <Text color={theme.muted}>
            {t(lang, '连续天数', 'Streak')}: <Text color={theme.accent} bold>{kpi.streak}{t(lang, '天', 'd')}</Text>
          </Text>
          <Text color={theme.muted}>
            {t(lang, '掌握度', 'Mastery')}: <Text color={theme.success} bold>{kpi.masteryPct}%</Text>
          </Text>
        </Box>
        {kpi.focusProgress ? (
          <Box height={1} overflow="hidden">
            <ProgressBar
              ratio={kpi.focusProgress.done / Math.max(1, kpi.focusProgress.total)}
              width={Math.min(54, Math.max(20, width - 4))}
              label={t(
                lang,
                `考纲重点 (${kpi.focusProgress.done}/${kpi.focusProgress.total})`,
                `Exam Focus (${kpi.focusProgress.done}/${kpi.focusProgress.total})`,
              )}
              style="line"
            />
          </Box>
        ) : null}
        <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(1, width - 2))}</Text>
      </Box>

      {/* Calm Proactive Daily Briefing Strip (Round 85 Track D2 — opt-out, 1/day, never steals focus) */}
      {showBriefingBar && dailyBriefing ? (
        <Box
          height={1}
          width={width}
          backgroundColor={theme.surface}
          overflow="hidden"
          paddingX={1}
          flexDirection="row"
          justifyContent="space-between"
        >
          {(() => {
            const actionTxt = ` ${dailyBriefing.actionLabel}`;
            const dismissTxt = width >= LAYOUT_BP.CONTENT_NARROW ? ` ${t(lang, '[Z]今日隐藏', '[Z]Hide')}` : ' [Z]';
            const rightW = displayWidth(actionTxt) + displayWidth(dismissTxt);
            const leftBudget = Math.max(12, width - 2 - rightW - 2);
            const sep = asciiMode ? ' - ' : ' · ';
            const fullLeft =
              width >= LAYOUT_BP.WIDE
                ? `${asciiMode ? '*' : '✦'} ${dailyBriefing.headline}${sep}${dailyBriefing.reason}`
                : `${asciiMode ? '*' : '✦'} ${dailyBriefing.headline}`;
            return (
              <>
                <ChromeLabel text={fullLeft} maxWidth={leftBudget} tone="ai" ascii={asciiMode} />
                <Box flexDirection="row" flexShrink={0}>
                  <ClickableBox clickActive={pageActive} onClick={handleAcceptBriefing}>
                    <Text color={theme.accent} bold>
                      {actionTxt}
                    </Text>
                  </ClickableBox>
                  <ClickableBox clickActive={pageActive} onClick={handleDismissBriefing}>
                    <Text color={theme.dim}>{dismissTxt}</Text>
                  </ClickableBox>
                </Box>
              </>
            );
          })()}
        </Box>
      ) : null}

      {/* Inline `/` Live Deck Search & Filter Bar */}
      {showFilterBar ? (
        <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
          <Text color={filterEditing ? theme.primary : theme.accent} bold>
            {filterBadge}
          </Text>
          <Box flexGrow={1} overflow="hidden">
            <KeyScope id="library:filter" opaque active={isActive && filterEditing}>
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
                isActive={isActive && filterEditing}
                width={filterInputW}
                prompt="/"
                placeholder={t(lang, `关键词${ell}`, `keyword${ell}`)}
                maxLength={120}
              />
            </KeyScope>
          </Box>
          {filterRightHint ? (
            <Text color={theme.dim} wrap="truncate">
              {filterRightHint}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* Main Master-Detail Split */}
      <SplitPane
        width={width}
        height={bodyHeight}
        breakpoint={LAYOUT_BP.SPLIT_DEFAULT}
        narrowMode="stack"
        leftWidth={0.44}
        minLeft={28}
        minRight={34}
        activePane="left"
        left={renderLeftPane}
        right={renderRightPane}
      />

      {/* Lazy-loaded Heavy Modals (each wrapped in its own opaque KeyScope outside Suspense) */}
      {manageDeckId ? (
        <KeyScope id="library:deck-manage" opaque>
          <Suspense fallback={null}>
            <DeckManageModal
              host={host}
              deckId={manageDeckId}
              isActive={isActive}
              width={width}
              height={height}
              onClose={() => setManageDeckId(null)}
              onUpdated={() => {
                void actions.refresh();
              }}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {voiceOpen ? (
        <KeyScope id="library:voice-pack" opaque>
          <Suspense fallback={null}>
            <VoicePackModal
              host={host}
              isActive={isActive}
              onClose={() => setVoiceOpen(false)}
              width={width}
              height={height}
              initialCourse={course}
              initialDeckId={selectedDeck?.id ?? null}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {dailyPlanOpen ? (
        <KeyScope id="library:daily-plan" opaque>
          <Suspense fallback={null}>
            <DailyPlanModal
              host={host}
              isActive={isActive}
              width={width}
              height={height}
              onClose={() => setDailyPlanOpen(false)}
              onUpdated={() => {
                void actions.refresh();
              }}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {courseSettingsOpen ? (
        <KeyScope id="library:course-settings" opaque>
          <Suspense fallback={null}>
            <CourseSettingsModal
              host={host}
              course={course ?? selectedDeck?.course ?? null}
              isActive={isActive}
              width={width}
              height={height}
              onClose={() => setCourseSettingsOpen(false)}
              onUpdated={() => {
                void actions.refresh();
              }}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {deckOpsOpen ? (
        <KeyScope id="library:deck-ops" opaque>
          <Suspense fallback={null}>
            <DeckOpsModal
              host={host}
              selectedDeckId={selectedDeck?.id ?? null}
              isActive={isActive}
              width={width}
              height={height}
              onClose={() => setDeckOpsOpen(false)}
              onUpdated={() => {
                void actions.refresh();
              }}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {guidedOpen ? (
        <KeyScope id="library:guided-study" opaque>
          <Suspense fallback={null}>
            <GuidedStudyModal
              host={host}
              course={course ?? selectedDeck?.course ?? null}
              selectedDeckId={selectedDeck?.id ?? null}
              selectedDeckTitle={selectedDeck ? String(selectedDeck.title ?? selectedDeck.name ?? selectedDeck.id) : null}
              isActive={isActive}
              width={width}
              height={height}
              onClose={() => setGuidedOpen(false)}
              onUpdated={() => {
                void actions.refresh();
              }}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {roundConfigOpen ? (
        <KeyScope id="library:round-config" opaque>
          <Suspense fallback={null}>
            <RoundConfigModal
              host={host}
              isActive={isActive}
              width={width}
              height={height}
              selectedDeckId={selectedDeck?.id ?? null}
              selectedDeckTitle={selectedDeck ? String(selectedDeck.title ?? selectedDeck.name ?? selectedDeck.id) : null}
              activeCourse={course ?? selectedDeck?.course ?? null}
              onClose={() => setRoundConfigOpen(false)}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {/* Archive / Restore Confirmation Dialog */}
      {confirmArchiveDeck ? (
        <KeyScope id="library:confirm-archive" opaque>
          <ConfirmDialog
            title={
              confirmArchiveDeck.archived
                ? t(lang, '恢复已归档题组', 'Restore Archived Deck')
                : t(lang, '归档题组', 'Archive Deck')
            }
            message={
              confirmArchiveDeck.archived
                ? t(
                    lang,
                    `确定将「${confirmArchiveDeck.title ?? confirmArchiveDeck.id}」从归档中恢复为正常题组吗？`,
                    `Restore "${confirmArchiveDeck.title ?? confirmArchiveDeck.id}" from archive?`,
                  )
                : t(
                    lang,
                    `确定归档「${confirmArchiveDeck.title ?? confirmArchiveDeck.id}」吗？归档将中断该题组正在进行的练习。`,
                    `Archive "${confirmArchiveDeck.title ?? confirmArchiveDeck.id}"? Archiving will interrupt any active practice sessions for this deck.`,
                  )
            }
            confirmLabel={
              confirmArchiveDeck.archived ? t(lang, '确认恢复', 'Restore') : t(lang, '确认归档', 'Archive')
            }
            cancelLabel={t(lang, '取消', 'Cancel')}
            danger={!confirmArchiveDeck.archived}
            isActive={isActive}
            onConfirm={() => {
              const target = confirmArchiveDeck;
              setConfirmArchiveDeck(null);
              void handleArchiveToggle(target);
            }}
            onCancel={() => setConfirmArchiveDeck(null)}
          />
        </KeyScope>
      ) : null}

      {/* Delete Confirmation Dialog */}
      {confirmDeleteDeck ? (
        <KeyScope id="library:confirm-delete" opaque>
          <ConfirmDialog
            title={t(lang, '永久删除题组', 'Delete Deck Permanently')}
            message={
              confirmDeleteDeck.archived
                ? t(
                    lang,
                    `确定永久删除「${confirmDeleteDeck.title ?? confirmDeleteDeck.id}」？此操作不可恢复。`,
                    `Permanently delete "${confirmDeleteDeck.title ?? confirmDeleteDeck.id}"? This cannot be undone.`,
                  )
                : t(
                    lang,
                    `将先归档并永久删除「${confirmDeleteDeck.title ?? confirmDeleteDeck.id}」，此操作不可恢复。`,
                    `Archive and permanently delete "${confirmDeleteDeck.title ?? confirmDeleteDeck.id}"? This cannot be undone.`,
                  )
            }
            confirmLabel={t(lang, '确认删除', 'Delete')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            danger
            isActive={isActive}
            onConfirm={() => {
              void handleDeleteConfirmed();
            }}
            onCancel={() => setConfirmDeleteDeck(null)}
          />
        </KeyScope>
      ) : null}
    </Box>
  );
});
