import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  Panel,
  ProgressBar,
  ScrollView,
  SelectList,
  Spinner,
  SplitPane,
  StatusPill,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useTheme,
  type SelectOption,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { padDisplay, renderTreeLines, truncateDisplay, type TreeLine, type TreeNode } from '../../render/index.js';
import type {
  CardMasteryInfo,
  FocusProgressTopic,
  NodeStats,
  SkeletonCardRef,
  SkeletonDetail,
  SkeletonNode,
  SkeletonSummary,
  SkeletonTopicItem,
} from './types.js';

const CourseRouteModal = lazy(() =>
  import('./CourseRouteModal.js').then((m) => ({ default: m.CourseRouteModal })),
);
const TopicGroupsModal = lazy(() =>
  import('./TopicGroupsModal.js').then((m) => ({ default: m.TopicGroupsModal })),
);
const NodeEditModal = lazy(() =>
  import('./TopicGroupsModal.js').then((m) => ({ default: m.NodeEditModal })),
);

const CLAIMED_KEYS = ['r', 'L', 'R', 'G', 'E'] as const;

interface SkeletonLintCard {
  deckId: string;
  deckTitle: string;
  cardId: string;
  topic: string;
  kind: string;
  prompt: string;
  issues: string[];
}

interface SkeletonLintResult {
  total: number;
  decks: number;
  flagged: number;
  counts: Record<string, number>;
  labels?: Record<string, string>;
  cards: SkeletonLintCard[];
}

interface LintFindingItem {
  id: string;
  severity: 'error' | 'warn' | 'info';
  tag: string;
  summary: string;
  detail: string;
}

function lintCodeLabel(code: string, lang: 'zh' | 'en', fallback?: string): string {
  switch (code) {
    case 'echo-explanation':
      return t(lang, '重复选项解析', 'Echo explanation');
    case 'membership-stem':
      return t(lang, '考课件页码/列表', 'Slide/page stem');
    case 'thin-explanation':
      return t(lang, '解析过短', 'Thin explanation');
    case 'isolated-recall':
      return t(lang, '孤立记忆题', 'Isolated recall');
    default:
      return fallback || code;
  }
}

function buildLintFindings(
  lint: SkeletonLintResult | null,
  detail: SkeletonDetail | null,
  topics: readonly SkeletonTopicItem[],
  cardIndex: ReadonlyMap<string, CardMasteryInfo>,
  nodeById: ReadonlyMap<string, SkeletonNode>,
  lang: 'zh' | 'en',
): LintFindingItem[] {
  const items: LintFindingItem[] = [];

  if (detail) {
    const parentIds = new Set<string>();
    const relNodeIds = new Set<string>();
    for (const n of detail.nodes) {
      if (n.parent) {
        parentIds.add(n.parent);
        if (!nodeById.has(n.parent)) {
          items.push({
            id: `broken-parent:${n.id}`,
            severity: 'error',
            tag: t(lang, '断链父节点', 'Broken parent'),
            summary: n.term,
            detail: t(lang, `引用了不存在的父节点 ${n.parent}`, `Missing parent ${n.parent}`),
          });
        }
      }
    }
    for (const [idx, r] of (detail.relations ?? []).entries()) {
      relNodeIds.add(r.from);
      relNodeIds.add(r.to);
      if (!nodeById.has(r.from) || !nodeById.has(r.to)) {
        items.push({
          id: `broken-rel:${idx}`,
          severity: 'error',
          tag: t(lang, '断链关系', 'Broken relation'),
          summary: `${r.from} -> ${r.to}`,
          detail: t(lang, '关系端点节点不存在', 'Relation endpoint node missing'),
        });
      }
    }

    const coveredTopics = new Set<string>();
    const coveredCardIds = new Set<string>();
    for (const s of detail.scope ?? []) {
      if (s.topic) coveredTopics.add(s.topic.trim().toLowerCase());
    }
    const nodeTerms: string[] = [];
    for (const n of detail.nodes) {
      const termLower = n.term.trim().toLowerCase();
      if (termLower) {
        coveredTopics.add(termLower);
        nodeTerms.push(termLower);
      }
      for (const ref of n.cards ?? []) {
        coveredCardIds.add(ref.cardId);
        const info = cardIndex.get(ref.cardId);
        if (info?.topic) coveredTopics.add(info.topic.trim().toLowerCase());
      }
      const hasCards = (n.cards ?? []).length > 0;
      const hasChildren = parentIds.has(n.id);
      const hasRelations = relNodeIds.has(n.id);
      if (!hasCards && !hasChildren && !hasRelations) {
        items.push({
          id: `orphan-node:${n.id}`,
          severity: 'warn',
          tag: t(lang, '孤立空节点', 'Orphan node'),
          summary: n.term,
          detail: t(lang, '未关联题卡且无子节点或关系', 'No linked cards, children, or relations'),
        });
      }
    }
    for (const c of lint?.cards ?? []) {
      if (coveredCardIds.has(c.cardId) && c.topic) {
        coveredTopics.add(c.topic.trim().toLowerCase());
      }
    }

    for (const tp of topics) {
      const key = tp.topic.trim().toLowerCase();
      if (!key) continue;
      const matchedTerm = nodeTerms.some((term) => term.includes(key) || key.includes(term));
      if (!coveredTopics.has(key) && !matchedTerm) {
        items.push({
          id: `uncovered-topic:${tp.key}`,
          severity: 'info',
          tag: t(lang, '未覆盖主题', 'Uncovered topic'),
          summary: tp.topic,
          detail: t(lang, `包含 ${tp.count} 题，尚未纳入骨架节点`, `${tp.count} cards not yet mapped to skeleton`),
        });
      }
    }
  }

  for (const card of lint?.cards ?? []) {
    if (!card.issues?.length) continue;
    const issueNames = card.issues.map((c) => lintCodeLabel(c, lang, lint?.labels?.[c])).join(' / ');
    items.push({
      id: `card:${card.deckId}:${card.cardId}`,
      severity: 'warn',
      tag: issueNames,
      summary: card.topic || card.deckTitle,
      detail: card.prompt,
    });
  }

  return items;
}

