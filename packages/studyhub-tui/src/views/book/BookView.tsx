import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { KeyHint, StudySnapshot, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { saveTuiPreferences } from '../../host/tui-prefs.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { computeProseLayout } from '../../components/Layout.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SelectList, type SelectOption } from '../../components/SelectList.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { formatReadingTimeLabel } from '../../render/longform.js';
import type {
  BookNode,
  BookOpenResult,
  BookQaListResult,
  BookReadResult,
  BookTocResult,
  FlatTocItem,
} from './types.js';
const BookAiBlocksModal = lazy(() => import('./BookAiBlocksModal.js').then((m) => ({ default: m.BookAiBlocksModal })));
const BookCrunchModal = lazy(() => import('./BookCrunchModal.js').then((m) => ({ default: m.BookCrunchModal })));
const BookEditModal = lazy(() => import('./BookEditModal.js').then((m) => ({ default: m.BookEditModal })));
const BookExplainModal = lazy(() => import('./BookExplainModal.js').then((m) => ({ default: m.BookExplainModal })));
const BookExportModal = lazy(() => import('./BookExportModal.js').then((m) => ({ default: m.BookExportModal })));
const BookHistoryModal = lazy(() => import('./BookHistoryModal.js').then((m) => ({ default: m.BookHistoryModal })));
const BookQaModal = lazy(() => import('./BookQaModal.js').then((m) => ({ default: m.BookQaModal })));
const BookRetellModal = lazy(() => import('./BookRetellModal.js').then((m) => ({ default: m.BookRetellModal })));
const BookStructureModal = lazy(() => import('./BookStructureModal.js').then((m) => ({ default: m.BookStructureModal })));

const BASE_CLAIMED_KEYS = ['B', 'E', 'H', 'M', 'P', 'T', 'U', 'e', 'w', 'x', '[', ']', '/'] as const;
const REBUILD_CLAIMED_KEYS = ['B', 'E', 'H', 'M', 'P', 'T', 'U', 'e', 'w', 'x', '[', ']', 'a'] as const;
const STRUCTURE_FILE = 'book.structure';

function tocItemMatchesFilter(item: FlatTocItem, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const nodeFiles = item.node?.files;
  const tocFiles = item.tocRow?.files ? Object.keys(item.tocRow.files) : [];
  const rawId = item.key?.startsWith('bk:') ? item.key.slice(3) : '';
  const parts: string[] = [
    item.title,
    item.number,
    item.hid,
    item.key,
    nodeFiles?.gen ?? '',
    nodeFiles?.mine ?? '',
    nodeFiles?.qa ?? '',
    ...(rawId ? [`${rawId}.gen.md`, `${rawId}.mine.md`, `${rawId}.qa.md`] : []),
    ...tocFiles,
  ];
  return parts.join('\n').toLowerCase().includes(q);
}

interface BookMockPlanResult {
  status: string;
  course: string;
  points: string[];
  unknown?: string[];
  questions: number;
  eligible: number;
  leftOut?: Record<string, number>;
  count: number;
  capped?: boolean;
  limitMinutes?: number;
}

interface MockConfirmState {
  plan: BookMockPlanResult;
  title: string;
}

function collectLeafHids(item: FlatTocItem | undefined, allItems: FlatTocItem[]): string[] {
  if (!item) return [];
  if (item.node) {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (node: BookNode) => {
      if (node.leaf || !node.children?.length) {
        if (node.hid && !seen.has(node.hid)) {
          seen.add(node.hid);
          out.push(node.hid);
        }
        return;
      }
      for (const child of node.children) walk(child);
    };
    walk(item.node);
    return out;
  }
  if (item.leaf) return item.hid ? [item.hid] : [];
  const prefix = item.number ? `${item.number}.` : '';
  const descendants = prefix
    ? allItems.filter((it) => it.leaf && it.number.startsWith(prefix)).map((it) => it.hid).filter(Boolean)
    : [];
  return descendants.length > 0 ? descendants : item.hid ? [item.hid] : [];
}

interface BookNodeRetold {
  tries?: number;
  passes?: number;
  gap?: string;
  at?: string;
  count?: number;
  lastAt?: string;
  passed?: boolean;
}

type BookNodeWithRetell = BookNode & {
  retell?: { passed?: boolean; tries?: number; passes?: number; gap?: string; at?: string };
};

function getRetoldSummary(node: BookNode | undefined): {
  passed: boolean;
  tries: number;
  passes: number;
} {
  if (!node) return { passed: false, tries: 0, passes: 0 };
  const raw = (node.retold ?? (node as BookNodeWithRetell).retell) as BookNodeRetold | undefined;
  if (!raw) return { passed: false, tries: 0, passes: 0 };
  const passes = Number(raw.passes ?? (raw.passed === true ? 1 : 0)) || 0;
  const tries = Number(raw.tries ?? raw.count ?? passes) || 0;
  const passed = passes > 0 || raw.passed === true || (node as BookNodeWithRetell).retell?.passed === true;
  return { passed, tries, passes };
}

interface UnplacedSectionPreview {
  id: string;
  title: string;
  chars?: number;
  preview?: string;
}

function extractUnplacedPreviews(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const previews: string[] = [];
  let currentLines: string[] | null = null;
  let fence = '';
  let seenTopHeading = false;

  const flush = (buf: string[]) => {
    const snippet = buf
      .map((l) => l.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim())
      .find((l) => l.length > 0 && !l.startsWith('[^'));
    previews.push(snippet ?? '');
  };

  for (const line of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = '';
    }
    if (!fence && /^#{1,3}\s+/.test(line)) {
      if (currentLines) flush(currentLines);
      else if (seenTopHeading === false && previews.length === 0) {
        // Check if there was unheaded text before first heading
      }
      seenTopHeading = true;
      currentLines = [];
      continue;
    }
    if (currentLines) {
      currentLines.push(line);
    } else if (!seenTopHeading && line.trim()) {
      currentLines = [line];
    }
  }
  if (currentLines) flush(currentLines);
  return previews;
}

function extractUnplacedSections(book: BookOpenResult | null): UnplacedSectionPreview[] {
  const rawSections = book?.unplaced?.sections;
  if (!Array.isArray(rawSections) || rawSections.length === 0) return [];
  const previews = extractUnplacedPreviews(book?.unplaced?.text);
  const aligned = previews.length === rawSections.length;
  return rawSections.map((sec, idx) => ({
    id: sec.id,
    title: sec.title,
    chars: sec.chars,
    ...(aligned && previews[idx] ? { preview: previews[idx] } : {}),
  }));
}

interface BookOpenWithStructure extends BookOpenResult {
  structureVersion?: number;
  book?: { structureVersion?: number };
}

interface BookStructureOpResult {
  course?: string | null;
  write?: string;
  hid?: string;
  structureVersion?: number;
  revision?: number;
  kept?: string[];
  emptied?: { hid: string; title: string };
  removed?: { points?: number; sections?: number; files?: number; toUnplaced?: number };
  note?: string;
}

function extractStructureVersion(res: unknown): number {
  if (!res || typeof res !== 'object') return 1;
  const obj = res as BookOpenWithStructure;
  const v = obj.structureVersion ?? obj.book?.structureVersion;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
}

function findNodeSiblings(
  nodes: BookNode[] | undefined,
  hid: string,
): { siblings: Array<{ hid: string; title: string }>; index: number } | null {
  if (!nodes?.length) return null;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].hid === hid) {
      return { siblings: nodes, index: i };
    }
    const found = findNodeSiblings(nodes[i].children, hid);
    if (found) return found;
  }
  return null;
}

function findFlatSiblings(
  items: FlatTocItem[],
  item: FlatTocItem,
): { siblings: Array<{ hid: string; title: string }>; index: number } | null {
  const parentPrefix = item.number.includes('.') ? item.number.slice(0, item.number.lastIndexOf('.')) : '';
  const siblings = items.filter((it) => {
    if (it.depth !== item.depth) return false;
    const prefix = it.number.includes('.') ? it.number.slice(0, it.number.lastIndexOf('.')) : '';
    return prefix === parentPrefix;
  });
  const index = siblings.findIndex((it) => it.hid === item.hid);
  return index >= 0 ? { siblings, index } : null;
}

