import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { SplitPane } from '../../components/SplitPane.js';
import { LAYOUT_BP } from '../../components/layout-tokens.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { persistCardQaToFollowupAndNote } from '../../host/ai-dialogue.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';

export interface ReaderNotesDrawerProps {
  host: HostClient;
  documentId?: string;
  sourceId?: string;
  revision?: string;
  title?: string;
  currentPage: number;
  width: number;
  height: number;
  isActive: boolean;
  onJumpPage: (page: number) => void;
  onClose: () => void;
}

export interface SavePageAskParams {
  host: HostClient;
  lang: UiLanguage;
  title: string;
  page: number;
  sourceId: string;
  documentId?: string;
  revision?: string;
  pageText: string;
  question: string;
  answer: string;
  course?: string;
  anchorOffset?: number;
  selectedExcerpt?: string;
}

export interface SavePageAskResult {
  ok: boolean;
  savedTo: 'note' | 'annotation' | 'both' | 'none';
  noteId?: string;
  message: string;
}

interface SelectionAnchor {
  sourceId?: string;
  start?: number;
  end?: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
  page?: number;
}

interface AnnotationItem {
  id: string;
  key?: string;
  parentId?: string | null;
  question: string;
  term?: string;
  label?: string;
  answer: string;
  language?: string;
  kind?: string;
  selection?: SelectionAnchor;
  status?: 'resolved' | 'stale';
  at?: string;
  updatedAt?: string;
}

interface MarkItem {
  id: string;
  key?: string;
  style: 'underline' | 'bold' | 'highlight' | 'queue' | string;
  selection?: SelectionAnchor;
  status?: 'resolved' | 'stale';
  at?: string;
  rereadAt?: string;
}

interface StaleMarkGroup {
  revision?: string;
  count?: number;
  savedAt?: string;
  items?: MarkItem[];
}

type DrawerTab = 'annotations' | 'marks';

type ConfirmAction =
  | { kind: 'annotation'; item: AnnotationItem }
  | { kind: 'mark'; item: MarkItem }
  | { kind: 'purge-stale-marks'; count: number };

const MARK_STYLE_ICON: Record<string, string> = {
  underline: '═',
  bold: 'B',
  highlight: '▮',
  queue: '✦',
};

const ASCII_MARK_STYLE_ICON: Record<string, string> = {
  underline: '=',
  bold: 'B',
  highlight: '#',
  queue: '*',
};

function markStyleLabel(lang: UiLanguage, style: string): string {
  switch (style) {
    case 'underline':
      return t(lang, '下划线', 'Underline');
    case 'bold':
      return t(lang, '加粗', 'Bold');
    case 'highlight':
      return t(lang, '荧光笔', 'Highlight');
    case 'queue':
      return t(lang, '待出题', 'Queued');
    default:
      return style;
  }
}

function resolveItemPage(selection: SelectionAnchor | undefined, pageMap: Map<string, number>): number | undefined {
  if (selection && Number.isInteger(selection.page) && Number(selection.page) > 0) {
    return Number(selection.page);
  }
  if (selection?.sourceId && pageMap.has(selection.sourceId)) {
    return pageMap.get(selection.sourceId);
  }
  return undefined;
}

function formatAnnotationMarkdown(lang: UiLanguage, item: AnnotationItem, page?: number, asciiMode = false): string {
  const heading = item.label || item.term || item.question;
  const metaParts: string[] = [];
  if (page) metaParts.push(`P.${page}`);
  if (item.status === 'stale') metaParts.push(t(lang, '旧版本锚点', 'Stale anchor'));
  if (item.kind === 'explain') metaParts.push(t(lang, '词解', 'Explain'));
  const quote = item.selection?.quote?.trim();
  const lines = [`### ${heading}`];
  const sep = asciiMode ? ' - ' : ' · ';
  if (metaParts.length > 0) lines.push(`*${metaParts.join(sep)}*`);
  if (item.label && item.question && item.label !== item.question) {
    lines.push('', `**${t(lang, '问题', 'Question')}:** ${item.question}`);
  }
  if (quote) {
    const single = quote.replace(/\s+/g, ' ').slice(0, 320);
    lines.push('', `> ${single}`);
  }
  lines.push('', '---', '', item.answer || '');
  return lines.join('\n');
}

