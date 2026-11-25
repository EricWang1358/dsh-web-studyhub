import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { KEY_LAYER_MODAL } from '../../input/dispatcher.js';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { HostClient, KeyHint, UiLanguage, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, EmptyState, ProgressBar, Spinner, StatusPill, type PillStatus } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { ScrollView } from '../../components/ScrollView.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { LAYOUT_BP, computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { useTheme } from '../../theme/tokens.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/cjk.js';
import { renderStatTable } from '../../render/charts.js';
import { buildTaskProgressTitle, writeTerminalNotification, writeTerminalTitle } from '../../render/terminal-title.js';
import { atomicWriteExportText, atomicWriteJsonFile, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { tryAction } from '../../host/sample-actions.js';
const WorkflowHistoryModal = lazy(() => import('./WorkflowHistoryModal.js').then((m) => ({ default: m.WorkflowHistoryModal })));
const MarkdownView = lazy(() => import('../../components/MarkdownView.js').then((m) => ({ default: m.MarkdownView })));

type FilterTab = 'running' | 'all' | 'archived';

interface JobRecord {
  id: string;
  contractJobId: string;
  title: string;
  type: string;
  status: string;
  progress: number;
  phase: string;
  stage?: string;
  draftId?: string;
  course?: string;
  error?: string;
  startedAt?: string | number;
  finishedAt?: string | number;
  createdAt?: string | number;
  updatedAt?: string | number;
  calls: Array<{ id: string; status?: string; stage?: string; kind?: string }>;
  archived: boolean;
  paused: boolean;
  pauseAvailable: boolean;
  resumeAvailable: boolean;
  parallelAvailable: boolean;
  pauseReasonCode?: string;
  concurrency: number | null;
  concurrencyKey: string | null;
  concurrencyMin: number;
  concurrencyMax: number;
  setAvailable: boolean;
}

const MAX_LOG_LINES = 200;
const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending', 'pausing', 'paused', 'cancelling', 'in_progress', 'started']);
const CLAIMED_KEYS = ['1', '2', '3', 'o', 'm', 'w', 'x', 'X', 'a', 'd', 'v', 'e', 'D', 'p', 'P', 'R', '+', '-', '=', '/'] as const;

export interface TaskMarkdownItem {
  id?: string;
  title?: string;
  type?: string;
  status?: string;
  progress?: number;
  phase?: string;
  stage?: string;
  course?: string;
  archived?: boolean;
  startedAt?: string | number;
  finishedAt?: string | number;
  createdAt?: string | number;
  updatedAt?: string | number;
}

export interface FormatTasksMarkdownParams {
  jobs?: readonly TaskMarkdownItem[];
  filterTab?: FilterTab | string;
  filterQuery?: string;
  lang?: UiLanguage;
  generatedAt?: Date | string;
}

function escapeMdCell(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function formatMdTimestamp(value: Date | string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '-';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '-';
    const ymd = todayLocalYmd(value);
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');
    return `${ymd} ${hh}:${mm}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-';
    return formatMdTimestamp(new Date(value));
  }
  const str = String(value).trim();
  if (!str) return '-';
  const parsed = Date.parse(str);
  if (Number.isFinite(parsed)) {
    return formatMdTimestamp(new Date(parsed));
  }
  return escapeMdCell(str) || '-';
}

function formatGeneratedAt(generatedAt?: Date | string): string {
  if (typeof generatedAt === 'string' && generatedAt.trim()) return generatedAt.trim();
  const d = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  return formatMdTimestamp(d);
}

function filterTabLabel(filterTab: string | undefined, lang: UiLanguage): string {
  const tab = (filterTab || 'all').toLowerCase();
  if (tab === 'running') return t(lang, '运行中 (running)', 'Running (running)');
  if (tab === 'archived') return t(lang, '已归档 (archived)', 'Archived (archived)');
  if (tab === 'all') return t(lang, '全部 (all)', 'All (all)');
  return escapeMdCell(tab) || 'all';
}

/** Pure formatter producing a Markdown summary report of visible TasksView jobs (0 LLM tokens). */
export function formatTasksMarkdown({
  jobs = [],
  filterTab = 'all',
  filterQuery = '',
  lang = 'en',
  generatedAt,
}: FormatTasksMarkdownParams): string {
  const jobList = Array.isArray(jobs) ? jobs : [];
  const dateLabel = formatGeneratedAt(generatedAt);
  const tabLabel = filterTabLabel(filterTab, lang);
  const trimmedQuery = String(filterQuery ?? '').trim();

  const statusCounts = new Map<string, number>();
  for (const j of jobList) {
    const st = String(j?.status ?? 'unknown').trim().toLowerCase() || 'unknown';
    statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1);
  }
  const breakdown =
    statusCounts.size > 0
      ? [...statusCounts.entries()].map(([st, count]) => `${escapeMdCell(st)}: ${count}`).join(', ')
      : t(lang, '无', 'None');

  const lines: string[] = [
    `# ${t(lang, 'StudyHub 后台任务汇总报告', 'StudyHub Background Jobs Summary')}`,
    '',
    `- **${t(lang, '生成时间', 'Generated')}**: ${dateLabel}`,
    `- **${t(lang, '当前标签页', 'Active Tab')}**: ${tabLabel}`,
  ];
  if (trimmedQuery) {
    lines.push(`- **${t(lang, '筛选关键词', 'Filter Query')}**: ${escapeMdCell(trimmedQuery)}`);
  }
  lines.push(
    `- **${t(lang, '任务总数', 'Total Jobs')}**: ${jobList.length}`,
    `- **${t(lang, '状态分布', 'Status Breakdown')}**: ${breakdown}`,
    '',
    `## ${t(lang, '任务明细', 'Jobs Summary')}`,
    '',
  );

  if (jobList.length === 0) {
    lines.push(t(lang, '_当前筛选下暂无任务记录。_', '_No jobs match the current filter._'), '');
    return lines.join('\n');
  }

  lines.push(
    lang === 'zh'
      ? '| # | 标题 | 类型 | 状态 | 进度 | 课程 | 更新/创建时间 |'
      : '| # | Title | Type | Status | Progress | Course | Updated/Created |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );

  jobList.forEach((job, idx) => {
    const titleCell = escapeMdCell(job?.title || job?.id || '-') || '-';
    const typeCell = escapeMdCell(job?.type || 'job') || '-';
    const statusCell = escapeMdCell(job?.status || 'unknown') || '-';
    const rawProg = typeof job?.progress === 'number' && Number.isFinite(job.progress) ? job.progress : 0;
    const ratio = rawProg > 1 ? rawProg / 100 : rawProg;
    const progressCell = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    const courseCell = escapeMdCell(job?.course) || '-';
    const timeVal = job?.finishedAt ?? job?.updatedAt ?? job?.startedAt ?? job?.createdAt;
    const timeCell = escapeMdCell(formatMdTimestamp(timeVal)) || '-';
    lines.push(`| ${idx + 1} | ${titleCell} | ${typeCell} | ${statusCell} | ${progressCell} | ${courseCell} | ${timeCell} |`);
  });

  lines.push('');
  return lines.join('\n');
}

function jobMatchesFilter(job: JobRecord, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const parts: string[] = [
    job.title,
    job.type,
    job.status,
    job.course ?? '',
    job.stage ?? '',
    job.phase,
    job.id,
    ...job.calls.map((c) => c.stage ?? ''),
  ];
  return parts.join('\n').toLowerCase().includes(q);
}

function sanitizeJobIdForFilename(jobId: string): string {
  const cleaned = String(jobId || 'job')
    .replace(/[/\\]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return cleaned || 'job';
}

function formatTraceTimestamp(d = new Date()): string {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Atomically export a job's request trace JSON into `<libraryRoot>/exports/trace-<safeJobId>-<yyyymmdd-hhmmss>.json`.
 * Sanitizes `jobId` against path traversal and creates `exports/` if missing.
 */
export async function exportJobTraceToFile(
  libraryRoot: string,
  jobId: string,
  tracePayload: unknown,
): Promise<string> {
  const baseRoot = libraryRoot?.trim() ? resolve(libraryRoot.trim()) : tmpdir();
  const exportsDir = resolve(join(baseRoot, 'exports'));
  const safeJobId = sanitizeJobIdForFilename(jobId);
  const fileName = `trace-${safeJobId}-${formatTraceTimestamp()}.json`;
  const targetPath = resolve(join(exportsDir, fileName));
  if (dirname(targetPath) !== exportsDir) {
    throw new Error(`Refusing trace export outside exports directory: ${targetPath}`);
  }

  await atomicWriteJsonFile(targetPath, tracePayload ?? null);
  return targetPath;
}

function capLines(text: string, maxLines = MAX_LOG_LINES): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
}

function textField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.title === 'string') return obj.title;
    if (typeof obj.code === 'string') return obj.code;
  }
  return '';
}

