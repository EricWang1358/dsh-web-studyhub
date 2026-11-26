import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, StudySnapshot } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import {
  getProgressMap,
  selectDeckMetrics,
  selectInactiveCourseKeys,
  selectStudySummary,
} from '../../selectors/study-metrics.js';

export type RoundScope = 'deck' | 'course' | 'all';
export type RoundFilter = 'all' | 'due' | 'new' | 'wrong';

export interface RoundConfigModalProps {
  host: HostClient;
  isActive: boolean;
  width: number;
  height: number;
  selectedDeckId?: string | null;
  selectedDeckTitle?: string | null;
  activeCourse?: string | null;
  onClose: () => void;
}

type DeckItem = NonNullable<StudySnapshot['decks']>[number];

const ROUND_FILTERS: readonly RoundFilter[] = ['all', 'due', 'new', 'wrong'];
const ROUND_SIZES: readonly number[] = [5, 10, 15, 20, 30, 50];
const ROW_COUNT = 4;

function stepArray<T>(list: readonly T[], current: T, delta: -1 | 1, wrap = true): T {
  const idx = list.indexOf(current);
  if (idx === -1) return list[0];
  if (wrap) return list[(idx + delta + list.length) % list.length];
  return list[Math.max(0, Math.min(list.length - 1, idx + delta))];
}

function defaultRoundSize(snapshot: StudySnapshot | null): number {
  const raw = Number((snapshot?.settings as { practice?: { roundSize?: unknown } } | undefined)?.practice?.roundSize);
  if (ROUND_SIZES.includes(raw)) return raw;
  return 20;
}

