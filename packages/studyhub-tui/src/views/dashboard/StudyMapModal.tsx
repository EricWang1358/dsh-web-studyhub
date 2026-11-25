import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction } from '../../host/sample-actions.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';

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

export interface StudyGraphNode {
  id: string;
  kind: 'deck' | 'topic' | 'card' | string;
  label: string;
  deckId: string;
  deckTitle?: string;
  topic?: string;
  cardId?: string;
  mastery?: number;
  due?: number;
  total?: number;
  level?: string;
  cardKind?: string;
}

export interface StudyGraphEdge {
  from: string;
  to: string;
  type: 'tree' | 'prereq' | 'order' | string;
  seq?: number;
}

export interface StudyGraphResponse {
  mode?: string;
  scope?: Array<{ deckId: string; topic?: string; cardId?: string }>;
  nodes?: StudyGraphNode[];
  edges?: StudyGraphEdge[];
  truncated?: boolean;
}

type StudyMapTab = 'map' | 'graph';

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

type GraphRow =
  | {
      kind: 'edge';
      key: string;
      course: string;
      prereqDeckId: string;
      prereqCardId: string;
      prereqLabel: string;
      prereqLevel: string;
      depDeckId: string;
      depCardId: string;
      depLabel: string;
      depLevel: string;
      deckTitle: string;
      topic: string;
    }
  | {
      kind: 'deck';
      key: string;
      course: string;
      deckId: string;
      label: string;
      mastery: number;
      total: number;
      due: number;
      edgeCount: number;
    }
  | {
      kind: 'topic';
      key: string;
      course: string;
      deckId: string;
      deckTitle: string;
      topic: string;
      label: string;
      mastery: number;
      total: number;
      due: number;
    }
  | {
      kind: 'card';
      key: string;
      course: string;
      deckId: string;
      deckTitle: string;
      topic: string;
      cardId: string;
      label: string;
      level: string;
      inCount: number;
      outCount: number;
    };

function levelTag(level: string | undefined, lang: 'zh' | 'en', compact: boolean): string {
  switch (level) {
    case 'mastered':
      return compact ? t(lang, '掌', 'M') : t(lang, '掌握', 'MST');
    case 'familiar':
      return compact ? t(lang, '熟', 'F') : t(lang, '熟悉', 'FAM');
    case 'learning':
      return compact ? t(lang, '学', 'L') : t(lang, '学习', 'LRN');
    case 'weak':
      return compact ? t(lang, '弱', 'W') : t(lang, '薄弱', 'WEAK');
    default:
      return compact ? t(lang, '新', 'N') : t(lang, '新题', 'NEW');
  }
}