function formatMarkMarkdown(lang: UiLanguage, item: MarkItem, page?: number, asciiMode = false): string {
  const label = markStyleLabel(lang, item.style);
  const meta: string[] = [];
  if (page) meta.push(`P.${page}`);
  if (item.status === 'stale') meta.push(t(lang, '旧版本', 'Stale'));
  if (item.rereadAt) meta.push(t(lang, '已重读', 'Reread'));
  const quote = item.selection?.quote?.trim() || t(lang, '（无引用片段）', '(No quote)');
  const iconMap = asciiMode ? ASCII_MARK_STYLE_ICON : MARK_STYLE_ICON;
  const sep = asciiMode ? ' - ' : ' · ';
  const lines = [`### ${iconMap[item.style] || (asciiMode ? '-' : '•')} ${label}`];
  if (meta.length > 0) lines.push(`*${meta.join(sep)}*`);
  lines.push('', `> ${quote}`);
  if (item.at) lines.push('', `- **${t(lang, '标记时间', 'Marked')}:** ${item.at.slice(0, 16).replace('T', ' ')}`);
  if (item.rereadAt) lines.push(`- **${t(lang, '重读时间', 'Reread')}:** ${item.rereadAt.slice(0, 16).replace('T', ' ')}`);
  return lines.join('\n');
}

/**
 * Save a finished AI Page Ask Q&A persistently:
 * 1) If the page has linked cards (`materials.pages.cards`), record a follow-up via `card.followup.add`
 *    and append into Study Notes via `note.qa.add`.
 * 2) When passage text is available, also save a page-anchored annotation via `materials.annotation.save`
 *    using the reader's active viewport offset/excerpt (falling back to first non-whitespace text)
 *    so the Q&A appears immediately in `ReaderNotesDrawer` even when no cards are linked yet.
 */