export const RoundConfigModal = memo(function RoundConfigModal({
  host,
  isActive,
  width,
  height,
  selectedDeckId,
  selectedDeckTitle,
  activeCourse,
  onClose,
}: RoundConfigModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);

  const decks = useMemo(() => snapshot?.decks ?? [], [snapshot?.decks]);
  const usableDeck = useMemo(() => {
    if (!selectedDeckId) return null;
    const hit = decks.find((d) => d.id === selectedDeckId) ?? null;
    if (!hit || hit.archived) return null;
    return hit;
  }, [decks, selectedDeckId]);

  const resolvedCourse = useMemo(() => {
    const c = activeCourse ?? usableDeck?.course ?? null;
    return typeof c === 'string' && c.trim() ? c.trim() : null;
  }, [activeCourse, usableDeck?.course]);

  const availableScopes = useMemo<RoundScope[]>(() => {
    const list: RoundScope[] = [];
    if (usableDeck) list.push('deck');
    if (resolvedCourse) list.push('course');
    list.push('all');
    return list;
  }, [usableDeck, resolvedCourse]);

  const [focusRow, setFocusRow] = useState<number>(0);
  const [scope, setScope] = useState<RoundScope>(() =>
    usableDeck ? 'deck' : resolvedCourse ? 'course' : 'all',
  );
  const [only, setOnly] = useState<RoundFilter>('all');
  const [focusOnly, setFocusOnly] = useState<boolean>(false);
  const [size, setSize] = useState<number>(() => defaultRoundSize(snapshot));
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const effectiveScope: RoundScope = availableScopes.includes(scope) ? scope : availableScopes[0];

  const poolStats = useMemo(() => {
    if (effectiveScope === 'deck' && usableDeck) {
      const m = selectDeckMetrics(usableDeck, getProgressMap(snapshot));
      return { total: m.total, due: m.due, newCount: m.newCount, wrong: m.weak };
    }
    const excludeInactiveCourses = effectiveScope === 'all' ? selectInactiveCourseKeys(snapshot) : undefined;
    const summary = selectStudySummary(
      snapshot,
      effectiveScope === 'course' ? resolvedCourse : null,
      excludeInactiveCourses ? { excludeInactiveCourses } : undefined,
    );
    return {
      total: summary.totalCards,
      due: summary.due,
      newCount: summary.newCount,
      wrong: summary.weak,
    };
  }, [snapshot, effectiveScope, usableDeck, resolvedCourse]);

  const deckDisplayTitle = useMemo(() => {
    if (usableDeck) return String(usableDeck.title ?? usableDeck.name ?? usableDeck.id);
    if (selectedDeckTitle) return selectedDeckTitle;
    return selectedDeckId ?? '';
  }, [usableDeck, selectedDeckTitle, selectedDeckId]);

  const handleStart = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setError('');

    const args: Record<string, unknown> = {
      mode: 'path',
      size,
      fresh: true,
    };
    if (effectiveScope === 'deck' && usableDeck) {
      args.deckId = usableDeck.id;
    } else if (effectiveScope === 'course' && resolvedCourse) {
      args.course = resolvedCourse;
    }
    if (only !== 'all') {
      args.only = only;
    }
    if (focusOnly) {
      args.focusOnly = true;
    }

    const res = await tryAction<{ id?: string }>(host, 'review.start', args);
    if (!mountedRef.current) return;
    busyRef.current = false;
    setSubmitting(false);

    if (!res.ok || !res.value?.id) {
      const msg =
        res.error?.message ||
        t(lang, '当前筛选条件下没有可练习题目，请调整范围或筛选条件', 'No matching cards found; try broadening scope or filter');
      setError(msg);
      return;
    }

    onClose();
    navigate('review', { runId: res.value.id });
  }, [host, size, effectiveScope, usableDeck, resolvedCourse, only, focusOnly, lang, onClose, navigate]);

  const stepRowValue = useCallback(
    (row: number, dir: -1 | 1) => {
      setError('');
      if (row === 0) {
        setScope((prev) => {
          const cur = availableScopes.includes(prev) ? prev : availableScopes[0];
          return stepArray(availableScopes, cur, dir, true);
        });
      } else if (row === 1) {
        setOnly((prev) => stepArray(ROUND_FILTERS, prev, dir, true));
      } else if (row === 2) {
        setFocusOnly((prev) => !prev);
      } else if (row === 3) {
        setSize((prev) => stepArray(ROUND_SIZES, prev, dir, false));
      }
    },
    [availableScopes],
  );

  useInput(
    (input, key) => {
      if (busyRef.current || submitting) return;

      if (key.return) {
        void handleStart();
        return;
      }
      if (key.upArrow || input === 'k') {
        setFocusRow((r) => (r - 1 + ROW_COUNT) % ROW_COUNT);
        return;
      }
      if (key.downArrow || input === 'j' || key.tab) {
        setFocusRow((r) => (r + 1) % ROW_COUNT);
        return;
      }
      if (key.leftArrow || input === 'h') {
        stepRowValue(focusRow, -1);
        return;
      }
      if (key.rightArrow || input === 'l') {
        stepRowValue(focusRow, 1);
        return;
      }
      if (input === ' ') {
        if (focusRow === 3) {
          setError('');
          setSize((prev) => stepArray(ROUND_SIZES, prev, 1, true));
        } else {
          stepRowValue(focusRow, 1);
        }
        return;
      }
      if (input === '+' || input === '=') {
        setError('');
        setSize((prev) => stepArray(ROUND_SIZES, prev, 1, false));
        return;
      }
      if (input === '-' || input === '_') {
        setError('');
        setSize((prev) => stepArray(ROUND_SIZES, prev, -1, false));
        return;
      }
      if (input === '1') {
        setError('');
        setOnly('all');
      } else if (input === '2') {
        setError('');
        setOnly('due');
      } else if (input === '3') {
        setError('');
        setOnly('new');
      } else if (input === '4') {
        setError('');
        setOnly('wrong');
      } else if (input === 'f') {
        setError('');
        setFocusOnly((v) => !v);
      } else if (input === 's') {
        setError('');
        setScope((prev) => {
          const cur = availableScopes.includes(prev) ? prev : availableScopes[0];
          return stepArray(availableScopes, cur, 1, true);
        });
      }
    },
    { isActive },
  );

  const frameW = Math.max(46, Math.min(76, width - 4));
  const frameH = Math.max(15, Math.min(20, height - 4));
  const innerW = modalContentWidth(frameW);
  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? '|' : '·';
  const pointer = asciiMode ? '> ' : '▸ ';

  const arrowUpDown = asciiMode ? 'j/k' : '↑/↓';
  const arrowLeftRight = asciiMode ? '<-/->' : '←/→';
  const hints = useMemo<KeyHint[]>(
    () => [
      { key: arrowUpDown, label: t(lang, '选行', 'Row') },
      { key: `${arrowLeftRight}/Space`, label: t(lang, '切换', 'Set') },
      { key: '+/-', label: t(lang, '题数', 'Size') },
      { key: 'Enter', label: t(lang, '开始', 'Start') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ],
    [arrowUpDown, arrowLeftRight, lang],
  );

  const labelW = lang === 'zh' ? 10 : 12;
  const formatRowLabel = (zh: string, en: string, focused: boolean) => {
    const label = t(lang, zh, en);
    const padded = padDisplay(truncateDisplay(label, labelW, ell), labelW);
    return (
      <Text color={focused ? theme.primary : theme.muted} bold={focused}>
        {focused ? pointer : '  '}
        {padded}{' '}
      </Text>
    );
  };

  const scopeBadgeLabel = (sc: RoundScope): string => {
    if (sc === 'deck') {
      return `${t(lang, '题组', 'Deck')}: ${truncateDisplay(deckDisplayTitle || t(lang, '当前', 'Selected'), 10, ell)}`;
    }
    if (sc === 'course') {
      return `${t(lang, '课程', 'Course')}: ${truncateDisplay(resolvedCourse || '', 10, ell)}`;
    }
    return t(lang, '全部课程', 'All Courses');
  };

  const filterLabel = (f: RoundFilter): string => {
    switch (f) {
      case 'all':
        return t(lang, '智能混合', 'Smart Mix');
      case 'due':
        return t(lang, '仅到期', 'Due Only');
      case 'new':
        return t(lang, '仅新题', 'New Only');
      case 'wrong':
        return t(lang, '仅错题', 'Wrong Only');
    }
  };

  const activeScopeSummary =
    effectiveScope === 'deck' && usableDeck
      ? `${t(lang, '题组', 'Deck')}: ${deckDisplayTitle}`
      : effectiveScope === 'course' && resolvedCourse
        ? `${t(lang, '课程', 'Course')}: ${resolvedCourse}`
        : t(lang, '全部课程', 'All Courses');

  const poolStatsText = `${t(lang, '到期', 'Due')} ${poolStats.due} ${sep} ${t(lang, '新', 'New')} ${poolStats.newCount} ${sep} ${t(lang, '错', 'Wrong')} ${poolStats.wrong} ${sep} ${t(lang, '共', 'Total')} ${poolStats.total}`;
  const scopeMaxW = Math.max(12, innerW - displayWidth(poolStatsText) - 3);
  const summaryLine = `${truncateDisplay(activeScopeSummary, scopeMaxW, ell)} ${sep} ${poolStatsText}`;

  const matchingPoolCount =
    only === 'all'
      ? poolStats.total
      : only === 'due'
        ? poolStats.due
        : only === 'new'
          ? poolStats.newCount
          : poolStats.wrong;

  return (
    <Modal
      title={t(lang, '定制本轮练习', 'Configure Practice Round')}
      icon={asciiMode ? '>' : '▶'}
      tone="primary"
      subtitle={`${size} ${t(lang, '题', 'cards')}`}
      width={frameW}
      height={frameH}
      onClose={submitting ? undefined : onClose}
      isActive={isActive}
      hints={hints}
    >
      {/* Scope & Pool Summary */}
      <Box height={1} overflow="hidden">
        <Text color={theme.text} wrap="truncate-end">
          {truncateDisplay(summaryLine, innerW, ell)}
        </Text>
      </Box>

      <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>

      {/* Row 0: Target Scope */}
      <Box height={1} flexDirection="row" overflow="hidden">
        {formatRowLabel('练习范围', 'Scope', focusRow === 0)}
        <Box flexDirection="row" gap={1} overflow="hidden">
          {availableScopes.map((sc) => (
            <Badge
              key={sc}
              label={scopeBadgeLabel(sc)}
              tone={effectiveScope === sc ? 'primary' : 'neutral'}
              variant={effectiveScope === sc ? 'solid' : 'outline'}
              bold={effectiveScope === sc}
            />
          ))}
        </Box>
      </Box>

      {/* Row 1: Filter (only) */}
      <Box height={1} flexDirection="row" overflow="hidden" marginTop={1}>
        {formatRowLabel('题型筛选', 'Filter', focusRow === 1)}
        <Box flexDirection="row" gap={1} overflow="hidden">
          {ROUND_FILTERS.map((f) => (
            <Badge
              key={f}
              label={filterLabel(f)}
              tone={only === f ? 'accent' : 'neutral'}
              variant={only === f ? 'solid' : 'outline'}
              bold={only === f}
            />
          ))}
        </Box>
      </Box>

      {/* Row 2: Focus Only */}
      <Box height={1} flexDirection="row" overflow="hidden" marginTop={1}>
        {formatRowLabel('考纲重点', 'Focus Only', focusRow === 2)}
        <Box flexDirection="row" gap={1} overflow="hidden">
          <Badge
            label={t(lang, '关闭 OFF', 'OFF')}
            tone={!focusOnly ? 'primary' : 'neutral'}
            variant={!focusOnly ? 'solid' : 'outline'}
            bold={!focusOnly}
          />
          <Badge
            label={t(lang, '仅练考纲重点 ON', 'Focus Cards Only ON')}
            tone={focusOnly ? 'ai' : 'neutral'}
            variant={focusOnly ? 'solid' : 'outline'}
            bold={focusOnly}
          />
        </Box>
      </Box>

      {/* Row 3: Round Size */}
      <Box height={1} flexDirection="row" overflow="hidden" marginTop={1}>
        {formatRowLabel('本轮题数', 'Round Size', focusRow === 3)}
        <Box flexDirection="row" gap={1} overflow="hidden">
          {ROUND_SIZES.map((n) => (
            <Badge
              key={n}
              label={n}
              tone={size === n ? 'success' : 'neutral'}
              variant={size === n ? 'solid' : 'outline'}
              bold={size === n}
            />
          ))}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>
      </Box>

      {/* Status / Inline Error / Start Preview */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {submitting ? (
          <Spinner label={t(lang, '正在生成本轮题目…', 'Starting practice round…')} active={isActive} />
        ) : error ? (
          <Text color={theme.error} wrap="wrap">
            {`${asciiMode ? '! ' : '✕ '}${error}`}
          </Text>
        ) : (
          <>
            <Text color={matchingPoolCount === 0 ? theme.warning : theme.muted} wrap="truncate-end">
              {matchingPoolCount === 0
                ? `${asciiMode ? '! ' : '▲ '}${t(
                    lang,
                    '当前筛选在本地统计为 0 题，按 Enter 将尝试启动或可先放宽条件',
                    '0 matching cards in current snapshot; broaden filter or press Enter to check',
                  )}`
                : truncateDisplay(
                    `${t(lang, '就绪', 'Ready')}: ${filterLabel(only)} ${sep} ${
                      focusOnly ? t(lang, '仅考纲重点', 'Focus only') : t(lang, '全部难度', 'All cards')
                    } ${sep} ${t(lang, `最多 ${size} 题`, `up to ${size} cards`)}`,
                    innerW,
                    ell,
                  )}
            </Text>
            <Text color={theme.dim} wrap="truncate-end">
              {truncateDisplay(
                t(
                  lang,
                  `快捷键: [1-4] 筛选 ${sep} [f] 重点开关 ${sep} [s] 范围 ${sep} [+/-] 题数`,
                  `Keys: [1-4] filter ${sep} [f] focus ${sep} [s] scope ${sep} [+/-] size`,
                ),
                innerW,
                ell,
              )}
            </Text>
          </>
        )}
      </Box>
    </Modal>
  );
});
