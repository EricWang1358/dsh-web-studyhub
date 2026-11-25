import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbsolute, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import type { Tone } from '../../theme/tokens.js';
import { useTheme } from '../../theme/tokens.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture } from '../../components/focus.js';
import { displayWidth, graphemeWidth, splitGraphemes, truncateDisplay } from '../../render/cjk.js';
import { cleanPathInput, errorMessage, importFormatOf, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from './path-complete.js';
import type { DocumentGroup } from './source-helpers.js';

export interface OriginalFileModalProps {
  host: HostClient;
  item: DocumentGroup;
  isActive: boolean;
  onRefresh: () => Promise<void> | void;
  onClose: () => void;
}

type AttachMode = 'reference' | 'copy';
type SubMode = 'inspect' | 'attach';
type AttachField = 'path' | 'mode';

interface OriginalCheckInfo {
  verdict?: string;
  similarity?: number;
  pages?: { stored?: number; supplied?: number | null; match?: boolean | null };
  checked?: number;
  matched?: number;
  confirmed?: boolean;
  verifiedAt?: string;
  basis?: string;
  reasons?: string[];
  mismatchedPages?: number[];
}

interface ConvertedFromInfo {
  path: string;
  bytes?: number;
  filename?: string;
}

interface OriginalStatusInfo {
  documentId?: string;
  revision?: string;
  format?: string;
  mode?: AttachMode | null;
  status: string;
  pages?: number;
  path?: string;
  bytes?: number;
  verifiedAt?: string;
  reason?: string;
  convertedFrom?: ConvertedFromInfo;
  check?: OriginalCheckInfo;
}

interface OriginalProbeReport extends OriginalCheckInfo {
  accepted: boolean;
  verdict: string;
  similarity: number;
  pages: { stored: number; supplied: number | null; match: boolean | null };
  checked: number;
  matched: number;
  format?: string;
  bytes?: number;
  hash?: string;
  documentId?: string;
  revision?: string;
}

interface OriginalAttachResponse {
  status: 'attached' | 'needs-confirmation';
  mode: AttachMode;
  documentId?: string;
  revision?: string;
  unchanged?: boolean;
  report?: OriginalProbeReport;
  original?: OriginalStatusInfo;
  originalAvailable?: boolean;
}

type ConfirmState =
  | { kind: 'detach' }
  | { kind: 'attach-confirm'; path: string; mode: AttachMode; report: OriginalProbeReport };

const SUPPORTED_EXTS = Object.freeze([
  '.pdf',
  '.docx',
  '.pptx',
  '.ppt',
  '.md',
  '.markdown',
  '.tex',
  '.latex',
  '.html',
  '.htm',
  '.txt',
]);

function formatBytes(bytes?: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n === 0) return '0 B';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatShortTime(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncatePathMiddle(rawPath: string, maxWidth: number, ell: string): string {
  const text = String(rawPath ?? '');
  if (!text || displayWidth(text) <= maxWidth) return text;
  const ellW = displayWidth(ell);
  if (maxWidth <= ellW + 2) return truncateDisplay(text, maxWidth, ell);

  const trimmed = text.length > 3 ? text.replace(/[\\/]+$/, '') : text;
  const sepIdx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));

  const sliceEndWidth = (str: string, budget: number): string => {
    const gs = splitGraphemes(str);
    let out = '';
    let w = 0;
    for (let i = gs.length - 1; i >= 0; i -= 1) {
      const gw = graphemeWidth(gs[i]);
      if (w + gw > budget) break;
      out = gs[i] + out;
      w += gw;
    }
    return out;
  };

  if (sepIdx <= 0 || sepIdx === trimmed.length - 1) {
    const budget = maxWidth - ellW;
    const headW = Math.max(1, Math.floor(budget / 2));
    const tailW = Math.max(1, budget - headW);
    return `${truncateDisplay(trimmed, headW, '')}${ell}${sliceEndWidth(trimmed, tailW)}`;
  }

  const tailSegment = trimmed.slice(sepIdx);
  const tailW = displayWidth(tailSegment);
  const headBudget = maxWidth - ellW - tailW;

  if (headBudget >= 3) {
    const headPart = truncateDisplay(trimmed.slice(0, sepIdx), headBudget, '');
    return `${headPart}${ell}${tailSegment}`;
  }

  const minHeadW = Math.min(4, Math.max(2, Math.floor((maxWidth - ellW) * 0.25)));
  const headPart = truncateDisplay(trimmed.slice(0, sepIdx), minHeadW, '');
  const tailBudget = Math.max(1, maxWidth - displayWidth(headPart) - ellW);
  if (tailW <= tailBudget) return `${headPart}${ell}${tailSegment}`;
  return `${headPart}${ell}${sliceEndWidth(tailSegment, tailBudget)}`;
}

