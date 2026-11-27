import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box } from 'ink';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { SplitPane } from '../../components/SplitPane.js';
import { useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { useShellActions } from '../../shell/actions.js';
import { buildTaskProgressTitle, writeTerminalNotification, writeTerminalTitle } from '../../render/terminal-title.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../../host/atomic-write.js';
import { tryAction } from '../../host/sample-actions.js';
import { JobMessageModal } from './JobMessageModal.js';
import { JobOutputModal } from './JobOutputModal.js';
import { TasksDetailPanel, TasksHeaderBar, TasksListPanel } from './TasksPanels.js';
import {
  ACTIVE_STATUSES,
  capLines,
  computeQueueStatus,
  computeTasksHints,
  exportJobTraceToFile,
  formatTasksMarkdown,
  formatTraceCallLines,
  jobMatchesFilter,
  mergeNormalizedJobs,
  type ControlOverride,
  type FilterTab,
  type FormatTasksMarkdownParams,
  type JobRecord,
  type TaskMarkdownItem,
  type TraceCallEntry,
} from './tasks-model.js';
import { useTasksActions } from './useTasksActions.js';

export { exportJobTraceToFile, formatTasksMarkdown };
export type { FormatTasksMarkdownParams, TaskMarkdownItem };

const CLAIMED_KEYS = [
  '1',
  '2',
  '3',
  'o',
  'm',
  'w',
  'x',
  'X',
  'a',
  'd',
  'v',
  'e',
  'D',
  'p',
  'P',
  'R',
  '+',
  '-',
  '=',
  '/',
] as const;

const WorkflowHistoryModal = lazy(() =>
  import('./WorkflowHistoryModal.js').then((m) => ({ default: m.WorkflowHistoryModal })),
);

export const TasksView: React.FC<ViewProps> = memo(function TasksView({
  host,
  width,
  height,
  isActive,
}) {
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navContext = useTuiStore((s) => s.navContext);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [liveJobs, setLiveJobs] = useState<Array<Record<string, unknown>> | null>(null);
  const [controlOverrides, setControlOverrides] = useState<Record<string, ControlOverride>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailMode, setDetailMode] = useState<'output' | 'trace'>('output');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmPurgeTraceOpen, setConfirmPurgeTraceOpen] = useState(false);
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
  const [traceReloadTick, setTraceReloadTick] = useState(0);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [traceLines, setTraceLines] = useState<string[]>([]);

  const exportBusyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Round 87 Track C4: emit OSC 9 terminal notification when a previously active background job completes
  const prevActiveJobsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const jobs = snapshot?.jobs ?? [];
    const nextActive = new Map<string, string>();
    for (const j of jobs) {
      const st = String(j.status ?? '').toLowerCase();
      const title = String(j.title ?? j.type ?? j.id);
      if (ACTIVE_STATUSES.has(st)) {
        nextActive.set(j.id, title);
      } else if (
        (st === 'complete' || st === 'completed' || st === 'done' || st === 'ok') &&
        prevActiveJobsRef.current.has(j.id)
      ) {
        writeTerminalNotification(
          t(lang, `StudyHub 后台任务完成：${title}`, `StudyHub task completed: ${title}`),
          { asciiMode },
        );
      }
    }
    prevActiveJobsRef.current = nextActive;
  }, [snapshot?.jobs, lang, asciiMode]);

  const allNormalized = useMemo(
    () =>
      mergeNormalizedJobs(
        snapshot?.jobs as Array<Record<string, unknown>> | undefined,
        snapshot?.archivedJobs as Array<Record<string, unknown>> | undefined,
        liveJobs,
        controlOverrides,
      ),
    [snapshot?.jobs, snapshot?.archivedJobs, liveJobs, controlOverrides],
  );

  const hasActiveJobs = useMemo(
    () => allNormalized.activeAndRecent.some((j) => ACTIVE_STATUSES.has(j.status)),
    [allNormalized.activeAndRecent],
  );

  // Poll `job.live.list` while active jobs exist and view is active (clean disposal).
  useEffect(() => {
    if (!isActive || !hasActiveJobs) return undefined;
    let cancelled = false;
    const poll = async () => {
      const res = await tryAction<{ jobs?: Array<Record<string, unknown>> }>(host, 'job.live.list', {});
      if (!cancelled && res.ok && Array.isArray(res.value?.jobs)) {
        setLiveJobs(res.value.jobs);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [host, isActive, hasActiveJobs]);

  const tabJobs = useMemo(() => {
    if (filterTab === 'running') {
      return allNormalized.activeAndRecent.filter((j) => ACTIVE_STATUSES.has(j.status));
    }
    if (filterTab === 'archived') {
      return allNormalized.archived;
    }
    return [...allNormalized.activeAndRecent, ...allNormalized.archived];
  }, [allNormalized, filterTab]);

  const filteredJobs = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return tabJobs;
    return tabJobs.filter((j) => jobMatchesFilter(j, q));
  }, [tabJobs, filterQuery]);

  // Select incoming navContext.jobId if provided
  useEffect(() => {
    if (!navContext.jobId) return;
    const idx = filteredJobs.findIndex((j) => j.id === navContext.jobId);
    if (idx >= 0) setSelectedIndex(idx);
  }, [navContext.jobId, filteredJobs]);

  useEffect(() => {
    if (selectedIndex >= filteredJobs.length) {
      setSelectedIndex(Math.max(0, filteredJobs.length - 1));
    }
  }, [filteredJobs.length, selectedIndex]);

  const selectedJob = filteredJobs[selectedIndex];
  const selectedJobRef = useRef<JobRecord | undefined>(selectedJob);
  selectedJobRef.current = selectedJob;
  const selectedJobId = selectedJob?.id;
  const selectedJobStatus = selectedJob?.status;
  const selectedJobCallsLen = selectedJob?.calls.length ?? 0;

  // Fetch `job.output` and `job.trace` for selected job (capped at MAX_LOG_LINES).
  useEffect(() => {
    const job = selectedJobRef.current;
    if (!isActive || !job || !selectedJobId) {
      setOutputLines([]);
      setTraceLines([]);
      return;
    }
    let cancelled = false;
    const latestCall = [...job.calls].reverse().find((c) => c.status === 'running') ?? job.calls.at(-1);

    const loadDetails = async () => {
      if (latestCall?.id) {
        const outRes = await tryAction<{ text?: string; supported?: boolean }>(host, 'job.output', {
          jobId: selectedJobId,
          callId: latestCall.id,
          cursor: 0,
        });
        if (!cancelled && outRes.ok && outRes.value) {
          const txt = String(outRes.value.text || '');
          setOutputLines(txt ? capLines(txt) : []);
        }
      } else if (!cancelled) {
        setOutputLines([]);
      }

      const traceRes = await tryAction<{ calls?: TraceCallEntry[]; unavailableReason?: string }>(host, 'job.trace', {
        jobId: selectedJobId,
      });
      if (!cancelled && traceRes.ok && traceRes.value) {
        setTraceLines(
          formatTraceCallLines(traceRes.value.calls ?? [], traceRes.value.unavailableReason, asciiMode),
        );
      }
    };

    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [asciiMode, host, isActive, selectedJobId, selectedJobStatus, selectedJobCallsLen, traceReloadTick]);

  const {
    handleCancel,
    handleArchive,
    handleDeleteConfirm,
    handleExportTrace,
    handlePurgeTraceConfirm,
    handleTogglePause,
    handleStartParallel,
    handleAdjustConcurrency,
    handleRecoverInterrupted,
  } = useTasksActions({
    host,
    lang,
    snapshotRoot: snapshot?.root,
    selectedJob,
    notify,
    refresh,
    mountedRef,
    setLiveJobs,
    setControlOverrides,
    setConfirmDeleteOpen,
    setConfirmPurgeTraceOpen,
    setTraceReloadTick,
  });

  const handleExportTasksMarkdown = useCallback(async () => {
    if (exportBusyRef.current) return;
    if (filteredJobs.length === 0) {
      notify(t(lang, '当前筛选下暂无可导出的任务记录', 'No jobs to export in current filter'), 'info');
      return;
    }
    exportBusyRef.current = true;
    try {
      const markdown = formatTasksMarkdown({
        jobs: filteredJobs,
        filterTab,
        filterQuery,
        lang,
        generatedAt: new Date(),
      });
      const exportLabel =
        [filterTab !== 'all' ? filterTab : '', filterQuery.trim()].filter(Boolean).join('-') || undefined;
      const defaultPath = defaultBackupFilePath(host.getLibraryRoot(), 'studyhub-tasks', '.md', exportLabel);
      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${filteredJobs.length} 条任务汇总 ${arrow} ${written.path}`,
          `Exported ${filteredJobs.length} job(s) summary ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出任务汇总失败: ${msg}`, `Failed to export jobs summary: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [asciiMode, filterQuery, filterTab, filteredJobs, host, lang, notify]);

  useInputCapture(isActive && filterEditing);

  const showParallelHint = Boolean(
    selectedJob &&
      !selectedJob.archived &&
      (selectedJob.parallelAvailable || selectedJob.status === 'queued' || selectedJob.status === 'pending'),
  );
  const hints = useMemo(() => computeTasksHints(lang, showParallelHint), [lang, showParallelHint]);
  useFooterHints(hints, isActive);

  const pageActive = useKeyScope({
    id: 'TasksView:main',
    active: isActive,
    keys: CLAIMED_KEYS,
    onKey: (input, key) => {
      if (key.escape && filterQuery) {
        setFilterQuery('');
        setSelectedIndex(0);
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setFilterEditing(true);
        return true;
      }
      if (input === 'X' && !key.ctrl && !key.meta) {
        void handleExportTasksMarkdown();
        return true;
      }
      if (key.tab) {
        setFilterTab((tCur) => (tCur === 'running' ? 'all' : tCur === 'all' ? 'archived' : 'running'));
        return true;
      }
      if (input === '1') {
        setFilterTab('running');
        return true;
      }
      if (input === '2') {
        setFilterTab('all');
        return true;
      }
      if (input === '3') {
        setFilterTab('archived');
        return true;
      }
      if (input === 'p') {
        void handleTogglePause();
        return true;
      }
      if (input === 'P') {
        void handleStartParallel();
        return true;
      }
      if (input === 'R') {
        void handleRecoverInterrupted();
        return true;
      }
      if (input === '+' || input === '=') {
        void handleAdjustConcurrency(1);
        return true;
      }
      if (input === '-') {
        void handleAdjustConcurrency(-1);
        return true;
      }
      if (input === 'o') {
        if (!selectedJob) notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        else setOutputModalOpen(true);
        return true;
      }
      if (input === 'm') {
        if (!selectedJob) notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        else if (!ACTIVE_STATUSES.has(selectedJob.status)) {
          notify(t(lang, '仅运行中的任务可发送补充说明', 'Only active jobs accept refinement messages'), 'info');
        } else {
          setMessageModalOpen(true);
        }
        return true;
      }
      if (input === 'w') {
        setWorkflowModalOpen(true);
        return true;
      }
      if (input === 'v') {
        setDetailMode((m) => (m === 'output' ? 'trace' : 'output'));
        return true;
      }
      if (input === 'e') {
        if (!selectedJob) notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        else void handleExportTrace();
        return true;
      }
      if (input === 'D') {
        if (!selectedJob) notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        else setConfirmPurgeTraceOpen(true);
        return true;
      }
      if (input === 'x') {
        void handleCancel();
        return true;
      }
      if (input === 'a') {
        void handleArchive();
        return true;
      }
      if (input === 'd' && selectedJob) {
        setConfirmDeleteOpen(true);
        return true;
      }
      return false;
    },
  });

  const topBarH = 2;
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const splitH = Math.max(4, height - topBarH - filterBarH);

  const runningCount = allNormalized.activeAndRecent.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const allCount = allNormalized.activeAndRecent.length + allNormalized.archived.length;
  const archivedCount = allNormalized.archived.length;

  const controlTarget = useMemo(
    () =>
      selectedJob ??
      allNormalized.activeAndRecent.find((j) => ACTIVE_STATUSES.has(j.status)) ??
      allNormalized.activeAndRecent[0] ??
      null,
    [allNormalized.activeAndRecent, selectedJob],
  );

  const queueStatus = computeQueueStatus(controlTarget, lang);
  const activeLogLines =
    detailMode === 'output'
      ? outputLines.length > 0
        ? outputLines
        : [t(lang, '（暂无实时输出文本；按 [v] 查看调用轨迹）', '(No live output text yet; press [v] for trace)')]
      : traceLines.length > 0
        ? traceLines
        : [t(lang, '（暂无调用轨迹）', '(No trace calls available)')];

  // Round 97 Track A15: Live OSC 2 window title when jobs are running (restored on idle/unmount)
  useEffect(() => {
    if (!isActive) return undefined;
    if (runningCount > 0) {
      writeTerminalTitle(
        buildTaskProgressTitle({ runningCount, label: controlTarget?.title, lang }),
        { asciiMode },
      );
    } else {
      writeTerminalTitle('StudyHub', { asciiMode });
    }
    return undefined;
  }, [isActive, runningCount, controlTarget?.title, lang, asciiMode]);

  useEffect(() => {
    return () => {
      writeTerminalTitle('StudyHub', { asciiMode });
    };
  }, [asciiMode]);

  const handleActivateJob = useCallback(
    (job: JobRecord) => {
      if (job.draftId) {
        navigate('generate', { draftId: job.draftId });
      } else {
        notify(t(lang, '该任务暂无关联草稿', 'No draft linked to this job'), 'info');
      }
    },
    [lang, navigate, notify],
  );

  const handleFilterChange = useCallback((val: string) => {
    setFilterQuery(val);
    setSelectedIndex(0);
  }, []);

  const handleFilterSubmit = useCallback((val: string) => {
    if (!val.trim()) setFilterQuery('');
    setFilterEditing(false);
  }, []);

  const handleFilterCancel = useCallback(() => {
    setFilterQuery('');
    setFilterEditing(false);
    setSelectedIndex(0);
  }, []);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <TasksHeaderBar
        width={width}
        topBarH={topBarH}
        lang={lang}
        asciiMode={asciiMode}
        isActive={isActive}
        filterTab={filterTab}
        runningCount={runningCount}
        allCount={allCount}
        archivedCount={archivedCount}
        hasActiveJobs={hasActiveJobs}
        controlTarget={controlTarget}
        queuePillLabel={queueStatus.label}
        queuePillStatus={queueStatus.status}
        showFilterBar={showFilterBar}
        filterEditing={filterEditing}
        filterQuery={filterQuery}
        filteredCount={filteredJobs.length}
        tabTotalCount={tabJobs.length}
        onFilterChange={handleFilterChange}
        onFilterSubmit={handleFilterSubmit}
        onFilterCancel={handleFilterCancel}
      />

      <Box height={splitH} width={width}>
        <SplitPane
          width={width}
          height={splitH}
          leftWidth={0.44}
          leftLabel={t(lang, '任务列表', 'Jobs')}
          rightLabel={t(lang, '日志与轨迹', 'Output & Trace')}
          left={({ width: lw, height: lh }) => (
            <TasksListPanel
              width={lw}
              height={lh}
              lang={lang}
              asciiMode={asciiMode}
              pageActive={pageActive}
              filterQuery={filterQuery}
              filteredJobs={filteredJobs}
              selectedIndex={selectedIndex}
              onSelectIndex={setSelectedIndex}
              onActivateJob={handleActivateJob}
            />
          )}
          right={({ width: rw, height: rh }) => (
            <TasksDetailPanel
              width={rw}
              height={rh}
              lang={lang}
              asciiMode={asciiMode}
              selectedJob={selectedJob}
              detailMode={detailMode}
              activeLogLines={activeLogLines}
              runningCount={runningCount}
              allCount={allCount}
              archivedCount={archivedCount}
            />
          )}
        />
      </Box>

      {confirmDeleteOpen && selectedJob ? (
        <KeyScope id="tasks:confirm-delete" opaque>
          <ConfirmDialog
            title={t(lang, '删除任务记录', 'Dismiss Job')}
            message={t(
              lang,
              `确认移除任务「${selectedJob.title}」的记录吗？（保留已生成的草稿）`,
              `Remove job record "${selectedJob.title}"? (Generated drafts are preserved.)`,
            )}
            confirmLabel={t(lang, '确认移除', 'Remove')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            danger
            isActive={isActive}
            onConfirm={() => void handleDeleteConfirm()}
            onCancel={() => setConfirmDeleteOpen(false)}
          />
        </KeyScope>
      ) : null}

      {confirmPurgeTraceOpen && selectedJob ? (
        <KeyScope id="tasks:confirm-purge-trace" opaque>
          <ConfirmDialog
            title={t(lang, '清空请求轨迹', 'Purge Request Traces')}
            message={t(
              lang,
              `确认清空任务「${selectedJob.title}」的缓存请求轨迹吗？（任务记录与草稿保持不变）`,
              `Purge saved request traces for "${selectedJob.title}"? (The job record itself stays intact.)`,
            )}
            confirmLabel={t(lang, '确认清空', 'Purge')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            danger
            isActive={isActive}
            onConfirm={() => void handlePurgeTraceConfirm()}
            onCancel={() => setConfirmPurgeTraceOpen(false)}
          />
        </KeyScope>
      ) : null}

      {outputModalOpen && selectedJob ? (
        <KeyScope id="tasks:output" opaque>
          <JobOutputModal
            host={host}
            job={selectedJob}
            isActive={isActive && outputModalOpen}
            onClose={() => setOutputModalOpen(false)}
            lang={lang}
            asciiMode={asciiMode}
          />
        </KeyScope>
      ) : null}

      {messageModalOpen && selectedJob ? (
        <KeyScope id="tasks:message" opaque>
          <JobMessageModal
            host={host}
            job={selectedJob}
            isActive={isActive && messageModalOpen}
            onClose={() => setMessageModalOpen(false)}
            onSent={(receipt) => {
              setMessageModalOpen(false);
              const receiptMsg =
                receipt.delivery === 'delivered'
                  ? t(lang, '补充说明已实时送达当前子任务', 'Refinement delivered to active workers')
                  : receipt.delivery === 'partial'
                    ? t(lang, '补充说明已部分送达，并保留至后续阶段', 'Partially delivered; saved for next stage')
                    : t(lang, '补充说明已保存，将在下一阶段生效', 'Saved; will apply to next stage');
              notify(receiptMsg, 'success');
            }}
            lang={lang}
            asciiMode={asciiMode}
          />
        </KeyScope>
      ) : null}

      {workflowModalOpen ? (
        <KeyScope id="tasks:workflow" opaque>
          <Suspense fallback={null}>
            <WorkflowHistoryModal
              host={host}
              isActive={isActive && workflowModalOpen}
              onClose={() => setWorkflowModalOpen(false)}
            />
          </Suspense>
        </KeyScope>
      ) : null}
    </Box>
  );
});
