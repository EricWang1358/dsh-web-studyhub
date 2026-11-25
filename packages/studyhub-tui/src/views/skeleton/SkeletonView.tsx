import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import { KEY_LAYER_MODAL } from '../../input/dispatcher.js';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { atomicWriteExportText, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { useShellActions } from '../../shell/actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, ProgressBar, Spinner, StatusPill } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { ScrollView } from '../../components/ScrollView.js';
import { SelectList, type SelectOption } from '../../components/SelectList.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, parseSgrWheelDelta, useSgrMouseWheel, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { padDisplay, truncateDisplay } from '../../render/cjk.js';
import { renderTreeLines, type TreeLine, type TreeNode } from '../../render/charts.js';
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
const SkeletonDiagramsModal = lazy(() =>
  import('./SkeletonDiagramsModal.js').then((m) => ({ default: m.SkeletonDiagramsModal })),
);

const CLAIMED_KEYS = ['L', 'R', 'G', 'E', 'D', 'M', '/', 'x'] as const;

const LintModalHotkeys = memo(function LintModalHotkeys({
  isActive,
  onRerun,
}: {
  isActive: boolean;
  onRerun: () => void;
}) {
  useKeyScope({
    id: 'SkeletonView:lint',
    active: isActive,
    layer: KEY_LAYER_MODAL,
    onKey: (input) => {
      if (input === 'r') {
        onRerun();
        return true;
      }
      return false;
    },
  });
  return null;
});

export { todayLocalYmd };

export interface FormatSkeletonMarkdownOptions {
  detail: SkeletonDetail;
  course?: string | null;
  masteryMap?: ReadonlyMap<string, NodeStats> | Record<string, NodeStats>;
  lang?: 'zh' | 'en';
  generatedAt?: Date | string;
}

function readNodeStats(
  masteryMap: FormatSkeletonMarkdownOptions['masteryMap'],
  nodeId: string,
): NodeStats | undefined {
  if (!masteryMap) return undefined;
  if (masteryMap instanceof Map) return masteryMap.get(nodeId);
  if (typeof (masteryMap as ReadonlyMap<string, NodeStats>).get === 'function') {
    return (masteryMap as ReadonlyMap<string, NodeStats>).get(nodeId);
  }
  return (masteryMap as Record<string, NodeStats>)[nodeId];
}

function cleanMdText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\r?\n+/g, ' ').trim() : '';
}

