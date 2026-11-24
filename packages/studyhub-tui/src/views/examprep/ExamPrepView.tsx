import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { KeyHint, UiLanguage, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { renderBarChart, renderStatTable } from '../../render/charts.js';
import {
  escapeMdCell,
  formatExamCountdownSummary,
  formatExamScheduleMarkdown,
  renderExamScheduleTable,
  type CoursePlanResponse,
} from './course-plan-display.js';
import { buildExamCoverage, buildGapFillWorkflowSteps } from './exam-coverage.js';
import { buildExamGapAlert } from './exam-gap-alert.js';
import { currentCourse, listCourses } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../../host/atomic-write.js';
import { tryAction } from '../../host/sample-actions.js';
const AddFocusModal = lazy(() => import('./AddFocusModal.js').then((m) => ({ default: m.AddFocusModal })));
const StudyPlanModal = lazy(() => import('./StudyPlanModal.js').then((m) => ({ default: m.StudyPlanModal })));
import {
  crunchStatusLabel,
  focusStatusGroup,
  focusStatusLabel,
  focusStatusTone,
  type BookCrunchResult,
  type CourseRecordView,
  type CrunchPoint,
  type FocusProgressResult,
  type FocusTopicProgress,
  type PrepTab,
} from './types.js';

const CLAIMED_KEYS = ['1', '2', 'a', 'd', 'g', 'G', 'm', 'p', 'P', ' ', '/', 'x', 'Z', 'T'] as const;

export interface FormatExamPrepMarkdownParams {
  course?: string | null;
  examDate?: string | null;
  topics?: readonly FocusTopicProgress[];
  crunchPoints?: readonly CrunchPoint[];
  planNotes?: string | null;
  /** The saved 备考计划 as `course.plan` answers it; null/undefined = not loaded, no plan section. */
  coursePlan?: CoursePlanResponse | null;
  /** Days to the exam as the backend resolves them (`course.plan` or `book.crunch`), for the coverage actions. */
  daysLeft?: number | null;
  lang?: UiLanguage;
  generatedAt?: Date | string;
}

function formatGeneratedAt(generatedAt?: Date | string): string {
  if (typeof generatedAt === 'string' && generatedAt.trim()) return generatedAt.trim();
  const d = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/** Pure formatter producing an Exam Prep study plan & focus progress Markdown report (0 LLM tokens). */
export function formatExamPrepMarkdown({
  course,
  examDate,
  topics = [],
  crunchPoints = [],
  planNotes,
  coursePlan,
  daysLeft,
  lang = 'en',
  generatedAt,
}: FormatExamPrepMarkdownParams): string {
  const topicList = Array.isArray(topics) ? topics : [];
  const crunchList = Array.isArray(crunchPoints) ? crunchPoints : [];
  const courseLabel = String(course || '').trim() || t(lang, '全部课程', 'All Courses');
  const dateLabel = formatGeneratedAt(generatedAt);

  const total = topicList.length;
  const doneCount = topicList.filter((tp) => tp.status === 'done').length;
  const weakCount = topicList.filter((tp) => tp.status === 'weak').length;
  const noneCount = topicList.filter((tp) => tp.status === 'none').length;
  const todoCount = topicList.filter((tp) => tp.status === 'todo' || tp.status === 'active').length;

  const lines: string[] = [
    `# ${t(lang, 'StudyHub 备考计划与重点进度', 'StudyHub Exam Prep Plan & Focus Progress')}`,
    '',
    `- **${t(lang, '生成日期', 'Generated')}**: ${dateLabel}`,
    `- **${t(lang, '课程', 'Course')}**: ${courseLabel}`,
  ];
  if (typeof examDate === 'string' && examDate.trim()) {
    lines.push(`- **${t(lang, '考试日期', 'Exam Date')}**: ${examDate.trim()}`);
  }
  lines.push(
    `- **${t(lang, '重点统计', 'Focus Summary')}**: ${t(
      lang,
      `共 ${total} 项 (已掌握 ${doneCount} / 薄弱 ${weakCount} / 待学 ${todoCount} / 缺题 ${noneCount})`,
      `${total} total (Done ${doneCount} / Weak ${weakCount} / Todo ${todoCount} / None ${noneCount})`,
    )}`,
    '',
    `## ${t(lang, '考纲重点进度', 'Focus Topics')}`,
    '',
  );

  if (topicList.length === 0) {
    lines.push(t(lang, '_暂无考纲重点条目。_', '_No focus topics yet._'), '');
  } else {
    lines.push(
      lang === 'zh'
        ? '| 重点主题 | 状态 | 掌握率 | 题数 | 薄弱题 |'
        : '| Topic | Status | Mastery | Cards | Weak |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const tp of topicList) {
      const topicCell = escapeMdCell(tp.topic) || '-';
      const statusCell = escapeMdCell(focusStatusLabel(tp.status, lang));
      const masteryCell = tp.cards > 0 ? `${Math.round((tp.mastery || 0) * 100)}%` : '-';
      const cardsCell = String(tp.cards ?? 0);
      const weakCell = String(tp.weakCards?.length ?? tp.counts?.weak ?? 0);
      lines.push(`| ${topicCell} | ${statusCell} | ${masteryCell} | ${cardsCell} | ${weakCell} |`);
    }
    lines.push('');
  }

  const scheduleMd = formatExamScheduleMarkdown(coursePlan, lang);
  if (scheduleMd) {
    lines.push(scheduleMd, '');
  }
  const gapSteps = buildGapFillWorkflowSteps(buildExamCoverage(topicList, daysLeft), lang);
  if (gapSteps.length > 0) {
    lines.push(`## ${t(lang, '建议行动清单', 'Recommended Next Actions')}`, '');
    for (const step of gapSteps) lines.push(`- [ ] ${escapeMdCell(step.label) || '-'}`);
    lines.push('');
  }

  if (crunchList.length > 0) {
    lines.push(`## ${t(lang, '期末冲刺清单', 'Final-Week Crunch')}`, '');
    for (const pt of crunchList) {
      const checked = pt.done ? 'x' : ' ';
      const title = escapeMdCell(pt.title) || pt.id;
      const metaParts: string[] = [];
      if (typeof pt.questions === 'number') {
        metaParts.push(lang === 'zh' ? `${pt.questions}题` : `${pt.questions} Q`);
      }
      if (typeof pt.weak === 'number' && pt.weak > 0) {
        metaParts.push(lang === 'zh' ? `${pt.weak}错` : `${pt.weak} weak`);
      }
      if (!pt.done && pt.seen) {
        metaParts.push(t(lang, '已翻看', 'seen'));
      }
      const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
      lines.push(`- [${checked}] ${title}${metaSuffix}`);
    }
    lines.push('');
  }

  if (typeof planNotes === 'string' && planNotes.trim()) {
    lines.push(`## ${t(lang, '备考计划备注', 'Study Plan Notes')}`, '', planNotes.trim(), '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export const ExamPrepView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const activeCourse = currentCourse(snapshot);
  const knownCourses = useMemo(() => listCourses(snapshot).map((c) => c.key), [snapshot]);
  const course = activeCourse || knownCourses[0] || '';

  const [tab, setTab] = useState<PrepTab>('focus');
  const [focusPane, setFocusPane] = useState<'left' | 'right'>('left');
  const [loading, setLoading] = useState(true);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [progress, setProgress] = useState<FocusProgressResult | null>(null);
  const [crunch, setCrunch] = useState<BookCrunchResult | null>(null);
  const [courseRecord, setCourseRecord] = useState<CourseRecordView | null>(null);
  const [coursePlan, setCoursePlan] = useState<CoursePlanResponse | null>(null);

  const [topicIdx, setTopicIdx] = useState(0);
  const [crunchIdx, setCrunchIdx] = useState(0);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [gapAlertDismissed, setGapAlertDismissed] = useState(false);
  const [showScheduleTable, setShowScheduleTable] = useState(false);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [deleteTopicTarget, setDeleteTopicTarget] = useState<string | null>(null);
  const [gapFillConfirm, setGapFillConfirm] = useState<{ topics: string[]; count: number } | null>(null);

  const modalOpen = addModalOpen || planModalOpen || deleteTopicTarget !== null || gapFillConfirm !== null;
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAll = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setErrorMsg(null);
    const [fpRes, crRes, cgRes, cpRes] = await Promise.all([
      tryAction<FocusProgressResult>(host, 'course.focusProgress', course ? { course } : {}),
      tryAction<BookCrunchResult>(host, 'book.crunch', course ? { course } : {}),
      course
        ? tryAction<CourseRecordView>(host, 'course.get', { name: course })
        : Promise.resolve({ ok: false as const, value: undefined }),
      course
        ? tryAction<CoursePlanResponse>(host, 'course.plan', { course })
        : Promise.resolve({ ok: false as const, value: undefined }),
    ]);
    if (!mountedRef.current || seq !== reqSeqRef.current) return;
    if (fpRes.ok && fpRes.value) setProgress(fpRes.value);
    else if (!fpRes.ok) setErrorMsg(fpRes.error?.message || t(lang, '加载重点进度失败', 'Failed to load focus progress'));
    if (crRes.ok && crRes.value) setCrunch(crRes.value);
    setCourseRecord(cgRes.ok && cgRes.value ? cgRes.value : null);
    setCoursePlan(cpRes.ok && cpRes.value ? cpRes.value : null);
    setLoading(false);
  }, [host, course, lang]);

  useEffect(() => {
    setLoading(true);
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const unsub = host.subscribeEvents(() => {
      if (mountedRef.current) void loadAll();
    });
    return unsub;
  }, [host, loadAll]);

  const topics = useMemo(() => progress?.topics ?? [], [progress?.topics]);
  const deckLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of snapshot?.decks ?? []) {
      const label = [d.title, d.name].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join(' ');
      if (d.id && label) map.set(d.id, label);
    }
    return map;
  }, [snapshot?.decks]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const filteredTopics = useMemo(() => {
    if (!normalizedFilter) return topics;
    return topics.filter((tp) => {
      const parts: string[] = [
        tp.topic,
        tp.status,
        focusStatusLabel(tp.status, 'zh'),
        focusStatusLabel(tp.status, 'en'),
      ];
      for (const wc of tp.weakCards ?? []) {
        if (wc.deckId) {
          parts.push(wc.deckId);
          const deckLabel = deckLabelById.get(wc.deckId);
          if (deckLabel) parts.push(deckLabel);
        }
        if (wc.cardId) parts.push(wc.cardId);
      }
      return parts.some((part) => part.toLowerCase().includes(normalizedFilter));
    });
  }, [topics, normalizedFilter, deckLabelById]);

  useEffect(() => {
    if (filteredTopics.length === 0) {
      if (topicIdx !== 0) setTopicIdx(0);
    } else if (topicIdx >= filteredTopics.length) {
      setTopicIdx(filteredTopics.length - 1);
    }
  }, [filteredTopics.length, topicIdx]);

  const clampedTopicIdx = filteredTopics.length > 0 ? Math.min(topicIdx, filteredTopics.length - 1) : 0;
  const selectedTopic: FocusTopicProgress | undefined = filteredTopics[clampedTopicIdx];
  const crunchPoints = crunch?.points ?? [];
  const selectedCrunch: CrunchPoint | undefined = crunchPoints[Math.min(crunchIdx, Math.max(0, crunchPoints.length - 1))];

  const noQuestionTopics = useMemo(
    () => filteredTopics.filter((tp) => tp.status === 'none').map((tp) => tp.topic),
    [filteredTopics],
  );
  const inProgressCount = useMemo(() => topics.filter((tp) => focusStatusGroup(tp.status) === 'in_progress').length, [topics]);

  useClaimKeys(CLAIMED_KEYS, isActive && !modalOpen && !filterEditing);

  const hints = useMemo<KeyHint[]>(() => {
    if (tab === 'focus') {
      return [
        { key: '1/2', label: t(lang, '重点/冲刺', 'Focus/Crunch') },
        { key: 'a', label: t(lang, '添加重点', 'Add Focus') },
        { key: 'p', label: t(lang, '练习未掌握', 'Practice') },
        { key: 'g/G', label: t(lang, '补齐出题', 'Gap-Fill') },
        { key: 'P', label: t(lang, '备考计划', 'Plan') },
        { key: 'd', label: t(lang, '移除重点', 'Remove') },
        { key: '/', label: t(lang, '筛选', 'Filter') },
        { key: 'x', label: t(lang, '导出MD', 'Export') },
      ];
    }
    return [
      { key: '1/2', label: t(lang, '重点/冲刺', 'Focus/Crunch') },
      { key: 'Space', label: t(lang, '标记已看', 'Seen') },
      { key: 'm', label: t(lang, '标记读完', 'Read') },
      { key: 'p', label: t(lang, '模拟开练', 'Mock/Practice') },
      { key: 'P', label: t(lang, '备考计划', 'Plan') },
      { key: 'a', label: t(lang, '添加重点', 'Add Focus') },
      { key: 'x', label: t(lang, '导出MD', 'Export') },
    ];
  }, [tab, lang]);

  useFooterHints(hints, isActive);

  // Actions
  const practiceUnmastered = useCallback(async () => {
    if (busyRef.current || busyLabel !== null) return;
    if (normalizedFilter && !selectedTopic) {
      notify(t(lang, '当前筛选结果为空，请先按 Esc 清除筛选', 'No matching focus topics; press Esc to clear filter'), 'info');
      return;
    }
    const scope = selectedTopic?.weakCards?.length
      ? selectedTopic.weakCards
      : normalizedFilter
        ? []
        : progress?.weakScope ?? [];
    if (scope.length > 0) {
      busyRef.current = true;
      setBusyLabel(t(lang, `正在开启重点薄弱题练习${ell}`, 'Starting weak focus practice...'));
      try {
        const res = await tryAction<{ id: string }>(host, 'review.start', { mode: 'path', scope, fresh: true });
        if (!mountedRef.current) return;
        if (res.ok && res.value?.id) {
          navigate('review', { runId: res.value.id });
          return;
        }
        notify(res.error?.message || t(lang, '启动练习失败', 'Failed to start practice'), 'error');
        return;
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyLabel(null);
      }
    }
    if (selectedTopic && selectedTopic.cards > 0 && course) {
      busyRef.current = true;
      setBusyLabel(t(lang, `正在开启练习${ell}`, 'Starting practice...'));
      try {
        const res = await tryAction<{ id: string }>(host, 'review.start', { mode: 'due', course, fresh: true });
        if (!mountedRef.current) return;
        if (res.ok && res.value?.id) {
          navigate('review', { runId: res.value.id });
          return;
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyLabel(null);
      }
    }
    notify(t(lang, '当前暂无可练薄弱重点题；可按 g 为空重点补齐出题', 'No unmastered focus questions ready; press g for gap-fill'), 'info');
  }, [busyLabel, selectedTopic, progress?.weakScope, host, course, lang, navigate, notify]);

  const requestGapFill = useCallback((targetTopics: string[]) => {
    if (busyRef.current || busyLabel !== null) return;
    if (!course) {
      notify(t(lang, '请先选择一门课程 (按 c)', 'Select a course first (press c)'), 'warning');
      return;
    }
    if (!targetTopics.length) {
      notify(t(lang, '当前没有缺少题目的重点知识点', 'No focus points without questions'), 'info');
      return;
    }
    const sourceIds = (snapshot?.sources ?? [])
      .filter((s) => !s.archived && (s.course === course || s.courses?.includes(course)))
      .map((s) => s.id);
    if (!sourceIds.length) {
      notify(t(lang, '该课程暂无可用学习资料，请先前往「资料」页导入讲义', 'No sources in this course; import materials first'), 'warning');
      return;
    }
    const count = Math.min(20, Math.max(4, targetTopics.length * 4));
    setGapFillConfirm({ topics: targetTopics, count });
  }, [busyLabel, course, snapshot?.sources, lang, notify]);

  const generateGapFill = useCallback(async (targetTopics: string[]) => {
    if (busyRef.current || busyLabel !== null) return;
    if (!course) {
      notify(t(lang, '请先选择一门课程 (按 c)', 'Select a course first (press c)'), 'warning');
      return;
    }
    if (!targetTopics.length) {
      notify(t(lang, '当前没有缺少题目的重点知识点', 'No focus points without questions'), 'info');
      return;
    }
    const sourceIds = (snapshot?.sources ?? [])
      .filter((s) => !s.archived && (s.course === course || s.courses?.includes(course)))
      .map((s) => s.id);
    if (!sourceIds.length) {
      notify(t(lang, '该课程暂无可用学习资料，请先前往「资料」页导入讲义', 'No sources in this course; import materials first'), 'warning');
      return;
    }
    busyRef.current = true;
    setBusyLabel(t(lang, `正在启动重点查漏补缺出题${ell}`, 'Starting gap-fill generation...'));
    try {
      const count = Math.min(20, Math.max(4, targetTopics.length * 4));
      const title = targetTopics.length === 1
        ? `${course} - ${targetTopics[0]}`
        : `${course} - ${t(lang, '考纲补缺', 'Exam Gap-Fill')}`;
      const res = await tryAction(host, 'generate', {
        course,
        sourceIds,
        focusTopics: targetTopics,
        count,
        kind: 'mixed',
        title,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '查漏补缺出题失败', 'Gap-fill generation failed'), 'error');
        return;
      }
      notify(
        t(lang, `已为 ${targetTopics.length} 个重点启动出题任务`, `Started gap-fill generation for ${targetTopics.length} topic(s)`),
        'success',
      );
      navigate('tasks');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, course, snapshot?.sources, host, lang, notify, navigate]);

  const confirmRemoveTopic = useCallback(async (topicToRemove: string) => {
    if (!course || busyRef.current || busyLabel !== null) return;
    setDeleteTopicTarget(null);
    busyRef.current = true;
    setBusyLabel(t(lang, `正在移除重点条目${ell}`, 'Removing focus topic...'));
    try {
      const existingCourse = (snapshot?.courses ?? []).find((c) => String(c.name || c.id || '').trim() === course);
      let record: CourseRecordView | null = null;
      if (existingCourse?.id) {
        const got = await tryAction<CourseRecordView>(host, 'course.get', { id: String(existingCourse.id) });
        if (got.ok && got.value) record = got.value;
      }
      const remaining = topics.map((tp) => tp.topic).filter((tp) => tp !== topicToRemove);
      const saved = await tryAction(host, 'course.save', {
        ...(record?.id ? { id: record.id } : {}),
        name: course,
        ...(record?.exam ? { exam: record.exam } : {}),
        ...(record?.plan ? { plan: record.plan } : {}),
        ...(record?.guidanceSourceIds ? { guidanceSourceIds: record.guidanceSourceIds } : {}),
        focusTopics: remaining,
      });
      if (!mountedRef.current) return;
      if (!saved.ok) {
        notify(saved.error?.message || t(lang, '移除失败', 'Remove failed'), 'error');
        return;
      }
      await refreshSnapshot();
      await loadAll();
      notify(t(lang, `已移除「${topicToRemove}」`, `Removed "${topicToRemove}"`), 'info');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, course, snapshot?.courses, host, topics, lang, notify, refreshSnapshot, loadAll]);

  const toggleCrunchMark = useCallback(async (kind: 'read' | 'seen') => {
    if (!selectedCrunch || !course || busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    try {
      const isOn = kind === 'read' ? Boolean(selectedCrunch.done) : Boolean(selectedCrunch.seen);
      const res = await tryAction<BookCrunchResult>(host, 'book.crunch.mark', {
        course,
        hid: selectedCrunch.id,
        kind,
        on: !isOn,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '标记失败', 'Mark failed'), 'error');
        return;
      }
      if (res.value) setCrunch(res.value);
    } finally {
      busyRef.current = false;
    }
  }, [busyLabel, selectedCrunch, course, host, lang, notify]);

  const startCrunchMock = useCallback(async () => {
    if (!course || busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, `正在生成冲刺模拟练习${ell}`, 'Starting crunch mock...'));
    try {
      const pointIds = selectedCrunch ? [selectedCrunch.id] : undefined;
      const res = await tryAction<{ id: string }>(host, 'book.mock', {
        course,
        ...(pointIds ? { pointIds } : {}),
      });
      if (!mountedRef.current) return;
      if (res.ok && res.value?.id) {
        navigate('review', { runId: res.value.id });
        return;
      }
      notify(res.error?.message || t(lang, '该节暂无选择题，先按 g 补题', 'No choice questions for mock yet'), 'warning');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, course, selectedCrunch, host, lang, navigate, notify]);

  const exportExamPrep = useCallback(async () => {
    if (exportBusyRef.current) return;
    if (topics.length === 0 && crunchPoints.length === 0) {
      notify(
        t(lang, '当前暂无可导出的备考重点或冲刺清单', 'No exam prep topics or crunch items to export'),
        'info',
      );
      return;
    }
    exportBusyRef.current = true;
    try {
      const examDate = coursePlan?.examDate ?? crunch?.examDate ?? null;
      const planNotes =
        typeof courseRecord?.plan?.notes === 'string' ? courseRecord.plan.notes : null;
      const markdown = formatExamPrepMarkdown({
        course,
        examDate,
        topics,
        crunchPoints,
        planNotes,
        coursePlan,
        daysLeft: coursePlan?.daysLeft ?? crunch?.daysLeft ?? null,
        lang,
      });
      const defaultPath = defaultBackupFilePath(host.getLibraryRoot(), 'studyhub-examprep', '.md', course || undefined);
      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${topics.length} 项重点 / ${crunchPoints.length} 项冲刺 ${arrow} ${written.path}`,
          `Exported ${topics.length} topic(s) / ${crunchPoints.length} crunch item(s) ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出备考报告失败: ${msg}`, `Failed to export exam prep: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [asciiMode, course, courseRecord, coursePlan, crunch?.daysLeft, crunch?.examDate, crunchPoints, host, lang, notify, topics]);

  useInput(
    (input, key) => {
      if (modalOpen || filterEditing) return;
      if (key.escape && tab === 'focus' && filterQuery) {
        setFilterQuery('');
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta && tab === 'focus') {
        setFilterEditing(true);
        return;
      }
      if (input === 'x' && !key.ctrl && !key.meta) {
        void exportExamPrep();
        return;
      }
      if (input === '1') { setTab('focus'); return; }
      if (input === '2') { setTab('crunch'); setFilterEditing(false); return; }
      if (key.tab) {
        setFocusPane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (input === 'a') {
        setAddModalOpen(true);
        return;
      }
      if (input === 'P') {
        setPlanModalOpen(true);
        return;
      }
      if (input === 'Z' && examGapAlert) {
        setGapAlertDismissed(true);
        notify(t(lang, '本次会话已隐藏考期预警', 'Exam gap alert dismissed for this session'), 'info');
        return;
      }
      if (input === 'T') {
        setShowScheduleTable((v) => !v);
        return;
      }
      if (key.ctrl && input === 'r') {
        void loadAll();
        return;
      }

      if (tab === 'focus') {
        if (input === 'p') {
          void practiceUnmastered();
          return;
        }
        if (input === 'g') {
          if (busyRef.current || busyLabel !== null) return;
          const list = selectedTopic && selectedTopic.status === 'none'
            ? [selectedTopic.topic]
            : noQuestionTopics.slice(0, 5);
          requestGapFill(list);
          return;
        }
        if (input === 'G') {
          if (busyRef.current || busyLabel !== null) return;
          requestGapFill(noQuestionTopics.slice(0, 10));
          return;
        }
        if (input === 'd' && selectedTopic) {
          if (busyRef.current || busyLabel !== null) return;
          setDeleteTopicTarget(selectedTopic.topic);
          return;
        }
      } else if (tab === 'crunch') {
        if (input === ' ') {
          void toggleCrunchMark('seen');
          return;
        }
        if (input === 'm') {
          void toggleCrunchMark('read');
          return;
        }
        if (input === 'p') {
          void startCrunchMock();
          return;
        }
      }
    },
    { isActive: isActive && !modalOpen && !filterEditing },
  );

  // Memoized FSRS distribution bars for selected focus point
  const distBars = useMemo(() => {
    if (!selectedTopic) return [];
    const c = selectedTopic.counts || {};
    const barW = Math.max(18, Math.min(44, Math.floor(width * 0.42)));
    return renderBarChart(
      [
        { label: t(lang, '新题', 'New'), value: c.new ?? 0, color: theme.info },
        { label: t(lang, '薄弱', 'Weak'), value: c.weak ?? 0, color: theme.error },
        { label: t(lang, '学习中', 'Learn'), value: c.learning ?? 0, color: theme.warning },
        { label: t(lang, '熟悉', 'Famil'), value: c.familiar ?? 0, color: theme.accent },
        { label: t(lang, '已掌握', 'Master'), value: c.mastered ?? 0, color: theme.success },
      ],
      barW,
      theme,
      { ascii: asciiMode },
    );
  }, [selectedTopic, width, lang, theme, asciiMode]);

  const proactiveHints = useTuiStore((s) => s.preferences.proactiveHints !== false);
  // Days to the exam come from the backend (course.plan resolves a child course's inherited date; book.crunch too).
  const daysLeft = coursePlan?.daysLeft ?? crunch?.daysLeft;
  const examCoverage = useMemo(() => buildExamCoverage(topics, daysLeft), [topics, daysLeft]);
  const examGapAlert = useMemo(
    () =>
      buildExamGapAlert({
        plan: examCoverage,
        proactiveHints,
        dismissed: gapAlertDismissed,
        lang,
        asciiMode,
      }),
    [examCoverage, proactiveHints, gapAlertDismissed, lang, asciiMode],
  );
  const countdownSummary = useMemo(
    () => examGapAlert?.message || formatExamCountdownSummary(coursePlan, lang, asciiMode),
    [examGapAlert, coursePlan, lang, asciiMode],
  );
  const showFilterBar = tab === 'focus' && (filterEditing || filterQuery.length > 0);
  const showCountdownBar = Boolean(countdownSummary) && !showFilterBar && height >= 16;
  const filterBarH = showFilterBar ? 1 : 0;
  const countdownBarH = showCountdownBar ? 1 : 0;
  const headerH = 3;
  const bodyH = Math.max(8, height - headerH - filterBarH - countdownBarH - (errorMsg ? 1 : 0));

  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${filteredTopics.length}/${topics.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* Header */}
      <Box height={1} width={width} justifyContent="space-between" paddingX={1}>
        <Box gap={1}>
          <Text color={theme.primary} bold>
            {`${asciiMode ? '^' : '⚑'} ${t(lang, '备考补习', 'Exam Prep')}`}
          </Text>
          <Badge label={course || t(lang, '未选课程', 'No Course')} tone="accent" variant="soft" />
          {crunch?.daysLeft !== undefined && crunch.daysLeft !== null ? (
            <Badge
              label={crunch.daysLeft >= 0 ? `${t(lang, '距考', 'D-')}${crunch.daysLeft}${t(lang, '天', 'd')}` : t(lang, '考期已过', 'Past')}
              tone={crunch.daysLeft >= 0 && crunch.daysLeft <= 7 ? 'error' : 'warning'}
              variant="outline"
            />
          ) : null}
        </Box>
        <Box gap={1}>
          {busyLabel ? <Spinner label={busyLabel} active={isActive} /> : null}
          {progress ? (
            <>
              <Badge label={`${t(lang, '掌握', 'Done')} ${progress.done}`} tone="success" variant="soft" />
              <Badge label={`${t(lang, '进行中', 'Prog')} ${inProgressCount}`} tone="warning" variant="soft" />
              <Badge label={`${t(lang, '缺题', 'Empty')} ${progress.none}`} tone={progress.none > 0 ? 'error' : 'muted'} variant="soft" />
            </>
          ) : null}
        </Box>
      </Box>

      {/* Tabs */}
      <Box height={1} width={width} paddingX={1} gap={1} overflow="hidden">
        <Text
          backgroundColor={tab === 'focus' ? theme.primary : theme.surface}
          color={tab === 'focus' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
          bold={tab === 'focus'}
        >
          {` 1:${t(lang, '考纲重点进度', 'Focus Progress')} (${topics.length}) `}
        </Text>
        <Text
          backgroundColor={tab === 'crunch' ? theme.primary : theme.surface}
          color={tab === 'crunch' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
          bold={tab === 'crunch'}
        >
          {` 2:${t(lang, '冲刺清单', 'Crunch List')} (${crunchPoints.length}) `}
        </Text>
        <Text color={theme.dim} wrap="truncate-end">
          {`  [a] ${t(lang, '添加重点', 'Add Focus')}  [P] ${t(lang, '备考计划', 'Plan')}`}
        </Text>
      </Box>
      <Divider width={width} />
      {showCountdownBar ? (
        <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
          <Text color={theme.ai} wrap="truncate">
            {truncateDisplay(countdownSummary, Math.max(10, width - 2), ell)}
          </Text>
        </Box>
      ) : null}
      {showFilterBar ? (
        <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
          <Text color={filterEditing ? theme.primary : theme.accent} bold>
            {filterBadge}
          </Text>
          <Box flexGrow={1} overflow="hidden">
            <TextInput
              value={filterQuery}
              onChange={(val) => setFilterQuery(val)}
              onSubmit={(val) => {
                if (!val.trim()) setFilterQuery('');
                setFilterEditing(false);
              }}
              onCancel={() => {
                setFilterQuery('');
                setFilterEditing(false);
              }}
              isActive={isActive && !modalOpen && tab === 'focus' && filterEditing}
              width={filterInputW}
              prompt="/"
              placeholder={t(lang, `主题/状态/题组${ell}`, `topic/status/deck${ell}`)}
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
      {errorMsg ? (
        <Box height={1} width={width} paddingX={1}>
          <Text color={theme.error} wrap="wrap">{`${asciiMode ? '!' : '✕'} ${errorMsg}`}</Text>
        </Box>
      ) : null}

      {/* Body */}
      {loading && !progress && !crunch ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Spinner label={asciiMode ? t(lang, '正在加载备考重点...', 'Loading exam prep...') : t(lang, '正在加载备考重点…', 'Loading exam prep…')} active={isActive} />
        </Box>
      ) : tab === 'focus' ? (
        topics.length === 0 ? (
          <Box flexDirection="column" height={bodyH} width={width} padding={1}>
            <EmptyState
              icon={asciiMode ? '^' : '⚑'}
              title={t(lang, '尚未添加本课程考纲重点', 'No Exam Focus Points Yet')}
              hint={t(lang, '按 [a] 粘贴划重点文字或输入截图路径，自动提炼并追踪掌握度与补题缺口。', 'Press [a] to paste syllabus text or enter a screenshot path to extract focus points.')}
              actions={[
                { key: 'a', label: t(lang, '添加考纲重点', 'Add Exam Focus') },
                { key: 'c', label: t(lang, '切换课程', 'Switch Course') },
              ]}
              width={width - 2}
              height={Math.max(6, bodyH - 2)}
            />
          </Box>
        ) : (
          <SplitPane
            width={width}
            height={bodyH}
            leftWidth={0.48}
            activePane={focusPane}
            leftLabel={t(lang, '重点条目', 'Focus Points')}
            rightLabel={t(lang, '掌握详情', 'Focus Detail')}
            left={(sz) => (
              <Panel
                title={t(lang, '重点 × 掌握度', 'Focus Progress')}
                badge={normalizedFilter ? `${filteredTopics.length}/${topics.length}` : topics.length}
                subtitle={t(lang, 'p练 g补题 a新增', 'p:Prac g:Gen a:Add')}
                focused={focusPane === 'left'}
                width={sz.width}
                height={sz.height}
                paddingX={0}
              >
                {filteredTopics.length === 0 ? (
                  <Box width={Math.max(10, sz.width - 2)} height={Math.max(3, sz.height - 2)} alignItems="center" justifyContent="center">
                    <Text color={theme.muted}>
                      {truncateDisplay(
                        t(lang, '无匹配重点 (Esc 清除筛选)', 'No matching topics (Esc to clear)'),
                        Math.max(10, sz.width - 4),
                        ell,
                      )}
                    </Text>
                  </Box>
                ) : (
                  <VirtualList
                    items={filteredTopics}
                    width={Math.max(10, sz.width - 2)}
                    height={Math.max(3, sz.height - 2)}
                    selectedIndex={clampedTopicIdx}
                    onChange={setTopicIdx}
                    isActive={isActive && !modalOpen && !filterEditing && focusPane === 'left'}
                    ascii={asciiMode}
                    renderItem={(tp, ctx) => {
                      const st = focusStatusLabel(tp.status, lang);
                      const pct = tp.cards > 0 ? `${Math.round((tp.mastery || 0) * 100)}%` : '0题';
                      const right = `[${st}] ${pct}`;
                      const rightW = displayWidth(right) + 1;
                      const nameW = Math.max(6, ctx.width - rightW);
                      const tone = focusStatusTone(tp.status);
                      const fg = ctx.selected
                        ? theme.selectionFg
                        : tone === 'success'
                          ? theme.success
                          : tone === 'error'
                            ? theme.error
                            : tone === 'muted'
                              ? theme.dim
                              : theme.text;
                      return (
                        <Text color={fg} bold={ctx.selected}>
                          {`${padDisplay(truncateDisplay(tp.topic, nameW, asciiMode ? '...' : '…'), nameW)} ${right}`}
                        </Text>
                      );
                    }}
                  />
                )}
              </Panel>
            )}
            right={(sz) => (
              <Panel
                title={
                  showScheduleTable
                    ? t(lang, '排程与重点矩阵 [T]详情', 'Schedule & Matrix [T]Detail')
                    : selectedTopic
                      ? truncateDisplay(selectedTopic.topic, Math.max(10, sz.width - 14), asciiMode ? '...' : '…')
                      : t(lang, '详情', 'Detail')
                }
                subtitle={t(lang, '[T]排程表', '[T]Table')}
                focused={focusPane === 'right'}
                width={sz.width}
                height={sz.height}
              >
                {showScheduleTable ? (
                  <Box flexDirection="column" gap={0}>
                    {(() => {
                      const innerW = Math.max(16, sz.width - 4);
                      const schedLines = renderExamScheduleTable(coursePlan, innerW, theme, { lang, ascii: asciiMode });
                      const gapSteps = buildGapFillWorkflowSteps(examCoverage, lang);
                      const matrixLines =
                        schedLines.length > 0
                          ? schedLines
                          : renderStatTable(
                              [
                                { key: 'topic', label: t(lang, '重点', 'Topic'), align: 'left', minWidth: 8 },
                                { key: 'status', label: t(lang, '状态', 'Status'), align: 'left', width: 6 },
                                { key: 'cards', label: t(lang, '题数', 'Qty'), align: 'right', width: 4 },
                                { key: 'mastery', label: t(lang, '掌握', 'Mast'), align: 'right', width: 5 },
                              ],
                              filteredTopics.slice(0, Math.max(2, sz.height - 5)).map((tp) => ({
                                topic: tp.topic,
                                status: focusStatusLabel(tp.status, lang),
                                cards: tp.cards,
                                mastery: tp.cards > 0 ? `${Math.round((tp.mastery || 0) * 100)}%` : '-',
                              })),
                              innerW,
                              theme,
                              { ascii: asciiMode },
                            );
                      return (
                        <>
                          {matrixLines.slice(0, Math.max(3, sz.height - (gapSteps.length > 0 ? 6 : 3))).map((line, i) => (
                            <Text key={`ep-tbl-${i}`} wrap="truncate">
                              {line}
                            </Text>
                          ))}
                          {gapSteps.length > 0 ? (
                            <Box flexDirection="column" marginTop={1}>
                              <Text color={theme.accent} bold>
                                {t(lang, '缺口自动补齐步骤（写操作需确认）:', 'Auto Gap-Fill Steps (writes confirmed):')}
                              </Text>
                              {gapSteps.slice(0, 3).map((s) => (
                                <Text key={`gs-${s.index}`} color={s.requiresConfirm ? theme.warning : theme.muted} wrap="truncate">
                                  {truncateDisplay(`${s.index + 1}. ${s.label}`, innerW, ell)}
                                </Text>
                              ))}
                            </Box>
                          ) : null}
                        </>
                      );
                    })()}
                  </Box>
                ) : selectedTopic ? (
                  <Box flexDirection="column" gap={1}>
                    <Box gap={1}>
                      <Badge label={focusStatusLabel(selectedTopic.status, lang)} tone={focusStatusTone(selectedTopic.status)} />
                      <Badge label={`${selectedTopic.cards} ${t(lang, '题', 'cards')}`} tone="info" variant="soft" />
                      {selectedTopic.weakCards.length > 0 ? (
                        <Badge label={`${selectedTopic.weakCards.length} ${t(lang, '薄弱', 'weak')}`} tone="error" variant="soft" />
                      ) : null}
                    </Box>
                    <ProgressBar
                      ratio={selectedTopic.mastery || 0}
                      width={Math.max(12, sz.width - 4)}
                      label={t(lang, '掌握率', 'Mastery')}
                    />
                    <Divider width={Math.max(8, sz.width - 4)} />
                    {distBars.map((line, i) => (
                      <Text key={i}>{line}</Text>
                    ))}
                    <Divider width={Math.max(8, sz.width - 4)} />
                    <Text color={theme.muted}>
                      {selectedTopic.status === 'none'
                        ? t(lang, '该重点尚无关联题目 — 按 [g] 自动从课程资料出题补齐。', 'No questions linked yet — press [g] to generate gap-fill questions.')
                        : selectedTopic.weakCards.length > 0
                          ? t(lang, '有待巩固薄弱题 — 按 [p] 立即针对练习。', 'Has weak cards — press [p] to practise now.')
                          : t(lang, '按 [p] 复习相关题目，或按 [d] 从重点清单中移除。', 'Press [p] to practise, or [d] to remove this focus topic.')}
                    </Text>
                  </Box>
                ) : null}
              </Panel>
            )}
          />
        )
      ) : crunchPoints.length === 0 ? (
        <Box flexDirection="column" height={bodyH} width={width} padding={1}>
          <EmptyState
            icon={asciiMode ? '=' : '▣'}
            title={crunchStatusLabel(crunch?.status || 'no-book', lang)}
            hint={t(lang, '前往「复习全书」生成复习全书并设置考试日期后，这里会生成每日冲刺清单。', 'Build a Review Book and set an exam date to unlock the crunch list.')}
            actions={[
              { key: '7', label: t(lang, '前往复习全书', 'Open Book') },
              { key: 'a', label: t(lang, '添加重点', 'Add Focus') },
            ]}
            width={width - 2}
            height={Math.max(6, bodyH - 2)}
          />
        </Box>
      ) : (
        <SplitPane
          width={width}
          height={bodyH}
          leftWidth={0.5}
          activePane={focusPane}
          leftLabel={t(lang, '冲刺清单', 'Crunch Points')}
          rightLabel={t(lang, '考点详情', 'Point Detail')}
          left={(sz) => (
            <Panel
              title={t(lang, '冲刺知识点', 'Crunch List')}
              badge={crunchPoints.length}
              subtitle={crunchStatusLabel(crunch?.status || 'ok', lang)}
              focused={focusPane === 'left'}
              width={sz.width}
              height={sz.height}
              paddingX={0}
            >
              <VirtualList
                items={crunchPoints}
                width={Math.max(10, sz.width - 2)}
                height={Math.max(3, sz.height - 2)}
                selectedIndex={crunchIdx}
                onChange={setCrunchIdx}
                isActive={isActive && !modalOpen && !filterEditing && focusPane === 'left'}
                ascii={asciiMode}
                renderItem={(pt, ctx) => {
                  const mark = asciiMode ? (pt.done ? '+' : pt.seen ? '~' : 'o') : (pt.done ? '✓' : pt.seen ? '◐' : '○');
                  const tag = `${pt.questions ?? 0}题${pt.weak ? `/${pt.weak}错` : ''}`;
                  const tagW = displayWidth(tag) + 1;
                  const titleW = Math.max(6, ctx.width - tagW - 2);
                  return (
                    <Text color={ctx.selected ? theme.selectionFg : pt.done ? theme.success : pt.weak ? theme.warning : theme.text} bold={ctx.selected}>
                      {`${mark} ${padDisplay(truncateDisplay(pt.title, titleW, asciiMode ? '...' : '…'), titleW)} ${tag}`}
                    </Text>
                  );
                }}
              />
            </Panel>
          )}
          right={(sz) => (
            <Panel
              title={selectedCrunch ? truncateDisplay(selectedCrunch.title, Math.max(10, sz.width - 14), asciiMode ? '...' : '…') : t(lang, '详情', 'Detail')}
              subtitle={t(lang, 'Space已看 m读完 p模考', 'Space:Seen m:Read p:Mock')}
              focused={focusPane === 'right'}
              width={sz.width}
              height={sz.height}
            >
              {selectedCrunch ? (
                <Box flexDirection="column" gap={1}>
                  <Box gap={1}>
                    <Badge label={selectedCrunch.done ? t(lang, '已读完', asciiMode ? 'Read +' : 'Read ✓') : t(lang, '未读完', 'Unread')} tone={selectedCrunch.done ? 'success' : 'muted'} />
                    <Badge label={selectedCrunch.seen ? t(lang, '已翻看', 'Seen') : t(lang, '未翻看', 'Unseen')} tone={selectedCrunch.seen ? 'info' : 'muted'} variant="soft" />
                    {selectedCrunch.examDay?.band ? (
                      <Badge
                        label={`${t(lang, '考日预测', 'Exam')}: ${selectedCrunch.examDay.band}`}
                        tone={selectedCrunch.examDay.band === 'solid' ? 'success' : selectedCrunch.examDay.band === 'weak' ? 'error' : 'warning'}
                        variant="outline"
                      />
                    ) : null}
                  </Box>
                  <Text color={theme.text}>
                    {`${t(lang, '题数', 'Questions')}: ${selectedCrunch.questions ?? 0}   ${t(lang, '薄弱', 'Weak')}: ${selectedCrunch.weak ?? 0}   ${t(lang, '到期', 'Due')}: ${selectedCrunch.due ?? 0}   ${t(lang, '未练', 'Fresh')}: ${selectedCrunch.fresh ?? 0}`}
                  </Text>
                  {selectedCrunch.tested?.length ? (
                    <Text color={theme.accent}>{`${t(lang, '样卷考过', 'Tested in')}: ${selectedCrunch.tested.join(', ')}`}</Text>
                  ) : null}
                  {selectedCrunch.pitfalls?.length ? (
                    <Box flexDirection="column">
                      <Text color={theme.warning} bold>{t(lang, '易错点提醒', 'Pitfalls')}:</Text>
                      {selectedCrunch.pitfalls.slice(0, 5).map((pf, i) => (
                        <Text key={i} color={theme.muted}>{truncateDisplay(`${asciiMode ? '*' : '•'} ${pf}`, Math.max(10, sz.width - 4), asciiMode ? '...' : '…')}</Text>
                      ))}
                    </Box>
                  ) : null}
                </Box>
              ) : null}
            </Panel>
          )}
        />
      )}

      {/* [a] Add Exam Focus Modal */}
      <Suspense fallback={null}>
        {addModalOpen ? (
          <AddFocusModal
            host={host}
            course={course}
            existingTopics={topics.map((tp) => tp.topic)}
            width={width}
            isActive={isActive}
            onClose={() => setAddModalOpen(false)}
            onSaved={() => {
              setAddModalOpen(false);
              void refreshSnapshot().then(() => loadAll());
            }}
          />
        ) : null}
      </Suspense>

      {/* [P] Course Study Plan & Readiness Modal */}
      <Suspense fallback={null}>
        {planModalOpen ? (
          <StudyPlanModal
            host={host}
            course={course}
            width={width}
            height={height}
            isActive={isActive}
            onClose={() => setPlanModalOpen(false)}
            onUpdated={() => {
              void refreshSnapshot().then(() => loadAll());
            }}
          />
        ) : null}
      </Suspense>

      {/* Confirm remove focus topic */}
      {deleteTopicTarget ? (
        <ConfirmDialog
          title={t(lang, '移除重点条目', 'Remove Focus Topic')}
          message={t(lang, `确认从「${course}」的重点清单中移除「${deleteTopicTarget}」？已生成的题目不会被删除。`, `Remove "${deleteTopicTarget}" from "${course}" focus list? Existing cards are kept.`)}
          confirmLabel={t(lang, '移除', 'Remove')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive}
          onConfirm={() => void confirmRemoveTopic(deleteTopicTarget)}
          onCancel={() => setDeleteTopicTarget(null)}
        />
      ) : null}

      {/* Confirm gap-fill AI generation */}
      {gapFillConfirm ? (
        <ConfirmDialog
          title={t(lang, '确认重点补齐出题', 'Confirm Gap-Fill Generation')}
          message={
            <Box flexDirection="column" gap={1}>
              <Text color={theme.text}>
                {t(
                  lang,
                  `即将为 ${gapFillConfirm.topics.length} 个缺失重点主题调用 AI 出题，预计发起约 1 次生成任务（约 ${gapFillConfirm.count} 题），确认继续吗？`,
                  `Will generate questions for ${gapFillConfirm.topics.length} missing focus topics (~1 AI generation job, ~${gapFillConfirm.count} questions). Continue?`,
                )}
              </Text>
              <Text color={theme.muted}>
                {`${t(lang, '目标主题', 'Topics')}: ${gapFillConfirm.topics.slice(0, 5).join(', ')}${gapFillConfirm.topics.length > 5 ? ` (+${gapFillConfirm.topics.length - 5})` : ''}`}
              </Text>
            </Box>
          }
          confirmLabel={t(lang, '开始出题', 'Generate')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => {
            const list = gapFillConfirm.topics;
            setGapFillConfirm(null);
            void generateGapFill(list);
          }}
          onCancel={() => setGapFillConfirm(null)}
        />
      ) : null}
    </Box>
  );
};