function describeStatusBadge(
  info: OriginalStatusInfo | null,
  lang: UiLanguage,
): { label: string; tone: Tone } {
  if (!info || info.status === 'none' || !info.mode) {
    return { label: t(lang, '未关联', 'Not attached'), tone: 'muted' };
  }
  switch (info.status) {
    case 'ok':
      return { label: t(lang, '已关联', 'Attached'), tone: 'success' };
    case 'missing':
      return { label: t(lang, '文件缺失', 'Missing'), tone: 'warning' };
    case 'changed':
      return { label: t(lang, '文件已变更', 'Changed'), tone: 'warning' };
    case 'unreadable':
      return { label: t(lang, '无法读取', 'Unreadable'), tone: 'warning' };
    default:
      return { label: info.status, tone: 'warning' };
  }
}

function describeModeText(mode: AttachMode | null | undefined, lang: UiLanguage): string {
  if (mode === 'reference') {
    return t(lang, 'reference（仅引用路径，不复制）', 'reference (path only, no copy)');
  }
  if (mode === 'copy') {
    return t(lang, 'copy（已复制到学习库）', 'copy (stored in library)');
  }
  return t(lang, '未关联', 'None');
}

function describeReasonText(reason: string | undefined, status: string, lang: UiLanguage): string {
  if (reason === 'redirected') {
    return t(lang, '路径目前指向与关联时不同的实际文件。', 'Path now resolves to a different real file.');
  }
  if (reason === 'missing' || status === 'missing') {
    return t(lang, '找不到原文件，可能已被移动或删除。', 'Original file not found (moved or deleted).');
  }
  if (reason === 'unreadable' || status === 'unreadable') {
    return t(lang, '没有读取该原文件的权限或文件不可访问。', 'Original file cannot be read.');
  }
  if (reason === 'changed' || status === 'changed') {
    return t(lang, '原文件大小或内容已与关联时不一致。', 'Original file size or content changed since attachment.');
  }
  return '';
}

function describeVerdictText(check: OriginalCheckInfo, lang: UiLanguage): string {
  const verdict = check.verdict || 'unknown';
  const simPct = typeof check.similarity === 'number' ? `${(Math.round(check.similarity * 1000) / 10).toFixed(1)}%` : null;
  let verdictLabel = verdict;
  if (verdict === 'identical') verdictLabel = t(lang, '完全一致 (identical)', 'Identical');
  else if (verdict === 'match') verdictLabel = t(lang, '匹配通过 (match)', 'Match');
  else if (verdict === 'mismatch') verdictLabel = t(lang, '存在差异 (mismatch)', 'Mismatch');
  else if (verdict === 'unchecked') verdictLabel = t(lang, '未逐页核对 (unchecked)', 'Unchecked');

  const parts = [verdictLabel];
  if (simPct !== null) parts.push(`${t(lang, '相似度', 'Similarity')} ${simPct}`);
  if (typeof check.checked === 'number' && check.checked > 0) {
    parts.push(t(lang, `抽查 ${check.matched ?? 0}/${check.checked} 页一致`, `${check.matched ?? 0}/${check.checked} pages matched`));
  }
  if (check.confirmed) {
    parts.push(t(lang, '已人工确认', 'User confirmed'));
  }
  return parts.join(' | ');
}