const RELATION_ZH: Record<string, string> = {
  'part-of': '属于',
  causes: '导致',
  contrasts: '对比',
  prerequisite: '前置',
  'example-of': '例子',
  related: '相关',
};

function inferCardLevel(card: Record<string, unknown>): CardMasteryInfo['level'] {
  const rev = card.review as Record<string, unknown> | undefined;
  const reps = Number(rev?.repetitions ?? 0) || 0;
  const days = Number(rev?.interval_days ?? 0) || 0;
  const lapses = Number(rev?.lapses ?? 0) || 0;
  if (reps <= 0) return 'new';
  if (lapses > 0 && days < 3) return 'weak';
  if (days >= 14 && reps >= 3) return 'mastered';
  if (days >= 5) return 'familiar';
  return 'learning';
}

function buildHierarchy(
  nodes: SkeletonNode[],
  statsMap: Map<string, NodeStats>,
): { tree: TreeNode[]; parentById: Map<string, string | null>; nodeById: Map<string, SkeletonNode> } {
  const nodeById = new Map<string, SkeletonNode>();
  const parentById = new Map<string, string | null>();
  const childrenMap = new Map<string, SkeletonNode[]>();

  for (const n of nodes) {
    nodeById.set(n.id, n);
    childrenMap.set(n.id, []);
  }

  const roots: SkeletonNode[] = [];
  for (const n of nodes) {
    if (n.parent && nodeById.has(n.parent) && n.parent !== n.id) {
      parentById.set(n.id, n.parent);
      childrenMap.get(n.parent)!.push(n);
    } else {
      parentById.set(n.id, null);
      roots.push(n);
    }
  }

  const visited = new Set<string>();
  const toTree = (n: SkeletonNode): TreeNode => {
    visited.add(n.id);
    const st = statsMap.get(n.id);
    const focusMark = st?.isFocus ? '⚑ ' : '';
    const levelIcon =
      st?.level === 'mastered' ? '★' : st?.level === 'weak' ? '✕' : st?.level === 'learning' ? '◐' : '○';
    const meta = st ? `${focusMark}${levelIcon} ${st.cardCount}题 ${st.masteryPct}%` : '';
    const kids = (childrenMap.get(n.id) ?? []).filter((c) => !visited.has(c.id)).map(toTree);
    return {
      id: n.id,
      label: n.term,
      meta,
      ...(kids.length ? { children: kids } : {}),
    };
  };

  const tree = roots.map(toTree);
  // Safety net for any cycle
  for (const n of nodes) {
    if (!visited.has(n.id)) tree.push(toTree(n));
  }
  return { tree, parentById, nodeById };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const SkeletonView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshotDecks = useTuiStore((s) => s.snapshot?.decks);
  const snapshotCourse = useTuiStore((s) => (typeof s.snapshot?.focus?.course === 'string' ? s.snapshot.focus.course : null));
  const navCourse = useTuiStore((s) => s.navContext.course);
  const activeCourse = navCourse ?? snapshotCourse;

  const [loading, setLoading] = useState(true);
  const [skeletons, setSkeletons] = useState<SkeletonSummary[]>([]);
  const [topics, setTopics] = useState<SkeletonTopicItem[]>([]);
  const [focusTopics, setFocusTopics] = useState<FocusProgressTopic[]>([]);
  const [selectedSkeletonId, setSelectedSkeletonId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkeletonDetail | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [diagramCount, setDiagramCount] = useState(0);
  const [lintOpen, setLintOpen] = useState(false);
  const [lintLoading, setLintLoading] = useState(false);
  const [lintError, setLintError] = useState('');
  const [lintResult, setLintResult] = useState<SkeletonLintResult | null>(null);
  const [lintCursor, setLintCursor] = useState(0);
  const [routeOpen, setRouteOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [nodeEditOpen, setNodeEditOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const lintReqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load skeleton.list + skeleton.topics + course.focusProgress
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const scopeArgs = activeCourse ? { course: activeCourse } : {};
    (async () => {
      try {
        const [listRes, topicsRes, focusRes] = await Promise.all([
          host.call<{ skeletons?: SkeletonSummary[] }>('skeleton.list', scopeArgs),
          host.call<{ topics?: SkeletonTopicItem[] }>('skeleton.topics', scopeArgs),
          activeCourse
            ? host.call<{ topics?: FocusProgressTopic[] }>('course.focusProgress', { course: activeCourse })
            : Promise.resolve({ ok: false, value: undefined }),
        ]);
        if (cancelled || !mountedRef.current) return;
        const list = listRes.ok && Array.isArray(listRes.value?.skeletons) ? listRes.value!.skeletons! : [];
        setSkeletons(list);
        if (topicsRes.ok && Array.isArray(topicsRes.value?.topics)) setTopics(topicsRes.value!.topics!);
        if (focusRes.ok && Array.isArray(focusRes.value?.topics)) setFocusTopics(focusRes.value!.topics!);
        else setFocusTopics([]);

        setSelectedSkeletonId((prev) => {
          if (prev && list.some((k) => k.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, activeCourse, reloadSeq]);

  // Fetch skeleton.get + non-blocking skeleton.diagram.list when selectedSkeletonId changes
  useEffect(() => {
    if (!selectedSkeletonId) {
      setDetail(null);
      setDiagramCount(0);
      return;
    }
    let cancelled = false;
    setDiagramCount(0);
    host
      .call<{ diagrams?: unknown[] }>('skeleton.diagram.list', { id: selectedSkeletonId })
      .then((dRes) => {
        if (cancelled || !mountedRef.current) return;
        setDiagramCount(dRes.ok && Array.isArray(dRes.value?.diagrams) ? dRes.value.diagrams.length : 0);
      })
      .catch(() => {
        // Non-blocking diagram count fetch
      });
    (async () => {
      const res = await host.call<SkeletonDetail>('skeleton.get', { id: selectedSkeletonId });
      if (cancelled || !mountedRef.current) return;
      if (res.ok && res.value) {
        const sk = res.value;
        setDetail(sk);
        const rootIds = new Set(sk.nodes.filter((n) => !n.parent).map((n) => n.id));
        setExpandedIds(rootIds);
        setSelectedNodeId(sk.nodes[0]?.id ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, selectedSkeletonId, reloadSeq]);

  const refreshDetail = useCallback(async () => {
    if (!selectedSkeletonId) return;
    const res = await host.call<SkeletonDetail>('skeleton.get', { id: selectedSkeletonId });
    if (!mountedRef.current) return;
    if (res.ok && res.value) {
      const sk = res.value;
      setDetail(sk);
      setSelectedNodeId((prev) => (prev && sk.nodes.some((n) => n.id === prev) ? prev : sk.nodes[0]?.id ?? null));
    }
  }, [host, selectedSkeletonId]);

  // Card mastery lookup from snapshot decks
  const cardIndex = useMemo(() => {
    const map = new Map<string, CardMasteryInfo>();
    for (const deck of snapshotDecks ?? []) {
      const cards = Array.isArray((deck as Record<string, unknown>).cards)
        ? ((deck as Record<string, unknown>).cards as Array<Record<string, unknown>>)
        : [];
      for (const c of cards) {
        const cardId = String(c.id ?? '');
        if (!cardId) continue;
        map.set(cardId, {
          deckId: deck.id,
          cardId,
          topic: String(c.topic ?? ''),
          prompt: String(c.prompt ?? '').replace(/\s+/g, ' ').trim(),
          level: inferCardLevel(c),
        });
      }
    }
    return map;
  }, [snapshotDecks]);

  const focusTermSet = useMemo(() => {
    const set = new Set<string>();
    for (const ft of focusTopics) {
      if (ft.topic) set.add(ft.topic.toLowerCase());
    }
    return set;
  }, [focusTopics]);

  // Compute node stats (including subtree rollups)
  const nodeStatsMap = useMemo(() => {
    const stats = new Map<string, NodeStats>();
    if (!detail?.nodes?.length) return stats;

    const childrenMap = new Map<string, SkeletonNode[]>();
    for (const n of detail.nodes) childrenMap.set(n.id, []);
    for (const n of detail.nodes) {
      if (n.parent && childrenMap.has(n.parent) && n.parent !== n.id) childrenMap.get(n.parent)!.push(n);
    }

    const collectSubtree = (n: SkeletonNode, seen = new Set<string>()): SkeletonCardRef[] => {
      if (seen.has(n.id)) return [];
      seen.add(n.id);
      const out = new Map<string, SkeletonCardRef>();
      for (const c of n.cards ?? []) out.set(c.cardId, c);
      for (const kid of childrenMap.get(n.id) ?? []) {
        for (const c of collectSubtree(kid, seen)) out.set(c.cardId, c);
      }
      return [...out.values()];
    };

    for (const n of detail.nodes) {
      const subtreeCards = collectSubtree(n);
      let mastered = 0;
      let weak = 0;
      let learning = 0;
      const samplePrompts: string[] = [];
      let topicFocusHit = focusTermSet.has(n.term.toLowerCase());

      for (const ref of subtreeCards) {
        const info = cardIndex.get(ref.cardId);
        if (info) {
          if (info.level === 'mastered' || info.level === 'familiar') mastered += 1;
          else if (info.level === 'weak') weak += 1;
          else if (info.level === 'learning') learning += 1;
          if (samplePrompts.length < 4 && info.prompt) samplePrompts.push(info.prompt);
          if (info.topic && focusTermSet.has(info.topic.toLowerCase())) topicFocusHit = true;
        }
      }
      const total = subtreeCards.length;
      const masteryPct = total > 0 ? Math.round((mastered / total) * 100) : 0;
      const level: NodeStats['level'] =
        weak > 0 ? 'weak' : total > 0 && mastered === total ? 'mastered' : learning > 0 || mastered > 0 ? 'learning' : 'new';

      stats.set(n.id, {
        cardCount: (n.cards ?? []).length,
        masteredCount: mastered,
        weakCount: weak,
        masteryPct,
        isFocus: topicFocusHit,
        level,
        samplePrompts,
        subtreeCards,
      });
    }
    return stats;
  }, [detail, cardIndex, focusTermSet]);

  const { tree, parentById, nodeById } = useMemo(
    () => buildHierarchy(detail?.nodes ?? [], nodeStatsMap),
    [detail?.nodes, nodeStatsMap],
  );

  // Fallback topics preview tree when no saved skeleton exists
  const fallbackTopicTree = useMemo<TreeNode[]>(() => {
    if (detail) return [];
    const sep = asciiMode ? ' - ' : ' · ';
    return topics.slice(0, 60).map((tp) => ({
      id: `topic:${tp.key}`,
      label: tp.topic,
      meta: `${tp.count}${t(lang, '题', 'Q')}${sep}${tp.decks.length}${t(lang, '组', 'D')}`,
      children: tp.decks.map((d) => ({
        id: `topic:${tp.key}:${d.deckId}`,
        label: d.deckTitle,
        meta: `${d.count}${t(lang, '题', 'Q')}`,
      })),
    }));
  }, [detail, topics, lang, asciiMode]);

  const treePaneWidth = useMemo(() => {
    const splitW = width >= 90 ? Math.max(28, Math.round(width * 0.44)) : width;
    return Math.max(18, splitW - 4);
  }, [width]);

  const treeLines: TreeLine[] = useMemo(
    () => renderTreeLines(detail ? tree : fallbackTopicTree, expandedIds, selectedNodeId, treePaneWidth, { ascii: asciiMode }),
    [detail, tree, fallbackTopicTree, expandedIds, selectedNodeId, treePaneWidth, asciiMode],
  );

  const selectedLineIdx = useMemo(() => {
    if (!treeLines.length) return -1;
    const idx = treeLines.findIndex((l) => l.id === selectedNodeId);
    return idx >= 0 ? idx : 0;
  }, [treeLines, selectedNodeId]);

  useEffect(() => {
    if (treeLines.length > 0 && (!selectedNodeId || !treeLines.some((l) => l.id === selectedNodeId))) {
      setSelectedNodeId(treeLines[0].id);
    }
  }, [treeLines, selectedNodeId]);

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;
  const selectedStats = selectedNodeId ? nodeStatsMap.get(selectedNodeId) ?? null : null;

  const toggleExpand = useCallback((id: string, force?: boolean) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      const want = force ?? !prev.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const practiseNode = useCallback(async () => {
    if (!selectedNode || busyAction) return;
    const refs = selectedStats?.subtreeCards.length ? selectedStats.subtreeCards : selectedNode.cards;
    if (!refs.length) {
      useTuiStore.getState().notify(t(lang, '该知识节点暂无关联题目', 'No cards linked to this node'), 'warning');
      return;
    }
    setBusyAction('practice');
    try {
      const res = await host.call<{ id?: string }>('review.start', {
        mode: 'path',
        scope: refs.slice(0, 200),
        fresh: true,
      });
      if (!res.ok || !res.value?.id) {
        useTuiStore.getState().notify(res.error?.message || t(lang, '启动练习失败', 'Failed to start practice'), 'error');
        return;
      }
      useTuiStore.getState().navigate('review', {
        runId: res.value.id,
        ...(activeCourse ? { course: activeCourse } : {}),
      });
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [selectedNode, selectedStats, busyAction, host, lang, activeCourse]);

  const generateSkeleton = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('generate');
    try {
      // 1. Try workflow.skeleton.generate first (supports test mocks or active sessions)
      const wfRes = await host.call<{ session?: { id?: string }; skeleton?: { id?: string } }>('workflow.skeleton.generate', {
        ...(activeCourse ? { course: activeCourse } : {}),
      });
      if (wfRes.ok) {
        useTuiStore.getState().notify(t(lang, '已触发知识骨架生成', 'Triggered skeleton generation'), 'success');
        setReloadSeq((n) => n + 1);
        return;
      }

      // 2. Gather scope from skeleton.topics + skeleton.context and generate via host.streamComplete -> skeleton.save
      const topicsRes = await host.call<{ topics?: SkeletonTopicItem[] }>('skeleton.topics', activeCourse ? { course: activeCourse } : {});
      const availableTopics = topicsRes.ok && topicsRes.value?.topics ? topicsRes.value.topics : topics;
      const scopeMap = new Map<string, { deckId: string; topic?: string }>();
      for (const tp of availableTopics.slice(0, 25)) {
        for (const d of tp.decks ?? []) {
          scopeMap.set(`${d.deckId}\0${tp.topic}`, { deckId: d.deckId, topic: tp.topic });
        }
      }
      const scope = [...scopeMap.values()];
      if (!scope.length) {
        useTuiStore.getState().notify(t(lang, '当前课程还没有题目，无法生成知识骨架', 'No questions in scope to generate skeleton'), 'warning');
        return;
      }

      const ctxRes = await host.call<{ cards?: Array<{ deckId: string; cardId: string; topic: string; prompt: string }> }>('skeleton.context', { scope });
      const cards = ctxRes.ok && Array.isArray(ctxRes.value?.cards) ? ctxRes.value!.cards! : [];

      if (host.streamComplete && cards.length > 0) {
        useTuiStore.getState().notify(t(lang, '正在用 AI 构建知识骨架…', 'Generating knowledge skeleton with AI…'), 'info');
        const sys = [
          'Design a hierarchical knowledge skeleton from the supplied topics and cards.',
          'Return ONLY valid JSON: {title:string, overview:string, nodes:[{id:string, term:string, meaning:string, parent?:string, cards:string[]}], relations:[{from:string, to:string, type:"part-of"|"causes"|"contrasts"|"prerequisite"|"example-of"|"related", note?:string}]}.',
          'Keep 5-20 nodes, depth <= 3, and meaning <= 50 chars.',
        ].join('\n');
        const prompt = JSON.stringify({
          course: activeCourse || 'all',
          topics: availableTopics.slice(0, 20).map((x) => ({ topic: x.topic, count: x.count })),
          cards: cards.slice(0, 60).map((c) => ({ cardId: c.cardId, topic: c.topic, prompt: c.prompt.slice(0, 100) })),
        });
        const raw = await host.streamComplete({ system: sys, prompt });
        const parsed = extractJsonObject(raw);
        if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
          const saved = await host.call<SkeletonDetail>('skeleton.save', { ...parsed, scope });
          if (saved.ok && saved.value?.id) {
            setSelectedSkeletonId(saved.value.id);
            setReloadSeq((n) => n + 1);
            useTuiStore.getState().notify(t(lang, `已生成骨架「${saved.value.title}」`, `Generated skeleton "${saved.value.title}"`), 'success');
            return;
          }
        }
      }

      // 3. Deterministic topic-tree fallback via skeleton.save if model unavailable or returned non-JSON
      const byTopic = new Map<string, Array<{ deckId: string; cardId: string }>>();
      for (const c of cards) {
        const list = byTopic.get(c.topic) ?? [];
        list.push({ deckId: c.deckId, cardId: c.cardId });
        byTopic.set(c.topic, list);
      }
      const rootId = 'n0';
      const nodes: SkeletonNode[] = [
        {
          id: rootId,
          term: activeCourse || t(lang, '课程知识总览', 'Course Overview'),
          meaning: t(lang, `包含 ${byTopic.size} 个核心主题`, `Covers ${byTopic.size} core topics`),
          cards: [],
        },
      ];
      let idx = 1;
      for (const [topic, list] of [...byTopic.entries()].slice(0, 24)) {
        nodes.push({
          id: `n${idx++}`,
          term: topic.slice(0, 60),
          meaning: t(lang, `共关联 ${list.length} 道练习题`, `Linked to ${list.length} practice questions`),
          parent: rootId,
          cards: list,
        });
      }
      const saved = await host.call<SkeletonDetail>('skeleton.save', {
        title: `${activeCourse || t(lang, '知识', 'Study')} ${t(lang, '骨架', 'Skeleton')}`.slice(0, 70),
        overview: t(lang, '按课程主题自动归并的知识层级树，可随时使用 AI 扩展细节。', 'Auto-organized knowledge hierarchy grouped by topic.'),
        scope,
        nodes,
        relations: [],
      });
      if (saved.ok && saved.value?.id) {
        setSelectedSkeletonId(saved.value.id);
        setReloadSeq((n) => n + 1);
        useTuiStore.getState().notify(t(lang, `已创建知识骨架「${saved.value.title}」`, `Created skeleton "${saved.value.title}"`), 'success');
      } else {
        useTuiStore.getState().notify(saved.error?.message || wfRes.error?.message || t(lang, '骨架生成失败', 'Skeleton generation failed'), 'error');
      }
    } catch (err) {
      if (mountedRef.current) {
        useTuiStore.getState().notify(err instanceof Error ? err.message : String(err), 'error');
      }
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, host, activeCourse, lang, topics]);

  const inspectorLines = useMemo(() => {
    if (!detail) {
      if (!topics.length) return [t(lang, '暂无主题数据。', 'No topic data yet.')];
      return [
        t(lang, '当前课程尚未保存知识骨架，下方为现有主题分布：', 'No saved skeleton yet. Topic overview:'),
        '',
        ...topics.slice(0, 20).map((tp) => `• ${tp.topic} (${tp.count}${t(lang, '题', 'Q')})`),
        '',
        t(lang, '按 [g] 自动生成交互式知识骨架。', 'Press [g] to generate an interactive knowledge skeleton.'),
      ];
    }
    if (!selectedNode) return [t(lang, '请在左侧选择一个知识节点。', 'Select a knowledge node on the left.')];

    const out: string[] = [];
    out.push(`${selectedNode.term}${selectedStats?.isFocus ? `  ⚑ ${t(lang, '考纲重点', 'Exam Focus')}` : ''}`);
    out.push('');
    out.push(`${t(lang, '释义', 'Description')}: ${selectedNode.meaning}`);
    if (selectedNode.attributes?.length) {
      out.push(`${t(lang, '特征', 'Traits')}: ${selectedNode.attributes.join(' · ')}`);
    }
    out.push('');
    if (selectedStats) {
      out.push(
        `${t(lang, '掌握度', 'Mastery')}: ${selectedStats.masteryPct}%  (${t(lang, '直属', 'Direct')} ${selectedStats.cardCount}${t(lang, '题', 'Q')} / ${t(lang, '子树共', 'Subtree')} ${selectedStats.subtreeCards.length}${t(lang, '题', 'Q')}, ${t(lang, '薄弱', 'Weak')} ${selectedStats.weakCount})`,
      );
    }
    const parentId = parentById.get(selectedNode.id);
    if (parentId && nodeById.has(parentId)) {
      out.push(`${t(lang, '上位概念', 'Parent')}: ${nodeById.get(parentId)!.term}`);
    }

    const rels = (detail.relations ?? []).filter((r) => r.from === selectedNode.id || r.to === selectedNode.id);
    if (rels.length) {
      out.push('');
      out.push(t(lang, '关联与前置关系:', 'Prerequisites & Relations:'));
      for (const r of rels) {
        const fromTerm = nodeById.get(r.from)?.term ?? r.from;
        const toTerm = nodeById.get(r.to)?.term ?? r.to;
        const relLabel = lang === 'zh' ? RELATION_ZH[r.type] ?? r.type : r.type;
        out.push(`  • ${fromTerm} —[${relLabel}]→ ${toTerm}${r.note ? ` (${r.note})` : ''}`);
      }
    }

    if (selectedStats?.samplePrompts.length) {
      out.push('');
      out.push(t(lang, '关联题目示例:', 'Sample Linked Questions:'));
      for (const p of selectedStats.samplePrompts) out.push(`  - ${p}`);
    }

    if (detail.overview) {
      out.push('');
      out.push(`${t(lang, '骨架总览', 'Skeleton Overview')}: ${detail.overview}`);
    }
    return out;
  }, [detail, topics, selectedNode, selectedStats, parentById, nodeById, lang]);

  const runLint = useCallback(async () => {
    const reqId = ++lintReqRef.current;
    setLintOpen(true);
    setLintLoading(true);
    setLintError('');
    setLintCursor(0);
    try {
      let scope: Array<{ deckId: string; topic?: string; cardId?: string }> = detail?.scope?.length ? [...detail.scope] : [];
      if (!scope.length) {
        const scopeMap = new Map<string, { deckId: string; topic?: string }>();
        for (const tp of topics.slice(0, 25)) {
          for (const d of tp.decks ?? []) {
            scopeMap.set(`${d.deckId}\0${tp.topic}`, { deckId: d.deckId, topic: tp.topic });
          }
        }
        scope = [...scopeMap.values()];
      }
      if (!scope.length) {
        if (mountedRef.current && lintReqRef.current === reqId) {
          setLintResult(null);
          setLintLoading(false);
        }
        return;
      }
      const res = await host.call<SkeletonLintResult>('skeleton.lint', { scope });
      if (!mountedRef.current || lintReqRef.current !== reqId) return;
      if (res.ok && res.value) {
        setLintResult(res.value);
      } else {
        setLintResult(null);
        setLintError(res.error?.message || t(lang, '骨架结构检查失败', 'Failed to lint skeleton'));
      }
    } catch (err) {
      if (mountedRef.current && lintReqRef.current === reqId) {
        setLintResult(null);
        setLintError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current && lintReqRef.current === reqId) {
        setLintLoading(false);
      }
    }
  }, [detail?.scope, topics, host, lang]);

  const lintFindings = useMemo(
    () => buildLintFindings(lintResult, detail, topics, cardIndex, nodeById, lang),
    [lintResult, detail, topics, cardIndex, nodeById, lang],
  );

  const modalOpen = switcherOpen || lintOpen || routeOpen || groupsOpen || nodeEditOpen;
  useClaimKeys(CLAIMED_KEYS, isActive && !modalOpen);

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'j/k', label: t(lang, '移动', 'Move') },
      { key: 'Space/h/l', label: t(lang, '展开/折叠', 'Toggle') },
      { key: 'p', label: t(lang, '练习节点', 'Practise') },
      ...(detail && selectedNode ? [{ key: 'E', label: t(lang, '编辑节点', 'Edit') }] : []),
      { key: 'R', label: t(lang, '路线', 'Route') },
      { key: 'G', label: t(lang, '分组', 'Groups') },
      { key: 'L', label: t(lang, '自检', 'Lint') },
      { key: 'g', label: t(lang, '生成骨架', 'Generate') },
      { key: 's', label: t(lang, '切换骨架', 'Switch') },
    ],
    [lang, detail, selectedNode],
  );
  useFooterHints(hints, isActive && !modalOpen);

  const treeViewportH = Math.max(4, height - 4);
  const treeScrollTop = useMemo(() => {
    if (selectedLineIdx < 0 || treeLines.length <= treeViewportH) return 0;
    const half = Math.floor(treeViewportH / 2);
    return Math.max(0, Math.min(selectedLineIdx - half, treeLines.length - treeViewportH));
  }, [selectedLineIdx, treeLines.length, treeViewportH]);

  useInput(
    (input) => {
      if (input === 'r') void runLint();
    },
    { isActive: isActive && lintOpen && !lintLoading },
  );

  useInput(
    (input, key) => {
      if (modalOpen) return;
      if (key.tab) {
        setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (input === 'L') {
        void runLint();
        return;
      }
      if (input === 'R') {
        setRouteOpen(true);
        return;
      }
      if (input === 'G') {
        setGroupsOpen(true);
        return;
      }
      if (input === 'E' && detail && selectedNode) {
        setNodeEditOpen(true);
        return;
      }
      if (input === 'p') {
        void practiseNode();
        return;
      }
      if (input === 'g') {
        void generateSkeleton();
        return;
      }
      if (input === 's' && skeletons.length > 0) {
        setSwitcherOpen(true);
        return;
      }
      if (input === 'r') {
        setReloadSeq((n) => n + 1);
        return;
      }

      if (activePane !== 'left' || treeLines.length === 0) return;

      if (key.downArrow || input === 'j') {
        const nextIdx = Math.min(treeLines.length - 1, Math.max(0, selectedLineIdx) + 1);
        setSelectedNodeId(treeLines[nextIdx]?.id ?? null);
      } else if (key.upArrow || input === 'k') {
        const prevIdx = Math.max(0, (selectedLineIdx < 0 ? 0 : selectedLineIdx) - 1);
        setSelectedNodeId(treeLines[prevIdx]?.id ?? null);
      } else if (input === ' ' || key.return) {
        const cur = treeLines[selectedLineIdx];
        if (cur?.hasChildren) toggleExpand(cur.id);
        else if (cur) setActivePane('right');
      } else if (input === 'l' || key.rightArrow) {
        const cur = treeLines[selectedLineIdx];
        if (cur?.hasChildren && !cur.expanded) toggleExpand(cur.id, true);
        else if (cur?.hasChildren && cur.expanded && treeLines[selectedLineIdx + 1]) {
          setSelectedNodeId(treeLines[selectedLineIdx + 1].id);
        } else {
          setActivePane('right');
        }
      } else if (input === 'h' || key.leftArrow) {
        const cur = treeLines[selectedLineIdx];
        if (cur?.hasChildren && cur.expanded) {
          toggleExpand(cur.id, false);
        } else if (cur) {
          const pid = parentById.get(cur.id);
          if (pid) setSelectedNodeId(pid);
        }
      } else if (input === 'e') {
        if (detail) {
          const allParents = detail.nodes.filter((n) => detail.nodes.some((c) => c.parent === n.id)).map((n) => n.id);
          setExpandedIds((prev) => (prev.size >= allParents.length ? new Set() : new Set(allParents)));
        }
      }
    },
    { isActive: isActive && !modalOpen },
  );

  const switcherOptions: SelectOption<string>[] = useMemo(
    () =>
      skeletons.map((k) => ({
        value: k.id,
        label: k.title,
        hint: `${k.nodes}${t(lang, '节点', ' nodes')} ${asciiMode ? '-' : '·'} ${k.relations}${t(lang, '关系', ' rels')}`,
        badge: `${k.cardIds?.length ?? 0}${t(lang, '题', 'Q')}`,
        badgeTone: 'primary',
      })),
    [skeletons, lang, asciiMode],
  );

  const lintModalW = Math.min(82, Math.max(46, width - 6));
  const lintModalH = Math.min(22, Math.max(12, height - 4));
  const lintInnerW = modalContentWidth(lintModalW);
  const lintListH = Math.max(4, lintModalH - 7);

  const renderLintRow = useCallback(
    (item: LintFindingItem, ctx: VirtualListRenderContext) => {
      const ell = asciiMode ? '...' : '…';
      const icon =
        item.severity === 'error'
          ? asciiMode
            ? '[!]'
            : '✕'
          : item.severity === 'warn'
            ? asciiMode
              ? '[~]'
              : '▲'
            : asciiMode
              ? '[i]'
              : '○';
      const toneColor =
        item.severity === 'error' ? theme.error : item.severity === 'warn' ? theme.warning : theme.info;
      const prefix = `${ctx.selected ? (asciiMode ? '>' : '❯') : ' '} ${icon} `;
      const tagText = `[${item.tag}]`;
      const bodyAvail = Math.max(10, ctx.width - prefix.length - tagText.length - 3);
      const bodyRaw = `${item.summary}: ${item.detail}`;
      const bodyText = padDisplay(truncateDisplay(bodyRaw, bodyAvail, ell), bodyAvail);
      return (
        <Box width={ctx.width} height={1}>
          <Text color={ctx.selected ? theme.primary : toneColor}>{prefix}</Text>
          <Text color={toneColor} bold>
            {tagText}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text}>{` ${bodyText}`}</Text>
        </Box>
      );
    },
    [asciiMode, theme],
  );

  const headerH = 2;
  const bodyH = Math.max(6, height - headerH);

  if (loading && !detail && skeletons.length === 0 && topics.length === 0) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Spinner label={t(lang, '正在加载知识骨架…', 'Loading knowledge skeleton…')} active={isActive} />
      </Box>
    );
  }

  const headerCompact = width < 105;
  const legendText = asciiMode
    ? t(lang, '*掌握  o学习  !薄弱  ^考纲重点', '*Mastered oLearning !Weak ^Focus')
    : t(lang, '★掌握  ◐学习  ✕薄弱  ⚑考纲重点', '★Mastered ◐Learning ✕Weak ⚑Focus');

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header */}
      <Box
        height={headerH}
        width={width}
        paddingX={1}
        flexDirection={headerCompact ? 'column' : 'row'}
        justifyContent={headerCompact ? 'flex-start' : 'space-between'}
        alignItems={headerCompact ? 'flex-start' : 'center'}
        overflow="hidden"
      >
        <Box gap={1} height={1} overflow="hidden">
          <Text color={theme.primary} bold>
            {asciiMode ? '&' : '⎇'}{' '}
            {truncateDisplay(
              detail?.title ?? t(lang, '知识骨架', 'Knowledge Skeleton'),
              Math.max(12, Math.floor(width * (headerCompact ? 0.48 : 0.36))),
              asciiMode ? '...' : '…',
            )}
          </Text>
          {activeCourse ? (
            <Box flexShrink={0}>
              <Badge label={truncateDisplay(activeCourse, 18, asciiMode ? '...' : '…')} tone="accent" variant="soft" />
            </Box>
          ) : null}
          {skeletons.length > 1 ? (
            <Box flexShrink={0}>
              <Badge label={`${skeletons.length} ${t(lang, '份', 'saved')}`} tone="info" variant="outline" />
            </Box>
          ) : null}
          {diagramCount > 0 ? (
            <Box flexShrink={0}>
              <Badge label={t(lang, `附图 ${diagramCount}`, `${diagramCount} diag`)} tone="info" variant="outline" />
            </Box>
          ) : null}
          {busyAction ? <Spinner label={t(lang, '生成中...', 'Working...')} active={isActive} /> : null}
        </Box>
        <Box height={1} overflow="hidden">
          <Text color={theme.muted}>{truncateDisplay(legendText, Math.max(12, width - 2), asciiMode ? '...' : '…')}</Text>
        </Box>
      </Box>

      {/* Main */}
      {!detail && topics.length === 0 ? (
        <Box width={width} height={bodyH} paddingX={1}>
          <EmptyState
            icon={asciiMode ? '&' : '⎇'}
            title={t(lang, '还没有知识骨架', 'No knowledge skeletons yet')}
            hint={t(lang, '先创建题组或导入题目，再按 [g] 生成知识层级树', 'Create questions first, then press [g] to generate a knowledge tree')}
            actions={[
              { key: 'g', label: t(lang, '生成骨架', 'Generate') },
              { key: 'c', label: t(lang, '选课', 'Course') },
            ]}
            width={width - 2}
            height={bodyH}
          />
        </Box>
      ) : (
        <SplitPane
          width={width}
          height={bodyH}
          leftWidth={0.44}
          minLeft={26}
          minRight={32}
          activePane={activePane}
          leftLabel={t(lang, '知识树 Tree', 'Tree')}
          rightLabel={t(lang, '节点详情', 'Inspector')}
          left={(size) => {
            const innerH = Math.max(3, size.height - 2);
            const innerW = Math.max(12, size.width - 4);
            const visible = treeLines.slice(treeScrollTop, treeScrollTop + innerH);
            return (
              <Panel
                title={detail ? t(lang, '知识层级树', 'Knowledge Tree') : t(lang, '课程主题预览', 'Course Topics')}
                badge={detail ? detail.nodes.length : topics.length}
                focused={activePane === 'left'}
                width={size.width}
                height={size.height}
                paddingX={1}
              >
                {visible.map((line) => {
                  const st = nodeStatsMap.get(line.id);
                  const fg = line.selected
                    ? theme.selectionFg
                    : st?.level === 'weak'
                      ? theme.error
                      : st?.level === 'mastered'
                        ? theme.success
                        : theme.text;
                  return (
                    <Box key={line.id} width={innerW} height={1} backgroundColor={line.selected ? theme.selectionBg : undefined}>
                      <Text color={fg} bold={line.selected}>
                        {truncateDisplay(line.text, innerW)}
                      </Text>
                    </Box>
                  );
                })}
              </Panel>
            );
          }}
          right={(size) => {
            const innerW = Math.max(16, size.width - 4);
            const innerH = Math.max(3, size.height - 2);
            return (
              <Panel
                title={selectedNode ? selectedNode.term : t(lang, '节点检视器', 'Node Inspector')}
                badge={selectedStats ? `${selectedStats.masteryPct}%` : undefined}
                badgeTone={selectedStats?.level === 'weak' ? 'error' : selectedStats?.level === 'mastered' ? 'success' : 'primary'}
                focused={activePane === 'right'}
                width={size.width}
                height={size.height}
                paddingX={1}
              >
                {selectedStats ? (
                  <Box marginBottom={1}>
                    <ProgressBar
                      ratio={selectedStats.masteryPct / 100}
                      width={innerW}
                      label={t(lang, '掌握', 'Mastery')}
                    />
                  </Box>
                ) : null}
                <ScrollView
                  lines={inspectorLines}
                  width={innerW}
                  height={Math.max(2, innerH - (selectedStats ? 2 : 0))}
                  isActive={isActive && activePane === 'right' && !modalOpen}
                />
              </Panel>
            );
          }}
        />
      )}

      {switcherOpen ? (
        <Modal
          title={t(lang, '选择已保存的知识骨架', 'Switch Knowledge Skeleton')}
          icon={asciiMode ? '&' : '⎇'}
          onClose={() => setSwitcherOpen(false)}
          isActive={isActive}
          width={Math.min(70, Math.max(40, width - 6))}
          hints={[
            { key: 'Enter', label: t(lang, '打开', 'Open') },
            { key: 'Esc', label: t(lang, '关闭', 'Close') },
          ]}
        >
          <SelectList
            options={switcherOptions}
            currentValue={selectedSkeletonId ?? undefined}
            width={modalContentWidth(Math.min(70, Math.max(40, width - 6)))}
            maxHeight={10}
            isActive={isActive}
            onSelect={(opt) => {
              setSelectedSkeletonId(opt.value);
              setSwitcherOpen(false);
            }}
          />
        </Modal>
      ) : null}

      {lintOpen ? (
        <Modal
          title={t(lang, '骨架结构自检', 'Skeleton Lint & Health')}
          subtitle={detail?.title}
          icon={asciiMode ? '!' : '⚑'}
          tone={lintError ? 'error' : lintFindings.length > 0 ? 'warning' : 'success'}
          onClose={() => setLintOpen(false)}
          isActive={isActive}
          width={lintModalW}
          height={lintModalH}
          hints={[
            { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
            { key: 'r', label: t(lang, '重检', 'Re-run') },
            { key: 'Esc', label: t(lang, '关闭', 'Close') },
          ]}
        >
          {lintLoading ? (
            <Box height={Math.max(4, lintListH + 2)} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, '正在检查骨架与题目结构...', 'Linting skeleton structure...')} active={isActive} />
            </Box>
          ) : lintError ? (
            <Box flexDirection="column" gap={1} paddingY={1}>
              <StatusPill status="error" label={t(lang, '检查失败', 'Lint failed')} />
              <Text color={theme.error}>{truncateDisplay(lintError, lintInnerW, asciiMode ? '...' : '…')}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box height={1} justifyContent="space-between" overflow="hidden">
                <StatusPill
                  status={lintFindings.length === 0 ? 'ok' : 'warn'}
                  label={
                    lintFindings.length === 0
                      ? t(lang, '骨架结构健康', 'Skeleton structure looks healthy')
                      : t(lang, `发现 ${lintFindings.length} 项结构提示`, `${lintFindings.length} structural finding(s)`)
                  }
                />
                <Text color={theme.muted}>
                  {lintResult
                    ? t(lang, `${lintResult.total}题 / ${lintResult.flagged}标红`, `${lintResult.total} cards / ${lintResult.flagged} flagged`)
                    : detail
                      ? t(lang, `${detail.nodes.length}节点`, `${detail.nodes.length} nodes`)
                      : ''}
                </Text>
              </Box>
              <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, lintInnerW))}</Text>
              {lintFindings.length === 0 ? (
                <Box height={lintListH} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
                  <Text color={theme.success} bold>
                    {t(lang, '骨架结构健康', 'Skeleton structure looks healthy')}
                  </Text>
                  <Text color={theme.muted}>
                    {truncateDisplay(
                      lintResult
                        ? t(
                            lang,
                            `已检查 ${lintResult.total} 道题与 ${detail?.nodes.length ?? 0} 个节点，未发现孤立主题或断链。`,
                            `Checked ${lintResult.total} cards and ${detail?.nodes.length ?? 0} nodes; no issues or orphaned topics found.`,
                          )
                        : t(lang, '当前作用域暂无可检查的题卡或结构问题。', 'No cards in scope or structural issues detected.'),
                      lintInnerW,
                      asciiMode ? '...' : '…',
                    )}
                  </Text>
                </Box>
              ) : (
                <VirtualList
                  items={lintFindings}
                  width={lintInnerW}
                  height={lintListH}
                  selectedIndex={lintCursor}
                  onChange={(idx) => setLintCursor(idx)}
                  isActive={isActive && lintOpen}
                  keyExtractor={(item) => item.id}
                  renderItem={renderLintRow}
                  ascii={asciiMode}
                />
              )}
            </Box>
          )}
        </Modal>
      ) : null}

      <Suspense fallback={null}>
        {routeOpen ? (
          <CourseRouteModal
            host={host}
            activeCourse={activeCourse}
            isActive={isActive && routeOpen}
            onClose={() => setRouteOpen(false)}
          />
        ) : null}
        {groupsOpen ? (
          <TopicGroupsModal
            host={host}
            activeCourse={activeCourse}
            isActive={isActive && groupsOpen}
            onClose={() => setGroupsOpen(false)}
            onSaved={() => setReloadSeq((n) => n + 1)}
          />
        ) : null}
        {nodeEditOpen && detail && selectedNode ? (
          <NodeEditModal
            host={host}
            skeletonId={detail.id}
            node={selectedNode}
            isActive={isActive && nodeEditOpen}
            onClose={() => setNodeEditOpen(false)}
            onSaved={() => void refreshDetail()}
          />
        ) : null}
      </Suspense>
    </Box>
  );
};
