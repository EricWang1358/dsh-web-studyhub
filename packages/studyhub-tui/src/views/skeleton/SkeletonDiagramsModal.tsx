import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { ScrollView } from '../../components/ScrollView.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { cleanPathInput, errorMessage } from '../../host/sample-actions.js';
import { expandHomePath } from '../sources/path-complete.js';

export const MAX_DIAGRAMS = 8;

export interface SkeletonDiagramSummary {
  id: string;
  title: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  skeletonRevision?: string;
  stale: boolean;
}

export interface SkeletonDiagramDetail extends SkeletonDiagramSummary {
  html: string;
  file: string;
}

export interface SkeletonDiagramsModalProps {
  host: HostClient;
  skeletonId: string;
  skeletonTitle: string;
  isActive: boolean;
  onClose: () => void;
  onCountChange?: (count: number) => void;
}

type ModalMode = 'list' | 'attach' | 'inspect';
type AttachField = 'path' | 'title';

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateShort(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractHtmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 65536));
  if (!match) return '';
  return decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
}

function stripHtmlToPreview(html: string, maxChars = 4000): string {
  const headSlice = html.slice(0, 65536);
  const withoutNoise = headSlice
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '\n');
  const withBreaks = withoutNoise
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote|svg|title)>/gi, '\n');
  const stripped = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ' '));
  const normalizedLines = stripped
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0));
  const joined = normalizedLines.slice(0, 120).join('\n').trim();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n...`;
}

export const SkeletonDiagramsModal = memo(function SkeletonDiagramsModal({
  host,
  skeletonId,
  skeletonTitle,
  isActive,
  onClose,
  onCountChange,
}: SkeletonDiagramsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows } = useWindowSize();

  const [mode, setMode] = useState<ModalMode>('list');
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState('');
  const [diagrams, setDiagrams] = useState<SkeletonDiagramSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [detailById, setDetailById] = useState<Record<string, SkeletonDiagramDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [attachPath, setAttachPath] = useState('');
  const [attachTitle, setAttachTitle] = useState('');
  const [attachField, setAttachField] = useState<AttachField>('path');
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState('');

  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const listReqRef = useRef(0);
  const detailReqRef = useRef(0);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load diagram list on open / refresh / skeletonId change
  useEffect(() => {
    if (!isActive || !skeletonId) return;
    let cancelled = false;
    const reqId = ++listReqRef.current;
    setLoadingList(true);
    setListError('');

    host
      .call<{ diagrams?: SkeletonDiagramSummary[] }>('skeleton.diagram.list', { id: skeletonId })
      .then((res) => {
        if (cancelled || !mountedRef.current || listReqRef.current !== reqId) return;
        if (!res.ok) {
          setDiagrams([]);
          setListError(errorMessage(res.error, lang) || t(lang, '加载互动图表列表失败', 'Failed to load diagrams'));
          return;
        }
        const list = Array.isArray(res.value?.diagrams) ? res.value.diagrams : [];
        setDiagrams(list);
        onCountChangeRef.current?.(list.length);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current || listReqRef.current !== reqId) return;
        setDiagrams([]);
        setListError(errorMessage(err, lang));
      })
      .finally(() => {
        if (!cancelled && mountedRef.current && listReqRef.current === reqId) {
          setLoadingList(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [host, skeletonId, isActive, reloadSeq, lang]);

  useEffect(() => {
    if (selectedIndex >= diagrams.length) {
      setSelectedIndex(Math.max(0, diagrams.length - 1));
    }
  }, [diagrams.length, selectedIndex]);

  const selectedDiagram = diagrams[selectedIndex] ?? null;
  const cachedDetail = selectedDiagram ? detailById[selectedDiagram.id] : undefined;
  const hasMatchingDetail = Boolean(
    selectedDiagram &&
      cachedDetail &&
      cachedDetail.sha256 === selectedDiagram.sha256 &&
      cachedDetail.stale === selectedDiagram.stale,
  );

  // Automatically fetch selected diagram details via skeleton.diagram.get
  useEffect(() => {
    if (!isActive || !skeletonId || !selectedDiagram) {
      setDetailError('');
      setLoadingDetail(false);
      return;
    }
    if (hasMatchingDetail) {
      setDetailError('');
      setLoadingDetail(false);
      return;
    }

    let cancelled = false;
    const reqId = ++detailReqRef.current;
    setLoadingDetail(true);
    setDetailError('');

    host
      .call<SkeletonDiagramDetail>('skeleton.diagram.get', {
        id: skeletonId,
        diagramId: selectedDiagram.id,
      })
      .then((res) => {
        if (cancelled || !mountedRef.current || detailReqRef.current !== reqId) return;
        if (!res.ok || !res.value) {
          setDetailError(errorMessage(res.error, lang) || t(lang, '读取图表内容失败', 'Failed to read diagram'));
          return;
        }
        const val = res.value;
        setDetailById((prev) => ({ ...prev, [val.id]: val }));
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current || detailReqRef.current !== reqId) return;
        setDetailError(errorMessage(err, lang));
      })
      .finally(() => {
        if (!cancelled && mountedRef.current && detailReqRef.current === reqId) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [host, skeletonId, selectedDiagram, hasMatchingDetail, isActive, lang]);

  const triggerRefresh = useCallback(() => {
    if (busyRef.current) return;
    setDetailById({});
    setDetailError('');
    setReloadSeq((n) => n + 1);
  }, []);

  const handleAttach = useCallback(async () => {
    if (busyRef.current || attaching) return;
    const cleaned = expandHomePath(cleanPathInput(attachPath));
    if (!cleaned) {
      setAttachError(t(lang, '请输入 UTF-8 HTML 文件路径', 'Please enter a UTF-8 HTML file path'));
      setAttachField('path');
      return;
    }

    busyRef.current = true;
    setAttaching(true);
    setAttachError('');
    try {
      const customTitle = attachTitle.trim();
      const res = await host.call<{
        diagram?: SkeletonDiagramSummary;
        unchanged?: boolean;
        rotated?: Array<{ id: string; title: string }>;
        notice?: string;
      }>('skeleton.diagram.attach', {
        id: skeletonId,
        path: cleaned,
        workspace: process.cwd(),
        ...(customTitle ? { title: customTitle } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setAttachError(errorMessage(res.error, lang) || t(lang, '挂载图表失败', 'Failed to attach diagram'));
        return;
      }

      const { diagram, unchanged, notice } = res.value;
      if (notice) {
        useTuiStore.getState().notify(notice, 'info');
      } else if (unchanged) {
        useTuiStore
          .getState()
          .notify(
            t(lang, `图表「${diagram?.title ?? ''}」已存在（内容未变化）`, `Diagram "${diagram?.title ?? ''}" already attached (unchanged)`),
            'info',
          );
      } else {
        useTuiStore
          .getState()
          .notify(
            t(lang, `已挂载图表「${diagram?.title ?? ''}」`, `Attached diagram "${diagram?.title ?? ''}"`),
            'success',
          );
      }

      setAttachPath('');
      setAttachTitle('');
      setAttachField('path');
      setSelectedIndex(0);
      setMode('list');
      setDetailById({});
      setReloadSeq((n) => n + 1);
    } catch (err) {
      if (mountedRef.current) {
        setAttachError(errorMessage(err, lang));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setAttaching(false);
    }
  }, [attaching, attachPath, attachTitle, host, skeletonId, lang]);

  const removeSelectedDiagram = useCallback(async () => {
    const target = selectedDiagram;
    if (!target || busyRef.current || removing) return;
    busyRef.current = true;
    setRemoving(true);
    try {
      const res = await host.call<{ removed?: string }>('skeleton.diagram.remove', {
        id: skeletonId,
        diagramId: target.id,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        useTuiStore
          .getState()
          .notify(errorMessage(res.error, lang) || t(lang, '移除图表失败', 'Failed to remove diagram'), 'error');
        return;
      }

      setDetailById((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      if (mode === 'inspect') setMode('list');
      setReloadSeq((n) => n + 1);
      useTuiStore
        .getState()
        .notify(t(lang, `已移除图表「${target.title}」`, `Removed diagram "${target.title}"`), 'success');
    } catch (err) {
      if (mountedRef.current) {
        useTuiStore.getState().notify(errorMessage(err, lang), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setRemoving(false);
    }
  }, [selectedDiagram, removing, host, skeletonId, lang, mode]);

  const handleClose = useCallback(() => {
    if (confirmRemoveOpen) {
      setConfirmRemoveOpen(false);
      return;
    }
    if (mode === 'attach') {
      if (!attaching) {
        setMode('list');
        setAttachError('');
      }
      return;
    }
    if (mode === 'inspect') {
      setMode('list');
      return;
    }
    onClose();
  }, [confirmRemoveOpen, mode, attaching, onClose]);

  useInput(
    (input, key) => {
      if (!isActive || confirmRemoveOpen || removing) return;
      if (mode === 'attach') {
        if (attaching) return;
        if (key.ctrl && input === 's') {
          void handleAttach();
          return;
        }
        if (key.tab || key.upArrow || key.downArrow) {
          setAttachField((f) => (f === 'path' ? 'title' : 'path'));
        }
        return;
      }
      if (loadingList) return;
      if (mode === 'inspect') {
        if (input === 'b' || input === 'q') {
          setMode('list');
          return;
        }
        if (input === 'd' && selectedDiagram && !busyRef.current) {
          setConfirmRemoveOpen(true);
          return;
        }
        if (input === 'r') {
          triggerRefresh();
        }
        return;
      }
      if (input === 'a') {
        setAttachError('');
        setAttachField('path');
        setMode('attach');
        return;
      }
      if (input === 'd' && selectedDiagram && !busyRef.current) {
        setConfirmRemoveOpen(true);
        return;
      }
      if (input === 'r') {
        triggerRefresh();
      }
    },
    { isActive: isActive && !confirmRemoveOpen },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (mode === 'attach') {
      return [
        { key: 'Tab', label: t(lang, '切换字段', 'Field') },
        { key: 'Enter', label: t(lang, '挂载', 'Attach') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (mode === 'inspect') {
      return [
        { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
        { key: 'd', label: t(lang, '移除', 'Remove') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    return [
      { key: 'a', label: t(lang, '挂载HTML', 'Attach') },
      ...(selectedDiagram
        ? [
            { key: 'Enter', label: t(lang, '详情', 'Inspect') },
            { key: 'd', label: t(lang, '移除', 'Remove') },
          ]
        : []),
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [lang, mode, selectedDiagram]);

  const frameW = Math.max(46, Math.min(92, columns - 4));
  const frameH = Math.max(14, Math.min(24, rows - 2));
  const innerW = modalContentWidth(frameW);
  const innerH = Math.max(8, frameH - 5);
  const inputW = Math.max(12, innerW - 4);
  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' | ' : ' · ';
  const hRule = (asciiMode ? '-' : '─').repeat(Math.max(4, innerW));
  const warnSym = asciiMode ? '[!]' : '⚠';

  const activeDetail = hasMatchingDetail ? cachedDetail : undefined;
  const previewText = useMemo(() => {
    if (!selectedDiagram) return '';
    if (loadingDetail && !activeDetail) {
      return t(lang, '正在读取图表详情...', 'Loading diagram details...');
    }
    if (detailError) {
      return `${warnSym} ${detailError}`;
    }
    const d = activeDetail ?? selectedDiagram;
    const html = activeDetail?.html ?? '';
    const htmlTitle = html ? extractHtmlTitle(html) : '';
    const snippet = html ? stripHtmlToPreview(html) : '';
    const lines: string[] = [];
    lines.push(`${d.title}${d.stale ? ` ${t(lang, '[需更新]', '[stale]')}` : ''}`);
    if (d.stale) {
      lines.push(`${warnSym} ${t(lang, '骨架已于挂载后更新，此图表可能已过时', 'Skeleton updated since attach; diagram may be stale')}`);
    }
    if (activeDetail?.file) {
      lines.push(`${t(lang, '文件', 'File')}: ${activeDetail.file}`);
    }
    lines.push(
      `${t(lang, '大小', 'Size')}: ${formatBytes(d.bytes)} (${d.bytes} B)${sep}SHA256: ${d.sha256.slice(0, 12)}`,
    );
    const dateStr = formatDateShort(d.createdAt);
    if (dateStr) {
      lines.push(`${t(lang, '挂载日期', 'Attached')}: ${dateStr}`);
    }
    if (html) {
      lines.push(`${t(lang, 'HTML <title>', 'HTML <title>')}: ${htmlTitle || t(lang, '(无)', '(none)')}`);
      lines.push('---');
      lines.push(snippet || t(lang, '(HTML 正文无纯文本内容)', '(No visible plain text in HTML body)'));
    }
    return lines.join('\n');
  }, [selectedDiagram, loadingDetail, activeDetail, detailError, lang, warnSym, sep]);

  const renderDiagramRow = useCallback(
    (item: SkeletonDiagramSummary, ctx: VirtualListRenderContext) => {
      const pointer = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      const staleTag = item.stale ? ` ${t(lang, '[需更新]', '[stale]')}` : '';
      const dateStr = formatDateShort(item.createdAt);
      const meta = `${formatBytes(item.bytes)}${dateStr ? ` ${dateStr}` : ''}${staleTag}`;
      const prefix = `${pointer} `;
      const rightW = displayWidth(meta) + 1;
      const titleAvail = Math.max(6, ctx.width - displayWidth(prefix) - rightW);
      const titleText = padDisplay(truncateDisplay(item.title, titleAvail, ell), titleAvail);
      return (
        <Box width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
            {prefix}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {titleText}
          </Text>
          <Text color={item.stale ? theme.warning : theme.muted}>{` ${meta}`}</Text>
        </Box>
      );
    },
    [asciiMode, ell, lang, theme],
  );

  const sideBySide = innerW >= 78;
  const bodyH = Math.max(5, innerH - 2);
  const leftW = sideBySide ? Math.max(30, Math.floor(innerW * 0.44)) : innerW;
  const rightW = sideBySide ? Math.max(24, innerW - leftW - 1) : innerW;
  const stackedListH = Math.min(5, Math.max(3, diagrams.length));
  const stackedPreviewH = Math.max(4, bodyH - stackedListH - 1);

  return (
    <>
      <Modal
        title={t(lang, `互动图表 (${diagrams.length}/${MAX_DIAGRAMS})`, `Diagrams (${diagrams.length}/${MAX_DIAGRAMS})`)}
        subtitle={skeletonTitle}
        icon={asciiMode ? '[]' : '◈'}
        width={frameW}
        height={frameH}
        isActive={isActive && !confirmRemoveOpen}
        onClose={handleClose}
        hints={hints}
      >
        <Box flexDirection="column" width={innerW} height={innerH}>
          {/* Inner header line */}
          <Box height={1} width={innerW} justifyContent="space-between" overflow="hidden">
            <Text color={theme.text} bold>
              {truncateDisplay(
                mode === 'attach'
                  ? t(lang, '挂载本地 HTML 互动图', 'Attach Local HTML Diagram')
                  : mode === 'inspect' && selectedDiagram
                    ? `${t(lang, '图表详情', 'Inspect')}: ${selectedDiagram.title}`
                    : `${skeletonTitle} (${diagrams.length}/${MAX_DIAGRAMS})`,
                Math.max(12, innerW - 18),
                ell,
              )}
            </Text>
            <Text color={diagrams.length >= MAX_DIAGRAMS ? theme.warning : theme.muted}>
              {removing
                ? t(lang, '移除中...', 'Removing...')
                : t(lang, `上限 ${MAX_DIAGRAMS} 张`, `Max ${MAX_DIAGRAMS}`)}
            </Text>
          </Box>
          <Box height={1} width={innerW} overflow="hidden">
            <Text color={theme.border}>{hRule}</Text>
          </Box>

          {mode === 'attach' ? (
            <Box flexDirection="column" width={innerW} height={bodyH}>
              <Box height={1} width={innerW} overflow="hidden">
                <Text color={attachField === 'path' ? theme.primary : theme.muted} bold={attachField === 'path'}>
                  {t(lang, 'HTML 文件路径 (UTF-8 HTML <= 5 MB):', 'HTML File Path (UTF-8 HTML <= 5 MB):')}
                </Text>
              </Box>
              <Box height={1} width={innerW} overflow="hidden">
                <TextInput
                  value={attachPath}
                  onChange={(v) => {
                    setAttachError('');
                    setAttachPath(v);
                  }}
                  onSubmit={() => void handleAttach()}
                  placeholder={t(lang, '输入 .html 文件路径 (如 ./diagrams/map.html)', 'Enter .html path (e.g. ./diagrams/map.html)')}
                  width={inputW}
                  prompt={asciiMode ? '>' : '›'}
                  isActive={isActive && !confirmRemoveOpen && mode === 'attach' && !attaching && attachField === 'path'}
                />
              </Box>
              <Box height={1} width={innerW} marginTop={1} overflow="hidden">
                <Text color={attachField === 'title' ? theme.primary : theme.muted} bold={attachField === 'title'}>
                  {t(lang, '自定义标题 (可选，留空自动提取 <title>):', 'Title (optional; blank uses HTML <title>):')}
                </Text>
              </Box>
              <Box height={1} width={innerW} overflow="hidden">
                <TextInput
                  value={attachTitle}
                  onChange={(v) => {
                    setAttachError('');
                    setAttachTitle(v);
                  }}
                  onSubmit={() => void handleAttach()}
                  placeholder={t(lang, '留空自动提取 <title> 或文件名', 'Blank uses HTML <title> or filename')}
                  width={inputW}
                  maxLength={80}
                  prompt={asciiMode ? '>' : '›'}
                  isActive={isActive && !confirmRemoveOpen && mode === 'attach' && !attaching && attachField === 'title'}
                />
              </Box>
              <Box width={innerW} marginTop={1}>
                {attaching ? (
                  <Spinner label={t(lang, '正在校验并挂载图表...', 'Validating and attaching diagram...')} active={isActive} />
                ) : attachError ? (
                  <Text color={theme.error} wrap="wrap">{attachError}</Text>
                ) : (
                  <Text color={theme.dim}>
                    {truncateDisplay(
                      t(
                        lang,
                        '仅接受 UTF-8 HTML (<= 5 MB)，路径须位于当前目录或学习库内；Tab 切换字段，Enter 提交',
                        'UTF-8 HTML (<= 5 MB) inside cwd or library; Tab switch field, Enter submit',
                      ),
                      innerW,
                      ell,
                    )}
                  </Text>
                )}
              </Box>
            </Box>
          ) : loadingList ? (
            <Box height={bodyH} width={innerW} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, '正在加载互动图表...', 'Loading interactive diagrams...')} active={isActive} />
            </Box>
          ) : listError ? (
            <Box height={bodyH} width={innerW} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
              <Text color={theme.error} bold>
                {t(lang, '加载图表列表失败', 'Failed to load diagram list')}
              </Text>
              <Text color={theme.muted} wrap="wrap">{listError}</Text>
            </Box>
          ) : diagrams.length === 0 ? (
            <EmptyState
              icon={asciiMode ? '[]' : '◈'}
              title={t(lang, '尚未挂载互动图表', 'No interactive diagrams attached')}
              hint={t(
                lang,
                `按 [a] 挂载 UTF-8 HTML (<= 5 MB)，每个骨架最多保留 ${MAX_DIAGRAMS} 张`,
                `Press [a] to attach UTF-8 HTML (<= 5 MB), max ${MAX_DIAGRAMS} per skeleton`,
              )}
              actions={[
                { key: 'a', label: t(lang, '挂载HTML', 'Attach') },
                { key: 'r', label: t(lang, '刷新', 'Refresh') },
              ]}
              width={innerW}
              height={bodyH}
            />
          ) : mode === 'inspect' ? (
            <ScrollView
              content={previewText}
              width={innerW}
              height={bodyH}
              isActive={isActive && !confirmRemoveOpen && mode === 'inspect'}
              ascii={asciiMode}
            />
          ) : sideBySide ? (
            <Box flexDirection="row" width={innerW} height={bodyH}>
              <Box width={leftW} height={bodyH} overflow="hidden" flexShrink={0}>
                <VirtualList
                  items={diagrams}
                  width={leftW}
                  height={bodyH}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  onSelect={() => setMode('inspect')}
                  isActive={isActive && !confirmRemoveOpen && mode === 'list'}
                  keyExtractor={(item) => item.id}
                  renderItem={renderDiagramRow}
                  ascii={asciiMode}
                />
              </Box>
              <Box width={1} height={bodyH} flexDirection="column" flexShrink={0}>
                {Array.from({ length: bodyH }, (_, i) => (
                  <Text key={i} color={theme.border}>
                    {asciiMode ? '|' : '│'}
                  </Text>
                ))}
              </Box>
              <Box width={rightW} height={bodyH} overflow="hidden" flexShrink={0}>
                <ScrollView
                  content={previewText}
                  width={rightW}
                  height={bodyH}
                  isActive={false}
                  ascii={asciiMode}
                />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" width={innerW} height={bodyH}>
              <VirtualList
                items={diagrams}
                width={innerW}
                height={stackedListH}
                selectedIndex={selectedIndex}
                onChange={(idx) => setSelectedIndex(idx)}
                onSelect={() => setMode('inspect')}
                isActive={isActive && !confirmRemoveOpen && mode === 'list'}
                keyExtractor={(item) => item.id}
                renderItem={renderDiagramRow}
                ascii={asciiMode}
              />
              <Box height={1} width={innerW} overflow="hidden">
                <Text color={theme.border}>{hRule}</Text>
              </Box>
              <ScrollView
                content={previewText}
                width={innerW}
                height={stackedPreviewH}
                isActive={false}
                ascii={asciiMode}
              />
            </Box>
          )}
        </Box>
      </Modal>

      {confirmRemoveOpen && selectedDiagram ? (
        <ConfirmDialog
          title={t(lang, '确认移除互动图表', 'Remove Interactive Diagram')}
          message={t(
            lang,
            `确定从骨架「${skeletonTitle}」中移除图表「${selectedDiagram.title}」吗？学习库中的存储副本也会一并删除。`,
            `Remove diagram "${selectedDiagram.title}" from skeleton "${skeletonTitle}"? Its stored file copy will be deleted.`,
          )}
          confirmLabel={t(lang, '确认移除', 'Remove')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          width={Math.min(60, Math.max(40, columns - 6))}
          isActive={isActive}
          onConfirm={() => {
            setConfirmRemoveOpen(false);
            void removeSelectedDiagram();
          }}
          onCancel={() => setConfirmRemoveOpen(false)}
        />
      ) : null}
    </>
  );
});
