import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import type { DocumentGroup } from './source-helpers.js';

export const MAX_ORGANIZE_SUGGEST_SOURCES = 100;

export interface OrganizeSourcesModalProps {
  host: HostClient;
  groups: readonly DocumentGroup[];
  allGroups?: readonly DocumentGroup[];
  isActive: boolean;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
}

interface RawOrganizeProposal {
  id?: string;
  title?: string;
  courses?: unknown;
  expectedCourses?: unknown;
  reason?: string;
  decidedBy?: string;
}

interface OrganizeProposal {
  id: string;
  title: string;
  courses: string[];
  expectedCourses: string[];
  reason: string;
  decidedBy?: string;
}

function normalizeCourseList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sameCourseSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((val, i) => val === sb[i]);
}

/** Validate that a `source.organize.suggest` batch obeys the backend 1–100 source cap before invoking the model. */
export function validateOrganizeBatchSize(
  sourceIds: readonly string[],
  lang: 'zh' | 'en' = 'zh',
): { ok: true; sourceIds: readonly string[] } | { ok: false; count: number; max: number; message: string } {
  if (sourceIds.length > MAX_ORGANIZE_SUGGEST_SOURCES) {
    return {
      ok: false,
      count: sourceIds.length,
      max: MAX_ORGANIZE_SUGGEST_SOURCES,
      message: t(
        lang,
        `单次 AI 归类最多支持 ${MAX_ORGANIZE_SUGGEST_SOURCES} 份资料（当前 ${sourceIds.length} 份），请缩小范围或分批处理`,
        `AI organize supports at most ${MAX_ORGANIZE_SUGGEST_SOURCES} sources per batch (got ${sourceIds.length}); narrow the filter or process in batches`,
      ),
    };
  }
  return { ok: true, sourceIds };
}

