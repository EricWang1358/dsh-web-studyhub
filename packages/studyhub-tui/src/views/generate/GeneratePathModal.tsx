import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner, normalizeAsciiChrome } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import type { DocumentGroup } from '../sources/source-helpers.js';

const MAX_STEP_PAGES = 20;
const MIN_STEP_COUNT = 5;
const MAX_STEP_COUNT = 20;

export interface PathStep {
  id: string;
  order: number;
  title: string;
  documentTitle: string;
  pages: number;
  chars: number;
  pageScope: string;
  range: string;
  count: number;
  focus?: string;
  reason?: string;
}

export interface PathApplyPayload {
  pageScope: string;
  targetCount: number;
  focusNote?: string;
}

export interface GeneratePathModalProps {
  host: HostClient;
  groups: readonly DocumentGroup[];
  selectedSourceIds: ReadonlySet<string>;
  course?: string;
  goal?: string;
  isActive: boolean;
  onApplyStep: (payload: PathApplyPayload) => void;
  onClose: () => void;
}

interface PathSuggestUnavailable {
  reason?: string;
  message?: string;
  sample?: string;
}

interface PathSuggestStepReply {
  id?: string;
  order?: number;
  title?: string;
  count?: number;
  focus?: string;
  reason?: string;
}

interface PathSuggestResponse {
  source?: 'model' | 'local';
  steps?: PathSuggestStepReply[];
  order?: string[];
  note?: string;
  unavailable?: PathSuggestUnavailable;
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return MIN_STEP_COUNT;
  return Math.min(MAX_STEP_COUNT, Math.max(MIN_STEP_COUNT, Math.round(value)));
}

