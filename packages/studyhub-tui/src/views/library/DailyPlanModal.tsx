import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, ProgressBar, Spinner, StatusPill } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { tryAction } from '../../host/sample-actions.js';

export interface DailyPlanStudyRef {
  root?: string;
  kind?: string;
  id?: string;
  sessionId?: string;
  deckId?: string;
  course?: string;
  [k: string]: unknown;
}

export interface DailyPlanProposalItem {
  candidateId?: string;
  taskId?: string;
  title: string;
  reason?: string;
  minutes: number;
  kind: string;
  studyRef?: DailyPlanStudyRef;
  scope?: Array<{ deckId: string; cardId?: string }>;
  progress?: { done: number; total: number };
  examDate?: string;
}

export interface DailyPlanProposal {
  id: string;
  items: DailyPlanProposalItem[];
  summary?: string;
  method?: string;
  warnings?: string[];
  emptyReason?: string;
  failure?: { kind?: string; message?: string };
  createdAt?: string;
}

export interface DailyPlanTask {
  id: string;
  title: string;
  reason?: string;
  minutes: number;
  kind: string;
  studyRef?: DailyPlanStudyRef;
  progress?: { done: number; total: number };
  status: string;
  available?: boolean;
  archived?: boolean;
  runId?: string;
  actualMinutes?: number;
}

export interface DailyPlanState {
  date: string;
  budgetMinutes: number;
  spentMinutes: number;
  budgetBasis?: string;
  profile?: {
    weekdayMinutes?: number;
    weekendMinutes?: number;
    source?: string;
  };
  proposal: DailyPlanProposal | null;
  tasks: DailyPlanTask[];
  accepted: boolean;
  warnings?: string[];
}

interface DailyPlanStartResult {
  run?: { id?: string; deckId?: string; [k: string]: unknown };
  runId?: string;
  studyRef?: DailyPlanStudyRef;
  task?: DailyPlanTask;
}

export interface DailyPlanModalProps {
  host: HostClient;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: () => void;
}

type PlanViewTab = 'tasks' | 'proposal';

function localTodayDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function kindTag(kind: string | undefined, lang: 'zh' | 'en'): string {
  switch (kind) {
    case 'practice':
      return t(lang, '练习', 'Practice');
    case 'reading':
      return t(lang, '阅读', 'Reading');
    case 'workflow':
      return t(lang, '流程', 'Flow');
    default:
      return kind || t(lang, '任务', 'Task');
  }
}

function taskStatusGlyph(task: DailyPlanTask, asciiMode: boolean): { glyph: string; tone: 'success' | 'accent' | 'warning' | 'muted' } {
  if (task.available === false) return { glyph: asciiMode ? '!' : '▲', tone: 'warning' };
  if (task.status === 'done') return { glyph: asciiMode ? '+' : '✔', tone: 'success' };
  if (task.status === 'doing') return { glyph: asciiMode ? '>' : '▶', tone: 'accent' };
  return { glyph: asciiMode ? 'o' : '○', tone: 'muted' };
}

