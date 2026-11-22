import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Divider,
  EmptyState,
  Modal,
  ProgressBar,
  Spinner,
  VirtualList,
  modalContentWidth,
  useInputCapture,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/index.js';

export interface StudyPlanModalProps {
  host: HostClient;
  course: string;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}

type ModalTab = 'plan' | 'readiness';

interface CoursePlanPhase {
  name: string;
  from: string;
  until: string;
  goal?: string;
}

interface CoursePlanReason {
  code: string;
  count?: number;
  tested?: number;
  weak?: number;
  minutes?: number;
  capacity?: number;
  week?: number;
  chapters?: number[];
  carried?: number;
}

interface CoursePlanDay {
  date: string;
  offset: number;
  phase: string | null;
  mode: 'learn' | 'review' | 'mock' | 'off' | string;
  mock?: boolean;
  week?: number | null;
  points: string[];
  done: string[];
  minutes: number;
  reason?: CoursePlanReason;
}

interface CoursePlanPoint {
  id: string;
  number?: string;
  code?: string;
  title: string;
  done?: string | null;
  seen?: string | null;
  weak?: number;
  questions?: number;
  pitfalls?: number;
}

interface CoursePlanResponse {
  status: 'ok' | 'no-plan' | 'no-book' | 'no-exam' | 'past' | 'no-course' | string;
  course: string | null;
  examDate?: string | null;
  daysLeft?: number | null;
  today?: string;
  plan?: {
    version?: number;
    status?: 'active' | 'paused' | 'done' | string;
    startDate?: string;
    minutesPerDay?: number;
    by?: 'exam' | 'weekly' | string;
    chaptersPerWeek?: number;
    reviewCycleDays?: number;
    phases?: Array<{ name: string; until?: string; goal?: string }>;
    notes?: string;
  } | null;
  schedule?: {
    status: string;
    examDate?: string | null;
    today?: string;
    daysLeft?: number | null;
    start?: string | null;
    capacity?: number;
    reviewCycleDays?: number;
    phases?: CoursePlanPhase[];
    days?: CoursePlanDay[];
    coverage?: {
      total: number;
      scheduled: number;
      unplaced: string[];
    };
    progress?: {
      learnt: number;
      total: number;
      elapsedDays: number;
      totalDays: number;
    };
    merged?: Array<{ date: string; ids: string[]; minutes: number; capacity: number }>;
    weekly?: {
      chaptersPerWeek?: number;
      thisWeek?: number | null;
      position?: string;
      behind?: number;
    };
    truncated?: boolean;
  };
  points?: CoursePlanPoint[];
}

interface CustomReadinessChapter {
  id: string;
  title: string;
  built: boolean;
  points: number;
  explained: number | null;
  asked: number | null;
  drafted: number | null;
  practised: number | null;
  solid: number | null;
  weak: number | null;
  readiness: number | null;
  quality?: { sentBack?: number };
  todo: {
    explain: number;
    questions: number;
    weak: number;
  };
  gapHint?: string;
}

interface CustomReadinessResponse {
  status: 'ok' | 'no-course' | 'no-book' | string;
  course: string | null;
  basis: 'outline' | 'documents' | string;
  plan: boolean;
  counted: {
    explained: boolean;
    questions: boolean;
  };
  unknownChapters: string[];
  chapters: CustomReadinessChapter[];
  total: {
    points: number;
    explained: number | null;
    asked: number | null;
    practised: number | null;
    solid: number | null;
    readiness: number | null;
  };
}

interface TokenRange {
  low: number;
  high: number;
}

interface CustomPreviewResponse {
  status: 'ok' | 'no-course' | string;
  course: string | null;
  skeleton?: {
    basis: 'outline' | 'documents' | string;
    outline?: { id?: string; stale?: boolean; chapters?: Array<{ id: string; title: string; points?: number }> };
  };
  estimate?: {
    book?: {
      points: number;
      calls: number;
      readTokens: TokenRange;
    };
    questions?: {
      count: number;
      runs: number;
      calls: number;
      readTokens: TokenRange;
    };
    total?: {
      calls: number;
      readTokens: TokenRange;
    };
    rough?: boolean;
  } | null;
  filled?: {
    purpose?: string;
    scope?: { kind?: string };
  } | null;
  saved?: Record<string, unknown> | null;
}

interface CustomFillResponse {
  status: 'ok' | 'nothing' | 'no-course' | 'no-book' | 'no-outline' | 'exam-scope-unconfirmed' | string;
  course: string | null;
  chapters: string[];
  unknownChapters: string[];
  estimate: boolean;
  book: null | { chapters: string[]; points: number; calls: { low: number; high: number } | null };
  questions: null | { points: number; chapters: number; sources?: number; calls: { low: number; high: number } | null };
  variants: null | { cards: number; points: number; calls: { low: number; high: number } | null };
  calls: { low: number; high: number } | null;
  started?: {
    book?: { error?: string; alreadyRunning?: boolean; [k: string]: unknown };
    questions?: { error?: string; alreadyRunning?: boolean; leftToRunning?: number; [k: string]: unknown };
    variants?: { error?: string; needsConsent?: boolean; [k: string]: unknown };
  };
}