function buildConfirmationMessage(report: OriginalProbeReport, targetPath: string, lang: UiLanguage, ell: string): string {
  const simPct = `${(Math.round((report.similarity ?? 0) * 1000) / 10).toFixed(1)}%`;
  const shortName = truncatePathMiddle(targetPath, 46, ell);
  if (report.verdict === 'unchecked' || report.reasons?.includes('too-large')) {
    return t(
      lang,
      `文件较大，未能逐页核对全文（verdict: ${report.verdict}）。\n文件: ${shortName}\n仍确认这是同一份资料并关联吗？`,
      `File is too large for full content check (verdict: ${report.verdict}).\nFile: ${shortName}\nConfirm this is the same material and attach anyway?`,
    );
  }
  const pageNote =
    report.pages && report.pages.match === false
      ? t(
          lang,
          `页数不一致（已存 ${report.pages.stored} 页 / 文件 ${report.pages.supplied ?? '?'} 页）`,
          `Page count differs (stored ${report.pages.stored} / file ${report.pages.supplied ?? '?'})`,
        )
      : '';
  const textNote =
    report.checked > 0
      ? t(
          lang,
          `文本核对: verdict=${report.verdict}, 相似度 ${simPct} (${report.matched}/${report.checked} 页匹配)`,
          `Text check: verdict=${report.verdict}, similarity ${simPct} (${report.matched}/${report.checked} pages matched)`,
        )
      : t(lang, `核对结果: verdict=${report.verdict}, 相似度 ${simPct}`, `Check verdict: ${report.verdict}, similarity ${simPct}`);
  const detail = [pageNote, textNote].filter(Boolean).join('\n');
  return t(
    lang,
    `该文件与已保存文本不完全一致：\n${detail}\n仍确认关联为原文件吗？`,
    `Supplied file does not fully match stored text:\n${detail}\nAttach as the original file anyway?`,
  );
}

function localizeOriginalError(message: string, lang: UiLanguage): { text: string; isAudio: boolean } {
  if (/audio transcript has no original file/i.test(message)) {
    return {
      text: t(lang, '音频转写稿没有可关联的原始文件。', 'An audio transcript has no original file to attach.'),
      isAudio: true,
    };
  }
  return { text: message, isAudio: false };
}

