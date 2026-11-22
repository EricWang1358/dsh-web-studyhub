import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  Spinner,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';

export interface ReaderOutlineDrawerProps {
  host: HostClient;
  documentId?: string;
  sourceId?: string;
  revision?: string;
  title?: string;
  currentPage: number;
  currentPageText?: string;
  width: number;
  height: number;
  isActive: boolean;
  onJumpPage: (page: number) => void;
  onClose: () => void;
}

interface OutlineEntryRow {
  id: string;
  title: string;
  level: number;
  page: number;
  sourceId?: string;
  startBlock?: number;
  kind?: 'quoted' | 'label' | 'heading';
}

interface ProposedOutline {
  entries: Array<{
    title: string;
    level: number;
    startBlock: number;
    kind?: 'quoted' | 'label';
    anchor?: { sourceId?: string; offset?: number; quote?: string; ordinal?: number };
  }>;
  warnings: string[];
  usage?: Record<string, unknown>;
  coverage?: { blocks?: number; units?: number; chars?: number; condensed?: boolean; sources?: number };
}

interface RawDocSource {
  id?: string;
  text?: string;
  document?: { page?: number };
}

interface RawOutlineEntry {
  title?: string;
  level?: number;
  startBlock?: number;
  kind?: 'quoted' | 'label';
  anchor?: { sourceId?: string; offset?: number; quote?: string; ordinal?: number };
}

const HEADING_RE = /^ {0,3}(#{1,4})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(?:```|~~~)/;

function extractMarkdownHeadings(text: string, page: number, sid?: string): OutlineEntryRow[] {
  const rows: OutlineEntryRow[] = [];
  let inFence = false;
  let seq = 0;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const title = m[2].replace(/\s+/g, ' ').trim();
    if (!title) continue;
    seq += 1;
    rows.push({
      id: `md-${page}-${seq}`,
      title,
      level: Math.min(3, m[1].length),
      page,
      ...(sid ? { sourceId: sid } : {}),
      kind: 'heading',
    });
  }
  return rows;
}

function buildSourcePageMap(sources: RawDocSource[]): Map<string, number> {
  const map = new Map<string, number>();
  sources.forEach((src, idx) => {
    if (!src.id) return;
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    map.set(src.id, pg);
  });
  return map;
}

function formatEstimateSummary(
  lang: 'zh' | 'en',
  coverage?: { blocks?: number; units?: number; chars?: number },
  estimate?: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if (coverage) {
    parts.push(
      t(
        lang,
        `共 ${coverage.blocks ?? coverage.units ?? 0} 段 / ${coverage.chars ?? 0} 字`,
        `${coverage.blocks ?? coverage.units ?? 0} blocks / ${coverage.chars ?? 0} chars`,
      ),
    );
  }
  if (estimate) {
    const inTok = typeof estimate.inputTokens === 'number' ? estimate.inputTokens : undefined;
    const outTok = typeof estimate.outputTokens === 'number' ? estimate.outputTokens : undefined;
    if (inTok !== undefined) {
      parts.push(
        outTok !== undefined
          ? `~${inTok}+${outTok} tokens`
          : `~${inTok} tokens`,
      );
    }
  }
  return parts.join(' · ');
}

