import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction } from '../../host/index.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import {
  Badge,
  EmptyState,
  Modal,
  ProgressBar,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';

export interface StudyMapModalProps {
  host: HostClient;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
}

export interface StudyMapCounts {
  new?: number;
  weak?: number;
  learning?: number;
  familiar?: number;
  mastered?: number;
}

export interface StudyMapTopic {
  name: string;
  total: number;
  counts?: StudyMapCounts;
  mastery: number;
  due: number;
  status: string;
}

export interface StudyMapDeck {
  id: string;
  title: string;
  folder?: string;
  archived?: boolean;
  total: number;
  mastery: number;
  counts?: StudyMapCounts;
  due: number;
  status: string;
  topics?: StudyMapTopic[];
  inactive?: boolean;
}

export interface StudyMapResponse {
  today?: {
    due?: number;
    weak?: number;
    new?: number;
    total?: number;
    size?: number;
    course?: string | null;
    dueTotal?: number;
  };
  next?: {
    deckId: string;
    deckTitle: string;
    topic: string;
    mastery: number;
    focus?: boolean;
  } | null;
  mastery?: {
    course?: { name: string; value: number; cards: number } | null;
    library?: { value: number; cards: number } | null;
  };
  decks?: StudyMapDeck[];
}

type MapRow =
  | {
      kind: 'course';
      key: string;
      course: string;
      label: string;
      mastery: number;
      total: number;
      due: number;
      weak: number;
      inactive: boolean;
      deckIds: string[];
    }
  | {
      kind: 'deck';
      key: string;
      course: string;
      courseLabel: string;
      deckId: string;
      label: string;
      mastery: number;
      total: number;
      due: number;
      weak: number;
      status: string;
      inactive: boolean;
    }
  | {
      kind: 'topic';
      key: string;
      course: string;
      courseLabel: string;
      deckId: string;
      deckTitle: string;
      topic: string;
      label: string;
      mastery: number;
      total: number;
      due: number;
      weak: number;
      status: string;
    };