function levelToneColor(
  level: string | undefined,
  theme: ReturnType<typeof useTheme>,
): string {
  switch (level) {
    case 'mastered':
      return theme.success;
    case 'familiar':
      return theme.primary;
    case 'learning':
      return theme.info;
    case 'weak':
      return theme.error;
    default:
      return theme.muted;
  }
}

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
  const { columns, rows } = useStableWindowSize();

  const activeCourse = currentCourse(snapshot);

  const [activeTab, setActiveTab] = useState<StudyMapTab>('map');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [mapData, setMapData] = useState<StudyMapResponse | null>(null);

  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState('');
  const [graphData, setGraphData] = useState<StudyGraphResponse | null>(null);
  const [graphScope, setGraphScope] = useState<'all' | 'course'>('all');
  const [graphReloadSeq, setGraphReloadSeq] = useState(0);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);
  const graphReqSeqRef = useRef(0);
  const graphDirtyRef = useRef(true);
  const graphLoadedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isActive) {
      graphDirtyRef.current = true;
      graphLoadedRef.current = false;
      return;
    }
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

  useEffect(() => {
    if (!isActive || activeTab !== 'graph') return;
    if (!graphDirtyRef.current && graphLoadedRef.current) return;
    let cancelled = false;
    const seq = ++graphReqSeqRef.current;
    graphDirtyRef.current = false;
    graphLoadedRef.current = true;
    setGraphLoading(true);
    setGraphError('');

    const args = graphScope === 'course' && activeCourse ? { course: activeCourse } : {};
    void tryAction<StudyGraphResponse>(host, 'graph', args).then((res) => {
      if (cancelled || !mountedRef.current || graphReqSeqRef.current !== seq) return;
      if (!res.ok) {
        setGraphData(null);
        setGraphError(res.error?.message || t(lang, '加载依赖图谱失败', 'Failed to load prerequisite graph'));
      } else {
        setGraphData(res.value ?? null);
      }
      setGraphLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [host, isActive, activeTab, graphReloadSeq, graphScope, activeCourse, lang]);

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

  const graphStats = useMemo(() => {
    const nodes = graphData?.nodes ?? [];
    const edges = graphData?.edges ?? [];
    const prereqs = edges.filter((e) => e.type === 'prereq');
    const cardCount = nodes.filter((n) => n.kind === 'card').length;
    const deckCount = nodes.filter((n) => n.kind === 'deck').length;
    return {
      nodeCount: nodes.length,
      cardCount,
      deckCount,
      prereqCount: prereqs.length,
    };
  }, [graphData]);

  const graphFilteredRows: GraphRow[] = useMemo(() => {
    const nodes = graphData?.nodes ?? [];
    if (nodes.length === 0) return [];
    const edges = graphData?.edges ?? [];
    const prereqs = edges.filter((e) => e.type === 'prereq');

    const nodeById = new Map<string, StudyGraphNode>();
    const deckTitleById = new Map<string, string>();
    for (const n of nodes) {
      nodeById.set(n.id, n);
      if (n.kind === 'deck') {
        deckTitleById.set(n.deckId, n.label);
      }
    }

    // In graphData, edge { from: dependent, to: prerequisite, type: 'prereq' }
    const requiresCount = new Map<string, number>();
    const unlocksCount = new Map<string, number>();
    const deckEdgeCount = new Map<string, number>();
    const edgeRows: GraphRow[] = [];

    for (const e of prereqs) {
      const dep = nodeById.get(e.from);
      const pre = nodeById.get(e.to);
      if (!dep || !pre) continue;
      requiresCount.set(dep.id, (requiresCount.get(dep.id) ?? 0) + 1);
      unlocksCount.set(pre.id, (unlocksCount.get(pre.id) ?? 0) + 1);
      deckEdgeCount.set(dep.deckId, (deckEdgeCount.get(dep.deckId) ?? 0) + 1);
      if (pre.deckId !== dep.deckId) {
        deckEdgeCount.set(pre.deckId, (deckEdgeCount.get(pre.deckId) ?? 0) + 1);
      }
      edgeRows.push({
        kind: 'edge',
        key: `edge:${pre.id}->${dep.id}`,
        course: deckCourseMap.get(pre.deckId) ?? deckCourseMap.get(dep.deckId) ?? '',
        prereqDeckId: pre.deckId,
        prereqCardId: pre.cardId ?? '',
        prereqLabel: pre.label || pre.cardId || '',
        prereqLevel: pre.level || 'new',
        depDeckId: dep.deckId,
        depCardId: dep.cardId ?? '',
        depLabel: dep.label || dep.cardId || '',
        depLevel: dep.level || 'new',
        deckTitle: pre.deckTitle || deckTitleById.get(pre.deckId) || '',
        topic: pre.topic || '',
      });
    }

    const q = filterQuery.trim().toLowerCase();
    const out: GraphRow[] = [];

    for (const er of edgeRows) {
      if (er.kind !== 'edge') continue;
      if (
        !q ||
        er.prereqLabel.toLowerCase().includes(q) ||
        er.depLabel.toLowerCase().includes(q) ||
        er.deckTitle.toLowerCase().includes(q) ||
        er.topic.toLowerCase().includes(q)
      ) {
        out.push(er);
      }
    }

    // Build deck -> topic -> card hierarchy preserving graph node order
    type DeckBucket = {
      deck: StudyGraphNode;
      topics: Array<{ topic: StudyGraphNode; cards: StudyGraphNode[] }>;
      looseCards: StudyGraphNode[];
    };
    const buckets: DeckBucket[] = [];
    const bucketByDeckId = new Map<string, DeckBucket>();
    const topicBucketByKey = new Map<string, { topic: StudyGraphNode; cards: StudyGraphNode[] }>();

    for (const n of nodes) {
      if (n.kind === 'deck') {
        const b: DeckBucket = { deck: n, topics: [], looseCards: [] };
        buckets.push(b);
        bucketByDeckId.set(n.deckId, b);
      } else if (n.kind === 'topic') {
        const b = bucketByDeckId.get(n.deckId);
        if (b) {
          const tb = { topic: n, cards: [] };
          b.topics.push(tb);
          topicBucketByKey.set(`${n.deckId}\0${n.topic ?? n.label}`, tb);
        }
      } else if (n.kind === 'card') {
        const tb = topicBucketByKey.get(`${n.deckId}\0${n.topic ?? '未分类'}`);
        if (tb) {
          tb.cards.push(n);
        } else {
          bucketByDeckId.get(n.deckId)?.looseCards.push(n);
        }
      }
    }

    for (const b of buckets) {
      const deckCourse = deckCourseMap.get(b.deck.deckId) ?? '';
      const deckMatches = !q || b.deck.label.toLowerCase().includes(q) || deckCourse.toLowerCase().includes(q);
      const childRows: GraphRow[] = [];

      for (const tb of b.topics) {
        const topicMatches = deckMatches || tb.topic.label.toLowerCase().includes(q);
        const matchedCards = topicMatches
          ? tb.cards
          : tb.cards.filter(
              (c) => c.label.toLowerCase().includes(q) || (c.topic ?? '').toLowerCase().includes(q),
            );
        if (!topicMatches && matchedCards.length === 0) continue;

        childRows.push({
          kind: 'topic',
          key: `gtopic:${tb.topic.id}`,
          course: deckCourse,
          deckId: b.deck.deckId,
          deckTitle: b.deck.label,
          topic: tb.topic.topic ?? tb.topic.label,
          label: tb.topic.label,
          mastery: Math.max(0, Math.min(100, Math.round(Number(tb.topic.mastery) || 0))),
          total: Math.max(0, Number(tb.topic.total) || 0),
          due: Math.max(0, Number(tb.topic.due) || 0),
        });

        for (const c of matchedCards) {
          childRows.push({
            kind: 'card',
            key: `gcard:${c.id}`,
            course: deckCourse,
            deckId: c.deckId,
            deckTitle: c.deckTitle ?? b.deck.label,
            topic: c.topic ?? tb.topic.label,
            cardId: c.cardId ?? '',
            label: c.label,
            level: c.level ?? 'new',
            inCount: requiresCount.get(c.id) ?? 0,
            outCount: unlocksCount.get(c.id) ?? 0,
          });
        }
      }

      if (!deckMatches && childRows.length === 0) continue;

      out.push({
        kind: 'deck',
        key: `gdeck:${b.deck.id}`,
        course: deckCourse,
        deckId: b.deck.deckId,
        label: b.deck.label,
        mastery: Math.max(0, Math.min(100, Math.round(Number(b.deck.mastery) || 0))),
        total: Math.max(0, Number(b.deck.total) || 0),
        due: Math.max(0, Number(b.deck.due) || 0),
        edgeCount: deckEdgeCount.get(b.deck.deckId) ?? 0,
      });
      out.push(...childRows);
    }

    return out;
  }, [graphData, deckCourseMap, filterQuery]);

  const activeRowsLen = activeTab === 'map' ? filteredRows.length : graphFilteredRows.length;

  useEffect(() => {
    if (selectedIdx >= activeRowsLen) {
      setSelectedIdx(Math.max(0, activeRowsLen - 1));
    }
  }, [activeRowsLen, selectedIdx]);

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

  const launchGraphRow = useCallback(
    async (row: GraphRow | undefined) => {
      if (!row || busyRef.current) return;
      if (row.kind !== 'edge' && row.kind !== 'card' && row.total <= 0) {
        notify(t(lang, '当前节点暂无可练题目', 'No cards in selected node'), 'info');
        return;
      }

      busyRef.current = true;
      setStarting(true);
      setGraphError('');

      try {
        if (row.course && row.course !== activeCourse) {
          const focusRes = await tryAction(host, 'focus.set', { course: row.course });
          if (focusRes.ok) {
            await refreshSnapshot();
          }
        }

        const startArgs: Record<string, unknown> =
          row.kind === 'edge'
            ? {
                mode: 'path',
                scope: [
                  ...(row.prereqCardId ? [{ deckId: row.prereqDeckId, cardId: row.prereqCardId }] : [{ deckId: row.prereqDeckId }]),
                  ...(row.depCardId ? [{ deckId: row.depDeckId, cardId: row.depCardId }] : [{ deckId: row.depDeckId }]),
                ],
                fresh: true,
              }
            : row.kind === 'card'
              ? {
                  mode: 'path',
                  scope: [row.cardId ? { deckId: row.deckId, cardId: row.cardId } : { deckId: row.deckId }],
                  fresh: true,
                }
              : row.kind === 'topic'
                ? { mode: 'path', scope: [{ deckId: row.deckId, topic: row.topic }], fresh: true }
                : { mode: 'path', scope: [{ deckId: row.deckId }], fresh: true };

        const res = await tryAction<{ id?: string }>(host, 'review.start', startArgs);
        if (!mountedRef.current) return;
        if (!res.ok || !res.value?.id) {
          const msg = res.error?.message || t(lang, '无法启动练习', 'Failed to start practice');
          setGraphError(msg);
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

  const switchTab = useCallback((next: StudyMapTab) => {
    setActiveTab(next);
    setSelectedIdx(0);
    setFilterQuery('');
    setFilterFocused(false);
  }, []);

  const activeLoading = activeTab === 'map' ? loading : graphLoading;

  useInput(
    (input, key) => {
      if (starting) return;
      if (key.tab) {
        switchTab(activeTab === 'map' ? 'graph' : 'map');
        return;
      }
      if (input === '1') {
        if (activeTab !== 'map') switchTab('map');
        return;
      }
      if (input === '2') {
        if (activeTab !== 'graph') switchTab('graph');
        return;
      }
      if (activeLoading) return;
      if (input === '/') {
        setFilterFocused(true);
        return;
      }
      if (input === 'r') {
        if (activeTab === 'map') {
          setLoading(true);
          setReloadSeq((n) => n + 1);
        } else {
          graphDirtyRef.current = true;
          setGraphLoading(true);
          setGraphReloadSeq((n) => n + 1);
        }
        return;
      }
      if (input === 's' && activeTab === 'graph' && activeCourse) {
        graphDirtyRef.current = true;
        setGraphScope((prev) => (prev === 'all' ? 'course' : 'all'));
        setSelectedIdx(0);
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

  const activeError = activeTab === 'map' ? error : graphError;
  const showFilterRow = filterFocused || filterQuery.length > 0;
  const showNextRow = activeTab === 'map' && Boolean(mapData?.next?.topic) && bodyH >= 12;
  const showErrorRow = Boolean(activeError);
  const overheadRows = 2 + (showNextRow ? 1 : 0) + (showFilterRow ? 1 : 0) + (showErrorRow ? 1 : 0);
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
      { key: '1/2', label: t(lang, '切页', 'Tab') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
    ];
    if (filterQuery) {
      items.push({ key: 'c', label: t(lang, '清空', 'Clear') });
    }
    if (activeTab === 'graph' && activeCourse) {
      items.push({ key: 's', label: t(lang, '范围', 'Scope') });
    }
    items.push({ key: 'r', label: t(lang, '刷新', 'Reload') });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [activeCourse, activeTab, filterFocused, filterQuery, lang]);

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

  const renderGraphRow = useCallback(
    (row: GraphRow, ctx: VirtualListRenderContext) => {
      const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
      const compact = ctx.width < 68;
      const arrow = asciiMode ? '->' : '→';
      const inArrow = asciiMode ? '<-' : '←';

      if (row.kind === 'edge') {
        const tag = compact ? t(lang, '[链]', '[E]') : t(lang, '[前置]', '[EDGE]');
        const preLvl = levelTag(row.prereqLevel, lang, true);
        const depLvl = levelTag(row.depLevel, lang, true);
        const rightBadge = ` [${preLvl}${arrow}${depLvl}]`;
        const prefix = `${pointer}${tag} `;
        const midArrow = ` ${arrow} `;
        const availTextW = Math.max(
          8,
          ctx.width - displayWidth(prefix) - displayWidth(rightBadge) - displayWidth(midArrow) - 1,
        );
        const leftMax = Math.max(4, Math.floor(availTextW / 2));
        const rightMax = Math.max(4, availTextW - leftMax);
        const preStr = truncateDisplay(row.prereqLabel, leftMax, ell);
        const depStr = padDisplay(
          truncateDisplay(row.depLabel, rightMax, ell),
          Math.max(4, availTextW - displayWidth(preStr)),
        );

        return (
          <Box flexDirection="row" width={ctx.width} height={1} overflow="hidden">
            <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
              {pointer}
            </Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.accent} bold>
              {`${tag} `}
            </Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
              {preStr}
            </Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.primary} bold>
              {midArrow}
            </Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
              {depStr}
            </Text>
            <Text color={ctx.selected ? theme.selectionFg : levelToneColor(row.depLevel, theme)}>
              {rightBadge}
            </Text>
          </Box>
        );
      }

      if (row.kind === 'card') {
        const indent = '    ';
        const tag = compact ? t(lang, '[卡]', '[C]') : t(lang, '[题目]', '[CARD]');
        const lvl = levelTag(row.level, lang, compact);
        const badgeStr = `[${lvl}]`;
        const ioParts: string[] = [];
        if (row.inCount > 0) ioParts.push(`${inArrow}${row.inCount}`);
        if (row.outCount > 0) ioParts.push(`${arrow}${row.outCount}`);
        const ioMeta = ioParts.length > 0 ? ` ${ioParts.join(' ')}` : '';
        const rightMeta = `${ioMeta} ${badgeStr}`;
        const prefix = `${pointer}${indent}${tag} `;
        const titleW = Math.max(6, ctx.width - displayWidth(prefix) - displayWidth(rightMeta) - 1);
        const titleStr = padDisplay(truncateDisplay(row.label, titleW, ell), titleW);

        return (
          <Box flexDirection="row" width={ctx.width} height={1} overflow="hidden">
            <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
              {pointer}
            </Text>
            <Text>{indent}</Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{`${tag} `}</Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
              {`${titleStr} `}
            </Text>
            {ioMeta ? (
              <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{ioMeta}</Text>
            ) : null}
            <Text color={ctx.selected ? theme.selectionFg : levelToneColor(row.level, theme)} bold>
              {` ${badgeStr}`}
            </Text>
          </Box>
        );
      }

      const indent = row.kind === 'topic' ? '  ' : '';
      const tag =
        row.kind === 'deck'
          ? compact
            ? t(lang, '[组]', '[D]')
            : t(lang, '[题组]', '[DECK]')
          : compact
            ? t(lang, '[点]', '[T]')
            : t(lang, '[考点]', '[TOP]');
      const pctBadge = ` [${String(row.mastery).padStart(2, ' ')}%]`;
      const metaSep = asciiMode ? '/' : '·';
      const metaParts = [`${row.total}${t(lang, '题', 'c')}`];
      if (row.due > 0) metaParts.push(compact ? `d${row.due}` : t(lang, `到${row.due}`, `due ${row.due}`));
      if (row.kind === 'deck' && row.edgeCount > 0) {
        metaParts.push(`${row.edgeCount}${t(lang, '链', 'e')}`);
      }
      const rightMeta = `${pctBadge} ${metaParts.join(metaSep)}`;
      const prefix = `${pointer}${indent}${tag} `;
      const titleW = Math.max(6, ctx.width - displayWidth(prefix) - displayWidth(rightMeta) - 1);
      const titleStr = padDisplay(truncateDisplay(row.label, titleW, ell), titleW);

      const pctColor = ctx.selected
        ? theme.selectionFg
        : row.mastery >= 80
          ? theme.success
          : row.mastery >= 50
            ? theme.primary
            : theme.warning;

      return (
        <Box flexDirection="row" width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
            {pointer}
          </Text>
          {indent ? <Text>{indent}</Text> : null}
          <Text
            color={ctx.selected ? theme.selectionFg : row.kind === 'deck' ? theme.accent : theme.muted}
            bold={row.kind === 'deck' || ctx.selected}
          >
            {`${tag} `}
          </Text>
          <Text
            color={ctx.selected ? theme.selectionFg : row.kind === 'deck' ? theme.text : theme.muted}
            bold={row.kind === 'deck' || ctx.selected}
          >
            {`${titleStr} `}
          </Text>
          <Text color={pctColor} bold>
            {pctBadge}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.dim}>
            {` ${metaParts.join(metaSep)}`}
          </Text>
        </Box>
      );
    },
    [asciiMode, ell, lang, theme],
  );

  const courseMastery = mapData?.mastery?.course;
  const libraryMastery = mapData?.mastery?.library;
  const dueTotal = mapData?.today?.dueTotal ?? mapData?.today?.due ?? 0;

  const summaryBits: string[] = [];
  if (activeTab === 'map') {
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
  } else {
    const scopeText =
      graphScope === 'course' && activeCourse
        ? activeCourse
        : t(lang, '全部激活课程', 'All active courses');
    summaryBits.push(scopeText);
    summaryBits.push(
      t(
        lang,
        `${graphStats.nodeCount} 节点 (${graphStats.cardCount} 题)`,
        `${graphStats.nodeCount} nodes (${graphStats.cardCount} cards)`,
      ),
    );
    summaryBits.push(
      t(lang, `${graphStats.prereqCount} 条前置边`, `${graphStats.prereqCount} prereq edges`),
    );
    if (graphData?.truncated) {
      summaryBits.push(t(lang, '仅前400题', 'First 400'));
    }
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
      {/* Tab Bar */}
      <Box flexDirection="row" height={1} gap={1} flexShrink={0} overflow="hidden">
        <Badge
          label={`1:${t(lang, '知识地图', 'Mastery Map')}`}
          tone={activeTab === 'map' ? 'primary' : 'neutral'}
          variant={activeTab === 'map' ? 'solid' : 'outline'}
        />
        <Badge
          label={`2:${t(lang, '前置依赖图', 'Prerequisite Graph')}`}
          tone={activeTab === 'graph' ? 'primary' : 'neutral'}
          variant={activeTab === 'graph' ? 'solid' : 'outline'}
        />
        <Box flexGrow={1} />
        {innerW >= 54 ? <Text color={theme.dim}>1-2 / Tab</Text> : null}
      </Box>

      {/* Top summary line */}
      <Box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0} overflow="hidden">
        <Text color={theme.muted} wrap="truncate">
          {truncateDisplay(
            summaryBits.join(sep) ||
              (activeTab === 'map'
                ? t(lang, '按课程、题组与考点查看掌握度', 'Mastery by course, deck & topic')
                : t(lang, '查看节点与前置依赖关系', 'Nodes & prerequisite edges')),
            Math.max(10, innerW - (starting ? 14 : 0)),
            ell,
          )}
        </Text>
        {starting ? <Spinner label={t(lang, '启动中...', 'Starting...')} active={isActive} /> : null}
      </Box>

      {/* Recommended next topic (Tab 1) */}
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
              placeholder={
                activeTab === 'map'
                  ? t(lang, `输入课程/题组/考点关键字${ell}`, `Filter course, deck, or topic${ell}`)
                  : t(lang, `输入节点/前置依赖关键字${ell}`, `Filter node, topic, or edge${ell}`)
              }
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
        <Box flexShrink={0}>
          <Text color={theme.error} wrap="wrap">
            {activeError}
          </Text>
        </Box>
      ) : null}

      {/* Body: Tab 1 vs Tab 2 */}
      {activeTab === 'map' ? (
        loading ? (
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
        )
      ) : graphLoading ? (
        <Box height={listH} alignItems="center" justifyContent="center">
          <Spinner
            label={t(lang, `正在加载依赖图谱${ell}`, `Loading prerequisite graph${ell}`)}
            active={isActive}
          />
        </Box>
      ) : graphFilteredRows.length === 0 ? (
        <EmptyState
          icon={asciiMode ? '+' : '◈'}
          title={
            filterQuery
              ? t(lang, '没有匹配的图谱节点或依赖', 'No matching nodes or prerequisites')
              : t(lang, '暂无前置依赖图数据', 'No prerequisite graph data yet')
          }
          hint={
            filterQuery
              ? t(lang, '按 [c] 清空筛选条件', 'Press [c] to clear filter')
              : t(
                  lang,
                  '创建题组并用 card.link 关联前置题目即可查看依赖图',
                  'Create decks and link cards with card.link to view dependencies',
                )
          }
          height={listH}
        />
      ) : (
        <VirtualList
          items={graphFilteredRows}
          height={listH}
          width={innerW}
          selectedIndex={selectedIdx}
          onChange={(idx) => setSelectedIdx(idx)}
          onSelect={(row) => {
            void launchGraphRow(row);
          }}
          renderItem={renderGraphRow}
          keyExtractor={(row) => row.key}
          isActive={isActive && !filterFocused && !starting}
          ascii={asciiMode}
        />
      )}
    </Modal>
  );
});
