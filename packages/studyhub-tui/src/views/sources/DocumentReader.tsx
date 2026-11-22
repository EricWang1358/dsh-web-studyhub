import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { ScrollView } from '../../components/ScrollView.js';
import { TextInput } from '../../components/TextInput.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { errorMessage, startReview, tryAction } from '../../host/sample-actions.js';
import { wrapDisplay } from '../../render/cjk.js';

const ReaderOutlineDrawer = lazy(() =>
  import('./ReaderOutlineDrawer.js').then((m) => ({ default: m.ReaderOutlineDrawer })),
);
const ReaderNotesDrawer = lazy(() =>
  import('./ReaderNotesDrawer.js').then((m) => ({ default: m.ReaderNotesDrawer })),
);
const MarkPassageModal = lazy(() =>
  import('./MarkPassageModal.js').then((m) => ({ default: m.MarkPassageModal })),
);
const TranslationGlossaryModal = lazy(() =>
  import('./TranslationGlossaryModal.js').then((m) => ({ default: m.TranslationGlossaryModal })),
);

export interface DocumentReaderProps {
  host: HostClient;
  sourceId?: string;
  documentId?: string;
  initialPage?: number;
  initialTitle?: string;
  initialFormat?: string;
  initialCourse?: string;
  totalPagesHint?: number;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
}

type ReaderSubMode =
  | 'read'
  | 'jump'
  | 'search'
  | 'ask-input'
  | 'ask-view'
  | 'translate-view'
  | 'outline'
  | 'notes'
  | 'mark'
  | 'glossary';

interface PageProjection {
  page: number;
  sourceId: string;
  text: string;
  chars: number;
  firstPage: number;
  lastPage: number;
  revision?: string;
  documentId?: string;
  title: string;
  format: string;
}

interface ReadingChapter {
  id: string;
  title: string;
  level: number;
  startPage: number;
  endPage: number;
}

interface RawOutlineDocSource {
  id?: string;
  text?: string;
  document?: {
    page?: number;
    chapter?: { index?: number; title?: string; level?: number };
  };
}

interface RawDocOutlineEntry {
  title?: string;
  level?: number;
  anchor?: { sourceId?: string };
}

