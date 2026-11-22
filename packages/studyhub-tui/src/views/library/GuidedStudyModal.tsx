import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Divider,
  EmptyState,
  MarkdownView,
  Modal,
  ProgressBar,
  Spinner,
  StatusPill,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
  type PillStatus,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/index.js';

export interface StudySessionScopeItem {
  kind: 'source' | 'deck' | 'card' | string;
  id: string;
  [k: string]: unknown;
}

export interface StudyCheckItem {
  id: string;
  title: string;
  weight?: number;
  targetCardIds?: string[];
  topic?: string;
}

export interface StudyProgressItem {
  id: string;
  title: string;
  weight?: number;
  status: 'passed' | 'assisted' | 'self_reported' | 'needs_review' | 'pending' | string;
  evidenceAttemptIds?: string[];
  gradingSource?: string;
}

export interface StudySessionProgress {
  independentPassedCount: number;
  assistedCount: number;
  selfReportedCount?: number;
  pendingCount: number;
  needsReviewCount: number;
  totalCount: number;
  independentRatio: number;
  displayLine: string;
  lectureCoveredCount?: number;
  nextDayDueCount?: number;
  scopeChangedNote?: string | null;
  items?: StudyProgressItem[];
}

export interface StudySessionEstimate {
  status: 'estimating' | 'no_goal' | 'completed' | 'estimated' | string;
  minMinutes: number | null;
  maxMinutes: number | null;
  remainingItems: number;
  preliminary?: boolean;
  display?: string;
  message?: string;
}

export interface StudySessionCost {
  totalTokens: number;
  independentPassedCount: number;
  costPerIndependentCheckItem?:
    | 'pending_first_pass'
    | { tokens: number | null; includesTutoring?: boolean; measured?: boolean };
  breakdown?: {
    tutoring?: { tokens: number | null; measured?: boolean; note?: string };
    reusedQuestions?: { count: number; tokens?: number; note?: string };
    generation?: { tokens: number | null; measured?: boolean; note?: string };
    qaOrganize?: { tokens: number; note?: string };
  };
}

export interface StudyArtifact {
  id: string;
  kind?: string;
  title: string;
  topic?: string;
  sourceAnchors?: unknown[];
  markdown: string;
  updatedAt?: number;
}

export interface StudySessionRecord {
  id: string;
  courseId: string;
  scope?: StudySessionScopeItem[];
  goal?: {
    title?: string;
    checkItems?: StudyCheckItem[];
    scopeNote?: string;
  } | null;
  status: 'active' | 'paused' | 'ended' | string;
  version?: number;
  createdAt?: number;
  updatedAt?: number;
  artifactRefs?: StudyArtifact[];
  artifacts?: StudyArtifact[];
  progress?: StudySessionProgress;
  estimate?: StudySessionEstimate;
  cost?: StudySessionCost;
}

interface SessionListResponse {
  sessions?: StudySessionRecord[];
  total?: number;
}

interface SessionResumeResponse {
  found: boolean;
  session: StudySessionRecord | null;
  progress?: StudySessionProgress;
  estimate?: StudySessionEstimate;
  cost?: StudySessionCost;
  staleWarnings?: Array<{ kind?: string; id?: string; detail?: string }>;
}

interface MergedCheckItem {
  id: string;
  title: string;
  status: string;
  targetCardIds: string[];
  topic?: string;
}

export interface GuidedStudyModalProps {
  host: HostClient;
  course: string | null;
  selectedDeckId?: string | null;
  selectedDeckTitle?: string | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: () => void;
}

type SubMode = 'sessions' | 'workbench' | 'artifact';

function sessionStatusMeta(
  status: string | undefined,
  lang: 'zh' | 'en',
): { label: string; short: string; pill: PillStatus } {
  switch (status) {
    case 'active':
      return {
        label: t(lang, '进行中', 'Active'),
        short: t(lang, '进行', 'ACT'),
        pill: 'ok',
      };
    case 'paused':
      return {
        label: t(lang, '已暂停', 'Paused'),
        short: t(lang, '暂停', 'PAU'),
        pill: 'warn',
      };
    case 'ended':
      return {
        label: t(lang, '已结束', 'Ended'),
        short: t(lang, '结束', 'END'),
        pill: 'idle',
      };
    default:
      return {
        label: status || t(lang, '未知', 'Unknown'),
        short: status || '?',
        pill: 'idle',
      };
  }
}

function checkItemGlyph(
  status: string,
  asciiMode: boolean,
): { glyph: string; tone: 'success' | 'info' | 'accent' | 'warning' | 'muted' } {
  switch (status) {
    case 'passed':
      return { glyph: asciiMode ? '[x]' : '[✓]', tone: 'success' };
    case 'assisted':
      return { glyph: asciiMode ? '[~]' : '[◐]', tone: 'info' };
    case 'self_reported':
      return { glyph: asciiMode ? '[s]' : '[◔]', tone: 'accent' };
    case 'needs_review':
      return { glyph: '[!]', tone: 'warning' };
    default:
      return { glyph: '[ ]', tone: 'muted' };
  }
}