export async function savePageAskToNote(params: SavePageAskParams): Promise<SavePageAskResult> {
  const {
    host,
    lang,
    title,
    page,
    sourceId,
    documentId,
    revision,
    pageText,
    question,
    answer,
    course,
    anchorOffset,
    selectedExcerpt,
  } = params;
  const cleanAnswer = answer.trim();
  if (!cleanAnswer || cleanAnswer.startsWith(String.fromCharCode(0x2715))) {
    return {
      ok: false,
      savedTo: 'none',
      message: t(lang, '暂无可保存的 AI 回答', 'No AI answer available to save'),
    };
  }
  const cleanQuestion = question.trim() || t(lang, `第 ${page} 页提问`, `Page ${page} question`);
  const docLabel = title || t(lang, '资料阅读', 'Material');

  let savedFollowup = false;
  let savedNote = false;
  let savedNoteId: string | undefined;
  let noteError: string | undefined;

  // 1. Check linked cards and atomically save Q&A via backend composite action `note.qa.save` (#1354 D7).
  if (sourceId || documentId) {
    const cardsRes = await tryAction<{ cards?: Array<{ deckId?: string; cardId?: string }> }>(
      host,
      'materials.pages.cards',
      {
        ...(documentId ? { documentId } : {}),
        ...(sourceId ? { sourceId } : {}),
      },
    );
    const linked = (cardsRes.ok ? cardsRes.value?.cards ?? [] : []).filter(
      (c): c is { deckId: string; cardId: string } => Boolean(c.deckId && c.cardId),
    );
    if (linked.length > 0) {
      const target = linked[0];
      const noteTitle = course ? `${course} · ${docLabel}` : docLabel;
      const persisted = await persistCardQaToFollowupAndNote({
        host,
        deckId: target.deckId,
        cardId: target.cardId,
        question: cleanQuestion,
        answer: cleanAnswer,
        noteTitle,
        lang,
      });
      if (persisted.ok && persisted.noteSaved) {
        savedFollowup = true;
        savedNote = true;
        savedNoteId = persisted.noteId;
      } else {
        noteError = persisted.error || persisted.warning;
      }
    }
  }

  // 2. Save as a persistent page passage annotation when sourceId & text exist.
  let savedAnnotation = false;
  let annotError: string | undefined;
  const nonWsIndex = pageText.search(/\S/);
  if (sourceId && nonWsIndex >= 0) {
    let start = nonWsIndex;
    let end = Math.min(pageText.length, start + 360);

    const cleanExcerpt = typeof selectedExcerpt === 'string' ? selectedExcerpt.trim() : '';
    if (cleanExcerpt) {
      const hint =
        typeof anchorOffset === 'number' && Number.isFinite(anchorOffset) && anchorOffset >= 0
          ? Math.min(pageText.length, Math.floor(anchorOffset))
          : 0;
      const matchedAt = pageText.indexOf(cleanExcerpt, hint);
      const fallbackAt = matchedAt >= 0 ? matchedAt : pageText.indexOf(cleanExcerpt);
      if (fallbackAt >= 0) {
        start = fallbackAt;
        end = Math.min(pageText.length, start + Math.max(1, Math.min(360, cleanExcerpt.length)));
      }
    }
    if (
      start === nonWsIndex &&
      typeof anchorOffset === 'number' &&
      Number.isFinite(anchorOffset) &&
      anchorOffset > 0
    ) {
      const clamped = Math.min(Math.max(0, Math.floor(anchorOffset)), Math.max(0, pageText.length - 1));
      const relNonWs = pageText.slice(clamped).search(/\S/);
      if (relNonWs >= 0) {
        start = clamped + relNonWs;
        end = Math.min(pageText.length, start + 360);
      }
    }

    const quote = pageText.slice(start, end);
    const nodeId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const annotRes = await tryAction<Record<string, unknown>>(host, 'materials.annotation.save', {
      ...(documentId ? { documentId } : {}),
      ...(revision ? { revision } : {}),
      sourceId,
      selection: {
        ...(documentId ? { documentId } : {}),
        ...(revision ? { revision } : {}),
        sourceId,
        start,
        end,
        quote,
      },
      nodes: [
        {
          id: nodeId,
          parentId: null,
          question: cleanQuestion.slice(0, 2000),
          answer: cleanAnswer.slice(0, 20000),
          language: lang === 'en' ? 'English' : '中文',
        },
      ],
    });
    if (annotRes.ok && annotRes.value?.status === 'saved') {
      savedAnnotation = true;
    } else if (!annotRes.ok) {
      annotError = annotRes.error?.message;
    } else if (typeof annotRes.value?.message === 'string') {
      annotError = annotRes.value.message;
    }
  }

  if (savedNote && savedAnnotation) {
    return {
      ok: true,
      savedTo: 'both',
      ...(savedNoteId ? { noteId: savedNoteId } : {}),
      message: t(lang, '已保存到学习笔记与文档批注', 'Saved to Study Notes & Annotations'),
    };
  }
  if (savedNote) {
    return {
      ok: true,
      savedTo: 'note',
      ...(savedNoteId ? { noteId: savedNoteId } : {}),
      message: t(lang, '已保存到学习笔记', 'Saved to Study Notes'),
    };
  }
  if (savedAnnotation) {
    if (savedFollowup && !savedNote) {
      return {
        ok: true,
        savedTo: 'annotation',
        message: t(
          lang,
          `已保存批注问答与关联题卡讲解，但写入学习笔记失败：${noteError || '请稍后重试'}`,
          `Saved annotation & card explanation, but writing to Study Notes failed: ${noteError || 'please retry'}`,
        ),
      };
    }
    return {
      ok: true,
      savedTo: 'annotation',
      message: t(lang, '已保存为本页批注问答 (按 B 查看)', 'Saved as page annotation (press B to view)'),
    };
  }
  if (savedFollowup) {
    return {
      ok: true,
      savedTo: 'note',
      message: t(
        lang,
        `已保存到关联题卡讲解，但写入学习笔记失败：${noteError || '请稍后重试'}`,
        `Saved to linked card explanation, but writing to Study Notes failed: ${noteError || 'please retry'}`,
      ),
    };
  }
  return {
    ok: false,
    savedTo: 'none',
    message:
      noteError ||
      annotError ||
      t(lang, '无法保存：本页暂无可锚定文本或关联题目', 'Unable to save: no anchorable text or linked card on this page'),
  };
}