export const DailyPlanModal = memo(function DailyPlanModal({
  host,
  isActive,
  width,
  height,
  onClose,
  onUpdated,
}: DailyPlanModalProps) {
  const theme = useTheme();
  const actions = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const activeCourse = currentCourse(snapshot);
  const modelReady = Boolean(snapshot?.modelReady);
  const [date] = useState<string>(() => localTodayDate());

  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<DailyPlanState | null>(null);
  const [tab, setTab] = useState<PlanViewTab>('tasks');
  const [taskIndex, setTaskIndex] = useState(0);
  const [proposalIndex, setProposalIndex] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await tryAction<DailyPlanState>(host, 'daily.plan.get', {
      date,
      ...(activeCourse ? { course: activeCourse } : {}),
    });
    if (!mountedRef.current) return;
    if (res.ok && res.value) {
      setPlan(res.value);
      if (res.value.proposal && (!res.value.tasks || res.value.tasks.length === 0)) {
        setTab('proposal');
      } else if (res.value.tasks?.length) {
        setTab('tasks');
      }
    } else {
      setError(res.error?.message || t(lang, '读取今日计划失败', 'Failed to load daily plan'));
    }
    setLoading(false);
  }, [host, date, activeCourse, lang]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      const res = await tryAction<DailyPlanState>(host, 'daily.plan.get', {
        date,
        ...(activeCourse ? { course: activeCourse } : {}),
      });
      if (!alive) return;
      if (res.ok && res.value) {
        setPlan(res.value);
        if (res.value.proposal && (!res.value.tasks || res.value.tasks.length === 0)) {
          setTab('proposal');
        } else {
          setTab('tasks');
        }
      } else {
        setError(res.error?.message || t(lang, '读取今日计划失败', 'Failed to load daily plan'));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [host, date, activeCourse, lang]);

  const tasks = useMemo(() => plan?.tasks ?? [], [plan?.tasks]);
  const proposal = plan?.proposal ?? null;
  const proposalItems = useMemo(() => proposal?.items ?? [], [proposal?.items]);

  useEffect(() => {
    if (taskIndex >= tasks.length) setTaskIndex(Math.max(0, tasks.length - 1));
  }, [tasks.length, taskIndex]);

  useEffect(() => {
    if (proposalIndex >= proposalItems.length) setProposalIndex(Math.max(0, proposalItems.length - 1));
  }, [proposalItems.length, proposalIndex]);

  const showingProposal = Boolean(proposal && (tab === 'proposal' || tasks.length === 0));
  const selectedTask = tasks[taskIndex] ?? null;
  const selectedProposalItem = proposalItems[proposalIndex] ?? null;

  const handleSuggest = useCallback(async () => {
    if (busyAction || loading) return;
    setBusyAction('suggest');
    setError('');
    const args: Record<string, unknown> = {
      date,
      ...(!modelReady ? { local: true } : {}),
      ...(proposal?.id ? { proposalId: proposal.id } : {}),
      ...(activeCourse ? { course: activeCourse } : {}),
    };
    const res = await tryAction<DailyPlanState>(host, 'daily.plan.suggest', args);
    if (!mountedRef.current) return;
    setBusyAction('');
    if (!res.ok || !res.value) {
      const msg = res.error?.message || t(lang, '生成学习计划失败', 'Failed to generate plan');
      setError(msg);
      notify(msg, 'error');
      return;
    }
    setPlan(res.value);
    setProposalIndex(0);
    setTab('proposal');
    if (res.value.proposal?.failure?.message) {
      notify(
        t(lang, 'AI 暂不可用，已生成本地建议', 'AI unavailable; generated local suggestion'),
        'warning',
      );
    } else if (res.value.proposal?.items?.length) {
      notify(
        res.value.proposal.method === 'ai'
          ? t(lang, `AI 已生成 ${res.value.proposal.items.length} 项建议，按 [a] 接受`, `AI suggested ${res.value.proposal.items.length} blocks; press [a] to accept`)
          : t(lang, `已生成 ${res.value.proposal.items.length} 项本地建议，按 [a] 接受`, `Generated ${res.value.proposal.items.length} local blocks; press [a] to accept`),
        'success',
      );
    } else {
      notify(t(lang, '当前没有可安排的新建议', 'No new blocks to suggest right now'), 'info');
    }
  }, [busyAction, loading, date, modelReady, proposal?.id, activeCourse, host, lang, notify]);

  const handleAccept = useCallback(async () => {
    if (busyAction || loading || !proposal?.id) return;
    setBusyAction('accept');
    setError('');
    const res = await tryAction<DailyPlanState>(host, 'daily.plan.accept', {
      date,
      proposalId: proposal.id,
    });
    if (!mountedRef.current) return;
    setBusyAction('');
    if (!res.ok || !res.value) {
      const msg = res.error?.message || t(lang, '接受计划失败', 'Failed to accept plan');
      setError(msg);
      notify(msg, 'error');
      return;
    }
    setPlan(res.value);
    setTab('tasks');
    setTaskIndex(0);
    onUpdated?.();
    void actions.refresh();
    notify(t(lang, '已将建议加入今日待办', 'Added suggested blocks to today plan'), 'success');
  }, [busyAction, loading, proposal?.id, date, host, lang, notify, onUpdated, actions]);

  const handleStartTask = useCallback(
    async (task: DailyPlanTask) => {
      if (busyAction || loading) return;
      if (task.available === false) {
        notify(t(lang, '该任务对应内容已归档或不可用', 'This block content is unavailable'), 'warning');
        return;
      }
      if (task.status === 'done') {
        notify(t(lang, '该任务已完成', 'This block is already complete'), 'info');
        return;
      }
      setBusyAction('start');
      setError('');
      const res = await tryAction<DailyPlanStartResult>(host, 'daily.plan.start', {
        date,
        taskId: task.id,
      });
      if (!mountedRef.current) return;
      setBusyAction('');
      if (!res.ok || !res.value) {
        const msg = res.error?.message || t(lang, '启动任务失败', 'Failed to start block');
        setError(msg);
        notify(msg, 'error');
        return;
      }
      const result = res.value;
      const runId = result.run?.id || result.runId || result.task?.runId || task.runId;
      const ref = result.studyRef || task.studyRef;
      const resultScope = (result as { scope?: Array<{ deckId?: string }> }).scope;
      const fallbackDeckId =
        (typeof ref?.deckId === 'string' && ref.deckId) ||
        (ref?.kind === 'deck' && typeof ref.id === 'string' && ref.id) ||
        resultScope?.[0]?.deckId;
      if (runId) {
        onClose();
        navigate('review', {
          runId,
          ...(fallbackDeckId ? { deckId: fallbackDeckId } : {}),
        });
        return;
      }
      if (fallbackDeckId) {
        onClose();
        navigate('review', { deckId: fallbackDeckId });
        return;
      }
      if (ref?.kind === 'source' && ref.id) {
        onClose();
        navigate('sources', { sourceId: String(ref.id) });
        return;
      }
      if (result.task) {
        setPlan((prev) =>
          prev
            ? { ...prev, tasks: prev.tasks.map((item) => (item.id === result.task!.id ? result.task! : item)) }
            : prev,
        );
      }
      notify(t(lang, `已开始：${task.title}`, `Started: ${task.title}`), 'success');
    },
    [busyAction, loading, date, host, lang, notify, onClose, navigate],
  );

  const handleCompleteTask = useCallback(
    async (task: DailyPlanTask) => {
      if (busyAction || loading) return;
      if (task.status === 'done') {
        notify(t(lang, '该任务已标记完成', 'Already marked complete'), 'info');
        return;
      }
      setBusyAction('complete');
      setError('');
      const res = await tryAction<DailyPlanState>(host, 'daily.plan.complete', {
        date,
        taskId: task.id,
      });
      if (!mountedRef.current) return;
      setBusyAction('');
      if (!res.ok || !res.value) {
        const msg = res.error?.message || t(lang, '无法标记完成', 'Could not mark complete');
        notify(msg, 'warning');
        return;
      }
      setPlan(res.value);
      onUpdated?.();
      void actions.refresh();
      notify(t(lang, `已完成「${task.title}」`, `Completed "${task.title}"`), 'success');
    },
    [busyAction, loading, date, host, lang, notify, onUpdated, actions],
  );

  useInput(
    (input, key) => {
      if (loading || busyAction) return;
      if (key.tab && proposal && tasks.length > 0) {
        setTab((prev) => (prev === 'tasks' ? 'proposal' : 'tasks'));
        return;
      }
      if (input === 'g') {
        void handleSuggest();
        return;
      }
      if (input === 'a' && proposal && proposalItems.length > 0) {
        void handleAccept();
        return;
      }
      if (input === 'r') {
        void loadPlan();
        return;
      }
      if (showingProposal) {
        if (key.return && selectedProposalItem) {
          notify(
            t(lang, '请先按 [a] 接受建议加入待办，再按 [Enter] 开始', 'Press [a] to accept proposal first, then [Enter] to start'),
            'info',
          );
        }
        return;
      }
      if (input === 'x' && selectedTask) {
        void handleCompleteTask(selectedTask);
        return;
      }
      if (key.return && selectedTask) {
        void handleStartTask(selectedTask);
      }
    },
    { isActive: isActive && !loading && !busyAction },
  );

  const frameW = Math.max(46, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);

  const spent = Math.max(0, plan?.spentMinutes ?? 0);
  const budget = Math.max(0, plan?.budgetMinutes ?? 0);
  const doneCount = tasks.filter((item) => item.status === 'done').length;

  const warnings = useMemo(() => {
    const list = [...(plan?.warnings ?? []), ...(proposal?.warnings ?? [])];
    return [...new Set(list.filter(Boolean))];
  }, [plan?.warnings, proposal?.warnings]);

  const hasBanner = showingProposal || warnings.length > 0;
  const overheadRows = 2 + 1 + (hasBanner ? 1 : 0) + 3;
  const listH = Math.max(3, bodyH - overheadRows);

  const hints = useMemo<KeyHint[]>(() => {
    const list: KeyHint[] = [{ key: 'g', label: t(lang, '生成建议', 'Suggest') }];
    if (proposal && proposalItems.length > 0) {
      list.push({ key: 'a', label: t(lang, '接受计划', 'Accept') });
    }
    if (!showingProposal && tasks.length > 0) {
      list.push({ key: 'Enter', label: t(lang, '开始', 'Start') });
      list.push({ key: 'x', label: t(lang, '完成', 'Complete') });
    }
    if (proposal && tasks.length > 0) {
      list.push({ key: 'Tab', label: t(lang, '切换视图', 'Switch') });
    }
    list.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return list;
  }, [lang, proposal, proposalItems.length, showingProposal, tasks.length]);

  const renderTaskRow = useCallback(
    (task: DailyPlanTask, ctx: VirtualListRenderContext) => {
      const st = taskStatusGlyph(task, asciiMode);
      const tag = `[${kindTag(task.kind, lang)}]`;
      const prog = task.progress && task.progress.total > 0 ? ` ${task.progress.done}/${task.progress.total}` : '';
      const mins = ` ${task.actualMinutes ?? task.minutes}m`;
      const meta = `${prog}${mins}`;
      const prefixW = 2 + displayWidth(tag) + 1;
      const titleBudget = Math.max(6, ctx.width - prefixW - displayWidth(meta));
      const title = padDisplay(truncateDisplay(task.title, titleBudget), titleBudget);
      const fg = ctx.selected ? theme.selectionFg : task.status === 'done' ? theme.dim : theme.text;
      const glyphColor = ctx.selected
        ? theme.selectionFg
        : st.tone === 'success'
          ? theme.success
          : st.tone === 'accent'
            ? theme.accent
            : st.tone === 'warning'
              ? theme.warning
              : theme.muted;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={glyphColor}>{st.glyph} </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{tag} </Text>
          {title}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{meta}</Text>
        </Text>
      );
    },
    [asciiMode, lang, theme],
  );

  const renderProposalRow = useCallback(
    (item: DailyPlanProposalItem, ctx: VirtualListRenderContext) => {
      const num = `${ctx.index + 1}.`;
      const tag = `[${kindTag(item.kind, lang)}]`;
      const mins = ` ~${item.minutes}m`;
      const prog = item.progress && item.progress.total > 0 ? ` (${item.progress.done}/${item.progress.total})` : '';
      const meta = `${prog}${mins}`;
      const prefixW = displayWidth(num) + 1 + displayWidth(tag) + 1;
      const titleBudget = Math.max(6, ctx.width - prefixW - displayWidth(meta));
      const title = padDisplay(truncateDisplay(item.title, titleBudget), titleBudget);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{num} </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.ai}>{tag} </Text>
          {title}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{meta}</Text>
        </Text>
      );
    },
    [lang, theme],
  );

  const subtitle = plan
    ? `${date}${tasks.length ? ` · ${doneCount}/${tasks.length} ${t(lang, '已完成', 'done')}` : ''}`
    : date;

  return (
    <Modal
      title={t(lang, '今日学习计划', "Today's Study Plan")}
      icon={asciiMode ? '*' : '◷'}
      tone="primary"
      subtitle={subtitle}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive}
      hints={hints}
    >
      {/* Top Status & Budget Meter */}
      <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" gap={1} height={1} overflow="hidden">
          <Badge label={activeCourse ?? t(lang, '全部课程', 'All Courses')} tone="accent" variant="soft" />
          <StatusPill
            label={
              modelReady
                ? t(lang, 'AI 模型就绪', 'Model Ready')
                : t(lang, '本地规划模式', 'Local Mode')
            }
            status={modelReady ? 'ok' : 'warn'}
          />
          {busyAction ? (
            <Spinner
              label={
                busyAction === 'suggest'
                  ? t(lang, '正在生成计划…', 'Generating plan…')
                  : busyAction === 'accept'
                    ? t(lang, '正在写入待办…', 'Accepting…')
                    : t(lang, '处理中…', 'Working…')
              }
              active={isActive}
            />
          ) : null}
        </Box>
        <Box height={1} overflow="hidden">
          <ProgressBar
            ratio={budget > 0 ? Math.min(1, spent / budget) : 0}
            width={Math.min(innerW, 56)}
            style="block"
            label={t(lang, `预算 ${spent}/${budget}m`, `Time ${spent}/${budget}m`)}
          />
        </Box>
      </Box>

      <Divider width={innerW} />

      {/* Main Content */}
      {loading ? (
        <Box height={Math.max(4, bodyH - 3)} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在读取今日学习安排…', 'Loading daily plan…')} active={isActive} />
        </Box>
      ) : error && !plan ? (
        <Box height={Math.max(4, bodyH - 3)} flexDirection="column" paddingY={1}>
          <Text color={theme.error} bold>{error}</Text>
          <Text color={theme.muted}>{t(lang, '按 [r] 重试，或按 [g] 重新生成计划', 'Press [r] to retry or [g] to suggest')}</Text>
        </Box>
      ) : showingProposal && proposal ? (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Box height={1} overflow="hidden" flexDirection="row" gap={1}>
            <Badge
              label={proposal.method === 'ai' ? t(lang, 'AI 建议', 'AI Proposal') : t(lang, '本地建议', 'Local Proposal')}
              tone={proposal.method === 'ai' ? 'ai' : 'info'}
              variant="solid"
            />
            <Text color={theme.muted} wrap="truncate-end">
              {proposalItems.length > 0
                ? t(lang, `${proposalItems.length} 项待确认 · 按 [a] 加入待办`, `${proposalItems.length} blocks · press [a] to accept`)
                : t(lang, '暂无可安排的行动', 'No blocks proposed')}
            </Text>
          </Box>

          {proposalItems.length === 0 ? (
            <EmptyState
              title={
                proposal.emptyReason === 'budget'
                  ? t(lang, '今日时间预算已满', 'Daily budget reached')
                  : proposal.emptyReason === 'nothing-due'
                    ? t(lang, '暂无到期复习或待学资料', 'Nothing due or pending')
                    : t(lang, '该建议未包含新行动', 'No new blocks in this proposal')
              }
              hint={
                proposal.failure?.message
                  ? proposal.failure.message
                  : warnings[0]
                    ? warnings[0]
                    : t(lang, '按 [g] 重新生成，或先导入/复习题组', 'Press [g] to retry or review decks in Library')
              }
              width={innerW}
              height={Math.max(4, listH + 2)}
            />
          ) : (
            <>
              <VirtualList
                items={proposalItems}
                height={listH}
                width={innerW}
                selectedIndex={proposalIndex}
                onChange={(idx) => setProposalIndex(idx)}
                isActive={isActive && !busyAction}
                keyExtractor={(item, idx) => item.candidateId || `${item.title}:${idx}`}
                renderItem={renderProposalRow}
              />
              <Divider width={innerW} />
              <Box height={2} width={innerW} flexDirection="column" overflow="hidden">
                <Text color={theme.text} wrap="truncate-end">
                  {selectedProposalItem?.reason || proposal.summary || t(lang, '按 [a] 接受建议并加入今日待办', 'Press [a] to accept into today plan')}
                </Text>
                <Text color={proposal.failure?.message ? theme.warning : theme.muted} wrap="wrap">
                  {proposal.failure?.message
                    ? proposal.failure.message
                    : warnings[0]
                      ? warnings[0]
                      : t(lang, '[a] 接受建议   [g] 重新生成   [Esc] 关闭', '[a] Accept   [g] Regenerate   [Esc] Close')}
                </Text>
              </Box>
            </>
          )}
        </Box>
      ) : tasks.length === 0 ? (
        <EmptyState
          title={t(lang, '今日尚未制定学习计划', 'No study plan for today yet')}
          hint={
            modelReady
              ? t(lang, '按 [g] 让 AI/本地为你规划今日学习块', 'Press [g] to generate today study blocks')
              : t(lang, '模型未配置，按 [g] 生成本地时间预算计划', 'No model configured; press [g] for a local plan')
          }
          width={innerW}
          height={Math.max(4, bodyH - 3)}
        />
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {warnings.length > 0 ? (
            <Box height={1} overflow="hidden">
              <Text color={theme.warning} wrap="truncate-end">{warnings[0]}</Text>
            </Box>
          ) : null}
          <VirtualList
            items={tasks}
            height={listH}
            width={innerW}
            selectedIndex={taskIndex}
            onChange={(idx) => setTaskIndex(idx)}
            onSelect={(task) => {
              void handleStartTask(task);
            }}
            isActive={isActive && !busyAction}
            keyExtractor={(item) => item.id}
            renderItem={renderTaskRow}
          />
          <Divider width={innerW} />
          <Box height={2} width={innerW} flexDirection="column" overflow="hidden">
            {selectedTask ? (
              <>
                <Text color={theme.text} wrap="truncate-end">
                  {selectedTask.reason || selectedTask.title}
                </Text>
                <Text color={theme.muted} wrap="truncate-end">
                  {t(lang, '类型', 'Type')}: {kindTag(selectedTask.kind, lang)}
                  {' · '}
                  {t(lang, '目标', 'Target')}: {selectedTask.minutes}{t(lang, '分钟', 'm')}
                  {selectedTask.progress && selectedTask.progress.total > 0
                    ? ` · ${t(lang, '进度', 'Progress')}: ${selectedTask.progress.done}/${selectedTask.progress.total}`
                    : ''}
                  {selectedTask.status === 'done'
                    ? ` · ${t(lang, '已完成', 'Done')}`
                    : selectedTask.status === 'doing'
                      ? ` · ${t(lang, '进行中', 'In progress')}`
                      : ''}
                </Text>
              </>
            ) : (
              <Text color={theme.muted}>{t(lang, '选择学习块后按 [Enter] 开始', 'Select a block and press [Enter] to start')}</Text>
            )}
          </Box>
        </Box>
      )}
    </Modal>
  );
});
