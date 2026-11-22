import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint, UiLanguage, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  MarkdownView,
  Modal,
  Panel,
  ProgressBar,
  ScrollView,
  Spinner,
  SplitPane,
  StatusPill,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useTheme,
  type PillStatus,
} from '../../components/index.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/sample-actions.js';
const WorkflowHistoryModal = lazy(() => import('./WorkflowHistoryModal.js').then((m) => ({ default: m.WorkflowHistoryModal })));

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

interface JobOutputResponse {
  jobId?: string;
  callId?: string;
  supported?: boolean;
  live?: boolean;
  ended?: boolean;
  retained?: boolean;
  source?: string;
  text?: string;
  markdown?: string;
  output?: unknown;
  logs?: unknown;
  artifacts?: unknown;
  messages?: unknown;
  reasoningChars?: number;
  writtenChars?: number;
  clipped?: boolean;
  partial?: boolean;
  truncated?: boolean;
  sessionUnreadable?: boolean;
  runner?: string;
  [k: string]: unknown;
}

interface JobMessageResponse {
  jobId?: string;
  id?: string;
  text?: string;
  at?: string;
  delivery?: string;
  note?: string;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function extractOutputContent(payload: JobOutputResponse | null): {
  kind: 'empty' | 'markdown' | 'json';
  markdownText: string;
  jsonText: string;
} {
  if (!payload) return { kind: 'empty', markdownText: '', jsonText: '' };

  const rawText =
    typeof payload.markdown === 'string' && payload.markdown.trim()
      ? payload.markdown
      : typeof payload.text === 'string' && payload.text.trim()
        ? payload.text
        : typeof payload.output === 'string' && payload.output.trim()
          ? payload.output
          : '';

  const structured: Record<string, unknown> = {};
  if (payload.output && typeof payload.output === 'object') structured.output = payload.output;
  if (Array.isArray(payload.logs) && payload.logs.length > 0) structured.logs = payload.logs;
  else if (typeof payload.logs === 'string' && payload.logs.trim()) structured.logs = payload.logs;
  if (Array.isArray(payload.artifacts) && payload.artifacts.length > 0) structured.artifacts = payload.artifacts;
  if (Array.isArray(payload.messages) && payload.messages.length > 0) structured.messages = payload.messages;

  const hasStructured = Object.keys(structured).length > 0;
  if (!rawText && !hasStructured) {
    return { kind: 'empty', markdownText: '', jsonText: '' };
  }

  if (rawText) {
    const parsed = tryParseJson(rawText);
    if (parsed.ok) {
      const combined = hasStructured ? { ...structured, data: parsed.value } : parsed.value;
      const jsonText = JSON.stringify(combined, null, 2);
      return { kind: 'json', markdownText: rawText, jsonText };
    }
    const jsonText = hasStructured
      ? JSON.stringify({ text: rawText, ...structured }, null, 2)
      : JSON.stringify(payload, null, 2);
    return { kind: 'markdown', markdownText: rawText, jsonText };
  }

  const jsonText = JSON.stringify(structured, null, 2);
  return { kind: 'json', markdownText: '', jsonText };
}

const JobOutputModal = memo(function JobOutputModal({
  host,
  job,
  isActive,
  onClose,
  lang,
  asciiMode,
}: {
  host: HostClient;
  job: JobRecord;
  isActive: boolean;
  onClose: () => void;
  lang: UiLanguage;
  asciiMode: boolean;
}) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const ell = asciiMode ? '...' : '…';

  const defaultCallIdx = useMemo(() => {
    if (job.calls.length === 0) return 0;
    const runningIdx = [...job.calls].reverse().findIndex((c) => c.status === 'running');
    if (runningIdx >= 0) return job.calls.length - 1 - runningIdx;
    return job.calls.length - 1;
  }, [job.calls]);

  const [callIdx, setCallIdx] = useState(defaultCallIdx);
  const [loading, setLoading] = useState(true);
  const [outputData, setOutputData] = useState<JobOutputResponse | null>(null);
  const [viewMode, setViewMode] = useState<'auto' | 'json'>('auto');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    setCallIdx(defaultCallIdx);
  }, [job.id, defaultCallIdx]);

  const activeCall: JobRecord['calls'][number] | undefined =
    job.calls[Math.min(callIdx, Math.max(0, job.calls.length - 1))];

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      let targetCallId: string | undefined = activeCall?.id;
      if (!targetCallId) {
        const traceRes = await tryAction<{ calls?: Array<{ callId?: string; status?: string }> }>(host, 'job.trace', {
          jobId: job.id,
        });
        if (!cancelled && traceRes.ok && Array.isArray(traceRes.value?.calls) && traceRes.value.calls.length > 0) {
          const running = [...traceRes.value.calls].reverse().find((c) => c.status === 'running');
          targetCallId = running?.callId || traceRes.value.calls.at(-1)?.callId;
        }
      }
      const args: Record<string, unknown> = targetCallId
        ? { jobId: job.id, callId: targetCallId, cursor: 0 }
        : { jobId: job.id };
      const res = await tryAction<JobOutputResponse>(host, 'job.output', args);
      if (cancelled) return;
      setOutputData(res.ok && res.value ? res.value : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [host, isActive, job.id, activeCall?.id, reloadTick]);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (input === 'r') {
        setReloadTick((n) => n + 1);
        return;
      }
      if (input === 'm') {
        setViewMode((m) => (m === 'auto' ? 'json' : 'auto'));
        return;
      }
      if (job.calls.length > 1) {
        if (key.leftArrow || input === '[') {
          setCallIdx((i) => Math.max(0, i - 1));
        } else if (key.rightArrow || input === ']') {
          setCallIdx((i) => Math.min(job.calls.length - 1, i + 1));
        }
      }
    },
    { isActive },
  );

  const frameW = Math.min(108, Math.max(46, columns - 4));
  const frameH = Math.min(34, Math.max(15, rows - 2));
  const innerW = modalContentWidth(frameW);
  // Modal chrome: 5 rows; internal header + divider: 2 rows.
  const innerH = Math.max(6, Math.min(frameH, rows - 2) - 5);
  const bodyH = Math.max(3, innerH - 2);

  const parsed = useMemo(() => extractOutputContent(outputData), [outputData]);
  const showJson = viewMode === 'json' || parsed.kind === 'json';

  const hints: KeyHint[] = useMemo(() => {
    const h: KeyHint[] = [{ key: '↑↓/Pg', label: t(lang, '滚动', 'Scroll') }];
    if (job.calls.length > 1) h.push({ key: '←/→', label: t(lang, '调用', 'Call') });
    if (parsed.kind !== 'empty') h.push({ key: 'm', label: showJson ? 'Markdown' : 'JSON' });
    h.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    h.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return h;
  }, [job.calls.length, lang, parsed.kind, showJson]);

  const callBadge = activeCall
    ? `${activeCall.stage || activeCall.kind || activeCall.id} (${callIdx + 1}/${job.calls.length})`
    : t(lang, '默认输出', 'Output');

  return (
    <Modal
      title={t(lang, `任务输出: ${job.title}`, `Job Output: ${job.title}`)}
      icon={asciiMode ? '>' : '▤'}
      tone="primary"
      subtitle={job.status}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive}
      hints={hints}
    >
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <StatusPill label={job.status} status={pillStatusFor(job.status)} />
        <Text> </Text>
        <Badge label={truncateDisplay(callBadge, Math.max(10, Math.floor(innerW * 0.4)), ell)} tone="info" variant="soft" />
        {outputData?.source ? (
          <>
            <Text> </Text>
            <Badge label={String(outputData.source)} tone="muted" variant="outline" />
          </>
        ) : null}
        {typeof outputData?.reasoningChars === 'number' && outputData.reasoningChars > 0 ? (
          <Text color={theme.dim}>{` ${t(lang, '思考', 'think')}:${outputData.reasoningChars}`}</Text>
        ) : null}
        {outputData?.clipped || outputData?.partial ? (
          <>
            <Text> </Text>
            <Badge label={t(lang, '截断', 'Clipped')} tone="warning" variant="outline" />
          </>
        ) : null}
      </Box>
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>
      </Box>

      <Box width={innerW} height={bodyH} overflow="hidden">
        {loading ? (
          <Box width={innerW} height={bodyH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, '正在获取任务输出…', 'Loading job output…')} active={isActive} />
          </Box>
        ) : parsed.kind === 'empty' ? (
          <EmptyState
            title={t(lang, '该任务暂无输出内容', 'No output available for this job yet')}
            hint={
              job.archived
                ? t(lang, '已归档任务不保留实时流输出缓存', 'Archived jobs do not retain live stream output')
                : outputData?.supported === false
                  ? t(lang, '当前运行器不支持实时流式输出', 'Live streaming output is not supported by this runner')
                  : outputData?.sessionUnreadable
                    ? t(lang, '子代理会话暂不可读', 'Subagent session output is unreadable')
                    : t(lang, '按 [r] 刷新输出，或稍后再试', 'Press [r] to refresh or check back shortly')
            }
            width={innerW}
            height={bodyH}
          />
        ) : showJson ? (
          <ScrollView
            content={parsed.jsonText}
            width={innerW}
            height={bodyH}
            isActive={isActive}
            ascii={asciiMode}
          />
        ) : (
          <MarkdownView
            markdown={parsed.markdownText}
            width={innerW}
            height={bodyH}
            isActive={isActive}
            ascii={asciiMode}
          />
        )}
      </Box>
    </Modal>
  );
});

