import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Panel,
  ProgressBar,
  ScrollView,
  Spinner,
  SplitPane,
  StatusPill,
  VirtualList,
  useClaimKeys,
  useFooterHints,
  useTheme,
  type PillStatus,
} from '../../components/index.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/sample-actions.js';

type FilterTab = 'running' | 'all' | 'archived';

interface JobRecord {
  id: string;
  title: string;
  type: string;
  status: string;
  progress: number;
  phase: string;
  draftId?: string;
  course?: string;
  error?: string;
  startedAt?: string | number;
  finishedAt?: string | number;
  calls: Array<{ id: string; status?: string; stage?: string; kind?: string }>;
  archived: boolean;
}

const MAX_LOG_LINES = 200;
const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending', 'pausing', 'cancelling', 'in_progress', 'started']);

function capLines(text: string, maxLines = MAX_LOG_LINES): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
}

function normalizeJob(raw: Record<string, unknown>, archived = false): JobRecord {
  const contract = (raw.contract && typeof raw.contract === 'object'
    ? (raw.contract as Record<string, unknown>)
    : undefined);
  const progressObj = (contract?.progress && typeof contract.progress === 'object'
    ? (contract.progress as Record<string, unknown>)
    : undefined);

  const status = String(contract?.status ?? raw.status ?? (archived ? 'complete' : 'unknown')).toLowerCase();
  let progress = 0;
  if (typeof raw.progress === 'number') {
    progress = raw.progress > 1 ? raw.progress / 100 : raw.progress;
  } else if (typeof progressObj?.ratio === 'number') {
    progress = progressObj.ratio;
  } else if (typeof progressObj?.completed === 'number' && typeof progressObj?.total === 'number' && progressObj.total > 0) {
    progress = progressObj.completed / progressObj.total;
  } else if (status === 'complete' || status === 'ok' || status === 'done') {
    progress = 1;
  }

  const rawCalls = Array.isArray(contract?.calls)
    ? contract.calls
    : Array.isArray(raw.calls)
      ? raw.calls
      : Array.isArray(raw.steps)
        ? raw.steps
        : [];
  const calls = rawCalls
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
    .map((c) => ({
      id: String(c.id ?? c.callId ?? ''),
      status: typeof c.status === 'string' ? c.status : undefined,
      stage: typeof c.stage === 'string' ? c.stage : undefined,
      kind: typeof c.kind === 'string' ? c.kind : undefined,
    }))
    .filter((c) => Boolean(c.id));

  const errObj = contract?.error as Record<string, unknown> | undefined;
  const resultObj = contract?.result as Record<string, unknown> | undefined;

  return {
    id: String(raw.id ?? contract?.jobId ?? ''),
    title: String(raw.title ?? contract?.title ?? raw.type ?? raw.kind ?? raw.id ?? '后台任务'),
    type: String(raw.type ?? raw.kind ?? contract?.kind ?? 'job'),
    status,
    progress: Math.max(0, Math.min(1, progress)),
    phase: String(raw.phase ?? contract?.stage ?? raw.stage ?? raw.message ?? ''),
    draftId:
      (typeof raw.draftId === 'string' && raw.draftId) ||
      (typeof resultObj?.draftId === 'string' && resultObj.draftId) ||
      undefined,
    course: typeof raw.course === 'string' ? raw.course : undefined,
    error:
      (typeof raw.error === 'string' && raw.error) ||
      (typeof errObj?.message === 'string' && errObj.message) ||
      undefined,
    startedAt: (raw.startedAt ?? contract?.startedAt ?? raw.createdAt) as string | number | undefined,
    finishedAt: (raw.finishedAt ?? contract?.finishedAt) as string | number | undefined,
    calls,
    archived,
  };
}

function pillStatusFor(status: string): PillStatus {
  if (ACTIVE_STATUSES.has(status)) return 'busy';
  if (status === 'complete' || status === 'ok' || status === 'done' || status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'error' || status === 'interrupted') return 'error';
  if (status === 'cancelled' || status === 'canceled') return 'warn';
  return 'idle';
}

