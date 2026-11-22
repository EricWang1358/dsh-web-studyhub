import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  Spinner,
  VirtualList,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
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

/** Collect up to 100 page-level sourceIds, prioritizing unassigned visible sources. */
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
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useWindowSize();

  const sourceIds = useMemo(() => collectOrganizeSourceIds(groups, allGroups), [groups, allGroups]);

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

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<OrganizeProposal[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    if (!isActive) return;
    if (sourceIds.length === 0) {
      setLoading(false);
      setLoadError(null);
      setProposals([]);
      setCheckedIds(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);

    void tryAction<{ proposals?: RawOrganizeProposal[] }>(host, 'source.organize.suggest', {
      sourceIds,
    }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.value) {
        setProposals([]);
        setCheckedIds(new Set());
        setLoadError(res.error?.message || t(lang, '获取 AI 课程归类建议失败', 'Failed to suggest courses'));
        return;
      }
      const rawList = Array.isArray(res.value.proposals) ? res.value.proposals : [];
      const parsed: OrganizeProposal[] = [];
      const initialChecked = new Set<string>();
      for (const item of rawList) {
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
      setProposals(parsed);
      setCheckedIds(initialChecked);
      setSelectedIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [host, isActive, lang, reloadSeq, sourceIds, titleById]);

  useEffect(() => {
    if (selectedIndex >= proposals.length) {
      setSelectedIndex(Math.max(0, proposals.length - 1));
    }
  }, [proposals.length, selectedIndex]);

  const currentProposal = proposals[selectedIndex];

  const handleToggleOne = useCallback(() => {
    if (!currentProposal || loading || saving) return;
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(currentProposal.id)) next.delete(currentProposal.id);
      else next.add(currentProposal.id);
      return next;
    });
  }, [currentProposal, loading, saving]);

  const handleToggleAll = useCallback(() => {
    if (loading || saving || proposals.length === 0) return;
    setCheckedIds((prev) => {
      if (prev.size === proposals.length) return new Set();
      return new Set(proposals.map((p) => p.id));
    });
  }, [loading, proposals, saving]);

  const handleSave = useCallback(async () => {
    if (loading || saving || proposals.length === 0) return;
    const selected = proposals.filter((p) => checkedIds.has(p.id));
    if (selected.length === 0) {
      notify(t(lang, '请先勾选至少一项课程归类建议', 'Select at least one proposal to apply'), 'warning');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const assignments = selected.map((p) => ({
        id: p.id,
        courses: p.courses,
        expectedCourses: p.expectedCourses,
      }));
      const res = await tryAction<{ updated?: number }>(host, 'source.courses.set', { assignments });
      if (!res.ok) {
        const msg = res.error?.message || t(lang, '保存课程归属失败', 'Failed to save course assignments');
        setSaveError(msg);
        notify(msg, 'error');
        return;
      }
      await onSaved();
      const count = res.value?.updated ?? assignments.length;
      notify(
        t(lang, `已更新 ${count} 份资料的课程归属`, `Updated course assignments for ${count} source(s)`),
        'success',
      );
      onClose();
    } catch (err) {
      const msg = errorMessage(err);
      setSaveError(msg);
      notify(msg, 'error');
    } finally {
      setSaving(false);
    }
  }, [checkedIds, host, lang, loading, notify, onClose, onSaved, proposals, saving]);

  useInput(
    (input, key) => {
      if (!isActive || saving) return;
      if (input === ' ') {
        handleToggleOne();
      } else if (input === 'a') {
        handleToggleAll();
      } else if (key.return) {
        void handleSave();
      } else if (input === 'r' && !loading) {
        setReloadSeq((n) => n + 1);
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (loading) {
      return [{ key: 'Esc', label: t(lang, '取消', 'Cancel') }];
    }
    if (loadError || proposals.length === 0) {
      return [
        { key: 'r', label: t(lang, '重试', 'Retry') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'Space', label: t(lang, '勾选', 'Toggle') },
      { key: 'a', label: t(lang, '全选/取消', 'All/None') },
      { key: 'Enter', label: t(lang, '应用保存', 'Apply') },
      { key: 'r', label: t(lang, '重算', 'Refresh') },
    ];
  }, [lang, loadError, loading, proposals.length]);

  const frameWidth = Math.max(46, Math.min(92, columns - 4));
  const frameHeight = Math.max(14, Math.min(28, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(8, frameHeight - 5);

  const ell = asciiMode ? '...' : '…';
  const arrow = asciiMode ? '->' : '→';
  const errMark = asciiMode ? 'x' : '✕';

  const showReasonRow = innerHeight >= 10 && proposals.length > 0;
  const extraStatusRows = (saving || saveError ? 1 : 0) + (showReasonRow ? 1 : 0);
  const listHeight = Math.max(3, innerHeight - 2 - extraStatusRows);

  return (
    <Modal
      title={t(lang, 'AI 智能整理课程归属', 'AI Organize Courses')}
      subtitle={`${sourceIds.length} ${t(lang, '份资料', 'sources')}`}
      icon={asciiMode ? '*' : '✦'}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {loading ? (
        <Box height={innerHeight} width={innerWidth} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在分析 ${sourceIds.length} 份资料的课程归属…`, `Analyzing ${sourceIds.length} source(s)…`)} />
        </Box>
      ) : loadError ? (
        <Box height={innerHeight} width={innerWidth} flexDirection="column" justifyContent="center" alignItems="center">
          <Text color={theme.error} bold>
            {`${errMark} ${truncateDisplay(loadError, Math.max(20, innerWidth - 4), ell)}`}
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
          hint={
            sourceIds.length === 0
              ? t(lang, '当前视图没有可整理的资料', 'No visible materials to organize')
              : t(lang, 'AI 暂未发现需要调整的课程归属，按 [r] 重试', 'No course changes suggested. Press [r] to retry')
          }
          width={innerWidth}
          height={innerHeight}
        />
      ) : (
        <Box flexDirection="column" height={innerHeight} width={innerWidth}>
          <Box height={1} flexDirection="row" alignItems="center" width={innerWidth} marginBottom={1}>
            <Badge label={`${t(lang, '建议', 'Proposals')} ${proposals.length}`} tone="info" variant="soft" />
            <Text> </Text>
            <Badge
              label={`${t(lang, '已选', 'Selected')} ${checkedIds.size}/${proposals.length}`}
              tone={checkedIds.size > 0 ? 'success' : 'muted'}
              variant="soft"
            />
            <Box flexGrow={1} />
            <Text color={theme.dim} wrap="truncate-end">
              {t(lang, 'Space 勾选 · a 全选 · Enter 应用', 'Space toggle · a all · Enter apply')}
            </Text>
          </Box>

          <VirtualList
            items={proposals}
            height={listHeight}
            width={innerWidth}
            selectedIndex={selectedIndex}
            onChange={(idx) => setSelectedIndex(idx)}
            isActive={isActive && !saving}
            keyExtractor={(item) => item.id}
            renderItem={(item, ctx) => {
              const checked = checkedIds.has(item.id);
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
            }}
          />

          {showReasonRow ? (
            <Box height={1} width={innerWidth}>
              <Text color={theme.dim} wrap="truncate-end">
                {currentProposal?.reason
                  ? `${t(lang, '理由: ', 'Reason: ')}${truncateDisplay(currentProposal.reason, Math.max(10, innerWidth - 8), ell)}`
                  : t(lang, '按 [Space] 切换勾选，[Enter] 保存已勾选资料的课程归属', 'Press [Space] to toggle, [Enter] to save checked assignments')}
              </Text>
            </Box>
          ) : null}

          {saving ? (
            <Box height={1}>
              <Spinner label={t(lang, '正在保存课程归属…', 'Saving course assignments…')} />
            </Box>
          ) : saveError ? (
            <Box height={1}>
              <Text color={theme.error} wrap="truncate-end">
                {`${errMark} ${truncateDisplay(saveError, Math.max(12, innerWidth - 3), ell)}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