/** Collect up to `limit` page-level sourceIds, prioritizing unassigned visible sources. */
export function collectOrganizeSourceIds(
  groups: readonly DocumentGroup[],
  allGroups: readonly DocumentGroup[] = [],
  limit = MAX_ORGANIZE_SUGGEST_SOURCES,
): string[] {
  const base = groups.length > 0 ? groups : allGroups;
  const nonArchived = base.filter((g) => !g.archived);
  const pool = nonArchived.length > 0 ? nonArchived : base;
  const prioritized = [
    ...pool.filter((g) => g.courses.length === 0),
    ...pool.filter((g) => g.courses.length > 0),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of prioritized) {
    for (const sid of group.sourceIds) {
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      out.push(sid);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

interface PendingOrganizeState {
  jobId?: string;
  proposals?: RawOrganizeProposal[];
  createdAt?: string;
}

function parseRawProposals(
  rawList: unknown,
  titleById: ReadonlyMap<string, string>,
): { proposals: OrganizeProposal[]; checked: Set<string> } {
  const list = Array.isArray(rawList) ? rawList : [];
  const parsed: OrganizeProposal[] = [];
  const initialChecked = new Set<string>();
  for (const item of list as RawOrganizeProposal[]) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const courses = normalizeCourseList(item.courses);
    const expectedCourses = normalizeCourseList(item.expectedCourses);
    const proposal: OrganizeProposal = {
      id,
      title: (typeof item.title === 'string' && item.title.trim()) || titleById.get(id) || id,
      courses,
      expectedCourses,
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
      ...(typeof item.decidedBy === 'string' ? { decidedBy: item.decidedBy } : {}),
    };
    parsed.push(proposal);
    if (courses.length > 0 && !sameCourseSet(courses, expectedCourses)) {
      initialChecked.add(id);
    }
  }
  return { proposals: parsed, checked: initialChecked };
}

type OrganizePhase = 'pending' | 'confirm' | 'loading' | 'results' | 'error';

export const OrganizeSourcesModal = memo(function OrganizeSourcesModal({
  host,
  groups,
  allGroups,
  isActive,
  onSaved,
  onClose,
}: OrganizeSourcesModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useWindowSize();

  // Hold input capture for the modal lifetime, including ConfirmDialog transitions.
  useInputCapture(isActive);

  const allEligibleSourceIds = useMemo(
    () => collectOrganizeSourceIds(groups, allGroups, Number.MAX_SAFE_INTEGER),
    [groups, allGroups],
  );
  const exceedsBatchCap = allEligibleSourceIds.length > MAX_ORGANIZE_SUGGEST_SOURCES;
  const sourceIds = useMemo(
    () => allEligibleSourceIds.slice(0, MAX_ORGANIZE_SUGGEST_SOURCES),
    [allEligibleSourceIds],
  );

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of [...groups, ...(allGroups ?? [])]) {
      for (const p of g.pages) {
        if (!map.has(p.sourceId)) map.set(p.sourceId, p.title || g.title);
      }
      for (const sid of g.sourceIds) {
        if (!map.has(sid)) map.set(sid, g.title);
      }
    }
    return map;
  }, [groups, allGroups]);

  const pendingOrganize = useMemo<PendingOrganizeState | null>(() => {
    const raw = (snapshot?.settings as { materialOrganizePending?: unknown } | undefined)?.materialOrganizePending;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as PendingOrganizeState;
  }, [snapshot]);

  const pendingParsed = useMemo(
    () => parseRawProposals(pendingOrganize?.proposals, titleById),
    [pendingOrganize?.proposals, titleById],
  );

  const [phase, setPhase] = useState<OrganizePhase>(() =>
    pendingOrganize ? 'pending' : sourceIds.length > 0 ? 'confirm' : 'results',
  );
  const [reanalyzeConfirm, setReanalyzeConfirm] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<OrganizeProposal[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSuggest = useCallback(async () => {
    if (sourceIds.length === 0 || busyRef.current || !isActive) return;
    const batchCheck = validateOrganizeBatchSize(sourceIds, lang);
    if (!batchCheck.ok) {
      setProposals([]);
      setCheckedIds(new Set());
      setLoadError(batchCheck.message);
      setPhase('error');
      return;
    }
    busyRef.current = true;
    const seq = ++seqRef.current;
    setPhase('loading');
    setLoadError(null);
    setSaveError(null);

    try {
      const res = await tryAction<{ proposals?: RawOrganizeProposal[] }>(host, 'source.organize.suggest', {
        sourceIds,
      });
      if (!mountedRef.current || seqRef.current !== seq) return;
      if (!res.ok || !res.value) {
        setProposals([]);
        setCheckedIds(new Set());
        setLoadError(res.error?.message || t(lang, '获取 AI 课程归类建议失败', 'Failed to suggest courses'));
        setPhase('error');
        return;
      }
      const { proposals: parsed, checked: initialChecked } = parseRawProposals(res.value.proposals, titleById);
      setProposals(parsed);
      setCheckedIds(initialChecked);
      setSelectedIndex(0);
      setPhase('results');
    } catch (err) {
      if (!mountedRef.current || seqRef.current !== seq) return;
      setProposals([]);
      setCheckedIds(new Set());
      setLoadError(errorMessage(err, lang));
      setPhase('error');
    } finally {
      busyRef.current = false;
    }
  }, [host, isActive, lang, sourceIds, titleById]);

  const activeListLength = phase === 'pending' ? pendingParsed.proposals.length : proposals.length;
  useEffect(() => {
    if (selectedIndex >= activeListLength) {
      setSelectedIndex(Math.max(0, activeListLength - 1));
    }
  }, [activeListLength, selectedIndex]);

  const currentProposal = proposals[selectedIndex];
  const loading = phase === 'loading';

  const handleToggleOne = useCallback(() => {
    if (!currentProposal || phase !== 'results' || saving) return;
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(currentProposal.id)) next.delete(currentProposal.id);
      else next.add(currentProposal.id);
      return next;
    });
  }, [currentProposal, phase, saving]);

  const handleToggleAll = useCallback(() => {
    if (phase !== 'results' || saving || proposals.length === 0) return;
    setCheckedIds((prev) => {
      if (prev.size === proposals.length) return new Set();
      return new Set(proposals.map((p) => p.id));
    });
  }, [phase, proposals, saving]);

  const handleSave = useCallback(async () => {
    if (busyRef.current || phase !== 'results' || saving || proposals.length === 0) return;
    const selected = proposals.filter((p) => checkedIds.has(p.id));
    if (selected.length === 0) {
      notify(t(lang, '请先勾选至少一项课程归类建议', 'Select at least one proposal to apply'), 'warning');
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const assignments = selected.map((p) => ({
        id: p.id,
        courses: p.courses,
        expectedCourses: p.expectedCourses,
      }));
      const res = await tryAction<{ updated?: number }>(host, 'source.courses.set', { assignments });
      if (!mountedRef.current) return;
      if (!res.ok) {
        const msg = res.error?.message || t(lang, '保存课程归属失败', 'Failed to save course assignments');
        setSaveError(msg);
        notify(msg, 'error');
        return;
      }
      await onSaved();
      if (!mountedRef.current) return;
      const count = res.value?.updated ?? assignments.length;
      notify(
        t(lang, `已更新 ${count} 份资料的课程归属`, `Updated course assignments for ${count} source(s)`),
        'success',
      );
      onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = errorMessage(err, lang);
      setSaveError(msg);
      notify(msg, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [checkedIds, host, lang, notify, onClose, onSaved, phase, proposals, saving]);

  useEffect(() => {
    if (phase === 'pending' && !pendingOrganize) {
      setPhase(sourceIds.length > 0 ? 'confirm' : 'results');
    }
  }, [pendingOrganize, phase, sourceIds.length]);

  const handleDismissPending = useCallback(async () => {
    if (busyRef.current || saving || dismissing || !pendingOrganize) return;
    busyRef.current = true;
    setDismissing(true);
    setSaveError(null);
    try {
      const res = await tryAction<{ dismissed?: boolean }>(
        host,
        'source.organize.dismiss',
        pendingOrganize.jobId ? { jobId: pendingOrganize.jobId } : {},
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        const msg = res.error?.message || t(lang, '清除待审课程归类建议失败', 'Failed to dismiss pending organize proposal');
        setSaveError(msg);
        notify(msg, 'error');
        return;
      }
      await onSaved();
      if (!mountedRef.current) return;
      notify(
        t(lang, '已清除待处理的课程归类建议', 'Dismissed pending course-organize proposal'),
        'success',
      );
      if (phase === 'pending') {
        setPhase(sourceIds.length > 0 ? 'confirm' : 'results');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = errorMessage(err, lang);
      setSaveError(msg);
      notify(msg, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setDismissing(false);
    }
  }, [dismissing, host, lang, notify, onSaved, pendingOrganize, phase, saving, sourceIds.length]);

  const handleInspectPending = useCallback(() => {
    if (phase !== 'pending' || !pendingOrganize || busyRef.current || dismissing) return;
    setProposals(pendingParsed.proposals);
    setCheckedIds(pendingParsed.checked);
    setSelectedIndex(0);
    setLoadError(null);
    setSaveError(null);
    setPhase('results');
  }, [dismissing, pendingOrganize, pendingParsed, phase]);

  const modalInteractive =
    isActive && phase !== 'confirm' && !reanalyzeConfirm && (phase === 'pending' || sourceIds.length > 0);

  useInput(
    (input, key) => {
      if (!modalInteractive || saving || dismissing || busyRef.current) return;
      if (input === 'X' && pendingOrganize) {
        void handleDismissPending();
        return;
      }
      if (phase === 'pending') {
        if (key.return) {
          handleInspectPending();
          return;
        }
        if (input === 'g' && sourceIds.length > 0) {
          setPhase('confirm');
          return;
        }
        return;
      }
      if (phase === 'results' && proposals.length > 0) {
        if (input === ' ') {
          handleToggleOne();
          return;
        }
        if (input === 'a') {
          handleToggleAll();
          return;
        }
        if (key.return) {
          void handleSave();
          return;
        }
      }
      if (input === 'r' && (phase === 'results' || phase === 'error')) {
        setReanalyzeConfirm(true);
      }
    },
    { isActive: modalInteractive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (phase === 'pending') {
      const pendingHints: KeyHint[] = [
        { key: 'Enter', label: t(lang, '查看/应用', 'Review') },
        { key: 'X', label: t(lang, '清除待审', 'Dismiss') },
      ];
      if (sourceIds.length > 0) {
        pendingHints.push({ key: 'g', label: t(lang, '重新分析', 'Re-analyze') });
      }
      pendingHints.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
      return pendingHints;
    }
    if (sourceIds.length === 0) {
      return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    }
    if (loading) {
      return [{ key: 'Esc', label: t(lang, '取消', 'Cancel') }];
    }
    if (phase === 'error' || loadError || proposals.length === 0) {
      const errHints: KeyHint[] = [{ key: 'r', label: t(lang, '重试', 'Retry') }];
      if (pendingOrganize) errHints.push({ key: 'X', label: t(lang, '清除待审', 'Dismiss') });
      errHints.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
      return errHints;
    }
    const resultHints: KeyHint[] = [
      { key: 'Space', label: t(lang, '勾选', 'Toggle') },
      { key: 'a', label: t(lang, '全选/取消', 'All/None') },
      { key: 'Enter', label: t(lang, '应用保存', 'Apply') },
      { key: 'r', label: t(lang, '重算', 'Refresh') },
    ];
    if (pendingOrganize) {
      resultHints.push({ key: 'X', label: t(lang, '清除待审', 'Dismiss') });
    }
    return resultHints;
  }, [lang, loadError, loading, pendingOrganize, phase, proposals.length, sourceIds.length]);

  const ell = asciiMode ? '...' : '…';
  const arrow = asciiMode ? '->' : '→';
  const errMark = asciiMode ? 'x' : '✕';
  const sep = asciiMode ? ' | ' : ' · ';

  const renderProposalRow = useCallback(
    (item: OrganizeProposal, ctx: { selected: boolean; width: number }, checked: boolean) => {
      const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
      const box = checked ? (asciiMode ? '[x] ' : '[✓] ') : '[ ] ';
      const curText = item.expectedCourses.length > 0 ? item.expectedCourses.join(', ') : t(lang, '未分配', 'Unassigned');
      const nextText = item.courses.length > 0 ? item.courses.join(', ') : t(lang, '不修改/留空', 'Uncertain');
      const unchanged = sameCourseSet(item.courses, item.expectedCourses);
      const courseDelta = unchanged
        ? `${curText} (${t(lang, '不变', 'same')})`
        : `${curText} ${arrow} ${nextText}`;

      const prefixW = displayWidth(cursor) + displayWidth(box);
      const avail = Math.max(8, ctx.width - prefixW);
      const deltaMax = Math.max(8, Math.min(Math.floor(avail * 0.55), displayWidth(courseDelta)));
      const deltaStr = truncateDisplay(courseDelta, deltaMax, ell);
      const titleMax = Math.max(6, avail - displayWidth(deltaStr) - 2);
      const titleStr = truncateDisplay(item.title, titleMax, ell);

      return (
        <Box flexDirection="row" width={ctx.width}>
          <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
          <Text color={checked ? theme.success : theme.dim} bold={checked}>
            {box}
          </Text>
          <Text color={theme.text} bold={ctx.selected}>
            {titleStr}
          </Text>
          <Box flexGrow={1} />
          <Text color={unchanged ? theme.dim : checked ? theme.accent : theme.muted}>
            {deltaStr}
          </Text>
        </Box>
      );
    },
    [arrow, asciiMode, ell, lang, theme],
  );

  const confirmWidth = Math.min(64, Math.max(40, columns - 4));
  const confirmTitle = t(lang, 'AI 分析资料所属课程', 'AI Organize Materials by Course');
  const confirmBody = exceedsBatchCap
    ? t(
        lang,
        `单次 AI 归类最多支持 ${MAX_ORGANIZE_SUGGEST_SOURCES} 份资料，请缩小范围或分批处理（当前共 ${allEligibleSourceIds.length} 份，将优先分析前 ${sourceIds.length} 份未归类资料，生成结果后由你勾选保存）。`,
        `AI organize supports at most ${MAX_ORGANIZE_SUGGEST_SOURCES} sources per batch; narrow the filter or process in batches (${allEligibleSourceIds.length} total, analyzing the first ${sourceIds.length} prioritized sources for review).`,
      )
    : t(
        lang,
        `将分析 ${sourceIds.length} 份资料并调用 AI 建议课程归属，生成结果后由你勾选确认再保存。`,
        `Analyze ${sourceIds.length} material(s) with AI to suggest course assignments; you review before saving.`,
      );

  if (sourceIds.length > 0 && phase === 'confirm') {
    return (
      <ConfirmDialog
        title={confirmTitle}
        message={confirmBody}
        confirmLabel={t(lang, '开始分析', 'Analyze')}
        cancelLabel={t(lang, '取消', 'Cancel')}
        width={confirmWidth}
        isActive={isActive}
        onConfirm={() => void runSuggest()}
        onCancel={onClose}
      />
    );
  }

  const frameWidth = Math.max(46, Math.min(92, columns - 4));
  const frameHeight = Math.max(14, Math.min(28, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(8, frameHeight - 5);

  const activeProposals = phase === 'pending' ? pendingParsed.proposals : proposals;
  const activeReason = activeProposals[selectedIndex]?.reason;
  const showReasonRow =
    innerHeight >= 10 && (phase === 'pending' || phase === 'results') && activeProposals.length > 0;
  const extraStatusRows = (saving || dismissing || saveError ? 1 : 0) + (showReasonRow ? 1 : 0);
  const listHeight = Math.max(3, innerHeight - 2 - extraStatusRows);

  return (
    <>
      <Modal
        title={t(lang, 'AI 智能整理课程归属', 'AI Organize Courses')}
        subtitle={`${sourceIds.length} ${t(lang, '份资料', 'sources')}`}
        icon={asciiMode ? '*' : '✦'}
        width={frameWidth}
        height={frameHeight}
        isActive={isActive && !reanalyzeConfirm}
        onClose={onClose}
        hints={hints}
      >
        {phase === 'pending' && pendingOrganize ? (
          <Box flexDirection="column" height={innerHeight} width={innerWidth}>
            <Box height={1} flexDirection="row" alignItems="center" width={innerWidth} marginBottom={1}>
              <Badge
                label={t(
                  lang,
                  `待审归类建议 ${pendingParsed.proposals.length}`,
                  `Pending organize ${pendingParsed.proposals.length}`,
                )}
                tone="warning"
                variant="soft"
              />
              <Box flexGrow={1} />
              <Text color={theme.dim} wrap="truncate-end">
                {t(
                  lang,
                  `[X] 清除${sep}[Enter] 查看应用${sep}[g] 重算`,
                  `[X] Dismiss${sep}[Enter] Review${sep}[g] Re-run`,
                )}
              </Text>
            </Box>

            {pendingParsed.proposals.length === 0 ? (
              <EmptyState
                title={t(lang, '存在待处理的课程归类建议', 'Pending course-organize proposal')}
                hint={t(lang, '按 [X] 清除待审状态，或按 [g] 重新分析', 'Press [X] to dismiss, or [g] to re-analyze')}
                width={innerWidth}
                height={Math.max(4, innerHeight - 3)}
              />
            ) : (
              <VirtualList
                items={pendingParsed.proposals}
                height={listHeight}
                width={innerWidth}
                selectedIndex={selectedIndex}
                onChange={(idx) => setSelectedIndex(idx)}
                isActive={modalInteractive && !dismissing}
                ascii={asciiMode}
                keyExtractor={(item) => item.id}
                renderItem={(item, ctx) => renderProposalRow(item, ctx, pendingParsed.checked.has(item.id))}
              />
            )}

            {showReasonRow ? (
              <Box height={1} width={innerWidth}>
                <Text color={theme.dim} wrap="truncate-end">
                  {activeReason
                    ? `${t(lang, '理由: ', 'Reason: ')}${truncateDisplay(activeReason, Math.max(10, innerWidth - 8), ell)}`
                    : t(lang, '按 [Enter] 进入勾选应用，或按 [X] 清除待审建议', 'Press [Enter] to review & apply, or [X] to dismiss')}
                </Text>
              </Box>
            ) : null}

            {dismissing ? (
              <Box height={1}>
                <Spinner label={t(lang, `正在清除待审建议${ell}`, `Dismissing pending proposal${ell}`)} />
              </Box>
            ) : saveError ? (
              <Box>
                <Text color={theme.error} wrap="wrap">
                  {`${errMark} ${saveError}`}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : sourceIds.length === 0 ? (
          <EmptyState
            title={t(lang, '暂无课程整理建议', 'No organization suggestions')}
            hint={t(lang, '当前视图没有可整理的资料', 'No visible materials to organize')}
            width={innerWidth}
            height={innerHeight}
          />
        ) : loading ? (
          <Box height={innerHeight} width={innerWidth} alignItems="center" justifyContent="center">
            <Spinner
              label={t(
                lang,
                `正在分析 ${sourceIds.length} 份资料的课程归属${ell}`,
                `Analyzing ${sourceIds.length} source(s)${ell}`,
              )}
            />
          </Box>
        ) : phase === 'error' || loadError ? (
          <Box height={innerHeight} width={innerWidth} flexDirection="column" justifyContent="center" alignItems="center">
            <Text color={theme.error} bold wrap="wrap">
              {`${errMark} ${loadError || t(lang, '获取 AI 课程归类建议失败', 'Failed to suggest courses')}`}
            </Text>
            <Box marginTop={1}>
              <Text color={theme.muted}>
                {t(lang, '请确认已配置可用模型，按 [r] 重试或 [Esc] 关闭。', 'Check model settings. Press [r] to retry or [Esc] to close.')}
              </Text>
            </Box>
          </Box>
        ) : proposals.length === 0 ? (
          <EmptyState
            title={t(lang, '暂无课程整理建议', 'No organization suggestions')}
            hint={t(lang, 'AI 暂未发现需要调整的课程归属，按 [r] 重试', 'No course changes suggested. Press [r] to retry')}
            width={innerWidth}
            height={innerHeight}
          />
        ) : (
          <Box flexDirection="column" height={innerHeight} width={innerWidth}>
            <Box height={1} flexDirection="row" alignItems="center" width={innerWidth} marginBottom={1}>
              {pendingOrganize ? (
                <>
                  <Badge label={t(lang, '待审', 'Pending')} tone="warning" variant="soft" />
                  <Text> </Text>
                </>
              ) : null}
              <Badge label={`${t(lang, '建议', 'Proposals')} ${proposals.length}`} tone="info" variant="soft" />
              <Text> </Text>
              <Badge
                label={`${t(lang, '已选', 'Selected')} ${checkedIds.size}/${proposals.length}`}
                tone={checkedIds.size > 0 ? 'success' : 'muted'}
                variant="soft"
              />
              <Box flexGrow={1} />
              <Text color={theme.dim} wrap="truncate-end">
                {t(lang, `Space 勾选${sep}a 全选${sep}Enter 应用`, `Space toggle${sep}a all${sep}Enter apply`)}
              </Text>
            </Box>

            <VirtualList
              items={proposals}
              height={listHeight}
              width={innerWidth}
              selectedIndex={selectedIndex}
              onChange={(idx) => setSelectedIndex(idx)}
              isActive={modalInteractive && !saving && !dismissing}
              ascii={asciiMode}
              keyExtractor={(item) => item.id}
              renderItem={(item, ctx) => renderProposalRow(item, ctx, checkedIds.has(item.id))}
            />

            {showReasonRow ? (
              <Box height={1} width={innerWidth}>
                <Text color={theme.dim} wrap="truncate-end">
                  {activeReason
                    ? `${t(lang, '理由: ', 'Reason: ')}${truncateDisplay(activeReason, Math.max(10, innerWidth - 8), ell)}`
                    : t(lang, '按 [Space] 切换勾选，[Enter] 保存已勾选资料的课程归属', 'Press [Space] to toggle, [Enter] to save checked assignments')}
                </Text>
              </Box>
            ) : null}

            {saving || dismissing ? (
              <Box height={1}>
                <Spinner
                  label={
                    dismissing
                      ? t(lang, `正在清除待审建议${ell}`, `Dismissing pending proposal${ell}`)
                      : t(lang, `正在保存课程归属${ell}`, `Saving course assignments${ell}`)
                  }
                />
              </Box>
            ) : saveError ? (
              <Box>
                <Text color={theme.error} wrap="wrap">
                  {`${errMark} ${saveError}`}
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Modal>

      {reanalyzeConfirm && sourceIds.length > 0 ? (
        <ConfirmDialog
          title={confirmTitle}
          message={confirmBody}
          confirmLabel={t(lang, '重新分析', 'Re-analyze')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={confirmWidth}
          isActive={isActive}
          onConfirm={() => {
            setReanalyzeConfirm(false);
            void runSuggest();
          }}
          onCancel={() => setReanalyzeConfirm(false)}
        />
      ) : null}
    </>
  );
});