function fmtCount(val: number | null | undefined): string {
  return typeof val === 'number' && Number.isFinite(val) ? String(val) : '-';
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTokenRange(range: TokenRange | undefined | null): string {
  if (!range) return '-';
  const low = fmtTokens(range.low);
  const high = fmtTokens(range.high);
  return low === high ? low : `${low}~${high}`;
}

function fmtCallRange(range: { low: number; high: number } | null | undefined): string {
  if (!range) return '-';
  return range.low === range.high ? String(range.low) : `${range.low}~${range.high}`;
}

function planStatusMeta(status: string, lang: 'zh' | 'en'): { label: string; tone: 'success' | 'warning' | 'error' | 'muted' } {
  switch (status) {
    case 'ok':
      return { label: t(lang, '排期中', 'Active'), tone: 'success' };
    case 'no-plan':
      return { label: t(lang, '未设计划', 'No Plan'), tone: 'warning' };
    case 'no-exam':
      return { label: t(lang, '未设考期', 'No Exam Date'), tone: 'warning' };
    case 'no-book':
      return { label: t(lang, '未建全书', 'No Book'), tone: 'warning' };
    case 'past':
      return { label: t(lang, '考期已过', 'Past Exam'), tone: 'error' };
    case 'no-course':
      return { label: t(lang, '未选课程', 'No Course'), tone: 'muted' };
    default:
      return { label: status, tone: 'muted' };
  }
}

function dayModeMeta(day: CoursePlanDay, lang: 'zh' | 'en'): { label: string; tone: 'primary' | 'accent' | 'warning' | 'muted' } {
  switch (day.mode) {
    case 'learn':
      return { label: t(lang, '精学', 'Learn'), tone: 'primary' };
    case 'review':
      return { label: t(lang, '复习', 'Review'), tone: 'accent' };
    case 'mock':
      return { label: t(lang, '模考', 'Mock'), tone: 'warning' };
    case 'off':
    default:
      return { label: t(lang, '休息', 'Off'), tone: 'muted' };
  }
}

function formatPlanDayReason(day: CoursePlanDay, lang: 'zh' | 'en'): string {
  const r = day.reason;
  if (!r) return day.points.length > 0 ? `${day.points.length} ${t(lang, '节', 'pts')}` : '';
  switch (r.code) {
    case 'exam-today':
      return t(lang, `今日考试 · 总览 ${r.count ?? day.points.length} 节`, `Exam today · review ${r.count ?? day.points.length}`);
    case 'exam-day':
      return t(lang, `考日总览 ${r.count ?? day.points.length} 节`, `Exam day review ${r.count ?? day.points.length}`);
    case 'mock':
      return t(lang, '全真模拟测试', 'Mock exam');
    case 'rest':
      return t(lang, '计划休息日', 'Planned rest day');
    case 'weekday':
      return t(lang, '非学习日', 'Non-study weekday');
    case 'done':
      return t(lang, `已完成 ${r.count ?? day.done.length} 节`, `Completed ${r.count ?? day.done.length}`);
    case 'looked':
      return t(lang, `已翻看 ${r.count ?? day.points.length} 节`, `Skimmed ${r.count ?? day.points.length}`);
    case 'review':
      return t(
        lang,
        `复习 ${r.count ?? day.points.length} 节 (薄弱 ${r.weak ?? 0})`,
        `Review ${r.count ?? day.points.length} pts (${r.weak ?? 0} weak)`,
      );
    case 'review-learn':
      return t(lang, `优先预学 ${r.count ?? day.points.length} 节`, `Priority ${r.count ?? day.points.length} pts`);
    case 'learn-free':
      return t(lang, '待学内容已排完', 'All pending scheduled');
    case 'learn-over':
      return t(
        lang,
        `超负荷 ${r.count ?? day.points.length} 节 (${r.minutes ?? day.minutes}/${r.capacity ?? 0}m)`,
        `Over ${r.count ?? day.points.length} pts (${r.minutes ?? day.minutes}/${r.capacity ?? 0}m)`,
      );
    case 'week':
      return t(
        lang,
        `第${r.week ?? '?'}周 第${(r.chapters ?? []).join('/')}章 · ${r.count ?? day.points.length} 节${r.carried ? ` (+欠${r.carried})` : ''}`,
        `Wk${r.week ?? '?'} Ch${(r.chapters ?? []).join('/')} · ${r.count ?? day.points.length} pts${r.carried ? ` (+${r.carried})` : ''}`,
      );
    case 'learn':
      return t(
        lang,
        `精学 ${r.count ?? day.points.length} 节 (考过 ${r.tested ?? 0} · 薄弱 ${r.weak ?? 0})`,
        `Learn ${r.count ?? day.points.length} pts (T:${r.tested ?? 0} W:${r.weak ?? 0})`,
      );
    case 'learn-size':
      return t(
        lang,
        `精学 ${r.count ?? day.points.length} 节 (薄弱 ${r.weak ?? 0})`,
        `Learn ${r.count ?? day.points.length} pts (W:${r.weak ?? 0})`,
      );
    default:
      return `${day.points.length} ${t(lang, '节', 'pts')}`;
  }
}

function summarizeStartedFill(started: NonNullable<CustomFillResponse['started']>, lang: 'zh' | 'en'): { text: string; tone: 'success' | 'warning' } {
  const parts: string[] = [];
  let hasIssue = false;

  if (started.book) {
    if (started.book.error) {
      hasIssue = true;
      parts.push(t(lang, `全书:${started.book.error}`, `Book:${started.book.error}`));
    } else if (started.book.alreadyRunning) {
      parts.push(t(lang, '全书:已在生成中', 'Book:already running'));
    } else {
      parts.push(t(lang, '全书:已启动', 'Book:started'));
    }
  }
  if (started.questions) {
    if (started.questions.error) {
      hasIssue = true;
      parts.push(t(lang, `出题:${started.questions.error}`, `Qs:${started.questions.error}`));
    } else if (started.questions.alreadyRunning) {
      parts.push(t(lang, '出题:已在运行', 'Qs:already running'));
    } else {
      const left = started.questions.leftToRunning ? t(lang, ` (另${started.questions.leftToRunning}页运行中)`, ` (${started.questions.leftToRunning} held)`) : '';
      parts.push(t(lang, `出题:已启动${left}`, `Qs:started${left}`));
    }
  }
  if (started.variants) {
    if (started.variants.error) {
      hasIssue = true;
      parts.push(t(lang, `变式:${started.variants.error}`, `Var:${started.variants.error}`));
    } else if (started.variants.needsConsent) {
      hasIssue = true;
      parts.push(t(lang, '变式:需先在教练页确认授权', 'Var:needs consent'));
    } else {
      parts.push(t(lang, '变式:已启动', 'Var:started'));
    }
  }

  return {
    text: parts.length > 0 ? parts.join(' · ') : t(lang, '已提交补齐任务', 'Fill tasks submitted'),
    tone: hasIssue ? 'warning' : 'success',
  };
}

export const StudyPlanModal = memo(function StudyPlanModal({
  host,
  course,
  width,
  height,
  isActive,
  onClose,
  onUpdated,
}: StudyPlanModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);

  // Hold input capture for the modal lifetime even while ConfirmDialog mounts on top.
  useInputCapture(isActive);

  const [tab, setTab] = useState<ModalTab>('plan');
  const [planLoading, setPlanLoading] = useState(true);
  const [readinessLoading, setReadinessLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  const [planData, setPlanData] = useState<CoursePlanResponse | null>(null);
  const [readinessData, setReadinessData] = useState<CustomReadinessResponse | null>(null);
  const [previewData, setPreviewData] = useState<CustomPreviewResponse | null>(null);

  const [dayIdx, setDayIdx] = useState(0);
  const [chapterIdx, setChapterIdx] = useState(0);
  const [confirmFill, setConfirmFill] = useState<CustomFillResponse | null>(null);

  const mountedRef = useRef(true);
  const planSeqRef = useRef(0);
  const readinessSeqRef = useRef(0);
  const readinessLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const courseArgs = useMemo(() => (course ? { course } : {}), [course]);

  const loadPlan = useCallback(async () => {
    const seq = ++planSeqRef.current;
    setPlanError(null);
    const res = await tryAction<CoursePlanResponse>(host, 'course.plan', courseArgs);
    if (!mountedRef.current || seq !== planSeqRef.current) return;
    if (res.ok && res.value) {
      setPlanData(res.value);
    } else {
      setPlanError(res.error?.message || t(lang, '加载备考计划失败', 'Failed to load study plan'));
    }
    setPlanLoading(false);
  }, [host, courseArgs, lang]);

  const loadReadiness = useCallback(async () => {
    const seq = ++readinessSeqRef.current;
    setReadinessError(null);
    const [rRes, pRes] = await Promise.all([
      tryAction<CustomReadinessResponse>(host, 'course.custom.readiness', courseArgs),
      tryAction<CustomPreviewResponse>(host, 'course.custom.preview', courseArgs),
    ]);
    if (!mountedRef.current || seq !== readinessSeqRef.current) return;
    readinessLoadedRef.current = true;
    if (rRes.ok && rRes.value) setReadinessData(rRes.value);
    else setReadinessError(rRes.error?.message || t(lang, '加载章节就绪度失败', 'Failed to load readiness'));
    if (pRes.ok && pRes.value) setPreviewData(pRes.value);
    else if (!rRes.ok) {
      setReadinessError(rRes.error?.message || pRes.error?.message || t(lang, '加载章节就绪度失败', 'Failed to load readiness'));
    }
    setReadinessLoading(false);
  }, [host, courseArgs, lang]);

  useEffect(() => {
    setPlanLoading(true);
    setReadinessLoading(true);
    readinessLoadedRef.current = false;
    void loadPlan();
  }, [loadPlan]);

  useEffect(() => {
    if (tab === 'readiness' && !readinessLoadedRef.current) {
      setReadinessLoading(true);
      void loadReadiness();
    }
  }, [tab, loadReadiness]);

  const effectiveCourse = planData?.course ?? readinessData?.course ?? previewData?.course ?? course ?? '';

  const upcomingDays = useMemo<CoursePlanDay[]>(() => {
    const all = planData?.schedule?.days ?? [];
    const future = all.filter((d) => d.offset >= 0);
    return future.length > 0 ? future : all;
  }, [planData?.schedule?.days]);

  const pointMap = useMemo(() => {
    const map = new Map<string, CoursePlanPoint>();
    for (const pt of planData?.points ?? []) {
      map.set(pt.id, pt);
    }
    return map;
  }, [planData?.points]);

  const chapters = readinessData?.chapters ?? [];

  useEffect(() => {
    if (upcomingDays.length > 0 && dayIdx >= upcomingDays.length) {
      setDayIdx(upcomingDays.length - 1);
    }
  }, [upcomingDays.length, dayIdx]);

  useEffect(() => {
    if (chapters.length > 0 && chapterIdx >= chapters.length) {
      setChapterIdx(chapters.length - 1);
    }
  }, [chapters.length, chapterIdx]);

  const handleRequestFill = useCallback(async () => {
    if (busyLabel) return;
    setBusyLabel(t(lang, '正在估算待补齐任务…', 'Estimating missing work…'));
    const res = await tryAction<CustomFillResponse>(host, 'course.custom.fill', {
      ...(effectiveCourse ? { course: effectiveCourse } : {}),
      estimate: true,
    });
    if (!mountedRef.current) return;
    setBusyLabel(null);
    if (!res.ok || !res.value) {
      notify(res.error?.message || t(lang, '估算补齐任务失败', 'Failed to estimate fill'), 'error');
      return;
    }
    const v = res.value;
    if (v.status === 'nothing') {
      notify(t(lang, '当前章节已全部补齐，暂无待启动任务', 'Nothing missing to fill right now'), 'info');
      return;
    }
    if (v.status !== 'ok') {
      const msgMap: Record<string, string> = {
        'no-course': t(lang, '请先选择课程', 'Select a course first'),
        'no-book': t(lang, '尚未生成复习全书，请先前往「复习全书」按 [g] 生成', 'No review book yet; build it in Book view [7] first'),
        'no-outline': t(lang, '尚未生成课程总纲，请先生成总纲后再补齐', 'No course outline yet; build outline first'),
        'exam-scope-unconfirmed': t(lang, '考试范围章节尚未确认，请先确认后再补齐', 'Exam scope chapters are unconfirmed'),
      };
      notify(msgMap[v.status] || t(lang, `当前状态不可补齐: ${v.status}`, `Cannot fill (${v.status})`), 'warning');
      return;
    }
    setConfirmFill(v);
  }, [busyLabel, host, effectiveCourse, lang, notify]);

  const handleConfirmFill = useCallback(async () => {
    setConfirmFill(null);
    setBusyLabel(t(lang, '正在启动补齐任务…', 'Starting fill jobs…'));
    const res = await tryAction<CustomFillResponse>(
      host,
      'course.custom.fill',
      effectiveCourse ? { course: effectiveCourse } : {},
    );
    if (!mountedRef.current) return;
    setBusyLabel(null);
    if (!res.ok || !res.value) {
      notify(res.error?.message || t(lang, '启动补齐任务失败', 'Failed to start fill jobs'), 'error');
      return;
    }
    const summary = res.value.started
      ? summarizeStartedFill(res.value.started, lang)
      : { text: t(lang, '已检查补齐任务', 'Fill checked'), tone: 'success' as const };
    notify(summary.text, summary.tone);
    setReadinessLoading(true);
    await Promise.all([loadReadiness(), loadPlan()]);
    onUpdated?.();
  }, [host, effectiveCourse, lang, notify, loadReadiness, loadPlan, onUpdated]);

  const modalActive = isActive && confirmFill === null;

  useInput(
    (input, key) => {
      if (input === '1') {
        setTab('plan');
        return;
      }
      if (input === '2') {
        setTab('readiness');
        return;
      }
      if (key.tab) {
        setTab((prev) => (prev === 'plan' ? 'readiness' : 'plan'));
        return;
      }
      if (input === 'r' && !busyLabel) {
        if (tab === 'plan') {
          setPlanLoading(true);
          void loadPlan();
        } else {
          setReadinessLoading(true);
          void loadReadiness();
        }
        return;
      }
      if (input === 'f' && tab === 'readiness' && !readinessLoading && !busyLabel) {
        void handleRequestFill();
      }
    },
    { isActive: modalActive },
  );

  // Modal geometry: Modal reserves 5 rows of chrome (top border, title, divider, hints, bottom border).
  const frameW = Math.max(48, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);
  const tabBodyH = Math.max(6, bodyH - 2);

  const hints = useMemo<KeyHint[]>(() => {
    const out: KeyHint[] = [
      { key: '1/2/Tab', label: t(lang, '切换标签', 'Tab') },
      { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
    ];
    if (tab === 'readiness') {
      out.push({ key: 'f', label: t(lang, '补齐缺失', 'Fill Missing') });
    }
    out.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    out.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return out;
  }, [tab, lang]);

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? '-' : '·';
  const arrow = asciiMode ? '->' : '→';

  const renderScheduleRow = useCallback(
    (day: CoursePlanDay, ctx: VirtualListRenderContext) => {
      const mode = dayModeMeta(day, lang);
      const dayLabel = day.offset === 0 ? t(lang, '今日', 'Today') : day.date.slice(5);
      const prefix = `[${dayLabel} ${mode.label}]`;
      const phaseTag = day.phase ? `${truncateDisplay(day.phase, 10, ell)} ` : '';
      const minTag = day.minutes > 0 ? ` ${day.minutes}m` : '';
      const doneTag = day.points.length > 0 && day.done.length > 0 ? ` ${day.done.length}/${day.points.length}` : '';
      const rightMeta = `${doneTag}${minTag}`;
      const reason = formatPlanDayReason(day, lang);
      const midAvail = Math.max(6, ctx.width - displayWidth(prefix) - displayWidth(phaseTag) - displayWidth(rightMeta) - 2);
      const midText = padDisplay(truncateDisplay(reason, midAvail, ell), midAvail);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      const prefixColor = ctx.selected
        ? theme.selectionFg
        : mode.tone === 'warning'
          ? theme.warning
          : mode.tone === 'accent'
            ? theme.accent
            : mode.tone === 'primary'
              ? theme.primary
              : theme.muted;

      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={prefixColor}>{prefix}</Text>
          {phaseTag ? <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{` ${phaseTag}`}</Text> : ' '}
          {midText}
          {rightMeta ? <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{rightMeta}</Text> : null}
        </Text>
      );
    },
    [lang, ell, theme],
  );

  const renderChapterRow = useCallback(
    (ch: CustomReadinessChapter, ctx: VirtualListRenderContext) => {
      const wide = ctx.width >= 78;
      const barW = wide ? 16 : 12;
      const statsStr = wide
        ? ` ${t(lang, '讲', 'E')}:${fmtCount(ch.explained)} ${t(lang, '问', 'A')}:${fmtCount(ch.asked)} ${t(lang, '练', 'P')}:${fmtCount(ch.practised)} ${t(lang, '稳', 'S')}:${fmtCount(ch.solid)} ${t(lang, '弱', 'W')}:${fmtCount(ch.weak)}`
        : ` ${t(lang, '稳', 'S')}:${fmtCount(ch.solid)}/${ch.points} ${t(lang, '弱', 'W')}:${fmtCount(ch.weak)}`;
      const nullPct = ch.readiness === null ? '  --%' : '';
      const titleBudget = Math.max(8, ctx.width - barW - displayWidth(nullPct) - displayWidth(statsStr) - 2);
      const titleText = padDisplay(truncateDisplay(ch.title || ch.id, titleBudget, ell), titleBudget);
      const fg = ctx.selected ? theme.selectionFg : !ch.built ? theme.dim : theme.text;
      const weakHighlight = !ctx.selected && (ch.weak ?? 0) > 0;

      return (
        <Text color={fg} bold={ctx.selected}>
          {titleText}
          {' '}
          {ch.readiness !== null ? (
            <ProgressBar ratio={ch.readiness} width={barW} style="line" showPercent />
          ) : (
            <>
              <ProgressBar ratio={0} width={Math.max(4, barW - 5)} style="line" showPercent={false} />
              <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{nullPct}</Text>
            </>
          )}
          <Text color={weakHighlight ? theme.warning : ctx.selected ? theme.selectionFg : theme.muted}>{statsStr}</Text>
        </Text>
      );
    },
    [lang, ell, theme],
  );

  const renderPlanTab = () => {
    if (planLoading && !planData) {
      return (
        <Box height={tabBodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在加载备考计划…', 'Loading study plan…')} active={isActive} />
        </Box>
      );
    }
    if (planError && !planData) {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '加载备考计划失败', 'Failed to load study plan')}
          hint={truncateDisplay(planError, Math.max(12, innerW - 4), ell)}
          actions={[{ key: 'r', label: t(lang, '重试', 'Retry') }]}
          width={innerW}
          height={tabBodyH}
        />
      );
    }

    const st = planData?.status ?? 'no-plan';
    const stMeta = planStatusMeta(st, lang);
    const examDate = planData?.examDate ?? planData?.schedule?.examDate ?? null;
    const daysLeft = planData?.daysLeft ?? planData?.schedule?.daysLeft ?? null;

    const countdownBadge =
      typeof daysLeft === 'number'
        ? daysLeft === 0
          ? { label: t(lang, `今日考试 (${examDate ?? ''})`, `Exam Today (${examDate ?? ''})`), tone: 'error' as const }
          : daysLeft > 0
            ? {
                label: `${t(lang, '距考', 'D-')}${daysLeft}${t(lang, '天', 'd')}${examDate ? ` (${examDate.slice(5)})` : ''}`,
                tone: (daysLeft <= 7 ? 'error' : 'warning') as 'error' | 'warning',
              }
            : { label: `${t(lang, '已过', 'Past')} (${examDate ?? ''})`, tone: 'error' as const }
        : planData?.schedule?.weekly
          ? { label: t(lang, '按周排期', 'Weekly Plan'), tone: 'accent' as const }
          : null;

    if (st !== 'ok' || !planData?.schedule) {
      const emptyCopy: Record<string, { title: string; hint: string }> = {
        'no-course': {
          title: t(lang, '尚未选择课程', 'No course selected'),
          hint: t(lang, '按 [Esc] 返回后按 [c] 选择一门课程。', 'Press [Esc], then [c] to select a course.'),
        },
        'no-plan': {
          title: t(lang, '该课程尚未制定备考计划', 'No study plan configured yet'),
          hint: t(
            lang,
            '可在主对话让 AI 规划并保存备考计划；按 [2] 可先查看章节就绪度。',
            'Ask AI in chat to draft and save a study plan; press [2] for chapter readiness.',
          ),
        },
        'no-book': {
          title: t(lang, '尚未生成课程复习全书', 'No review book built yet'),
          hint: t(
            lang,
            '备考计划基于全书知识点排期：按 [Esc] 返回后前往 [7] 复习全书按 [g] 生成。',
            'Schedule requires a Review Book: press [Esc], open [7] Book, then [g] to build.',
          ),
        },
        'no-exam': {
          title: t(lang, '尚未设置本课程考试日期', 'No exam date set for this course'),
          hint: t(
            lang,
            '按 [Esc] 返回后按 [C] 打开课程设置 -> 标签 2 -> [d] 设置考试日期。',
            'Press [Esc], then [C] Course Settings -> Tab 2 -> [d] Set Exam Date.',
          ),
        },
        past: {
          title: t(lang, `考试日期 (${examDate ?? ''}) 已过`, `Exam date (${examDate ?? ''}) has passed`),
          hint: t(
            lang,
            '可在课程设置 [C] 中更新考试日期，或按 [2] 查看章节就绪度。',
            'Update exam date in Course Settings [C], or press [2] for readiness.',
          ),
        },
      };
      const copy = emptyCopy[st] ?? {
        title: t(lang, `备考计划暂不可用 (${st})`, `Study plan unavailable (${st})`),
        hint: t(lang, '按 [r] 刷新，或按 [2] 查看章节就绪度。', 'Press [r] to retry or [2] for readiness.'),
      };
      return (
        <Box flexDirection="column" height={tabBodyH} overflow="hidden">
          <Box height={1} gap={1} overflow="hidden">
            <Badge label={stMeta.label} tone={stMeta.tone} variant="soft" />
            {countdownBadge ? <Badge label={countdownBadge.label} tone={countdownBadge.tone} variant="outline" /> : null}
          </Box>
          <EmptyState
            icon={asciiMode ? '!' : '◷'}
            title={copy.title}
            hint={copy.hint}
            actions={[
              { key: '2', label: t(lang, '章节就绪度', 'Readiness') },
              { key: 'r', label: t(lang, '刷新', 'Refresh') },
            ]}
            width={innerW}
            height={Math.max(4, tabBodyH - 1)}
          />
        </Box>
      );
    }

    const sched = planData.schedule;
    const progress = sched.progress ?? { learnt: 0, total: 0, elapsedDays: 0, totalDays: 0 };
    const coverage = sched.coverage ?? { total: 0, scheduled: 0, unplaced: [] };
    const phases = sched.phases ?? [];
    const todayStr = planData.today ?? sched.today ?? '';
    const activePhase = phases.find((p) => p.from <= todayStr && todayStr <= p.until) ?? phases[0] ?? null;

    // Show full multi-row phase block only when viewport has comfortable vertical room.
    const showPhaseBlock = tabBodyH >= 18 && phases.length > 0;
    const shownPhases = showPhaseBlock ? phases.slice(0, 3) : [];
    const phaseRowsUsed = showPhaseBlock ? 1 + shownPhases.length : 1;
    // Fixed rows: status(1) + progress(1) + phaseRowsUsed + scheduleDivider(1) + detailDivider(1) + detail(1)
    const fixedRows = 5 + phaseRowsUsed;
    const listH = Math.max(3, tabBodyH - fixedRows);

    const selectedDay = upcomingDays[Math.min(dayIdx, Math.max(0, upcomingDays.length - 1))] ?? null;
    const selectedPhaseObj = selectedDay?.phase ? phases.find((p) => p.name === selectedDay.phase) : null;
    const selectedPointTitles = (selectedDay?.points ?? [])
      .slice(0, 3)
      .map((pid) => pointMap.get(pid)?.title || pid)
      .join(', ');

    const learntRatio = progress.total > 0 ? progress.learnt / progress.total : 0;
    const barW = Math.max(14, Math.min(34, Math.floor(innerW * 0.42)));
    const planPaused = planData.plan?.status === 'paused';

    const capText = sched.capacity ? `${sched.capacity}m/${t(lang, '天', 'd')}` : '';
    const cycleText = sched.reviewCycleDays && sched.reviewCycleDays >= 2 ? `${t(lang, '每', 'Rev/')}${sched.reviewCycleDays}${t(lang, '天复习', 'd')}` : '';
    const weeklyText = sched.weekly
      ? `${t(lang, '第', 'Wk')}${sched.weekly.thisWeek ?? '-'}${t(lang, '周', '')}${sched.weekly.behind ? ` ${t(lang, '欠', 'behind:')}${sched.weekly.behind}` : ''}`
      : '';

    return (
      <Box flexDirection="column" height={tabBodyH} overflow="hidden">
        {/* Row 1: status, countdown, rhythm */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box gap={1} overflow="hidden">
            <Badge
              label={planPaused ? t(lang, '已暂停', 'Paused') : stMeta.label}
              tone={planPaused ? 'warning' : stMeta.tone}
              variant="soft"
            />
            {countdownBadge ? <Badge label={countdownBadge.label} tone={countdownBadge.tone} variant="outline" /> : null}
          </Box>
          <Text color={theme.muted} wrap="truncate-end">
            {[capText, cycleText, weeklyText].filter(Boolean).join(` ${sep} `)}
          </Text>
        </Box>

        {/* Row 2: progress + coverage */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <ProgressBar
            ratio={learntRatio}
            width={barW}
            style="block"
            label={t(lang, `已学 ${progress.learnt}/${progress.total}`, `Learnt ${progress.learnt}/${progress.total}`)}
          />
          <Text color={theme.muted} wrap="truncate-end">
            {`${t(lang, '已排', 'Sched')} ${coverage.scheduled}/${coverage.total}`}
            {coverage.unplaced.length > 0 ? ` (${t(lang, '未排', 'Unplaced')} ${coverage.unplaced.length})` : ''}
            {progress.totalDays > 0 ? ` ${sep} ${t(lang, '第', 'D')}${progress.elapsedDays}/${progress.totalDays}${t(lang, '天', '')}` : ''}
          </Text>
        </Box>

        {/* Phases */}
        {showPhaseBlock ? (
          <>
            <Divider width={innerW} label={t(lang, `阶段规划 (${phases.length})`, `Phases (${phases.length})`)} />
            {shownPhases.map((ph, idx) => {
              const isCurrent = ph.from <= todayStr && todayStr <= ph.until;
              const marker = isCurrent ? (asciiMode ? '*' : '▶') : (asciiMode ? '-' : '•');
              const range = `${ph.from.slice(5)}${arrow}${ph.until.slice(5)}`;
              const goalPart = ph.goal ? ` ${sep} ${ph.goal}` : '';
              return (
                <Box key={`${ph.name}:${idx}`} height={1} overflow="hidden">
                  <Text color={isCurrent ? theme.primary : theme.muted} bold={isCurrent} wrap="truncate-end">
                    {truncateDisplay(`${marker} ${ph.name} (${range})${goalPart}`, innerW, ell)}
                  </Text>
                </Box>
              );
            })}
          </>
        ) : (
          <Box height={1} overflow="hidden">
            <Text color={activePhase ? theme.accent : theme.muted} wrap="truncate-end">
              {activePhase
                ? truncateDisplay(
                    `${t(lang, '当前阶段', 'Phase')}: ${activePhase.name} (${activePhase.from.slice(5)}${arrow}${activePhase.until.slice(5)})${activePhase.goal ? ` ${sep} ${activePhase.goal}` : ''}`,
                    innerW,
                    ell,
                  )
                : t(lang, '阶段: 默认备考期', 'Phase: Default')}
            </Text>
          </Box>
        )}

        {/* Upcoming schedule VirtualList */}
        <Divider width={innerW} label={t(lang, `近期日程 (${upcomingDays.length})`, `Upcoming Schedule (${upcomingDays.length})`)} />
        <VirtualList
          items={upcomingDays}
          width={innerW}
          height={listH}
          selectedIndex={dayIdx}
          onChange={(idx) => setDayIdx(idx)}
          isActive={modalActive && tab === 'plan' && !busyLabel}
          keyExtractor={(item) => item.date}
          emptyText={t(lang, '暂无近期排期条目', 'No upcoming days scheduled')}
          renderItem={renderScheduleRow}
        />

        {/* Selected day detail */}
        <Divider width={innerW} />
        <Box height={1} overflow="hidden">
          <Text color={theme.text} wrap="truncate-end">
            {selectedDay
              ? truncateDisplay(
                  `${selectedDay.date}${selectedDay.phase ? ` [${selectedDay.phase}${selectedPhaseObj?.goal ? `: ${selectedPhaseObj.goal}` : ''}]` : ''} ${sep} ${selectedPointTitles || formatPlanDayReason(selectedDay, lang)}`,
                  innerW,
                  ell,
                )
              : t(lang, '使用 j/k 或方向键浏览每日安排', 'Use j/k or arrows to inspect daily schedule')}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderReadinessTab = () => {
    if (readinessLoading && !readinessData && !previewData) {
      return (
        <Box height={tabBodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在分析章节就绪度与估算…', 'Loading chapter readiness & estimate…')} active={isActive} />
        </Box>
      );
    }
    if (readinessError && !readinessData && !previewData) {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '加载章节就绪度失败', 'Failed to load readiness')}
          hint={truncateDisplay(readinessError, Math.max(12, innerW - 4), ell)}
          actions={[{ key: 'r', label: t(lang, '重试', 'Retry') }]}
          width={innerW}
          height={tabBodyH}
        />
      );
    }

    if (readinessData?.status === 'no-course' && previewData?.status === 'no-course') {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '◷'}
          title={t(lang, '尚未选择课程', 'No course selected')}
          hint={t(lang, '按 [Esc] 返回后按 [c] 选择一门课程。', 'Press [Esc], then [c] to select a course.')}
          width={innerW}
          height={tabBodyH}
        />
      );
    }

    const total = readinessData?.total;
    const est = previewData?.estimate;
    const basis = readinessData?.basis ?? previewData?.skeleton?.basis ?? 'outline';
    const basisLabel =
      readinessData?.status === 'no-book'
        ? t(lang, '未建全书', 'No Book')
        : basis === 'outline'
          ? t(lang, '总纲章节', 'Outline')
          : t(lang, '资料章节', 'Documents');

    // Fixed rows: total summary(1) + estimate(1) + divider(1) + detailDivider(1) + detail(1) = 5
    const listH = Math.max(3, tabBodyH - 5);
    const selectedChapter = chapters[Math.min(chapterIdx, Math.max(0, chapters.length - 1))] ?? null;

    return (
      <Box flexDirection="column" height={tabBodyH} overflow="hidden">
        {/* Row 1: Total readiness summary */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box gap={1} overflow="hidden">
            <Badge label={basisLabel} tone={readinessData?.status === 'ok' ? 'accent' : 'warning'} variant="soft" />
            {total && total.readiness !== null ? (
              <ProgressBar
                ratio={total.readiness}
                width={Math.max(14, Math.min(26, Math.floor(innerW * 0.34)))}
                style="block"
                label={t(lang, '总就绪', 'Ready')}
              />
            ) : (
              <Text color={theme.dim}>{t(lang, '总就绪度: --', 'Readiness: --')}</Text>
            )}
          </Box>
          {total ? (
            <Text color={theme.muted} wrap="truncate-end">
              {`${t(lang, '点', 'Pts')}:${total.points} ${t(lang, '讲', 'E')}:${fmtCount(total.explained)} ${t(lang, '问', 'A')}:${fmtCount(total.asked)} ${t(lang, '练', 'P')}:${fmtCount(total.practised)} ${t(lang, '稳', 'S')}:${fmtCount(total.solid)}`}
            </Text>
          ) : null}
        </Box>

        {/* Row 2: Rough token / call estimate */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Text color={theme.info} wrap="truncate-end">
            {est?.total && est.total.calls > 0
              ? truncateDisplay(
                  t(
                    lang,
                    `粗估消耗(非计费): 约 ${est.total.calls} 次调用 · 读入 ${fmtTokenRange(est.total.readTokens)} tokens (全书 ${est.book?.calls ?? 0} / 出题 ${est.questions?.calls ?? 0})`,
                    `Rough est.(no price): ~${est.total.calls} calls · ${fmtTokenRange(est.total.readTokens)} read tok (Book ${est.book?.calls ?? 0} / Qs ${est.questions?.calls ?? 0})`,
                  ),
                  innerW - 14,
                  ell,
                )
              : t(lang, '粗估消耗: 暂无待估算调用', 'Rough est.: 0 model calls')}
          </Text>
          <Text color={theme.accent} bold>
            {t(lang, '[f] 补齐缺失', '[f] Fill')}
          </Text>
        </Box>

        {/* Chapters list */}
        <Divider width={innerW} label={t(lang, `章节就绪度 (${chapters.length})`, `Chapter Readiness (${chapters.length})`)} />
        {chapters.length === 0 ? (
          <EmptyState
            icon={asciiMode ? '*' : '▣'}
            title={
              readinessData?.status === 'no-book'
                ? t(lang, '尚未生成总纲或定制范围', 'No outline or custom plan yet')
                : t(lang, '暂无可统计章节', 'No chapters to measure')
            }
            hint={t(
              lang,
              '按 [Esc] 返回后前往 [7] 复习全书按 [g] 生成总纲与全书，即可统计章节就绪度。',
              'Press [Esc], open [7] Book and press [g] to build outline & review book.',
            )}
            width={innerW}
            height={listH + 2}
          />
        ) : (
          <>
            <VirtualList
              items={chapters}
              width={innerW}
              height={listH}
              selectedIndex={chapterIdx}
              onChange={(idx) => setChapterIdx(idx)}
              isActive={modalActive && tab === 'readiness' && !busyLabel}
              keyExtractor={(ch) => ch.id}
              renderItem={renderChapterRow}
            />
            <Divider width={innerW} />
            <Box height={1} overflow="hidden">
              <Text color={theme.text} wrap="truncate-end">
                {selectedChapter
                  ? truncateDisplay(
                      `${t(lang, '讲解', 'Expl')}:${fmtCount(selectedChapter.explained)}/${selectedChapter.points} ${sep} ${t(lang, '出题', 'Ask')}:${fmtCount(selectedChapter.asked)} ${sep} ${t(lang, '已练', 'Prac')}:${fmtCount(selectedChapter.practised)} ${sep} ${t(lang, '稳固', 'Solid')}:${fmtCount(selectedChapter.solid)} ${sep} ${t(lang, '薄弱', 'Weak')}:${fmtCount(selectedChapter.weak)} ${sep} ${t(lang, '就绪', 'Ready')}:${selectedChapter.readiness !== null ? `${Math.round(selectedChapter.readiness * 100)}%` : '--'}${selectedChapter.gapHint ? ` ${sep} ${selectedChapter.gapHint}` : ''}`,
                      innerW,
                      ell,
                    )
                  : t(lang, '按 [f] 预览并补齐缺失讲解/题目', 'Press [f] to preview & fill missing items')}
              </Text>
            </Box>
          </>
        )}
      </Box>
    );
  };

  return (
    <>
      <Modal
        title={t(lang, '课程备考计划 & 章节就绪度', 'Study Plan & Chapter Readiness')}
        icon={asciiMode ? '*' : '◷'}
        tone="primary"
        subtitle={effectiveCourse || undefined}
        width={frameW}
        height={frameH}
        onClose={onClose}
        isActive={modalActive}
        hints={hints}
      >
        {/* Top Modal Tab Switcher (1 row) */}
        <Box height={1} justifyContent="space-between" overflow="hidden" flexShrink={0}>
          <Box gap={1} overflow="hidden">
            <Text
              backgroundColor={tab === 'plan' ? theme.primary : theme.surface}
              color={tab === 'plan' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'plan'}
            >
              {` 1:${t(lang, '备考计划', 'Study Plan')} `}
            </Text>
            <Text
              backgroundColor={tab === 'readiness' ? theme.primary : theme.surface}
              color={tab === 'readiness' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'readiness'}
            >
              {` 2:${t(lang, '章节就绪度', 'Readiness')}${chapters.length > 0 ? ` (${chapters.length})` : ''} `}
            </Text>
          </Box>
          <Box gap={1} overflow="hidden">
            {busyLabel ? <Spinner label={truncateDisplay(busyLabel, 24, ell)} active={isActive} /> : null}
            <Badge label={effectiveCourse || t(lang, '未选课程', 'No Course')} tone="accent" variant="soft" />
          </Box>
        </Box>

        <Divider width={innerW} />

        {tab === 'plan' ? renderPlanTab() : renderReadinessTab()}
      </Modal>

      {confirmFill ? (
        <ConfirmDialog
          title={t(lang, '确认补齐缺失内容', 'Confirm Fill Missing')}
          width={Math.min(64, Math.max(40, width - 8))}
          confirmLabel={t(lang, '开始补齐', 'Start Fill')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onCancel={() => setConfirmFill(null)}
          onConfirm={() => void handleConfirmFill()}
          message={
            <Box flexDirection="column">
              <Text color={theme.text} bold>
                {t(
                  lang,
                  `将为「${confirmFill.course || effectiveCourse}」启动以下补齐任务：`,
                  `Start missing fill jobs for "${confirmFill.course || effectiveCourse}":`,
                )}
              </Text>
              {confirmFill.book ? (
                <Text color={theme.text}>
                  {`${asciiMode ? '-' : '•'} ${t(lang, `补写全书讲解: ${confirmFill.book.points} 个知识点 (${confirmFill.book.chapters.length} 章)`, `Book explanations: ${confirmFill.book.points} pts (${confirmFill.book.chapters.length} ch)`)}`}
                </Text>
              ) : null}
              {confirmFill.questions ? (
                <Text color={theme.text}>
                  {`${asciiMode ? '-' : '•'} ${t(lang, `补齐题目草稿: ${confirmFill.questions.points} 个知识点 (${confirmFill.questions.chapters} 章)`, `Question drafts: ${confirmFill.questions.points} pts (${confirmFill.questions.chapters} ch)`)}`}
                </Text>
              ) : null}
              {confirmFill.variants ? (
                <Text color={theme.text}>
                  {`${asciiMode ? '-' : '•'} ${t(lang, `生成薄弱变式题: ${confirmFill.variants.cards} 题 (${confirmFill.variants.points} 知识点)`, `Weak variants: ${confirmFill.variants.cards} cards (${confirmFill.variants.points} pts)`)}`}
                </Text>
              ) : null}
              <Text color={theme.muted}>
                {t(
                  lang,
                  `粗估调用次数(非计费): ${confirmFill.calls ? `${fmtCallRange(confirmFill.calls)} 次` : '部分步骤暂不可估'}`,
                  `Rough call estimate (no price): ${confirmFill.calls ? `${fmtCallRange(confirmFill.calls)} calls` : 'unavailable for some steps'}`,
                )}
              </Text>
            </Box>
          }
        />
      ) : null}
    </>
  );
});