const JobMessageModal = memo(function JobMessageModal({
  host,
  job,
  isActive,
  onClose,
  onSent,
  lang,
  asciiMode,
}: {
  host: HostClient;
  job: JobRecord;
  isActive: boolean;
  onClose: () => void;
  onSent: (receipt: JobMessageResponse) => void;
  lang: UiLanguage;
  asciiMode: boolean;
}) {
  const theme = useTheme();
  const { columns } = useWindowSize();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const frameW = Math.min(72, Math.max(40, columns - 4));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(12, modalContentWidth(frameW) - 4);
  const ell = asciiMode ? '...' : '…';

  const handleSubmit = useCallback(
    async (raw: string) => {
      if (submitting) return;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 4000) {
        setValidationError(t(lang, '请输入 1–4000 字的补充说明', 'Please enter 1–4000 characters'));
        return;
      }
      setValidationError('');
      setSubmitting(true);
      const res = await tryAction<JobMessageResponse>(host, 'job.message', {
        jobId: job.id,
        message: trimmed,
      });
      if (!mountedRef.current) return;
      setSubmitting(false);
      if (!res.ok) {
        setValidationError(res.error?.message || t(lang, '发送补充说明失败', 'Failed to send refinement message'));
        return;
      }
      onSent(res.value ?? { jobId: job.id });
    },
    [host, job.id, lang, onSent, submitting],
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Enter', label: t(lang, '发送', 'Send') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ],
    [lang],
  );

  return (
    <Modal
      title={t(lang, '发送任务补充说明', 'Send Refinement Message')}
      icon={asciiMode ? '>' : '✉'}
      tone="accent"
      subtitle={truncateDisplay(job.title, 24, ell)}
      width={frameW}
      onClose={submitting ? undefined : onClose}
      isActive={isActive}
      hints={hints}
    >
      <Box flexDirection="column" width={innerW}>
        <Text color={theme.muted} wrap="truncate-end">
          {t(
            lang,
            '向正在运行的出题任务发送实时补充要求（1–4000 字），立即投递或用于下一阶段。',
            'Send live guidance (1–4000 chars) to this active job for current or next-stage workers.',
          )}
        </Text>
        <Box
          marginTop={1}
          borderStyle={asciiMode ? 'classic' : 'round'}
          borderColor={submitting ? theme.muted : theme.borderActive}
          paddingX={1}
        >
          <TextInput
            value={message}
            onChange={(val) => {
              setMessage(val);
              if (validationError) setValidationError('');
            }}
            onSubmit={(val) => void handleSubmit(val)}
            onCancel={onClose}
            isActive={isActive && !submitting}
            width={inputW}
            prompt={asciiMode ? '> ' : '› '}
            placeholder={t(lang, '例如：多出几道边界条件与反例题…', 'e.g. Add more boundary-case questions…')}
            maxLength={4000}
            captureInput={false}
          />
        </Box>
        {submitting ? (
          <Box marginTop={1}>
            <Spinner label={t(lang, '正在投递补充说明…', 'Delivering message…')} active={isActive} />
          </Box>
        ) : validationError ? (
          <Box marginTop={1}>
            <Text color={theme.error} wrap="truncate-end">
              {truncateDisplay(`${asciiMode ? '! ' : '✕ '}${validationError}`, innerW, ell)}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Modal>
  );
});

export const TasksView: React.FC<ViewProps> = memo(function TasksView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
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
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
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
    if (ACTIVE_STATUSES.has(selectedJob.status)) {
      notify(t(lang, '运行中的任务无法归档', 'Running jobs cannot be archived'), 'info');
      return;
    }
    setBusy(true);
    if (selectedJob.archived) {
      const res = await tryAction<{ unarchived?: string[]; missing?: string[] }>(host, 'job.unarchive', {
        jobId: selectedJob.id,
      });
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '恢复归档任务失败', 'Unarchive failed'), 'error');
        return;
      }
      await refresh();
      notify(t(lang, '任务已从归档恢复', 'Job restored from archive'), 'success');
      return;
    }
    const res = await tryAction<{ archived?: string[]; skipped?: Array<{ id: string; reason: string }> }>(
      host,
      'job.archive',
      { jobId: selectedJob.id },
    );
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '归档任务失败', 'Archive failed'), 'error');
      return;
    }
    if (res.value?.skipped?.length) {
      notify(
        t(lang, `任务未能归档 (${res.value.skipped[0].reason})`, `Skipped (${res.value.skipped[0].reason})`),
        'warning',
      );
      return;
    }
    await refresh();
    notify(t(lang, '任务已归档', 'Job archived'), 'success');
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedJob || busy) return;
    setBusy(true);
    const dismissRes = await tryAction(host, 'job.dismiss', { jobId: selectedJob.id });
    if (dismissRes.ok) {
      setBusy(false);
      setConfirmDeleteOpen(false);
      await refresh();
      notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
      return;
    }
    const delRes = await tryAction<{
      deleted?: string[];
      skipped?: Array<{ id?: string; reason?: string }>;
      missing?: string[];
    }>(host, 'job.delete', { jobIds: [selectedJob.id] });
    setBusy(false);
    setConfirmDeleteOpen(false);
    if (!delRes.ok) {
      notify(delRes.error?.message || t(lang, '删除任务失败', 'Delete failed'), 'error');
      return;
    }
    if (delRes.value?.skipped?.length) {
      const reason = delRes.value.skipped[0]?.reason;
      notify(
        reason === 'running'
          ? t(lang, '运行中的任务无法直接删除，请先按 [x] 取消任务', 'Running job cannot be removed; press [x] to cancel it first')
          : t(lang, `任务未能删除 (${reason || 'skipped'})`, `Job could not be removed (${reason || 'skipped'})`),
        'warning',
      );
      return;
    }
    if (delRes.value?.deleted && delRes.value.deleted.length === 0 && delRes.value.missing?.length) {
      await refresh();
      notify(t(lang, '该任务记录已不存在，已刷新列表', 'Job record was already gone; list refreshed'), 'info');
      return;
    }
    await refresh();
    notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const modalOpen = confirmDeleteOpen || outputModalOpen || messageModalOpen || workflowModalOpen;
  const listActive = isActive && !modalOpen;
  useClaimKeys(['1', '2', '3', 'o', 'm', 'w', 'x', 'a', 'd', 'v'], listActive);

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'o', label: t(lang, '输出', 'Output') },
      { key: 'm', label: t(lang, '补充', 'Msg') },
      { key: 'w', label: t(lang, '历史流', 'Flows') },
      { key: 'Tab', label: t(lang, '筛选', 'Filter') },
      { key: 'Enter', label: t(lang, '草稿', 'Draft') },
      { key: 'v', label: t(lang, '轨迹', 'Trace') },
      { key: 'x', label: t(lang, '取消', 'Cancel') },
      { key: 'a', label: t(lang, '归档/恢复', 'Archive') },
      { key: 'd', label: t(lang, '删除', 'Dismiss') },
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
      else if (input === 'o') {
        if (!selectedJob) notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        else setOutputModalOpen(true);
      } else if (input === 'm') {
        if (!selectedJob) notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        else if (!ACTIVE_STATUSES.has(selectedJob.status)) {
          notify(t(lang, '仅运行中的任务可发送补充说明', 'Only active jobs accept refinement messages'), 'info');
        } else {
          setMessageModalOpen(true);
        }
      } else if (input === 'w') setWorkflowModalOpen(true);
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
              <Text color={theme.dim} wrap="truncate-end">{t(lang, 'Tab 筛选 · w 历史学习流 · v 轨迹', 'Tab filter · w Workflows · v Trace')}</Text>
            </Box>
          ) : null}
        </Box>
        <Text color={theme.dim} wrap="truncate-end">
          {t(
            lang,
            '监控后台任务；[o] 输出弹窗 · [m] 补充要求 · [w] 历史学习流 · Enter 打开草稿',
            'Monitor jobs; [o] Output · [m] Message · [w] Workflows · Enter Open Draft',
          )}
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
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                        <Text color={active ? theme.accent : theme.muted}>{active ? (asciiMode ? '* ' : '⟳ ') : (asciiMode ? '- ' : '• ')}</Text>
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(job.title, titleMax, asciiMode ? '...' : '…')}
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

      {outputModalOpen && selectedJob ? (
        <JobOutputModal
          host={host}
          job={selectedJob}
          isActive={isActive && outputModalOpen}
          onClose={() => setOutputModalOpen(false)}
          lang={lang}
          asciiMode={asciiMode}
        />
      ) : null}

      {messageModalOpen && selectedJob ? (
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
      ) : null}

      <Suspense fallback={null}>
        {workflowModalOpen ? (
          <WorkflowHistoryModal
            host={host}
            isActive={isActive && workflowModalOpen}
            onClose={() => setWorkflowModalOpen(false)}
          />
        ) : null}
      </Suspense>
    </Box>
  );
});
