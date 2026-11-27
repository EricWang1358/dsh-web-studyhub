import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { KeyHint, UiLanguage } from '../../types/contracts.js';
import type { PillStatus } from '../../components/Badge.js';
import { t } from '../../state/store.js';
import { atomicWriteJsonFile, todayLocalYmd } from '../../host/atomic-write.js';

export type FilterTab = 'running' | 'all' | 'archived';

export interface JobRecord {
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

export interface ControlOverride {
  paused?: boolean;
  status?: string;
  concurrency?: number;
}

export interface JobOutputResponse {
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

export interface JobMessageResponse {
  jobId?: string;
  id?: string;
  text?: string;
  at?: string;
  delivery?: string;
  note?: string;
}

export interface TraceCallEntry {
  callId?: string;
  stage?: string;
  purpose?: string;
  status?: string;
  model?: string;
  deleted?: boolean;
  tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number };
}

export const MAX_LOG_LINES = 200;
export const ACTIVE_STATUSES = new Set([
  'running',
  'queued',
  'pending',
  'pausing',
  'paused',
  'cancelling',
  'in_progress',
  'started',
]);

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

export function jobMatchesFilter(job: JobRecord, rawQuery: string): boolean {
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

export function capLines(text: string, maxLines = MAX_LOG_LINES): string[] {
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

export function extractJobControlState(
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

export function normalizeJob(raw: Record<string, unknown>, archived = false): JobRecord {
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
  } else if (
    typeof progressObj?.completed === 'number' &&
    typeof progressObj?.total === 'number' &&
    progressObj.total > 0
  ) {
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
    createdAt: (raw.createdAt ?? contract?.createdAt ?? raw.startedAt ?? contract?.startedAt) as
      | string
      | number
      | undefined,
    updatedAt: (raw.updatedAt ??
      contract?.updatedAt ??
      raw.finishedAt ??
      contract?.finishedAt ??
      raw.startedAt ??
      contract?.startedAt) as string | number | undefined,
    calls,
    archived,
    ...controlState,
  };
}

export function mergeNormalizedJobs(
  snapshotJobs: readonly Record<string, unknown>[] | undefined,
  archivedJobs: readonly Record<string, unknown>[] | undefined,
  liveJobs: readonly Record<string, unknown>[] | null,
  controlOverrides: Record<string, ControlOverride>,
): { activeAndRecent: JobRecord[]; archived: JobRecord[] } {
  const snapJobs = (snapshotJobs ?? []).map((j) => normalizeJob(j, false));
  const liveNorm = (liveJobs ?? []).map((j) => normalizeJob(j, false));
  const byId = new Map<string, JobRecord>();
  for (const j of snapJobs) if (j.id) byId.set(j.id, j);
  for (const j of liveNorm) if (j.id) byId.set(j.id, j);
  const activeAndRecent = [...byId.values()].reverse().map((j) => {
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
  const archived = (archivedJobs ?? []).map((j) => normalizeJob(j, true));
  return { activeAndRecent, archived };
}

export function isJobPaused(job: Pick<JobRecord, 'paused' | 'status' | 'resumeAvailable'>): boolean {
  return job.paused || job.status === 'paused' || job.status === 'pausing' || job.resumeAvailable;
}

export function pillStatusFor(status: string): PillStatus {
  if (status === 'paused') return 'warn';
  if (ACTIVE_STATUSES.has(status)) return 'busy';
  if (status === 'complete' || status === 'ok' || status === 'done' || status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'error' || status === 'interrupted') return 'error';
  if (status === 'cancelled' || status === 'canceled') return 'warn';
  return 'idle';
}

export function formatElapsed(
  startedAt?: string | number,
  finishedAt?: string | number,
  asciiMode = false,
): string {
  const dash = asciiMode ? '-' : '—';
  if (!startedAt) return dash;
  const start = typeof startedAt === 'number' ? startedAt : Date.parse(String(startedAt));
  if (!Number.isFinite(start)) return dash;
  const end = finishedAt
    ? (typeof finishedAt === 'number' ? finishedAt : Date.parse(String(finishedAt)))
    : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${String(rem).padStart(2, '0')}s`;
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

export function extractOutputContent(payload: JobOutputResponse | null): {
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

export function formatTraceCallLines(
  calls: readonly TraceCallEntry[],
  unavailableReason: string | undefined,
  asciiMode: boolean,
): string[] {
  if (calls.length === 0) {
    return unavailableReason ? [`(${unavailableReason})`] : [];
  }
  const arrow = asciiMode ? '->' : '→';
  const sep = asciiMode ? ' - ' : ' · ';
  const lines = calls.map((c) => {
    const inTok = c.tokenUsage?.uncachedInputTokens ?? 0;
    const outTok = c.tokenUsage?.outputTokens ?? 0;
    const tok = inTok || outTok ? `${sep}${inTok}${arrow}${outTok} tok` : '';
    const purged = c.deleted ? `${sep}purged` : '';
    return `[${c.status || 'ok'}] ${c.stage || c.purpose || c.callId || 'call'} (${c.model || 'model'}${tok}${purged})`;
  });
  return lines.slice(-MAX_LOG_LINES);
}

export function computeQueueStatus(
  controlTarget: JobRecord | null,
  lang: UiLanguage,
): { status: PillStatus; label: string } {
  if (!controlTarget) {
    return { status: 'idle', label: t(lang, '空闲', 'Idle') };
  }
  if (controlTarget.status === 'pausing') {
    return { status: 'busy', label: t(lang, '暂停中', 'Pausing') };
  }
  if (isJobPaused(controlTarget)) {
    return { status: 'warn', label: t(lang, '已暂停', 'Paused') };
  }
  if (ACTIVE_STATUSES.has(controlTarget.status)) {
    return { status: 'ok', label: t(lang, '活跃', 'Active') };
  }
  return { status: 'idle', label: t(lang, '空闲', 'Idle') };
}

export function computeTasksHints(lang: UiLanguage, showParallelHint: boolean): KeyHint[] {
  return [
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
  ];
}