function extractJobControlState(
  raw: Record<string, unknown>,
  contract: Record<string, unknown> | undefined,
  status: string,
  type: string,
  archived: boolean,
): Pick<
  JobRecord,
  | 'contractJobId'
  | 'paused'
  | 'pauseAvailable'
  | 'resumeAvailable'
  | 'parallelAvailable'
  | 'pauseReasonCode'
  | 'concurrency'
  | 'concurrencyKey'
  | 'concurrencyMin'
  | 'concurrencyMax'
  | 'setAvailable'
> {
  const id = String(raw.id ?? contract?.jobId ?? '');
  const contractJobId = typeof contract?.jobId === 'string' && contract.jobId ? contract.jobId : id;
  const actions =
    contract?.actions && typeof contract.actions === 'object'
      ? (contract.actions as Record<string, unknown>)
      : undefined;
  const detail =
    contract?.detail && typeof contract.detail === 'object'
      ? (contract.detail as Record<string, unknown>)
      : undefined;
  const controlObj =
    raw.control && typeof raw.control === 'object'
      ? (raw.control as Record<string, unknown>)
      : undefined;
  const controlValues =
    controlObj?.values && typeof controlObj.values === 'object'
      ? (controlObj.values as Record<string, unknown>)
      : undefined;
  const controlLimits =
    controlObj?.limits && typeof controlObj.limits === 'object'
      ? (controlObj.limits as Record<string, unknown>)
      : undefined;

  const pauseAction =
    actions?.pause && typeof actions.pause === 'object'
      ? (actions.pause as Record<string, unknown>)
      : undefined;
  const resumeAction =
    actions?.resume && typeof actions.resume === 'object'
      ? (actions.resume as Record<string, unknown>)
      : undefined;
  const parallelAction =
    actions?.parallel && typeof actions.parallel === 'object'
      ? (actions.parallel as Record<string, unknown>)
      : undefined;
  const setAction =
    actions?.set && typeof actions.set === 'object'
      ? (actions.set as Record<string, unknown>)
      : undefined;

  const pauseAvailable = !archived && Boolean(pauseAction?.available);
  const resumeAvailable = !archived && Boolean(resumeAction?.available);
  const parallelAvailable = !archived && Boolean(parallelAction?.available);
  const pauseReasonObj =
    pauseAction?.reason && typeof pauseAction.reason === 'object'
      ? (pauseAction.reason as Record<string, unknown>)
      : undefined;
  const pauseReasonCode = textField(pauseReasonObj?.code) || undefined;

  const paused =
    status === 'paused' ||
    status === 'pausing' ||
    raw.paused === true ||
    detail?.paused === true ||
    controlValues?.paused === true ||
    resumeAvailable;

  const rawSettings = Array.isArray(setAction?.settings) ? setAction.settings : [];
  const settings = rawSettings.filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'));
  const matchedSetting =
    settings.find((s) => s.key === 'concurrency') ??
    settings.find((s) => s.key === 'textConcurrency') ??
    settings.find((s) => s.type === 'int' && String(s.key ?? '').toLowerCase().includes('concurrency'));

  const defaultMax = type === 'translation' ? 3 : type === 'audio-import' ? 6 : 8;
  let concurrencyKey: string | null = null;
  let concurrency: number | null = null;
  let concurrencyMin = 1;
  let concurrencyMax = defaultMax;

  if (matchedSetting && typeof matchedSetting.key === 'string') {
    concurrencyKey = matchedSetting.key;
    if (typeof matchedSetting.value === 'number' && Number.isFinite(matchedSetting.value)) {
      concurrency = matchedSetting.value;
    }
    if (typeof matchedSetting.min === 'number' && Number.isFinite(matchedSetting.min)) {
      concurrencyMin = matchedSetting.min;
    }
    if (typeof matchedSetting.max === 'number' && Number.isFinite(matchedSetting.max)) {
      concurrencyMax = matchedSetting.max;
    }
  } else if (controlValues) {
    const keyCandidate =
      typeof controlValues.concurrency === 'number'
        ? 'concurrency'
        : typeof controlValues.textConcurrency === 'number'
          ? 'textConcurrency'
          : null;
    if (keyCandidate) {
      concurrencyKey = keyCandidate;
      concurrency = controlValues[keyCandidate] as number;
      const rule =
        controlLimits?.[keyCandidate] && typeof controlLimits[keyCandidate] === 'object'
          ? (controlLimits[keyCandidate] as Record<string, unknown>)
          : undefined;
      if (typeof rule?.min === 'number' && Number.isFinite(rule.min)) concurrencyMin = rule.min;
      if (typeof rule?.max === 'number' && Number.isFinite(rule.max)) concurrencyMax = rule.max;
    }
  }

  if (concurrency === null) {
    const fallbackVal =
      typeof detail?.concurrency === 'number' && Number.isFinite(detail.concurrency)
        ? detail.concurrency
        : typeof raw.concurrency === 'number' && Number.isFinite(raw.concurrency)
          ? raw.concurrency
          : null;
    if (fallbackVal !== null) {
      concurrency = fallbackVal;
      concurrencyKey = 'concurrency';
    }
  }

  const setAvailable =
    !archived &&
    Boolean(concurrencyKey) &&
    (Boolean(setAction?.available && matchedSetting) ||
      Boolean(controlValues && concurrencyKey && typeof controlValues[concurrencyKey] === 'number'));

  return {
    contractJobId,
    paused,
    pauseAvailable,
    resumeAvailable,
    parallelAvailable,
    pauseReasonCode,
    concurrency,
    concurrencyKey,
    concurrencyMin,
    concurrencyMax,
    setAvailable,
  };
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
      stage: textField(c.stage) || undefined,
      kind: typeof c.kind === 'string' ? c.kind : undefined,
    }))
    .filter((c) => Boolean(c.id));

  const errObj = contract?.error as Record<string, unknown> | undefined;
  const resultObj = contract?.result as Record<string, unknown> | undefined;
  const type = textField(raw.type) || textField(raw.kind) || textField(contract?.kind) || 'job';
  const controlState = extractJobControlState(raw, contract, status, type, archived);

  return {
    id: String(raw.id ?? contract?.jobId ?? ''),
    title:
      textField(raw.title) ||
      textField(contract?.title) ||
      textField(raw.type) ||
      textField(raw.kind) ||
      textField(raw.id) ||
      '后台任务',
    type,
    status,
    progress: Math.max(0, Math.min(1, progress)),
    phase:
      textField(raw.phase) ||
      textField(contract?.stage) ||
      textField(raw.stage) ||
      textField(raw.message),
    stage: textField(contract?.stage) || textField(raw.stage) || textField(raw.phase) || undefined,
    draftId:
      (typeof raw.draftId === 'string' && raw.draftId) ||
      (typeof resultObj?.draftId === 'string' && resultObj.draftId) ||
      undefined,
    course: typeof raw.course === 'string' ? raw.course : undefined,
    error: textField(raw.error) || textField(errObj?.message) || textField(errObj) || undefined,
    startedAt: (raw.startedAt ?? contract?.startedAt ?? raw.createdAt) as string | number | undefined,
    finishedAt: (raw.finishedAt ?? contract?.finishedAt) as string | number | undefined,
    createdAt: (raw.createdAt ?? contract?.createdAt ?? raw.startedAt ?? contract?.startedAt) as string | number | undefined,
    updatedAt: (raw.updatedAt ?? contract?.updatedAt ?? raw.finishedAt ?? contract?.finishedAt ?? raw.startedAt ?? contract?.startedAt) as string | number | undefined,
    calls,
    archived,
    ...controlState,
  };
}