function formatElapsed(startedAt?: string | number, finishedAt?: string | number): string {
  if (!startedAt) return '—';
  const start = typeof startedAt === 'number' ? startedAt : Date.parse(String(startedAt));
  if (!Number.isFinite(start)) return '—';
  const end = finishedAt
    ? (typeof finishedAt === 'number' ? finishedAt : Date.parse(String(finishedAt)))
    : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${String(rem).padStart(2, '0')}s`;
}

export const TasksView: React.FC<ViewProps> = memo(function TasksView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const snapshot = useTuiStore((s) => s.snapshot);
  const navContext = useTuiStore((s) => s.navContext);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [liveJobs, setLiveJobs] = useState<Array<Record<string, unknown>> | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailMode, setDetailMode] = useState<'output' | 'trace'>('output');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Bounded detail buffers (capped at 200 lines — memory NFR)
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [traceLines, setTraceLines] = useState<string[]>([]);

  const allNormalized = useMemo(() => {
    const snapJobs = (snapshot?.jobs ?? []).map((j) => normalizeJob(j as Record<string, unknown>, false));
    const liveNorm = (liveJobs ?? []).map((j) => normalizeJob(j, false));
    const byId = new Map<string, JobRecord>();
    for (const j of snapJobs) if (j.id) byId.set(j.id, j);
    for (const j of liveNorm) if (j.id) byId.set(j.id, j);
    const activeAndRecent = [...byId.values()].reverse();
    const archived = (snapshot?.archivedJobs ?? []).map((j) => normalizeJob(j, true));
    return { activeAndRecent, archived };
  }, [snapshot?.jobs, snapshot?.archivedJobs, liveJobs]);

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

  const displayedJobs = useMemo(() => {
    if (filterTab === 'running') {
      return allNormalized.activeAndRecent.filter((j) => ACTIVE_STATUSES.has(j.status));
    }
    if (filterTab === 'archived') {
      return allNormalized.archived;
    }
    return [...allNormalized.activeAndRecent, ...allNormalized.archived];
  }, [allNormalized, filterTab]);

  // Select incoming navContext.jobId if provided
  useEffect(() => {
    if (!navContext.jobId) return;
    const idx = displayedJobs.findIndex((j) => j.id === navContext.jobId);
    if (idx >= 0) setSelectedIndex(idx);
  }, [navContext.jobId, displayedJobs]);

  useEffect(() => {
    if (selectedIndex >= displayedJobs.length) {
      setSelectedIndex(Math.max(0, displayedJobs.length - 1));
    }
  }, [displayedJobs.length, selectedIndex]);

  const selectedJob = displayedJobs[selectedIndex];

  // Fetch `job.output` and `job.trace` for selected job (capped at MAX_LOG_LINES).
  useEffect(() => {
    if (!isActive || !selectedJob) {
      setOutputLines([]);
      setTraceLines([]);
      return;
    }
    let cancelled = false;
    const latestCall = [...selectedJob.calls].reverse().find((c) => c.status === 'running') ?? selectedJob.calls.at(-1);

    const loadDetails = async () => {
      if (latestCall?.id) {
        const outRes = await tryAction<{ text?: string; supported?: boolean }>(host, 'job.output', {
          jobId: selectedJob.id,
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

      const traceRes = await tryAction<{
        calls?: Array<{
          callId?: string;
          stage?: string;
          purpose?: string;
          status?: string;
          model?: string;
          tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number };
        }>;
        unavailableReason?: string;
      }>(host, 'job.trace', { jobId: selectedJob.id });
      if (!cancelled && traceRes.ok && traceRes.value) {
        const calls = traceRes.value.calls ?? [];
        if (calls.length === 0) {
          setTraceLines(
            traceRes.value.unavailableReason
              ? [`(${traceRes.value.unavailableReason})`]
              : [],
          );
        } else {
          const lines = calls.map((c) => {
            const inTok = c.tokenUsage?.uncachedInputTokens ?? 0;
            const outTok = c.tokenUsage?.outputTokens ?? 0;
            const tok = inTok || outTok ? ` · ${inTok}→${outTok} tok` : '';
            return `[${c.status || 'ok'}] ${c.stage || c.purpose || c.callId || 'call'} (${c.model || 'model'}${tok})`;
          });
          setTraceLines(lines.slice(-MAX_LOG_LINES));
        }
      }
    };

    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [host, isActive, selectedJob?.id, selectedJob?.status, selectedJob?.calls.length]);

  const handleCancel = useCallback(async () => {
    if (!selectedJob || busy) return;
    if (!ACTIVE_STATUSES.has(selectedJob.status)) {
      notify(t(lang, '该任务已结束，无需取消', 'Job is already finished'), 'info');
      return;
    }
    setBusy(true);
    const res = await tryAction(host, 'job.cancel', { jobId: selectedJob.id });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '取消任务失败', 'Cancel failed'), 'error');
      return;
    }
    await refresh();
    notify(t(lang, '已请求取消任务', 'Job cancel requested'), 'success');
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const handleArchive = useCallback(async () => {
    if (!selectedJob || busy) return;
    if (selectedJob.archived || ACTIVE_STATUSES.has(selectedJob.status)) return;
    setBusy(true);
    const res = await tryAction(host, 'job.archive', { jobId: selectedJob.id });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '归档任务失败', 'Archive failed'), 'error');
      return;
    }
    await refresh();
    notify(t(lang, '任务已归档', 'Job archived'), 'success');
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedJob || busy) return;
    setBusy(true);
    let res = await tryAction(host, 'job.dismiss', { jobId: selectedJob.id });
    if (!res.ok) {
      res = await tryAction(host, 'job.delete', { jobIds: [selectedJob.id] });
    }
    setBusy(false);
    setConfirmDeleteOpen(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '删除任务失败', 'Delete failed'), 'error');
      return;
    }
    await refresh();
    notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const listActive = isActive && !confirmDeleteOpen;
  useClaimKeys(['1', '2', '3', 'x', 'a', 'd', 'v'], listActive);

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Tab', label: t(lang, '切换筛选', 'Filter') },
      { key: 'Enter', label: t(lang, '打开草稿', 'Open Draft') },
      { key: 'x', label: t(lang, '取消', 'Cancel') },
      { key: 'a', label: t(lang, '归档', 'Archive') },
      { key: 'd', label: t(lang, '删除', 'Dismiss') },
      { key: 'v', label: t(lang, '输出/轨迹', 'Output/Trace') },
    ],
    [lang],
  );
  useFooterHints(hints, isActive);

  useInput(
    (input, key) => {
      if (!listActive) return;
      if (key.tab) {
        setFilterTab((tCur) => (tCur === 'running' ? 'all' : tCur === 'all' ? 'archived' : 'running'));
        return;
      }
      if (input === '1') setFilterTab('running');
      else if (input === '2') setFilterTab('all');
      else if (input === '3') setFilterTab('archived');
      else if (input === 'v') setDetailMode((m) => (m === 'output' ? 'trace' : 'output'));
      else if (input === 'x') void handleCancel();
      else if (input === 'a') void handleArchive();
      else if (input === 'd' && selectedJob) setConfirmDeleteOpen(true);
    },
    { isActive: listActive },
  );

  const narrowBar = width < 84;
  const topBarH = 2;
  const splitH = Math.max(4, height - topBarH);

  const runningCount = allNormalized.activeAndRecent.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const allCount = allNormalized.activeAndRecent.length + allNormalized.archived.length;
  const archivedCount = allNormalized.archived.length;

  const activeLogLines = detailMode === 'output'
    ? (outputLines.length > 0 ? outputLines : [t(lang, '（暂无实时输出文本；按 [v] 查看调用轨迹）', '(No live output text yet; press [v] for trace)')])
    : (traceLines.length > 0 ? traceLines : [t(lang, '（暂无调用轨迹）', '(No trace calls available)')]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Filter Header */}
      <Box height={topBarH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center" width={Math.max(10, width - 2)}>
          <Box flexShrink={0}>
            <Badge
              label={`1. ${t(lang, '运行中', 'Running')} (${runningCount})`}
              tone={filterTab === 'running' ? 'accent' : 'muted'}
              variant={filterTab === 'running' ? 'solid' : 'outline'}
            />
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <Badge
              label={`2. ${t(lang, '全部', 'All')} (${allCount})`}
              tone={filterTab === 'all' ? 'primary' : 'muted'}
              variant={filterTab === 'all' ? 'solid' : 'outline'}
            />
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <Badge
              label={`3. ${t(lang, '已归档', 'Archived')} (${archivedCount})`}
              tone={filterTab === 'archived' ? 'info' : 'muted'}
              variant={filterTab === 'archived' ? 'solid' : 'outline'}
            />
          </Box>
          <Box flexGrow={1} />
          {hasActiveJobs ? (
            <Box flexShrink={0}>
              <Spinner label={narrowBar ? '' : t(lang, '实时刷新中…', 'Live…')} />
            </Box>
          ) : !narrowBar ? (
            <Box flexShrink={0}>
              <Text color={theme.dim} wrap="truncate-end">{t(lang, 'Tab 切换筛选 · v 切换输出/轨迹', 'Tab filter · v Output/Trace')}</Text>
            </Box>
          ) : null}
        </Box>
        <Text color={theme.dim} wrap="truncate-end">
          {t(lang, '监控出题、导入与转写后台任务进度；完成后按 Enter 打开草稿', 'Monitor generation, import & transcription jobs; press Enter to open draft')}
        </Text>
      </Box>

      {/* SplitPane */}
      <Box height={splitH} width={width}>
        <SplitPane
          width={width}
          height={splitH}
          leftWidth={0.44}
          leftLabel={t(lang, '任务列表', 'Jobs')}
          rightLabel={t(lang, '日志与轨迹', 'Output & Trace')}
          left={({ width: lw, height: lh }) => (
            <Panel
              title={t(lang, '后台任务', 'Background Jobs')}
              badge={displayedJobs.length}
              width={lw}
              height={lh}
              focused={listActive}
            >
              {displayedJobs.length === 0 ? (
                <EmptyState
                  title={t(lang, '当前筛选下无任务', 'No jobs in this filter')}
                  hint={t(lang, '前往「创建题组」或「音频转写」启动任务', 'Start a task from Generate or Audio')}
                  width={Math.max(12, lw - 4)}
                  height={Math.max(4, lh - 2)}
                />
              ) : (
                <VirtualList
                  items={displayedJobs}
                  height={Math.max(1, lh - 2)}
                  width={Math.max(12, lw - 4)}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  onSelect={(job) => {
                    if (job.draftId) {
                      navigate('generate', { draftId: job.draftId });
                    } else {
                      notify(t(lang, '该任务暂无关联草稿', 'No draft linked to this job'), 'info');
                    }
                  }}
                  isActive={listActive}
                  keyExtractor={(j) => `${j.archived ? 'arch-' : ''}${j.id}`}
                  renderItem={(job, ctx) => {
                    const active = ACTIVE_STATUSES.has(job.status);
                    const pct = `${Math.round(job.progress * 100)}%`;
                    const elapsed = formatElapsed(job.startedAt, job.finishedAt);
                    const meta = `${pct} · ${elapsed}`;
                    const titleMax = Math.max(8, ctx.width - meta.length - 8);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? '▸ ' : '  '}</Text>
                        <Text color={active ? theme.accent : theme.muted}>{active ? '⟳ ' : '• '}</Text>
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(job.title, titleMax)}
                        </Text>
                        <Box flexGrow={1} />
                        <Text color={theme.dim}>{meta}</Text>
                      </Box>
                    );
                  }}
                />
              )}
            </Panel>
          )}
          right={({ width: rw, height: rh }) => (
            <Panel
              title={selectedJob ? selectedJob.title : t(lang, '任务详情', 'Job Detail')}
              subtitle={detailMode === 'output' ? t(lang, '实时输出 (≤200行)', 'Output (≤200)') : t(lang, '调用轨迹', 'Trace')}
              width={rw}
              height={rh}
            >
              {!selectedJob ? (
                <EmptyState
                  title={t(lang, '选择一个任务查看详情', 'Select a job')}
                  width={Math.max(12, rw - 4)}
                  height={Math.max(4, rh - 2)}
                />
              ) : (
                <Box flexDirection="column" width={Math.max(12, rw - 4)} height={Math.max(2, rh - 2)}>
                  <Box flexDirection="row" alignItems="center" flexWrap="wrap">
                    <StatusPill label={selectedJob.status} status={pillStatusFor(selectedJob.status)} />
                    <Text> </Text>
                    <Badge label={selectedJob.type} tone="info" variant="soft" />
                    <Text> </Text>
                    <Text color={theme.dim}>{formatElapsed(selectedJob.startedAt, selectedJob.finishedAt)}</Text>
                    {selectedJob.draftId ? (
                      <>
                        <Text> </Text>
                        <Badge label={t(lang, 'Enter 打开草稿', 'Enter: Draft')} tone="success" variant="outline" />
                      </>
                    ) : null}
                  </Box>

                  <Box marginTop={1}>
                    <ProgressBar ratio={selectedJob.progress} width={Math.max(14, Math.min(36, rw - 8))} />
                  </Box>

                  {selectedJob.phase ? (
                    <Text color={theme.muted}>{`${t(lang, '阶段: ', 'Phase: ')}${selectedJob.phase}`}</Text>
                  ) : null}
                  {selectedJob.error ? (
                    <Text color={theme.error}>{`${t(lang, '错误: ', 'Error: ')}${selectedJob.error}`}</Text>
                  ) : null}

                  <Box marginTop={1} flexDirection="row">
                    <Badge
                      label={t(lang, '实时输出', 'Output')}
                      tone={detailMode === 'output' ? 'primary' : 'muted'}
                      variant={detailMode === 'output' ? 'solid' : 'outline'}
                    />
                    <Text> </Text>
                    <Badge
                      label={t(lang, '调用轨迹', 'Trace')}
                      tone={detailMode === 'trace' ? 'primary' : 'muted'}
                      variant={detailMode === 'trace' ? 'solid' : 'outline'}
                    />
                    <Text color={theme.dim}>  [v]</Text>
                  </Box>

                  <ScrollView
                    lines={activeLogLines}
                    width={Math.max(12, rw - 4)}
                    height={Math.max(2, rh - 10)}
                    follow={detailMode === 'output' && ACTIVE_STATUSES.has(selectedJob.status)}
                    isActive={false}
                  />
                </Box>
              )}
            </Panel>
          )}
        />
      </Box>

      {confirmDeleteOpen && selectedJob ? (
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
      ) : null}
    </Box>
  );
});
