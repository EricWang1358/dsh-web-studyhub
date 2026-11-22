import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { renderBarChart } from '../../render/charts.js';
import { currentCourse, listCourses } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
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

const CLAIMED_KEYS = ['1', '2', 'a', 'd', 'g', 'G', 'm', 'p', 'P', 'r', ' '] as const;

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

  const [topicIdx, setTopicIdx] = useState(0);
  const [crunchIdx, setCrunchIdx] = useState(0);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [deleteTopicTarget, setDeleteTopicTarget] = useState<string | null>(null);
  const [gapFillConfirm, setGapFillConfirm] = useState<{ topics: string[]; count: number } | null>(null);

  const modalOpen = addModalOpen || planModalOpen || deleteTopicTarget !== null || gapFillConfirm !== null;
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAll = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setErrorMsg(null);
    const [fpRes, crRes] = await Promise.all([
      tryAction<FocusProgressResult>(host, 'course.focusProgress', course ? { course } : {}),
      tryAction<BookCrunchResult>(host, 'book.crunch', course ? { course } : {}),
    ]);
    if (!mountedRef.current || seq !== reqSeqRef.current) return;
    if (fpRes.ok && fpRes.value) setProgress(fpRes.value);
    else if (!fpRes.ok) setErrorMsg(fpRes.error?.message || t(lang, '加载重点进度失败', 'Failed to load focus progress'));
    if (crRes.ok && crRes.value) setCrunch(crRes.value);
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

  const topics = progress?.topics ?? [];
  const selectedTopic: FocusTopicProgress | undefined = topics[Math.min(topicIdx, Math.max(0, topics.length - 1))];
  const crunchPoints = crunch?.points ?? [];
  const selectedCrunch: CrunchPoint | undefined = crunchPoints[Math.min(crunchIdx, Math.max(0, crunchPoints.length - 1))];

  const noQuestionTopics = useMemo(() => topics.filter((tp) => tp.status === 'none').map((tp) => tp.topic), [topics]);
  const inProgressCount = useMemo(() => topics.filter((tp) => focusStatusGroup(tp.status) === 'in_progress').length, [topics]);

  useClaimKeys(CLAIMED_KEYS, isActive && !modalOpen);

  const hints = useMemo<KeyHint[]>(() => {
    if (tab === 'focus') {
      return [
        { key: '1/2', label: t(lang, '重点/冲刺', 'Focus/Crunch') },
        { key: 'a', label: t(lang, '添加重点', 'Add Focus') },
        { key: 'p', label: t(lang, '练习未掌握', 'Practice') },
        { key: 'g/G', label: t(lang, '补齐出题', 'Gap-Fill') },
        { key: 'P', label: t(lang, '备考计划', 'Plan') },
        { key: 'd', label: t(lang, '移除重点', 'Remove') },
      ];
    }
    return [
      { key: '1/2', label: t(lang, '重点/冲刺', 'Focus/Crunch') },
      { key: 'Space', label: t(lang, '标记已看', 'Seen') },
      { key: 'm', label: t(lang, '标记读完', 'Read') },
      { key: 'p', label: t(lang, '模拟开练', 'Mock/Practice') },
      { key: 'P', label: t(lang, '备考计划', 'Plan') },
      { key: 'a', label: t(lang, '添加重点', 'Add Focus') },
    ];
  }, [tab, lang]);

  useFooterHints(hints, isActive);

  // Actions
  const practiceUnmastered = useCallback(async () => {
    if (busyRef.current || busyLabel !== null) return;
    const scope = selectedTopic?.weakCards?.length
      ? selectedTopic.weakCards
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

  useInput(
    (input, key) => {
      if (modalOpen) return;
      if (input === '1') { setTab('focus'); return; }
      if (input === '2') { setTab('crunch'); return; }
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
      if (input === 'r') {
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
    { isActive: isActive && !modalOpen },
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

  const headerH = 3;
  const bodyH = Math.max(8, height - headerH - (errorMsg ? 1 : 0));

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
      {errorMsg ? (
        <Box height={1} width={width} paddingX={1}>
          <Text color={theme.error}>{`${asciiMode ? '!' : '✕'} ${truncateDisplay(errorMsg, Math.max(10, width - 4), asciiMode ? '...' : '…')}`}</Text>
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
                badge={topics.length}
                subtitle={t(lang, 'p练 g补题 a新增', 'p:Prac g:Gen a:Add')}
                focused={focusPane === 'left'}
                width={sz.width}
                height={sz.height}
                paddingX={0}
              >
                <VirtualList
                  items={topics}
                  width={Math.max(10, sz.width - 2)}
                  height={Math.max(3, sz.height - 2)}
                  selectedIndex={topicIdx}
                  onChange={setTopicIdx}
                  isActive={isActive && !modalOpen && focusPane === 'left'}
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
              </Panel>
            )}
            right={(sz) => (
              <Panel
                title={selectedTopic ? truncateDisplay(selectedTopic.topic, Math.max(10, sz.width - 14), asciiMode ? '...' : '…') : t(lang, '详情', 'Detail')}
                focused={focusPane === 'right'}
                width={sz.width}
                height={sz.height}
              >
                {selectedTopic ? (
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
                isActive={isActive && !modalOpen && focusPane === 'left'}
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
