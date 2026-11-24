import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';

export interface BookCrunchModalProps {
  host: HostClient;
  course: string | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
}

interface CrunchReason {
  code: string;
  count?: number;
  tested?: number;
  weak?: number;
  minutes?: number;
  capacity?: number;
  pitfalls?: number;
}

interface CrunchDay {
  date: string;
  offset: number;
  mode: 'learn' | 'flip' | 'off' | string;
  mock?: boolean;
  points: string[];
  done: string[];
  minutes: number;
  reason?: CrunchReason;
}

interface CrunchPoint {
  id: string;
  key?: string;
  code?: string;
  number?: string;
  title: string;
  order?: number;
  tested?: number;
  weakness?: number;
  questions?: number;
  weak?: number;
  due?: number;
  fresh?: number;
  size?: number;
  pitfalls?: number;
  focus?: boolean;
  examDay?: {
    band?: 'solid' | 'slip' | 'weak' | string;
    atRisk?: Array<{ deckId: string; cardId: string; rank?: number }>;
  };
  done?: string | null;
  seen?: string | null;
}

interface BookCrunchResponse {
  status: 'ok' | 'far' | 'past' | 'no-exam' | 'no-book' | 'no-course' | string;
  course: string | null;
  examDate?: string | null;
  daysLeft?: number | null;
  today?: string;
  window?: number;
  plan?: {
    status?: string;
    daysLeft?: number | null;
    weighting?: string;
    reviewDays?: number;
    flipStart?: string | null;
    capacity?: number;
    days?: CrunchDay[];
    today?: CrunchDay | null;
    unlearned?: string[];
  };
  points?: CrunchPoint[];
}

interface BookMockPlanResponse {
  status: string;
  course: string;
  points: string[];
  questions: number;
  eligible: number;
  leftOut?: Record<string, number>;
  count: number;
  capped?: boolean;
  limitMinutes?: number;
}

type ScheduleRow =
  | {
      kind: 'day';
      key: string;
      day: CrunchDay;
      isToday: boolean;
    }
  | {
      kind: 'point';
      key: string;
      day: CrunchDay;
      point: CrunchPoint;
      isToday: boolean;
    };

function formatDayModeLabel(day: CrunchDay, lang: 'zh' | 'en'): { label: string; tone: 'primary' | 'warning' | 'accent' | 'muted' } {
  if (day.mode === 'off') return { label: t(lang, '休息', 'Off'), tone: 'muted' };
  if (day.mode === 'flip') {
    if (day.mock) return { label: t(lang, '翻看+模考', 'Skim+Mock'), tone: 'warning' };
    return { label: t(lang, '翻看', 'Skim'), tone: 'accent' };
  }
  return { label: t(lang, '精学', 'Learn'), tone: 'primary' };
}

