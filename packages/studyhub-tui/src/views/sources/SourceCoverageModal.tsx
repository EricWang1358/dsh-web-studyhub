import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  ProgressBar,
  Spinner,
  VirtualList,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
import { displayWidth, truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/sample-actions.js';
import type { DocumentGroup } from './source-helpers.js';

export interface SourceCoverageModalProps {
  host: HostClient;
  item: DocumentGroup;
  defaultCourse?: string | null;
  isActive: boolean;
  onGenerate: (sourceIds: string[], course?: string) => void;
  onClose: () => void;
}

interface CoverageSection {
  id: string;
  key: string;
  sourceId: string;
  kind?: string;
  title?: string;
  state: 'covered' | 'planned-failed' | 'never-planned' | string;
  cards?: number;
  reason?: string;
  page?: number;
}

interface CoverageReport {
  sections?: CoverageSection[];
  covered?: number;
  plannedFailed?: number;
  neverPlanned?: number;
  leaves?: number;
  percentLeaves?: number;
  percentChars?: number;
  cards?: number;
  units?: string;
}

interface CoverageGetResponse {
  status?: string;
  scope?: string;
  coverage?: CoverageReport;
}

interface CoverageTargetDeck {
  id: string;
  title?: string;
  course?: string;
  cards?: number;
  directCitedCards?: number;
  cardIndex?: { total?: number };
}

interface SourceCoverageResponse {
  directReferences?: {
    numerator?: number;
    denominator?: number;
    unit?: string;
  };
  targets?: {
    active?: CoverageTargetDeck[];
    archived?: CoverageTargetDeck[];
    drafts?: CoverageTargetDeck[];
  };
}

type LinkedTargetKind = 'active' | 'draft' | 'archived';

interface LinkedTargetItem {
  id: string;
  kind: LinkedTargetKind;
  title: string;
  course: string;
  directCitedCards: number;
  totalCards: number;
}

type CoverageRow =
  | { kind: 'section'; key: string; section: CoverageSection; index: number }
  | { kind: 'header'; key: string; label: string }
  | { kind: 'target'; key: string; target: LinkedTargetItem };

export const SourceCoverageModal = memo(function SourceCoverageModal({
  host,
  item,
  defaultCourse,
  isActive,
  onGenerate,
  onClose,
}: SourceCoverageModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows: termRows } = useWindowSize();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docCoverage, setDocCoverage] = useState<CoverageReport | null>(null);
  const [srcCoverage, setSrcCoverage] = useState<SourceCoverageResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const covGetArgs: Record<string, unknown> = {
      ...(item.documentId ? { documentId: item.documentId } : {}),
      ...(item.sourceIds[0] ? { sourceId: item.sourceIds[0] } : {}),
    };

    void Promise.allSettled([
      tryAction<CoverageGetResponse>(host, 'coverage.get', covGetArgs),
      tryAction<SourceCoverageResponse>(host, 'source.coverage', { sourceIds: item.sourceIds }),
    ]).then(([covRes, srcRes]) => {
      if (cancelled) return;
      setLoading(false);

      const covOk =
        covRes.status === 'fulfilled' &&
        covRes.value.ok &&
        covRes.value.value?.status === 'ok' &&
        covRes.value.value.coverage;
      const srcOk = srcRes.status === 'fulfilled' && srcRes.value.ok && srcRes.value.value;

      setDocCoverage(covOk ? (covRes.value.value?.coverage ?? null) : null);
      setSrcCoverage(srcOk ? (srcRes.value.value ?? null) : null);

      if (!covOk && !srcOk) {
        const covErr = covRes.status === 'fulfilled' ? covRes.value.error?.message : undefined;
        const srcErr = srcRes.status === 'fulfilled' ? srcRes.value.error?.message : undefined;
        setError(covErr || srcErr || t(lang, '获取覆盖率数据失败', 'Failed to load coverage data'));
      }
      setSelectedIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [host, isActive, item.documentId, item.sourceIds, lang, reloadSeq]);

  const sections = useMemo(
    () => (Array.isArray(docCoverage?.sections) ? docCoverage.sections : []),
    [docCoverage],
  );

  const linkedTargets = useMemo<LinkedTargetItem[]>(() => {
    const tData = srcCoverage?.targets;
    if (!tData) return [];
    const out: LinkedTargetItem[] = [];
    const pushList = (list: CoverageTargetDeck[] | undefined, kind: LinkedTargetKind) => {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        if (!entry || typeof entry.id !== 'string') continue;
        const directCited = Number(entry.directCitedCards ?? 0);
        const totalCited = Number(entry.cardIndex?.total ?? 0);
        if (directCited <= 0 && totalCited <= 0) continue;
        out.push({
          id: entry.id,
          kind,
          title: entry.title || entry.id,
          course: entry.course || '',
          directCitedCards: directCited || totalCited,
          totalCards: Number(entry.cards ?? 0),
        });
      }
    };
    pushList(tData.active, 'active');
    pushList(tData.drafts, 'draft');
    pushList(tData.archived, 'archived');
    return out;
  }, [srcCoverage]);

  const rows = useMemo<CoverageRow[]>(() => {
    const out: CoverageRow[] = sections.map((section, idx) => ({
      kind: 'section',
      key: `sec:${section.key || section.id || idx}`,
      section,
      index: idx,
    }));
    if (linkedTargets.length > 0) {
      const dash = asciiMode ? '--' : '──';
      out.push({
        kind: 'header',
        key: 'hdr:targets',
        label: `${dash} ${t(lang, `关联题组与草稿 (${linkedTargets.length})`, `Linked Decks & Drafts (${linkedTargets.length})`)} ${dash}`,
      });
      for (const target of linkedTargets) {
        out.push({
          kind: 'target',
          key: `tgt:${target.kind}:${target.id}`,
          target,
        });
      }
    }
    return out;
  }, [asciiMode, lang, linkedTargets, sections]);

  useEffect(() => {
    if (selectedIndex >= rows.length) {
      setSelectedIndex(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIndex]);

  const uncoveredSourceIds = useMemo(() => {
    const valid = new Set(item.sourceIds);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of sections) {
      if (s.state !== 'covered' && valid.has(s.sourceId) && !seen.has(s.sourceId)) {
        seen.add(s.sourceId);
        out.push(s.sourceId);
      }
    }
    return out.length > 0 ? out : [...item.sourceIds];
  }, [item.sourceIds, sections]);

  const triggerGenerate = useCallback(() => {
    const course = item.courses[0] || defaultCourse || undefined;
    onClose();
    onGenerate(uncoveredSourceIds, course);
  }, [defaultCourse, item.courses, onClose, onGenerate, uncoveredSourceIds]);

  useInput(
    (input) => {
      if (!isActive || loading) return;
      if (input === 'g') {
        triggerGenerate();
      } else if (input === 'r') {
        setReloadSeq((n) => n + 1);
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (loading) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    return [
      { key: 'g', label: t(lang, '为未覆盖出题', 'Generate') },
      { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [lang, loading]);

  const frameWidth = Math.max(48, Math.min(88, columns - 4));
  const frameHeight = Math.max(15, Math.min(30, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(8, frameHeight - 5);

  const ell = asciiMode ? '...' : '…';
  const errMark = asciiMode ? 'x' : '✕';

  const covered = docCoverage?.covered ?? 0;
  const plannedFailed = docCoverage?.plannedFailed ?? 0;
  const neverPlanned = docCoverage?.neverPlanned ?? 0;
  const leaves = docCoverage?.leaves ?? sections.length;
  const uncoveredCount = plannedFailed + neverPlanned;
  const percentLeaves = docCoverage?.percentLeaves ?? (leaves > 0 ? Math.round((covered / leaves) * 100) : 0);
  const percentChars = docCoverage?.percentChars ?? 0;

  const directNum = srcCoverage?.directReferences?.numerator ?? 0;
  const directDenom = srcCoverage?.directReferences?.denominator ?? item.sourceIds.length;
  const progressRatio = leaves > 0 ? covered / leaves : directDenom > 0 ? directNum / directDenom : 0;

  const summaryRows = 3;
  const listHeight = Math.max(4, innerHeight - summaryRows);

  return (
    <Modal
      title={t(lang, '资料引用与章节覆盖率', 'Source Coverage')}
      subtitle={item.title}
      icon={asciiMode ? '%' : '◔'}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {loading ? (
        <Box height={innerHeight} width={innerWidth} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在统计章节与引用覆盖率…', 'Loading citation & section coverage…')} />
        </Box>
      ) : error ? (
        <Box height={innerHeight} width={innerWidth} flexDirection="column" justifyContent="center" alignItems="center">
          <Text color={theme.error} bold>
            {`${errMark} ${truncateDisplay(error, Math.max(20, innerWidth - 4), ell)}`}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.muted}>
              {t(lang, '按 [r] 重试，或按 [g] 直接为该资料出题', 'Press [r] to retry, or [g] to generate questions')}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" height={innerHeight} width={innerWidth}>
          {/* Progress Bar */}
          <Box height={1} width={innerWidth}>
            <ProgressBar
              ratio={progressRatio}
              width={innerWidth}
              style="block"
              showPercent
              label={leaves > 0 ? t(lang, '章节覆盖', 'Sections') : t(lang, '直接引用', 'Citations')}
            />
          </Box>

          {/* Coverage Stats Row */}
          <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
            {docCoverage ? (
              <Text wrap="truncate-end">
                <Text color={theme.success}>{`${t(lang, '已覆盖', 'Covered')} ${covered}/${leaves}`}</Text>
                <Text color={theme.dim}> · </Text>
                <Text color={uncoveredCount > 0 ? theme.warning : theme.muted}>
                  {`${t(lang, '未覆盖', 'Uncovered')} ${uncoveredCount}`}
                </Text>
                {plannedFailed > 0 ? (
                  <Text color={theme.error}>{` (${t(lang, '失败', 'failed')} ${plannedFailed})`}</Text>
                ) : null}
                <Text color={theme.dim}> · </Text>
                <Text color={theme.muted}>{`${t(lang, '章节', 'Sec')} ${percentLeaves}%`}</Text>
                <Text color={theme.dim}> · </Text>
                <Text color={theme.muted}>{`${t(lang, '字数', 'Chars')} ${percentChars}%`}</Text>
                {srcCoverage?.directReferences ? (
                  <>
                    <Text color={theme.dim}> · </Text>
                    <Text color={theme.dim}>{`${t(lang, '引用源', 'Refs')} ${directNum}/${directDenom}`}</Text>
                  </>
                ) : null}
              </Text>
            ) : (
              <Text color={theme.muted} wrap="truncate-end">
                {t(
                  lang,
                  `直接引用来源: ${directNum}/${directDenom} · 关联题组/草稿: ${linkedTargets.length}`,
                  `Direct cited sources: ${directNum}/${directDenom} · Linked decks/drafts: ${linkedTargets.length}`,
                )}
              </Text>
            )}
          </Box>

          {/* List Header / Quick Action Hint */}
          <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
            <Badge
              label={`${t(lang, '章节', 'Sections')} ${sections.length}`}
              tone="info"
              variant="soft"
            />
            <Text> </Text>
            <Badge
              label={`${t(lang, '题组/草稿', 'Decks/Drafts')} ${linkedTargets.length}`}
              tone="accent"
              variant="soft"
            />
            <Box flexGrow={1} />
            <Text color={theme.dim} wrap="truncate-end">
              {t(lang, '[g] 为未覆盖出题', '[g] Generate uncovered')}
            </Text>
          </Box>

          {rows.length === 0 ? (
            <EmptyState
              title={t(lang, '暂无章节或引用记录', 'No sections or citations yet')}
              hint={t(lang, '按 [g] 立即基于该资料生成题目', 'Press [g] to generate questions from this source')}
              width={innerWidth}
              height={listHeight}
            />
          ) : (
            <VirtualList
              items={rows}
              height={listHeight}
              width={innerWidth}
              selectedIndex={selectedIndex}
              onChange={(idx) => setSelectedIndex(idx)}
              isActive={isActive}
              keyExtractor={(row) => row.key}
              renderItem={(row, ctx) => {
                if (row.kind === 'header') {
                  return (
                    <Box flexDirection="row" width={ctx.width}>
                      <Text color={theme.accent} bold>
                        {truncateDisplay(row.label, ctx.width, ell)}
                      </Text>
                    </Box>
                  );
                }

                const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                if (row.kind === 'section') {
                  const s = row.section;
                  const isCov = s.state === 'covered';
                  const isFail = s.state === 'planned-failed';
                  const mark = isCov
                    ? asciiMode ? '[+] ' : '[✓] '
                    : isFail
                      ? '[!] '
                      : asciiMode ? '[ ] ' : '[○] ';
                  const markColor = isCov ? theme.success : isFail ? theme.warning : theme.dim;
                  const meta = isCov
                    ? `${s.cards ?? 0}${t(lang, '题', 'c')}`
                    : isFail
                      ? `${t(lang, '失败', 'fail')}${s.reason ? `:${s.reason}` : ''}`
                      : t(lang, '未覆盖', 'uncovered');
                  const fallbackName = s.page
                    ? t(lang, `第 ${s.page} 页`, `Page ${s.page}`)
                    : t(lang, `章节 ${row.index + 1}`, `Section ${row.index + 1}`);
                  const label = (s.title || '').trim() || fallbackName;
                  const metaStr = truncateDisplay(meta, Math.max(6, Math.floor(ctx.width * 0.32)), ell);
                  const maxTitle = Math.max(8, ctx.width - displayWidth(cursor) - displayWidth(mark) - displayWidth(metaStr) - 2);
                  return (
                    <Box flexDirection="row" width={ctx.width}>
                      <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                      <Text color={markColor} bold={isCov || isFail}>
                        {mark}
                      </Text>
                      <Text color={theme.text} bold={ctx.selected}>
                        {truncateDisplay(label, maxTitle, ell)}
                      </Text>
                      <Box flexGrow={1} />
                      <Text color={isCov ? theme.success : isFail ? theme.warning : theme.dim}>{metaStr}</Text>
                    </Box>
                  );
                }

                const tgt = row.target;
                const tag =
                  tgt.kind === 'draft'
                    ? t(lang, '[草稿] ', '[Draft] ')
                    : tgt.kind === 'archived'
                      ? t(lang, '[归档] ', '[Arch] ')
                      : t(lang, '[题组] ', '[Deck] ');
                const tagColor = tgt.kind === 'draft' ? theme.warning : tgt.kind === 'archived' ? theme.dim : theme.info;
                const countStr = `${tgt.directCitedCards}${t(lang, '引', 'c')}/${tgt.totalCards}${t(lang, '题', 't')}`;
                const titleWithCourse = tgt.course ? `${tgt.title} (${tgt.course})` : tgt.title;
                const maxTitle = Math.max(8, ctx.width - displayWidth(cursor) - displayWidth(tag) - displayWidth(countStr) - 2);
                return (
                  <Box flexDirection="row" width={ctx.width}>
                    <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                    <Text color={tagColor}>{tag}</Text>
                    <Text color={theme.text} bold={ctx.selected}>
                      {truncateDisplay(titleWithCourse, maxTitle, ell)}
                    </Text>
                    <Box flexGrow={1} />
                    <Text color={theme.dim}>{countStr}</Text>
                  </Box>
                );
              }}
            />
          )}
        </Box>
      )}
    </Modal>
  );
});