export const ReaderOutlineDrawer = memo(function ReaderOutlineDrawer({
  host,
  documentId,
  sourceId,
  revision,
  title,
  currentPage,
  currentPageText,
  width,
  height,
  isActive,
  onJumpPage,
  onClose,
}: ReaderOutlineDrawerProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<OutlineEntryRow[]>([]);
  const [outlineOrigin, setOutlineOrigin] = useState<'ai' | 'headings' | 'none'>('none');
  const [proposal, setProposal] = useState<ProposedOutline | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusNotice, setStatusNotice] = useState<{ text: string; tone: 'info' | 'warning' | 'error' | 'success' } | null>(null);

  const [resolvedDocId, setResolvedDocId] = useState<string | undefined>(documentId);
  const [resolvedRevision, setResolvedRevision] = useState<string | undefined>(revision);
  const [sourcePageMap, setSourcePageMap] = useState<Map<string, number>>(() => new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Memory NFR: clear cached outline rows/proposals on unmount.
      setEntries([]);
      setProposal(null);
      setSourcePageMap(new Map());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatusNotice(null);
    setProposal(null);

    const loadOutline = async () => {
      const hasId = Boolean(documentId || sourceId);
      if (hasId) {
        const res = await tryAction<Record<string, unknown>>(host, 'materials.document.get', {
          ...(documentId ? { documentId } : {}),
          ...(sourceId ? { sourceId } : {}),
          ...(revision ? { revision } : {}),
        });
        if (cancelled || !mountedRef.current) return;

        if (res.ok && res.value) {
          const val = res.value;
          const docId = typeof val.documentId === 'string' ? val.documentId : typeof val.id === 'string' ? val.id : documentId;
          const rev = typeof val.revision === 'string' ? val.revision : typeof val.currentRevision === 'string' ? val.currentRevision : revision;
          const sources = Array.isArray(val.sources) ? (val.sources as RawDocSource[]) : [];
          const pageMap = buildSourcePageMap(sources);

          setResolvedDocId(docId);
          setResolvedRevision(rev);
          setSourcePageMap(pageMap);

          const outlineObj = val.outline as { entries?: RawOutlineEntry[] } | undefined;
          if (outlineObj && Array.isArray(outlineObj.entries) && outlineObj.entries.length > 0) {
            const mapped: OutlineEntryRow[] = outlineObj.entries.map((entry, idx) => ({
              id: `ai-${idx}`,
              title: String(entry.title ?? ''),
              level: Number(entry.level) || 1,
              page: entry.anchor?.sourceId ? (pageMap.get(entry.anchor.sourceId) ?? 1) : 1,
              ...(entry.anchor?.sourceId ? { sourceId: entry.anchor.sourceId } : {}),
              ...(typeof entry.startBlock === 'number' ? { startBlock: entry.startBlock } : {}),
              kind: entry.kind || 'quoted',
            }));
            setEntries(mapped);
            setOutlineOrigin('ai');
            const nearIdx = mapped.findIndex((e) => e.page >= currentPage);
            setSelectedIndex(nearIdx >= 0 ? nearIdx : 0);
            setLoading(false);
            return;
          }

          // Fallback: extract Markdown # headings across document sources.
          const extracted: OutlineEntryRow[] = [];
          sources.forEach((src, idx) => {
            if (typeof src.text !== 'string' || !src.text) return;
            const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
            extracted.push(...extractMarkdownHeadings(src.text, pg, src.id));
          });
          if (extracted.length > 0) {
            setEntries(extracted);
            setOutlineOrigin('headings');
            const nearIdx = extracted.findIndex((e) => e.page >= currentPage);
            setSelectedIndex(nearIdx >= 0 ? nearIdx : 0);
            setLoading(false);
            return;
          }

          if (val.outlineStale) {
            setStatusNotice({
              text: t(lang, '文档已更新，旧版 AI 目录暂不适用；按 [g] 可重新生成。', 'Document updated; stale AI outline skipped. Press [g] to regenerate.'),
              tone: 'info',
            });
          }
        }
      }

      // Final fallback: extract Markdown # headings from the current page text.
      if (currentPageText) {
        const localHeadings = extractMarkdownHeadings(currentPageText, currentPage, sourceId);
        if (localHeadings.length > 0) {
          setEntries(localHeadings);
          setOutlineOrigin('headings');
          setSelectedIndex(0);
          setLoading(false);
          return;
        }
      }

      setEntries([]);
      setOutlineOrigin('none');
      setSelectedIndex(0);
      setLoading(false);
    };

    void loadOutline();
    return () => {
      cancelled = true;
    };
  }, [host, documentId, sourceId, revision, currentPage, currentPageText, lang]);

  const displayedRows: OutlineEntryRow[] = useMemo(() => {
    if (proposal) {
      return proposal.entries.map((entry, idx) => ({
        id: `prop-${idx}`,
        title: entry.title,
        level: entry.level,
        page: entry.anchor?.sourceId ? (sourcePageMap.get(entry.anchor.sourceId) ?? 1) : 1,
        ...(entry.anchor?.sourceId ? { sourceId: entry.anchor.sourceId } : {}),
        startBlock: entry.startBlock,
        kind: entry.kind || 'quoted',
      }));
    }
    return entries;
  }, [proposal, entries, sourcePageMap]);

  const handleSuggest = useCallback(async () => {
    if (busy || loading) return;
    if (!resolvedDocId && !sourceId) {
      setStatusNotice({
        text: t(lang, '缺少文档标识，无法生成目录', 'Missing document identifier'),
        tone: 'warning',
      });
      return;
    }
    setBusy(true);
    setStatusNotice({
      text: t(lang, `正在请求 AI 整理章节目录${ell}`, `Requesting AI chapter outline${ell}`),
      tone: 'info',
    });

    try {
      const args: Record<string, unknown> = {
        ...(resolvedDocId ? { id: resolvedDocId, documentId: resolvedDocId } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(resolvedRevision ? { revision: resolvedRevision } : {}),
        mode: 'chapters',
        language: lang === 'en' ? 'English' : '中文',
      };

      const res = await tryAction<Record<string, unknown>>(host, 'materials.outline.suggest', args);
      if (!mountedRef.current) return;

      if (!res.ok || !res.value) {
        setStatusNotice({
          text: res.error?.message || t(lang, 'AI 目录生成失败', 'Outline suggestion failed'),
          tone: 'error',
        });
        setBusy(false);
        return;
      }

      const val = res.value;
      const status = String(val.status ?? '');

      if (status === 'proposed' && Array.isArray(val.entries)) {
        const proposedEntries = val.entries as ProposedOutline['entries'];
        setProposal({
          entries: proposedEntries,
          warnings: Array.isArray(val.warnings) ? (val.warnings as string[]) : [],
          usage: val.usage && typeof val.usage === 'object' ? (val.usage as Record<string, unknown>) : undefined,
          coverage: val.coverage && typeof val.coverage === 'object' ? (val.coverage as ProposedOutline['coverage']) : undefined,
        });
        setSelectedIndex(0);
        setStatusNotice({
          text: t(
            lang,
            `AI 已建议 ${proposedEntries.length} 个章节，按 [s] 保存为正式目录`,
            `Proposed ${proposedEntries.length} chapters. Press [s] to save.`,
          ),
          tone: 'success',
        });
      } else if (status === 'unavailable') {
        // Fetch estimate gracefully when model is unavailable so learner sees scope/cost info.
        const estRes = await tryAction<Record<string, unknown>>(host, 'materials.outline.suggest', {
          ...args,
          estimate: true,
        });
        if (!mountedRef.current) return;
        const estVal = estRes.ok ? estRes.value : undefined;
        const cov = (estVal?.coverage || val.coverage) as { blocks?: number; units?: number; chars?: number } | undefined;
        const est = estVal?.estimate as Record<string, unknown> | undefined;
        const estStr = formatEstimateSummary(lang, cov, est);
        const baseMsg = String(val.message || t(lang, '未配置可用模型，请先在设置中配置模型', 'No model available. Configure one in Settings.'));
        setStatusNotice({
          text: estStr ? `${baseMsg} (${estStr})` : baseMsg,
          tone: 'warning',
        });
      } else if (status === 'estimate') {
        const cov = val.coverage as { blocks?: number; units?: number; chars?: number } | undefined;
        const est = val.estimate as Record<string, unknown> | undefined;
        const estStr = formatEstimateSummary(lang, cov, est);
        setStatusNotice({
          text: t(lang, `用量估算：${estStr || '就绪'}`, `Estimate: ${estStr || 'ready'}`),
          tone: 'info',
        });
      } else if (status === 'empty') {
        setStatusNotice({
          text: String(val.message || t(lang, '文档暂无可整理的文本内容', 'Document has no text to outline')),
          tone: 'warning',
        });
      } else if (status === 'rejected') {
        setStatusNotice({
          text: String(val.message || t(lang, 'AI 返回的目录格式未通过校验，原目录保持不变', 'Proposed outline rejected; existing outline unchanged')),
          tone: 'error',
        });
      } else {
        setStatusNotice({
          text: String(val.message || t(lang, '未能生成建议目录', 'Could not generate outline')),
          tone: 'warning',
        });
      }
    } catch (err) {
      if (mountedRef.current) {
        setStatusNotice({ text: errorMessage(err), tone: 'error' });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, loading, resolvedDocId, sourceId, resolvedRevision, lang, host]);

  const handleSaveProposal = useCallback(async () => {
    if (busy || !proposal || proposal.entries.length === 0) return;
    setBusy(true);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'materials.outline.save', {
        ...(resolvedDocId ? { id: resolvedDocId, documentId: resolvedDocId } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(resolvedRevision ? { revision: resolvedRevision } : {}),
        mode: 'chapters',
        entries: proposal.entries.map((e) => ({
          title: e.title,
          level: e.level,
          startBlock: e.startBlock,
        })),
        ...(proposal.usage ? { usage: proposal.usage } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok || res.value?.saved === false) {
        const msg = res.error?.message || t(lang, '保存目录失败', 'Failed to save outline');
        setStatusNotice({ text: msg, tone: 'error' });
        notify(msg, 'error');
        setBusy(false);
        return;
      }

      const savedOutline = res.value?.outline as { entries?: RawOutlineEntry[] } | undefined;
      const nextRaw = Array.isArray(savedOutline?.entries) ? savedOutline.entries : proposal.entries;
      const savedRows: OutlineEntryRow[] = nextRaw.map((entry, idx) => ({
        id: `ai-${idx}`,
        title: String(entry.title ?? ''),
        level: Number(entry.level) || 1,
        page: entry.anchor?.sourceId ? (sourcePageMap.get(entry.anchor.sourceId) ?? 1) : 1,
        ...(entry.anchor?.sourceId ? { sourceId: entry.anchor.sourceId } : {}),
        ...(typeof entry.startBlock === 'number' ? { startBlock: entry.startBlock } : {}),
        kind: entry.kind || 'quoted',
      }));
      setEntries(savedRows);
      setOutlineOrigin('ai');
      setProposal(null);
      setStatusNotice({
        text: t(lang, `已保存 ${savedRows.length} 个章节目录`, `Saved ${savedRows.length} outline entries`),
        tone: 'success',
      });
      notify(t(lang, '已保存文档章节目录', 'Document outline saved'), 'success');
    } catch (err) {
      if (mountedRef.current) {
        const msg = errorMessage(err);
        setStatusNotice({ text: msg, tone: 'error' });
        notify(msg, 'error');
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, proposal, host, resolvedDocId, sourceId, resolvedRevision, lang, sourcePageMap, notify]);

  useClaimKeys(['g', 's', 'j', 'k'], isActive);

  useInput(
    (input) => {
      if (input === 'g') {
        void handleSuggest();
      } else if (input === 's' && proposal) {
        void handleSaveProposal();
      }
    },
    { isActive },
  );

  const frameW = Math.min(84, Math.max(46, width - 4));
  const frameH = Math.min(28, Math.max(14, height - 2));
  const innerW = modalContentWidth(frameW);
  const noticeRows = statusNotice ? 2 : 0;
  const headerRows = 2;
  const listH = Math.max(4, frameH - 5 - headerRows - noticeRows);

  const modalHints: KeyHint[] = useMemo(() => {
    const base: KeyHint[] = [{ key: 'Enter', label: t(lang, '跳页', 'Jump') }];
    if (proposal) {
      base.push({ key: 's', label: t(lang, '保存', 'Save') });
    }
    base.push({ key: 'g', label: t(lang, 'AI目录', 'Suggest') });
    base.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return base;
  }, [lang, proposal]);

  const badgeLabel = proposal
    ? t(lang, `AI 建议 · ${proposal.entries.length} 项`, `AI Draft · ${proposal.entries.length}`)
    : outlineOrigin === 'ai'
      ? t(lang, `AI 目录 · ${entries.length} 项`, `AI Outline · ${entries.length}`)
      : outlineOrigin === 'headings'
        ? t(lang, `标题提取 · ${entries.length} 项`, `Headings · ${entries.length}`)
        : t(lang, '暂无目录', 'Empty');

  return (
    <Modal
      title={t(lang, '文档目录大纲', 'Document Outline')}
      subtitle={title ? truncateDisplay(title, Math.max(12, Math.floor(innerW * 0.45)), ell) : undefined}
      icon={asciiMode ? '#' : '☰'}
      tone="primary"
      width={frameW}
      height={frameH}
      isActive={isActive}
      onClose={onClose}
      hints={modalHints}
    >
      <Box height={headerRows} flexDirection="row" alignItems="center" width={innerW} overflow="hidden">
        <Badge
          label={badgeLabel}
          tone={proposal ? 'ai' : outlineOrigin === 'ai' ? 'success' : outlineOrigin === 'headings' ? 'info' : 'muted'}
          variant="soft"
        />
        <Text> </Text>
        <Badge label={`${t(lang, '当前', 'Curr')} P.${currentPage}`} tone="accent" variant="outline" />
        <Box flexGrow={1} />
        {busy ? <Spinner label={t(lang, `处理中${ell}`, `Working${ell}`)} /> : null}
      </Box>

      {statusNotice ? (
        <Box height={noticeRows} width={innerW} overflow="hidden">
          <Text
            color={
              statusNotice.tone === 'error'
                ? theme.error
                : statusNotice.tone === 'warning'
                  ? theme.warning
                  : statusNotice.tone === 'success'
                    ? theme.success
                    : theme.info
            }
            wrap="truncate-end"
          >
            {statusNotice.text}
          </Text>
        </Box>
      ) : null}

      {loading ? (
        <Box height={listH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取目录结构${ell}`, `Loading outline${ell}`)} />
        </Box>
      ) : displayedRows.length === 0 ? (
        <EmptyState
          title={t(lang, '暂无目录条目', 'No outline entries')}
          hint={t(lang, '按 [g] 让 AI 生成章节目录，或按 [Esc] 返回阅读', 'Press [g] to suggest AI chapters, or [Esc] to return')}
          width={innerW}
          height={listH}
        />
      ) : (
        <VirtualList
          items={displayedRows}
          height={listH}
          width={innerW}
          selectedIndex={selectedIndex}
          onChange={(idx) => setSelectedIndex(idx)}
          onSelect={(item) => {
            onJumpPage(item.page);
            onClose();
          }}
          keyExtractor={(item) => item.id}
          isActive={isActive && !busy}
          renderItem={(item, ctx) => {
            const indent = '  '.repeat(Math.max(0, item.level - 1));
            const isCurrent = item.page === currentPage;
            const pageTag = `P.${item.page}`;
            const tag = item.kind === 'label' ? t(lang, ' [概括]', ' [label]') : '';
            const avail = Math.max(6, ctx.width - pageTag.length - tag.length - 4);
            const label = truncateDisplay(`${indent}${item.title}`, avail, ell);
            return (
              <Box width={ctx.width} height={1}>
                <Text color={ctx.selected ? theme.primary : isCurrent ? theme.accent : theme.dim} bold={ctx.selected}>
                  {ctx.selected ? (asciiMode ? '> ' : '▸ ') : isCurrent ? (asciiMode ? '- ' : '• ') : '  '}
                </Text>
                <Text
                  color={ctx.selected ? theme.text : item.level === 1 ? theme.text : theme.muted}
                  bold={ctx.selected || item.level === 1}
                >
                  {label}
                </Text>
                {tag ? <Text color={theme.ai}>{tag}</Text> : null}
                <Box flexGrow={1} />
                <Text color={isCurrent ? theme.accent : theme.dim}>{pageTag}</Text>
              </Box>
            );
          }}
        />
      )}
    </Modal>
  );
});