function flattenBookNodes(nodes: BookNode[] | undefined, out: FlatTocItem[] = []): FlatTocItem[] {
  for (const node of nodes ?? []) {
    out.push({
      hid: node.hid,
      key: node.key,
      number: node.number,
      title: node.title,
      depth: node.depth,
      leaf: Boolean(node.leaf),
      questionTotal: Number(node.questionTotal ?? node.questions?.length ?? 0) || 0,
      unbuilt: Boolean(node.unbuilt),
      short: Boolean(node.short),
      hasQa: Boolean(node.qa && node.qa.trim()),
      hasMine: Boolean(node.mine && node.mine.trim()),
      retoldCount: getRetoldSummary(node).tries,
      node,
    });
    if (node.children?.length) flattenBookNodes(node.children, out);
  }
  return out;
}

function flattenTocRows(toc: BookTocResult | null): FlatTocItem[] {
  if (!toc?.toc?.length) return [];
  return toc.toc.map((row) => {
    const depth = Math.max(1, row.n.split('.').length);
    const leaf = !row.chapter && Boolean(row.files && Object.keys(row.files).length > 0);
    return {
      hid: row.hid,
      key: row.hid,
      number: row.n,
      title: row.title,
      depth,
      leaf,
      questionTotal: 0,
      unbuilt: false,
      short: Boolean(row.short),
      hasQa: Boolean(row.files?.qa),
      hasMine: Boolean(row.files?.mine),
      retoldCount: 0,
      tocRow: row,
    };
  });
}