function formatPageRanges(pageNumbers: readonly number[]): string {
  if (pageNumbers.length === 0) return 'all';
  const sorted = [...new Set(pageNumbers)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (p === end + 1) {
      end = p;
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = p;
      end = p;
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(', ');
}

function suggestStepCount(pages: number, chars: number): number {
  const byChars = chars > 0 ? Math.round(chars / 6000) : 0;
  const byPages = Math.ceil(Math.max(1, pages) / 2);
  return clampCount(Math.max(byChars, byPages));
}

/**
 * Pure local planner: partitions selected DocumentGroup pages into sequential
 * steps of up to 20 pages each with clamped [5, 20] question counts.
 */
export function buildLocalPathSteps(
  groups: readonly DocumentGroup[],
  selectedDocIds: ReadonlySet<string> | readonly string[],
): PathStep[] {
  const selectedSet: ReadonlySet<string> = selectedDocIds instanceof Set ? selectedDocIds : new Set(selectedDocIds);
  if (!Array.isArray(groups) || selectedSet.size === 0) return [];

  const steps: PathStep[] = [];
  for (const doc of groups) {
    if (!doc) continue;
    const wholeDocSelected =
      selectedSet.has(doc.key) || (Boolean(doc.documentId) && selectedSet.has(doc.documentId!));

    const docPages: DocumentGroup['pages'] = Array.isArray(doc.pages) ? doc.pages : [];
    let matchedPages: DocumentGroup['pages'];
    if (docPages.length > 0) {
      matchedPages = wholeDocSelected
        ? [...docPages]
        : docPages.filter((p) => selectedSet.has(p.sourceId));
    } else {
      const sourceIds: string[] = Array.isArray(doc.sourceIds) ? doc.sourceIds : [];
      const matchedIds: string[] = wholeDocSelected
        ? sourceIds.length > 0
          ? sourceIds
          : Array.from({ length: Math.max(1, doc.pageCount || 1) }, (_, idx) => `${doc.key}#p${idx + 1}`)
        : sourceIds.filter((id) => selectedSet.has(id));
      const avgChars =
        matchedIds.length > 0
          ? Math.round(Math.max(0, doc.chars || 0) / Math.max(1, doc.pageCount || matchedIds.length))
          : 0;
      matchedPages = matchedIds.map((sourceId, idx) => ({
        sourceId,
        page: idx + 1,
        title: doc.title,
        chars: avgChars,
      }));
    }

    if (matchedPages.length === 0) continue;
    matchedPages.sort((a, b) => a.page - b.page);

    const totalChunks = Math.ceil(matchedPages.length / MAX_STEP_PAGES);
    for (let offset = 0; offset < matchedPages.length; offset += MAX_STEP_PAGES) {
      const chunk = matchedPages.slice(offset, offset + MAX_STEP_PAGES);
      const pages = chunk.length;
      const chars = chunk.reduce((sum, p) => sum + Math.max(0, Number(p.chars) || 0), 0);
      const pageScope = formatPageRanges(chunk.map((p) => p.page));
      const docTitle = String(doc.title || doc.key || 'Untitled');
      const order = steps.length + 1;
      steps.push({
        id: `step-${order}`,
        order,
        title: totalChunks > 1 ? `${docTitle} (p.${pageScope})` : docTitle,
        documentTitle: docTitle,
        pages,
        chars,
        pageScope,
        range: pageScope,
        count: suggestStepCount(pages, chars),
      });
    }
  }
  return steps;
}

function formatPathUnavailable(
  unavailable: PathSuggestUnavailable | undefined,
  lang: 'zh' | 'en',
): string {
  const reason = unavailable?.reason;
  switch (reason) {
    case 'no-model':
      return t(
        lang,
        '当前未配置轻量模型，已保留本地分步方案（可直接按 Enter 应用）。',
        'No AI model configured; keeping local step plan (press Enter to apply).',
      );
    case 'nothing-usable':
      return t(
        lang,
        '模型返回格式不可用，已保留本地分步方案。',
        'Model output could not be parsed; keeping local step plan.',
      );
    case 'no-steps':
      return t(lang, '当前没有可规划的步骤。', 'No steps available to refine.');
    case 'failed':
      return t(
        lang,
        `AI 优化失败${unavailable?.message ? ` (${unavailable.message})` : ''}，已保留本地分步方案。`,
        `AI refinement failed${unavailable?.message ? ` (${unavailable.message})` : ''}; keeping local plan.`,
      );
    default:
      return t(
        lang,
        `AI 优化暂不可用${reason ? ` (${reason})` : ''}，已保留本地分步方案。`,
        `AI refinement unavailable${reason ? ` (${reason})` : ''}; keeping local plan.`,
      );
  }
}

function mergePathRefinement(current: readonly PathStep[], reply: PathSuggestResponse): PathStep[] {
  const byId = new Map(current.map((step) => [step.id, step]));
  const ordered: PathStep[] = [];
  const seen = new Set<string>();

  if (Array.isArray(reply.steps) && reply.steps.length > 0) {
    const replyById = new Map<string, PathSuggestStepReply>();
    for (const item of reply.steps) {
      if (item && typeof item.id === 'string') replyById.set(item.id, item);
    }

    const idSequence = Array.isArray(reply.order) && reply.order.length > 0
      ? reply.order
      : reply.steps.map((s) => s.id).filter((id): id is string => typeof id === 'string');

    for (const id of idSequence) {
      const base = byId.get(id);
      if (!base || seen.has(id)) continue;
      seen.add(id);
      const ref = replyById.get(id);
      const refinedTitle = typeof ref?.title === 'string' && ref.title.trim() ? ref.title.trim() : base.title;
      const refinedFocus = typeof ref?.focus === 'string' && ref.focus.trim() ? ref.focus.trim() : base.focus;
      const refinedReason = typeof ref?.reason === 'string' && ref.reason.trim() ? ref.reason.trim() : base.reason;
      const refinedCount =
        typeof ref?.count === 'number' && Number.isFinite(ref.count) && ref.count > 0
          ? clampCount(ref.count)
          : base.count;
      ordered.push({
        ...base,
        title: refinedTitle,
        count: refinedCount,
        ...(refinedFocus ? { focus: refinedFocus } : {}),
        ...(refinedReason ? { reason: refinedReason } : {}),
      });
    }
  }

  for (const base of current) {
    if (!seen.has(base.id)) ordered.push(base);
  }

  return ordered.map((step, index) => ({ ...step, order: index + 1 }));
}

export const GeneratePathModal = memo(function GeneratePathModal({
  host,
  groups,
  selectedSourceIds,
  course,
  goal,
  isActive,
  onApplyStep,
  onClose,
}: GeneratePathModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows } = useStableWindowSize();

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' | ' : ' · ';
  const iconGlyph = asciiMode ? '*' : '✦';
  const cursorGlyph = asciiMode ? '>' : '›';
  const navKeyHint = asciiMode ? 'j/k/Up/Down' : 'j/k/↑/↓';

  const localSteps = useMemo(
    () => buildLocalPathSteps(groups, selectedSourceIds),
    [groups, selectedSourceIds],
  );

  const [steps, setSteps] = useState<PathStep[]>(() => localSteps);
  const [cursor, setCursor] = useState(0);
  const [aiSource, setAiSource] = useState<'local' | 'model'>('local');
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [unavailableMsg, setUnavailableMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (aiSource === 'local') {
      setSteps(localSteps);
      setCursor((prev) => Math.min(prev, Math.max(0, localSteps.length - 1)));
    }
  }, [aiSource, localSteps]);

  useInputCapture(isActive);

  const handleApplySelected = useCallback(() => {
    const step = steps[cursor];
    if (!step) return;
    onApplyStep({
      pageScope: step.pageScope,
      targetCount: step.count,
      ...(step.focus ? { focusNote: step.focus } : {}),
    });
  }, [cursor, onApplyStep, steps]);

  const handleRunSuggest = useCallback(async () => {
    if (busyRef.current || loading || steps.length === 0) return;
    setConfirmOpen(false);
    busyRef.current = true;
    setLoading(true);
    setUnavailableMsg(null);
    try {
      let resolvedGoal = goal;
      if (!resolvedGoal) {
        const profileRes = await tryAction<{ goal?: unknown }>(host, 'coach.profile', {});
        if (profileRes.ok && typeof profileRes.value?.goal === 'string' && profileRes.value.goal.trim()) {
          resolvedGoal = profileRes.value.goal.trim();
        }
      }
      const res = await tryAction<PathSuggestResponse>(host, 'generate.path.suggest', {
        ...(course ? { course } : {}),
        ...(resolvedGoal ? { goal: resolvedGoal } : {}),
        steps: steps.map((s) => ({
          id: s.id,
          title: s.title,
          pages: s.pages,
          chars: s.chars,
          count: s.count,
          range: s.range,
          documentTitle: s.documentTitle,
        })),
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setUnavailableMsg(
          res.error?.message ||
            t(lang, 'AI 优化分步路径失败，已保留本地分步方案。', 'Failed to refine path with AI; keeping local plan.'),
        );
        return;
      }
      if (res.value.source === 'model' && Array.isArray(res.value.steps) && res.value.steps.length > 0) {
        const merged = mergePathRefinement(steps, res.value);
        setSteps(merged);
        setCursor(0);
        setAiSource('model');
        setAiNote(typeof res.value.note === 'string' && res.value.note.trim() ? res.value.note.trim() : null);
        setUnavailableMsg(null);
      } else {
        setUnavailableMsg(formatPathUnavailable(res.value.unavailable, lang));
      }
    } catch (error) {
      if (mountedRef.current) {
        setUnavailableMsg(errorMessage(error, lang));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [course, goal, host, lang, loading, steps]);

  const modalActive = isActive && !confirmOpen && !loading;

  useInput(
    (input, key) => {
      if (!modalActive) return;
      if (key.escape || (!key.ctrl && !key.meta && input === 'q')) {
        onClose();
        return true;
      }
      if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) {
        setCursor((c) => Math.min(Math.max(0, steps.length - 1), c + 1));
        return;
      }
      if (key.upArrow || (!key.ctrl && !key.meta && input === 'k')) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.return) {
        handleApplySelected();
        return;
      }
      if (!key.ctrl && !key.meta && input === 'g') {
        if (steps.length > 0 && !busyRef.current) {
          setConfirmOpen(true);
        }
      }
    },
    { isActive: modalActive },
  );

  const modalW = Math.min(78, Math.max(46, columns - 4));
  const innerW = modalContentWidth(modalW);
  const selectedStep = steps[cursor];
  const hasBanner = Boolean(unavailableMsg || aiNote);
  const detailLines = selectedStep ? (selectedStep.focus || selectedStep.reason ? 2 : 1) : 0;
  const maxListH = Math.max(3, rows - 10 - (hasBanner ? 2 : 0) - detailLines);
  const listH = Math.max(3, Math.min(Math.max(3, steps.length), maxListH));

  const hints: KeyHint[] = useMemo(
    () => [
      { key: navKeyHint, label: t(lang, '切换步骤', 'Select') },
      { key: 'Enter', label: t(lang, '应用范围', 'Apply') },
      { key: 'g', label: t(lang, 'AI 优化', 'AI Refine') },
      { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
    ],
    [lang, navKeyHint],
  );

  return (
    <>
      <Modal
        title={t(lang, '分步出题路径规划', 'Generation Path Planner')}
        subtitle={aiSource === 'model' ? t(lang, 'AI 优化', 'AI Refined') : t(lang, '本地分步', 'Local Plan')}
        icon={iconGlyph}
        tone={aiSource === 'model' ? 'primary' : 'accent'}
        width={modalW}
        isActive={modalActive}
        onClose={onClose}
        hints={hints}
      >
        <Box flexDirection="column" width={innerW}>
          <Box flexDirection="row" alignItems="center">
            <Badge
              label={
                aiSource === 'model'
                  ? t(lang, `AI 推荐路径 (${steps.length} 步)`, `AI Path (${steps.length} steps)`)
                  : t(lang, `本地分步方案 (${steps.length} 步)`, `Local Path (${steps.length} steps)`)
              }
              tone={aiSource === 'model' ? 'success' : 'accent'}
              variant="soft"
            />
            <Box flexGrow={1} />
            <Text color={theme.dim}>
              {truncateDisplay(
                t(lang, `每步 <= ${MAX_STEP_PAGES} 页`, `<= ${MAX_STEP_PAGES}p/step`),
                Math.max(10, Math.floor(innerW / 3)),
                ell,
              )}
            </Text>
          </Box>

          {loading ? (
            <Box marginTop={1}>
              <Spinner
                label={t(lang, '正在调用 AI 优化步骤标题、顺序与题数...', 'Refining step titles, order & counts...')}
                active={isActive}
              />
            </Box>
          ) : null}

          {!loading && unavailableMsg ? (
            <Box marginTop={1}>
              <Text color={theme.warning} wrap="wrap">
                {truncateDisplay(normalizeAsciiChrome(unavailableMsg, asciiMode), Math.max(20, innerW * 2 - 4), ell)}
              </Text>
            </Box>
          ) : !loading && aiNote ? (
            <Box marginTop={1}>
              <Text color={theme.info} wrap="wrap">
                {truncateDisplay(normalizeAsciiChrome(aiNote, asciiMode), Math.max(20, innerW * 2 - 4), ell)}
              </Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <VirtualList
              items={steps}
              height={listH}
              width={innerW}
              selectedIndex={cursor}
              isActive={false}
              ascii={asciiMode}
              keyExtractor={(step) => step.id}
              emptyText={t(lang, '当前未选择可用资料', 'No selected materials available')}
              renderItem={(step, ctx: VirtualListRenderContext) => {
                const prefix = ctx.selected ? `${cursorGlyph} ${step.order}. ` : `  ${step.order}. `;
                const countUnit = t(lang, '题', 'q');
                const meta = `p.${step.pageScope}${sep}${step.pages}p${sep}${step.count}${countUnit}`;
                const titleBudget = Math.max(8, ctx.width - displayWidth(prefix) - displayWidth(meta) - 2);
                const cleanTitle = normalizeAsciiChrome(step.title, asciiMode);
                return (
                  <Box flexDirection="row" width={ctx.width}>
                    <Text color={ctx.selected ? theme.accent : theme.muted} bold={ctx.selected}>
                      {prefix}
                    </Text>
                    <Text color={ctx.selected ? theme.text : theme.muted} bold={ctx.selected}>
                      {truncateDisplay(cleanTitle, titleBudget, ell)}
                    </Text>
                    <Box flexGrow={1} />
                    <Text color={ctx.selected ? theme.primary : theme.dim}>{meta}</Text>
                  </Box>
                );
              }}
            />
          </Box>

          {selectedStep ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>
                {truncateDisplay(
                  normalizeAsciiChrome(
                    `${t(lang, '当前步骤', 'Step')}: p.${selectedStep.pageScope}${sep}${selectedStep.pages} ${t(lang, '页', 'pages')}${sep}${selectedStep.count} ${t(lang, '题', 'questions')}`,
                    asciiMode,
                  ),
                  innerW,
                  ell,
                )}
              </Text>
              {selectedStep.focus ? (
                <Text color={theme.accent}>
                  {truncateDisplay(
                    normalizeAsciiChrome(`${t(lang, '练习重点', 'Focus')}: ${selectedStep.focus}`, asciiMode),
                    innerW,
                    ell,
                  )}
                </Text>
              ) : selectedStep.reason ? (
                <Text color={theme.dim}>
                  {truncateDisplay(
                    normalizeAsciiChrome(`${t(lang, '排序说明', 'Note')}: ${selectedStep.reason}`, asciiMode),
                    innerW,
                    ell,
                  )}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      </Modal>

      {confirmOpen ? (
        <ConfirmDialog
          title={t(lang, 'AI 优化分步出题路径', 'AI Path Refinement')}
          message={t(
            lang,
            '确认调用 AI 优化分步出题路径？仅发送步骤标题与页数，不发送正文。',
            'Call AI to refine step names, order & counts? Only step titles & sizes are sent, never source text.',
          )}
          confirmLabel={t(lang, '开始优化', 'Refine')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={60}
          isActive={isActive && confirmOpen && !loading}
          onConfirm={() => void handleRunSuggest()}
          onCancel={() => {
            if (!busyRef.current) setConfirmOpen(false);
          }}
        />
      ) : null}
    </>
  );
});
