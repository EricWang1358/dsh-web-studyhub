import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import { saveTuiPreferences } from '../../host/tui-prefs.js';
import { readWholePage, readWholeSource, type WholeText } from './page-loader.js';
import {
  LAST_READ_DEBOUNCE_MS,
  MAX_LAST_READ_PAGE,
  buildDocKey,
  buildUpdatedLastReadPages,
  extractChaptersFromDocument,
  findChapterForPage,
  parsePageRange,
  type PageProjection,
  type RawOutlineDocSource,
  type ReadingChapter,
} from './reader-model.js';

export interface UseReaderPageStateParams {
  host: HostClient;
  sourceId?: string;
  documentId?: string;
  initialPage: number;
  initialTitle: string;
  initialFormat: string;
  totalPagesHint: number;
  lang: UiLanguage;
}

export function useReaderPageState({
  host,
  sourceId,
  documentId,
  initialPage,
  initialTitle,
  initialFormat,
  totalPagesHint,
  lang,
}: UseReaderPageStateParams) {
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const notify = useTuiStore((s) => s.notify);

  const [currentPage, setCurrentPage] = useState(Math.max(1, initialPage));
  // Memory NFR: hold ONLY the currently viewed page window locally, cleared on unmount.
  const [pageData, setPageData] = useState<PageProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageScrollTop, setPageScrollTop] = useState(0);

  const [chapters, setChapters] = useState<ReadingChapter[]>([]);
  const [readChapterIds, setReadChapterIds] = useState<Set<string>>(() => new Set());
  const [outlineRefreshTick, setOutlineRefreshTick] = useState(0);

  const mountedRef = useRef(true);
  const docGenRef = useRef(0);
  const readingSeqRef = useRef(0);
  const readingBusyRef = useRef(false);
  const readingTargetRef = useRef<{ documentId?: string; sourceId?: string; revision?: string }>({});
  const prevDocTargetRef = useRef(`${documentId ?? ''}|${sourceId ?? ''}`);
  const firstSourceIdRef = useRef<string | undefined>(sourceId);
  const resumeCheckedRef = useRef(false);
  const userNavigatedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistRef = useRef<{ docKey: string; page: number } | null>(null);
  const lastPersistedRef = useRef<{ docKey: string; page: number } | null>(null);

  const clearPersistTimer = useCallback(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  const flushPendingPersist = useCallback(() => {
    clearPersistTimer();
    const pending = pendingPersistRef.current;
    if (!pending) return;
    pendingPersistRef.current = null;
    const { docKey, page } = pending;
    if (!docKey || !Number.isSafeInteger(page) || page < 1 || page > MAX_LAST_READ_PAGE) return;
    if (
      lastPersistedRef.current &&
      lastPersistedRef.current.docKey === docKey &&
      lastPersistedRef.current.page === page
    ) {
      return;
    }
    lastPersistedRef.current = { docKey, page };
    const currentPrefs = useTuiStore.getState().preferences;
    const nextLastReadPages = buildUpdatedLastReadPages(currentPrefs.lastReadPages, docKey, page);
    setPreferences({ lastReadPages: nextLastReadPages });
    const dshHome = (host as { dshHome?: string }).dshHome;
    void saveTuiPreferences(
      { lastReadPages: nextLastReadPages },
      dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
    ).catch(() => {});
  }, [clearPersistTimer, host, setPreferences]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushPendingPersist();
      setPageData(null);
      setChapters([]);
      setReadChapterIds(new Set());
    };
  }, [flushPendingPersist]);

  // Reset page and resume tracking when target source/document changes.
  useEffect(() => {
    flushPendingPersist();
    firstSourceIdRef.current = sourceId;
    resumeCheckedRef.current = false;
    userNavigatedRef.current = false;
    lastPersistedRef.current = null;
    setCurrentPage(Math.max(1, initialPage));
    const nextTarget = `${documentId ?? ''}|${sourceId ?? ''}`;
    if (prevDocTargetRef.current !== nextTarget) {
      prevDocTargetRef.current = nextTarget;
      docGenRef.current += 1;
      readingSeqRef.current += 1;
      readingBusyRef.current = false;
      readingTargetRef.current = {};
      setPageData(null);
      setChapters([]);
      setReadChapterIds(new Set());
    }
  }, [sourceId, documentId, initialPage, flushPendingPersist]);

  // Load current page window on demand.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPageScrollTop(0);

    const loadPage = async () => {
      let docMeta: {
        documentId?: string;
        firstSourceId?: string;
        revision?: string;
        title?: string;
        format?: string;
        totalPages?: number;
      } = {};

      if (documentId || sourceId) {
        const metaRes = await tryAction<Record<string, unknown>>(host, 'materials.document.get', {
          ...(documentId ? { documentId } : {}),
          ...(sourceId ? { sourceId } : {}),
        });
        if (cancelled) return;
        if (metaRes.ok && metaRes.value) {
          const metaSources = Array.isArray(metaRes.value.sources)
            ? (metaRes.value.sources as Array<{ id?: unknown }>)
            : [];
          const metaFirstSourceId = typeof metaSources[0]?.id === 'string' ? metaSources[0].id : undefined;
          if (metaFirstSourceId) {
            firstSourceIdRef.current = metaFirstSourceId;
          }
          docMeta = {
            documentId:
              typeof metaRes.value.documentId === 'string'
                ? metaRes.value.documentId
                : typeof metaRes.value.id === 'string'
                  ? metaRes.value.id
                  : documentId,
            firstSourceId: metaFirstSourceId,
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
      const pageTarget = {
        ...(docMeta.documentId ? { documentId: docMeta.documentId } : documentId ? { documentId } : {}),
        ...(sourceId && !docMeta.documentId && !documentId ? { sourceId } : {}),
      };
      // #1418: a slice that failed to arrive is said out loud at the end of the page.
      const shownText = (whole: WholeText): string => {
        if (!whole.incomplete) return whole.text;
        const note = whole.hitLimit
          ? t(lang, '（这一页太长，这里只显示了前面的部分。）', '(This page is too long; only the first part is shown.)')
          : t(lang, '（后面的内容没有读出来，重新打开这份资料可以重试。）', '(The rest could not be read. Reopen this material to retry.)');
        return `${whole.text}\n\n${note}`;
      };
      const pagesRes = await tryAction<Record<string, unknown>>(host, 'source.pages', {
        ...pageTarget,
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
          const resolvedDocId = docMeta.documentId || (typeof val.documentId === 'string' ? val.documentId : documentId);
          const resolvedFirstSourceId =
            docMeta.firstSourceId || firstSourceIdRef.current || sourceId || String(firstShown.sourceId ?? '');
          const resolvedTitle = docMeta.title || String(val.title || initialTitle || '文档阅读');
          const resolvedDocKey = buildDocKey(resolvedDocId, resolvedFirstSourceId, resolvedTitle);
          const hasExplicitPage = initialPage > 1;
          if (!hasExplicitPage && !resumeCheckedRef.current && !userNavigatedRef.current) {
            resumeCheckedRef.current = true;
            const savedPage = resolvedDocKey
              ? useTuiStore.getState().preferences.lastReadPages?.[resolvedDocKey]
              : undefined;
            if (
              last > 1 &&
              typeof savedPage === 'number' &&
              Number.isSafeInteger(savedPage) &&
              savedPage > 1 &&
              savedPage <= last &&
              savedPage !== targetFrom
            ) {
              lastPersistedRef.current = { docKey: resolvedDocKey, page: savedPage };
              setCurrentPage(savedPage);
              notify(
                t(lang, `已恢复到上次阅读第 ${savedPage} 页`, `Resumed at page ${savedPage}`),
                'info',
              );
              return;
            }
          }
          // #1418: `source.pages` hands out about 6000 characters a call; read the page to its end.
          const wholePage = await readWholePage(
            (sliceArgs) => tryAction<Record<string, unknown>>(host, 'source.pages', { ...pageTarget, ...sliceArgs }),
            val,
            () => cancelled,
          );
          if (cancelled) return;
          setPageData({
            page: Number(firstShown.page ?? targetFrom),
            sourceId: String(firstShown.sourceId ?? sourceId ?? ''),
            text: shownText(wholePage),
            chars: Number(firstShown.chars ?? 0),
            firstPage: first,
            lastPage: last,
            revision: docMeta.revision,
            documentId: resolvedDocId,
            title: resolvedTitle,
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
          const wholeSource = await readWholeSource(
            (sliceArgs) => tryAction<Record<string, unknown>>(host, 'source.get', { id: fallbackId, ...sliceArgs }),
            val,
            () => cancelled,
          );
          if (cancelled) return;
          setPageData({
            page: 1,
            sourceId: String(val.id ?? fallbackId),
            text: shownText(wholeSource),
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
  }, [host, documentId, sourceId, currentPage, initialPage, initialTitle, initialFormat, totalPagesHint, lang, notify]);

  // Debounce-persist last-read page on user navigation (flushed on close/unmount).
  useEffect(() => {
    if (!userNavigatedRef.current) return;
    const totalPages = Math.max(pageData?.lastPage ?? 1, totalPagesHint);
    if (totalPages <= 1) return;
    const docKey = buildDocKey(
      pageData?.documentId || readingTargetRef.current.documentId || documentId,
      firstSourceIdRef.current || sourceId,
      pageData?.title || initialTitle,
    );
    if (!docKey) return;
    const targetPage = currentPage;
    if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_LAST_READ_PAGE) return;
    if (
      lastPersistedRef.current &&
      lastPersistedRef.current.docKey === docKey &&
      lastPersistedRef.current.page === targetPage
    ) {
      pendingPersistRef.current = null;
      clearPersistTimer();
      return;
    }
    pendingPersistRef.current = { docKey, page: targetPage };
    clearPersistTimer();
    persistTimerRef.current = setTimeout(() => {
      flushPendingPersist();
    }, LAST_READ_DEBOUNCE_MS);
  }, [
    clearPersistTimer,
    currentPage,
    documentId,
    flushPendingPersist,
    initialTitle,
    pageData?.documentId,
    pageData?.lastPage,
    pageData?.title,
    sourceId,
    totalPagesHint,
  ]);

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
  const currentChapter = useMemo(() => findChapterForPage(chapters, activePageNum), [chapters, activePageNum]);
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

      const gen = docGenRef.current;
      const reqSeq = ++readingSeqRef.current;
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
        if (!mountedRef.current || gen !== docGenRef.current || reqSeq !== readingSeqRef.current) return;
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
        if (mountedRef.current && gen === docGenRef.current && reqSeq === readingSeqRef.current) {
          setReadChapterIds(prevSet);
          notify(errorMessage(err), 'error');
        }
      } finally {
        if (gen === docGenRef.current && reqSeq === readingSeqRef.current) {
          readingBusyRef.current = false;
        }
      }
    },
    [chapters, documentId, host, lang, notify, pageData, readChapterIds, sourceId],
  );

  const navigateToPage = useCallback(
    (targetPage: number, { allowBeyondHint = false }: { allowBeyondHint?: boolean } = {}) => {
      const lo = pageData?.firstPage ?? 1;
      const hi = pageData?.lastPage ?? Math.max(allowBeyondHint ? targetPage : 1, totalPagesHint);
      userNavigatedRef.current = true;
      setCurrentPage(Math.max(lo, Math.min(hi, targetPage)));
    },
    [pageData?.firstPage, pageData?.lastPage, totalPagesHint],
  );

  const stepPage = useCallback(
    (delta: -1 | 1) => {
      const lo = pageData?.firstPage ?? 1;
      const hi = pageData?.lastPage ?? Math.max(1, totalPagesHint);
      userNavigatedRef.current = true;
      setCurrentPage((p) => Math.max(lo, Math.min(hi, p + delta)));
    },
    [pageData?.firstPage, pageData?.lastPage, totalPagesHint],
  );

  const bumpOutlineRefresh = useCallback(() => {
    setOutlineRefreshTick((n) => n + 1);
  }, []);

  return {
    currentPage,
    pageData,
    loading,
    loadError,
    pageScrollTop,
    setPageScrollTop,
    chapters,
    readChapterIds,
    currentChapter,
    readCount,
    currentChapterRead,
    flushPendingPersist,
    toggleChapterRead,
    navigateToPage,
    stepPage,
    bumpOutlineRefresh,
  };
}
