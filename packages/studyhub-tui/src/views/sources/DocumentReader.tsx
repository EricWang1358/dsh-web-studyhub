import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import {
  buildCachedTranslationState,
  buildReaderFooterHints,
  buildTranslationResultState,
  computeReaderLayout,
  extractPageAnchorSlice,
  normalizeTranslationCounts,
  type PendingTranslateConfirm,
  type ReaderSubMode,
  type TranslateMeta,
  type TranslationListResponse,
  type TranslationTranslateResponse,
} from './reader-model.js';
import { useReaderPageState } from './useReaderPageState.js';
import { useReaderAskActions } from './useReaderAskActions.js';
import {
  ReaderAskPanel,
  ReaderHeader,
  ReaderMiniInputBar,
  ReaderPagePanel,
  ReaderTranslatePanel,
  renderTranslateConfirmMessage,
} from './ReaderAuxPanels.js';
import { ReaderOverlays } from './ReaderOverlays.js';

export { extractPageAnchorSlice };

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

  const [subMode, setSubMode] = useState<ReaderSubMode>('read');
  const [jumpInput, setJumpInput] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const {
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
  } = useReaderPageState({
    host,
    sourceId,
    documentId,
    initialPage,
    initialTitle,
    initialFormat,
    totalPagesHint,
    lang,
  });

  const {
    text: translationText,
    set: setTranslationText,
    finish: finishTranslation,
    reset: resetTranslation,
  } = useStreamingBuffer();
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateTarget, setTranslateTarget] = useState<'zh' | 'en'>(() => (lang === 'en' ? 'en' : 'zh'));
  const [translateMeta, setTranslateMeta] = useState<TranslateMeta | null>(null);
  const [pendingTranslateConfirm, setPendingTranslateConfirm] = useState<PendingTranslateConfirm | null>(null);

  const mountedRef = useRef(true);
  const translateAbortRef = useRef<AbortController | null>(null);
  const translateRequestIdRef = useRef<string | null>(null);
  const translateInFlightRef = useRef(false);
  const translateSeqRef = useRef(0);
  const pageKeyRef = useRef('');
  pageKeyRef.current = pageData ? `${pageData.documentId ?? ''}|${pageData.sourceId}|${pageData.page}` : '';

  const abortTranslateRef = useCallback(() => {
    if (translateAbortRef.current) {
      translateAbortRef.current.abort();
      translateAbortRef.current = null;
    }
  }, []);

  const cancelActiveTranslation = useCallback(() => {
    translateSeqRef.current += 1;
    const reqId = translateRequestIdRef.current;
    translateRequestIdRef.current = null;
    translateInFlightRef.current = false;
    abortTranslateRef();
    if (reqId) {
      void tryAction(host, 'materials.translation.cancel', { requestId: reqId }).catch(() => {});
    }
  }, [abortTranslateRef, host]);

  const handleSearchJumpPage = useCallback(
    (page: number) => {
      navigateToPage(page, { allowBeyondHint: true });
    },
    [navigateToPage],
  );

  const {
    activeSearch,
    searchHits,
    askQuestion,
    setAskQuestion,
    aiAnswer,
    aiBusy,
    savingNote,
    savingCard,
    savedCard,
    setSavedCard,
    runSearch,
    runAskAi,
    handlePracticeLinkedCards,
    handleSaveAskToNote,
    handleSaveAskToCard,
    abortAskInFlight,
    resetAskState,
  } = useReaderAskActions({
    host,
    lang,
    asciiMode,
    pageData,
    documentId,
    sourceId,
    initialCourse,
    currentPage,
    pageScrollTop,
    subMode,
    width,
    setSubMode,
    onSearchJumpPage: handleSearchJumpPage,
    abortAllInFlight: cancelActiveTranslation,
  });

  // Clear local translation buffers and cancel active streams on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveTranslation();
      abortAskInFlight();
      setPendingTranslateConfirm(null);
      setTranslateMeta(null);
      setSubMode('read');
    };
  }, [abortAskInFlight, cancelActiveTranslation]);

  // Abort any in-flight AI / translation stream and reset coalesced buffers on page or document change.
  useEffect(() => {
    cancelActiveTranslation();
    resetAskState(false);
    setTranslateBusy(false);
    setPendingTranslateConfirm(null);
    setTranslateMeta(null);
    resetTranslation();
    setSubMode((m) => (m === 'translate-view' || m === 'ask-view' ? 'read' : m));
  }, [sourceId, documentId, currentPage, cancelActiveTranslation, resetAskState, resetTranslation]);

  const applyTranslationResults = useCallback(
    (resVal: TranslationTranslateResponse, target: 'zh' | 'en') => {
      const next = buildTranslationResultState(resVal, target, lang, asciiMode);
      resetTranslation();
      setTranslationText(next.text);
      setTranslateMeta(next.meta);
      finishTranslation();
    },
    [asciiMode, finishTranslation, lang, resetTranslation, setTranslationText],
  );

  const openTranslatePage = useCallback(
    async (target: 'zh' | 'en', retranslate = false) => {
      if (!pageData || !pageData.sourceId) {
        notify(t(lang, '当前页内容尚未加载完成', 'Page content not loaded yet'), 'info');
        return;
      }
      if (translateInFlightRef.current || translateBusy) return;

      const expectedPageKey = `${pageData.documentId ?? ''}|${pageData.sourceId}|${pageData.page}`;
      const seq = ++translateSeqRef.current;
      translateInFlightRef.current = true;
      setTranslateTarget(target);
      setPendingTranslateConfirm(null);

      const locator = {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
        ...(pageData.revision ? { revision: pageData.revision } : {}),
      };

      try {
        if (!retranslate) {
          const listRes = await tryAction<TranslationListResponse>(host, 'materials.translation.list', {
            ...locator,
            target,
          });
          if (!mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) return;
          if (listRes.ok && listRes.value && Array.isArray(listRes.value.items)) {
            const cached = buildCachedTranslationState(listRes.value.items, pageData.sourceId, target, lang, asciiMode);
            if (cached) {
              resetTranslation();
              setTranslationText(cached.text);
              finishTranslation();
              setTranslateMeta(cached.meta);
              setTranslateBusy(false);
              setSubMode('translate-view');
              return;
            }
          }
        }

        const estRes = await tryAction<TranslationTranslateResponse>(host, 'materials.translation.translate', {
          ...locator,
          scope: { sourceIds: [pageData.sourceId] },
          target,
          estimate: true,
          ...(retranslate ? { retranslate: true } : {}),
        });
        if (!mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) return;

        if (!estRes.ok || !estRes.value) {
          notify(estRes.error?.message || t(lang, '获取翻译估算失败', 'Failed to estimate translation'), 'error');
          return;
        }

        const counts = normalizeTranslationCounts(estRes.value.counts);
        if (counts.toTranslate === 0) {
          if (counts.reused > 0 || counts.cached > 0) {
            const reuseRes = await tryAction<TranslationTranslateResponse>(host, 'materials.translation.translate', {
              ...locator,
              scope: { sourceIds: [pageData.sourceId] },
              target,
              ...(retranslate ? { retranslate: true } : {}),
            });
            if (!mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) return;
            if (reuseRes.ok && reuseRes.value) {
              applyTranslationResults(reuseRes.value, target);
              setSubMode('translate-view');
            } else {
              notify(reuseRes.error?.message || t(lang, '加载译文失败', 'Failed to load translations'), 'error');
            }
            return;
          }

          resetTranslation();
          setTranslationText(
            counts.skipped > 0
              ? t(
                  lang,
                  '本页已是目标语言，无需翻译。',
                  'This page is already in the target language; no translation needed.',
                )
              : t(lang, '本页暂无可翻译段落。', 'No translatable passages on this page.'),
          );
          finishTranslation();
          setTranslateMeta({
            target,
            source: counts.skipped > 0 ? 'skipped' : 'empty',
            cachedCount: 0,
            freshCount: 0,
            reusedCount: 0,
            skippedCount: counts.skipped,
            rejectedCount: 0,
            outdatedCount: 0,
          });
          setTranslateBusy(false);
          setSubMode('translate-view');
          return;
        }

        setPendingTranslateConfirm({
          target,
          retranslate,
          counts,
          estimate: estRes.value.estimate ?? null,
          modelAvailable: estRes.value.modelAvailable !== false,
        });
      } catch (err) {
        if (mountedRef.current && seq === translateSeqRef.current) {
          notify(errorMessage(err), 'error');
        }
      } finally {
        if (seq === translateSeqRef.current) {
          translateInFlightRef.current = false;
        }
      }
    },
    [
      applyTranslationResults,
      asciiMode,
      finishTranslation,
      host,
      lang,
      notify,
      pageData,
      resetTranslation,
      setTranslationText,
      translateBusy,
    ],
  );

  const executeConfirmedTranslate = useCallback(
    async (confirm: PendingTranslateConfirm) => {
      if (!pageData || !pageData.sourceId || translateInFlightRef.current) return;
      const expectedPageKey = `${pageData.documentId ?? ''}|${pageData.sourceId}|${pageData.page}`;
      const seq = ++translateSeqRef.current;
      const requestId = `tui-tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setPendingTranslateConfirm(null);
      abortAskInFlight();
      abortTranslateRef();
      const ac = new AbortController();
      translateAbortRef.current = ac;
      translateRequestIdRef.current = requestId;
      translateInFlightRef.current = true;
      setTranslateTarget(confirm.target);
      setTranslateMeta(null);
      setSubMode('translate-view');
      setTranslateBusy(true);
      resetTranslation();

      const locator = {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
        ...(pageData.revision ? { revision: pageData.revision } : {}),
      };

      try {
        const res = await tryAction<TranslationTranslateResponse>(host, 'materials.translation.translate', {
          ...locator,
          scope: { sourceIds: [pageData.sourceId] },
          target: confirm.target,
          ...(confirm.retranslate ? { retranslate: true } : {}),
          requestId,
        });
        if (ac.signal.aborted || !mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) {
          return;
        }
        if (res.ok && res.value) {
          if (res.value.status === 'unavailable') {
            setTranslationText(
              res.value.message ||
                t(
                  lang,
                  '未配置可用的翻译模型，请先在设置中配置模型。',
                  'No model available for translation. Please configure a model in Settings.',
                ),
            );
            setTranslateMeta({
              target: confirm.target,
              source: 'unavailable',
              cachedCount: 0,
              freshCount: 0,
              reusedCount: 0,
              skippedCount: 0,
              rejectedCount: 0,
              outdatedCount: 0,
            });
            finishTranslation();
          } else {
            applyTranslationResults(res.value, confirm.target);
          }
        } else {
          setTranslationText(`${asciiMode ? 'x' : '✕'} ${res.error?.message || t(lang, '翻译失败', 'Translation failed')}`);
          setTranslateMeta({
            target: confirm.target,
            source: 'error',
            cachedCount: 0,
            freshCount: 0,
            reusedCount: 0,
            skippedCount: 0,
            rejectedCount: 0,
            outdatedCount: 0,
          });
          finishTranslation();
        }
      } catch (err) {
        if (!ac.signal.aborted && mountedRef.current && seq === translateSeqRef.current) {
          setTranslationText(`${asciiMode ? 'x' : '✕'} ${errorMessage(err)}`);
          setTranslateMeta({
            target: confirm.target,
            source: 'error',
            cachedCount: 0,
            freshCount: 0,
            reusedCount: 0,
            skippedCount: 0,
            rejectedCount: 0,
            outdatedCount: 0,
          });
          finishTranslation();
        }
      } finally {
        if (translateRequestIdRef.current === requestId) {
          translateRequestIdRef.current = null;
        }
        if (seq === translateSeqRef.current) {
          translateInFlightRef.current = false;
        }
        if (translateAbortRef.current === ac) {
          translateAbortRef.current = null;
          finishTranslation();
          if (!ac.signal.aborted && mountedRef.current) {
            setTranslateBusy(false);
          }
        } else if (ac.signal.aborted && !translateAbortRef.current) {
          finishTranslation();
        }
      }
    },
    [
      abortAskInFlight,
      abortTranslateRef,
      applyTranslationResults,
      asciiMode,
      finishTranslation,
      host,
      lang,
      pageData,
      resetTranslation,
      setTranslationText,
    ],
  );

  const isTyping = subMode === 'jump' || subMode === 'search' || subMode === 'ask-input';
  const drawerOpen = subMode === 'outline' || subMode === 'notes' || subMode === 'mark' || subMode === 'glossary';
  const readerInputActive = isActive && !drawerOpen && !pendingTranslateConfirm;
  const claimedKeys = useMemo(
    () =>
      subMode === 'ask-view'
        ? ['s', 'f', 'backspace']
        : subMode === 'translate-view'
          ? ['L', 'R', 'backspace']
          : ['[', ']', '/', 'g', 'G', 'm', 'M', 'a', 't', 'Q', 'p', 'O', 'B', 'H', 'backspace'],
    [subMode],
  );
  useClaimKeys(claimedKeys, readerInputActive && !isTyping);
  useInputCapture(isActive && (isTyping || drawerOpen || Boolean(pendingTranslateConfirm)));

  const hints: KeyHint[] = useMemo(
    () =>
      buildReaderFooterHints({
        subMode,
        lang,
        savedCard,
        translateTarget,
        hasChapters: chapters.length > 0,
      }),
    [chapters.length, lang, savedCard, subMode, translateTarget],
  );
  useFooterHints(hints, readerInputActive);

  useInput(
    (input, key) => {
      if (isTyping || drawerOpen || pendingTranslateConfirm) return;
      if (key.escape || (subMode === 'read' && key.backspace)) {
        if (subMode !== 'read') {
          cancelActiveTranslation();
          resetAskState(true);
          finishTranslation();
          resetTranslation();
          setTranslateMeta(null);
          setTranslateBusy(false);
          setSubMode('read');
        } else {
          flushPendingPersist();
          cancelActiveTranslation();
          resetAskState(false);
          resetTranslation();
          onClose();
        }
        return true;
      }
      if (subMode === 'ask-view') {
        if (input === 's' && !aiBusy) {
          void handleSaveAskToNote();
        } else if (input === 'f' && !aiBusy) {
          void handleSaveAskToCard();
        }
        return;
      }
      if (subMode === 'translate-view') {
        if (input === 'L' && !translateBusy && !translateInFlightRef.current) {
          const nextTarget: 'zh' | 'en' = translateTarget === 'zh' ? 'en' : 'zh';
          void openTranslatePage(nextTarget, false);
        } else if (input === 'R' && !translateBusy && !translateInFlightRef.current) {
          void openTranslatePage(translateTarget, true);
        }
        return;
      }
      if (subMode !== 'read') return;

      if (input === '[') {
        stepPage(-1);
      } else if (input === ']') {
        stepPage(1);
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
        setSavedCard(false);
        setSubMode('ask-input');
      } else if (input === 't') {
        void openTranslatePage(translateTarget, false);
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
      } else if (input === 'Q') {
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

  const { showSide, bodyH, readerH, auxH, mainW, auxW } = computeReaderLayout({
    width,
    height,
    subMode,
    isTyping,
  });

  const pageLabel = pageData
    ? `${t(lang, '第', 'P.')} ${pageData.page} / ${pageData.lastPage} ${t(lang, '页', '')}`
    : `${t(lang, '第', 'P.')} ${currentPage}`;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <ReaderHeader
        width={width}
        lang={lang}
        asciiMode={asciiMode}
        mathUnicode={mathUnicode}
        format={pageData?.format || initialFormat}
        title={pageData?.title || initialTitle}
        pageLabel={pageLabel}
        chaptersCount={chapters.length}
        readCount={readCount}
        currentChapter={currentChapter}
        currentChapterRead={currentChapterRead}
      />

      <ReaderMiniInputBar
        subMode={subMode}
        width={width}
        lang={lang}
        isActive={isActive}
        jumpInput={jumpInput}
        onChangeJump={setJumpInput}
        onSubmitJump={(val) => {
          const n = Number.parseInt(val.trim(), 10);
          if (Number.isFinite(n)) {
            navigateToPage(n);
          }
          setSubMode('read');
        }}
        searchInput={searchInput}
        onChangeSearch={setSearchInput}
        onSubmitSearch={(val) => void runSearch(val)}
        askQuestion={askQuestion}
        onChangeAsk={setAskQuestion}
        onSubmitAsk={(val) => void runAskAi(val)}
        onCancel={() => setSubMode('read')}
      />

      <Box flexDirection={showSide ? 'row' : 'column'} width={width} height={bodyH} overflow="hidden">
        <ReaderPagePanel
          pageLabel={pageLabel}
          activeSearch={activeSearch}
          searchHitsCount={searchHits.length}
          pageData={pageData}
          loading={loading}
          loadError={loadError}
          width={mainW}
          height={readerH}
          focused={subMode === 'read'}
          isActive={readerInputActive && subMode === 'read'}
          lang={lang}
          asciiMode={asciiMode}
          mathUnicode={mathUnicode}
          pageScrollTop={pageScrollTop}
          onScroll={setPageScrollTop}
        />

        {showSide ? <Box width={1} /> : null}

        {subMode === 'ask-view' ? (
          <ReaderAskPanel
            width={auxW}
            height={auxH}
            lang={lang}
            asciiMode={asciiMode}
            mathUnicode={mathUnicode}
            aiBusy={aiBusy}
            savingNote={savingNote}
            savingCard={savingCard}
            savedCard={savedCard}
            askQuestion={askQuestion}
            aiAnswer={aiAnswer}
            isActive={readerInputActive && subMode === 'ask-view'}
          />
        ) : null}

        {subMode === 'translate-view' ? (
          <ReaderTranslatePanel
            width={auxW}
            height={auxH}
            lang={lang}
            asciiMode={asciiMode}
            mathUnicode={mathUnicode}
            translateBusy={translateBusy}
            translateMeta={translateMeta}
            translationText={translationText}
            isActive={readerInputActive && subMode === 'translate-view' && !translateBusy}
          />
        ) : null}
      </Box>

      {pendingTranslateConfirm ? (
        <ConfirmDialog
          title={
            pendingTranslateConfirm.retranslate
              ? t(lang, '确认重新翻译本页', 'Confirm Page Retranslation')
              : t(lang, '确认翻译本页', 'Confirm Page Translation')
          }
          message={renderTranslateConfirmMessage(pendingTranslateConfirm, lang, theme)}
          confirmLabel={t(lang, '开始翻译', 'Translate')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={Math.min(62, Math.max(40, width - 4))}
          onConfirm={() => void executeConfirmedTranslate(pendingTranslateConfirm)}
          onCancel={() => setPendingTranslateConfirm(null)}
          isActive={isActive}
        />
      ) : null}

      <ReaderOverlays
        host={host}
        subMode={subMode}
        pageData={pageData}
        documentId={documentId}
        sourceId={sourceId}
        initialTitle={initialTitle}
        currentPage={currentPage}
        readChapterIds={readChapterIds}
        width={width}
        height={height}
        isActive={isActive}
        onToggleRead={(chapter, allChapters) => void toggleChapterRead(chapter, allChapters)}
        onOutlineSaved={bumpOutlineRefresh}
        onJumpPage={(pg) => navigateToPage(pg, { allowBeyondHint: true })}
        onCloseOverlay={() => setSubMode('read')}
      />
    </Box>
  );
});