function resolveAttachPath(raw: string): string {
  const cleaned = cleanPathInput(raw);
  const expanded = expandHomePath(cleaned);
  if (!expanded) return '';
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export const OriginalFileModal = memo(function OriginalFileModal({
  host,
  item,
  isActive,
  onRefresh,
  onClose,
}: OriginalFileModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const { columns } = useStableWindowSize();

  useInputCapture(isActive);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAudioError, setIsAudioError] = useState(false);
  const [statusInfo, setStatusInfo] = useState<OriginalStatusInfo | null>(null);

  const [subMode, setSubMode] = useState<SubMode>('inspect');
  const [attachField, setAttachField] = useState<AttachField>('path');
  const [pathInput, setPathInput] = useState('');
  const [attachMode, setAttachMode] = useState<AttachMode>('reference');
  const [matches, setMatches] = useState<string[]>([]);
  const [probeReport, setProbeReport] = useState<OriginalProbeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const reqSeqRef = useRef(0);
  const cachedCompletionRef = useRef<{
    input: string;
    completed: string;
    isExactFile: boolean;
    hasMatches: boolean;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const locator = useMemo(
    () => ({
      ...(item.documentId ? { documentId: item.documentId } : {}),
      sourceId: item.sourceIds[0],
    }),
    [item.documentId, item.sourceIds],
  );

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' - ' : ' · ';
  const errMark = asciiMode ? 'x' : '✕';
  const promptGlyph = asciiMode ? '>' : '›';

  const loadStatus = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setLoadError(null);
    setIsAudioError(false);
    try {
      const res = await tryAction<OriginalStatusInfo>(host, 'materials.original.status', locator);
      if (!mountedRef.current || seq !== reqSeqRef.current) return;
      setLoading(false);
      if (!res.ok || !res.value) {
        const localized = localizeOriginalError(
          res.error?.message || t(lang, '读取原文件状态失败', 'Failed to load original file status'),
          lang,
        );
        setStatusInfo(null);
        setLoadError(localized.text);
        setIsAudioError(localized.isAudio);
        return;
      }
      setStatusInfo(res.value);
    } catch (err) {
      if (!mountedRef.current || seq !== reqSeqRef.current) return;
      setLoading(false);
      const localized = localizeOriginalError(errorMessage(err, lang), lang);
      setStatusInfo(null);
      setLoadError(localized.text);
      setIsAudioError(localized.isAudio);
    }
  }, [host, lang, locator]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Pre-fetch path completions when editing the path input in attach sub-mode.
  useEffect(() => {
    if (!isActive || subMode !== 'attach' || attachField !== 'path' || confirmState) return;
    let cancelled = false;
    const cleaned = cleanPathInput(pathInput);
    void completeFsPath(cleaned, { extensions: [...SUPPORTED_EXTS] }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      cachedCompletionRef.current = {
        input: pathInput,
        completed: res.completed,
        isExactFile: res.isExactFile,
        hasMatches: res.matches.length > 0,
      };
      setMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [attachField, confirmState, isActive, pathInput, subMode]);

  const toggleAttachMode = useCallback(() => {
    setAttachMode((prev) => (prev === 'reference' ? 'copy' : 'reference'));
    setActionError(null);
  }, []);

  const enterAttachMode = useCallback(() => {
    setActionError(null);
    setProbeReport(null);
    setAttachField('path');
    setAttachMode(statusInfo?.mode === 'copy' ? 'copy' : 'reference');
    if (!pathInput && statusInfo?.path) {
      setPathInput(statusInfo.path);
    } else if (!pathInput && statusInfo?.convertedFrom?.path) {
      setPathInput(statusInfo.convertedFrom.path);
    }
    setSubMode('attach');
  }, [pathInput, statusInfo]);

  const handleTabOnPath = useCallback(
    (val: string) => {
      if (!val.trim()) {
        toggleAttachMode();
        return undefined;
      }
      const cached = cachedCompletionRef.current;
      if (cached && cached.input === val) {
        if (cached.completed && cached.completed !== val) {
          return cached.completed;
        }
        if (cached.isExactFile || !cached.hasMatches) {
          toggleAttachMode();
          return undefined;
        }
      }
      const cleaned = cleanPathInput(val);
      void completeFsPath(cleaned, { extensions: [...SUPPORTED_EXTS] }).then((res) => {
        if (!mountedRef.current) return;
        cachedCompletionRef.current = {
          input: res.completed,
          completed: res.completed,
          isExactFile: res.isExactFile,
          hasMatches: res.matches.length > 0,
        };
        setMatches(res.matches.slice(0, 6));
        if (res.completed && res.completed !== val) {
          setPathInput(res.completed);
        } else if (res.matches.length === 0 || res.isExactFile) {
          toggleAttachMode();
        }
      });
      return undefined;
    },
    [toggleAttachMode],
  );

  const runProbe = useCallback(async () => {
    if (busyRef.current || busy) return;
    const resolvedPath = resolveAttachPath(pathInput);
    if (!resolvedPath) {
      setActionError(t(lang, '请输入原文件的本地路径', 'Please enter a local file path'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setBusyLabel(t(lang, `正在核对文件内容${ell}`, `Probing original file${ell}`));
    setActionError(null);
    try {
      const res = await tryAction<OriginalProbeReport>(host, 'materials.original.probe', {
        ...locator,
        path: resolvedPath,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setProbeReport(null);
        setActionError(localizeOriginalError(res.error?.message || t(lang, '核对原文件失败', 'Probe failed'), lang).text);
        return;
      }
      setProbeReport(res.value);
    } catch (err) {
      if (mountedRef.current) {
        setProbeReport(null);
        setActionError(localizeOriginalError(errorMessage(err, lang), lang).text);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setBusyLabel(null);
      }
    }
  }, [busy, ell, host, lang, locator, pathInput]);

  const submitAttach = useCallback(
    async (explicitConfirm = false, explicitPath?: string, explicitMode?: AttachMode) => {
      if (busyRef.current || busy) return;
      const resolvedPath = explicitPath ?? resolveAttachPath(pathInput);
      const targetMode = explicitMode ?? attachMode;
      if (!resolvedPath) {
        setActionError(t(lang, '请输入原文件的本地路径', 'Please enter a local file path'));
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setBusyLabel(t(lang, `正在关联原文件${ell}`, `Attaching original file${ell}`));
      setActionError(null);
      try {
        const res = await tryAction<OriginalAttachResponse>(host, 'materials.original.attach', {
          ...locator,
          path: resolvedPath,
          mode: targetMode,
          ...(explicitConfirm ? { confirm: true } : {}),
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          setActionError(localizeOriginalError(res.error?.message || t(lang, '关联原文件失败', 'Attach failed'), lang).text);
          return;
        }
        if (res.value.status === 'needs-confirmation' && res.value.report) {
          setProbeReport(res.value.report);
          setConfirmState({
            kind: 'attach-confirm',
            path: resolvedPath,
            mode: res.value.mode || targetMode,
            report: res.value.report,
          });
          return;
        }
        if (res.value.original) {
          setStatusInfo(res.value.original);
        }
        await onRefresh();
        if (!mountedRef.current) return;
        await loadStatus();
        if (!mountedRef.current) return;
        setSubMode('inspect');
        setProbeReport(null);
        notify(
          targetMode === 'copy'
            ? t(lang, '已将原文件复制到学习库并关联', 'Original copied to library and attached')
            : t(lang, '已关联原文件路径（reference）', 'Original file referenced'),
          'success',
        );
      } catch (err) {
        if (mountedRef.current) {
          setActionError(localizeOriginalError(errorMessage(err, lang), lang).text);
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          setBusyLabel(null);
        }
      }
    },
    [attachMode, busy, ell, host, lang, loadStatus, locator, notify, onRefresh, pathInput],
  );

  const executeDetach = useCallback(async () => {
    if (busyRef.current || busy) return;
    busyRef.current = true;
    setBusy(true);
    setBusyLabel(t(lang, `正在解除原文件关联${ell}`, `Detaching original file${ell}`));
    setActionError(null);
    try {
      const res = await tryAction<{ status?: string }>(host, 'materials.original.detach', locator);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setActionError(localizeOriginalError(res.error?.message || t(lang, '解除关联失败', 'Detach failed'), lang).text);
        return;
      }
      await onRefresh();
      if (!mountedRef.current) return;
      setPathInput('');
      await loadStatus();
      if (!mountedRef.current) return;
      notify(
        t(lang, '已解除原文件关联（磁盘原文件未被删除）', 'Original detached (disk file untouched)'),
        'success',
      );
    } catch (err) {
      if (mountedRef.current) {
        setActionError(localizeOriginalError(errorMessage(err, lang), lang).text);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setBusyLabel(null);
      }
    }
  }, [busy, ell, host, lang, loadStatus, locator, notify, onRefresh]);

  const modalInputActive = isActive && !busy && !confirmState;
  useInput(
    (input, key) => {
      if (!modalInputActive) return;
      if (subMode === 'inspect') {
        if (loading) return;
        if (input === 'r' && !isAudioError) {
          setActionError(null);
          void loadStatus();
        } else if (input === 'a' && !isAudioError && !loadError) {
          enterAttachMode();
        } else if (input === 'd' && !isAudioError && !loadError && statusInfo?.mode) {
          setActionError(null);
          setConfirmState({ kind: 'detach' });
        }
        return;
      }

      // subMode === 'attach'
      if (key.ctrl && input === 'm') {
        toggleAttachMode();
        return;
      }
      if (key.ctrl && input === 'p') {
        void runProbe();
        return;
      }
      if (key.downArrow || key.upArrow || (key.ctrl && input === 'n')) {
        setAttachField((f) => (f === 'path' ? 'mode' : 'path'));
        return;
      }
      if (attachField === 'mode') {
        if (input === 'm' || input === ' ' || key.tab || key.leftArrow || key.rightArrow) {
          toggleAttachMode();
        } else if (input === 'p') {
          void runProbe();
        } else if (key.return) {
          void submitAttach(false);
        }
      }
    },
    { isActive: modalInputActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (loading || busy) {
      return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    }
    if (subMode === 'attach') {
      return [
        { key: 'Enter', label: t(lang, '关联', 'Attach') },
        { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '字段', 'Field') },
        { key: attachField === 'mode' ? 'm/Tab' : 'Tab/Ctrl+M', label: t(lang, '模式', 'Mode') },
        { key: attachField === 'mode' ? 'p' : 'Ctrl+P', label: t(lang, '核对', 'Probe') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (isAudioError || loadError) {
      return [
        ...(!isAudioError ? [{ key: 'r', label: t(lang, '重试', 'Retry') }] : []),
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'a', label: statusInfo?.mode ? t(lang, '更换/关联', 'Attach/Replace') : t(lang, '关联', 'Attach') },
      ...(statusInfo?.mode ? [{ key: 'd', label: t(lang, '解除关联', 'Detach') }] : []),
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [asciiMode, attachField, busy, isAudioError, lang, loadError, loading, statusInfo?.mode, subMode]);

  const frameWidth = Math.max(46, Math.min(76, columns - 4));
  const innerWidth = modalContentWidth(frameWidth);
  const badge = describeStatusBadge(statusInfo, lang);
  const effectiveFormat = (statusInfo?.format || item.format || 'text').toUpperCase();
  const effectivePages = statusInfo?.pages ?? item.pageCount;
  const detectedFmt = importFormatOf(expandHomePath(cleanPathInput(pathInput)));
  const reasonText = statusInfo ? describeReasonText(statusInfo.reason, statusInfo.status, lang) : '';

  return (
    <>
      <Modal
        title={t(lang, '原文件信息与关联', 'Original File')}
        subtitle={item.title}
        icon={asciiMode ? '@' : '◈'}
        width={frameWidth}
        isActive={isActive && !busy && !confirmState}
        onClose={
          subMode === 'inspect'
            ? onClose
            : () => {
                setActionError(null);
                setProbeReport(null);
                setSubMode('inspect');
              }
        }
        hints={hints}
      >
        {loading ? (
          <Box paddingY={1}>
            <Spinner
              label={t(
                lang,
                asciiMode ? '正在读取原文件状态...' : '正在读取原文件状态…',
                asciiMode ? 'Loading original file status...' : 'Loading original file status…',
              )}
              active={isActive && !confirmState}
            />
          </Box>
        ) : loadError ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color={isAudioError ? theme.warning : theme.error} bold>
              {`${isAudioError ? '!' : errMark} ${loadError}`}
            </Text>
            <Box marginTop={1}>
              <Text color={theme.muted}>
                {isAudioError
                  ? t(lang, '按 [Esc] 关闭此窗口。', 'Press [Esc] to close.')
                  : t(lang, '按 [r] 重试，或按 [Esc] 关闭。', 'Press [r] to retry or [Esc] to close.')}
              </Text>
            </Box>
          </Box>
        ) : subMode === 'inspect' && statusInfo ? (
          <Box flexDirection="column" width={innerWidth}>
            <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
              <Badge label={effectiveFormat} tone="accent" variant="soft" />
              <Text> </Text>
              <Badge label={badge.label} tone={badge.tone} variant="solid" />
              <Text> </Text>
              <Badge
                label={statusInfo.mode ? statusInfo.mode : t(lang, '无模式', 'none')}
                tone={statusInfo.mode ? 'info' : 'muted'}
                variant="outline"
              />
            </Box>

            <Text color={theme.muted}>
              {t(lang, '关联方式: ', 'Mode: ')}
              <Text color={theme.text}>{describeModeText(statusInfo.mode, lang)}</Text>
            </Text>

            {statusInfo.path ? (
              <Text color={theme.muted}>
                {t(lang, '文件路径: ', 'Path: ')}
                <Text color={theme.text}>
                  {truncatePathMiddle(statusInfo.path, Math.max(16, innerWidth - 10), ell)}
                </Text>
              </Text>
            ) : null}

            <Text color={theme.muted}>
              {t(lang, '文件大小: ', 'Size: ')}
              <Text color={theme.text}>{formatBytes(statusInfo.bytes)}</Text>
              <Text color={theme.dim}>{sep}</Text>
              {t(lang, '页数: ', 'Pages: ')}
              <Text color={theme.text}>{String(effectivePages)}</Text>
              <Text color={theme.dim}>{sep}</Text>
              {t(lang, '核验: ', 'Verified: ')}
              <Text color={theme.text}>{formatShortTime(statusInfo.verifiedAt)}</Text>
            </Text>

            {statusInfo.check ? (
              <Text color={theme.muted}>
                {t(lang, '核验记录: ', 'Check: ')}
                <Text color={statusInfo.check.verdict === 'mismatch' ? theme.warning : theme.success}>
                  {truncateDisplay(describeVerdictText(statusInfo.check, lang), Math.max(16, innerWidth - 10), ell)}
                </Text>
              </Text>
            ) : null}

            {reasonText ? (
              <Box marginTop={1}>
                <Text color={theme.warning}>{`! ${truncateDisplay(reasonText, Math.max(16, innerWidth - 2), ell)}`}</Text>
              </Box>
            ) : null}

            {statusInfo.convertedFrom ? (
              <Box marginTop={1} flexDirection="column">
                <Text color={theme.info}>
                  {truncateDisplay(
                    t(
                      lang,
                      `转换来源: ${statusInfo.convertedFrom.filename || statusInfo.convertedFrom.path} (${formatBytes(statusInfo.convertedFrom.bytes)})`,
                      `Converted from: ${statusInfo.convertedFrom.filename || statusInfo.convertedFrom.path} (${formatBytes(statusInfo.convertedFrom.bytes)})`,
                    ),
                    innerWidth,
                    ell,
                  )}
                </Text>
              </Box>
            ) : null}

            <Box marginTop={1}>
              <Text color={theme.dim}>
                {t(
                  lang,
                  '仅管理原文件关联，不改动已提取文字、引用锚点或题卡。',
                  'Manages original attachment only; stored text, citations, and cards stay intact.',
                )}
              </Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" width={innerWidth}>
            <Box flexDirection="row" alignItems="center">
              <Text color={attachField === 'mode' ? theme.primary : theme.muted} bold={attachField === 'mode'}>
                {t(lang, '保存方式: ', 'Mode: ')}
              </Text>
              <Badge
                label={`1. reference ${t(lang, '(仅引用)', '(path)')}`}
                tone={attachMode === 'reference' ? 'primary' : 'muted'}
                variant={attachMode === 'reference' ? 'solid' : 'outline'}
              />
              <Text> </Text>
              <Badge
                label={`2. copy ${t(lang, '(复制入库)', '(copy)')}`}
                tone={attachMode === 'copy' ? 'primary' : 'muted'}
                variant={attachMode === 'copy' ? 'solid' : 'outline'}
              />
            </Box>

            <Box marginBottom={1}>
              <Text color={theme.dim}>
                {attachMode === 'reference'
                  ? t(lang, '仅记忆磁盘路径，不复制文件、无大小上限。', 'Stores path reference only; no copy and no size cap.')
                  : t(lang, '复制一份到学习库内部存储（文件移动后仍可用）。', 'Copies file into library storage (survives external moves).')}
              </Text>
            </Box>

            <Box flexDirection="row" justifyContent="space-between">
              <Text color={attachField === 'path' ? theme.primary : theme.muted} bold={attachField === 'path'}>
                {t(lang, '本地原文件路径:', 'Original File Path:')}
              </Text>
              {detectedFmt ? <Badge label={detectedFmt.toUpperCase()} tone="success" variant="soft" /> : null}
            </Box>

            <TextInput
              value={pathInput}
              onChange={(val) => {
                setPathInput(val);
                setActionError(null);
              }}
              onTab={handleTabOnPath}
              onSubmit={() => void submitAttach(false)}
              onCancel={() => {
                setActionError(null);
                setProbeReport(null);
                setSubMode('inspect');
              }}
              placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\book.pdf' : '~/Documents/material.pdf'}
              width={Math.max(20, innerWidth - 4)}
              isActive={modalInputActive && attachField === 'path'}
              prompt={promptGlyph}
            />

            {matches.length > 0 && attachField === 'path' ? (
              <Text color={theme.dim}>
                {truncateDisplay(`${t(lang, '补全:', 'Matches:')} ${matches.join('  ')}`, innerWidth, ell)}
              </Text>
            ) : null}

            <Box marginTop={1}>
              <Text color={attachField === 'mode' ? theme.primary : theme.dim}>
                {attachField === 'mode'
                  ? t(
                      lang,
                      `${asciiMode ? '>' : '›'} 已聚焦操作栏: [m/Space] 切换方式  [p] 核对文件  [Enter] 关联`,
                      `${asciiMode ? '>' : '›'} Actions focused: [m/Space] toggle mode  [p] probe  [Enter] attach`,
                    )
                  : t(
                      lang,
                      `按 [${asciiMode ? 'Down' : '↓'}] 切换方式/核对，或直接 [Enter] 关联。`,
                      `Press [${asciiMode ? 'Down' : '↓'}] to switch mode / probe, or [Enter] to attach.`,
                    )}
              </Text>
            </Box>

            {probeReport ? (
              <Box marginTop={1} flexDirection="column">
                <Text color={probeReport.accepted ? theme.success : theme.warning} bold>
                  {truncateDisplay(
                    `${t(lang, '核对结果', 'Probe')}: ${describeVerdictText(probeReport, lang)}`,
                    innerWidth,
                    ell,
                  )}
                </Text>
                {!probeReport.accepted ? (
                  <Text color={theme.warning}>
                    {t(
                      lang,
                      '! 文件与已存文本存在差异，按 [Enter] 提交后将弹出二次确认。',
                      '! Content mismatch detected; submitting will prompt for confirmation.',
                    )}
                  </Text>
                ) : null}
              </Box>
            ) : null}
          </Box>
        )}

        {busy ? (
          <Box marginTop={1}>
            <Spinner label={busyLabel ?? t(lang, `处理中${ell}`, `Working${ell}`)} active={isActive && !confirmState} />
          </Box>
        ) : null}

        {actionError ? (
          <Box marginTop={1}>
            <Text color={theme.error} wrap="wrap">{`${errMark} ${actionError}`}</Text>
          </Box>
        ) : null}
      </Modal>

      {confirmState?.kind === 'detach' ? (
        <ConfirmDialog
          title={t(lang, '解除原文件关联', 'Detach Original File')}
          message={t(
            lang,
            `确定解除「${item.title}」的原文件关联吗？\n仅解除与学习库的关联，不会删除磁盘上的原始文件。`,
            `Detach original file from "${item.title}"?\nUnlinks from library only; your file on disk is never deleted.`,
          )}
          confirmLabel={t(lang, '确认解除', 'Detach')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={Math.min(64, Math.max(44, columns - 4))}
          isActive={isActive && confirmState.kind === 'detach'}
          onConfirm={() => {
            setConfirmState(null);
            void executeDetach();
          }}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}

      {confirmState?.kind === 'attach-confirm' ? (
        <ConfirmDialog
          title={t(lang, '确认关联原文件', 'Confirm Original Attachment')}
          message={buildConfirmationMessage(confirmState.report, confirmState.path, lang, ell)}
          confirmLabel={t(lang, '仍要关联', 'Attach Anyway')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={Math.min(68, Math.max(46, columns - 4))}
          isActive={isActive && confirmState.kind === 'attach-confirm'}
          onConfirm={() => {
            const targetPath = confirmState.path;
            const targetMode = confirmState.mode;
            setConfirmState(null);
            void submitAttach(true, targetPath, targetMode);
          }}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}
    </>
  );
});