function formatDayReason(day: CrunchDay, lang: 'zh' | 'en'): string {
  const r = day.reason;
  if (!r) return '';
  switch (r.code) {
    case 'done':
      return t(lang, `已完成 ${r.count ?? day.points.length} 节`, `Completed ${r.count ?? day.points.length}`);
    case 'exam-today':
      return t(lang, `今日考试 · 考前速览 ${r.count ?? day.points.length} 节`, `Exam today · skim ${r.count ?? day.points.length}`);
    case 'off':
      return t(lang, '休息日（不安排新任务）', 'Rest day');
    case 'learn-free':
      return t(lang, '本阶段知识点已排完', 'All points scheduled');
    case 'learn-over':
      return t(
        lang,
        `${r.count ?? 0} 节 · 预计 ${r.minutes ?? day.minutes}m（超每日 ${r.capacity ?? 0}m 上限）`,
        `${r.count ?? 0} pts · ~${r.minutes ?? day.minutes}m (over ${r.capacity ?? 0}m cap)`,
      );
    case 'learn':
      return t(
        lang,
        `${r.count ?? 0} 节 · 样卷考过 ${r.tested ?? 0} · 薄弱 ${r.weak ?? 0} · ${r.minutes ?? day.minutes}m`,
        `${r.count ?? 0} pts · tested ${r.tested ?? 0} · weak ${r.weak ?? 0} · ${r.minutes ?? day.minutes}m`,
      );
    case 'learn-size':
      return t(
        lang,
        `${r.count ?? 0} 节 · 薄弱 ${r.weak ?? 0} · 约 ${r.minutes ?? day.minutes}m`,
        `${r.count ?? 0} pts · weak ${r.weak ?? 0} · ~${r.minutes ?? day.minutes}m`,
      );
    case 'flip-mock':
      return t(
        lang,
        `翻看 ${r.count ?? 0} 节（易错 ${r.pitfalls ?? 0}）+ 全真模拟卷`,
        `Skim ${r.count ?? 0} pts (${r.pitfalls ?? 0} pitfalls) + Mock exam`,
      );
    case 'flip':
      return t(
        lang,
        `翻看 ${r.count ?? 0} 节（易错 ${r.pitfalls ?? 0} · ${day.minutes}m）`,
        `Skim ${r.count ?? 0} pts (${r.pitfalls ?? 0} pitfalls · ${day.minutes}m)`,
      );
    default:
      return `${day.points.length} ${t(lang, '节', 'pts')} · ${day.minutes}m`;
  }
}

function formatLeftOutSummary(leftOut: Record<string, number> | undefined, lang: 'zh' | 'en'): string {
  if (!leftOut) return '';
  const total = Object.values(leftOut).reduce((acc, n) => acc + (Number(n) || 0), 0);
  if (!total) return '';
  return t(lang, `（另有 ${total} 道非选择题不计入模考）`, `(${total} non-choice excluded)`);
}