function extractPendingOutlineId(book: BookOpenResult | null | undefined): string | undefined {
  if (!book) return undefined;
  const extra = book as BookOpenResult & { outlineId?: unknown; rebuildPending?: { outlineId?: unknown } };
  const raw = book.moves?.outlineId ?? extra.rebuildPending?.outlineId ?? extra.outlineId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function collectNodeQuestions(node: BookNode | undefined): Array<{ deckId: string; cardId: string }> {
  if (!node) return [];
  const seen = new Set<string>();
  const out: Array<{ deckId: string; cardId: string }> = [];
  const walk = (cur: BookNode) => {
    for (const q of cur.questions ?? []) {
      const k = `${q.deckId}\0${q.cardId}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ deckId: q.deckId, cardId: q.cardId });
      }
    }
    for (const child of cur.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

function buildSectionMarkdown(
  item: FlatTocItem | undefined,
  readResult: BookReadResult | null,
  qaList: BookQaListResult | null,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): string {
  if (!item) return '';
  const parts: string[] = [];
  const node = item.node;

  if (node) {
    parts.push(`# ${node.number} ${node.title}`);
    const statusTags: string[] = [];
    if (node.leaf) {
      statusTags.push(t(lang, `关联题目: ${node.questionTotal ?? 0}`, `Linked questions: ${node.questionTotal ?? 0}`));
      const retold = getRetoldSummary(node);
      if (retold.passed) {
        statusTags.push(
          t(
            lang,
            `${asciiMode ? '+' : '✓'} 讲清楚过 (${retold.passes}/${retold.tries})`,
            `${asciiMode ? '+' : '✓'} Retold (${retold.passes}/${retold.tries})`,
          ),
        );
      } else if (retold.tries > 0) {
        statusTags.push(t(lang, `已复述 ${retold.tries} 次`, `Retold ${retold.tries}x`));
      }
      if (node.short) statusTags.push(t(lang, '内容较精简', 'Short summary'));
      if (node.unbuilt) statusTags.push(t(lang, '本节尚未生成讲义', 'Section not generated yet'));
    } else {
      statusTags.push(t(lang, `章节 · ${node.children?.length ?? 0} 个子节`, `Section · ${node.children?.length ?? 0} sub-items`));
    }
    if (statusTags.length) parts.push(`> ${statusTags.join('  ·  ')}`);

    if (node.gen && node.gen.trim()) {
      parts.push(node.gen.trim());
    } else if (!node.leaf && node.children?.length) {
      parts.push(`## ${t(lang, '下级知识点目录', 'Sub-sections')}`);
      for (const child of node.children) {
        const qInfo = child.questionTotal ? ` (${child.questionTotal}${t(lang, '题', 'Q')})` : '';
        parts.push(`- **${child.number} ${child.title}**${qInfo}`);
      }
    } else if (readResult?.files?.gen?.text) {
      parts.push(readResult.files.gen.text.trim());
    } else {
      parts.push(t(lang, '_该节暂无讲义正文，可按 `[g]` 生成或更新复习全书。_', '_No study note body yet. Press `[g]` to build or update the review book._'));
    }

    if (node.mine && node.mine.trim()) {
      parts.push(`---\n\n## ${t(lang, '我的笔记', 'My Notes')}\n\n${node.mine.trim()}`);
    } else if (readResult?.files?.mine?.text) {
      parts.push(`---\n\n## ${t(lang, '我的笔记', 'My Notes')}\n\n${readResult.files.mine.text.trim()}`);
    }

    const qaText = node.qa?.trim() || readResult?.files?.qa?.text?.trim() || '';
    if (qaText) {
      parts.push(`---\n\n## ${t(lang, '本节内联问答笔记 (Q&A)', 'Inline Q&A Notes')}\n\n${qaText}`);
    }

    if (node.questions?.length) {
      parts.push(`---\n\n## ${t(lang, '本节练习题预览', 'Section Questions')}`);
      for (const q of node.questions.slice(0, 5)) {
        const cleanPrompt = String(q.prompt ?? '').replace(/\s+/g, ' ').trim();
        parts.push(`- ${cleanPrompt}`);
      }
      if ((node.questionTotal ?? 0) > node.questions.length) {
        parts.push(t(lang, `\n_共 ${node.questionTotal} 道题 — 按 \`[p]\` 立即练习 5 道_`, `\n_${node.questionTotal} questions total — press \`[p]\` to practise 5_`));
      }
    }
  } else if (readResult) {
    parts.push(`# ${item.number} ${item.title}`);
    if (readResult.path?.length) parts.push(`> ${readResult.path.join(' / ')}`);
    if (readResult.files?.gen?.text) parts.push(readResult.files.gen.text.trim());
    if (readResult.files?.mine?.text) parts.push(`---\n\n## ${t(lang, '我的笔记', 'My Notes')}\n\n${readResult.files.mine.text.trim()}`);
    if (readResult.files?.qa?.text) parts.push(`---\n\n## ${t(lang, '本节内联问答笔记 (Q&A)', 'Inline Q&A Notes')}\n\n${readResult.files.qa.text.trim()}`);
    if (readResult.materials?.length) {
      parts.push(`---\n\n## ${t(lang, '来源资料页码', 'Source Pages')}`);
      for (const m of readResult.materials) {
        parts.push(`- ${m.title}: ${m.pages || '-'}`);
      }
    }
  }

  if (qaList && ((qaList.followupIds?.length ?? 0) > 0 || (qaList.answerCardIds?.length ?? 0) > 0)) {
    const fCount = qaList.followupIds?.length ?? 0;
    const aCount = qaList.answerCardIds?.length ?? 0;
    parts.push(`\n> ${t(lang, `全书已收录 ${fCount} 条追问笔记 · ${aCount} 张答题卡`, `Book Q&A archive: ${fCount} follow-ups · ${aCount} answer cards`)}`);
  }

  return parts.join('\n\n');
}

export const BookView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const snapshotCourse = useTuiStore((s) => (typeof s.snapshot?.focus?.course === 'string' ? s.snapshot.focus.course : null));
  const navCourse = useTuiStore((s) => s.navContext.course);
  const activeCourse = navCourse ?? snapshotCourse;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookData, setBookData] = useState<BookOpenResult | null>(null);
  const [tocData, setTocData] = useState<BookTocResult | null>(null);
  const [qaList, setQaList] = useState<BookQaListResult | null>(null);
  const [readCache, setReadCache] = useState<Record<string, BookReadResult>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [aiBlocksOpen, setAiBlocksOpen] = useState(false);
  const [buildModalOpen, setBuildModalOpen] = useState(false);
  const [crunchModalOpen, setCrunchModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [qaModalOpen, setQaModalOpen] = useState(false);
  const [retellModalOpen, setRetellModalOpen] = useState(false);
  const [structureModalOpen, setStructureModalOpen] = useState(false);
  const [structureModalMode, setStructureModalMode] = useState<'rename' | 'place'>('rename');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmRevertOpen, setConfirmRevertOpen] = useState(false);
  const [confirmUndoRebuildOpen, setConfirmUndoRebuildOpen] = useState(false);
  const [mockConfirmPlan, setMockConfirmPlan] = useState<MockConfirmState | null>(null);
  const [structureVersion, setStructureVersion] = useState<number>(1);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const pendingFocusHidRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load book + qa list
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const courseArgs = activeCourse ? { course: activeCourse } : {};

    (async () => {
      try {
        const [openRes, qaRes] = await Promise.all([
          host.call<BookOpenResult>('course.book.open', { ...courseArgs, language: lang }),
          host.call<BookQaListResult>('book.qa.list', courseArgs),
        ]);
        if (cancelled || !mountedRef.current) return;

        if (qaRes.ok && qaRes.value) setQaList(qaRes.value);

        if (openRes.ok && openRes.value) {
          setBookData(openRes.value);
          setStructureVersion(extractStructureVersion(openRes.value));
          if (openRes.value.status === 'ok' && (!openRes.value.nodes || openRes.value.nodes.length === 0)) {
            const tocRes = await host.call<BookTocResult>('book.toc', { ...courseArgs, compact: false });
            if (!cancelled && mountedRef.current && tocRes.ok && tocRes.value) {
              setTocData(tocRes.value);
              setStructureVersion(extractStructureVersion(tocRes.value));
            }
          } else {
            setTocData(null);
          }
        } else {
          const tocRes = await host.call<BookTocResult>('book.toc', { ...courseArgs, compact: false });
          if (cancelled || !mountedRef.current) return;
          if (tocRes.ok && tocRes.value) {
            setTocData(tocRes.value);
            setBookData(null);
            setStructureVersion(extractStructureVersion(tocRes.value));
          } else {
            setError(openRes.error?.message || tocRes.error?.message || t(lang, '加载复习全书失败', 'Failed to load review book'));
          }
        }
      } catch (err) {
        if (!cancelled && mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host, activeCourse, lang, reloadSeq]);

  useEffect(() => {
    setFilterQuery('');
    setFilterEditing(false);
    setSelectedIndex(0);
  }, [activeCourse]);

  const items: FlatTocItem[] = useMemo(() => {
    if (bookData?.status === 'ok' && bookData.nodes?.length) return flattenBookNodes(bookData.nodes);
    return flattenTocRows(tocData);
  }, [bookData, tocData]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const visibleItems: FlatTocItem[] = useMemo(() => {
    if (!normalizedFilter) return items;
    return items.filter((it) => tocItemMatchesFilter(it, normalizedFilter));
  }, [items, normalizedFilter]);

  const unplacedSections = useMemo(() => extractUnplacedSections(bookData), [bookData]);

  const leafPoints = useMemo(
    () =>
      items
        .filter((it) => it.leaf)
        .map((it) => ({ hid: it.hid, title: it.title, number: it.number, depth: it.depth })),
    [items],
  );

  useEffect(() => {
    const targetHid = pendingFocusHidRef.current;
    if (targetHid && visibleItems.length > 0) {
      const idx = visibleItems.findIndex((it) => it.hid === targetHid);
      pendingFocusHidRef.current = null;
      if (idx >= 0) {
        setSelectedIndex(idx);
        return;
      }
    }
    if (visibleItems.length > 0 && selectedIndex >= visibleItems.length) {
      setSelectedIndex(visibleItems.length - 1);
    } else if (visibleItems.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }, [visibleItems, selectedIndex]);

  const clampedSelectedIndex = visibleItems.length > 0 ? Math.max(0, Math.min(selectedIndex, visibleItems.length - 1)) : 0;
  const selectedItem = visibleItems[clampedSelectedIndex];
  const effectiveCourse = bookData?.course ?? tocData?.course ?? activeCourse ?? undefined;

  // Lazy-fetch book.read when selected node lacks inline text (e.g., toc fallback or chapter/leaf read)
  useEffect(() => {
    if (!selectedItem || !selectedItem.hid) return;
    if (selectedItem.node && (selectedItem.node.gen || !selectedItem.leaf)) return;
    const cacheKey = `${effectiveCourse ?? ''}:${selectedItem.hid}`;
    if (readCache[cacheKey]) return;

    let cancelled = false;
    (async () => {
      const res = await host.call<BookReadResult>('book.read', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        hid: selectedItem.hid,
      });
      if (!cancelled && mountedRef.current && res.ok && res.value?.status === 'ok') {
        setReadCache((prev) => ({ ...prev, [cacheKey]: res.value! }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, selectedItem, effectiveCourse, readCache]);

  const selectedRead = selectedItem ? readCache[`${effectiveCourse ?? ''}:${selectedItem.hid}`] ?? null : null;
  const selectedRetold = useMemo(() => getRetoldSummary(selectedItem?.node), [selectedItem?.node]);

  const markdown = useMemo(
    () => buildSectionMarkdown(selectedItem, selectedRead, qaList, lang, asciiMode),
    [selectedItem, selectedRead, qaList, lang, asciiMode],
  );

  const toggleMath = useCallback(() => {
    const next = !useTuiStore.getState().preferences.mathUnicode;
    useTuiStore.getState().setPreferences({ mathUnicode: next });
    const dshHome = (host as { dshHome?: string }).dshHome;
    void saveTuiPreferences({ mathUnicode: next }, dshHome ? { env: { DSH_HOME: dshHome } } : undefined).catch(() => {});
    useTuiStore.getState().notify(
      next ? t(lang, '已开启 Unicode 数学公式渲染', 'Unicode math rendering ON') : t(lang, '已切换为原始 LaTeX 公式', 'Raw LaTeX math mode'),
      'info',
    );
  }, [host, lang]);

  const practiseSection = useCallback(async () => {
    if (!selectedItem || busyAction) return;
    const course = effectiveCourse;
    setBusyAction('practice');
    try {
      let scope: Array<{ deckId: string; cardId: string }> = [];
      if (selectedItem.key && selectedItem.key.startsWith('bk:')) {
        const outlineRes = await host.call<{ practice?: { scope?: Array<{ deckId: string; cardId: string }> } }>('course.outline', {
          ...(course ? { course } : {}),
          pick: { keys: [selectedItem.key] },
        });
        if (outlineRes.ok && outlineRes.value?.practice?.scope?.length) {
          scope = outlineRes.value.practice.scope.slice(0, 5);
        }
      }
      if (!scope.length && selectedItem.node) {
        scope = collectNodeQuestions(selectedItem.node).slice(0, 5);
      }
      if (!scope.length) {
        useTuiStore.getState().notify(t(lang, '这一节还没有关联练习题，请先生成题组。', 'No questions linked to this section yet.'), 'warning');
        return;
      }
      const startRes = await host.call<{ id?: string }>('review.start', {
        mode: 'path',
        scope,
        fresh: true,
      });
      if (!startRes.ok || !startRes.value?.id) {
        useTuiStore.getState().notify(startRes.error?.message || t(lang, '无法开始练习', 'Failed to start practice'), 'error');
        return;
      }
      useTuiStore.getState().navigate('review', { runId: startRes.value.id, ...(course ? { course } : {}) });
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [selectedItem, busyAction, effectiveCourse, host, lang]);

  const resolvePendingOutlineId = useCallback(
    async (course: string): Promise<string | undefined> => {
      let outlineId = extractPendingOutlineId(bookData);
      if (!outlineId) {
        const openRes = await host.call<BookOpenResult>('course.book.open', { course, language: lang });
        if (openRes.ok && openRes.value) {
          if (mountedRef.current) {
            setBookData(openRes.value);
            setStructureVersion(extractStructureVersion(openRes.value));
          }
          outlineId = extractPendingOutlineId(openRes.value);
        }
      }
      if (!outlineId) {
        const outlineRes = await host.call<{ book?: { id?: string; outlineId?: string } | null }>('course.outline', { course });
        if (outlineRes.ok && outlineRes.value?.book) {
          const candidate = outlineRes.value.book.outlineId ?? outlineRes.value.book.id;
          if (typeof candidate === 'string' && candidate.trim()) outlineId = candidate.trim();
        }
      }
      return outlineId;
    },
    [bookData, host, lang],
  );

  const runBuild = useCallback(
    async (kind: 'outline' | 'book' | 'point' | 'apply-rebuild') => {
      setBuildModalOpen(false);
      if (busyRef.current || busyAction) return;
      const course = effectiveCourse;
      if (!course) {
        useTuiStore.getState().notify(t(lang, '请先按 [c] 选择一门课程', 'Please pick a course first with [c]'), 'warning');
        return;
      }
      busyRef.current = true;
      setBusyAction('build');
      try {
        if (kind === 'apply-rebuild') {
          const outlineId = await resolvePendingOutlineId(course);
          if (!outlineId) {
            useTuiStore.getState().notify(
              t(lang, '未能获取待应用总纲的 outlineId，请按 [Ctrl+R] 刷新后重试', 'Missing pending outlineId; press [Ctrl+R] to refresh and try again'),
              'error',
            );
            return;
          }
          const res = await host.call('course.book.rebuild', { course, action: 'apply', outlineId });
          if (res.ok) {
            useTuiStore.getState().notify(t(lang, '已应用新总纲结构', 'Applied rebuilt outline to book'), 'success');
            setReadCache({});
            setReloadSeq((n) => n + 1);
          } else {
            useTuiStore.getState().notify(res.error?.message || t(lang, '应用失败', 'Apply failed'), 'error');
          }
          return;
        }
        if (kind === 'outline') {
          const res = await host.call<{ jobId?: string; alreadyRunning?: boolean }>('courseOutline.build', { course, language: lang });
          if (res.ok) {
            useTuiStore.getState().notify(
              res.value?.alreadyRunning
                ? t(lang, '课程总纲任务已在后台运行', 'Outline build is already running')
                : t(lang, '已启动课程总纲构建任务', 'Started course outline build'),
              'success',
            );
          } else {
            useTuiStore.getState().notify(res.error?.message || t(lang, '启动总纲构建失败', 'Outline build failed'), 'error');
          }
          return;
        }
        const pointId = kind === 'point' && selectedItem?.key?.startsWith('bk:') ? selectedItem.key.replace(/^bk:/, '') : undefined;
        const res = await host.call<{ jobId?: string; alreadyRunning?: boolean }>('courseBook.build', {
          course,
          language: lang,
          coverage: 'standard',
          ...(pointId ? { point: pointId } : {}),
        });
        if (res.ok) {
          useTuiStore.getState().notify(
            res.value?.alreadyRunning
              ? t(lang, '复习全书构建任务已在运行中', 'Review book build already running')
              : t(lang, pointId ? '已启动本节讲义生成任务' : '已启动复习全书构建任务', pointId ? 'Started section book build' : 'Started review book build'),
            'success',
          );
        } else {
          useTuiStore.getState().notify(res.error?.message || t(lang, '启动复习全书构建失败', 'Book build failed'), 'error');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyAction(null);
      }
    },
    [busyAction, effectiveCourse, host, lang, resolvePendingOutlineId, selectedItem],
  );

  const undoPendingRebuild = useCallback(async () => {
    setConfirmUndoRebuildOpen(false);
    if (busyRef.current || busyAction) return;
    const course = effectiveCourse;
    if (!course) {
      useTuiStore.getState().notify(t(lang, '请先按 [c] 选择一门课程', 'Please pick a course first with [c]'), 'warning');
      return;
    }
    busyRef.current = true;
    setBusyAction('rebuild-undo');
    try {
      const outlineId = await resolvePendingOutlineId(course);
      if (!outlineId) {
        useTuiStore.getState().notify(
          t(lang, '未能获取待撤销总纲的 outlineId，请按 [Ctrl+R] 刷新后重试', 'Missing pending outlineId; press [Ctrl+R] to refresh and try again'),
          'error',
        );
        return;
      }
      const res = await host.call('course.book.rebuild', { course, action: 'undo', outlineId });
      if (res.ok) {
        useTuiStore.getState().notify(t(lang, '已撤销本次总纲重组', 'Undid outline rebuild'), 'success');
        setReadCache({});
        setReloadSeq((n) => n + 1);
      } else {
        useTuiStore.getState().notify(res.error?.message || t(lang, '撤销总纲重组失败', 'Failed to undo rebuild'), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, effectiveCourse, host, lang, resolvePendingOutlineId]);

  const moveSelectedNode = useCallback(
    async (direction: 'up' | 'down') => {
      if (busyRef.current || busyAction) return;
      if (!selectedItem || (bookData?.status ?? tocData?.status) !== 'ok') {
        useTuiStore.getState().notify(t(lang, '请先选择一个目录节点', 'Select a TOC node first'), 'warning');
        return;
      }
      const loc = findNodeSiblings(bookData?.nodes, selectedItem.hid) ?? findFlatSiblings(items, selectedItem);
      if (!loc) {
        useTuiStore.getState().notify(t(lang, '未找到该节点在目录中的位置', 'Could not locate selected node in TOC'), 'warning');
        return;
      }
      if (direction === 'up' && loc.index <= 0) {
        useTuiStore.getState().notify(t(lang, '已经是同级第一个节点', 'Already the first item at this level'), 'info');
        return;
      }
      if (direction === 'down' && loc.index >= loc.siblings.length - 1) {
        useTuiStore.getState().notify(t(lang, '已经是同级最后一个节点', 'Already the last item at this level'), 'info');
        return;
      }
      const neighbor = loc.siblings[direction === 'up' ? loc.index - 1 : loc.index + 1];
      busyRef.current = true;
      setBusyAction('move');
      try {
        const res = await host.call<BookStructureOpResult>('course.book.move', {
          ...(effectiveCourse ? { course: effectiveCourse } : {}),
          hid: selectedItem.hid,
          ...(direction === 'up' ? { beforeHid: neighbor.hid } : { afterHid: neighbor.hid }),
          version: structureVersion,
        });
        if (!mountedRef.current) return;
        if (res.ok) {
          if (typeof res.value?.structureVersion === 'number') setStructureVersion(res.value.structureVersion);
          pendingFocusHidRef.current = selectedItem.hid;
          useTuiStore.getState().notify(
            direction === 'up'
              ? t(lang, `已上移「${selectedItem.title}」`, `Moved "${selectedItem.title}" up`)
              : t(lang, `已下移「${selectedItem.title}」`, `Moved "${selectedItem.title}" down`),
            'success',
          );
          setReadCache({});
          setReloadSeq((n) => n + 1);
        } else if (res.error?.code === 'course-book-conflict') {
          useTuiStore.getState().notify(
            res.error.message || t(lang, '目录版本已变更，已刷新最新目录', 'Book structure changed; refreshing TOC'),
            'warning',
          );
          pendingFocusHidRef.current = selectedItem.hid;
          setReadCache({});
          setReloadSeq((n) => n + 1);
        } else {
          useTuiStore.getState().notify(res.error?.message || t(lang, '移动节点失败', 'Failed to move node'), 'error');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyAction(null);
      }
    },
    [bookData?.nodes, bookData?.status, busyAction, effectiveCourse, host, items, lang, selectedItem, structureVersion, tocData?.status],
  );

  const deleteSelectedNode = useCallback(async () => {
    setConfirmDeleteOpen(false);
    if (busyRef.current || busyAction || !selectedItem) return;
    busyRef.current = true;
    setBusyAction('delete');
    try {
      const res = await host.call<BookStructureOpResult>('course.book.delete', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        hid: selectedItem.hid,
        children: 'promote',
        version: structureVersion,
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        if (typeof res.value?.structureVersion === 'number') setStructureVersion(res.value.structureVersion);
        const parked = Number(res.value?.removed?.toUnplaced ?? 0) > 0;
        useTuiStore.getState().notify(
          parked
            ? t(lang, `已删除「${selectedItem.title}」，原有笔记已保留在「未归位」`, `Deleted "${selectedItem.title}"; learner notes kept in Unplaced`)
            : t(lang, `已删除「${selectedItem.title}」`, `Deleted "${selectedItem.title}"`),
          'success',
        );
        setReadCache({});
        setReloadSeq((n) => n + 1);
      } else if (res.error?.code === 'course-book-conflict') {
        useTuiStore.getState().notify(
          res.error.message || t(lang, '目录版本已变更，已刷新最新目录', 'Book structure changed; refreshing TOC'),
          'warning',
        );
        setReadCache({});
        setReloadSeq((n) => n + 1);
      } else {
        useTuiStore.getState().notify(res.error?.message || t(lang, '删除节点失败', 'Failed to delete node'), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, effectiveCourse, host, lang, selectedItem, structureVersion]);

  const revertStructure = useCallback(async () => {
    setConfirmRevertOpen(false);
    if (busyRef.current || busyAction) return;
    busyRef.current = true;
    setBusyAction('revert');
    try {
      const res = await host.call<BookStructureOpResult>('course.book.revert', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        file: STRUCTURE_FILE,
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        if (typeof res.value?.structureVersion === 'number') setStructureVersion(res.value.structureVersion);
        if (res.value?.kept?.length) {
          useTuiStore.getState().notify(
            t(
              lang,
              `已撤销目录改动（后续已编辑文件保持不变: ${res.value.kept.join(', ')}）`,
              `Reverted structure (kept newer edits in: ${res.value.kept.join(', ')})`,
            ),
            'warning',
          );
        } else {
          useTuiStore.getState().notify(t(lang, '已撤销最近一次目录结构调整', 'Reverted last structure change'), 'success');
        }
        setReadCache({});
        setReloadSeq((n) => n + 1);
      } else {
        const tone = res.error?.code === 'course-book-no-version' ? 'info' : 'error';
        useTuiStore.getState().notify(res.error?.message || t(lang, '没有可撤销的目录调整', 'No structure edit to revert'), tone);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, effectiveCourse, host, lang]);

  const buildOptions: SelectOption<'outline' | 'book' | 'point' | 'apply-rebuild'>[] = useMemo(() => {
    const opts: SelectOption<'outline' | 'book' | 'point' | 'apply-rebuild'>[] = [];
    if (bookData?.status === 'rebuild-pending') {
      opts.push({
        value: 'apply-rebuild',
        label: t(lang, '应用待处理的总纲重组', 'Apply pending outline rebuild'),
        hint: t(lang, '保留已有笔记并按新总纲归位', 'Keep notes and map to rebuilt outline'),
        badge: 'Rebuild',
        badgeTone: 'warning',
      });
    }
    if (selectedItem?.leaf && selectedItem.key.startsWith('bk:')) {
      opts.push({
        value: 'point',
        label: t(lang, `生成/重写本节：${selectedItem.title}`, `Build current point: ${selectedItem.title}`),
        hint: 'courseBook.build (point)',
        badge: t(lang, '单节', 'Point'),
        badgeTone: 'primary',
      });
    }
    opts.push(
      {
        value: 'book',
        label: t(lang, '生成 / 更新整本复习全书', 'Build / rebuild full review book'),
        hint: 'courseBook.build',
        badge: 'AI',
        badgeTone: 'ai',
      },
      {
        value: 'outline',
        label: t(lang, '生成 / 重建课程总纲', 'Build / rebuild course outline'),
        hint: 'courseOutline.build',
        badge: 'Outline',
        badgeTone: 'accent',
      },
    );
    return opts;
  }, [bookData?.status, lang, selectedItem]);

  const status = bookData?.status ?? tocData?.status ?? 'empty';
  const reason = bookData?.reason ?? tocData?.reason ?? '';
  const bookTitle = bookData?.title ?? tocData?.title ?? t(lang, '复习全书', 'Review Book');

  const modalOpen =
    aiBlocksOpen ||
    buildModalOpen ||
    crunchModalOpen ||
    editModalOpen ||
    explainOpen ||
    exportModalOpen ||
    historyOpen ||
    qaModalOpen ||
    retellModalOpen ||
    structureModalOpen ||
    confirmDeleteOpen ||
    confirmRevertOpen ||
    confirmUndoRebuildOpen ||
    Boolean(mockConfirmPlan);
  useClaimKeys(
    status === 'rebuild-pending' ? REBUILD_CLAIMED_KEYS : BASE_CLAIMED_KEYS,
    isActive && !modalOpen && !filterEditing,
  );
  useInputCapture(isActive && !modalOpen && filterEditing);

  const planMockExam = useCallback(async () => {
    if (busyRef.current || busyAction) return;
    if (status !== 'ok' || !selectedItem) {
      useTuiStore.getState().notify(
        t(lang, '请先打开复习全书并选择一个章节或知识点', 'Open a review book and select a chapter or point first'),
        'warning',
      );
      return;
    }
    const pointIds = collectLeafHids(selectedItem, items);
    if (pointIds.length === 0) {
      useTuiStore.getState().notify(
        t(
          lang,
          '模拟考试仅支持选择题，当前所选章节暂无可用知识点或选择题。',
          'Mock exams require choice questions; no eligible choice questions found for this selection.',
        ),
        'info',
      );
      return;
    }
    busyRef.current = true;
    setBusyAction('mock-plan');
    try {
      const res = await host.call<BookMockPlanResult>('book.mock.plan', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        pointIds,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        const code = res.error?.code;
        if (code === 'book-mock-empty' || code === 'book-mock-points') {
          useTuiStore.getState().notify(
            t(
              lang,
              '模拟考试仅支持单选与多选题，当前所选章节暂无可用选择题。',
              'Mock exams require single or multiple choice questions; none found for this selection.',
            ),
            'info',
          );
        } else {
          useTuiStore.getState().notify(res.error?.message || t(lang, '规划模拟卷失败', 'Failed to plan mock paper'), 'error');
        }
        return;
      }
      const plan = res.value;
      const skipped = Object.values(plan.leftOut ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
      if (!plan.eligible || plan.eligible <= 0 || !plan.count || plan.count <= 0) {
        useTuiStore.getState().notify(
          t(
            lang,
            `模拟卷仅考选择题：「${selectedItem.title}」暂无可用单/多选题${skipped > 0 ? `（跳过 ${skipped} 题）` : ''}`,
            `Mock exam needs choice Qs: none in "${selectedItem.title}"${skipped > 0 ? ` (${skipped} skipped)` : ''}`,
          ),
          'info',
        );
        return;
      }
      setMockConfirmPlan({
        plan,
        title: `${selectedItem.number} ${selectedItem.title}`.trim(),
      });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, effectiveCourse, host, items, lang, selectedItem, status]);

  const confirmMockStart = useCallback(async () => {
    const target = mockConfirmPlan;
    setMockConfirmPlan(null);
    if (!target || busyRef.current || busyAction) return;
    busyRef.current = true;
    setBusyAction('mock-start');
    try {
      const res = await host.call<{ id?: string }>('book.mock', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        pointIds: target.plan.points,
        count: target.plan.count,
        ...(target.plan.limitMinutes !== undefined ? { limitMinutes: target.plan.limitMinutes } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value?.id) {
        useTuiStore.getState().notify(res.error?.message || t(lang, '启动模拟考试失败', 'Failed to start mock exam'), 'error');
        return;
      }
      const runId = res.value.id;
      const store = useTuiStore.getState();
      store.setActiveRunId(runId);
      const snapRes = await host.call<StudySnapshot>('snapshot');
      if (mountedRef.current && snapRes.ok && snapRes.value && typeof snapRes.value === 'object') {
        store.setSnapshot(snapRes.value);
      }
      store.notify(
        t(lang, `已创建模拟卷（${target.plan.count} 题），正在进入模拟考试`, `Mock paper created (${target.plan.count} Qs) — opening Exam`),
        'success',
      );
      store.navigate('exam', {
        runId,
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
      });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, effectiveCourse, host, lang, mockConfirmPlan]);

  const hints: KeyHint[] = useMemo(
    () =>
      status === 'rebuild-pending'
        ? [
            { key: 'a', label: t(lang, '应用重建', 'Apply') },
            { key: 'u', label: t(lang, '撤销重组', 'Undo rebuild') },
            { key: 'g', label: t(lang, '构建选项', 'Build') },
            { key: 'P', label: t(lang, '精选问答', 'Pinned QA') },
            { key: 'Ctrl+R', label: t(lang, '刷新', 'Refresh') },
          ]
        : [
            { key: 'Tab', label: t(lang, '切换窗格', 'Pane') },
            { key: 'm', label: mathUnicode ? t(lang, '数学:Unicode', 'Math:Unicode') : t(lang, '数学:LaTeX', 'Math:LaTeX') },
            { key: 'T', label: t(lang, '费曼复述', 'Retell') },
            ...(selectedItem?.leaf ? [{ key: 'E', label: t(lang, 'AI讲解', 'AI Explain') }] : []),
            { key: 'M', label: t(lang, '章节模拟', 'Mock exam') },
            { key: 'e', label: t(lang, '编辑', 'Edit') },
            { key: 'p', label: t(lang, '练5题', 'Practise 5') },
            { key: 'P', label: t(lang, '精选问答', 'Pinned QA') },
            { key: 'H', label: t(lang, '历史版本', 'History') },
            { key: 'B', label: t(lang, 'AI块审阅', 'AI Blocks') },
            { key: '/', label: t(lang, '筛选', 'Filter') },
            { key: 'w', label: t(lang, '期末一周', 'Final week') },
            { key: 'x', label: t(lang, '导出', 'Export') },
            { key: 'R', label: t(lang, '改名', 'Rename') },
            { key: '[/]', label: t(lang, '移序', 'Move') },
            { key: 'D', label: t(lang, '删节', 'Delete') },
            {
              key: 'U',
              label:
                unplacedSections.length > 0
                  ? t(lang, `归位(${unplacedSections.length})`, `Place(${unplacedSections.length})`)
                  : t(lang, '归位', 'Place'),
            },
            { key: 'z', label: t(lang, '撤销结构', 'Undo struct') },
            { key: 'g', label: t(lang, '生成/重建', 'Build') },
            { key: 'Ctrl+R', label: t(lang, '刷新', 'Refresh') },
          ],
    [lang, mathUnicode, selectedItem?.leaf, status, unplacedSections.length],
  );
  useFooterHints(hints, isActive && !modalOpen);

  useInput(
    (input, key) => {
      if (modalOpen || filterEditing) return;
      if (key.escape && filterQuery) {
        setFilterQuery('');
        setSelectedIndex(0);
        return;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        if (items.length > 0) {
          setActivePane('left');
          setFilterEditing(true);
        }
        return;
      }
      if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
        if (input === 'h' || key.leftArrow) setActivePane('left');
        else if (input === 'l' || key.rightArrow) setActivePane('right');
        else setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (key.return && activePane === 'left' && visibleItems.length > 0) {
        setActivePane('right');
        return;
      }
      if (status === 'rebuild-pending') {
        if (input === 'a') {
          void runBuild('apply-rebuild');
          return;
        }
        if (input === 'u') {
          setConfirmUndoRebuildOpen(true);
          return;
        }
      }
      if (input === 'm') {
        toggleMath();
        return;
      }
      if (input === 'e') {
        setEditModalOpen(true);
        return;
      }
      if (input === 'H') {
        if (effectiveCourse && status === 'ok') {
          setHistoryOpen(true);
        } else {
          useTuiStore.getState().notify(
            t(lang, '当前课程还没有可查看历史的复习全书', 'No review book available for history yet'),
            'info',
          );
        }
        return;
      }
      if (input === 'R') {
        setStructureModalMode('rename');
        setStructureModalOpen(true);
        return;
      }
      if (input === 'U') {
        if (status === 'rebuild-pending') {
          useTuiStore.getState().notify(
            t(lang, '请先处理待确认的总纲重组（按 [a] 应用或 [u] 撤销）', 'Resolve pending outline rebuild first ([a] apply or [u] undo)'),
            'warning',
          );
          return;
        }
        if (unplacedSections.length === 0) {
          useTuiStore.getState().notify(
            t(lang, '当前没有未归位段落', 'No unplaced sections to place'),
            'info',
          );
          return;
        }
        setStructureModalMode('place');
        setStructureModalOpen(true);
        return;
      }
      if (input === '[') {
        void moveSelectedNode('up');
        return;
      }
      if (input === ']') {
        void moveSelectedNode('down');
        return;
      }
      if (input === 'D') {
        if (status === 'ok' && selectedItem) {
          setConfirmDeleteOpen(true);
        } else {
          useTuiStore.getState().notify(t(lang, '请先选择一个目录节点', 'Select a TOC node first'), 'warning');
        }
        return;
      }
      if (input === 'z') {
        if (status === 'ok') {
          setConfirmRevertOpen(true);
        } else {
          useTuiStore.getState().notify(t(lang, '当前没有可撤销的目录调整', 'No review book structure to revert'), 'info');
        }
        return;
      }
      if (input === 'p') {
        void practiseSection();
        return;
      }
      if (input === 'P') {
        setQaModalOpen(true);
        return;
      }
      if (input === 'T') {
        if (status !== 'ok' || !selectedItem) {
          useTuiStore.getState().notify(
            t(lang, '请先打开复习全书并选择一个知识点', 'Open a review book and select a knowledge point first'),
            'warning',
          );
          return;
        }
        if (!selectedItem.leaf) {
          useTuiStore.getState().notify(
            t(lang, '章节标题不支持费曼复述，请选择具体叶子知识点', 'Chapter headers cannot be retold — select a leaf knowledge point'),
            'warning',
          );
          return;
        }
        setRetellModalOpen(true);
        return;
      }
      if (input === 'E') {
        if (effectiveCourse && status === 'ok' && selectedItem?.leaf && (selectedItem.node?.hid || selectedItem.hid)) {
          setExplainOpen(true);
        } else {
          useTuiStore.getState().notify(
            t(lang, '请先在目录中选择一个具体知识点（叶子节点）', 'Select a specific knowledge point (leaf) first'),
            'info',
          );
        }
        return;
      }
      if (input === 'B') {
        if (effectiveCourse && status === 'ok') {
          setAiBlocksOpen(true);
        } else {
          useTuiStore.getState().notify(
            t(lang, '当前课程还没有可审阅的复习全书', 'No review book available for AI blocks yet'),
            'info',
          );
        }
        return;
      }
      if (input === 'M') {
        void planMockExam();
        return;
      }
      if (input === 'w') {
        setCrunchModalOpen(true);
        return;
      }
      if (input === 'x') {
        setExportModalOpen(true);
        return;
      }
      if (input === 'g') {
        setBuildModalOpen(true);
        return;
      }
      if (key.ctrl && input === 'r') {
        setReadCache({});
        setReloadSeq((n) => n + 1);
      }
    },
    { isActive: isActive && !modalOpen && !filterEditing },
  );

  const showFilterBar = status === 'ok' && items.length > 0 && (filterEditing || filterQuery.length > 0);
  const headerH = 2;
  const filterBarH = showFilterBar ? 1 : 0;
  const bodyH = Math.max(6, height - headerH - filterBarH);
  const ell = asciiMode ? '...' : '…';
  const filterBadge = `[${t(lang, '筛选', filterEditing ? 'Filter' : 'Filtered')} ${visibleItems.length}/${items.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

  if (loading && !bookData && !tocData) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Spinner
          label={asciiMode ? t(lang, '正在打开复习全书...', 'Opening review book...') : t(lang, '正在打开复习全书…', 'Opening review book…')}
          active={isActive}
        />
      </Box>
    );
  }

  if (error) {
    return (
      <Box width={width} height={height} paddingX={1}>
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '无法打开复习全书', 'Cannot open review book')}
          hint={error}
          actions={[
            { key: 'Ctrl+R', label: t(lang, '重试', 'Retry') },
            { key: 'c', label: t(lang, '切换课程', 'Switch course') },
          ]}
          width={width - 2}
          height={height}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header strip */}
      <Box height={headerH} width={width} paddingX={1} justifyContent="space-between" alignItems="center">
        <Box gap={1}>
          <Text color={theme.primary} bold>
            {asciiMode ? '=' : '▣'} {truncateDisplay(bookTitle, Math.max(16, Math.floor(width * 0.45)), asciiMode ? '...' : '…')}
          </Text>
          {effectiveCourse ? <Badge label={effectiveCourse} tone="accent" variant="soft" /> : null}
          {bookData?.outdated ? <Badge label={t(lang, '资料有更新', 'Outdated')} tone="warning" variant="outline" /> : null}
          {busyAction ? <Spinner label={asciiMode ? t(lang, '处理中...', 'Working...') : t(lang, '处理中…', 'Working…')} active={isActive} /> : null}
        </Box>
        <Box gap={1}>
          <Badge
            label={mathUnicode ? 'Math: Unicode' : 'Math: LaTeX'}
            tone={mathUnicode ? 'success' : 'info'}
            variant="soft"
          />
          {unplacedSections.length > 0 ? (
            <Badge
              label={t(lang, `未归位 ${unplacedSections.length}`, `Unplaced ${unplacedSections.length}`)}
              tone="warning"
              variant="soft"
            />
          ) : null}
          {((qaList?.followupIds?.length ?? 0) + (qaList?.answerCardIds?.length ?? 0)) > 0 ? (
            <Badge
              label={`Q&A ${(qaList?.followupIds?.length ?? 0) + (qaList?.answerCardIds?.length ?? 0)}`}
              tone="ai"
              variant="soft"
            />
          ) : null}
        </Box>
      </Box>

      {/* Inline `/` Live TOC Filter Bar */}
      {showFilterBar ? (
        <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
          <Text color={filterEditing ? theme.primary : theme.accent} bold>
            {filterBadge}
          </Text>
          <Box flexGrow={1} overflow="hidden">
            <TextInput
              value={filterQuery}
              onChange={(val) => {
                setFilterQuery(val);
                setSelectedIndex(0);
              }}
              onSubmit={(val) => {
                if (!val.trim()) setFilterQuery('');
                setFilterEditing(false);
              }}
              onCancel={() => {
                setFilterQuery('');
                setFilterEditing(false);
                setSelectedIndex(0);
              }}
              isActive={isActive && !modalOpen && filterEditing}
              width={filterInputW}
              prompt="/"
              placeholder={t(lang, `标题/编号/HID/文件名${ell}`, `title/number/hid/file${ell}`)}
              maxLength={120}
            />
          </Box>
          {filterRightHint ? (
            <Text color={theme.dim} wrap="truncate">
              {filterRightHint}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* Main content */}
      {status !== 'ok' || items.length === 0 ? (
        <Box width={width} height={bodyH} paddingX={1}>
          <EmptyState
            icon={asciiMode ? '=' : '▣'}
            title={
              status === 'rebuild-pending'
                ? t(lang, '课程总纲已重建，等待确认归位', 'Outline rebuilt — confirmation needed')
                : reason === 'no-course'
                  ? t(lang, '请先选择一门课程', 'Select a course first')
                  : t(lang, '这门课还没有复习全书', 'No review book for this course yet')
            }
            hint={
              status === 'rebuild-pending'
                ? t(lang, '按 [a] 应用新总纲，按 [u] 撤销本次总纲重组，或按 [g] 查看构建选项', 'Press [a] to apply, [u] to undo rebuild, or [g] for build options')
                : reason === 'no-course'
                  ? t(lang, '按 [c] 选择课程，或先导入课程资料', 'Press [c] to pick a course')
                  : t(lang, '按 [g] 自动整理课程总纲并生成复习全书', 'Press [g] to build the course outline and review book')
            }
            actions={
              status === 'rebuild-pending'
                ? [
                    { key: 'a', label: t(lang, '应用新总纲', 'Apply') },
                    { key: 'u', label: t(lang, '撤销重组', 'Undo') },
                    { key: 'g', label: t(lang, '构建选项', 'Build') },
                  ]
                : [
                    { key: 'g', label: t(lang, '生成/重建', 'Build') },
                    { key: 'c', label: t(lang, '选课', 'Course') },
                  ]
            }
            width={width - 2}
            height={bodyH}
          />
        </Box>
      ) : (
        <SplitPane
          width={width}
          height={bodyH}
          leftWidth={0.36}
          minLeft={26}
          minRight={34}
          activePane={activePane}
          leftLabel={t(lang, '目录 TOC', 'TOC')}
          rightLabel={t(lang, '讲义正文', 'Content')}
          left={(size) => (
            <Panel
              title={t(lang, '章节目录', 'Contents')}
              badge={normalizedFilter ? `${visibleItems.length}/${items.length}` : items.length}
              focused={activePane === 'left'}
              width={size.width}
              height={size.height}
              paddingX={1}
            >
              <VirtualList
                items={visibleItems}
                width={Math.max(10, size.width - 4)}
                height={Math.max(3, size.height - 2)}
                selectedIndex={clampedSelectedIndex}
                onChange={(idx) => setSelectedIndex(idx)}
                onSelect={() => setActivePane('right')}
                isActive={isActive && activePane === 'left' && !modalOpen && !filterEditing}
                emptyText={normalizedFilter ? t(lang, '没有匹配的章节或知识点', 'No matching TOC items') : undefined}
                emptyHint={normalizedFilter ? t(lang, '按 Esc 清除筛选或按 / 修改', asciiMode ? 'Esc clear | / edit' : 'Esc clear · / edit') : undefined}
                keyExtractor={(it) => it.hid}
                renderItem={(it, ctx) => {
                  const indent = '  '.repeat(Math.max(0, it.depth - 1));
                  const retold = getRetoldSummary(it.node);
                  const tags = [
                    it.leaf && retold.passed ? (asciiMode ? '+' : '✓') : '',
                    it.hasQa ? (asciiMode ? '*' : '✎') : '',
                    it.short ? '·' : '',
                    it.questionTotal > 0 ? `${it.questionTotal}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const tagReserve = tags ? displayWidth(tags) + 1 : 0;
                  const labelText = truncateDisplay(`${indent}${it.number} ${it.title}`, Math.max(8, ctx.width - tagReserve), asciiMode ? '...' : '…');
                  return (
                    <Box width={ctx.width} justifyContent="space-between">
                      <Text
                        color={ctx.selected ? theme.selectionFg : it.leaf ? theme.text : theme.heading}
                        bold={!it.leaf || ctx.selected}
                      >
                        {labelText}
                      </Text>
                      {tags ? <Text color={ctx.selected ? theme.selectionFg : retold.passed && it.leaf ? theme.success : theme.muted}>{tags}</Text> : null}
                    </Box>
                  );
                }}
              />
            </Panel>
          )}
          right={(size) => {
            const innerW = Math.max(16, size.width - 4);
            const { proseWidth, marginLeft } = computeProseLayout(innerW);
            const readTime = markdown ? formatReadingTimeLabel(markdown, lang) : '';
            const baseSub = selectedItem?.leaf
              ? t(lang, '[T] 费曼复述  [p] 练5题  [m] 公式', '[T] Retell  [p] Practise 5  [m] Math')
              : '';
            const subSep = asciiMode ? ' - ' : ' · ';
            const subtitle = baseSub && readTime ? `${readTime}${subSep}${baseSub}` : baseSub || readTime || undefined;
            return (
              <Panel
                title={selectedItem ? `${selectedItem.number} ${selectedItem.title}` : t(lang, '正文', 'Reader')}
                badge={
                  selectedItem?.leaf && selectedRetold.passed
                    ? t(lang, asciiMode ? '+ 讲清楚过' : '✓ 讲清楚过', asciiMode ? '+ Retold' : '✓ Retold')
                    : undefined
                }
                badgeTone="success"
                subtitle={subtitle}
                focused={activePane === 'right'}
                width={size.width}
                height={size.height}
                paddingX={1}
              >
                <Box width={innerW} height={Math.max(3, size.height - 2)} paddingLeft={marginLeft} overflow="hidden">
                  <MarkdownView
                    markdown={markdown}
                    width={proseWidth}
                    height={Math.max(3, size.height - 2)}
                    isActive={isActive && activePane === 'right' && !modalOpen && !filterEditing}
                    mathUnicode={mathUnicode}
                  />
                </Box>
              </Panel>
            );
          }}
        />
      )}

      {buildModalOpen ? (
        <Modal
          title={t(lang, '构建 / 重建复习全书', 'Build Outline & Review Book')}
          subtitle={effectiveCourse ?? undefined}
          icon={asciiMode ? '=' : '▣'}
          onClose={() => setBuildModalOpen(false)}
          isActive={isActive}
          width={Math.min(72, Math.max(44, width - 6))}
          hints={[
            { key: 'Enter', label: t(lang, '执行', 'Run') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <SelectList
            options={buildOptions}
            width={modalContentWidth(Math.min(72, Math.max(44, width - 6)))}
            maxHeight={10}
            isActive={isActive}
            onSelect={(opt) => void runBuild(opt.value)}
          />
        </Modal>
      ) : null}

      <Suspense fallback={null}>
        {aiBlocksOpen ? (
          <BookAiBlocksModal
            host={host}
            course={effectiveCourse ?? null}
            selectedItem={selectedItem ?? null}
            bookData={bookData}
            isActive={isActive && aiBlocksOpen}
            width={width}
            height={height}
            onClose={() => setAiBlocksOpen(false)}
            onUpdated={(view) => {
              if (selectedItem?.hid) pendingFocusHidRef.current = selectedItem.hid;
              setReadCache({});
              if (view && view.status === 'ok') {
                setBookData(view);
                setStructureVersion(extractStructureVersion(view));
              } else {
                setReloadSeq((n) => n + 1);
              }
            }}
          />
        ) : null}

        {crunchModalOpen ? (
          <BookCrunchModal
            host={host}
            course={effectiveCourse ?? null}
            isActive={isActive && crunchModalOpen}
            width={width}
            height={height}
            onClose={() => setCrunchModalOpen(false)}
          />
        ) : null}

        {editModalOpen ? (
          <BookEditModal
            host={host}
            course={effectiveCourse ?? null}
            selectedItem={selectedItem ?? null}
            bookData={bookData}
            isActive={isActive && editModalOpen}
            width={width}
            height={height}
            onClose={() => setEditModalOpen(false)}
            onSaved={() => {
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
          />
        ) : null}

        {explainOpen ? (
          <BookExplainModal
            host={host}
            course={effectiveCourse ?? null}
            selectedItem={selectedItem ?? null}
            isActive={isActive && explainOpen}
            width={width}
            height={height}
            onClose={() => setExplainOpen(false)}
            onStarted={() => {
              if (selectedItem?.hid) pendingFocusHidRef.current = selectedItem.hid;
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
          />
        ) : null}

        {exportModalOpen ? (
          <BookExportModal
            host={host}
            course={effectiveCourse ?? null}
            isActive={isActive && exportModalOpen}
            width={width}
            height={height}
            onClose={() => setExportModalOpen(false)}
          />
        ) : null}

        {historyOpen ? (
          <BookHistoryModal
            host={host}
            course={effectiveCourse ?? null}
            selectedItem={selectedItem ?? null}
            bookData={bookData}
            isActive={isActive && historyOpen}
            width={width}
            height={height}
            onClose={() => setHistoryOpen(false)}
            onReverted={() => {
              if (selectedItem?.hid) pendingFocusHidRef.current = selectedItem.hid;
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
          />
        ) : null}

        {qaModalOpen ? (
          <BookQaModal
            host={host}
            course={effectiveCourse ?? null}
            selectedNodeId={selectedItem?.key ?? null}
            selectedHid={selectedItem?.hid ?? null}
            isActive={isActive && qaModalOpen}
            width={width}
            height={height}
            onClose={() => setQaModalOpen(false)}
            onChanged={() => {
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
          />
        ) : null}

        {retellModalOpen ? (
          <BookRetellModal
            host={host}
            course={effectiveCourse ?? null}
            selectedItem={selectedItem ?? null}
            isActive={isActive && retellModalOpen}
            width={width}
            height={height}
            mathUnicode={mathUnicode}
            onClose={() => setRetellModalOpen(false)}
            onRetold={() => {
              if (selectedItem?.hid) pendingFocusHidRef.current = selectedItem.hid;
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
          />
        ) : null}

        {structureModalOpen ? (
          <BookStructureModal
            host={host}
            course={effectiveCourse ?? null}
            mode={structureModalMode}
            selectedItem={selectedItem ?? null}
            unplacedSections={unplacedSections}
            leafPoints={leafPoints}
            structureVersion={structureVersion}
            isActive={isActive && structureModalOpen}
            width={width}
            height={height}
            onClose={() => setStructureModalOpen(false)}
            onRenamed={(nextVer, hid) => {
              if (typeof nextVer === 'number') setStructureVersion(nextVer);
              if (hid) pendingFocusHidRef.current = hid;
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
            onPlaced={(nextVer, toHid) => {
              if (typeof nextVer === 'number') setStructureVersion(nextVer);
              if (toHid) pendingFocusHidRef.current = toHid;
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
            onConflict={() => {
              if (selectedItem?.hid) pendingFocusHidRef.current = selectedItem.hid;
              setReadCache({});
              setReloadSeq((n) => n + 1);
            }}
          />
        ) : null}
      </Suspense>

      {confirmDeleteOpen && selectedItem ? (
        <ConfirmDialog
          title={t(lang, '删除目录节点', 'Delete TOC Node')}
          message={t(
            lang,
            `确定删除「${selectedItem.number} ${selectedItem.title}」吗？子节点将上提一级，你写的笔记与问答会保留在「未归位 (Unplaced)」中，不会丢失。`,
            `Delete "${selectedItem.number} ${selectedItem.title}"? Child items will be promoted, and learner notes & Q&A will be kept safely in Unplaced (未归位).`,
          )}
          confirmLabel={t(lang, '删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && confirmDeleteOpen}
          onConfirm={() => void deleteSelectedNode()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      ) : null}

      {confirmRevertOpen ? (
        <ConfirmDialog
          title={t(lang, '撤销上次目录调整', 'Revert Last Structure Edit')}
          message={t(
            lang,
            '确定撤销最近一次章节改名、移动或删除操作吗？之后单独编辑过的讲义正文会保留。',
            'Revert the latest rename, move, or delete structure change? Any section text edited afterward will be kept.',
          )}
          confirmLabel={t(lang, '撤销', 'Revert')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && confirmRevertOpen}
          onConfirm={() => void revertStructure()}
          onCancel={() => setConfirmRevertOpen(false)}
        />
      ) : null}

      {confirmUndoRebuildOpen ? (
        <ConfirmDialog
          title={t(lang, '撤销本次总纲重组', 'Undo Outline Rebuild')}
          message={t(
            lang,
            '确定放弃本次待确认的新总纲重组并回到原来的总纲结构吗？原有笔记不会被改动。',
            'Discard the pending outline rebuild and keep the previous outline structure? Existing notes stay unchanged.',
          )}
          confirmLabel={t(lang, '撤销重组', 'Undo rebuild')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && confirmUndoRebuildOpen}
          onConfirm={() => void undoPendingRebuild()}
          onCancel={() => setConfirmUndoRebuildOpen(false)}
        />
      ) : null}

      {mockConfirmPlan ? (
        <ConfirmDialog
          title={t(lang, '章节模拟卷确认', 'Chapter Mock Exam')}
          message={(() => {
            const { plan, title } = mockConfirmPlan;
            const mins = plan.limitMinutes ?? 30;
            const skipped = Object.values(plan.leftOut ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
            const capNoteZh = plan.capped ? `（共 ${plan.eligible} 道可选）` : '';
            const capNoteEn = plan.capped ? ` (${plan.eligible} eligible)` : '';
            const skipNoteZh = skipped > 0 ? `，已跳过 ${skipped} 道非选择题` : '';
            const skipNoteEn = skipped > 0 ? `, ${skipped} non-choice skipped` : '';
            return t(
              lang,
              `已为「${title}」规划 ${plan.count} 道选择题${capNoteZh}，预计限时 ${mins} 分钟${skipNoteZh}。是否立即开始模拟考试？`,
              `Planned ${plan.count} choice questions for "${title}"${capNoteEn}, ${mins} min limit${skipNoteEn}. Start mock exam now?`,
            );
          })()}
          confirmLabel={t(lang, '开始模考', 'Start Mock')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && Boolean(mockConfirmPlan)}
          onConfirm={() => void confirmMockStart()}
          onCancel={() => setMockConfirmPlan(null)}
        />
      ) : null}
    </Box>
  );
};
