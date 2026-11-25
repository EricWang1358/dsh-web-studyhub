import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbsolute, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme, type Tone } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { cleanPathInput, errorMessage, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from './path-complete.js';

export interface MinerUModalProps {
  host: HostClient;
  defaultCourse?: string | null;
  isActive: boolean;
  onQueued?: () => Promise<void> | void;
  onOpenTasks?: (jobId?: string) => void;
  onClose: () => void;
}

type ModalTab = 'plan' | 'history';
type PlanField = 'path' | 'course' | 'confirm';

interface PlanWindow {
  index: number;
  startPage: number;
  endPage: number;
  pages: number;
}

interface PlanAdaptive {
  firstPages?: number;
  rampPages?: number[];
  targetSeconds?: number;
  minPages?: number;
  maxPages?: number;
}

interface MinerUPlanResult {
  name?: string;
  pages: number;
  bytes: number;
  windows: PlanWindow[];
  adaptive?: PlanAdaptive;
  localEstimateSeconds?: Record<string, number>;
}

interface MinerULocalStatus {
  state?: string;
  next?: string | null;
  tier?: string;
  lastError?: { code?: string; message?: string } | null;
}

interface MinerUImportResult {
  jobId?: string;
  id?: string;
  status?: string;
  queuedBehind?: number;
  pages?: number;
  converter?: string;
  next?: string;
}

interface MinerUHistoryRecord {
  id: string;
  filename?: string;
  title?: string;
  bytes?: number;
  pages?: number;
  pieces?: number;
  pagesDone?: number;
  importedPages?: number;
  converter?: string;
  route?: string;
  tier?: string;
  status: string;
  phase?: string;
  attempts?: number;
  elapsedMs?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  canRetry?: boolean;
  live?: boolean;
  failure?: {
    stage?: string;
    piece?: number;
    reason?: string;
    code?: string;
  };
  document?: {
    exists?: boolean;
    title?: string;
    pages?: number;
  };
}

interface MinerUHistoryResponse {
  records?: MinerUHistoryRecord[];
  total?: number;
  keepLatest?: number;
  keepDays?: number;
}

interface RetryResult {
  jobId?: string;
  status?: string;
}

const PDF_EXTENSIONS = ['.pdf'] as const;
const RETRYABLE_STATUSES = new Set(['failed', 'interrupted', 'cancelled', 'stopped']);
const SETTINGS_ERROR_CODES = new Set([
  'not-installed',
  'needs-models',
  'installing',
  'unknown',
  'cloud-removed',
  'server-start-failed',
  'service-failed',
  'models-missing',
]);

function resolveUserPath(raw: string): string {
  const cleaned = cleanPathInput(raw);
  const expanded = expandHomePath(cleaned);
  if (!expanded) return '';
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number | undefined, lang: UiLanguage): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-';
  const sec = Math.round(seconds);
  if (sec < 60) return `${sec}${t(lang, '秒', 's')}`;
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins}${t(lang, '分', 'm')}`;
  const hrs = (sec / 3600).toFixed(1);
  return `${hrs}${t(lang, '小时', 'h')}`;
}

function formatShortDate(iso: string | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function isSettingsGuidanceError(code: string | undefined, message: string | undefined): boolean {
  if (code && SETTINGS_ERROR_CODES.has(code)) return true;
  if (!message) return false;
  return /mineru|设置|settings|一键安装|one-click install|needs-models|not-installed|repair|修复/i.test(message);
}

function isPdfInputError(code: string | undefined, message: string | undefined): boolean {
  if (code && ['not-pdf', 'damaged', 'encrypted', 'empty', 'ENOENT'].includes(code)) return true;
  if (!message) return false;
  return /ENOENT|no such file|not a pdf|不是有效的\s*PDF|密码|encrypted|损坏|damaged|绝对路径/i.test(message);
}

function statusDisplay(
  status: string,
  lang: UiLanguage,
): { tag: string; label: string; tone: Tone } {
  switch (status) {
    case 'complete':
      return { tag: 'OK', label: t(lang, '完成', 'Done'), tone: 'success' };
    case 'running':
      return { tag: 'RUN', label: t(lang, '运行', 'Running'), tone: 'accent' };
    case 'failed':
      return { tag: 'FAIL', label: t(lang, '失败', 'Failed'), tone: 'error' };
    case 'interrupted':
    case 'stopped':
      return { tag: 'STOP', label: t(lang, '中断', 'Stopped'), tone: 'warning' };
    case 'held':
      return { tag: 'HOLD', label: t(lang, '待审', 'Held'), tone: 'warning' };
    case 'cancelled':
      return { tag: 'CANC', label: t(lang, '取消', 'Cancelled'), tone: 'muted' };
    default:
      return { tag: 'INFO', label: status || '-', tone: 'muted' };
  }
}

function canRetryRecord(rec: MinerUHistoryRecord | undefined): boolean {
  if (!rec) return false;
  if (rec.live || rec.status === 'running' || rec.status === 'complete') return false;
  if (rec.route === 'cloud') return false;
  if (rec.canRetry === true) return true;
  if (rec.canRetry === false) return false;
  return RETRYABLE_STATUSES.has(rec.status);
}

export const MinerUModal = memo(function MinerUModal({
  host,
  defaultCourse,
  isActive,
  onQueued,
  onOpenTasks,
  onClose,
}: MinerUModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useStableWindowSize();

  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const [tab, setTab] = useState<ModalTab>('plan');
  const [focusField, setFocusField] = useState<PlanField>('path');

  // Tab 1: Plan & Convert
  const [filePath, setFilePath] = useState('');
  const [courseInput, setCourseInput] = useState(defaultCourse || '');
  const [matches, setMatches] = useState<string[]>([]);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [planResult, setPlanResult] = useState<{ path: string; data: MinerUPlanResult } | null>(null);
  const [localStatus, setLocalStatus] = useState<MinerULocalStatus | null>(null);
  const [planError, setPlanError] = useState<{ message: string; code?: string } | null>(null);
  const [queuedResult, setQueuedResult] = useState<{ jobId: string; status: string; queuedBehind: number; pages: number; next?: string } | null>(null);

  // Tab 2: History
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRecords, setHistoryRecords] = useState<MinerUHistoryRecord[]>([]);
  const [historyMeta, setHistoryMeta] = useState<{ keepLatest?: number; keepDays?: number }>({});
  const [selectedHistoryIdx, setSelectedHistoryIdx] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    const res = await tryAction<MinerUHistoryResponse>(host, 'mineru.history.list', {});
    if (!mountedRef.current) return;
    setHistoryLoading(false);
    if (!res.ok || !res.value) {
      setHistoryError(res.error?.message || t(lang, '加载 MinerU 转换历史失败', 'Failed to load MinerU history'));
      return;
    }
    const list = Array.isArray(res.value.records) ? res.value.records : [];
    setHistoryRecords(list);
    setHistoryMeta({
      keepLatest: typeof res.value.keepLatest === 'number' ? res.value.keepLatest : undefined,
      keepDays: typeof res.value.keepDays === 'number' ? res.value.keepDays : undefined,
    });
    setSelectedHistoryIdx((idx) => Math.min(idx, Math.max(0, list.length - 1)));
  }, [host, lang]);

  // Load conversion history on open
  useEffect(() => {
    if (!isActive) return;
    void loadHistory();
  }, [isActive, loadHistory]);

  // Pre-fetch PDF path completions while editing the path field
  useEffect(() => {
    if (!isActive || tab !== 'plan' || focusField !== 'path' || queuedResult) return;
    let cancelled = false;
    const cleaned = cleanPathInput(filePath);
    void completeFsPath(cleaned, { extensions: PDF_EXTENSIONS }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      cachedCompletionRef.current = { input: filePath, completed: res.completed };
      setMatches(res.matches.slice(0, 5));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, tab, focusField, filePath, queuedResult]);

  const handlePathChange = useCallback((next: string) => {
    setFilePath(next);
    setPlanResult(null);
    setPlanError(null);
  }, []);

  const handleTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    const cleaned = cleanPathInput(val);
    void completeFsPath(cleaned, { extensions: PDF_EXTENSIONS }).then((res) => {
      if (!mountedRef.current) return;
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setMatches(res.matches.slice(0, 5));
      if (res.completed && res.completed !== val) {
        setFilePath(res.completed);
        setPlanResult(null);
        setPlanError(null);
      }
    });
    return undefined;
  }, []);

  const runPlan = useCallback(async () => {
    if (busyRef.current) return;
    const absPath = resolveUserPath(filePath);
    if (!absPath) {
      setPlanError({
        message: t(lang, '请输入本地 PDF 文件路径', 'Please enter a local PDF file path'),
      });
      return;
    }
    if (!absPath.toLowerCase().endsWith('.pdf')) {
      setPlanError({
        code: 'not-pdf',
        message: t(lang, '请选择 .pdf 格式文件用于 MinerU 转换', 'Please select a .pdf file for MinerU conversion'),
      });
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setBusyLabel(t(lang, `正在本地读取页数与分段计划${ell}`, `Reading PDF pages & conversion plan locally${ell}`));
    setPlanError(null);
    setPlanResult(null);

    try {
      const [planRes, statusRes] = await Promise.allSettled([
        tryAction<MinerUPlanResult>(host, 'mineru.plan', { path: absPath }),
        tryAction<MinerULocalStatus>(host, 'mineru.local.status', {}),
      ]);

      if (!mountedRef.current) return;

      if (statusRes.status === 'fulfilled' && statusRes.value.ok && statusRes.value.value) {
        setLocalStatus(statusRes.value.value);
      }

      if (planRes.status !== 'fulfilled') {
        setPlanError({ message: errorMessage(planRes.reason) });
        return;
      }

      const res = planRes.value;
      if (!res.ok || !res.value) {
        setPlanError({
          code: res.error?.code,
          message: res.error?.message || t(lang, 'PDF 解析计划生成失败', 'Failed to plan PDF conversion'),
        });
        return;
      }

      const data = res.value;
      const pages = Number.isFinite(data.pages) ? data.pages : 0;
      const bytes = Number.isFinite(data.bytes) ? data.bytes : 0;
      const windows = Array.isArray(data.windows) ? data.windows : [];
      setPlanResult({
        path: absPath,
        data: { ...data, pages, bytes, windows },
      });
      setFocusField('confirm');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [filePath, host, lang]);

  const submitConvert = useCallback(async () => {
    if (busyRef.current || !planResult) return;
    busyRef.current = true;
    setBusy(true);
    setBusyLabel(t(lang, `正在加入 MinerU 转换队列${ell}`, `Queueing MinerU conversion${ell}`));
    setPlanError(null);

    try {
      const course = courseInput.trim();
      const args: Record<string, unknown> = {
        path: planResult.path,
        ...(course ? { course } : {}),
      };
      const res = await tryAction<MinerUImportResult>(host, 'mineru.import', args);
      if (!mountedRef.current) return;

      if (!res.ok || !res.value) {
        setPlanError({
          code: res.error?.code,
          message: res.error?.message || t(lang, '加入 MinerU 转换队列失败', 'Failed to queue MinerU conversion'),
        });
        return;
      }

      const jobId = String(res.value.jobId || res.value.id || '');
      const status = String(res.value.status || 'queued');
      const queuedBehind = typeof res.value.queuedBehind === 'number' ? res.value.queuedBehind : 0;
      const pages = typeof res.value.pages === 'number' ? res.value.pages : planResult.data.pages;
      setQueuedResult({
        jobId,
        status,
        queuedBehind,
        pages,
        ...(typeof res.value.next === 'string' ? { next: res.value.next } : {}),
      });
      notify(
        jobId
          ? t(lang, `已加入 MinerU 转换队列 (${jobId})`, `Queued MinerU conversion (${jobId})`)
          : t(lang, '已加入 MinerU 转换队列', 'Queued MinerU conversion'),
        'success',
      );
      void onQueued?.();
      void loadHistory();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [courseInput, host, lang, loadHistory, notify, onQueued, planResult]);

  const selectedRecord = historyRecords[selectedHistoryIdx];

  const handleRetrySelected = useCallback(async () => {
    if (busyRef.current || !selectedRecord) return;
    if (selectedRecord.route === 'cloud') {
      notify(
        t(lang, '云端解析记录无法续传，请用本机 MinerU 重新转换', 'Cloud jobs cannot resume; re-convert locally'),
        'warning',
      );
      return;
    }
    if (selectedRecord.live || selectedRecord.status === 'running') {
      notify(t(lang, '该转换正在运行，按 [t] 可前往任务页查看', 'Conversion is running; press [t] to view in Jobs'), 'info');
      return;
    }
    if (!canRetryRecord(selectedRecord)) {
      notify(
        t(lang, '该记录当前不可重试（已完成或临时文件已清理）', 'Record cannot be retried (completed or cleaned up)'),
        'warning',
      );
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setBusyLabel(t(lang, `正在恢复 MinerU 转换任务${ell}`, `Retrying MinerU conversion${ell}`));
    try {
      const res = await tryAction<RetryResult>(host, 'mineru.retry', { jobId: selectedRecord.id });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '重试 MinerU 任务失败', 'Failed to retry MinerU job'), 'error');
        return;
      }
      const nextJobId = res.value?.jobId || selectedRecord.id;
      notify(
        t(lang, `已恢复转换任务 (${nextJobId})`, `Retried conversion (${nextJobId})`),
        'success',
      );
      void onQueued?.();
      await loadHistory();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [host, lang, loadHistory, notify, onQueued, selectedRecord]);

  const isTypingField = tab === 'plan' && !queuedResult && (focusField === 'path' || focusField === 'course');

  useInput(
    (input, key) => {
      if (!isActive || busyRef.current) return;

      // Always allow Ctrl+T, Ctrl+Tab, or Shift+Tab to toggle modal tabs even while editing
      if ((key.ctrl && input === 't') || (key.ctrl && key.tab) || (key.tab && key.shift)) {
        setTab((cur) => (cur === 'plan' ? 'history' : 'plan'));
        return;
      }

      if (!isTypingField) {
        if (input === '1') {
          setTab('plan');
          return;
        }
        if (input === '2') {
          setTab('history');
          return;
        }
      }
      if (key.tab && (!isTypingField || focusField === 'course')) {
        setTab((cur) => (cur === 'plan' ? 'history' : 'plan'));
        return;
      }

      if (tab === 'plan') {
        if (queuedResult) {
          if (input === 't' || input === 'T' || key.return) {
            if (onOpenTasks) onOpenTasks(queuedResult.jobId || undefined);
            else onClose();
            return;
          }
          if (input === 'n' || input === 'N') {
            setQueuedResult(null);
            setPlanResult(null);
            setPlanError(null);
            setFocusField('path');
            return;
          }
          return;
        }

        if (focusField === 'path') {
          if (key.downArrow) {
            setFocusField('course');
          }
          return;
        }
        if (focusField === 'course') {
          if (key.upArrow) {
            setFocusField('path');
          } else if (key.downArrow && planResult) {
            setFocusField('confirm');
          }
          return;
        }
        if (focusField === 'confirm') {
          if (input === 'c' || input === 'C' || key.return) {
            void submitConvert();
          } else if (input === 'e' || input === 'E' || key.upArrow || key.backspace) {
            setFocusField('path');
          }
          return;
        }
      } else {
        // Tab 2: History
        if (input === 'r') {
          void handleRetrySelected();
        } else if (input === 'R') {
          void loadHistory();
        } else if ((input === 't' || input === 'T' || key.return) && selectedRecord) {
          if (selectedRecord.live || selectedRecord.status === 'running') {
            if (onOpenTasks) onOpenTasks(selectedRecord.id);
            else onClose();
          }
        }
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (tab === 'history') {
      return [
        { key: '1/2', label: t(lang, '切标签', 'Tabs') },
        { key: 'r', label: t(lang, '重试', 'Retry') },
        { key: 'R', label: t(lang, '刷新', 'Refresh') },
        ...(selectedRecord && (selectedRecord.live || selectedRecord.status === 'running')
          ? [{ key: 't', label: t(lang, '任务页', 'Jobs') }]
          : []),
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    if (queuedResult) {
      return [
        { key: 't/Enter', label: t(lang, '去任务页', 'Open Jobs') },
        { key: 'n', label: t(lang, '继续规划', 'New PDF') },
        { key: '2', label: t(lang, '历史', 'History') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    if (focusField === 'confirm' && planResult) {
      return [
        { key: 'c/Enter', label: t(lang, '开始转换', 'Convert') },
        { key: 'e', label: t(lang, '改路径', 'Edit') },
        { key: '2/Tab', label: t(lang, '历史', 'History') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    return [
      ...(focusField === 'path' ? [{ key: 'Tab', label: t(lang, '补全', 'Complete') }] : []),
      { key: 'Enter', label: t(lang, '本地规划', 'Plan') },
      { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '切字段', 'Field') },
      { key: 'Ctrl+T', label: t(lang, '历史', 'History') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }, [asciiMode, focusField, lang, planResult, queuedResult, selectedRecord, tab]);

  const frameWidth = Math.max(46, Math.min(82, columns - 4));
  const frameHeight = Math.max(15, Math.min(28, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(10, frameHeight - 5);
  const inputWidth = Math.max(20, innerWidth - 4);

  const sep = asciiMode ? '-' : '·';
  const gt = asciiMode ? '>' : '›';
  const errMark = asciiMode ? 'x' : '✕';
  const okMark = asciiMode ? '+' : '✓';
  const warnMark = asciiMode ? '!' : '⚠';

  const bodyHeight = Math.max(8, innerHeight - 2);
  const showHistoryDetail = bodyHeight >= 10 && historyRecords.length > 0;
  const historyListHeight = Math.max(3, bodyHeight - 2 - (showHistoryDetail ? 2 : 0));

  const pdfDetected = resolveUserPath(filePath).toLowerCase().endsWith('.pdf');
  const mineruNotReady = Boolean(
    localStatus?.state && ['not-installed', 'needs-models', 'installing', 'unknown'].includes(localStatus.state),
  );

  const basicSec = planResult?.data.localEstimateSeconds?.basic;
  const standardSec = planResult?.data.localEstimateSeconds?.standard;

  return (
    <Modal
      title={t(lang, 'MinerU 扫描/长 PDF 转换', 'MinerU Scanned / Long PDF')}
      subtitle={t(lang, '本机离线解析', 'Local · Zero Upload')}
      icon={asciiMode ? 'M' : '▤'}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {/* 2-Tab Header */}
      <Box height={1} flexDirection="row" alignItems="center" width={innerWidth} marginBottom={1}>
        <Badge
          label={`[1] ${t(lang, '转换长/扫描 PDF', 'Plan & Convert')}`}
          tone={tab === 'plan' ? 'primary' : 'muted'}
          variant={tab === 'plan' ? 'solid' : 'outline'}
        />
        <Text> </Text>
        <Badge
          label={`[2] ${t(lang, '转换历史', 'History')} (${historyRecords.length})`}
          tone={tab === 'history' ? 'primary' : 'muted'}
          variant={tab === 'history' ? 'solid' : 'outline'}
        />
        <Box flexGrow={1} />
        <Text color={theme.dim} wrap="truncate-end">
          {isTypingField ? 'Ctrl+T' : '1/2 · Tab'}
        </Text>
      </Box>

      {tab === 'plan' ? (
        <Box flexDirection="column" height={bodyHeight} width={innerWidth} overflow="hidden">
          {queuedResult ? (
            <Box
              flexDirection="column"
              borderStyle={asciiMode ? 'classic' : 'round'}
              borderColor={theme.success}
              paddingX={1}
              paddingY={0}
              width={innerWidth}
            >
              <Box flexDirection="row" alignItems="center">
                <Badge label={`${okMark} ${t(lang, '已入队', 'Queued')}`} tone="success" variant="solid" />
                <Text> </Text>
                <Text color={theme.text} bold wrap="truncate-end">
                  {truncateDisplay(`Job: ${queuedResult.jobId || '-'}`, Math.max(12, innerWidth - 16), ell)}
                </Text>
              </Box>
              <Box marginTop={1}>
                <Text color={theme.muted} wrap="truncate-end">
                  {truncateDisplay(
                    `${t(lang, '页数', 'Pages')}: ${queuedResult.pages} ${sep} ${t(lang, '状态', 'Status')}: ${queuedResult.status}${
                      queuedResult.queuedBehind > 0
                        ? ` (${t(lang, `前方排队 ${queuedResult.queuedBehind} 项`, `${queuedResult.queuedBehind} ahead`)})`
                        : ''
                    }`,
                    Math.max(16, innerWidth - 4),
                    ell,
                  )}
                </Text>
              </Box>
              {queuedResult.next ? (
                <Box marginTop={1}>
                  <Text color={theme.text} wrap="wrap">
                    {truncateDisplay(queuedResult.next, Math.max(20, (innerWidth - 4) * 2), ell)}
                  </Text>
                </Box>
              ) : null}
              <Box marginTop={1} flexDirection="row" flexWrap="wrap">
                <Text color={theme.accent} bold>
                  {t(lang, '[t / Enter] 前往后台任务查看进度', '[t / Enter] Open Jobs View')}
                </Text>
                <Text color={theme.dim}>   </Text>
                <Text color={theme.muted}>{t(lang, '[n] 转换另一份 PDF', '[n] Plan another PDF')}</Text>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" width={innerWidth}>
              <Box flexDirection="row" justifyContent="space-between" width={innerWidth}>
                <Text color={focusField === 'path' ? theme.primary : theme.muted} bold={focusField === 'path'} wrap="truncate-end">
                  {truncateDisplay(
                    t(lang, 'PDF 路径 (支持 ~, /, \\, C:\\... 及拖拽)', 'PDF Path (~, /, \\, C:\\... & drag-drop)'),
                    Math.max(16, innerWidth - 8),
                    ell,
                  )}
                </Text>
                {pdfDetected ? <Badge label="PDF" tone="success" variant="soft" /> : null}
              </Box>
              <TextInput
                value={filePath}
                onChange={handlePathChange}
                onTab={handleTabComplete}
                onSubmit={() => void runPlan()}
                onCancel={onClose}
                placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\scanned.pdf' : '~/Documents/scanned.pdf'}
                width={inputWidth}
                isActive={isActive && !busy && focusField === 'path'}
                prompt={asciiMode ? '>' : '›'}
              />

              {matches.length > 0 && focusField === 'path' ? (
                <Box height={1} width={innerWidth}>
                  <Text color={theme.dim} wrap="truncate-end">
                    {truncateDisplay(
                      `${t(lang, '补全:', 'Tab:')} ${matches.join('  ')}`,
                      innerWidth,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : null}

              <Box marginTop={1} width={innerWidth}>
                <Text color={focusField === 'course' ? theme.primary : theme.muted} bold={focusField === 'course'}>
                  {t(lang, '所属课程 (可选)', 'Course (optional)')}
                </Text>
              </Box>
              <TextInput
                value={courseInput}
                onChange={setCourseInput}
                onSubmit={() => void runPlan()}
                onCancel={onClose}
                placeholder={t(lang, '例如：线性代数', 'e.g. Linear Algebra')}
                width={inputWidth}
                isActive={isActive && !busy && focusField === 'course'}
                prompt={asciiMode ? '>' : '›'}
              />

              {busy ? (
                <Box marginTop={1}>
                  <Spinner label={busyLabel} />
                </Box>
              ) : planError ? (
                <Box
                  marginTop={1}
                  flexDirection="column"
                  borderStyle={asciiMode ? 'classic' : 'round'}
                  borderColor={theme.error}
                  paddingX={1}
                  width={innerWidth}
                >
                  <Text color={theme.error} bold wrap="wrap">
                    {`${errMark} ${planError.message}`}
                  </Text>
                  {isSettingsGuidanceError(planError.code, planError.message) ? (
                    <Text color={theme.warning} wrap="wrap">
                      {truncateDisplay(
                        t(
                          lang,
                          `指引：请在 StudyHub Desktop「设置 ${gt} PDF 转换」一键安装或修复本机 MinerU 后重试。`,
                          'Settings: Open StudyHub Desktop "Settings > PDF conversion" to install or repair local MinerU.',
                        ),
                        Math.max(20, (innerWidth - 4) * 2),
                        ell,
                      )}
                    </Text>
                  ) : isPdfInputError(planError.code, planError.message) ? (
                    <Text color={theme.muted} wrap="wrap">
                      {truncateDisplay(
                        t(
                          lang,
                          '提示：请检查路径是否存在且为未加密的 PDF（可按 Tab 补全路径）。',
                          'Tip: Verify the file exists and is an unencrypted PDF (press Tab to complete).',
                        ),
                        Math.max(20, (innerWidth - 4) * 2),
                        ell,
                      )}
                    </Text>
                  ) : null}
                </Box>
              ) : planResult ? (
                <Box
                  marginTop={1}
                  flexDirection="column"
                  borderStyle={asciiMode ? 'classic' : 'round'}
                  borderColor={focusField === 'confirm' ? theme.primary : theme.border}
                  paddingX={1}
                  width={innerWidth}
                >
                  <Box flexDirection="row" alignItems="center" width={Math.max(10, innerWidth - 4)}>
                    <Badge label={`${planResult.data.pages} ${t(lang, '页', 'p')}`} tone="info" variant="soft" />
                    <Text> </Text>
                    <Text color={theme.text} bold wrap="truncate-end">
                      {truncateDisplay(
                        planResult.data.name || planResult.path,
                        Math.max(12, innerWidth - 24),
                        ell,
                      )}
                    </Text>
                    <Box flexGrow={1} />
                    <Text color={theme.dim}>{formatBytes(planResult.data.bytes)}</Text>
                  </Box>

                  <Box width={Math.max(10, innerWidth - 4)}>
                    <Text color={theme.muted} wrap="truncate-end">
                      {truncateDisplay(
                        planResult.data.adaptive
                          ? t(
                              lang,
                              `分段策略: 自适应（首窗 ${planResult.data.adaptive.firstPages ?? 10} 页，目标 ${planResult.data.adaptive.targetSeconds ?? 75}s/窗）`,
                              `Windows: Adaptive (first ${planResult.data.adaptive.firstPages ?? 10}p, ~${planResult.data.adaptive.targetSeconds ?? 75}s/win)`,
                            )
                          : t(
                              lang,
                              `分段策略: 共 ${planResult.data.windows.length} 个转换窗口`,
                              `Windows: ${planResult.data.windows.length} conversion window(s)`,
                            ),
                        Math.max(16, innerWidth - 4),
                        ell,
                      )}
                    </Text>
                  </Box>

                  <Box width={Math.max(10, innerWidth - 4)}>
                    <Text color={theme.muted} wrap="truncate-end">
                      {truncateDisplay(
                        `${t(lang, '本机预计耗时', 'Est. time')}: basic ~${formatDuration(basicSec, lang)} ${sep} standard ~${formatDuration(standardSec, lang)}`,
                        Math.max(16, innerWidth - 4),
                        ell,
                      )}
                    </Text>
                  </Box>

                  {mineruNotReady ? (
                    <Box width={Math.max(10, innerWidth - 4)}>
                      <Text color={theme.warning} wrap="truncate-end">
                        {truncateDisplay(
                          `${warnMark} ${t(
                            lang,
                            `本机 MinerU 未就绪，请先前往「设置 ${gt} PDF 转换」安装或修复。`,
                            'Local MinerU not ready — check Settings > PDF conversion.',
                          )}`,
                          Math.max(16, innerWidth - 4),
                          ell,
                        )}
                      </Text>
                    </Box>
                  ) : null}

                  <Box marginTop={0} width={Math.max(10, innerWidth - 4)} flexDirection="row">
                    <Text color={focusField === 'confirm' ? theme.success : theme.accent} bold>
                      {t(lang, '[c / Enter] 确认加入后台转换队列', '[c / Enter] Confirm & Queue Conversion')}
                    </Text>
                    <Box flexGrow={1} />
                    <Text color={theme.dim}>{t(lang, '[e] 改路径', '[e] Edit')}</Text>
                  </Box>
                </Box>
              ) : (
                <Box marginTop={1} flexDirection="column" width={innerWidth}>
                  <Text color={theme.dim} wrap="truncate-end">
                    {truncateDisplay(
                      t(
                        lang,
                        '输入 PDF 路径后按 [Enter] 本地估算页数与分段窗口（零上传）。',
                        'Enter a PDF path and press [Enter] to inspect pages & windows locally (zero upload).',
                      ),
                      innerWidth,
                      ell,
                    )}
                  </Text>
                  {mineruNotReady ? (
                    <Text color={theme.warning} wrap="truncate-end">
                      {truncateDisplay(
                        `${warnMark} ${t(
                          lang,
                          `未检测到本机 MinerU：请在「设置 ${gt} PDF 转换」安装后开始转换。`,
                          'Local MinerU not ready: install under Settings > PDF conversion.',
                        )}`,
                        innerWidth,
                        ell,
                      )}
                    </Text>
                  ) : null}
                </Box>
              )}
            </Box>
          )}
        </Box>
      ) : (
        /* Tab 2: Conversion History */
        <Box flexDirection="column" height={bodyHeight} width={innerWidth} overflow="hidden">
          <Box height={1} flexDirection="row" alignItems="center" width={innerWidth} marginBottom={1}>
            <Badge label={`${t(lang, '记录', 'Records')} ${historyRecords.length}`} tone="info" variant="soft" />
            {historyMeta.keepLatest ? (
              <Text color={theme.dim} wrap="truncate-end">
                {`  ${t(lang, `保留近 ${historyMeta.keepLatest} 条`, `Keep ${historyMeta.keepLatest}`)}`}
              </Text>
            ) : null}
            <Box flexGrow={1} />
            <Text color={theme.dim} wrap="truncate-end">
              {t(lang, '[r] 重试  [R] 刷新', '[r] Retry  [R] Refresh')}
            </Text>
          </Box>

          {historyLoading && historyRecords.length === 0 ? (
            <Box height={Math.max(4, bodyHeight - 2)} width={innerWidth} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, `正在加载 MinerU 转换历史${ell}`, `Loading MinerU history${ell}`)} />
            </Box>
          ) : historyError && historyRecords.length === 0 ? (
            <Box height={Math.max(4, bodyHeight - 2)} width={innerWidth} flexDirection="column" alignItems="center" justifyContent="center">
              <Text color={theme.error} bold wrap="wrap">
                {`${errMark} ${historyError}`}
              </Text>
              <Box marginTop={1}>
                <Text color={theme.muted}>{t(lang, '按 [R] 重新加载', 'Press [R] to reload')}</Text>
              </Box>
            </Box>
          ) : historyRecords.length === 0 ? (
            <EmptyState
              title={t(lang, '暂无 MinerU 转换记录', 'No MinerU conversions yet')}
              hint={t(lang, '按 [1] 切换到转换规划页导入扫描/长 PDF', 'Press [1] to plan & convert a scanned/long PDF')}
              width={innerWidth}
              height={Math.max(4, bodyHeight - 2)}
            />
          ) : (
            <>
              <VirtualList
                items={historyRecords}
                height={historyListHeight}
                width={innerWidth}
                selectedIndex={selectedHistoryIdx}
                onChange={(idx) => setSelectedHistoryIdx(idx)}
                isActive={isActive && tab === 'history' && !busy}
                keyExtractor={(item) => item.id}
                ascii={asciiMode}
                renderItem={(item, ctx) => {
                  const st = statusDisplay(item.status, lang);
                  const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                  const badgeStr = `[${asciiMode ? st.tag : st.label}] `;
                  const totalP = typeof item.pages === 'number' && Number.isFinite(item.pages) ? item.pages : 0;
                  const doneP =
                    typeof item.importedPages === 'number' && item.status === 'complete'
                      ? item.importedPages
                      : typeof item.pagesDone === 'number'
                        ? item.pagesDone
                        : 0;
                  const pagesStr =
                    totalP > 0
                      ? item.status === 'complete'
                        ? `${totalP}p`
                        : `${doneP}/${totalP}p`
                      : '';
                  const dateStr = formatShortDate(item.finishedAt || item.updatedAt || item.startedAt);
                  const meta = [pagesStr, dateStr].filter(Boolean).join(` ${sep} `);
                  const titleText = item.document?.title || item.title || item.filename || item.id;
                  const fixedW = displayWidth(cursor) + displayWidth(badgeStr) + (meta ? displayWidth(meta) + 2 : 0);
                  const titleMax = Math.max(6, ctx.width - fixedW);
                  const toneColorVal =
                    st.tone === 'success'
                      ? theme.success
                      : st.tone === 'error'
                        ? theme.error
                        : st.tone === 'warning'
                          ? theme.warning
                          : st.tone === 'accent'
                            ? theme.accent
                            : theme.muted;

                  return (
                    <Box flexDirection="row" width={ctx.width}>
                      <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                      <Text color={toneColorVal} bold>
                        {badgeStr}
                      </Text>
                      <Text color={theme.text} bold={ctx.selected}>
                        {truncateDisplay(titleText, titleMax, ell)}
                      </Text>
                      <Box flexGrow={1} />
                      {meta ? <Text color={theme.dim}>{meta}</Text> : null}
                    </Box>
                  );
                }}
              />

              {showHistoryDetail && selectedRecord ? (
                <Box flexDirection="column" height={2} width={innerWidth} marginTop={0}>
                  <Text color={theme.muted} wrap="truncate-end">
                    {truncateDisplay(
                      [
                        `${selectedRecord.converter || 'mineru'} (${selectedRecord.route || 'local'}${selectedRecord.tier ? `/${selectedRecord.tier}` : ''})`,
                        typeof selectedRecord.attempts === 'number' ? `${selectedRecord.attempts}${t(lang, '次', 'x')}` : '',
                        typeof selectedRecord.elapsedMs === 'number'
                          ? formatDuration(selectedRecord.elapsedMs / 1000, lang)
                          : '',
                        canRetryRecord(selectedRecord) ? t(lang, '[r] 可重试', '[r] Retryable') : '',
                      ]
                        .filter(Boolean)
                        .join(` ${sep} `),
                      innerWidth,
                      ell,
                    )}
                  </Text>
                  <Text color={selectedRecord.failure?.reason ? theme.error : theme.dim} wrap="truncate-end">
                    {truncateDisplay(
                      selectedRecord.failure?.reason
                        ? `${errMark} ${selectedRecord.failure.reason}`
                        : selectedRecord.document?.exists
                          ? `${okMark} ${t(lang, `已导入 ${selectedRecord.document.pages ?? selectedRecord.pages ?? 0} 页`, `Imported ${selectedRecord.document.pages ?? selectedRecord.pages ?? 0} page(s)`)}`
                          : selectedRecord.route === 'cloud'
                            ? t(lang, '旧版云端任务记录（仅查看）', 'Legacy cloud record (read-only)')
                            : t(lang, '按 [j/k] 选择记录，失败/中断记录可按 [r] 继续', 'Use [j/k] to select; press [r] on failed/stopped jobs to retry'),
                      innerWidth,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : null}
            </>
          )}

          {busy ? (
            <Box height={1}>
              <Spinner label={busyLabel} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