export const BookCrunchModal = memo(function BookCrunchModal({
  host,
  course,
  isActive,
  width,
  height,
  onClose,
}: BookCrunchModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crunch, setCrunch] = useState<BookCrunchResponse | null>(null);
  const [mockPlan, setMockPlan] = useState<BookMockPlanResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const initialFocusDoneRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    const seq = ++seqRef.current;
    setError(null);
    const args = course ? { course } : {};
    const [crunchRes, mockRes] = await Promise.all([
      tryAction<BookCrunchResponse>(host, 'book.crunch', args),
      tryAction<BookMockPlanResponse>(host, 'book.mock.plan', args),
    ]);
    if (!mountedRef.current || seq !== seqRef.current) return;
    if (crunchRes.ok && crunchRes.value) {
      setCrunch(crunchRes.value);
    } else {
      setCrunch(null);
      setError(crunchRes.error?.message || t(lang, '加载期末一周计划失败', 'Failed to load crunch schedule'));
    }
    if (mockRes.ok && mockRes.value) {
      setMockPlan(mockRes.value);
    } else {
      setMockPlan(null);
    }
    setLoading(false);
  }, [host, course, lang]);

  useEffect(() => {
    setLoading(true);
    initialFocusDoneRef.current = false;
    void loadData();
  }, [loadData]);

  const effectiveCourse = crunch?.course ?? mockPlan?.course ?? course ?? null;

  const scheduleRows = useMemo<ScheduleRow[]>(() => {
    const days = crunch?.plan?.days ?? [];
    const pointMap = new Map((crunch?.points ?? []).map((p) => [p.id, p]));
    const rows: ScheduleRow[] = [];
    for (const day of days) {
      const isToday = day.offset === 0;
      rows.push({
        kind: 'day',
        key: `day:${day.date}`,
        day,
        isToday,
      });
      for (const pid of day.points ?? []) {
        const point = pointMap.get(pid);
        if (!point) continue;
        rows.push({
          kind: 'point',
          key: `pt:${day.date}:${pid}`,
          day,
          point,
          isToday,
        });
      }
    }
    return rows;
  }, [crunch?.plan?.days, crunch?.points]);

  // Focus today's first point (or first point in the list) on initial load
  useEffect(() => {
    if (initialFocusDoneRef.current || scheduleRows.length === 0) return;
    initialFocusDoneRef.current = true;
    const todayPt = scheduleRows.findIndex((r) => r.kind === 'point' && r.isToday);
    if (todayPt >= 0) {
      setSelectedIndex(todayPt);
      return;
    }
    const firstPt = scheduleRows.findIndex((r) => r.kind === 'point');
    if (firstPt >= 0) setSelectedIndex(firstPt);
  }, [scheduleRows]);

  useEffect(() => {
    if (scheduleRows.length > 0 && selectedIndex >= scheduleRows.length) {
      setSelectedIndex(scheduleRows.length - 1);
    }
  }, [scheduleRows.length, selectedIndex]);

  const selectedRow = scheduleRows[selectedIndex] ?? null;

  const toggleFocusedMark = useCallback(async () => {
    if (!selectedRow || selectedRow.kind !== 'point' || busy) return;
    const { day, point } = selectedRow;
    const kind: 'read' | 'seen' = day.mode === 'flip' || (point.questions ?? 0) > 0 ? 'seen' : 'read';
    const isOn = kind === 'read' ? Boolean(point.done) : Boolean(point.seen);
    setBusy(true);
    const res = await tryAction<BookCrunchResponse>(host, 'book.crunch.mark', {
      ...(effectiveCourse ? { course: effectiveCourse } : {}),
      hid: point.id,
      kind,
      on: !isOn,
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setBusy(false);
      notify(res.error?.message || t(lang, '更新打卡状态失败', 'Failed to update mark'), 'error');
      return;
    }
    if (res.value) {
      setCrunch(res.value);
    } else {
      await loadData();
    }
    const mockRes = await tryAction<BookMockPlanResponse>(
      host,
      'book.mock.plan',
      effectiveCourse ? { course: effectiveCourse } : {},
    );
    if (!mountedRef.current) return;
    if (mockRes.ok && mockRes.value) setMockPlan(mockRes.value);
    setBusy(false);
    notify(
      !isOn
        ? kind === 'read'
          ? t(lang, `已标记读完「${point.title}」`, `Marked "${point.title}" read`)
          : t(lang, `已标记已看「${point.title}」`, `Marked "${point.title}" seen`)
        : t(lang, `已取消「${point.title}」标记`, `Cleared mark for "${point.title}"`),
      'success',
    );
  }, [selectedRow, busy, host, effectiveCourse, notify, lang, loadData]);

  const startMockExam = useCallback(async () => {
    if (busy) return;
    if (!mockPlan || mockPlan.eligible <= 0) {
      notify(
        t(lang, '当前课程复习全书暂无可用选择题，无法生成模拟卷', 'No eligible choice questions available for a mock paper'),
        'warning',
      );
      return;
    }
    setBusy(true);
    const res = await tryAction<{ id?: string }>(host, 'book.mock', {
      ...(effectiveCourse ? { course: effectiveCourse } : {}),
      count: mockPlan.count,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok || !res.value?.id) {
      notify(res.error?.message || t(lang, '无法启动模拟考试', 'Failed to start mock exam'), 'error');
      return;
    }
    onClose();
    navigate('review', {
      runId: res.value.id,
      ...(effectiveCourse ? { course: effectiveCourse } : {}),
    });
  }, [busy, mockPlan, host, effectiveCourse, notify, lang, onClose, navigate]);

  useInput(
    (input) => {
      if (loading || busy) return;
      if (input === ' ') {
        void toggleFocusedMark();
        return;
      }
      if (input === 'm') {
        void startMockExam();
        return;
      }
      if (input === 'r') {
        setLoading(true);
        void loadData();
      }
    },
    { isActive: isActive && !loading && !busy },
  );

  const frameW = Math.max(48, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);
  const listH = Math.max(3, bodyH - 5);

  const hints = useMemo<KeyHint[]>(() => {
    const out: KeyHint[] = [];
    if (scheduleRows.length > 0) {
      out.push({ key: 'Space', label: t(lang, '标记已看/读完', 'Toggle Mark') });
    }
    if (mockPlan && mockPlan.eligible > 0) {
      out.push({ key: 'm', label: t(lang, '开始模考', 'Start Mock') });
    }
    out.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    out.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return out;
  }, [scheduleRows.length, mockPlan, lang]);

  const renderScheduleRow = useCallback(
    (row: ScheduleRow, ctx: VirtualListRenderContext) => {
      if (row.kind === 'day') {
        const { day, isToday } = row;
        const modeInfo = formatDayModeLabel(day, lang);
        const dayPrefix = isToday
          ? t(lang, '今日', 'Today')
          : day.offset < 0
            ? t(lang, '已过', 'Past')
            : `+${day.offset}d`;
        const tag = `[${dayPrefix} ${day.date.slice(5)} ${modeInfo.label}]`;
        const reasonText = formatDayReason(day, lang);
        const avail = Math.max(4, ctx.width - displayWidth(tag) - 1);
        const trimmedReason = truncateDisplay(reasonText, avail);
        const modeColor = ctx.selected
          ? theme.selectionFg
          : modeInfo.tone === 'warning'
            ? theme.warning
            : modeInfo.tone === 'accent'
              ? theme.accent
              : modeInfo.tone === 'primary'
                ? theme.primary
                : theme.muted;
        return (
          <Text color={ctx.selected ? theme.selectionFg : theme.heading} bold>
            <Text color={modeColor}>{tag}</Text>
            {trimmedReason ? <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{` ${trimmedReason}`}</Text> : null}
          </Text>
        );
      }

      const { day, point } = row;
      const marked = day.mode === 'flip' ? Boolean(point.seen) : Boolean(point.done || point.seen);
      const glyph = marked ? (asciiMode ? '[x]' : '[✓]') : '[ ]';
      const bandTag =
        point.examDay?.band === 'weak'
          ? t(lang, ' 弱', ' !')
          : point.examDay?.band === 'slip'
            ? t(lang, ' 滑', ' ~')
            : '';
      const qTag = (point.questions ?? 0) > 0 ? ` ${point.questions}${t(lang, '题', 'Q')}` : t(lang, ' 精读', ' Read');
      const pitTag = (point.pitfalls ?? 0) > 0 ? ` ${t(lang, '易错', 'Pit')}:${point.pitfalls}` : '';
      const rightMeta = `${qTag}${pitTag}${bandTag}`;
      const prefix = `  ${glyph} `;
      const codePart = point.number ? `${point.number} ` : point.code ? `${point.code} ` : '';
      const avail = Math.max(6, ctx.width - displayWidth(prefix) - displayWidth(rightMeta) - 1);
      const label = padDisplay(truncateDisplay(`${codePart}${point.title}`, avail), avail);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      const glyphColor = ctx.selected ? theme.selectionFg : marked ? theme.success : theme.dim;
      const rightColor = ctx.selected
        ? theme.selectionFg
        : point.examDay?.band === 'weak'
          ? theme.error
          : point.examDay?.band === 'slip'
            ? theme.warning
            : theme.muted;

      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={glyphColor}>{prefix}</Text>
          {label}
          <Text color={rightColor}>{` ${rightMeta}`}</Text>
        </Text>
      );
    },
    [lang, asciiMode, theme],
  );

  const renderEmptySchedule = () => {
    const st = crunch?.status ?? 'no-book';
    if (st === 'no-course') {
      return (
        <EmptyState
          icon={asciiMode ? '*' : '▣'}
          title={t(lang, '尚未选择课程', 'No course selected')}
          hint={t(lang, '关闭弹窗后按 [c] 选择一门课程。', 'Close and press [c] to select a course.')}
          width={innerW}
          height={listH}
        />
      );
    }
    if (st === 'no-book') {
      return (
        <EmptyState
          icon={asciiMode ? '*' : '▣'}
          title={t(lang, '当前课程尚未生成复习全书', 'No review book yet')}
          hint={t(lang, '按 [Esc] 返回后按 [g] 自动生成总纲与复习全书，再制定期末冲刺计划。', 'Press [Esc], then [g] in Book view to build the review book first.')}
          width={innerW}
          height={listH}
        />
      );
    }
    if (st === 'no-exam') {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '◷'}
          title={t(lang, '尚未设置本课程考试日期', 'No exam date set for this course')}
          hint={t(lang, '按 [C] 打开课程设置 -> 标签 2「重命名与目标」-> [d] 设置考试日期后即可生成期末一周日程。', 'Press [C] to open Course Settings -> Tab 2 -> [d] Set Exam Date to generate a crunch schedule.')}
          width={innerW}
          height={listH}
        />
      );
    }
    if (st === 'past') {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '◷'}
          title={t(lang, `考试日期 (${crunch?.examDate ?? ''}) 已过`, `Exam date (${crunch?.examDate ?? ''}) has passed`)}
          hint={t(lang, '可在课程设置 [C] 中更新或清除考试日期；下方仍可直接开启模拟试卷练习。', 'Update or clear the exam date in Course Settings [C]; mock exam below remains available.')}
          width={innerW}
          height={listH}
        />
      );
    }
    if (st === 'far') {
      return (
        <EmptyState
          icon={asciiMode ? 'o' : '◷'}
          title={t(
            lang,
            `距考试 ${crunch?.examDate ?? ''} 还有 ${crunch?.daysLeft ?? '?'} 天`,
            `Exam ${crunch?.examDate ?? ''} is ${crunch?.daysLeft ?? '?'}d away`,
          )}
          hint={t(
            lang,
            `考前 ${crunch?.window ?? 21} 天内会自动排入每日冲刺日程；现在也可按 [m] 做一套综合模拟卷。`,
            `Daily crunch schedule opens within ${crunch?.window ?? 21}d of the exam; press [m] for a mock paper anytime.`,
          )}
          width={innerW}
          height={listH}
        />
      );
    }
    return (
      <EmptyState
        icon={asciiMode ? '*' : '▣'}
        title={t(lang, '暂无冲刺日程条目', 'No schedule items')}
        hint={t(lang, '请确认课程总纲与复习全书包含知识点。', 'Ensure the review book contains leaf sections.')}
        width={innerW}
        height={listH}
      />
    );
  };

  const mockLeftOut = formatLeftOutSummary(mockPlan?.leftOut, lang);
  const doneCount = (crunch?.points ?? []).filter((p) => Boolean(p.done || p.seen)).length;
  const totalPoints = crunch?.points?.length ?? 0;

  return (
    <Modal
      title={t(lang, '期末一周冲刺 & 模拟考', 'Final Week Crunch & Mock')}
      icon={asciiMode ? '*' : '⚑'}
      tone="warning"
      subtitle={effectiveCourse ?? undefined}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive}
      hints={hints}
    >
      {loading ? (
        <Box height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在载入期末一周日程与模拟卷…', 'Loading crunch schedule & mock plan…')} active={isActive} />
        </Box>
      ) : error && !crunch && !mockPlan ? (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '加载期末冲刺失败', 'Failed to load crunch schedule')}
          hint={error}
          actions={[{ key: 'r', label: t(lang, '重试', 'Retry') }]}
          width={innerW}
          height={bodyH}
        />
      ) : (
        <Box flexDirection="column" height={bodyH} overflow="hidden">
          {/* Summary header (1 row) */}
          <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
            <Box gap={1} overflow="hidden">
              {crunch?.examDate ? (
                <Badge
                  label={
                    typeof crunch.daysLeft === 'number'
                      ? crunch.daysLeft >= 0
                        ? `${t(lang, '距考', 'D-')}${crunch.daysLeft}${t(lang, '天', 'd')} (${crunch.examDate})`
                        : `${t(lang, '已过', 'Past')} (${crunch.examDate})`
                      : crunch.examDate
                  }
                  tone={typeof crunch.daysLeft === 'number' && crunch.daysLeft >= 0 && crunch.daysLeft <= 7 ? 'error' : 'warning'}
                  variant="soft"
                />
              ) : (
                <Badge label={t(lang, '未设考期', 'No Exam Date')} tone="neutral" variant="soft" />
              )}
              {crunch?.plan?.capacity ? (
                <Text color={theme.muted} wrap="truncate-end">
                  {t(lang, `日均 ${crunch.plan.capacity}m`, `${crunch.plan.capacity}m/day`)}
                  {totalPoints > 0 ? ` · ${t(lang, `已打卡 ${doneCount}/${totalPoints}`, `Done ${doneCount}/${totalPoints}`)}` : ''}
                </Text>
              ) : null}
            </Box>
            <Box flexShrink={0}>
              {busy ? <Spinner label={t(lang, '同步中…', 'Syncing…')} active={isActive} /> : null}
            </Box>
          </Box>

          <Divider width={innerW} />

          {/* Schedule list or empty state */}
          <Box height={listH} flexDirection="column" overflow="hidden" flexShrink={0}>
            {crunch?.status === 'ok' && scheduleRows.length > 0 ? (
              <VirtualList
                items={scheduleRows}
                width={innerW}
                height={listH}
                selectedIndex={selectedIndex}
                onChange={setSelectedIndex}
                isActive={isActive && !loading && !busy}
                keyExtractor={(row) => row.key}
                renderItem={renderScheduleRow}
              />
            ) : (
              renderEmptySchedule()
            )}
          </Box>

          <Divider width={innerW} />

          {/* Mock Paper Bar (2 rows) */}
          <Box height={2} flexDirection="column" overflow="hidden" flexShrink={0}>
            {mockPlan ? (
              <>
                <Text color={theme.text} wrap="truncate-end">
                  <Text color={theme.accent} bold>
                    {t(lang, '全书模拟卷: ', 'Book Mock: ')}
                  </Text>
                  <Text bold>{mockPlan.eligible}</Text>
                  <Text color={theme.muted}>
                    {t(
                      lang,
                      ` 道可选选择题 / 共 ${mockPlan.questions} 题（本次组卷 ${mockPlan.count} 题${mockPlan.limitMinutes ? ` · ${mockPlan.limitMinutes} 分钟` : ''}）`,
                      ` eligible choice / ${mockPlan.questions} total (${mockPlan.count} in paper${mockPlan.limitMinutes ? ` · ${mockPlan.limitMinutes}m` : ''})`,
                    )}
                  </Text>
                </Text>
                <Text color={mockPlan.eligible > 0 ? theme.accent : theme.muted} wrap="truncate-end">
                  {mockPlan.eligible > 0
                    ? `${t(lang, '[m] 立即开始限时模拟考', '[m] Start timed mock exam')}${mockLeftOut ? `  ${mockLeftOut}` : ''}`
                    : t(lang, '当前重点节暂无单/多选题（模拟考仅支持单选与多选）', 'No single/multiple choice questions eligible for mock')}
                </Text>
              </>
            ) : (
              <>
                <Text color={theme.muted} wrap="truncate-end">
                  {t(lang, '全书模拟卷: 需先生成包含题目的复习全书', 'Book Mock: requires a review book with linked questions')}
                </Text>
                <Text color={theme.dim} wrap="truncate-end">
                  {t(lang, '按 [Esc] 返回复习全书后按 [g] 构建', 'Press [Esc] and [g] in Book view to build')}
                </Text>
              </>
            )}
          </Box>
        </Box>
      )}
    </Modal>
  );
});