/** Pure helper generating a hierarchical Markdown outline for a knowledge skeleton (0 LLM tokens). */
export function formatSkeletonMarkdown({
  detail,
  course,
  masteryMap,
  lang = 'en',
  generatedAt = new Date(),
}: FormatSkeletonMarkdownOptions): string {
  const nodes = Array.isArray(detail?.nodes) ? detail.nodes : [];
  const relations = Array.isArray(detail?.relations) ? detail.relations : [];
  const title = cleanMdText(detail?.title) || (lang === 'zh' ? '知识骨架' : 'Knowledge Skeleton');
  const courseLabel = cleanMdText(course) || (lang === 'zh' ? '全部课程' : 'All Courses');
  const timestamp =
    generatedAt instanceof Date
      ? generatedAt.toISOString().slice(0, 16).replace('T', ' ')
      : cleanMdText(generatedAt) || new Date().toISOString().slice(0, 16).replace('T', ' ');

  const nodeById = new Map<string, SkeletonNode>();
  const childrenMap = new Map<string, SkeletonNode[]>();
  for (const n of nodes) {
    nodeById.set(n.id, n);
    childrenMap.set(n.id, []);
  }
  const roots: SkeletonNode[] = [];
  for (const n of nodes) {
    if (n.parent && nodeById.has(n.parent) && n.parent !== n.id) {
      childrenMap.get(n.parent)!.push(n);
    } else {
      roots.push(n);
    }
  }

  const uniqueCardIds = new Set<string>();
  let masterySum = 0;
  let masteryCount = 0;
  for (const n of nodes) {
    for (const ref of n.cards ?? []) {
      if (ref?.cardId) uniqueCardIds.add(ref.cardId);
    }
    const st = readNodeStats(masteryMap, n.id);
    if (st && typeof st.masteryPct === 'number') {
      masterySum += st.masteryPct;
      masteryCount += 1;
    }
  }
  const avgMasteryPct = masteryCount > 0 ? Math.round(masterySum / masteryCount) : 0;

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    lang === 'zh'
      ? `- 课程: ${courseLabel} | 节点: ${nodes.length} | 关系: ${relations.length} | 题卡: ${uniqueCardIds.size} | 平均掌握度: ${avgMasteryPct}% | 导出时间: ${timestamp}`
      : `- Course: ${courseLabel} | Nodes: ${nodes.length} | Relations: ${relations.length} | Cards: ${uniqueCardIds.size} | Avg Mastery: ${avgMasteryPct}% | Generated: ${timestamp}`,
  );

  const overview = cleanMdText(detail?.overview);
  if (overview) {
    lines.push('');
    lines.push(`> ${overview}`);
  }
  const classNote = cleanMdText(detail?.classNote);
  if (classNote) {
    lines.push('');
    lines.push(`- ${lang === 'zh' ? '课堂备注' : 'Class Note'}: ${classNote}`);
  }

  lines.push('');
  lines.push(`## ${lang === 'zh' ? '知识层级大纲' : 'Knowledge Outline'}`);
  lines.push('');

  if (nodes.length === 0) {
    lines.push(lang === 'zh' ? '_暂无知识节点_' : '_No knowledge nodes_');
  } else {
    const visited = new Set<string>();
    const appendNode = (n: SkeletonNode, depth: number) => {
      if (visited.has(n.id)) return;
      visited.add(n.id);
      const st = readNodeStats(masteryMap, n.id);
      const directCards = st?.cardCount ?? (n.cards ?? []).length;
      const masteryPct = st?.masteryPct ?? 0;
      const focusTag = st?.isFocus ? (lang === 'zh' ? ' | 考纲重点' : ' | Focus') : '';
      const badge =
        lang === 'zh'
          ? `[${masteryPct}% | ${directCards}题${focusTag}]`
          : `[${masteryPct}% | ${directCards} cards${focusTag}]`;
      const dyn = n as SkeletonNode & { title?: string; summary?: string; note?: string };
      const label = cleanMdText(n.term) || cleanMdText(dyn.title) || n.id;
      const desc = cleanMdText(n.meaning) || cleanMdText(dyn.summary) || cleanMdText(dyn.note);

      if (depth === 0) {
        lines.push(`### ${label} ${badge}`);
        if (desc) lines.push(`- ${lang === 'zh' ? '释义' : 'Summary'}: ${desc}`);
        if (n.attributes?.length) {
          lines.push(`- ${lang === 'zh' ? '特征' : 'Traits'}: ${n.attributes.join(', ')}`);
        }
      } else {
        const indent = '  '.repeat(depth - 1);
        lines.push(`${indent}- **${label}** ${badge}`);
        if (desc) lines.push(`${indent}  - ${desc}`);
        if (n.attributes?.length) {
          lines.push(`${indent}  - ${lang === 'zh' ? '特征' : 'Traits'}: ${n.attributes.join(', ')}`);
        }
      }

      for (const kid of childrenMap.get(n.id) ?? []) {
        appendNode(kid, depth + 1);
      }
      if (depth === 0) lines.push('');
    };

    for (const root of roots) {
      appendNode(root, 0);
    }
    for (const n of nodes) {
      if (!visited.has(n.id)) appendNode(n, 0);
    }
  }

  if (relations.length > 0) {
    lines.push(`## ${lang === 'zh' ? '概念关系' : 'Relations'}`);
    lines.push('');
    for (const r of relations) {
      const fromTerm = nodeById.get(r.from)?.term ?? r.from;
      const toTerm = nodeById.get(r.to)?.term ?? r.to;
      const relLabel = lang === 'zh' ? RELATION_ZH[r.type] ?? r.type : r.type;
      const noteText = cleanMdText(r.note);
      lines.push(`- ${fromTerm} --[${relLabel}]-> ${toTerm}${noteText ? ` (${noteText})` : ''}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

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

const LEVEL_WEIGHT: Record<CardMasteryInfo['level'], number> = {
  new: 0,
  weak: 0.15,
  learning: 0.45,
  familiar: 0.75,
  mastered: 1,
};

function inferCardLevel(card: Record<string, unknown>, lastGrade?: number): CardMasteryInfo['level'] {
  const rev = card.review as Record<string, unknown> | undefined;
  const streak = Number(rev?.repetitions ?? 0) || 0;
  const totalReps = Number(rev?.reps ?? 0) || 0;
  const days = Number(rev?.interval_days ?? 0) || 0;
  const lapses = Number(rev?.lapses ?? 0) || 0;
  const hasReviewHistory = Boolean(rev?.lastReview || rev?.last_review);
  if (lastGrade === undefined && streak <= 0 && totalReps <= 0 && lapses <= 0 && !hasReviewHistory) {
    return 'new';
  }
  if (lastGrade !== undefined && lastGrade < 3) return 'weak';
  if (lastGrade === 5) return 'mastered';
  if ((lapses > 0 && (streak <= 0 || days < 3)) || (streak <= 0 && (totalReps > 0 || hasReviewHistory) && days < 3)) {
    return 'weak';
  }
  const cap = Number(rev?.maximum_interval);
  const line = (value: number) => (Number.isFinite(cap) && cap >= 1 ? Math.min(value, cap) : value);
  if (days >= line(21) && streak >= 2) return 'mastered';
  if (days >= line(6)) return 'familiar';
  return 'learning';
}

function buildHierarchy(
  nodes: SkeletonNode[],
  statsMap: Map<string, NodeStats>,
  asciiMode = false,
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
    const focusMark = st?.isFocus ? (asciiMode ? '^ ' : '⚑ ') : '';
    const levelIcon = asciiMode
      ? st?.level === 'mastered'
        ? '*'
        : st?.level === 'weak'
          ? '!'
          : st?.level === 'learning'
            ? 'o'
            : '-'
      : st?.level === 'mastered'
        ? '★'
        : st?.level === 'weak'
          ? '✕'
          : st?.level === 'learning'
            ? '◐'
            : '○';
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
  const { refresh } = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshotDecks = useTuiStore((s) => s.snapshot?.decks);
  const snapshotAttempts = useTuiStore((s) => s.snapshot?.attempts);
  const snapshotProgress = useTuiStore((s) => s.snapshot?.progress);
  const snapshotRoot = useTuiStore((s) => s.snapshot?.root);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const snapshotCourse = useTuiStore((s) => (typeof s.snapshot?.focus?.course === 'string' ? s.snapshot.focus.course : null));
  const navCourse = useTuiStore((s) => s.navContext.course);
  const activeCourse = navCourse ?? snapshotCourse;

  const [loading, setLoading] = useState(true);
  const [skeletons, setSkeletons] = useState<SkeletonSummary[]>([]);
  const [topics, setTopics] = useState<SkeletonTopicItem[]>([]);
  const [focusTopics, setFocusTopics] = useState<FocusProgressTopic[]>([]);
  const [selectedSkeletonId, setSelectedSkeletonId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkeletonDetail | null>(null);
  const [fetchedDecks, setFetchedDecks] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
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
  const [diagramsOpen, setDiagramsOpen] = useState(false);
  const [confirmGenOpen, setConfirmGenOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);
  const lintReqRef = useRef(0);
  const genAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      genAbortRef.current?.abort();
      genAbortRef.current = null;
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

  // Collect unique deckIds referenced by detail.nodes[].cards (plus detail.scope[].deckId fallback)
  const detailDeckIds = useMemo(() => {
    if (!detail) return [];
    const ids = new Set<string>();
    for (const n of detail.nodes ?? []) {
      for (const c of n.cards ?? []) {
        if (c.deckId) ids.add(c.deckId);
      }
    }
    for (const s of detail.scope ?? []) {
      if (s.deckId) ids.add(s.deckId);
    }
    return [...ids];
  }, [detail]);

  // Fetch full decks via deck.get because snapshot.decks omits .cards arrays
  useEffect(() => {
    if (!detailDeckIds.length) {
      setFetchedDecks({});
      return;
    }
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        detailDeckIds.map((id) =>
          host
            .call<{ id?: string; cards?: Array<Record<string, unknown>> }>('deck.get', { id })
            .catch(() => ({ ok: false as const, value: undefined })),
        ),
      );
      if (cancelled || !mountedRef.current) return;
      const next: Record<string, Array<Record<string, unknown>>> = {};
      results.forEach((res, idx) => {
        if (res.ok && res.value && Array.isArray(res.value.cards)) {
          const deckId = String(res.value.id || detailDeckIds[idx]);
          next[deckId] = res.value.cards;
        }
      });
      setFetchedDecks(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [host, detailDeckIds, reloadSeq]);

  const latestGrades = useMemo(() => {
    const grades = new Map<string, number>();
    for (const raw of snapshotAttempts ?? []) {
      if (!raw || raw.voidedAt || raw.retry || raw.updatedAfterOpening) continue;
      const cardId = typeof raw.quiz_id === 'string' ? raw.quiz_id : typeof raw.cardId === 'string' ? raw.cardId : '';
      const deckId = typeof raw.deckId === 'string' ? raw.deckId : '';
      const grade = Number(raw.grade);
      if (cardId && Number.isFinite(grade)) {
        grades.set(`${deckId}\0${cardId}`, grade);
        grades.set(`\0${cardId}`, grade);
      }
    }
    return grades;
  }, [snapshotAttempts]);

  // Card mastery lookup from fetched decks (falling back to snapshotDecks[].cards if present)
  const cardIndex = useMemo(() => {
    const map = new Map<string, CardMasteryInfo>();
    const indexCards = (deckId: string, cards: Array<Record<string, unknown>>) => {
      for (const c of cards) {
        const cardId = String(c.id ?? '');
        if (!cardId) continue;
        const lastGrade = latestGrades.get(`${deckId}\0${cardId}`) ?? latestGrades.get(`\0${cardId}`);
        map.set(cardId, {
          deckId,
          cardId,
          topic: String(c.topic ?? ''),
          prompt: String(c.prompt ?? '').replace(/\s+/g, ' ').trim(),
          level: inferCardLevel(c, lastGrade),
        });
      }
    };
    for (const [deckId, cards] of Object.entries(fetchedDecks)) {
      indexCards(deckId, cards);
    }
    for (const deck of snapshotDecks ?? []) {
      if (Object.prototype.hasOwnProperty.call(fetchedDecks, deck.id)) continue;
      const cards = Array.isArray((deck as Record<string, unknown>).cards)
        ? ((deck as Record<string, unknown>).cards as Array<Record<string, unknown>>)
        : [];
      indexCards(deck.id, cards);
    }
    return map;
  }, [fetchedDecks, snapshotDecks, latestGrades]);

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
      let weightSum = 0;
      let matched = 0;
      const samplePrompts: string[] = [];
      let topicFocusHit = focusTermSet.has(n.term.toLowerCase());

      for (const ref of subtreeCards) {
        const info = cardIndex.get(ref.cardId);
        if (info) {
          matched += 1;
          weightSum += LEVEL_WEIGHT[info.level];
          if (info.level === 'mastered' || info.level === 'familiar') mastered += 1;
          else if (info.level === 'weak') weak += 1;
          else if (info.level === 'learning') learning += 1;
          if (samplePrompts.length < 4 && info.prompt) samplePrompts.push(info.prompt);
          if (info.topic && focusTermSet.has(info.topic.toLowerCase())) topicFocusHit = true;
        }
      }
      const total = subtreeCards.length;
      let masteryPct = total > 0 ? Math.round((weightSum / total) * 100) : 0;
      if (total > 0 && matched === 0 && snapshotProgress) {
        let progSum = 0;
        let progCount = 0;
        for (const ref of subtreeCards) {
          const deckProg = snapshotProgress[ref.deckId] as { mastery?: number } | undefined;
          if (deckProg && typeof deckProg.mastery === 'number') {
            progSum += deckProg.mastery;
            progCount += 1;
          }
        }
        if (progCount > 0) masteryPct = Math.round(progSum / progCount);
      }
      const level: NodeStats['level'] =
        weak > 0
          ? 'weak'
          : total > 0 && (mastered === total || masteryPct >= 80)
            ? 'mastered'
            : learning > 0 || mastered > 0 || masteryPct > 0
              ? 'learning'
              : 'new';

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
  }, [detail, cardIndex, focusTermSet, snapshotProgress]);

  const { tree, parentById, nodeById } = useMemo(
    () => buildHierarchy(detail?.nodes ?? [], nodeStatsMap, asciiMode),
    [detail?.nodes, nodeStatsMap, asciiMode],
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

  const normalizedFilter = filterQuery.trim().toLowerCase();

  const allExpandedIds = useMemo(() => {
    if (detail) {
      return new Set(detail.nodes.filter((n) => detail.nodes.some((c) => c.parent === n.id)).map((n) => n.id));
    }
    return new Set(topics.slice(0, 60).map((tp) => `topic:${tp.key}`));
  }, [detail, topics]);

  const activeTree = detail ? tree : fallbackTopicTree;

  const treeLabelById = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (items: TreeNode[]) => {
      for (const item of items) {
        map.set(item.id, item.label);
        if (item.children?.length) walk(item.children);
      }
    };
    walk(activeTree);
    return map;
  }, [activeTree]);

  const baseTreeLines: TreeLine[] = useMemo(
    () =>
      renderTreeLines(activeTree, normalizedFilter ? allExpandedIds : expandedIds, null, treePaneWidth, {
        ascii: asciiMode,
      }),
    [activeTree, normalizedFilter, allExpandedIds, expandedIds, treePaneWidth, asciiMode],
  );

  const matchesFilter = useCallback(
    (id: string): boolean => {
      if (!normalizedFilter) return true;
      if (id.toLowerCase().includes(normalizedFilter)) return true;
      const fallbackLabel = treeLabelById.get(id);
      if (fallbackLabel && fallbackLabel.toLowerCase().includes(normalizedFilter)) return true;
      const node = nodeById.get(id);
      if (node) {
        const dyn = node as SkeletonNode & { title?: string; summary?: string; note?: string; topic?: string };
        if (node.term.toLowerCase().includes(normalizedFilter)) return true;
        if (dyn.title && dyn.title.toLowerCase().includes(normalizedFilter)) return true;
        if (node.meaning && node.meaning.toLowerCase().includes(normalizedFilter)) return true;
        if (dyn.summary && dyn.summary.toLowerCase().includes(normalizedFilter)) return true;
        if (dyn.note && dyn.note.toLowerCase().includes(normalizedFilter)) return true;
        if (dyn.topic && dyn.topic.toLowerCase().includes(normalizedFilter)) return true;
        if (node.attributes?.some((attr) => attr.toLowerCase().includes(normalizedFilter))) return true;
        for (const ref of node.cards ?? []) {
          const info = cardIndex.get(ref.cardId);
          if (info?.topic && info.topic.toLowerCase().includes(normalizedFilter)) return true;
        }
      }
      return false;
    },
    [normalizedFilter, treeLabelById, nodeById, cardIndex],
  );

  const treeLines: TreeLine[] = useMemo(
    () => (normalizedFilter ? baseTreeLines.filter((l) => matchesFilter(l.id)) : baseTreeLines),
    [normalizedFilter, baseTreeLines, matchesFilter],
  );

  const effectiveSelectedNodeId = useMemo(() => {
    if (treeLines.length === 0) return null;
    if (selectedNodeId && treeLines.some((l) => l.id === selectedNodeId)) return selectedNodeId;
    return treeLines[0].id;
  }, [treeLines, selectedNodeId]);

  const selectedLineIdx = useMemo(() => {
    if (!treeLines.length || !effectiveSelectedNodeId) return -1;
    const idx = treeLines.findIndex((l) => l.id === effectiveSelectedNodeId);
    return idx >= 0 ? idx : 0;
  }, [treeLines, effectiveSelectedNodeId]);

  useEffect(() => {
    if (treeLines.length > 0 && effectiveSelectedNodeId && effectiveSelectedNodeId !== selectedNodeId) {
      setSelectedNodeId(effectiveSelectedNodeId);
    }
  }, [treeLines.length, effectiveSelectedNodeId, selectedNodeId]);

  const selectedNode = effectiveSelectedNodeId ? nodeById.get(effectiveSelectedNodeId) ?? null : null;
  const selectedStats = effectiveSelectedNodeId ? nodeStatsMap.get(effectiveSelectedNodeId) ?? null : null;

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
    if (!selectedNode || busyRef.current || busyAction !== null) return;
    const refs = selectedStats?.subtreeCards.length ? selectedStats.subtreeCards : selectedNode.cards;
    if (!refs.length) {
      useTuiStore.getState().notify(t(lang, '该知识节点暂无关联题目', 'No cards linked to this node'), 'warning');
      return;
    }
    busyRef.current = true;
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
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [selectedNode, selectedStats, busyAction, host, lang, activeCourse]);

  const requestGenerateSkeleton = useCallback(() => {
    if (busyRef.current || busyAction !== null) return;
    if (!topics.length) {
      useTuiStore.getState().notify(t(lang, '当前课程还没有题目，无法生成知识骨架', 'No questions in scope to generate skeleton'), 'warning');
      return;
    }
    setConfirmGenOpen(true);
  }, [busyAction, topics.length, lang]);

  const generateSkeleton = useCallback(async () => {
    if (busyRef.current || busyAction !== null) return;
    busyRef.current = true;
    setBusyAction('generate');
    try {
      // 1. Gather scope from skeleton.topics + skeleton.context and generate via host.streamComplete -> skeleton.save
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
      if (cards.length === 0) {
        useTuiStore.getState().notify(t(lang, '当前课程还没有题目，无法生成知识骨架', 'No questions in scope to generate skeleton'), 'warning');
        return;
      }

      if (!host.streamComplete) {
        useTuiStore.getState().notify(
          t(lang, '当前模型未就绪，无法生成知识骨架（请先检查模型配置）', 'Model is unavailable to generate skeleton; check model configuration'),
          'error',
        );
        return;
      }

      useTuiStore.getState().notify(t(lang, `正在用 AI 构建知识骨架${asciiMode ? '...' : '…'}`, 'Generating knowledge skeleton with AI...'), 'info');
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
      genAbortRef.current?.abort();
      const ac = new AbortController();
      genAbortRef.current = ac;
      const raw = await host.streamComplete({ system: sys, prompt, signal: ac.signal });
      if (!mountedRef.current || ac.signal.aborted) return;
      const parsed = extractJsonObject(raw);
      if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
        useTuiStore.getState().notify(
          t(lang, 'AI 返回的骨架格式无效，未写入（可重试或先检查模型配置）', 'Model output could not be parsed as a valid skeleton; nothing saved'),
          'error',
        );
        return;
      }

      const saved = await host.call<SkeletonDetail>('skeleton.save', { ...parsed, scope });
      if (!mountedRef.current || ac.signal.aborted) return;
      if (saved.ok && saved.value?.id) {
        setSelectedSkeletonId(saved.value.id);
        setReloadSeq((n) => n + 1);
        useTuiStore.getState().notify(t(lang, `已生成骨架「${saved.value.title}」`, `Generated skeleton "${saved.value.title}"`), 'success');
      } else {
        useTuiStore.getState().notify(saved.error?.message || t(lang, '骨架保存失败', 'Failed to save skeleton'), 'error');
      }
    } catch (err) {
      if (mountedRef.current && !genAbortRef.current?.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        useTuiStore.getState().notify(
          t(lang, `AI 骨架生成失败，未写入：${msg}`, `AI skeleton generation failed; nothing saved: ${msg}`),
          'error',
        );
      }
    } finally {
      genAbortRef.current = null;
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [asciiMode, busyAction, host, activeCourse, lang, topics]);

  const deleteSkeleton = useCallback(async () => {
    const target = detail;
    if (!target || busyRef.current || busyAction !== null) return;
    busyRef.current = true;
    setBusyAction('delete');
    try {
      const res = await host.call<{ deleted?: string }>('skeleton.delete', { id: target.id });
      if (!mountedRef.current) return;
      if (!res.ok) {
        useTuiStore
          .getState()
          .notify(res.error?.message || t(lang, '删除知识骨架失败', 'Failed to delete skeleton'), 'error');
        return;
      }
      setDetail(null);
      setDiagramCount(0);
      setSelectedNodeId(null);
      setSelectedSkeletonId(null);
      setLintResult(null);
      setReloadSeq((n) => n + 1);
      await refresh();
      if (!mountedRef.current) return;
      useTuiStore.getState().notify(
        t(
          lang,
          `已删除知识骨架「${target.title}」（题组与卡片保持不变）`,
          `Deleted skeleton "${target.title}" (decks and cards remain untouched)`,
        ),
        'success',
      );
    } catch (err) {
      if (mountedRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        useTuiStore.getState().notify(t(lang, `删除知识骨架失败：${msg}`, `Failed to delete skeleton: ${msg}`), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [detail, busyAction, host, lang, refresh]);

  const inspectorLines = useMemo(() => {
    const bullet = asciiMode ? '* ' : '• ';
    const focusSym = asciiMode ? '^ ' : '⚑ ';
    if (!detail) {
      if (!topics.length) return [t(lang, '暂无主题数据。', 'No topic data yet.')];
      return [
        t(lang, '当前课程尚未保存知识骨架，下方为现有主题分布：', 'No saved skeleton yet. Topic overview:'),
        '',
        ...topics.slice(0, 20).map((tp) => `${bullet}${tp.topic} (${tp.count}${t(lang, '题', 'Q')})`),
        '',
        t(lang, '按 [g] 自动生成交互式知识骨架。', 'Press [g] to generate an interactive knowledge skeleton.'),
      ];
    }
    if (!selectedNode) return [t(lang, '请在左侧选择一个知识节点。', 'Select a knowledge node on the left.')];

    const out: string[] = [];
    out.push(`${selectedNode.term}${selectedStats?.isFocus ? `  ${focusSym}${t(lang, '考纲重点', 'Exam Focus')}` : ''}`);
    out.push('');
    out.push(`${t(lang, '释义', 'Description')}: ${selectedNode.meaning}`);
    if (selectedNode.attributes?.length) {
      out.push(`${t(lang, '特征', 'Traits')}: ${selectedNode.attributes.join(asciiMode ? ' - ' : ' · ')}`);
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
        const relLine = asciiMode
          ? `  * ${fromTerm} --[${relLabel}]-> ${toTerm}${r.note ? ` (${r.note})` : ''}`
          : `  • ${fromTerm} —[${relLabel}]→ ${toTerm}${r.note ? ` (${r.note})` : ''}`;
        out.push(relLine);
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
  }, [detail, topics, selectedNode, selectedStats, parentById, nodeById, lang, asciiMode]);

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

  const exportSkeleton = useCallback(async () => {
    if (exportBusyRef.current) return;
    if (!detail) {
      useTuiStore
        .getState()
        .notify(t(lang, '当前暂无可导出的知识骨架', 'No skeleton to export'), 'info');
      return;
    }
    exportBusyRef.current = true;
    try {
      const markdown = formatSkeletonMarkdown({
        detail,
        course: activeCourse,
        masteryMap: nodeStatsMap,
        lang,
        generatedAt: new Date(),
      });
      const rawRoot =
        bindingRoot?.trim() ||
        host.getLibraryRoot?.()?.trim() ||
        host.getConfig?.()?.libraryRoot?.trim() ||
        snapshotRoot?.trim() ||
        '';
      const baseDir = rawRoot ? resolve(rawRoot) : process.cwd();
      const defaultPath = defaultBackupFilePath(baseDir, 'studyhub-skeleton', 'md', activeCourse || detail.title || undefined);
      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      useTuiStore.getState().notify(
        t(
          lang,
          `已导出 ${detail.nodes.length} 个知识节点 ${arrow} ${written.path}`,
          `Exported ${detail.nodes.length} skeleton node(s) ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      useTuiStore.getState().notify(t(lang, `导出知识骨架失败：${msg}`, `Failed to export skeleton: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [activeCourse, asciiMode, bindingRoot, detail, host, lang, nodeStatsMap, snapshotRoot]);

  const treeLinesRef = useRef(treeLines);
  treeLinesRef.current = treeLines;
  const selectedLineIdxRef = useRef(selectedLineIdx);
  selectedLineIdxRef.current = selectedLineIdx;

  const moveTreeCursorByWheel = useCallback((delta: number) => {
    if (delta === 0) return;
    const rows = treeLinesRef.current;
    if (rows.length === 0) return;
    const step = delta > 0 ? Math.max(1, Math.round(delta / 3)) : Math.min(-1, Math.round(delta / 3));
    const cur = Math.max(0, selectedLineIdxRef.current);
    const nextIdx = Math.max(0, Math.min(rows.length - 1, cur + step));
    const targetId = rows[nextIdx]?.id ?? null;
    if (targetId) {
      selectedLineIdxRef.current = nextIdx;
      setSelectedNodeId(targetId);
    }
  }, []);

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'j/k', label: t(lang, '移动', 'Move') },
      { key: 'Space/h/l', label: t(lang, '折叠', 'Toggle') },
      { key: 'p', label: t(lang, '练习', 'Practise') },
      ...(detail && selectedNode ? [{ key: 'E', label: t(lang, '编辑', 'Edit') }] : []),
      ...(detail ? [{ key: 'M', label: t(lang, `互动图(${diagramCount})`, `Diagrams(${diagramCount})`) }] : []),
      ...(detail ? [{ key: 'D', label: t(lang, '删除', 'Delete') }] : []),
      { key: 'R', label: t(lang, '路线', 'Route') },
      { key: 'G', label: t(lang, '分组', 'Groups') },
      { key: 'L', label: t(lang, '自检', 'Lint') },
      { key: 'g', label: t(lang, '生成', 'Gen') },
      { key: 's', label: t(lang, '切换', 'Switch') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
      { key: 'x', label: t(lang, '导出MD', 'Export') },
    ],
    [lang, detail, selectedNode, diagramCount],
  );

  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const treeViewportH = Math.max(4, height - 4 - filterBarH);
  const treeScrollTop = useMemo(() => {
    if (selectedLineIdx < 0 || treeLines.length <= treeViewportH) return 0;
    const half = Math.floor(treeViewportH / 2);
    return Math.max(0, Math.min(selectedLineIdx - half, treeLines.length - treeViewportH));
  }, [selectedLineIdx, treeLines.length, treeViewportH]);

  const pageActive = useKeyScope({
    id: 'SkeletonView:main',
    active: isActive,
    keys: CLAIMED_KEYS,
    onKey: (input, key) => {
      const wheelDelta = parseSgrWheelDelta(input);
      if (wheelDelta !== 0) {
        moveTreeCursorByWheel(wheelDelta);
        return true;
      }
      if (key.escape && filterQuery) {
        setFilterQuery('');
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setFilterEditing(true);
        return true;
      }
      if (input === 'x' && !key.ctrl && !key.meta) {
        void exportSkeleton();
        return true;
      }
      if (key.tab) {
        setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return true;
      }
      if (input === 'L') {
        void runLint();
        return true;
      }
      if (input === 'R') {
        setRouteOpen(true);
        return true;
      }
      if (input === 'G') {
        setGroupsOpen(true);
        return true;
      }
      if (input === 'E' && detail && selectedNode) {
        setNodeEditOpen(true);
        return true;
      }
      if (input === 'M') {
        if (detail) {
          setDiagramsOpen(true);
        } else {
          useTuiStore
            .getState()
            .notify(
              t(lang, '请先生成或选择一个知识骨架，再管理互动图表', 'Generate or select a knowledge skeleton first'),
              'warning',
            );
        }
        return true;
      }
      if (input === 'D' && detail) {
        if (!busyRef.current && busyAction === null) {
          setConfirmDeleteOpen(true);
        }
        return true;
      }
      if (input === 'p') {
        void practiseNode();
        return true;
      }
      if (input === 'g') {
        requestGenerateSkeleton();
        return true;
      }
      if (input === 's' && skeletons.length > 0) {
        setSwitcherOpen(true);
        return true;
      }
      if (key.ctrl && input === 'r') {
        setReloadSeq((n) => n + 1);
        return true;
      }

      if (activePane !== 'left' || treeLines.length === 0) return false;

      if (key.downArrow || input === 'j') {
        const nextIdx = Math.min(treeLines.length - 1, Math.max(0, selectedLineIdx) + 1);
        setSelectedNodeId(treeLines[nextIdx]?.id ?? null);
        return true;
      }
      if (key.upArrow || input === 'k') {
        const prevIdx = Math.max(0, (selectedLineIdx < 0 ? 0 : selectedLineIdx) - 1);
        setSelectedNodeId(treeLines[prevIdx]?.id ?? null);
        return true;
      }
      if (input === ' ' || key.return) {
        const cur = treeLines[selectedLineIdx];
        if (cur?.hasChildren) toggleExpand(cur.id);
        else if (cur) setActivePane('right');
        return true;
      }
      if (input === 'l' || key.rightArrow) {
        const cur = treeLines[selectedLineIdx];
        if (cur?.hasChildren && !cur.expanded) toggleExpand(cur.id, true);
        else if (cur?.hasChildren && cur.expanded && treeLines[selectedLineIdx + 1]) {
          setSelectedNodeId(treeLines[selectedLineIdx + 1].id);
        } else {
          setActivePane('right');
        }
        return true;
      }
      if (input === 'h' || key.leftArrow) {
        const cur = treeLines[selectedLineIdx];
        if (cur?.hasChildren && cur.expanded) {
          toggleExpand(cur.id, false);
        } else if (cur) {
          const pid = parentById.get(cur.id);
          if (pid) setSelectedNodeId(pid);
        }
        return true;
      }
      if (input === 'e') {
        if (detail) {
          const allParents = detail.nodes.filter((n) => detail.nodes.some((c) => c.parent === n.id)).map((n) => n.id);
          setExpandedIds((prev) => (prev.size >= allParents.length ? new Set() : new Set(allParents)));
        }
        return true;
      }
      return false;
    },
  });
  useSgrMouseWheel(pageActive, moveTreeCursorByWheel);
  useFooterHints(hints, pageActive);

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
  const bodyH = Math.max(6, height - headerH - filterBarH);
  const ell = asciiMode ? '...' : '…';

  if (loading && !detail && skeletons.length === 0 && topics.length === 0) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Spinner
          label={asciiMode ? t(lang, '正在加载知识骨架...', 'Loading knowledge skeleton...') : t(lang, '正在加载知识骨架…', 'Loading knowledge skeleton…')}
          active={isActive}
        />
      </Box>
    );
  }

  const headerCompact = width < 105;
  const legendText = asciiMode
    ? t(lang, '*掌握  o学习  !薄弱  ^考纲重点', '*Mastered oLearning !Weak ^Focus')
    : t(lang, '★掌握  ◐学习  ✕薄弱  ⚑考纲重点', '★Mastered ◐Learning ✕Weak ⚑Focus');

  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${treeLines.length}/${baseTreeLines.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);
  const filterBarNode = showFilterBar ? (
    <KeyScope id="skeleton:filter" opaque active={isActive && filterEditing}>
      <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
        <Text color={filterEditing ? theme.primary : theme.accent} bold>
          {filterBadge}
        </Text>
        <Box flexGrow={1} overflow="hidden">
          <TextInput
            value={filterQuery}
            onChange={(val) => setFilterQuery(val)}
            onSubmit={(val) => {
              if (!val.trim()) setFilterQuery('');
              setFilterEditing(false);
            }}
            onCancel={() => {
              setFilterQuery('');
              setFilterEditing(false);
            }}
            isActive={isActive && filterEditing}
            width={filterInputW}
            prompt="/"
            placeholder={t(lang, `关键词${ell}`, `keyword${ell}`)}
            maxLength={120}
          />
        </Box>
        {filterRightHint ? (
          <Text color={theme.dim} wrap="truncate">
            {filterRightHint}
          </Text>
        ) : null}
      </Box>
    </KeyScope>
  ) : null;

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
              ell,
            )}
          </Text>
          {activeCourse ? (
            <Box flexShrink={0}>
              <Badge label={truncateDisplay(activeCourse, 18, ell)} tone="accent" variant="soft" />
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
          {busyAction ? (
            <Spinner
              label={
                busyAction === 'delete'
                  ? t(lang, '删除中...', 'Deleting...')
                  : busyAction === 'generate'
                    ? t(lang, '生成中...', 'Generating...')
                    : t(lang, '处理中...', 'Working...')
              }
              active={isActive}
            />
          ) : null}
        </Box>
        <Box height={1} overflow="hidden">
          <Text color={theme.muted}>{truncateDisplay(legendText, Math.max(12, width - 2), ell)}</Text>
        </Box>
      </Box>

      {filterBarNode}

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
                badge={normalizedFilter ? `${treeLines.length}/${baseTreeLines.length}` : detail ? detail.nodes.length : topics.length}
                focused={activePane === 'left'}
                width={size.width}
                height={size.height}
                paddingX={1}
              >
                {visible.length === 0 ? (
                  <Box width={innerW} height={innerH} alignItems="center" justifyContent="center">
                    <Text color={theme.muted}>
                      {truncateDisplay(
                        normalizedFilter
                          ? t(lang, '无匹配节点 (Esc 清除筛选)', 'No matching nodes (Esc to clear)')
                          : t(lang, '暂无节点', 'No nodes'),
                        innerW,
                        ell,
                      )}
                    </Text>
                  </Box>
                ) : (
                  visible.map((line) => {
                    const isSelected = line.id === effectiveSelectedNodeId;
                    const st = nodeStatsMap.get(line.id);
                    const fg = isSelected
                      ? theme.selectionFg
                      : st?.level === 'weak'
                        ? theme.error
                        : st?.level === 'mastered'
                          ? theme.success
                          : theme.text;
                    return (
                      <Box key={line.id} width={innerW} height={1} backgroundColor={isSelected ? theme.selectionBg : undefined}>
                        <Text color={fg} bold={isSelected}>
                          {truncateDisplay(line.text, innerW, ell)}
                        </Text>
                      </Box>
                    );
                  })
                )}
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
                  isActive={pageActive && activePane === 'right'}
                />
              </Panel>
            );
          }}
        />
      )}

      {switcherOpen ? (
        <KeyScope id="skeleton:switcher" opaque>
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
        </KeyScope>
      ) : null}

      {lintOpen ? (
        <KeyScope id="skeleton:lint" opaque>
          <LintModalHotkeys isActive={isActive && !lintLoading} onRerun={() => void runLint()} />
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
                <Text color={theme.error} wrap="wrap">{lintError}</Text>
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
        </KeyScope>
      ) : null}

      {routeOpen ? (
        <KeyScope id="skeleton:route" opaque>
          <Suspense fallback={null}>
            <CourseRouteModal
              host={host}
              activeCourse={activeCourse}
              isActive={isActive && routeOpen}
              onClose={() => setRouteOpen(false)}
            />
          </Suspense>
        </KeyScope>
      ) : null}
      {groupsOpen ? (
        <KeyScope id="skeleton:groups" opaque>
          <Suspense fallback={null}>
            <TopicGroupsModal
              host={host}
              activeCourse={activeCourse}
              isActive={isActive && groupsOpen}
              onClose={() => setGroupsOpen(false)}
              onSaved={() => setReloadSeq((n) => n + 1)}
            />
          </Suspense>
        </KeyScope>
      ) : null}
      {nodeEditOpen && detail && selectedNode ? (
        <KeyScope id="skeleton:node-edit" opaque>
          <Suspense fallback={null}>
            <NodeEditModal
              host={host}
              skeletonId={detail.id}
              node={selectedNode}
              isActive={isActive && nodeEditOpen}
              onClose={() => setNodeEditOpen(false)}
              onSaved={() => void refreshDetail()}
            />
          </Suspense>
        </KeyScope>
      ) : null}
      {diagramsOpen && detail ? (
        <KeyScope id="skeleton:diagrams" opaque>
          <Suspense fallback={null}>
            <SkeletonDiagramsModal
              host={host}
              skeletonId={detail.id}
              skeletonTitle={detail.title}
              isActive={isActive && diagramsOpen}
              onClose={() => setDiagramsOpen(false)}
              onCountChange={setDiagramCount}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {confirmGenOpen ? (
        <KeyScope id="skeleton:confirm-gen" opaque>
          <ConfirmDialog
            title={t(lang, '确认生成知识骨架', 'Confirm Skeleton Generation')}
            message={t(
              lang,
              `将为「${activeCourse || '全部课程'}」调用 AI 生成知识骨架（覆盖 ${topics.length} 个主题，共 ${topics.reduce((sum, tp) => sum + (tp.count || 0), 0)} 题，预计发起 1 次 AI 模型调用）。确认继续吗？`,
              `Generate knowledge skeleton for "${activeCourse || 'All Courses'}" (${topics.length} topics, ${topics.reduce((sum, tp) => sum + (tp.count || 0), 0)} cards; ~1 AI model call). Continue?`,
            )}
            confirmLabel={t(lang, '开始生成', 'Generate')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            isActive={isActive}
            onConfirm={() => {
              setConfirmGenOpen(false);
              void generateSkeleton();
            }}
            onCancel={() => setConfirmGenOpen(false)}
          />
        </KeyScope>
      ) : null}

      {confirmDeleteOpen && detail ? (
        <KeyScope id="skeleton:confirm-delete" opaque>
          <ConfirmDialog
            title={t(lang, '确认删除知识骨架', 'Delete Knowledge Skeleton')}
            message={t(
              lang,
              `确定永久删除当前知识骨架「${detail.title}」吗？关联的图表也会一并删除，题组与卡片本身不受影响。`,
              `Permanently delete skeleton "${detail.title}"? Associated diagrams will also be removed, while decks and cards remain untouched.`,
            )}
            confirmLabel={t(lang, '永久删除', 'Delete')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            danger
            width={Math.min(62, Math.max(40, width - 6))}
            isActive={isActive}
            onConfirm={() => {
              setConfirmDeleteOpen(false);
              void deleteSkeleton();
            }}
            onCancel={() => setConfirmDeleteOpen(false)}
          />
        </KeyScope>
      ) : null}
    </Box>
  );
};