export const StudyMapModal = memo(function StudyMapModal({
  host,
  width,
  height,
  isActive,
  onClose,
}: StudyMapModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();
  const { columns, rows } = useWindowSize();

  const activeCourse = currentCourse(snapshot);

  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [mapData, setMapData] = useState<StudyMapResponse | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');

    void tryAction<StudyMapResponse>(host, 'map', {}).then((res) => {
      if (cancelled || !mountedRef.current || reqSeqRef.current !== seq) return;
      if (!res.ok) {
        setMapData(null);
        setError(res.error?.message || t(lang, '加载知识地图失败', 'Failed to load study map'));
      } else {
        setMapData(res.value ?? null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [host, isActive, reloadSeq, lang]);

  const deckCourseMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of snapshot?.decks ?? []) {
      const c = (d.course ?? '').trim();
      if (c) m.set(d.id, c);
    }
    return m;
  }, [snapshot?.decks]);

  const filteredRows: MapRow[] = useMemo(() => {
    const rawDecks = (mapData?.decks ?? []).filter((d) => !d.archived);
    if (rawDecks.length === 0) return [];

    type CourseGroup = {
      course: string;
      label: string;
      decks: StudyMapDeck[];
      weighted: number;
      total: number;
      due: number;
      weak: number;
      allInactive: boolean;
    };

    const groups = new Map<string, CourseGroup>();
    const uncatLabel = t(lang, '未分组', 'Uncategorized');

    for (const d of rawDecks) {
      const course = (deckCourseMap.get(d.id) ?? d.folder ?? '').trim();
      const label = course || uncatLabel;
      const g = groups.get(course) ?? {
        course,
        label,
        decks: [],
        weighted: 0,
        total: 0,
        due: 0,
        weak: 0,
        allInactive: true,
      };
      g.decks.push(d);
      const count = Math.max(0, Number(d.total) || 0);
      g.weighted += (Number(d.mastery) || 0) * count;
      g.total += count;
      g.due += Math.max(0, Number(d.due) || 0);
      g.weak += Math.max(0, Number(d.counts?.weak) || 0);
      if (!d.inactive) g.allInactive = false;
      groups.set(course, g);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => {
      if (activeCourse) {
        if (a.course === activeCourse && b.course !== activeCourse) return -1;
        if (b.course === activeCourse && a.course !== activeCourse) return 1;
      }
      if (a.allInactive !== b.allInactive) return a.allInactive ? 1 : -1;
      return a.label.localeCompare(b.label);
    });

    const q = filterQuery.trim().toLowerCase();
    const out: MapRow[] = [];

    for (const g of sortedGroups) {
      const courseMatches = !q || g.label.toLowerCase().includes(q);
      const deckRowsForGroup: MapRow[] = [];

      for (const d of g.decks) {
        const deckMatches = courseMatches || d.title.toLowerCase().includes(q);
        const topics = Array.isArray(d.topics) ? d.topics : [];
        const matchedTopics = deckMatches
          ? topics
          : topics.filter((tp) => tp.name.toLowerCase().includes(q));

        if (!deckMatches && matchedTopics.length === 0) continue;

        deckRowsForGroup.push({
          kind: 'deck',
          key: `deck:${d.id}`,
          course: g.course,
          courseLabel: g.label,
          deckId: d.id,
          label: d.title,
          mastery: Math.max(0, Math.min(100, Math.round(Number(d.mastery) || 0))),
          total: Math.max(0, Number(d.total) || 0),
          due: Math.max(0, Number(d.due) || 0),
          weak: Math.max(0, Number(d.counts?.weak) || 0),
          status: d.status || 'todo',
          inactive: Boolean(d.inactive),
        });

        for (const tp of matchedTopics) {
          deckRowsForGroup.push({
            kind: 'topic',
            key: `topic:${d.id}:${tp.name}`,
            course: g.course,
            courseLabel: g.label,
            deckId: d.id,
            deckTitle: d.title,
            topic: tp.name,
            label: tp.name,
            mastery: Math.max(0, Math.min(100, Math.round(Number(tp.mastery) || 0))),
            total: Math.max(0, Number(tp.total) || 0),
            due: Math.max(0, Number(tp.due) || 0),
            weak: Math.max(0, Number(tp.counts?.weak) || 0),
            status: tp.status || 'todo',
          });
        }
      }

      if (deckRowsForGroup.length === 0) continue;

      const courseMastery = g.total > 0 ? Math.round(g.weighted / g.total) : 0;
      out.push({
        kind: 'course',
        key: `course:${g.course || '__uncategorized__'}`,
        course: g.course,
        label: g.label,
        mastery: Math.max(0, Math.min(100, courseMastery)),
        total: g.total,
        due: g.due,
        weak: g.weak,
        inactive: g.allInactive,
        deckIds: g.decks.map((d) => d.id),
      });
      out.push(...deckRowsForGroup);
    }

    return out;
  }, [mapData?.decks, deckCourseMap, lang, activeCourse, filterQuery]);

  useEffect(() => {
    if (selectedIdx >= filteredRows.length) {
      setSelectedIdx(Math.max(0, filteredRows.length - 1));
    }
  }, [filteredRows.length, selectedIdx]);

  const launchRow = useCallback(
    async (row: MapRow | undefined) => {
      if (!row || busyRef.current) return;
      if (row.total <= 0) {
        notify(t(lang, '当前范围暂无可练题目', 'No cards in selected scope'), 'info');
        return;
      }

      busyRef.current = true;
      setStarting(true);
      setError('');

      try {
        if (row.course && row.course !== activeCourse) {
          const focusRes = await tryAction(host, 'focus.set', { course: row.course });
          if (focusRes.ok) {
            await refreshSnapshot();
          }
        }

        const startArgs: Record<string, unknown> =
          row.kind === 'topic'
            ? { mode: 'path', scope: [{ deckId: row.deckId, topic: row.topic }], fresh: true }
            : row.kind === 'deck'
              ? { mode: 'path', scope: [{ deckId: row.deckId }], fresh: true }
              : row.course
                ? { mode: 'course', course: row.course, fresh: true }
                : { mode: 'path', scope: row.deckIds.map((deckId) => ({ deckId })), fresh: true };

        const res = await tryAction<{ id?: string }>(host, 'review.start', startArgs);
        if (!mountedRef.current) return;
        if (!res.ok || !res.value?.id) {
          const msg = res.error?.message || t(lang, '无法启动练习', 'Failed to start practice');
          setError(msg);
          notify(msg, 'error');
          return;
        }
        onClose();
        navigate('review', {
          runId: res.value.id,
          ...(row.course ? { course: row.course } : {}),
        });
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setStarting(false);
      }
    },
    [activeCourse, host, lang, navigate, notify, onClose, refreshSnapshot],
  );

  useInput(
    (input) => {
      if (loading || starting) return;
      if (input === '/') {
        setFilterFocused(true);
        return;
      }
      if (input === 'r') {
        setReloadSeq((n) => n + 1);
        return;
      }
      if (input === 'c' && filterQuery) {
        setFilterQuery('');
        setSelectedIdx(0);
      }
    },
    { isActive: isActive && !filterFocused },
  );

  const availW = Math.min(width, columns);
  const availH = Math.min(height, rows);
  const frameW = Math.max(46, Math.min(92, availW - 4));
  const frameH = Math.max(14, Math.min(30, availH - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(6, frameH - 5);
  const filterInputW = Math.max(12, modalContentWidth(frameW) - 10);

  const showFilterRow = filterFocused || filterQuery.length > 0;
  const showNextRow = Boolean(mapData?.next?.topic) && bodyH >= 11;
  const showErrorRow = Boolean(error);
  const overheadRows = 1 + (showNextRow ? 1 : 0) + (showFilterRow ? 1 : 0) + (showErrorRow ? 1 : 0);
  const listH = Math.max(3, bodyH - overheadRows);

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' | ' : ' · ';

  const hints = useMemo<KeyHint[]>(() => {
    if (filterFocused) {
      return [
        { key: 'Enter', label: t(lang, '应用筛选', 'Apply') },
        { key: 'Esc', label: t(lang, '清空退出', 'Clear') },
      ];
    }
    const items: KeyHint[] = [
      { key: 'j/k', label: t(lang, '移动', 'Move') },
      { key: 'Enter', label: t(lang, '练习', 'Practise') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
    ];
    if (filterQuery) {
      items.push({ key: 'c', label: t(lang, '清空', 'Clear') });
    }
    items.push({ key: 'r', label: t(lang, '刷新', 'Reload') });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [filterFocused, filterQuery, lang]);

  const renderRow = useCallback(
    (row: MapRow, ctx: VirtualListRenderContext) => {
      const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
      const compact = ctx.width < 68;
      const barW = ctx.width >= 78 ? 12 : ctx.width >= 60 ? 8 : 6;
      const pctText = ` ${String(row.mastery).padStart(3, ' ')}%`;

      const indent = row.kind === 'topic' ? '    ' : row.kind === 'deck' ? '  ' : '';
      const tag =
        row.kind === 'course'
          ? compact
            ? t(lang, '[课]', '[C]')
            : t(lang, '[课程]', '[CRS]')
          : row.kind === 'deck'
            ? compact
              ? t(lang, '[组]', '[D]')
              : t(lang, '[题组]', '[DECK]')
            : compact
              ? t(lang, '[点]', '[T]')
              : t(lang, '[考点]', '[TOP]');

      const metaParts: string[] = [];
      if (row.due > 0) metaParts.push(compact ? `d${row.due}` : t(lang, `到${row.due}`, `due ${row.due}`));
      if (row.weak > 0) metaParts.push(compact ? `w${row.weak}` : t(lang, `弱${row.weak}`, `weak ${row.weak}`));
      metaParts.push(`${row.total}${t(lang, '题', 'c')}`);
      if (row.kind !== 'topic' && row.inactive) {
        metaParts.push(t(lang, '停用', 'parked'));
      }
      const metaSep = asciiMode ? '/' : '·';
      const rightMeta = ` ${metaParts.join(metaSep)}`;

      const prefix = `${pointer}${indent}${tag} `;
      const rightTotalW = barW + displayWidth(pctText) + displayWidth(rightMeta);
      const titleW = Math.max(6, ctx.width - displayWidth(prefix) - rightTotalW - 1);
      const titleStr = padDisplay(truncateDisplay(row.label, titleW, ell), titleW);

      const tagColor = ctx.selected
        ? theme.selectionFg
        : row.kind === 'course'
          ? theme.primary
          : row.kind === 'deck'
            ? theme.accent
            : theme.muted;

      const labelColor = ctx.selected
        ? theme.selectionFg
        : row.kind === 'course'
          ? theme.text
          : row.kind === 'deck'
            ? theme.text
            : theme.muted;

      const pctColor = ctx.selected
        ? theme.selectionFg
        : row.mastery >= 80
          ? theme.success
          : row.mastery >= 50
            ? theme.primary
            : theme.warning;

      const metaColor = ctx.selected
        ? theme.selectionFg
        : row.weak > 0
          ? theme.error
          : row.due > 0
            ? theme.warning
            : theme.dim;

      return (
        <Box flexDirection="row" width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
            {pointer}
          </Text>
          {indent ? <Text>{indent}</Text> : null}
          <Text color={tagColor} bold={row.kind === 'course' || ctx.selected}>
            {`${tag} `}
          </Text>
          <Text color={labelColor} bold={row.kind === 'course' || ctx.selected}>
            {`${titleStr} `}
          </Text>
          <ProgressBar ratio={row.mastery / 100} width={barW} style="block" showPercent={false} />
          <Text color={pctColor} bold={ctx.selected}>
            {pctText}
          </Text>
          <Text color={metaColor}>{rightMeta}</Text>
        </Box>
      );
    },
    [asciiMode, ell, lang, theme],
  );

  const courseMastery = mapData?.mastery?.course;
  const libraryMastery = mapData?.mastery?.library;
  const dueTotal = mapData?.today?.dueTotal ?? mapData?.today?.due ?? 0;

  const summaryBits: string[] = [];
  if (courseMastery) {
    summaryBits.push(
      t(
        lang,
        `${courseMastery.name}: ${courseMastery.value}% (${courseMastery.cards}题)`,
        `${courseMastery.name}: ${courseMastery.value}% (${courseMastery.cards}c)`,
      ),
    );
  }
  if (libraryMastery) {
    summaryBits.push(
      t(
        lang,
        `全库 ${libraryMastery.value}% (${libraryMastery.cards}题)`,
        `Library ${libraryMastery.value}% (${libraryMastery.cards}c)`,
      ),
    );
  }
  if (dueTotal > 0) {
    summaryBits.push(t(lang, `今日到期 ${dueTotal}`, `Due ${dueTotal}`));
  }

  const subtitle = courseMastery
    ? `${courseMastery.name}${sep}${courseMastery.value}%`
    : libraryMastery
      ? t(lang, `全库 ${libraryMastery.value}%`, `Library ${libraryMastery.value}%`)
      : undefined;

  return (
    <Modal
      title={t(lang, '知识掌握地图', 'Knowledge Mastery Map')}
      subtitle={subtitle}
      icon={asciiMode ? '%' : '◈'}
      tone="primary"
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive && !filterFocused}
      hints={hints}
    >
      {/* Top summary line */}
      <Box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0} overflow="hidden">
        <Text color={theme.muted} wrap="truncate">
          {truncateDisplay(
            summaryBits.join(sep) || t(lang, '按课程、题组与考点查看掌握度', 'Mastery by course, deck & topic'),
            Math.max(10, innerW - (starting ? 14 : 0)),
            ell,
          )}
        </Text>
        {starting ? <Spinner label={t(lang, '启动中...', 'Starting...')} active={isActive} /> : null}
      </Box>

      {/* Recommended next topic */}
      {showNextRow && mapData?.next ? (
        <Box flexDirection="row" gap={1} height={1} flexShrink={0} overflow="hidden">
          <Badge label={t(lang, '推荐下一步', 'NEXT')} tone="accent" variant="soft" />
          <Text color={theme.text} wrap="truncate">
            {truncateDisplay(
              `${mapData.next.deckTitle}${sep}${mapData.next.topic} (${mapData.next.mastery}%)`,
              Math.max(10, innerW - 14),
              ell,
            )}
          </Text>
        </Box>
      ) : null}

      {/* Inline filter bar */}
      {showFilterRow ? (
        <Box flexDirection="row" height={1} flexShrink={0} overflow="hidden">
          <Text color={theme.accent} bold>
            {t(lang, '筛选: ', 'Filter: ')}
          </Text>
          {filterFocused ? (
            <TextInput
              value={filterQuery}
              onChange={(val) => {
                setFilterQuery(val);
                setSelectedIdx(0);
              }}
              onSubmit={() => setFilterFocused(false)}
              onCancel={() => {
                setFilterQuery('');
                setFilterFocused(false);
                setSelectedIdx(0);
              }}
              placeholder={t(lang, `输入课程/题组/考点关键字${ell}`, `Filter course, deck, or topic${ell}`)}
              isActive={isActive && filterFocused}
              width={filterInputW}
              prompt={asciiMode ? '/' : '›'}
            />
          ) : (
            <Text color={theme.text} wrap="truncate">
              {truncateDisplay(filterQuery, Math.max(10, innerW - 10), ell)}
            </Text>
          )}
        </Box>
      ) : null}

      {/* Error banner */}
      {showErrorRow ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={theme.error} wrap="truncate">
            {truncateDisplay(error, innerW, ell)}
          </Text>
        </Box>
      ) : null}

      {/* Body: loading / empty / list */}
      {loading ? (
        <Box height={listH} alignItems="center" justifyContent="center">
          <Spinner
            label={t(lang, `正在加载知识地图${ell}`, `Loading knowledge map${ell}`)}
            active={isActive}
          />
        </Box>
      ) : filteredRows.length === 0 ? (
        <EmptyState
          icon={asciiMode ? '+' : '◈'}
          title={
            filterQuery
              ? t(lang, '没有匹配的课程或考点', 'No matching courses or topics')
              : t(lang, '暂无知识掌握数据', 'No mastery data yet')
          }
          hint={
            filterQuery
              ? t(lang, '按 [c] 清空筛选条件', 'Press [c] to clear filter')
              : t(lang, '先导入资料或创建题组即可查看知识地图', 'Import materials or create decks to see the map')
          }
          height={listH}
        />
      ) : (
        <VirtualList
          items={filteredRows}
          height={listH}
          width={innerW}
          selectedIndex={selectedIdx}
          onChange={(idx) => setSelectedIdx(idx)}
          onSelect={(row) => {
            void launchRow(row);
          }}
          renderItem={renderRow}
          keyExtractor={(row) => row.key}
          isActive={isActive && !filterFocused && !starting}
          ascii={asciiMode}
        />
      )}
    </Modal>
  );
});