const DOC_HEADING_RE = /^ {0,3}(#{1,4})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const DOC_FENCE_RE = /^ {0,3}(?:```|~~~)/;

function finalizeChapterRanges(
  rawRows: Array<{ id: string; title: string; level: number; page: number }>,
  totalPages: number,
): ReadingChapter[] {
  return rawRows
    .filter((r) => r.id && Number.isFinite(r.page))
    .map((row, idx, arr) => {
      const startPage = Math.max(1, Math.floor(row.page));
      let nextSiblingPage: number | null = null;
      for (let j = idx + 1; j < arr.length; j += 1) {
        if (arr[j].level <= row.level) {
          nextSiblingPage = Math.max(1, Math.floor(arr[j].page));
          break;
        }
      }
      const endPage =
        nextSiblingPage !== null
          ? nextSiblingPage > startPage
            ? nextSiblingPage - 1
            : startPage
          : Math.max(startPage, totalPages);
      return {
        id: row.id,
        title: row.title.trim(),
        level: row.level,
        startPage,
        endPage: Math.max(startPage, endPage),
      };
    });
}

function extractChaptersFromDocument(
  docVal: Record<string, unknown>,
  totalPagesHint: number,
  lang: 'zh' | 'en',
): ReadingChapter[] {
  const sources = Array.isArray(docVal.sources) ? (docVal.sources as RawOutlineDocSource[]) : [];
  const pageMap = new Map<string, number>();
  let maxPage = Math.max(1, totalPagesHint, sources.length);
  sources.forEach((src, idx) => {
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    if (src.id) pageMap.set(src.id, pg);
    if (pg > maxPage) maxPage = pg;
  });

  const outlineObj = docVal.outline as { entries?: RawDocOutlineEntry[] } | undefined;
  if (outlineObj && Array.isArray(outlineObj.entries) && outlineObj.entries.length > 0) {
    const raw = outlineObj.entries.map((entry, idx) => ({
      id: `ai-${idx}`,
      title: String(entry.title ?? ''),
      level: Number(entry.level) || 1,
      page: entry.anchor?.sourceId ? (pageMap.get(entry.anchor.sourceId) ?? 1) : 1,
    }));
    return finalizeChapterRanges(raw, maxPage);
  }

  // Fallback 1: Markdown headings across sources (matches ReaderOutlineDrawer)
  const mdRows: Array<{ id: string; title: string; level: number; page: number }> = [];
  sources.forEach((src, idx) => {
    if (typeof src.text !== 'string' || !src.text) return;
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    let inFence = false;
    let seq = 0;
    for (const rawLine of src.text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (DOC_FENCE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = DOC_HEADING_RE.exec(line);
      if (!m) continue;
      const heading = m[2].replace(/\s+/g, ' ').trim();
      if (!heading) continue;
      seq += 1;
      mdRows.push({
        id: `md-${pg}-${seq}`,
        title: heading,
        level: Math.min(3, m[1].length),
        page: pg,
      });
    }
  });
  if (mdRows.length > 0) {
    return finalizeChapterRanges(mdRows, maxPage);
  }

  // Fallback 2: Converted book document.chapter stamps across sources
  const chapterGroups = new Map<number, { index: number; title: string; level: number; startPage: number; endPage: number }>();
  sources.forEach((src, idx) => {
    const ch = src.document?.chapter;
    const index = Number.isInteger(ch?.index) ? Number(ch?.index) : -1;
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    if (!chapterGroups.has(index)) {
      chapterGroups.set(index, {
        index,
        title: index < 0 ? t(lang, '卷首', 'Front Matter') : String(ch?.title ?? '').trim() || `Ch.${index}`,
        level: index < 0 ? 1 : Number(ch?.level) || 1,
        startPage: pg,
        endPage: pg,
      });
    } else {
      const g = chapterGroups.get(index)!;
      g.startPage = Math.min(g.startPage, pg);
      g.endPage = Math.max(g.endPage, pg);
    }
  });
  if (chapterGroups.size > 1 || (chapterGroups.size === 1 && !chapterGroups.has(-1))) {
    return [...chapterGroups.values()]
      .sort((a, b) => a.startPage - b.startPage || a.index - b.index)
      .map((g) => ({
        id: g.index < 0 ? 'chapter-front' : `chapter-${g.index}`,
        title: g.title,
        level: g.level,
        startPage: g.startPage,
        endPage: g.endPage,
      }));
  }

  return [];
}

function parsePageRange(pagesStr: unknown, fallbackTotal: number): { first: number; last: number } {
  if (typeof pagesStr === 'string') {
    const m = pagesStr.match(/^(\d+)-(\d+)$/);
    if (m) return { first: Number(m[1]), last: Number(m[2]) };
  }
  return { first: 1, last: Math.max(1, fallbackTotal) };
}

export const DocumentReader = memo(function DocumentReader({
  host,
  sourceId,
  documentId,
  initialPage = 1,
  initialTitle = '',
  initialFormat = 'text',
  initialCourse,
  totalPagesHint = 1,
  width,
  height,
  isActive,
  onClose,
}: DocumentReaderProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const [currentPage, setCurrentPage] = useState(Math.max(1, initialPage));
  // Memory NFR: hold ONLY the currently viewed page window locally, cleared on unmount.
  const [pageData, setPageData] = useState<PageProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [subMode, setSubMode] = useState<ReaderSubMode>('read');
  const [jumpInput, setJumpInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [searchHits, setSearchHits] = useState<Array<{ sourceId: string; page?: number; snippet: string }>>([]);

  const [askQuestion, setAskQuestion] = useState('');
  const {
    text: aiAnswer,
    push: pushAiAnswer,
    set: setAiAnswer,
    finish: finishAiAnswer,
    reset: resetAiAnswer,
  } = useStreamingBuffer();
  const [aiBusy, setAiBusy] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const {
    text: translationText,
    push: pushTranslation,
    set: setTranslationText,
    finish: finishTranslation,
    reset: resetTranslation,
  } = useStreamingBuffer();
  const [translateBusy, setTranslateBusy] = useState(false);
  const [pageScrollTop, setPageScrollTop] = useState(0);

  const [chapters, setChapters] = useState<ReadingChapter[]>([]);
  const [readChapterIds, setReadChapterIds] = useState<Set<string>>(() => new Set());
  const [outlineRefreshTick, setOutlineRefreshTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const readingBusyRef = useRef(false);
  const readingTargetRef = useRef<{ documentId?: string; sourceId?: string; revision?: string }>({});

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  // Clear local page/drawer buffers and abort any active AI stream on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortInFlight();
      setPageData(null);
      setSearchHits([]);
      setChapters([]);
      setReadChapterIds(new Set());
      setSubMode('read');
      setSavingNote(false);
    };
  }, [abortInFlight]);

  // Reset page when target source/document changes.
  useEffect(() => {
    setCurrentPage(Math.max(1, initialPage));
  }, [sourceId, documentId, initialPage]);

  // Abort any in-flight AI stream and reset coalesced buffers on page or document change.
  useEffect(() => {
    abortInFlight();
    setAiBusy(false);
    setTranslateBusy(false);
    resetAiAnswer();
    resetTranslation();
  }, [sourceId, documentId, currentPage, abortInFlight, resetAiAnswer, resetTranslation]);

  // Load current page window on demand.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPageScrollTop(0);

    const loadPage = async () => {
      let docMeta: { documentId?: string; revision?: string; title?: string; format?: string; totalPages?: number } = {};

      if (documentId || sourceId) {
        const metaRes = await tryAction<Record<string, unknown>>(host, 'materials.document.get', {
          ...(documentId ? { documentId } : {}),
          ...(sourceId ? { sourceId } : {}),
        });
        if (metaRes.ok && metaRes.value) {
          docMeta = {
            documentId: typeof metaRes.value.id === 'string' ? metaRes.value.id : documentId,
            revision:
              typeof metaRes.value.currentRevision === 'string'
                ? metaRes.value.currentRevision
                : typeof metaRes.value.revision === 'string'
                  ? metaRes.value.revision
                  : undefined,
            title: typeof metaRes.value.title === 'string' ? metaRes.value.title : undefined,
            format: typeof metaRes.value.format === 'string' ? metaRes.value.format : undefined,
          };
        }
      }

      const targetFrom = currentPage;
      const pagesRes = await tryAction<Record<string, unknown>>(host, 'source.pages', {
        ...(docMeta.documentId ? { documentId: docMeta.documentId } : documentId ? { documentId } : {}),
        ...(sourceId && !docMeta.documentId && !documentId ? { sourceId } : {}),
        from: targetFrom,
        to: targetFrom,
      });

      if (cancelled) return;

      if (pagesRes.ok && pagesRes.value) {
        const val = pagesRes.value;
        const shown = Array.isArray(val.shown) ? (val.shown as Array<Record<string, unknown>>) : [];
        const firstShown = shown[0];
        const { first, last } = parsePageRange(val.pages, Math.max(totalPagesHint, targetFrom));
        if (firstShown) {
          setPageData({
            page: Number(firstShown.page ?? targetFrom),
            sourceId: String(firstShown.sourceId ?? sourceId ?? ''),
            text: String(firstShown.text ?? ''),
            chars: Number(firstShown.chars ?? 0),
            firstPage: first,
            lastPage: last,
            revision: docMeta.revision,
            documentId: docMeta.documentId || (typeof val.documentId === 'string' ? val.documentId : documentId),
            title: docMeta.title || String(val.title || initialTitle || '文档阅读'),
            format: docMeta.format || initialFormat,
          });
          setLoading(false);
          return;
        }
      }

      // Fallback to source.get for single-source or non-paged items
      const fallbackId = sourceId;
      if (fallbackId) {
        const getRes = await tryAction<Record<string, unknown>>(host, 'source.get', {
          id: fallbackId,
          offset: 0,
          limit: 20000,
        });
        if (cancelled) return;
        if (getRes.ok && getRes.value) {
          const val = getRes.value;
          setPageData({
            page: 1,
            sourceId: String(val.id ?? fallbackId),
            text: String(val.text ?? ''),
            chars: Number(val.chars ?? 0),
            firstPage: 1,
            lastPage: 1,
            revision: docMeta.revision,
            documentId: docMeta.documentId || documentId,
            title: docMeta.title || String(val.title || initialTitle || '文档阅读'),
            format: docMeta.format || initialFormat,
          });
          setLoading(false);
          return;
        }
      }

      setLoadError(
        pagesRes.error?.message ||
          t(lang, '无法读取该页内容', 'Unable to load this page'),
      );
      setLoading(false);
    };

    void loadPage();
    return () => {
      cancelled = true;
    };
  }, [host, documentId, sourceId, currentPage, initialTitle, initialFormat, totalPagesHint, lang]);

  // Load outline chapters + Web-parity reading progress (fail-soft for legacy or un-outlined sources).
  useEffect(() => {
    let cancelled = false;
    if (!documentId && !sourceId) {
      setChapters([]);
      setReadChapterIds(new Set());
      return;
    }

    const loadOutlineAndReading = async () => {
      try {
        const metaRes = await tryAction<Record<string, unknown>>(host, 'materials.document.get', {
          ...(documentId ? { documentId } : {}),
          ...(sourceId ? { sourceId } : {}),
        });
        if (cancelled || !mountedRef.current) return;
        if (!metaRes.ok || !metaRes.value) {
          setChapters([]);
          setReadChapterIds(new Set());
          return;
        }

        const val = metaRes.value;
        const resolvedDocId =
          typeof val.documentId === 'string'
            ? val.documentId
            : typeof val.id === 'string'
              ? val.id
              : documentId;
        const resolvedRev =
          typeof val.revision === 'string'
            ? val.revision
            : typeof val.currentRevision === 'string'
              ? val.currentRevision
              : undefined;
        const sources = Array.isArray(val.sources) ? (val.sources as RawOutlineDocSource[]) : [];
        const resolvedSrcId = sourceId || (typeof sources[0]?.id === 'string' ? sources[0].id : undefined);

        readingTargetRef.current = {
          documentId: resolvedDocId,
          sourceId: resolvedSrcId,
          revision: resolvedRev,
        };

        const extracted = extractChaptersFromDocument(val, totalPagesHint, lang);
        setChapters(extracted);

        if (extracted.length === 0) {
          setReadChapterIds(new Set());
          return;
        }

        const chapterRefs = extracted.map(({ id, title, startPage, endPage }) => ({
          id,
          title,
          startPage,
          endPage,
        }));
        const readRes = await tryAction<{ read?: unknown[] }>(host, 'materials.reading.get', {
          ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
          ...(resolvedSrcId ? { sourceId: resolvedSrcId } : {}),
          ...(resolvedRev ? { revision: resolvedRev } : {}),
          chapters: chapterRefs,
        });
        if (cancelled || !mountedRef.current) return;
        if (readRes.ok && Array.isArray(readRes.value?.read)) {
          setReadChapterIds(new Set(readRes.value.read.filter((id): id is string => typeof id === 'string')));
        } else {
          setReadChapterIds(new Set());
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setReadChapterIds(new Set());
        }
      }
    };

    void loadOutlineAndReading();
    return () => {
      cancelled = true;
    };
  }, [host, documentId, sourceId, totalPagesHint, outlineRefreshTick, lang]);

  const activePageNum = pageData?.page ?? currentPage;
  const currentChapter = useMemo(() => {
    if (chapters.length === 0) return null;
    let match: ReadingChapter | null = null;
    for (const ch of chapters) {
      if (activePageNum >= ch.startPage && activePageNum <= ch.endPage) {
        match = ch;
      }
    }
    return match;
  }, [chapters, activePageNum]);

  const readCount = useMemo(
    () => chapters.reduce((acc, ch) => (readChapterIds.has(ch.id) ? acc + 1 : acc), 0),
    [chapters, readChapterIds],
  );
  const currentChapterRead = Boolean(currentChapter && readChapterIds.has(currentChapter.id));

  const toggleChapterRead = useCallback(
    async (
      chapter: { id: string; title: string; startPage: number; endPage: number },
      overrideChapters?: Array<{ id: string; title: string; startPage: number; endPage: number }>,
    ) => {
      if (readingBusyRef.current) return;
      const docId = pageData?.documentId || readingTargetRef.current.documentId || documentId;
      const srcId = pageData?.sourceId || readingTargetRef.current.sourceId || sourceId;
      const rev = pageData?.revision || readingTargetRef.current.revision;
      if (!docId && !srcId) {
        notify(t(lang, '缺少文档标识，无法保存阅读进度', 'Missing document identifier'), 'warning');
        return;
      }

      const wasRead = readChapterIds.has(chapter.id);
      const nextRead = !wasRead;
      const prevSet = readChapterIds;

      const optimistic = new Set(prevSet);
      if (nextRead) optimistic.add(chapter.id);
      else optimistic.delete(chapter.id);
      setReadChapterIds(optimistic);
      readingBusyRef.current = true;

      const refPayload = {
        id: chapter.id,
        title: chapter.title,
        startPage: chapter.startPage,
        endPage: chapter.endPage,
      };
      const baseList =
        overrideChapters && overrideChapters.length > 0
          ? overrideChapters
          : chapters.map(({ id, title, startPage, endPage }) => ({ id, title, startPage, endPage }));
      const allRefs = baseList.some((c) => c.id === chapter.id) ? baseList : [...baseList, refPayload];

      try {
        const res = await tryAction<{ read?: unknown[]; saved?: boolean }>(host, 'materials.reading.save', {
          ...(docId ? { documentId: docId } : {}),
          ...(srcId ? { sourceId: srcId } : {}),
          ...(rev ? { revision: rev } : {}),
          chapters: allRefs,
          read: nextRead ? [refPayload] : [],
          unread: nextRead ? [] : [refPayload],
        });
        if (!mountedRef.current) return;
        if (!res.ok || res.value?.saved === false) {
          setReadChapterIds(prevSet);
          notify(
            res.error?.message || t(lang, '保存阅读进度失败', 'Failed to save reading progress'),
            'error',
          );
          return;
        }
        if (Array.isArray(res.value?.read)) {
          setReadChapterIds(new Set(res.value.read.filter((id): id is string => typeof id === 'string')));
        }
        const shortTitle = chapter.title ? ` (${chapter.title.slice(0, 24)})` : '';
        notify(
          nextRead
            ? t(lang, `已标记章节为已读${shortTitle}`, `Marked chapter read${shortTitle}`)
            : t(lang, `已取消章节已读标记${shortTitle}`, `Marked chapter unread${shortTitle}`),
          'success',
        );
      } catch (err) {
        if (mountedRef.current) {
          setReadChapterIds(prevSet);
          notify(errorMessage(err), 'error');
        }
      } finally {
        readingBusyRef.current = false;
      }
    },
    [chapters, documentId, host, lang, notify, pageData, readChapterIds, sourceId],
  );

  const runSearch = useCallback(
    async (query: string) => {
      const q = query.trim();
      setActiveSearch(q);
      setSubMode('read');
      if (!q) {
        setSearchHits([]);
        return;
      }
      const targetIds = pageData?.sourceId ? [pageData.sourceId] : sourceId ? [sourceId] : undefined;
      const res = await tryAction<{ matches?: Array<Record<string, unknown>> }>(host, 'source.search', {
        query: q,
        ...(targetIds && !pageData?.documentId ? { sourceIds: targetIds } : {}),
        limit: 8,
      });
      if (res.ok && res.value && Array.isArray(res.value.matches)) {
        const hits = res.value.matches.map((m) => ({
          sourceId: String(m.id ?? m.sourceId ?? ''),
          page: typeof m.page === 'number' ? m.page : undefined,
          snippet: String(m.snippet ?? m.text ?? '').slice(0, 120),
        }));
        setSearchHits(hits);
        if (hits.length > 0 && hits[0].page && hits[0].page !== currentPage) {
          setCurrentPage(hits[0].page);
        }
      } else {
        setSearchHits([]);
      }
    },
    [host, pageData, sourceId, currentPage],
  );

  const runAskAi = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !pageData) return;
      abortInFlight();
      const ac = new AbortController();
      abortRef.current = ac;
      setSubMode('ask-view');
      setAiBusy(true);
      resetAiAnswer();

      try {
        if (typeof host.streamComplete === 'function') {
          const system = t(
            lang,
            '你是 StudyHub 终端助教。请严格基于提供的当前页面内容回答用户问题；如需补充通用背景，请明确标注。使用简洁 Markdown 输出。',
            'You are the StudyHub terminal tutor. Answer based strictly on the provided page text; clearly mark any general background knowledge. Output concise Markdown.',
          );
          const prompt = `Document: ${pageData.title} (Page ${pageData.page}/${pageData.lastPage})\n\n--- PAGE TEXT ---\n${pageData.text.slice(0, 14000)}\n--- END ---\n\nQuestion: ${q}`;
          const final = await host.streamComplete({
            system,
            prompt,
            signal: ac.signal,
            onChunk: (delta) => {
              if (ac.signal.aborted) return;
              pushAiAnswer(delta);
            },
          });
          if (!ac.signal.aborted) {
            if (final) setAiAnswer(final);
            finishAiAnswer();
          }
        } else {
          const res = await tryAction<Record<string, unknown>>(host, 'materials.selection.ask', {
            scope: 'page',
            selection: {
              ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
              ...(pageData.revision ? { revision: pageData.revision } : {}),
              sourceId: pageData.sourceId,
              page: pageData.page,
            },
            question: q,
          });
          if (!ac.signal.aborted) {
            if (res.ok && res.value) {
              setAiAnswer(String(res.value.answer ?? res.value.message ?? ''));
            } else {
              setAiAnswer(`${asciiMode ? 'x' : '✕'} ${res.error?.message || t(lang, 'AI 回答失败', 'AI request failed')}`);
            }
            finishAiAnswer();
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          setAiAnswer(`${asciiMode ? 'x' : '✕'} ${errorMessage(err)}`);
          finishAiAnswer();
        }
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
          finishAiAnswer();
          if (!ac.signal.aborted) setAiBusy(false);
        } else if (ac.signal.aborted && !abortRef.current) {
          finishAiAnswer();
        }
      }
    },
    [abortInFlight, asciiMode, finishAiAnswer, host, lang, pageData, pushAiAnswer, resetAiAnswer, setAiAnswer],
  );

  const runTranslatePage = useCallback(async () => {
    if (!pageData) return;
    abortInFlight();
    const ac = new AbortController();
    abortRef.current = ac;
    setSubMode('translate-view');
    setTranslateBusy(true);
    resetTranslation();

    try {
      const targetLang = lang === 'en' ? 'English' : '中文';
      if (pageData.documentId) {
        const res = await tryAction<Record<string, unknown>>(host, 'materials.translation.translate', {
          documentId: pageData.documentId,
          scope: { sourceIds: [pageData.sourceId] },
          target: targetLang,
        });
        if (ac.signal.aborted) return;
        if (res.ok && res.value && Array.isArray(res.value.results)) {
          const items = res.value.results as Array<Record<string, unknown>>;
          const translatedLines = items
            .map((entry) => {
              const item = entry.item as Record<string, unknown> | undefined;
              const srcTxt = typeof item?.sourceText === 'string' ? item.sourceText : '';
              const dstTxt = typeof item?.translation === 'string' ? item.translation : typeof entry.text === 'string' ? entry.text : '';
              if (srcTxt && dstTxt) return `> ${srcTxt}\n\n${dstTxt}`;
              return dstTxt || srcTxt;
            })
            .filter(Boolean);
          if (translatedLines.length > 0) {
            setTranslationText(translatedLines.join('\n\n---\n\n'));
            finishTranslation();
            setTranslateBusy(false);
            return;
          }
        }
      }

      if (typeof host.streamComplete === 'function') {
        const system = `Translate the following study material page into ${targetLang}. Keep technical terms accurate and show clear bilingual paragraph pairs (original quote followed by translation).`;
        const final = await host.streamComplete({
          system,
          prompt: pageData.text.slice(0, 12000),
          signal: ac.signal,
          onChunk: (delta) => {
            if (ac.signal.aborted) return;
            pushTranslation(delta);
          },
        });
        if (!ac.signal.aborted) {
          if (final) setTranslationText(final);
          finishTranslation();
        }
      } else {
        setTranslationText(t(lang, '未配置可用的翻译模型，请先在设置中配置模型。', 'No model available for translation. Please configure a model in Settings.'));
        finishTranslation();
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        setTranslationText(`${asciiMode ? 'x' : '✕'} ${errorMessage(err)}`);
        finishTranslation();
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        finishTranslation();
        if (!ac.signal.aborted) setTranslateBusy(false);
      } else if (ac.signal.aborted && !abortRef.current) {
        finishTranslation();
      }
    }
  }, [abortInFlight, asciiMode, finishTranslation, host, lang, pageData, pushTranslation, resetTranslation, setTranslationText]);

  const handlePracticeLinkedCards = useCallback(async () => {
    if (!pageData) return;
    const res = await tryAction<{ cards?: Array<{ deckId: string; cardId: string }> }>(
      host,
      'materials.pages.cards',
      {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
      },
    );
    if (!res.ok) {
      notify(res.error?.message || t(lang, '获取关联题目失败', 'Failed to fetch linked cards'), 'error');
      return;
    }
    const cards = (res.value?.cards ?? []).filter((c) => c.deckId && c.cardId);
    if (cards.length === 0) {
      notify(t(lang, '本页暂无关联卡片', 'No cards linked to this page yet'), 'info');
      return;
    }
    try {
      const run = await startReview(host, {
        mode: 'path',
        scope: cards.map((c) => ({ deckId: c.deckId, cardId: c.cardId })),
      });
      navigate('review', { runId: run.id });
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  }, [host, lang, navigate, notify, pageData]);

  const handleSaveAskToNote = useCallback(async () => {
    if (!pageData || aiBusy || savingNote) return;
    setSavingNote(true);
    try {
      let anchorOffset: number | undefined;
      let selectedExcerpt: string | undefined;
      if (pageScrollTop > 0 && pageData.text) {
        const isSide = (subMode === 'ask-view' || subMode === 'translate-view') && width >= 88;
        const readerW = isSide ? Math.max(24, Math.floor(width * 0.56)) : width;
        const textCols = Math.max(11, readerW - 5);
        const wrapped = wrapDisplay(pageData.text, textCols);
        if (wrapped.length > 0) {
          const lineIdx = Math.min(pageScrollTop, wrapped.length - 1);
          let approx = 0;
          for (let i = 0; i < lineIdx; i += 1) approx += wrapped[i].length;
          const ratioOffset = Math.floor((lineIdx / wrapped.length) * pageData.text.length);
          let offset = Math.min(Math.max(0, Math.min(approx, ratioOffset)), Math.max(0, pageData.text.length - 1));
          const probe = wrapped
            .slice(lineIdx, lineIdx + 3)
            .map((l) => l.trim())
            .find((l) => l.length >= 6);
          if (probe) {
            const needle = probe.slice(0, 32);
            const foundAt = pageData.text.indexOf(needle, Math.max(0, offset - 200));
            if (foundAt >= 0) offset = foundAt;
          }
          const relNonWs = pageData.text.slice(offset).search(/\S/);
          anchorOffset = relNonWs >= 0 ? offset + relNonWs : offset;
          selectedExcerpt = pageData.text.slice(anchorOffset, Math.min(pageData.text.length, anchorOffset + 360));
        }
      }
      const { savePageAskToNote } = await import('./ReaderNotesDrawer.js');
      const result = await savePageAskToNote({
        host,
        lang,
        title: pageData.title,
        page: pageData.page,
        sourceId: pageData.sourceId,
        documentId: pageData.documentId || documentId,
        revision: pageData.revision,
        pageText: pageData.text,
        question: askQuestion,
        answer: aiAnswer,
        course: initialCourse,
        ...(anchorOffset !== undefined ? { anchorOffset } : {}),
        ...(selectedExcerpt !== undefined ? { selectedExcerpt } : {}),
      });
      if (!mountedRef.current) return;
      notify(result.message, result.ok ? 'success' : 'warning');
    } catch (err) {
      if (mountedRef.current) notify(errorMessage(err), 'error');
    } finally {
      if (mountedRef.current) setSavingNote(false);
    }
  }, [pageData, aiBusy, savingNote, pageScrollTop, subMode, width, host, lang, documentId, askQuestion, aiAnswer, initialCourse, notify]);

  const isTyping = subMode === 'jump' || subMode === 'search' || subMode === 'ask-input';
  const drawerOpen = subMode === 'outline' || subMode === 'notes' || subMode === 'mark' || subMode === 'glossary';
  const readerInputActive = isActive && !drawerOpen;
  const claimedKeys = useMemo(
    () =>
      subMode === 'ask-view'
        ? ['s', 'backspace']
        : ['[', ']', '/', 'g', 'G', 'm', 'M', 'a', 't', 'q', 'p', 'O', 'B', 'H', 'backspace'],
    [subMode],
  );
  useClaimKeys(claimedKeys, readerInputActive && !isTyping);
  useInputCapture(isActive && subMode !== 'read');

  const hints: KeyHint[] = useMemo(() => {
    if (subMode === 'ask-view') {
      return [
        { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
        { key: 's', label: t(lang, '存笔记', 'Save Note') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    const items: KeyHint[] = [
      { key: '[/]', label: t(lang, '翻页', 'Page') },
      { key: 'O', label: t(lang, '目录', 'TOC') },
      { key: 'B', label: t(lang, '批注', 'Notes') },
      { key: 'H', label: t(lang, '标记段落', 'Mark') },
      ...(chapters.length > 0 ? [{ key: 'M', label: t(lang, '已读', 'Read') }] : []),
      { key: 'a', label: t(lang, '问AI', 'Ask') },
      { key: 't', label: t(lang, '翻译', 'Trans') },
      { key: 'G', label: t(lang, '术语译文', 'Glossary') },
      { key: 'g', label: t(lang, '跳页', 'Go') },
      { key: '/', label: t(lang, '搜索', 'Search') },
      { key: 'm', label: t(lang, '公式', 'Math') },
      { key: 'q', label: t(lang, '出题', 'Gen') },
      { key: 'p', label: t(lang, '练题', 'Quiz') },
      { key: 'Esc', label: t(lang, '返回', 'Back') },
    ];
    return items;
  }, [chapters.length, lang, subMode]);
  useFooterHints(hints, readerInputActive);

  useInput(
    (input, key) => {
      if (isTyping || drawerOpen) return;
      if (key.escape || (subMode === 'read' && key.backspace)) {
        if (subMode !== 'read') {
          abortInFlight();
          finishAiAnswer();
          finishTranslation();
          resetAiAnswer();
          resetTranslation();
          setAiBusy(false);
          setTranslateBusy(false);
          setSubMode('read');
        } else {
          abortInFlight();
          resetAiAnswer();
          resetTranslation();
          onClose();
        }
        return;
      }
      if (subMode === 'ask-view') {
        if (input === 's' && !aiBusy) {
          void handleSaveAskToNote();
        }
        return;
      }
      if (subMode !== 'read') return;

      if (input === '[') {
        const first = pageData?.firstPage ?? 1;
        setCurrentPage((p) => Math.max(first, p - 1));
      } else if (input === ']') {
        const last = pageData?.lastPage ?? Math.max(1, totalPagesHint);
        setCurrentPage((p) => Math.min(last, p + 1));
      } else if (input === 'g') {
        setJumpInput(String(currentPage));
        setSubMode('jump');
      } else if (input === '/') {
        setSearchInput(activeSearch);
        setSubMode('search');
      } else if (input === 'm') {
        setPreferences({ mathUnicode: !mathUnicode });
      } else if (input === 'M') {
        if (currentChapter) {
          void toggleChapterRead(currentChapter);
        } else {
          notify(t(lang, '当前页暂无可标记的章节', 'No chapter available to mark on this page'), 'info');
        }
      } else if (input === 'a') {
        setAskQuestion('');
        setSubMode('ask-input');
      } else if (input === 't') {
        void runTranslatePage();
      } else if (input === 'G') {
        setSubMode('glossary');
      } else if (input === 'O') {
        setSubMode('outline');
      } else if (input === 'B') {
        setSubMode('notes');
      } else if (input === 'H') {
        if (!pageData || !pageData.sourceId) {
          notify(t(lang, '当前页内容尚未加载完成', 'Page content not loaded yet'), 'info');
        } else {
          setSubMode('mark');
        }
      } else if (input === 'q') {
        const sid = pageData?.sourceId || sourceId;
        if (sid) {
          navigate('generate', {
            sourceIds: [sid],
            ...(initialCourse ? { course: initialCourse } : {}),
          });
        }
      } else if (input === 'p') {
        void handlePracticeLinkedCards();
      }
    },
    { isActive: readerInputActive },
  );

  const showSide = (subMode === 'ask-view' || subMode === 'translate-view') && width >= 88;
  const showBottom = (subMode === 'ask-view' || subMode === 'translate-view') && width < 88;
  const barRows = isTyping ? 2 : 0;
  const bodyH = Math.max(4, height - 3 - barRows);
  const readerH = showBottom ? Math.max(3, Math.floor(bodyH * 0.52)) : bodyH;
  const auxH = showBottom ? Math.max(3, bodyH - readerH) : bodyH;
  const mainW = showSide ? Math.max(24, Math.floor(width * 0.56)) : width;
  const auxW = showSide ? Math.max(20, width - mainW - 1) : width;

  const pageLabel = pageData
    ? `${t(lang, '第', 'P.')} ${pageData.page} / ${pageData.lastPage} ${t(lang, '页', '')}`
    : `${t(lang, '第', 'P.')} ${currentPage}`;

  const progressPrefix = `${asciiMode ? 'OK' : '✓'} ${readCount}/${chapters.length}`;
  const chapterStateTag = currentChapter
    ? currentChapterRead
      ? t(lang, '已读', 'Read')
      : t(lang, '未读', 'Unread')
    : '';
  const progressBadgeLabel =
    chapterStateTag && width >= 88 ? `${progressPrefix} (${chapterStateTag})` : progressPrefix;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Reader Header */}
      <Box height={1} width={width} paddingX={1}>
        <Badge label={pageData?.format.toUpperCase() || initialFormat.toUpperCase()} tone="primary" />
        <Text> </Text>
        <Text bold color={theme.text} wrap="truncate-end">
          {pageData?.title || initialTitle || t(lang, '资料阅读器', 'Document Reader')}
        </Text>
        <Box flexGrow={1} />
        {chapters.length > 0 ? (
          <>
            <Badge
              label={progressBadgeLabel}
              tone={currentChapterRead ? 'success' : readCount === chapters.length ? 'success' : 'muted'}
              variant="outline"
            />
            <Text> </Text>
          </>
        ) : null}
        <Badge
          label={mathUnicode ? (asciiMode ? 'Unicode' : '∑ Unicode') : 'TeX'}
          tone={mathUnicode ? 'success' : 'muted'}
          variant="outline"
        />
        <Text> </Text>
        <Badge label={pageLabel.trim()} tone="accent" variant="soft" />
      </Box>

      {/* Optional mini input bar for jump / search / ask */}
      {subMode === 'jump' ? (
        <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
          <Text color={theme.primary} bold>
            {t(lang, '跳转到页码: ', 'Go to page: ')}
          </Text>
          <TextInput
            value={jumpInput}
            onChange={setJumpInput}
            onSubmit={(val) => {
              const n = Number.parseInt(val.trim(), 10);
              const lo = pageData?.firstPage ?? 1;
              const hi = pageData?.lastPage ?? Math.max(1, totalPagesHint);
              if (Number.isFinite(n)) setCurrentPage(Math.max(lo, Math.min(hi, n)));
              setSubMode('read');
            }}
            onCancel={() => setSubMode('read')}
            width={16}
            isActive={isActive}
          />
        </Box>
      ) : null}

      {subMode === 'search' ? (
        <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
          <Box flexShrink={0}>
            <Text color={theme.primary} bold>
              {t(lang, '文档内搜索: ', 'Search document: ')}
            </Text>
          </Box>
          <TextInput
            value={searchInput}
            onChange={setSearchInput}
            onSubmit={(val) => void runSearch(val)}
            onCancel={() => setSubMode('read')}
            width={Math.max(16, width - 24)}
            isActive={isActive}
          />
        </Box>
      ) : null}

      {subMode === 'ask-input' ? (
        <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
          <Box flexShrink={0}>
            <Text color={theme.ai} bold>
              {t(lang, '向 AI 提问本页: ', 'Ask AI about this page: ')}
            </Text>
          </Box>
          <TextInput
            value={askQuestion}
            onChange={setAskQuestion}
            onSubmit={(val) => void runAskAi(val)}
            onCancel={() => setSubMode('read')}
            placeholder={t(lang, '例如：用通俗例子解释这一页的核心定理', 'e.g. Explain the main theorem on this page')}
            width={Math.max(20, width - 26)}
            isActive={isActive}
          />
        </Box>
      ) : null}

      {/* Main Content */}
      <Box flexDirection={showSide ? 'row' : 'column'} width={width} height={bodyH} overflow="hidden">
        <Panel
          title={pageLabel.trim()}
          subtitle={activeSearch ? `${asciiMode ? '?' : '🔍'} ${activeSearch} (${searchHits.length})` : undefined}
          width={mainW}
          height={readerH}
          focused={subMode === 'read'}
        >
          {loading ? (
            <Box padding={1}>
              <Spinner label={asciiMode ? t(lang, '正在读取页面内容...', 'Loading page...') : t(lang, '正在读取页面内容…', 'Loading page…')} />
            </Box>
          ) : loadError ? (
            <Box padding={1}>
              <Text color={theme.error}>{loadError}</Text>
            </Box>
          ) : (pageData?.format === 'md' || pageData?.format === 'tex') ? (
            <MarkdownView
              markdown={pageData?.text || t(lang, '（本页暂无可提取文字）', '(No extracted text on this page)')}
              width={Math.max(12, mainW - 4)}
              height={Math.max(2, readerH - 2)}
              isActive={readerInputActive && subMode === 'read'}
              mathUnicode={mathUnicode}
              highlight={activeSearch || undefined}
              scrollTop={pageScrollTop}
              onScroll={setPageScrollTop}
            />
          ) : (
            <ScrollView
              content={pageData?.text || t(lang, '（本页暂无可提取文字）', '(No extracted text on this page)')}
              width={Math.max(12, mainW - 4)}
              height={Math.max(2, readerH - 2)}
              isActive={readerInputActive && subMode === 'read'}
              highlight={activeSearch || undefined}
              scrollTop={pageScrollTop}
              onScroll={setPageScrollTop}
            />
          )}
        </Panel>

        {showSide ? <Box width={1} /> : null}

        {subMode === 'ask-view' ? (
          <Panel
            title={t(lang, 'AI 讲解', 'AI Answer')}
            icon={asciiMode ? '*' : '✦'}
            tone="ai"
            subtitle={
              aiBusy
                ? asciiMode
                  ? t(lang, '生成中... Esc 中止', 'Streaming... Esc abort')
                  : t(lang, '生成中… Esc 中止', 'Streaming… Esc abort')
                : savingNote
                  ? asciiMode
                    ? t(lang, '保存中...', 'Saving...')
                    : t(lang, '保存中…', 'Saving…')
                  : asciiMode
                    ? t(lang, 's 存笔记 - Esc 返回', 's Save Note - Esc Back')
                    : t(lang, 's 存笔记 · Esc 返回', 's Save Note · Esc Back')
            }
            width={auxW}
            height={auxH}
            focused
          >
            <MarkdownView
              markdown={aiAnswer || (aiBusy ? (asciiMode ? t(lang, '_正在思考..._', '_Thinking..._') : t(lang, '_正在思考…_', '_Thinking…_')) : '')}
              width={Math.max(12, auxW - 4)}
              height={Math.max(2, auxH - 2)}
              isActive={readerInputActive && subMode === 'ask-view'}
              mathUnicode={mathUnicode}
              follow={aiBusy}
            />
          </Panel>
        ) : null}

        {subMode === 'translate-view' ? (
          <Panel
            title={t(lang, '双语对照翻译', 'Bilingual Translation')}
            icon="译"
            tone="info"
            subtitle={
              translateBusy
                ? asciiMode
                  ? t(lang, '翻译中... Esc 中止', 'Translating... Esc abort')
                  : t(lang, '翻译中… Esc 中止', 'Translating… Esc abort')
                : t(lang, 'Esc 返回', 'Esc Back')
            }
            width={auxW}
            height={auxH}
            focused
          >
            <MarkdownView
              markdown={translationText || (translateBusy ? (asciiMode ? t(lang, '_正在翻译当前页..._', '_Translating current page..._') : t(lang, '_正在翻译当前页…_', '_Translating current page…_')) : '')}
              width={Math.max(12, auxW - 4)}
              height={Math.max(2, auxH - 2)}
              isActive={readerInputActive && subMode === 'translate-view'}
              mathUnicode={mathUnicode}
              follow={translateBusy}
            />
          </Panel>
        ) : null}
      </Box>

      <Suspense fallback={null}>
        {subMode === 'outline' ? (
          <ReaderOutlineDrawer
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            currentPage={pageData?.page ?? currentPage}
            currentPageText={pageData?.text}
            readChapterIds={readChapterIds}
            onToggleRead={(chapter, allChapters) => void toggleChapterRead(chapter, allChapters)}
            onOutlineSaved={() => setOutlineRefreshTick((n) => n + 1)}
            width={width}
            height={height}
            isActive={isActive}
            onJumpPage={(pg) => {
              const lo = pageData?.firstPage ?? 1;
              const hi = pageData?.lastPage ?? Math.max(pg, totalPagesHint);
              setCurrentPage(Math.max(lo, Math.min(hi, pg)));
            }}
            onClose={() => setSubMode('read')}
          />
        ) : null}

        {subMode === 'notes' ? (
          <ReaderNotesDrawer
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            currentPage={pageData?.page ?? currentPage}
            width={width}
            height={height}
            isActive={isActive}
            onJumpPage={(pg) => {
              const lo = pageData?.firstPage ?? 1;
              const hi = pageData?.lastPage ?? Math.max(pg, totalPagesHint);
              setCurrentPage(Math.max(lo, Math.min(hi, pg)));
            }}
            onClose={() => setSubMode('read')}
          />
        ) : null}

        {subMode === 'mark' ? (
          <MarkPassageModal
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            currentPage={pageData?.page ?? currentPage}
            pageText={pageData?.text ?? ''}
            isActive={isActive}
            onClose={() => setSubMode('read')}
          />
        ) : null}

        {subMode === 'glossary' ? (
          <TranslationGlossaryModal
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            isActive={isActive}
            onClose={() => setSubMode('read')}
          />
        ) : null}
      </Suspense>
    </Box>
  );
});