export const ReaderNotesDrawer = memo(function ReaderNotesDrawer({
  host,
  documentId,
  sourceId,
  revision,
  title,
  currentPage,
  width,
  height,
  isActive,
  onJumpPage,
  onClose,
}: ReaderNotesDrawerProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const [tab, setTab] = useState<DrawerTab>('annotations');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([]);
  const [marks, setMarks] = useState<MarkItem[]>([]);
  const [staleAnnotCount, setStaleAnnotCount] = useState(0);
  const [staleMarkCount, setStaleMarkCount] = useState(0);
  const [pageMap, setPageMap] = useState<Map<string, number>>(() => new Map());
  const [annotIndex, setAnnotIndex] = useState(0);
  const [markIndex, setMarkIndex] = useState(0);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const [resolvedDocId, setResolvedDocId] = useState<string | undefined>(documentId);
  const [resolvedRevision, setResolvedRevision] = useState<string | undefined>(revision);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      // Memory NFR: clear drawer lists/maps on unmount.
      setAnnotations([]);
      setMarks([]);
      setStaleAnnotCount(0);
      setStaleMarkCount(0);
      setPageMap(new Map());
      setConfirmAction(null);
    };
  }, []);

  const applyMarksResponse = useCallback((marksVal: Record<string, unknown> | undefined) => {
    const markItems = Array.isArray(marksVal?.items) ? (marksVal.items as MarkItem[]) : [];
    const staleGroups = Array.isArray(marksVal?.stale) ? (marksVal.stale as StaleMarkGroup[]) : [];
    const olderStaleCount = staleGroups.reduce(
      (sum, s) => sum + Number(s.count ?? (Array.isArray(s.items) ? s.items.length : 0)),
      0,
    );
    const inlineStaleCount = markItems.filter((item) => item.status === 'stale').length;
    setMarks(markItems);
    setStaleMarkCount(olderStaleCount + inlineStaleCount);
    setMarkIndex((idx) => (markItems.length === 0 ? 0 : Math.max(0, Math.min(idx, markItems.length - 1))));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfirmAction(null);

    const loadAll = async () => {
      const targetArgs: Record<string, unknown> = {
        ...(documentId ? { documentId } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(revision ? { revision } : {}),
      };

      const [docRes, annotRes, marksRes] = await Promise.all([
        documentId || sourceId
          ? tryAction<Record<string, unknown>>(host, 'materials.document.get', targetArgs)
          : Promise.resolve({ ok: false as const }),
        tryAction<Record<string, unknown>>(host, 'materials.annotation.list', targetArgs),
        tryAction<Record<string, unknown>>(host, 'materials.marks.list', targetArgs),
      ]);
      if (cancelled || !mountedRef.current) return;

      let nextDocId = documentId;
      let nextRev = revision;

      const nextPageMap = new Map<string, number>();
      if (docRes.ok && docRes.value) {
        const val = docRes.value;
        if (typeof val.documentId === 'string') nextDocId = val.documentId;
        else if (typeof val.id === 'string') nextDocId = val.id;
        if (typeof val.revision === 'string') nextRev = val.revision;
        else if (typeof val.currentRevision === 'string') nextRev = val.currentRevision;

        const sources = Array.isArray(val.sources) ? (val.sources as Array<{ id?: string; document?: { page?: number } }>) : [];
        sources.forEach((src, idx) => {
          if (!src.id) return;
          nextPageMap.set(src.id, Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1);
        });
      }
      setPageMap(nextPageMap);

      const annotItems = annotRes.ok && Array.isArray(annotRes.value?.items)
        ? (annotRes.value.items as AnnotationItem[])
        : [];

      if (annotRes.ok && typeof annotRes.value?.documentId === 'string') {
        nextDocId = annotRes.value.documentId;
      }
      if (annotRes.ok && typeof annotRes.value?.revision === 'string') {
        nextRev = annotRes.value.revision;
      }
      if (!nextRev && marksRes.ok && typeof marksRes.value?.revision === 'string') {
        nextRev = marksRes.value.revision;
      }
      setResolvedDocId(nextDocId);
      setResolvedRevision(nextRev);

      const staleList = annotRes.ok && Array.isArray(annotRes.value?.stale)
        ? (annotRes.value.stale as Array<{ count?: number }>)
        : [];
      const nextStaleAnnotCount = staleList.reduce((sum, s) => sum + Number(s.count ?? 0), 0);
      setStaleAnnotCount(nextStaleAnnotCount);
      setAnnotations(annotItems);
      setAnnotIndex(0);
      applyMarksResponse(marksRes.ok ? marksRes.value : undefined);
      setMarkIndex(0);
      setLoading(false);
    };

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [host, documentId, sourceId, revision, applyMarksResponse]);

  const staleSummary = useMemo(() => {
    if (staleAnnotCount <= 0 && staleMarkCount <= 0) return null;
    return t(
      lang,
      `旧版本另有 ${staleAnnotCount} 条批注 / ${staleMarkCount} 条标记`,
      `Older revisions: ${staleAnnotCount} annotations / ${staleMarkCount} marks`,
    );
  }, [lang, staleAnnotCount, staleMarkCount]);

  const selectedAnnotation = annotations[annotIndex];
  const selectedMark = marks[markIndex];

  const buildTargetArgs = useCallback(
    (): Record<string, unknown> => ({
      ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(resolvedRevision ? { revision: resolvedRevision } : {}),
    }),
    [resolvedDocId, sourceId, resolvedRevision],
  );

  const refreshMarks = useCallback(async () => {
    const res = await tryAction<Record<string, unknown>>(host, 'materials.marks.list', buildTargetArgs());
    if (!mountedRef.current || !res.ok) return res;
    if (!resolvedRevision && typeof res.value?.revision === 'string') {
      setResolvedRevision(res.value.revision);
    }
    applyMarksResponse(res.value);
    return res;
  }, [host, buildTargetArgs, resolvedRevision, applyMarksResponse]);

  const handleMarkReread = useCallback(async () => {
    if (!selectedMark || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'materials.marks.seen', {
        ...buildTargetArgs(),
        id: selectedMark.id,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '标记重读失败', 'Failed to mark as reread'), 'error');
        return;
      }
      if (res.value?.status === 'missing') {
        notify(t(lang, '当前版本未找到该标记', 'Mark not found in current revision'), 'info');
        await refreshMarks();
        return;
      }
      await refreshMarks();
      if (!mountedRef.current) return;
      notify(t(lang, '已标记为重读', 'Marked as reread'), 'success');
    } catch (err) {
      if (mountedRef.current) notify(errorMessage(err), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [selectedMark, host, buildTargetArgs, notify, lang, refreshMarks]);

  const handleConfirmAction = useCallback(async () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (action.kind === 'annotation') {
        const res = await tryAction<Record<string, unknown>>(host, 'materials.annotation.delete', {
          ...buildTargetArgs(),
          ids: [action.item.id],
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '删除批注失败', 'Failed to delete annotation'), 'error');
          return;
        }
        setAnnotations((prev) => {
          const next = prev.filter((item) => item.id !== action.item.id);
          setAnnotIndex((idx) => Math.max(0, Math.min(idx, next.length - 1)));
          return next;
        });
        notify(t(lang, '已删除批注', 'Annotation deleted'), 'success');
      } else if (action.kind === 'mark') {
        const res = await tryAction<Record<string, unknown>>(host, 'materials.marks.delete', {
          ...buildTargetArgs(),
          ids: [action.item.id],
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '删除标记失败', 'Failed to delete mark'), 'error');
          return;
        }
        await refreshMarks();
        if (!mountedRef.current) return;
        notify(t(lang, '已删除标记', 'Mark deleted'), 'success');
      } else {
        const res = await tryAction<Record<string, unknown>>(host, 'materials.marks.delete', {
          ...buildTargetArgs(),
          stale: true,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '清除旧版本标记失败', 'Failed to purge stale marks'), 'error');
          return;
        }
        const deletedCount = Number(res.value?.deleted ?? action.count);
        await refreshMarks();
        if (!mountedRef.current) return;
        notify(t(lang, `已清除 ${deletedCount} 条旧版本标记`, `Purged ${deletedCount} stale mark(s)`), 'success');
      }
    } catch (err) {
      if (mountedRef.current) notify(errorMessage(err), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [confirmAction, host, buildTargetArgs, notify, lang, refreshMarks]);

  const handleJumpSelection = useCallback(
    (selection: SelectionAnchor | undefined) => {
      const pg = resolveItemPage(selection, pageMap);
      if (pg) {
        onJumpPage(pg);
        onClose();
      } else {
        notify(t(lang, '该条目暂无页码定位信息', 'No page info available for this item'), 'info');
      }
    },
    [pageMap, onJumpPage, onClose, notify, lang],
  );

  const listActive = isActive && !confirmAction && !busy && !loading;
  useClaimKeys(['d', 'j', 'k', 'R', 'S'], listActive);

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      if (input === 'r') {
        const st = useTuiStore.getState();
        onClose();
        st.navigate('review', st.activeRunId ? { runId: st.activeRunId } : {});
      }
    },
    { isActive: isActive && !confirmAction },
  );

  useInput(
    (input, key) => {
      if (key.tab) {
        setTab((prev) => (prev === 'annotations' ? 'marks' : 'annotations'));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input === 'd') {
        if (tab === 'annotations' && selectedAnnotation) {
          setConfirmAction({ kind: 'annotation', item: selectedAnnotation });
        } else if (tab === 'marks' && selectedMark) {
          setConfirmAction({ kind: 'mark', item: selectedMark });
        }
        return;
      }
      if (input === 'R' && tab === 'marks' && selectedMark) {
        void handleMarkReread();
        return;
      }
      if (input === 'S' && tab === 'marks' && staleMarkCount > 0) {
        setConfirmAction({ kind: 'purge-stale-marks', count: staleMarkCount });
      }
    },
    { isActive: listActive },
  );

  const frameW = Math.min(96, Math.max(52, width - 4));
  const frameH = Math.min(30, Math.max(15, height - 2));
  const innerW = modalContentWidth(frameW);
  const tabRows = 2;
  const bodyH = Math.max(6, frameH - 5 - tabRows);

  const modalHints: KeyHint[] = useMemo(() => {
    const items: KeyHint[] = [
      { key: 'Tab', label: t(lang, '切换', 'Tab') },
      { key: 'Enter', label: t(lang, '跳页', 'Jump') },
    ];
    if (tab === 'annotations' && selectedAnnotation) {
      items.push({ key: 'd', label: t(lang, '删除', 'Delete') });
    } else if (tab === 'marks') {
      if (selectedMark) {
        items.push({ key: 'R', label: t(lang, '重读', 'Reread') });
        items.push({ key: 'd', label: t(lang, '删除', 'Delete') });
      }
      if (staleMarkCount > 0) {
        items.push({ key: 'S', label: t(lang, '清旧标', 'Purge stale') });
      }
    }
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [lang, tab, selectedAnnotation, selectedMark, staleMarkCount]);

  const detailMarkdown = useMemo(() => {
    if (tab === 'annotations') {
      if (!selectedAnnotation) return '';
      const pg = resolveItemPage(selectedAnnotation.selection, pageMap);
      return formatAnnotationMarkdown(lang, selectedAnnotation, pg, asciiMode);
    }
    if (!selectedMark) return '';
    const pg = resolveItemPage(selectedMark.selection, pageMap);
    return formatMarkMarkdown(lang, selectedMark, pg, asciiMode);
  }, [tab, selectedAnnotation, selectedMark, pageMap, lang, asciiMode]);

  return (
    <>
      <Modal
        title={t(lang, '批注问答与高亮标记', 'Annotations & Marks')}
        subtitle={title ? truncateDisplay(title, Math.max(12, Math.floor(innerW * 0.4)), ell) : undefined}
        icon={asciiMode ? '*' : '✎'}
        tone="accent"
        width={frameW}
        height={frameH}
        isActive={isActive && !confirmAction}
        onClose={onClose}
        hints={modalHints}
      >
        {/* Tab Strip */}
        <Box height={tabRows} flexDirection="row" alignItems="center" width={innerW} overflow="hidden">
          <Text
            backgroundColor={tab === 'annotations' ? theme.primary : theme.surface}
            color={tab === 'annotations' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
            bold={tab === 'annotations'}
          >
            {` ${t(lang, '批注问答', 'Annotations')} (${annotations.length}) `}
          </Text>
          <Text> </Text>
          <Text
            backgroundColor={tab === 'marks' ? theme.primary : theme.surface}
            color={tab === 'marks' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
            bold={tab === 'marks'}
          >
            {` ${t(lang, '高亮标记', 'Marks')} (${marks.length}) `}
          </Text>
          <Box flexGrow={1} />
          {tab === 'marks' && staleMarkCount > 0 ? (
            <Badge
              label={t(lang, `旧版标记 ${staleMarkCount}`, `Stale: ${staleMarkCount}`)}
              tone="warning"
              variant="outline"
            />
          ) : staleSummary && innerW >= 60 ? (
            <Text color={theme.dim}>{staleSummary}</Text>
          ) : (
            <Badge label={`P.${currentPage}`} tone="info" variant="outline" />
          )}
        </Box>

        {loading ? (
          <Box height={bodyH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, `正在加载批注与标记${ell}`, `Loading annotations & marks${ell}`)} />
          </Box>
        ) : (
          <SplitPane
            width={innerW}
            height={bodyH}
            leftWidth={0.44}
            minLeft={22}
            minRight={26}
            breakpoint={LAYOUT_BP.SPLIT_MODAL}
            narrowMode="stack"
            divider
            left={({ width: lw, height: lh }) =>
              tab === 'annotations' ? (
                annotations.length === 0 ? (
                  <EmptyState
                    title={t(lang, '暂无批注问答', 'No annotations yet')}
                    hint={t(lang, '按 [a] 问 AI 后可按 [s] 保存为批注', 'Press [a] to ask AI, then [s] to save')}
                    width={lw}
                    height={lh}
                  />
                ) : (
                  <VirtualList
                    items={annotations}
                    height={lh}
                    width={lw}
                    selectedIndex={annotIndex}
                    onChange={(idx) => setAnnotIndex(idx)}
                    onSelect={(item) => handleJumpSelection(item.selection)}
                    keyExtractor={(item) => item.id}
                    isActive={listActive}
                    renderItem={(item, ctx) => {
                      const pg = resolveItemPage(item.selection, pageMap);
                      const pgTag = pg ? `P.${pg}` : '';
                      const titleTxt = item.label || item.term || item.question;
                      const maxTitle = Math.max(6, ctx.width - pgTag.length - 4);
                      return (
                        <Box width={ctx.width} height={1}>
                          <Text color={ctx.selected ? theme.primary : theme.dim} bold={ctx.selected}>
                            {ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}
                          </Text>
                          <Text color={ctx.selected ? theme.text : theme.muted} bold={ctx.selected}>
                            {truncateDisplay(titleTxt.replace(/\s+/g, ' '), maxTitle, ell)}
                          </Text>
                          <Box flexGrow={1} />
                          {pgTag ? <Text color={pg === currentPage ? theme.accent : theme.dim}>{pgTag}</Text> : null}
                        </Box>
                      );
                    }}
                  />
                )
              ) : marks.length === 0 ? (
                <EmptyState
                  title={t(lang, '暂无高亮标记', 'No marks yet')}
                  hint={
                    staleMarkCount > 0
                      ? t(
                          lang,
                          `旧版本有 ${staleMarkCount} 条失效标记，按 [S] 清除`,
                          `${staleMarkCount} stale mark(s) from older revisions, press [S] to purge`,
                        )
                      : t(lang, '文档划线、加粗、荧光笔与待出题标记会显示在这里', 'Highlights, underlines & queued passages appear here')
                  }
                  width={lw}
                  height={lh}
                />
              ) : (
                <VirtualList
                  items={marks}
                  height={lh}
                  width={lw}
                  selectedIndex={markIndex}
                  onChange={(idx) => setMarkIndex(idx)}
                  onSelect={(item) => handleJumpSelection(item.selection)}
                  keyExtractor={(item) => item.id}
                  isActive={listActive}
                  renderItem={(item, ctx) => {
                    const icon = (asciiMode ? ASCII_MARK_STYLE_ICON : MARK_STYLE_ICON)[item.style] || (asciiMode ? '-' : '•');
                    const pg = resolveItemPage(item.selection, pageMap);
                    const pgTag = pg ? `P.${pg}` : '';
                    const rereadText = item.rereadAt ? t(lang, '已重读', 'Reread') : '';
                    const rereadTagW = rereadText ? displayWidth(`[${rereadText}]`) + 1 : 0;
                    const pgTagW = pgTag ? displayWidth(pgTag) + 1 : 0;
                    const quote = (item.selection?.quote || markStyleLabel(lang, item.style)).replace(/\s+/g, ' ');
                    const maxQ = Math.max(4, ctx.width - 5 - rereadTagW - pgTagW);
                    return (
                      <Box width={ctx.width} height={1}>
                        <Text color={ctx.selected ? theme.primary : theme.accent} bold={ctx.selected}>
                          {ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}
                          {icon}{' '}
                        </Text>
                        <Text color={ctx.selected ? theme.text : theme.muted} bold={ctx.selected}>
                          {truncateDisplay(quote, maxQ, ell)}
                        </Text>
                        <Box flexGrow={1} />
                        {rereadText ? (
                          <>
                            <Badge label={rereadText} tone="success" variant="outline" />
                            {pgTag ? <Text> </Text> : null}
                          </>
                        ) : null}
                        {pgTag ? <Text color={pg === currentPage ? theme.accent : theme.dim}>{pgTag}</Text> : null}
                      </Box>
                    );
                  }}
                />
              )
            }
            right={({ width: rw, height: rh }) =>
              detailMarkdown ? (
                <MarkdownView
                  markdown={detailMarkdown}
                  width={rw}
                  height={rh}
                  isActive={false}
                  mathUnicode={mathUnicode}
                  ascii={asciiMode}
                />
              ) : (
                <EmptyState
                  title={t(lang, '选择左侧条目查看详情', 'Select an item to preview')}
                  width={rw}
                  height={rh}
                />
              )
            }
          />
        )}
      </Modal>

      {confirmAction ? (
        <ConfirmDialog
          title={
            confirmAction.kind === 'annotation'
              ? t(lang, '删除批注', 'Delete Annotation')
              : confirmAction.kind === 'mark'
                ? t(lang, '删除标记', 'Delete Mark')
                : t(lang, '清除旧版本标记', 'Purge Stale Marks')
          }
          message={
            confirmAction.kind === 'annotation'
              ? t(
                  lang,
                  `确定要删除这条批注吗？「${truncateDisplay(confirmAction.item.question.replace(/\s+/g, ' '), 40, ell)}」`,
                  `Delete this annotation? "${truncateDisplay(confirmAction.item.question.replace(/\s+/g, ' '), 40, ell)}"`,
                )
              : confirmAction.kind === 'mark'
                ? t(
                    lang,
                    `确定要删除这条标记吗？「${truncateDisplay(
                      (confirmAction.item.selection?.quote || markStyleLabel(lang, confirmAction.item.style)).replace(
                        /\s+/g,
                        ' ',
                      ),
                      40,
                      ell,
                    )}」`,
                    `Delete this mark? "${truncateDisplay(
                      (confirmAction.item.selection?.quote || markStyleLabel(lang, confirmAction.item.style)).replace(
                        /\s+/g,
                        ' ',
                      ),
                      40,
                      ell,
                    )}"`,
                  )
                : t(
                    lang,
                    `确定要清除来自旧版本的 ${confirmAction.count} 条失效标记吗？`,
                    `Purge ${confirmAction.count} stale mark(s) from older revisions?`,
                  )
          }
          confirmLabel={
            confirmAction.kind === 'purge-stale-marks'
              ? t(lang, '清除', 'Purge')
              : t(lang, '删除', 'Delete')
          }
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive}
          onConfirm={() => void handleConfirmAction()}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </>
  );
});