function formatEstimate(
  estimate: StudySessionEstimate | undefined,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): string {
  if (!estimate) return t(lang, '尚在估计', 'Estimating');
  if (estimate.status === 'estimated' && estimate.minMinutes !== null && estimate.maxMinutes !== null) {
    const dash = asciiMode ? '-' : '–';
    const range = `${estimate.minMinutes}${dash}${estimate.maxMinutes} ${t(lang, '分钟', 'min')}`;
    return estimate.preliminary ? `${range}${t(lang, ' (粗估)', ' (rough)')}` : range;
  }
  if (estimate.status === 'completed') return t(lang, '已完成', 'Done');
  if (estimate.status === 'no_goal') return t(lang, '未设检验项', 'No items');
  return t(lang, '尚在估计', 'Estimating');
}

function formatEstimateShort(
  estimate: StudySessionEstimate | undefined,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): string {
  if (!estimate) return '';
  if (estimate.status === 'estimated' && estimate.minMinutes !== null && estimate.maxMinutes !== null) {
    const dash = asciiMode ? '-' : '–';
    return `${estimate.minMinutes}${dash}${estimate.maxMinutes}m${estimate.preliminary ? '~' : ''}`;
  }
  if (estimate.status === 'completed') return t(lang, '完成', 'done');
  return '';
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function formatCostSummary(cost: StudySessionCost | undefined, lang: 'zh' | 'en'): string {
  if (!cost) return '';
  const tokens = Number(cost.totalTokens ?? 0);
  const reused = Number(cost.breakdown?.reusedQuestions?.count ?? 0);
  const measured = Boolean(cost.breakdown?.tutoring?.measured || cost.breakdown?.generation?.measured);
  if (tokens > 0) {
    return `${formatTokenCount(tokens)} tok`;
  }
  if (measured) return '0 tok';
  if (reused > 0) return t(lang, `复用${reused}题`, `${reused} reused`);
  return '';
}

function progressCounts(session: StudySessionRecord): { done: number; total: number } {
  const total = session.progress?.totalCount ?? session.goal?.checkItems?.length ?? 0;
  const done = session.progress?.independentPassedCount ?? 0;
  return { done, total };
}

export const GuidedStudyModal = memo(function GuidedStudyModal({
  host,
  course,
  selectedDeckId,
  selectedDeckTitle,
  isActive,
  width,
  height,
  onClose,
  onUpdated,
}: GuidedStudyModalProps) {
  const theme = useTheme();
  const { columns } = useWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const [scopeFilter, setScopeFilter] = useState<'course' | 'all'>(course ? 'course' : 'all');
  const [subMode, setSubMode] = useState<SubMode>('sessions');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');

  const [sessions, setSessions] = useState<StudySessionRecord[]>([]);
  const [readouts, setReadouts] = useState<Record<string, StudySessionRecord>>({});
  const [sessionIndex, setSessionIndex] = useState(0);
  const [checkIndex, setCheckIndex] = useState(0);
  const [artifactIndex, setArtifactIndex] = useState(0);

  const [creating, setCreating] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [createError, setCreateError] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [staleWarnings, setStaleWarnings] = useState<string[]>([]);

  const mountedRef = useRef(true);
  const autoModeSetRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Resolve canonical courseId matching lib/study-session.js createStudySession
  const resolvedCourseId = useMemo(() => {
    const courses = snapshot?.courses ?? [];
    const candidate = course || snapshot?.decks?.find((d) => d.id === selectedDeckId)?.course || '';
    if (candidate) {
      const match = courses.find((c) => c.name === candidate || c.id === candidate || c.title === candidate);
      if (match) return String(match.name ?? match.id ?? candidate).trim();
      return candidate.trim();
    }
    const activeRec = courses.find((c) => c.active !== false) ?? courses[0];
    if (activeRec) return String(activeRec.name ?? activeRec.id ?? '').trim();
    const fallbackDeck = (snapshot?.decks ?? []).find(
      (d) => !d.archived && !(d as Record<string, unknown>).systemKind && d.course,
    );
    return String(fallbackDeck?.course ?? '').trim();
  }, [course, selectedDeckId, snapshot?.courses, snapshot?.decks]);

  const listCourseArg = scopeFilter === 'course' && resolvedCourseId ? { courseId: resolvedCourseId } : {};

  const loadSessions = useCallback(
    async (preferSessionId?: string) => {
      setLoading(true);
      setError('');
      const res = await tryAction<SessionListResponse>(host, 'study.session.list', listCourseArg);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(res.error?.message || t(lang, '读取带学会话失败', 'Failed to load guided sessions'));
        setLoading(false);
        return;
      }
      const rawList = [...(res.value?.sessions ?? [])].sort(
        (a, b) => Number(b.updatedAt ?? b.createdAt ?? 0) - Number(a.updatedAt ?? a.createdAt ?? 0),
      );
      setSessions(rawList);

      // Hydrate full readouts (progress, estimate, cost) via study.session.get
      const targets = rawList.slice(0, 20);
      const fetched = await Promise.all(
        targets.map(async (item) => {
          const getRes = await tryAction<StudySessionRecord>(host, 'study.session.get', { sessionId: item.id });
          return getRes.ok && getRes.value ? [item.id, getRes.value] as const : null;
        }),
      );
      if (!mountedRef.current) return;
      const nextMap: Record<string, StudySessionRecord> = {};
      for (const pair of fetched) {
        if (pair) nextMap[pair[0]] = pair[1];
      }
      setReadouts(nextMap);

      let nextIdx = 0;
      if (preferSessionId) {
        const hit = rawList.findIndex((s) => s.id === preferSessionId);
        if (hit >= 0) nextIdx = hit;
      } else {
        const activeHit = rawList.findIndex((s) => s.status === 'active');
        if (activeHit >= 0) nextIdx = activeHit;
      }
      setSessionIndex(Math.min(nextIdx, Math.max(0, rawList.length - 1)));

      if (!autoModeSetRef.current) {
        autoModeSetRef.current = true;
        if (rawList.some((s) => s.status === 'active' || s.status === 'paused')) {
          setSubMode('workbench');
        }
      }
      setLoading(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, scopeFilter, resolvedCourseId, lang],
  );

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const enrichedSessions = useMemo(
    () => sessions.map((s) => readouts[s.id] ?? s),
    [sessions, readouts],
  );

  useEffect(() => {
    if (sessionIndex >= enrichedSessions.length) {
      setSessionIndex(Math.max(0, enrichedSessions.length - 1));
    }
  }, [enrichedSessions.length, sessionIndex]);

  const selectedSession = enrichedSessions[sessionIndex] ?? null;

  // Ensure selected session beyond first 20 is also hydrated on demand
  useEffect(() => {
    if (!selectedSession || readouts[selectedSession.id]) return;
    let alive = true;
    void (async () => {
      const res = await tryAction<StudySessionRecord>(host, 'study.session.get', { sessionId: selectedSession.id });
      if (!alive || !mountedRef.current) return;
      if (res.ok && res.value) {
        setReadouts((prev) => ({ ...prev, [selectedSession.id]: res.value! }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, selectedSession, readouts]);

  const mergedCheckItems = useMemo<MergedCheckItem[]>(() => {
    if (!selectedSession) return [];
    const goalItems = selectedSession.goal?.checkItems ?? [];
    const progressItems = selectedSession.progress?.items ?? [];
    const progById = new Map(progressItems.map((p) => [p.id, p]));
    if (goalItems.length > 0) {
      return goalItems.map((item, idx) => {
        const prog = progById.get(item.id) ?? progressItems[idx];
        return {
          id: item.id,
          title: item.title || prog?.title || item.id,
          status: prog?.status ?? 'pending',
          targetCardIds: Array.isArray(item.targetCardIds) ? item.targetCardIds : [],
          topic: item.topic,
        };
      });
    }
    return progressItems.map((item) => ({
      id: item.id,
      title: item.title || item.id,
      status: item.status ?? 'pending',
      targetCardIds: [],
    }));
  }, [selectedSession]);

  const artifacts = useMemo<StudyArtifact[]>(
    () => selectedSession?.artifactRefs ?? selectedSession?.artifacts ?? [],
    [selectedSession],
  );

  useEffect(() => {
    setCheckIndex((prev) => (mergedCheckItems.length === 0 ? 0 : Math.min(prev, mergedCheckItems.length - 1)));
  }, [mergedCheckItems.length]);

  useEffect(() => {
    setArtifactIndex((prev) => (artifacts.length === 0 ? 0 : Math.min(prev, artifacts.length - 1)));
    if (subMode === 'artifact' && artifacts.length === 0) {
      setSubMode('workbench');
    }
  }, [artifacts.length, subMode]);

  const selectedCheckItem = mergedCheckItems[checkIndex] ?? null;
  const activeArtifact = artifacts[artifactIndex] ?? null;

  const openCreateInput = useCallback(() => {
    if (!resolvedCourseId) {
      notify(
        t(lang, '请先选择一门课程（或按 [s] 载入示例课）后再新建带学', 'Select a course first (or load sample) before starting guided study'),
        'warning',
      );
      return;
    }
    setCreateError('');
    setNewGoalTitle(selectedDeckTitle ? `${selectedDeckTitle}` : '');
    setCreating(true);
  }, [resolvedCourseId, selectedDeckTitle, lang, notify]);

  const handleCreateSubmit = useCallback(
    async (rawTitle: string) => {
      const clean = rawTitle.trim();
      if (!clean) {
        setCreateError(t(lang, '请输入带学目标名称', 'Please enter a goal title'));
        return;
      }
      if (!resolvedCourseId) {
        setCreateError(t(lang, '未找到有效课程', 'No active course found'));
        return;
      }
      if (busyAction) return;
      setBusyAction('start');
      setCreateError('');
      const scope: StudySessionScopeItem[] = selectedDeckId ? [{ kind: 'deck', id: selectedDeckId }] : [];
      const res = await tryAction<StudySessionRecord>(host, 'study.session.start', {
        courseId: resolvedCourseId,
        scope,
        goal: { title: clean },
      });
      if (!mountedRef.current) return;
      setBusyAction('');
      if (!res.ok || !res.value) {
        const msg = res.error?.message || t(lang, '启动带学失败', 'Failed to start guided session');
        setCreateError(msg);
        notify(msg, 'error');
        return;
      }
      setCreating(false);
      setNewGoalTitle('');
      setStaleWarnings([]);
      setSubMode('workbench');
      await loadSessions(res.value.id);
      onUpdated?.();
      notify(t(lang, `已启动带学：「${clean}」`, `Started guided study: "${clean}"`), 'success');
    },
    [resolvedCourseId, busyAction, selectedDeckId, host, lang, notify, loadSessions, onUpdated],
  );

  const handlePause = useCallback(async () => {
    if (!selectedSession || busyAction) return;
    if (selectedSession.status !== 'active') {
      notify(t(lang, '仅进行中的带学可以暂停', 'Only active sessions can be paused'), 'info');
      return;
    }
    setBusyAction('pause');
    const res = await tryAction<StudySessionRecord>(host, 'study.session.pause', {
      sessionId: selectedSession.id,
    });
    if (!mountedRef.current) return;
    setBusyAction('');
    if (!res.ok) {
      notify(res.error?.message || t(lang, '暂停失败', 'Failed to pause session'), 'error');
      return;
    }
    await loadSessions(selectedSession.id);
    onUpdated?.();
    notify(t(lang, '已暂停当前带学', 'Paused guided session'), 'success');
  }, [selectedSession, busyAction, host, lang, notify, loadSessions, onUpdated]);

  const handleResume = useCallback(async () => {
    if (!selectedSession || busyAction) return;
    if (selectedSession.status === 'ended') {
      notify(t(lang, '该带学已结束，请按 [n] 新建会话', 'Session already ended; press [n] to start a new one'), 'info');
      return;
    }
    setBusyAction('resume');
    const resumeRes = await tryAction<SessionResumeResponse>(host, 'study.session.resume', {
      sessionId: selectedSession.id,
    });
    if (!mountedRef.current) return;
    if (!resumeRes.ok || !resumeRes.value) {
      setBusyAction('');
      notify(resumeRes.error?.message || t(lang, '恢复失败', 'Failed to resume session'), 'error');
      return;
    }
    const warnings = (resumeRes.value.staleWarnings ?? [])
      .map((w) => w.detail || `${w.kind ?? 'item'}: ${w.id ?? ''}`)
      .filter(Boolean);
    setStaleWarnings(warnings);

    if (selectedSession.status === 'paused') {
      const updRes = await tryAction<StudySessionRecord>(host, 'study.session.update', {
        sessionId: selectedSession.id,
        status: 'active',
      });
      if (!mountedRef.current) return;
      if (!updRes.ok) {
        setBusyAction('');
        notify(updRes.error?.message || t(lang, '更新会话状态失败', 'Failed to reactivate session'), 'error');
        return;
      }
    }
    setBusyAction('');
    await loadSessions(selectedSession.id);
    onUpdated?.();
    if (warnings.length > 0) {
      notify(
        t(
          lang,
          `已恢复带学 · ${warnings.length} 条变更提醒：${warnings[0]}`,
          `Resumed with ${warnings.length} stale warning(s): ${warnings[0]}`,
        ),
        'warning',
      );
    } else {
      notify(t(lang, '已恢复带学会话', 'Resumed guided session'), 'success');
    }
  }, [selectedSession, busyAction, host, lang, notify, loadSessions, onUpdated]);

  const handleEndConfirmed = useCallback(async () => {
    setConfirmEnd(false);
    if (!selectedSession || busyAction) return;
    setBusyAction('end');
    const res = await tryAction<StudySessionRecord>(host, 'study.session.end', {
      sessionId: selectedSession.id,
    });
    if (!mountedRef.current) return;
    setBusyAction('');
    if (!res.ok) {
      notify(res.error?.message || t(lang, '结束带学失败', 'Failed to end session'), 'error');
      return;
    }
    await loadSessions(selectedSession.id);
    onUpdated?.();
    notify(t(lang, '已结束该带学会话', 'Ended guided session'), 'success');
  }, [selectedSession, busyAction, host, lang, notify, loadSessions, onUpdated]);

  const handlePractice = useCallback(async () => {
    if (!selectedSession || busyAction) return;
    const sessionDeckIds = (selectedSession.scope ?? [])
      .filter((s) => s.kind === 'deck' && s.id)
      .map((s) => String(s.id));
    const fallbackDeckId = sessionDeckIds[0] || selectedDeckId || undefined;

    const targetItem =
      subMode === 'workbench'
        ? selectedCheckItem
        : mergedCheckItems.find((item) => item.status !== 'passed') ?? mergedCheckItems[0] ?? null;

    let reviewScope: Array<{ deckId?: string; cardId?: string }> = [];
    if (targetItem && targetItem.targetCardIds.length > 0) {
      reviewScope = targetItem.targetCardIds.map((cardId) => ({
        ...(fallbackDeckId ? { deckId: fallbackDeckId } : {}),
        cardId,
      }));
    } else if (sessionDeckIds.length > 0) {
      reviewScope = sessionDeckIds.map((deckId) => ({ deckId }));
    } else {
      const cardScope = (selectedSession.scope ?? [])
        .filter((s) => s.kind === 'card' && s.id)
        .map((s) => ({ ...(fallbackDeckId ? { deckId: fallbackDeckId } : {}), cardId: String(s.id) }));
      if (cardScope.length > 0) {
        reviewScope = cardScope;
      } else if (fallbackDeckId) {
        reviewScope = [{ deckId: fallbackDeckId }];
      }
    }

    setBusyAction('practice');
    const startArgs: Record<string, unknown> =
      reviewScope.length > 0
        ? { mode: 'path', scope: reviewScope }
        : { mode: 'path', ...(selectedSession.courseId ? { course: selectedSession.courseId } : {}) };
    const res = await tryAction<{ id?: string }>(host, 'review.start', startArgs);
    if (!mountedRef.current) return;
    setBusyAction('');
    if (!res.ok || !res.value?.id) {
      notify(res.error?.message || t(lang, '当前范围暂无可练习题目', 'No practice questions available for this scope'), 'warning');
      return;
    }
    onClose();
    navigate('review', { runId: res.value.id });
  }, [selectedSession, busyAction, selectedDeckId, subMode, selectedCheckItem, mergedCheckItems, host, notify, lang, onClose, navigate]);

  const modalInputActive = isActive && !creating && !confirmEnd;

  useInput(
    (input, key) => {
      if (busyAction || loading) return;

      if (subMode === 'artifact') {
        if (key.escape || input === 'b') {
          setSubMode('workbench');
          return;
        }
        if (key.tab) {
          setSubMode('sessions');
          return;
        }
        if (input === '1') {
          setSubMode('sessions');
          return;
        }
        if (input === '2') {
          setSubMode('workbench');
          return;
        }
        if ((key.leftArrow || input === ',') && artifacts.length > 1) {
          setArtifactIndex((i) => (i - 1 + artifacts.length) % artifacts.length);
          return;
        }
        if ((key.rightArrow || input === '.') && artifacts.length > 1) {
          setArtifactIndex((i) => (i + 1) % artifacts.length);
          return;
        }
        return;
      }

      if (key.tab) {
        setSubMode((prev) => (prev === 'sessions' ? 'workbench' : 'sessions'));
        return;
      }
      if (input === '1') {
        setSubMode('sessions');
        return;
      }
      if (input === '2') {
        setSubMode('workbench');
        return;
      }
      if ((input === '3' || input === 'a') && artifacts.length > 0) {
        setSubMode('artifact');
        return;
      }
      if (input === 'f' && resolvedCourseId) {
        setStaleWarnings([]);
        setScopeFilter((prev) => (prev === 'course' ? 'all' : 'course'));
        return;
      }
      if (input === 'n') {
        openCreateInput();
        return;
      }
      if (input === 'p' && selectedSession) {
        void handlePause();
        return;
      }
      if (input === 'r' && selectedSession) {
        void handleResume();
        return;
      }
      if (input === 'e' && selectedSession) {
        if (selectedSession.status === 'ended') {
          notify(t(lang, '该带学已结束', 'Session has already ended'), 'info');
        } else {
          setConfirmEnd(true);
        }
        return;
      }
      if (key.return && selectedSession) {
        void handlePractice();
      }
    },
    { isActive: modalInputActive },
  );

  // Frame geometry respecting 5-row Modal chrome across 80x24, 120x36, 160x44
  const frameW = Math.max(46, Math.min(96, Math.min(width, columns) - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);

  const hasStale = staleWarnings.length > 0;
  const overheadRows = 2 + (creating ? 2 : 0) + (hasStale ? 1 : 0);
  const contentH = Math.max(5, bodyH - overheadRows);

  const hints = useMemo<KeyHint[]>(() => {
    if (creating) {
      return [
        { key: 'Enter', label: t(lang, '确认创建', 'Start') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    if (subMode === 'artifact') {
      const list: KeyHint[] = [];
      if (artifacts.length > 1) list.push({ key: asciiMode ? '<-/->' : '←/→', label: t(lang, '切换文稿', 'Switch') });
      list.push({ key: 'j/k', label: t(lang, '滚动', 'Scroll') });
      list.push({ key: 'b/Esc', label: t(lang, '返回', 'Back') });
      return list;
    }
    const list: KeyHint[] = [{ key: 'n', label: t(lang, '新建', 'New') }];
    if (selectedSession) {
      list.push({ key: 'Enter', label: t(lang, '去练习', 'Practice') });
      if (selectedSession.status === 'active') list.push({ key: 'p', label: t(lang, '暂停', 'Pause') });
      if (selectedSession.status === 'paused') list.push({ key: 'r', label: t(lang, '恢复', 'Resume') });
      if (selectedSession.status !== 'ended') list.push({ key: 'e', label: t(lang, '结束', 'End') });
      if (artifacts.length > 0) list.push({ key: 'a', label: t(lang, '讲解', 'Artifacts') });
    }
    list.push({ key: 'Tab', label: subMode === 'sessions' ? t(lang, '工作台', 'Workbench') : t(lang, '会话', 'Sessions') });
    list.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return list;
  }, [creating, subMode, artifacts.length, selectedSession, lang, asciiMode]);

  const renderSessionRow = useCallback(
    (item: StudySessionRecord, ctx: VirtualListRenderContext) => {
      const st = sessionStatusMeta(item.status, lang);
      const { done, total } = progressCounts(item);
      const tag = `[${st.short}]`;
      const est = formatEstimateShort(item.estimate, lang, asciiMode);
      const costStr = formatCostSummary(item.cost, lang);
      const metaParts = [`${done}/${total}`];
      if (est) metaParts.push(est);
      if (costStr) metaParts.push(costStr);
      const meta = ` ${metaParts.join(' · ')}`;
      const titleBudget = Math.max(8, ctx.width - displayWidth(tag) - 1 - displayWidth(meta));
      const title = padDisplay(
        truncateDisplay(item.goal?.title || item.courseId || item.id, titleBudget),
        titleBudget,
      );
      const fg = ctx.selected ? theme.selectionFg : item.status === 'ended' ? theme.dim : theme.text;
      const tagColor = ctx.selected
        ? theme.selectionFg
        : item.status === 'active'
          ? theme.success
          : item.status === 'paused'
            ? theme.warning
            : theme.muted;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={tagColor}>{tag} </Text>
          {title}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{meta}</Text>
        </Text>
      );
    },
    [lang, asciiMode, theme],
  );

  const renderCheckRow = useCallback(
    (item: MergedCheckItem, ctx: VirtualListRenderContext) => {
      const { glyph, tone } = checkItemGlyph(item.status, asciiMode);
      const cardCountTag =
        item.targetCardIds.length > 0 ? ` (${item.targetCardIds.length}${t(lang, '题', 'q')})` : '';
      const topicTag = item.topic && ctx.width >= 48 ? ` [${truncateDisplay(item.topic, 12)}]` : '';
      const suffix = `${topicTag}${cardCountTag}`;
      const titleBudget = Math.max(8, ctx.width - displayWidth(glyph) - 1 - displayWidth(suffix));
      const title = padDisplay(truncateDisplay(item.title, titleBudget), titleBudget);
      const glyphColor = ctx.selected ? theme.selectionFg : theme[tone];
      const fg = ctx.selected ? theme.selectionFg : item.status === 'passed' ? theme.dim : theme.text;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={glyphColor}>{glyph} </Text>
          {title}
          {suffix ? <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{suffix}</Text> : null}
        </Text>
      );
    },
    [asciiMode, lang, theme],
  );

  const scopeBadgeLabel =
    scopeFilter === 'course' && resolvedCourseId
      ? resolvedCourseId
      : t(lang, '全部课程', 'All Courses');

  const subtitle = busyAction
    ? t(lang, `处理中${ell}`, `Working${ell}`)
    : `${enrichedSessions.length} ${t(lang, '个会话', 'sessions')}`;

  return (
    <>
      <Modal
        title={t(lang, 'AI 带学工作台', 'Guided Study Workbench')}
        icon={asciiMode ? '*' : '✦'}
        tone="ai"
        subtitle={subtitle}
        width={frameW}
        height={frameH}
        onClose={subMode === 'artifact' || creating || confirmEnd ? undefined : onClose}
        isActive={isActive && !confirmEnd}
        hints={hints}
      >
        {/* Top Tab & Course Scope Strip (2 rows) */}
        <Box flexDirection="column" flexShrink={0}>
          <Box flexDirection="row" height={1} overflow="hidden" gap={1}>
            <Text
              color={subMode === 'sessions' ? theme.primary : theme.muted}
              bold={subMode === 'sessions'}
            >
              {`[1] ${t(lang, '会话', 'Sessions')}(${enrichedSessions.length})`}
            </Text>
            <Text
              color={subMode === 'workbench' ? theme.primary : theme.muted}
              bold={subMode === 'workbench'}
            >
              {`[2] ${t(lang, '工作台', 'Workbench')}`}
            </Text>
            {artifacts.length > 0 ? (
              <Text
                color={subMode === 'artifact' ? theme.ai : theme.muted}
                bold={subMode === 'artifact'}
              >
                {`[3] ${t(lang, '讲解', 'Artifacts')}(${artifacts.length})`}
              </Text>
            ) : null}
            <Box flexGrow={1} />
            <Badge label={truncateDisplay(scopeBadgeLabel, 18)} tone="accent" variant="soft" />
            {resolvedCourseId && innerW >= 54 ? (
              <Text color={theme.dim}>{t(lang, '[f] 切换', '[f] Scope')}</Text>
            ) : null}
          </Box>
          <Divider width={innerW} />
        </Box>

        {/* Inline New Session Input (2 rows when creating) */}
        {creating ? (
          <Box flexDirection="column" height={2} flexShrink={0} overflow="hidden">
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text color={theme.accent} bold>{t(lang, '新目标: ', 'Goal: ')}</Text>
              <TextInput
                value={newGoalTitle}
                onChange={(v) => {
                  setNewGoalTitle(v);
                  if (createError) setCreateError('');
                }}
                onSubmit={(val) => {
                  void handleCreateSubmit(val);
                }}
                onCancel={() => {
                  setCreating(false);
                  setCreateError('');
                }}
                placeholder={t(lang, `输入学习目标，按 Enter 启动带学${ell}`, `Enter goal title, press Enter to start${ell}`)}
                width={Math.max(12, innerW - (lang === 'en' ? 6 : 7) - 4)}
                isActive={isActive && creating && !confirmEnd}
                prompt={asciiMode ? '> ' : '› '}
              />
            </Box>
            <Text color={createError ? theme.error : theme.muted} wrap="truncate-end">
              {createError ||
                t(
                  lang,
                  `课程: ${resolvedCourseId}${selectedDeckTitle ? ` · 题组: ${selectedDeckTitle}` : ''} · Enter 启动 · Esc 取消`,
                  `Course: ${resolvedCourseId}${selectedDeckTitle ? ` · Deck: ${selectedDeckTitle}` : ''} · Enter start · Esc cancel`,
                )}
            </Text>
          </Box>
        ) : null}

        {/* Stale Warnings Banner (1 row when present) */}
        {hasStale ? (
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text color={theme.warning} wrap="truncate-end">
              {`${asciiMode ? '[!]' : '▲'} ${staleWarnings[0]}${staleWarnings.length > 1 ? ` (+${staleWarnings.length - 1})` : ''}`}
            </Text>
          </Box>
        ) : null}

        {/* Main Content */}
        {loading ? (
          <Box height={contentH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, `正在读取带学工作台${ell}`, `Loading guided study sessions${ell}`)} active={isActive} />
          </Box>
        ) : error && enrichedSessions.length === 0 ? (
          <Box height={contentH} flexDirection="column" paddingY={1}>
            <Text color={theme.error} bold>{error}</Text>
            <Text color={theme.muted}>
              {t(lang, '按 [n] 新建带学，或按 [Esc] 关闭', 'Press [n] to start a session, or [Esc] to close')}
            </Text>
          </Box>
        ) : enrichedSessions.length === 0 ? (
          <EmptyState
            title={t(lang, '暂无 AI 带学会话', 'No Guided Study sessions yet')}
            hint={
              resolvedCourseId
                ? t(
                    lang,
                    `按 [n] 为「${selectedDeckTitle || resolvedCourseId}」新建带学目标${scopeFilter === 'course' ? ' · [f] 查看全部' : ''}`,
                    `Press [n] to start for "${selectedDeckTitle || resolvedCourseId}"${scopeFilter === 'course' ? ' · [f] All' : ''}`,
                  )
                : t(lang, '请先在学习库中选择一门课程或题组', 'Select a course or deck in Library first')
            }
            width={innerW}
            height={contentH}
          />
        ) : subMode === 'artifact' && activeArtifact ? (
          <Box flexDirection="column" height={contentH} overflow="hidden">
            <Box height={1} overflow="hidden" flexDirection="row" gap={1}>
              <Badge label={`${artifactIndex + 1}/${artifacts.length}`} tone="ai" variant="soft" />
              <Text color={theme.text} bold wrap="truncate-end">
                {activeArtifact.title}
              </Text>
              {activeArtifact.topic ? (
                <Text color={theme.muted} wrap="truncate-end">· {activeArtifact.topic}</Text>
              ) : null}
            </Box>
            <Divider width={innerW} />
            <MarkdownView
              markdown={activeArtifact.markdown || t(lang, '*(文稿为空)*', '*(Empty artifact)*')}
              width={innerW}
              height={Math.max(3, contentH - 2)}
              isActive={modalInputActive && subMode === 'artifact'}
            />
          </Box>
        ) : subMode === 'sessions' ? (
          <Box flexDirection="column" height={contentH} overflow="hidden">
            <VirtualList
              items={enrichedSessions}
              height={Math.max(3, contentH - 3)}
              width={innerW}
              selectedIndex={sessionIndex}
              onChange={setSessionIndex}
              onSelect={() => {
                void handlePractice();
              }}
              isActive={modalInputActive && subMode === 'sessions'}
              keyExtractor={(item) => item.id}
              renderItem={renderSessionRow}
            />
            <Divider width={innerW} />
            <Box height={2} flexDirection="column" overflow="hidden">
              {selectedSession ? (
                <>
                  <Text color={theme.text} wrap="truncate-end">
                    {selectedSession.progress?.displayLine ||
                      t(
                        lang,
                        `检验项共 ${selectedSession.goal?.checkItems?.length ?? 0} 项`,
                        `${selectedSession.goal?.checkItems?.length ?? 0} check items`,
                      )}
                  </Text>
                  <Text color={theme.muted} wrap="truncate-end">
                    {`${t(lang, '预计', 'Est')}: ${formatEstimate(selectedSession.estimate, lang, asciiMode)}`}
                    {formatCostSummary(selectedSession.cost, lang)
                      ? ` · ${t(lang, '消耗', 'Cost')}: ${formatCostSummary(selectedSession.cost, lang)}`
                      : ''}
                    {artifacts.length > 0 ? ` · ${artifacts.length}${t(lang, '份讲解', ' artifacts')}` : ''}
                    {` · ${t(lang, '[Tab] 工作台', '[Tab] Workbench')}`}
                  </Text>
                </>
              ) : null}
            </Box>
          </Box>
        ) : (
          /* Sub-mode: Workbench */
          <Box flexDirection="column" height={contentH} overflow="hidden">
            {selectedSession ? (
              <>
                {/* Workbench Header (2 rows) */}
                <Box flexDirection="column" height={2} flexShrink={0} overflow="hidden">
                  <Box flexDirection="row" height={1} gap={1} overflow="hidden">
                    <StatusPill
                      label={sessionStatusMeta(selectedSession.status, lang).label}
                      status={sessionStatusMeta(selectedSession.status, lang).pill}
                    />
                    <Text color={theme.text} bold wrap="truncate-end">
                      {selectedSession.goal?.title || selectedSession.courseId || selectedSession.id}
                    </Text>
                  </Box>
                  <Box flexDirection="row" height={1} gap={1} overflow="hidden">
                    <Text color={theme.muted} wrap="truncate-end">
                      {`${t(lang, '课程', 'Course')}: ${selectedSession.courseId}`}
                      {` · ${t(lang, '预计', 'Est')}: ${formatEstimate(selectedSession.estimate, lang, asciiMode)}`}
                      {formatCostSummary(selectedSession.cost, lang)
                        ? ` · ${t(lang, '消耗', 'Cost')}: ${formatCostSummary(selectedSession.cost, lang)}`
                        : ''}
                    </Text>
                  </Box>
                </Box>

                {/* Progress Bar (1 row) */}
                <Box height={1} flexShrink={0} overflow="hidden">
                  {(() => {
                    const { done, total } = progressCounts(selectedSession);
                    return (
                      <ProgressBar
                        ratio={total > 0 ? done / total : 0}
                        width={Math.min(innerW, 56)}
                        style="block"
                        label={t(lang, `检验 ${done}/${total}`, `Items ${done}/${total}`)}
                      />
                    );
                  })()}
                </Box>

                <Divider width={innerW} />

                {/* Checklist */}
                {mergedCheckItems.length === 0 ? (
                  <EmptyState
                    title={t(lang, '当前会话暂无检验项', 'No check items in this session')}
                    hint={t(lang, '按 [Enter] 直接进入范围刷题练习', 'Press [Enter] to practice the session scope')}
                    width={innerW}
                    height={Math.max(3, contentH - 4 - (artifacts.length > 0 ? 2 : 0))}
                  />
                ) : (
                  <VirtualList
                    items={mergedCheckItems}
                    height={Math.max(3, contentH - 4 - (artifacts.length > 0 ? 2 : 0))}
                    width={innerW}
                    selectedIndex={checkIndex}
                    onChange={setCheckIndex}
                    onSelect={() => {
                      void handlePractice();
                    }}
                    isActive={modalInputActive && subMode === 'workbench'}
                    keyExtractor={(item, idx) => `${item.id}:${idx}`}
                    renderItem={renderCheckRow}
                  />
                )}

                {/* Teaching Artifacts Bar (2 rows when artifacts exist) */}
                {artifacts.length > 0 ? (
                  <>
                    <Divider width={innerW} />
                    <Box height={1} flexShrink={0} overflow="hidden">
                      <Text color={theme.ai} wrap="truncate-end">
                        {`${asciiMode ? '*' : '◈'} ${t(lang, `教学讲解 (${artifacts.length})`, `Artifacts (${artifacts.length})`)}: `}
                        <Text color={theme.text}>{artifacts[artifactIndex]?.title || artifacts[0].title}</Text>
                        <Text color={theme.muted}>{t(lang, ' · 按 [a] 阅读', ' · Press [a] to read')}</Text>
                      </Text>
                    </Box>
                  </>
                ) : null}
              </>
            ) : null}
          </Box>
        )}
      </Modal>

      {confirmEnd && selectedSession ? (
        <ConfirmDialog
          title={t(lang, '结束带学会话', 'End Guided Study Session')}
          message={t(
            lang,
            `确定结束「${selectedSession.goal?.title || selectedSession.courseId}」？结束后将保留进度与讲解记录。`,
            `End "${selectedSession.goal?.title || selectedSession.courseId}"? Progress and artifacts will be preserved.`,
          )}
          confirmLabel={t(lang, '确认结束', 'End Session')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && confirmEnd}
          onConfirm={() => {
            void handleEndConfirmed();
          }}
          onCancel={() => setConfirmEnd(false)}
        />
      ) : null}
    </>
  );
});