function pillStatusFor(status: string): PillStatus {
  if (status === 'paused') return 'warn';
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
  const { columns, rows } = useStableWindowSize();
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

  useKeyScope({
    id: 'TasksView:output-modal',
    active: isActive,
    layer: KEY_LAYER_MODAL,
    onKey: (input, key) => {
      if (input === 'r') {
        setReloadTick((n) => n + 1);
        return true;
      }
      if (input === 'm') {
        setViewMode((m) => (m === 'auto' ? 'json' : 'auto'));
        return true;
      }
      if (job.calls.length > 1) {
        if (key.leftArrow || input === '[') {
          setCallIdx((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.rightArrow || input === ']') {
          setCallIdx((i) => Math.min(job.calls.length - 1, i + 1));
          return true;
        }
      }
      return false;
    },
  });

  const frameW = Math.min(108, Math.max(46, columns - 4));
  const frameH = Math.min(34, Math.max(15, rows - 2));
  const innerW = modalContentWidth(frameW);
  // Modal chrome: 5 rows; internal header + divider: 2 rows.
  const innerH = Math.max(6, Math.min(frameH, rows - 2) - 5);
  const bodyH = Math.max(3, innerH - 2);

  const parsed = useMemo(() => extractOutputContent(outputData), [outputData]);
  const showJson = viewMode === 'json' || parsed.kind === 'json';

  const hints: KeyHint[] = useMemo(() => {
    const h: KeyHint[] = [{ key: asciiMode ? 'Up/Dn/Pg' : '↑↓/Pg', label: t(lang, '滚动', 'Scroll') }];
    if (job.calls.length > 1) h.push({ key: asciiMode ? '<-/->' : '←/→', label: t(lang, '调用', 'Call') });
    if (parsed.kind !== 'empty') h.push({ key: 'm', label: showJson ? 'Markdown' : 'JSON' });
    h.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    h.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return h;
  }, [asciiMode, job.calls.length, lang, parsed.kind, showJson]);

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
            <Spinner label={t(lang, `正在获取任务输出${ell}`, `Loading job output${ell}`)} active={isActive} />
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
          <Suspense fallback={<Spinner label={t(lang, '加载输出视图...', 'Loading output view...')} />}>
            <MarkdownView
              markdown={parsed.markdownText}
              width={innerW}
              height={bodyH}
              isActive={isActive}
              ascii={asciiMode}
            />
          </Suspense>
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
  const { columns } = useStableWindowSize();
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
            placeholder={t(lang, `例如：多出几道边界条件与反例题${ell}`, `e.g. Add more boundary-case questions${ell}`)}
            maxLength={4000}
            captureInput={false}
          />
        </Box>
        {submitting ? (
          <Box marginTop={1}>
            <Spinner label={t(lang, `正在投递补充说明${ell}`, `Delivering message${ell}`)} active={isActive} />
          </Box>
        ) : validationError ? (
          <Box marginTop={1}>
            <Text color={theme.error} wrap="wrap">
              {`${asciiMode ? '! ' : '✕ '}${validationError}`}
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
  const [filterQuery, setFilterQuery] = useState('');

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
      } else if ((st === 'complete' || st === 'completed' || st === 'done' || st === 'ok') && prevActiveJobsRef.current.has(j.id)) {
        writeTerminalNotification(
          t(lang, `StudyHub 后台任务完成：${title}`, `StudyHub task completed: ${title}`),
          { asciiMode },
        );
      }
    }
    prevActiveJobsRef.current = nextActive;
  }, [snapshot?.jobs, lang, asciiMode]);
  const [filterEditing, setFilterEditing] = useState(false);
  const [liveJobs, setLiveJobs] = useState<Array<Record<string, unknown>> | null>(null);
  const [controlOverrides, setControlOverrides] = useState<
    Record<string, { paused?: boolean; status?: string; concurrency?: number }>
  >({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailMode, setDetailMode] = useState<'output' | 'trace'>('output');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmPurgeTraceOpen, setConfirmPurgeTraceOpen] = useState(false);
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
  const [traceReloadTick, setTraceReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Bounded detail buffers (capped at 200 lines — memory NFR)
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [traceLines, setTraceLines] = useState<string[]>([]);

  const allNormalized = useMemo(() => {
    const snapJobs = (snapshot?.jobs ?? []).map((j) => normalizeJob(j as Record<string, unknown>, false));
    const liveNorm = (liveJobs ?? []).map((j) => normalizeJob(j, false));
    const byId = new Map<string, JobRecord>();
    for (const j of snapJobs) if (j.id) byId.set(j.id, j);
    for (const j of liveNorm) if (j.id) byId.set(j.id, j);
    const activeAndRecent = [...byId.values()]
      .reverse()
      .map((j) => {
        const ov = controlOverrides[j.id];
        if (!ov || (!ACTIVE_STATUSES.has(j.status) && !j.pauseAvailable && !j.resumeAvailable && !j.setAvailable)) {
          return j;
        }
        return {
          ...j,
          ...(ov.paused !== undefined
            ? {
                paused: ov.paused,
                pauseAvailable: !ov.paused,
                resumeAvailable: ov.paused,
              }
            : {}),
          ...(ov.status !== undefined ? { status: ov.status } : {}),
          ...(ov.concurrency !== undefined ? { concurrency: ov.concurrency } : {}),
        };
      });
    const archived = (snapshot?.archivedJobs ?? []).map((j) => normalizeJob(j, true));
    return { activeAndRecent, archived };
  }, [snapshot?.jobs, snapshot?.archivedJobs, liveJobs, controlOverrides]);

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
  const selectedJobRef = useRef(selectedJob);
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

      const traceRes = await tryAction<{
        calls?: Array<{
          callId?: string;
          stage?: string;
          purpose?: string;
          status?: string;
          model?: string;
          deleted?: boolean;
          tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number };
        }>;
        unavailableReason?: string;
      }>(host, 'job.trace', { jobId: selectedJobId });
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
            const arrow = asciiMode ? '->' : '→';
            const tok = inTok || outTok ? ` · ${inTok}${arrow}${outTok} tok` : '';
            const purged = c.deleted ? ' · purged' : '';
            return `[${c.status || 'ok'}] ${c.stage || c.purpose || c.callId || 'call'} (${c.model || 'model'}${tok}${purged})`;
          });
          setTraceLines(lines.slice(-MAX_LOG_LINES));
        }
      }
    };

    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [asciiMode, host, isActive, selectedJobId, selectedJobStatus, selectedJobCallsLen, traceReloadTick]);

  const resolveLibraryRoot = useCallback((): string => {
    const hostWithInfo = host as HostClient & { getInfo?: () => { libraryRoot?: string } | null };
    return (
      host.getLibraryRoot?.()?.trim() ||
      hostWithInfo.getInfo?.()?.libraryRoot?.trim() ||
      host.getConfig?.()?.libraryRoot?.trim() ||
      snapshot?.root?.trim() ||
      tmpdir()
    );
  }, [host, snapshot?.root]);

  const handleCancel = useCallback(async () => {
    if (!selectedJob || busy || busyRef.current) return;
    if (!ACTIVE_STATUSES.has(selectedJob.status)) {
      notify(t(lang, '该任务已结束，无需取消', 'Job is already finished'), 'info');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction(host, 'job.cancel', { jobId: selectedJob.id });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '取消任务失败', 'Cancel failed'), 'error');
        return;
      }
      await refresh();
      if (mountedRef.current) {
        notify(t(lang, '已请求取消任务', 'Job cancel requested'), 'success');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const handleArchive = useCallback(async () => {
    if (!selectedJob || busy || busyRef.current) return;
    if (ACTIVE_STATUSES.has(selectedJob.status)) {
      notify(t(lang, '运行中的任务无法归档', 'Running jobs cannot be archived'), 'info');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (selectedJob.archived) {
        const res = await tryAction<{ unarchived?: string[]; missing?: string[] }>(host, 'job.unarchive', {
          jobId: selectedJob.id,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '恢复归档任务失败', 'Unarchive failed'), 'error');
          return;
        }
        await refresh();
        if (mountedRef.current) {
          notify(t(lang, '任务已从归档恢复', 'Job restored from archive'), 'success');
        }
        return;
      }
      const res = await tryAction<{ archived?: string[]; skipped?: Array<{ id: string; reason: string }> }>(
        host,
        'job.archive',
        { jobId: selectedJob.id },
      );
      if (!mountedRef.current) return;
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
      if (mountedRef.current) {
        notify(t(lang, '任务已归档', 'Job archived'), 'success');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedJob || busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const dismissRes = await tryAction(host, 'job.dismiss', { jobId: selectedJob.id });
      if (!mountedRef.current) return;
      if (dismissRes.ok) {
        setConfirmDeleteOpen(false);
        await refresh();
        if (mountedRef.current) {
          notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
        }
        return;
      }
      const delRes = await tryAction<{
        deleted?: string[];
        skipped?: Array<{ id?: string; reason?: string }>;
        missing?: string[];
      }>(host, 'job.delete', { jobIds: [selectedJob.id] });
      if (!mountedRef.current) return;
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
        if (mountedRef.current) {
          notify(t(lang, '该任务记录已不存在，已刷新列表', 'Job record was already gone; list refreshed'), 'info');
        }
        return;
      }
      await refresh();
      if (mountedRef.current) {
        notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const handleExportTrace = useCallback(async () => {
    if (!selectedJob || busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<{
        archived?: boolean;
        unavailableReason?: string;
        calls?: Array<{ callId?: string; retained?: boolean; deleted?: boolean }>;
      }>(host, 'job.trace.export', { jobId: selectedJob.id });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '导出调用轨迹失败', 'Trace export failed'), 'error');
        return;
      }
      const payload = res.value;
      const calls = Array.isArray(payload?.calls) ? payload.calls : [];
      if (!payload || payload.archived || calls.length === 0 || calls.every((c) => c.deleted)) {
        const reason = payload?.unavailableReason;
        const msg =
          reason === 'archived'
            ? t(lang, '已归档任务不保留调用轨迹', 'Archived jobs do not retain traces')
            : reason === 'deleted-by-user'
              ? t(lang, '该任务的调用轨迹已被清空', 'Traces for this job have been purged')
              : t(lang, '该任务暂无可导出的调用轨迹', 'No trace available for this job');
        notify(msg, 'info');
        return;
      }
      const savedPath = await exportJobTraceToFile(resolveLibraryRoot(), selectedJob.id, payload);
      if (!mountedRef.current) return;
      notify(t(lang, `轨迹已导出到 ${savedPath}`, `Trace exported to ${savedPath}`), 'success');
    } catch (err) {
      if (mountedRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出调用轨迹失败: ${msg}`, `Trace export failed: ${msg}`), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, resolveLibraryRoot, selectedJob]);

  const handlePurgeTraceConfirm = useCallback(async () => {
    if (!selectedJob || busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<{ jobId?: string; removed?: number }>(host, 'job.trace.delete', {
        jobId: selectedJob.id,
      });
      if (!mountedRef.current) return;
      setConfirmPurgeTraceOpen(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '清空调用轨迹失败', 'Failed to purge traces'), 'error');
        return;
      }
      const removed = typeof res.value?.removed === 'number' ? res.value.removed : 0;
      setTraceReloadTick((n) => n + 1);
      await refresh();
      if (!mountedRef.current) return;
      if (removed > 0) {
        notify(
          t(lang, `已清空 ${removed} 条调用轨迹（任务记录保留）`, `Purged ${removed} trace(s) (job record kept)`),
          'success',
        );
      } else {
        notify(
          t(lang, '该任务暂无可清空的缓存轨迹（任务记录保留）', 'No cached traces to purge (job record kept)'),
          'info',
        );
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, refresh, selectedJob]);

  const syncLiveAndRefresh = useCallback(async () => {
    const liveRes = await tryAction<{ jobs?: Array<Record<string, unknown>> }>(host, 'job.live.list', {});
    if (!mountedRef.current) return;
    if (liveRes.ok && Array.isArray(liveRes.value?.jobs)) {
      setLiveJobs(liveRes.value.jobs);
    }
    await refresh();
  }, [host, refresh]);

  const handleTogglePause = useCallback(async () => {
    if (busy || busyRef.current) return;
    if (!selectedJob) {
      notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
      return;
    }
    if (selectedJob.archived) {
      notify(
        t(lang, '已归档任务为只读记录，请先按 [a] 取消归档', 'Archived job is read-only; press [a] to unarchive first'),
        'info',
      );
      return;
    }
    const isPaused =
      selectedJob.paused ||
      selectedJob.status === 'paused' ||
      selectedJob.status === 'pausing' ||
      selectedJob.resumeAvailable;
    if (!isPaused && !selectedJob.pauseAvailable && !ACTIVE_STATUSES.has(selectedJob.status)) {
      notify(t(lang, '该任务已结束，无法暂停或继续', 'Job has ended; cannot pause or resume'), 'info');
      return;
    }

    const action = isPaused ? 'resume' : 'pause';
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<{
        action?: string;
        paused?: boolean;
        status?: string;
        applied?: Record<string, unknown>;
        values?: Record<string, unknown>;
      }>(host, 'job.control', {
        jobId: selectedJob.contractJobId,
        action,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '队列控制操作失败', 'Job control failed'), 'warning');
        return;
      }

      const nextPaused = action === 'pause';
      const nextStatus =
        typeof res.value?.status === 'string' && res.value.status
          ? res.value.status
          : nextPaused
            ? selectedJob.calls.some((c) => c.status === 'running')
              ? 'pausing'
              : 'paused'
            : 'running';

      setControlOverrides((prev) => ({
        ...prev,
        [selectedJob.id]: { ...prev[selectedJob.id], paused: nextPaused, status: nextStatus },
      }));
      await syncLiveAndRefresh();
      if (!mountedRef.current) return;
      setControlOverrides((prev) => {
        const next = { ...prev };
        delete next[selectedJob.id];
        return next;
      });
      notify(
        nextPaused
          ? t(lang, '已暂停任务队列（当前调用完成后停止新调度）', 'Job queue paused (no new calls will start)')
          : t(lang, '已恢复任务队列继续执行', 'Job queue resumed'),
        'success',
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, selectedJob, syncLiveAndRefresh]);

  const handleStartParallel = useCallback(async () => {
    if (busy || busyRef.current) return;
    if (!selectedJob) {
      notify(t(lang, '请先选择一个排队中的任务', 'Select a queued job first'), 'info');
      return;
    }
    if (selectedJob.archived) {
      notify(t(lang, '已归档任务无法并行启动', 'Archived jobs cannot be started in parallel'), 'info');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<{
        jobId?: string;
        attemptId?: string;
        status?: string;
        parallel?: boolean;
        note?: string;
      }>(host, 'job.parallel', {
        jobId: selectedJob.contractJobId || selectedJob.id,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(
          res.error?.message || t(lang, '无法并行启动该任务', 'Cannot start job in parallel'),
          'warning',
        );
        return;
      }

      await syncLiveAndRefresh();
      if (!mountedRef.current) return;
      notify(
        res.value?.note || t(lang, '已要求并行启动该任务', 'Job promoted to run in parallel'),
        'success',
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, selectedJob, syncLiveAndRefresh]);

  const handleAdjustConcurrency = useCallback(
    async (delta: -1 | 1) => {
      if (busy || busyRef.current) return;
      if (!selectedJob) {
        notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        return;
      }
      if (selectedJob.archived) {
        notify(
          t(lang, '已归档任务为只读记录，无法调整并发数', 'Archived job is read-only; concurrency cannot be changed'),
          'info',
        );
        return;
      }
      if (!selectedJob.setAvailable || !selectedJob.concurrencyKey || selectedJob.concurrency === null) {
        notify(t(lang, '当前任务不支持并发数调节', 'Concurrency adjustment is unavailable for this job'), 'info');
        return;
      }

      const min = selectedJob.concurrencyMin;
      const max = selectedJob.concurrencyMax;
      const current = selectedJob.concurrency;
      const next = Math.max(min, Math.min(max, current + delta));
      if (next === current) {
        notify(
          delta < 0
            ? t(lang, `并发数已达下限 (${min}x)`, `Concurrency already at minimum (${min}x)`)
            : t(lang, `并发数已达上限 (${max}x)`, `Concurrency already at maximum (${max}x)`),
          'info',
        );
        return;
      }

      const keyName = selectedJob.concurrencyKey;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<{
          applied?: Record<string, unknown>;
          values?: Record<string, unknown>;
        }>(host, 'job.control', {
          jobId: selectedJob.contractJobId,
          action: 'set',
          patch: { [keyName]: next },
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '调整并发数失败', 'Failed to adjust concurrency'), 'warning');
          return;
        }
        const confirmedRaw = res.value?.values?.[keyName] ?? res.value?.applied?.[keyName];
        const confirmed =
          typeof confirmedRaw === 'number' && Number.isFinite(confirmedRaw) ? confirmedRaw : next;

        setControlOverrides((prev) => ({
          ...prev,
          [selectedJob.id]: { ...prev[selectedJob.id], concurrency: confirmed },
        }));
        await syncLiveAndRefresh();
        if (!mountedRef.current) return;
        setControlOverrides((prev) => {
          const nextMap = { ...prev };
          delete nextMap[selectedJob.id];
          return nextMap;
        });
        notify(t(lang, `并发数已调整为 ${confirmed}x`, `Concurrency updated to ${confirmed}x`), 'success');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, notify, selectedJob, syncLiveAndRefresh],
  );

  const handleRecoverInterrupted = useCallback(async () => {
    if (busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<{ recovered?: number }>(host, 'coverage.recover', {});
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '恢复中断任务失败', 'Failed to recover interrupted jobs'), 'error');
        return;
      }
      const recovered = typeof res.value?.recovered === 'number' ? res.value.recovered : 0;
      await syncLiveAndRefresh();
      if (!mountedRef.current) return;
      if (recovered > 0) {
        notify(
          t(lang, `已恢复 ${recovered} 个中断任务`, `Recovered ${recovered} interrupted job(s)`),
          'success',
        );
      } else {
        notify(
          t(lang, '当前没有可恢复的中断任务', 'No interrupted jobs to recover'),
          'info',
        );
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, host, lang, notify, syncLiveAndRefresh]);

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
      const exportLabel = [filterTab !== 'all' ? filterTab : '', filterQuery.trim()].filter(Boolean).join('-') || undefined;
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

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'p', label: t(lang, '暂停/继续', 'Pause/Resume') },
      ...(showParallelHint ? [{ key: 'P', label: t(lang, '立即并行', 'Parallel') }] : []),
      { key: '+/-', label: t(lang, '并发', 'Concur') },
      { key: 'R', label: t(lang, '恢复中断', 'Recover') },
      { key: 'o', label: t(lang, '输出', 'Output') },
      { key: 'm', label: t(lang, '补充', 'Msg') },
      { key: 'w', label: t(lang, '历史流', 'Flows') },
      { key: 'v', label: t(lang, '轨迹', 'Trace') },
      { key: 'e', label: t(lang, '导出轨迹', 'Export') },
      { key: 'D', label: t(lang, '清轨迹', 'Purge') },
      { key: 'Tab', label: t(lang, '筛选', 'Filter') },
      { key: 'Enter', label: t(lang, '草稿', 'Draft') },
      { key: 'x', label: t(lang, '取消', 'Cancel') },
      { key: 'a', label: t(lang, '归档/恢复', 'Archive') },
      { key: 'd', label: t(lang, '删除', 'Dismiss') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
      { key: 'X', label: t(lang, '导出MD', 'Export') },
    ],
    [lang, showParallelHint],
  );
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

  const narrowBar = width < LAYOUT_BP.SPLIT_COMPACT;
  const topBarH = 2;
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const splitH = Math.max(4, height - topBarH - filterBarH);
  const ell = asciiMode ? '...' : '…';
  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${filteredJobs.length}/${tabJobs.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

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

  const queueIsPausing = controlTarget?.status === 'pausing';
  const queueIsPaused = Boolean(
    controlTarget &&
      (controlTarget.paused || controlTarget.status === 'paused' || controlTarget.resumeAvailable),
  );
  const queueIsActive = Boolean(controlTarget && ACTIVE_STATUSES.has(controlTarget.status));
  const queuePillStatus: PillStatus = !controlTarget
    ? 'idle'
    : queueIsPausing
      ? 'busy'
      : queueIsPaused
        ? 'warn'
        : queueIsActive
          ? 'ok'
          : 'idle';
  const queuePillLabel = !controlTarget
    ? t(lang, '空闲', 'Idle')
    : queueIsPausing
      ? t(lang, '暂停中', 'Pausing')
      : queueIsPaused
        ? t(lang, '已暂停', 'Paused')
        : queueIsActive
          ? t(lang, '活跃', 'Active')
          : t(lang, '空闲', 'Idle');

  const activeLogLines = detailMode === 'output'
    ? (outputLines.length > 0 ? outputLines : [t(lang, '（暂无实时输出文本；按 [v] 查看调用轨迹）', '(No live output text yet; press [v] for trace)')])
    : (traceLines.length > 0 ? traceLines : [t(lang, '（暂无调用轨迹）', '(No trace calls available)')]);

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
          <Box flexShrink={0} flexDirection="row" alignItems="center">
            <StatusPill label={queuePillLabel} status={queuePillStatus} />
            {controlTarget?.concurrency !== null && controlTarget?.concurrency !== undefined ? (
              <>
                <Text> </Text>
                <Badge
                  label={`${controlTarget.concurrency}x`}
                  tone={controlTarget.setAvailable ? 'info' : 'muted'}
                  variant="outline"
                />
              </>
            ) : null}
          </Box>
          {hasActiveJobs ? (
            <Box flexShrink={0} marginLeft={1}>
              <Spinner label={narrowBar ? '' : asciiMode ? t(lang, '实时刷新中...', 'Live...') : t(lang, '实时刷新中…', 'Live…')} />
            </Box>
          ) : width >= LAYOUT_BP.AI_DRAWER_SIDE ? (
            <Box flexShrink={0} marginLeft={1}>
              <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate-end'}>
                {truncateDisplay(
                  t(lang, 'Tab 筛选 · w 历史流 · v 轨迹', 'Tab filter · w Flows · v Trace'),
                  Math.max(8, width - 72),
                  asciiMode ? '...' : '…',
                )}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate-end'}>
          {truncateDisplay(
            width < LAYOUT_BP.COMPACT
              ? t(
                  lang,
                  '任务：[R]恢复 [p]暂停 [+/-]并发 [e]导出 [D]清轨迹 [o]输出 [m]补充 [w]流',
                  'Jobs: [R]Rec [p]Pause [+/-]Conc [e]Exp [D]Purge [o]Out [m]Msg [w]Flow',
                )
              : t(
                  lang,
                  '监控后台任务；[R] 恢复 · [p] 暂停 · [+/-] 并发 · [e] 导出 · [D] 清轨迹 · [o] 输出 · [m] 补充 · [w] 流',
                  'Monitor jobs; [R] Recover · [p] Pause · [+/-] Concur · [e] Export · [D] Purge · [o] Out · [m] Msg · [w] Flows',
                ),
            Math.max(10, width - 2),
            asciiMode ? '...' : '…',
          )}
        </Text>
      </Box>

      {/* Inline Live Filter Bar ([/]) */}
      {showFilterBar ? (
        <KeyScope id="tasks:filter" opaque active={isActive && filterEditing}>
          <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
            <Text color={filterEditing ? theme.primary : theme.accent} bold>
              {filterBadge}
            </Text>
            <Box flexGrow={1} overflow="hidden">
              <TextInput
                value={filterQuery}
                onChange={(val) => {
                  setFilterQuery(val);
                  setSelectedIndex(0);
                }}
                onSubmit={(val) => {
                  if (!val.trim()) setFilterQuery('');
                  setFilterEditing(false);
                }}
                onCancel={() => {
                  setFilterQuery('');
                  setFilterEditing(false);
                  setSelectedIndex(0);
                }}
                isActive={isActive && filterEditing}
                width={filterInputW}
                prompt="/"
                placeholder={t(lang, `标题/类型/状态/课程/阶段/ID${ell}`, `title/type/status/course/stage/id${ell}`)}
                maxLength={120}
              />
            </Box>
            {filterRightHint ? (
              <Text color={theme.dim} wrap="truncate">
                {filterRightHint}
              </Text>
            ) : null}
          </Box>
        </KeyScope>
      ) : null}

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
              badge={filteredJobs.length}
              width={lw}
              height={lh}
              focused={pageActive}
            >
              {filteredJobs.length === 0 ? (
                <EmptyState
                  title={
                    filterQuery.trim()
                      ? t(lang, '未找到匹配的任务', 'No matching jobs')
                      : t(lang, '当前筛选下无任务', 'No jobs in this filter')
                  }
                  hint={
                    filterQuery.trim()
                      ? t(lang, '按 Esc 清除筛选条件，或切换标签页', 'Press Esc to clear filter, or switch tabs')
                      : t(lang, '前往「创建题组」或「音频转写」启动任务', 'Start a task from Generate or Audio')
                  }
                  width={Math.max(12, lw - 4)}
                  height={Math.max(4, lh - 2)}
                />
              ) : (
                <VirtualList
                  items={filteredJobs}
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
                  isActive={pageActive}
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
              subtitle={detailMode === 'output' ? t(lang, '实时输出 (<=200行)', asciiMode ? 'Output (<=200)' : 'Output (≤200)') : t(lang, '调用轨迹', 'Trace')}
              width={rw}
              height={rh}
            >
              {!selectedJob ? (
                <Box flexDirection="column" width={Math.max(12, rw - 4)} height={Math.max(4, rh - 2)}>
                  {rh >= 12 ? (
                    <Box flexDirection="column" marginBottom={1}>
                      {renderStatTable(
                        [
                          { key: 'queue', label: t(lang, '任务队列', 'Queue'), align: 'left', minWidth: 8 },
                          { key: 'count', label: t(lang, '数量', 'Count'), align: 'right', minWidth: 5 },
                        ],
                        [
                          { queue: t(lang, '运行中', 'Running'), count: runningCount },
                          { queue: t(lang, '全部任务', 'All Jobs'), count: allCount },
                          { queue: t(lang, '已归档', 'Archived'), count: archivedCount },
                        ],
                        Math.max(18, rw - 4),
                        theme,
                        { ascii: asciiMode },
                      ).map((line, idx) => (
                        <Text key={`tq-${idx}`}>{line}</Text>
                      ))}
                    </Box>
                  ) : null}
                  <EmptyState
                    title={t(lang, '选择一个任务查看详情', 'Select a job')}
                    width={Math.max(12, rw - 4)}
                    height={Math.max(4, rh - (rh >= 12 ? 8 : 2))}
                  />
                </Box>
              ) : (
                <Box flexDirection="column" width={Math.max(12, rw - 4)} height={Math.max(2, rh - 2)}>
                  <Box flexDirection="row" alignItems="center" flexWrap="wrap">
                    <StatusPill label={selectedJob.status} status={pillStatusFor(selectedJob.status)} />
                    <Text> </Text>
                    <Badge label={selectedJob.type} tone="info" variant="soft" />
                    {selectedJob.concurrency !== null ? (
                      <>
                        <Text> </Text>
                        <Badge label={`${selectedJob.concurrency}x`} tone={selectedJob.setAvailable ? 'info' : 'muted'} variant="outline" />
                      </>
                    ) : null}
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
                    <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate-end'}>
                      {truncateDisplay(
                        t(lang, '  [v] 切换 · [e] 导出 · [D] 清空', '  [v] Switch · [e] Export · [D] Purge'),
                        Math.max(8, rw - 28),
                        asciiMode ? '...' : '…',
                      )}
                    </Text>
                  </Box>

                  <ScrollView
                    lines={activeLogLines}
                    width={Math.max(12, rw - 4)}
                    height={Math.max(2, rh - 10)}
                    follow={detailMode === 'output' && ACTIVE_STATUSES.has(selectedJob.status)}
                    isActive={false}
                    ascii={asciiMode}
                  />
                </Box>
              )}
            </Panel>
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
