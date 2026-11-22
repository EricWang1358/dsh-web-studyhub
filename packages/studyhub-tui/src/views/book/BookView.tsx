import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { saveTuiPreferences } from '../../host/index.js';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  MarkdownView,
  Modal,
  Panel,
  SelectList,
  Spinner,
  SplitPane,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useTheme,
  type SelectOption,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import type {
  BookNode,
  BookOpenResult,
  BookQaListResult,
  BookReadResult,
  BookTocResult,
  FlatTocItem,
} from './types.js';
const BookCrunchModal = lazy(() => import('./BookCrunchModal.js').then((m) => ({ default: m.BookCrunchModal })));
const BookEditModal = lazy(() => import('./BookEditModal.js').then((m) => ({ default: m.BookEditModal })));
const BookExportModal = lazy(() => import('./BookExportModal.js').then((m) => ({ default: m.BookExportModal })));
const BookQaModal = lazy(() => import('./BookQaModal.js').then((m) => ({ default: m.BookQaModal })));
const BookStructureModal = lazy(() => import('./BookStructureModal.js').then((m) => ({ default: m.BookStructureModal })));

const BASE_CLAIMED_KEYS = ['P', 'e', 'r', 'w', 'x', '[', ']'] as const;
const REBUILD_CLAIMED_KEYS = ['P', 'e', 'r', 'w', 'x', '[', ']', 'a'] as const;
const STRUCTURE_FILE = 'book.structure';

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
      retoldCount: Number(node.retold?.count ?? 0) || 0,
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
): string {
  if (!item) return '';
  const parts: string[] = [];
  const node = item.node;

  if (node) {
    parts.push(`# ${node.number} ${node.title}`);
    const statusTags: string[] = [];
    if (node.leaf) {
      statusTags.push(t(lang, `关联题目: ${node.questionTotal ?? 0}`, `Linked questions: ${node.questionTotal ?? 0}`));
      if (node.retold?.count) statusTags.push(t(lang, `已复述 ${node.retold.count} 次`, `Retold ${node.retold.count}x`));
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
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [buildModalOpen, setBuildModalOpen] = useState(false);
  const [crunchModalOpen, setCrunchModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [qaModalOpen, setQaModalOpen] = useState(false);
  const [structureModalOpen, setStructureModalOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmRevertOpen, setConfirmRevertOpen] = useState(false);
  const [confirmUndoRebuildOpen, setConfirmUndoRebuildOpen] = useState(false);
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

  const items: FlatTocItem[] = useMemo(() => {
    if (bookData?.status === 'ok' && bookData.nodes?.length) return flattenBookNodes(bookData.nodes);
    return flattenTocRows(tocData);
  }, [bookData, tocData]);

  useEffect(() => {
    const targetHid = pendingFocusHidRef.current;
    if (targetHid && items.length > 0) {
      const idx = items.findIndex((it) => it.hid === targetHid);
      pendingFocusHidRef.current = null;
      if (idx >= 0) {
        setSelectedIndex(idx);
        return;
      }
    }
    if (items.length > 0 && selectedIndex >= items.length) setSelectedIndex(items.length - 1);
  }, [items, selectedIndex]);

  const selectedItem = items[selectedIndex];
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

  const markdown = useMemo(
    () => buildSectionMarkdown(selectedItem, selectedRead, qaList, lang),
    [selectedItem, selectedRead, qaList, lang],
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
              t(lang, '未能获取待应用总纲的 outlineId，请按 [r] 刷新后重试', 'Missing pending outlineId; press [r] to refresh and try again'),
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
          t(lang, '未能获取待撤销总纲的 outlineId，请按 [r] 刷新后重试', 'Missing pending outlineId; press [r] to refresh and try again'),
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
    buildModalOpen ||
    crunchModalOpen ||
    editModalOpen ||
    exportModalOpen ||
    qaModalOpen ||
    structureModalOpen ||
    confirmDeleteOpen ||
    confirmRevertOpen ||
    confirmUndoRebuildOpen;
  useClaimKeys(status === 'rebuild-pending' ? REBUILD_CLAIMED_KEYS : BASE_CLAIMED_KEYS, isActive && !modalOpen);

  const hints: KeyHint[] = useMemo(
    () =>
      status === 'rebuild-pending'
        ? [
            { key: 'a', label: t(lang, '应用重建', 'Apply') },
            { key: 'u', label: t(lang, '撤销重组', 'Undo rebuild') },
            { key: 'g', label: t(lang, '构建选项', 'Build') },
            { key: 'P', label: t(lang, '精选问答', 'Pinned QA') },
            { key: 'r', label: t(lang, '刷新', 'Refresh') },
          ]
        : [
            { key: 'Tab', label: t(lang, '切换窗格', 'Pane') },
            { key: 'm', label: mathUnicode ? t(lang, '数学:Unicode', 'Math:Unicode') : t(lang, '数学:LaTeX', 'Math:LaTeX') },
            { key: 'e', label: t(lang, '编辑', 'Edit') },
            { key: 'p', label: t(lang, '练5题', 'Practise 5') },
            { key: 'P', label: t(lang, '精选问答', 'Pinned QA') },
            { key: 'w', label: t(lang, '期末一周', 'Final week') },
            { key: 'x', label: t(lang, '导出', 'Export') },
            { key: 'R', label: t(lang, '改名', 'Rename') },
            { key: '[/]', label: t(lang, '移序', 'Move') },
            { key: 'D', label: t(lang, '删节', 'Delete') },
            { key: 'z', label: t(lang, '撤销结构', 'Undo struct') },
            { key: 'g', label: t(lang, '生成/重建', 'Build') },
            { key: 'r', label: t(lang, '刷新', 'Refresh') },
          ],
    [lang, mathUnicode, status],
  );
  useFooterHints(hints, isActive && !modalOpen);

  useInput(
    (input, key) => {
      if (modalOpen) return;
      if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
        if (input === 'h' || key.leftArrow) setActivePane('left');
        else if (input === 'l' || key.rightArrow) setActivePane('right');
        else setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (key.return && activePane === 'left' && items.length > 0) {
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
      if (input === 'R') {
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
      if (input === 'r') {
        setReadCache({});
        setReloadSeq((n) => n + 1);
      }
    },
    { isActive: isActive && !modalOpen },
  );

  const headerH = 2;
  const bodyH = Math.max(6, height - headerH);

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
            { key: 'r', label: t(lang, '重试', 'Retry') },
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
          {((qaList?.followupIds?.length ?? 0) + (qaList?.answerCardIds?.length ?? 0)) > 0 ? (
            <Badge
              label={`Q&A ${(qaList?.followupIds?.length ?? 0) + (qaList?.answerCardIds?.length ?? 0)}`}
              tone="ai"
              variant="soft"
            />
          ) : null}
        </Box>
      </Box>

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
              badge={items.length}
              focused={activePane === 'left'}
              width={size.width}
              height={size.height}
              paddingX={1}
            >
              <VirtualList
                items={items}
                width={Math.max(10, size.width - 4)}
                height={Math.max(3, size.height - 2)}
                selectedIndex={selectedIndex}
                onChange={(idx) => setSelectedIndex(idx)}
                onSelect={() => setActivePane('right')}
                isActive={isActive && activePane === 'left' && !modalOpen}
                keyExtractor={(it) => it.hid}
                renderItem={(it, ctx) => {
                  const indent = '  '.repeat(Math.max(0, it.depth - 1));
                  const tags = [
                    it.hasQa ? (asciiMode ? '*' : '✎') : '',
                    it.short ? '·' : '',
                    it.questionTotal > 0 ? `${it.questionTotal}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const tagReserve = tags ? tags.length + 1 : 0;
                  const labelText = truncateDisplay(`${indent}${it.number} ${it.title}`, Math.max(8, ctx.width - tagReserve), asciiMode ? '...' : '…');
                  return (
                    <Box width={ctx.width} justifyContent="space-between">
                      <Text
                        color={ctx.selected ? theme.selectionFg : it.leaf ? theme.text : theme.heading}
                        bold={!it.leaf || ctx.selected}
                      >
                        {labelText}
                      </Text>
                      {tags ? <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{tags}</Text> : null}
                    </Box>
                  );
                }}
              />
            </Panel>
          )}
          right={(size) => (
            <Panel
              title={selectedItem ? `${selectedItem.number} ${selectedItem.title}` : t(lang, '正文', 'Reader')}
              subtitle={selectedItem?.leaf ? t(lang, '[p] 练5题  [m] 公式', '[p] Practise 5  [m] Math') : undefined}
              focused={activePane === 'right'}
              width={size.width}
              height={size.height}
              paddingX={1}
            >
              <MarkdownView
                markdown={markdown}
                width={Math.max(16, size.width - 4)}
                height={Math.max(3, size.height - 2)}
                isActive={isActive && activePane === 'right' && !modalOpen}
                mathUnicode={mathUnicode}
              />
            </Panel>
          )}
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

        {qaModalOpen ? (
          <BookQaModal
            host={host}
            course={effectiveCourse ?? null}
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

        {structureModalOpen ? (
          <BookStructureModal
            host={host}
            course={effectiveCourse ?? null}
            selectedItem={selectedItem ?? null}
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
    </Box>
  );
};
