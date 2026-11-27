import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { useAiConversation } from '../../components/useAiConversation.js';
import { isAiStreamingAvailable } from '../../host/ai-dialogue.js';
import { errorMessage, startReview, tryAction } from '../../host/sample-actions.js';
import {
  computeScrollAnchorExcerpt,
  extractPageAnchorSlice,
  type PageProjection,
  type ReaderSubMode,
  type SearchHit,
} from './reader-model.js';

export interface UseReaderAskActionsParams {
  host: HostClient;
  lang: UiLanguage;
  asciiMode: boolean;
  pageData: PageProjection | null;
  documentId?: string;
  sourceId?: string;
  initialCourse?: string;
  currentPage: number;
  pageScrollTop: number;
  subMode: ReaderSubMode;
  width: number;
  setSubMode: (next: ReaderSubMode | ((prev: ReaderSubMode) => ReaderSubMode)) => void;
  onSearchJumpPage: (page: number) => void;
  abortAllInFlight: () => void;
  buildAskPrompts: (page: PageProjection, question: string) => { system: string; prompt: string };
}

export function useReaderAskActions({
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
  onSearchJumpPage,
  abortAllInFlight,
  buildAskPrompts,
}: UseReaderAskActionsParams) {
  const setSnapshot = useTuiStore((s) => s.setSnapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const [activeSearch, setActiveSearch] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
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
  const [savingCard, setSavingCard] = useState(false);
  const [savedCard, setSavedCard] = useState(false);

  const saveCardBusyRef = useRef(false);
  const askAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const searchSeqRef = useRef(0);
  const practiceSeqRef = useRef(0);
  const askActionSeqRef = useRef(0);
  const prevDocTargetRef = useRef(`${documentId ?? ''}|${sourceId ?? ''}`);

  const { send: sendAiTurn, abort: abortAiTurn } = useAiConversation(host, lang);

  const abortAskInFlight = useCallback(() => {
    abortAiTurn();
    if (askAbortRef.current) {
      askAbortRef.current.abort();
      askAbortRef.current = null;
    }
  }, [abortAiTurn]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      searchSeqRef.current += 1;
      practiceSeqRef.current += 1;
      askActionSeqRef.current += 1;
      saveCardBusyRef.current = false;
      abortAskInFlight();
      setSearchHits([]);
      setSavingNote(false);
      setSavingCard(false);
      setSavedCard(false);
    };
  }, [abortAskInFlight]);

  useEffect(() => {
    const nextTarget = `${documentId ?? ''}|${sourceId ?? ''}`;
    if (prevDocTargetRef.current !== nextTarget) {
      prevDocTargetRef.current = nextTarget;
      searchSeqRef.current += 1;
      practiceSeqRef.current += 1;
      setActiveSearch('');
      setSearchHits([]);
    }
  }, [documentId, sourceId]);

  const resetAskState = useCallback(
    (flushFirst = false) => {
      askActionSeqRef.current += 1;
      practiceSeqRef.current += 1;
      saveCardBusyRef.current = false;
      abortAskInFlight();
      if (flushFirst) finishAiAnswer();
      resetAiAnswer();
      setAiBusy(false);
      setSavingNote(false);
      setSavingCard(false);
      setSavedCard(false);
    },
    [abortAskInFlight, finishAiAnswer, resetAiAnswer],
  );

  const runSearch = useCallback(
    async (query: string) => {
      const seq = ++searchSeqRef.current;
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
      if (!mountedRef.current || seq !== searchSeqRef.current) return;
      if (res.ok && res.value && Array.isArray(res.value.matches)) {
        const hits = res.value.matches.map((m) => ({
          sourceId: String(m.id ?? m.sourceId ?? ''),
          page: typeof m.page === 'number' ? m.page : undefined,
          snippet: String(m.snippet ?? m.text ?? '').slice(0, 120),
        }));
        setSearchHits(hits);
        if (hits.length > 0 && hits[0].page && hits[0].page !== currentPage) {
          onSearchJumpPage(hits[0].page);
        }
      } else {
        setSearchHits([]);
      }
    },
    [host, pageData, sourceId, currentPage, onSearchJumpPage, setSubMode],
  );

  const runAskAi = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !pageData) return;
      abortAllInFlight();
      abortAskInFlight();
      const ac = new AbortController();
      askAbortRef.current = ac;
      setSubMode('ask-view');
      setAiBusy(true);
      setSavedCard(false);
      resetAiAnswer();

      try {
        if (isAiStreamingAvailable(host)) {
          const { system, prompt } = buildAskPrompts(pageData, q);
          const outcome = await sendAiTurn({
            system,
            prompt,
            onChunk: (delta) => {
              if (ac.signal.aborted) return;
              pushAiAnswer(delta);
            },
          });
          if (!ac.signal.aborted && outcome.status !== 'superseded' && outcome.status !== 'aborted') {
            if (outcome.status === 'done') {
              if (outcome.text) setAiAnswer(outcome.text);
            } else {
              setAiAnswer(`${asciiMode ? 'x' : '✕'} ${outcome.error}`);
            }
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
        if (askAbortRef.current === ac) {
          askAbortRef.current = null;
          finishAiAnswer();
          if (!ac.signal.aborted) setAiBusy(false);
        } else if (ac.signal.aborted && !askAbortRef.current) {
          finishAiAnswer();
        }
      }
    },
    [
      abortAllInFlight,
      abortAskInFlight,
      asciiMode,
      buildAskPrompts,
      finishAiAnswer,
      host,
      lang,
      pageData,
      pushAiAnswer,
      resetAiAnswer,
      sendAiTurn,
      setAiAnswer,
      setSubMode,
    ],
  );

  const handlePracticeLinkedCards = useCallback(async () => {
    if (!pageData) return;
    const seq = ++practiceSeqRef.current;
    const res = await tryAction<{ cards?: Array<{ deckId: string; cardId: string }> }>(
      host,
      'materials.pages.cards',
      {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
      },
    );
    if (!mountedRef.current || seq !== practiceSeqRef.current) return;
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
      if (!mountedRef.current || seq !== practiceSeqRef.current) return;
      navigate('review', { runId: run.id });
    } catch (err) {
      if (mountedRef.current && seq === practiceSeqRef.current) {
        notify(errorMessage(err), 'error');
      }
    }
  }, [host, lang, navigate, notify, pageData]);

  const handleSaveAskToNote = useCallback(async () => {
    if (!pageData || aiBusy || savingNote) return;
    const seq = askActionSeqRef.current;
    setSavingNote(true);
    try {
      const { anchorOffset, selectedExcerpt } = computeScrollAnchorExcerpt(
        pageData.text,
        pageScrollTop,
        subMode,
        width,
      );
      const { savePageAskToNote } = await import('./ReaderNotesDrawer.js');
      if (!mountedRef.current || seq !== askActionSeqRef.current) return;
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
      if (!mountedRef.current || seq !== askActionSeqRef.current) return;
      notify(result.message, result.ok ? 'success' : 'warning');
    } catch (err) {
      if (mountedRef.current && seq === askActionSeqRef.current) notify(errorMessage(err), 'error');
    } finally {
      if (mountedRef.current && seq === askActionSeqRef.current) setSavingNote(false);
    }
  }, [
    pageData,
    aiBusy,
    savingNote,
    pageScrollTop,
    subMode,
    width,
    host,
    lang,
    documentId,
    askQuestion,
    aiAnswer,
    initialCourse,
    notify,
  ]);

  const handleSaveAskToCard = useCallback(async () => {
    if (!pageData || aiBusy || saveCardBusyRef.current) return;
    const question = askQuestion.trim();
    const answer = aiAnswer.trim();
    if (!question || !answer) {
      notify(t(lang, '当前没有可保存的问答内容', 'No Q&A answer available to save'), 'error');
      return;
    }
    const anchor = extractPageAnchorSlice(pageData.text);
    if (!anchor) {
      notify(t(lang, '当前页没有可用于定位的原文段落', 'No source passage available on this page to link'), 'error');
      return;
    }
    const seq = askActionSeqRef.current;
    saveCardBusyRef.current = true;
    setSavingCard(true);
    try {
      let selection: Record<string, unknown> = {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        ...(pageData.revision ? { revision: pageData.revision } : {}),
        sourceId: pageData.sourceId,
        start: anchor.start,
        end: anchor.end,
        quote: anchor.quote,
      };
      if (!pageData.revision || !pageData.documentId) {
        let resolvedDocId = pageData.documentId;
        let resolvedRev = pageData.revision;
        if (!resolvedDocId) {
          const docRes = await tryAction<{ id?: string; documentId?: string; currentRevision?: string; revision?: string }>(
            host,
            'materials.document.get',
            { sourceId: pageData.sourceId },
          );
          if (!mountedRef.current || seq !== askActionSeqRef.current) return;
          if (docRes.ok && docRes.value) {
            resolvedDocId = docRes.value.documentId || docRes.value.id;
            resolvedRev = resolvedRev || docRes.value.currentRevision || docRes.value.revision;
          }
        }
        const resolveRes = await tryAction<{
          status?: string;
          selection?: Record<string, unknown>;
          message?: string;
        }>(host, 'materials.selection.resolve', {
          ...selection,
          ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
          ...(resolvedRev ? { revision: resolvedRev } : {}),
        });
        if (!mountedRef.current || seq !== askActionSeqRef.current) return;
        if (resolveRes.ok && resolveRes.value?.status === 'resolved' && resolveRes.value.selection) {
          selection = Object.fromEntries(
            Object.entries(resolveRes.value.selection).filter(([, v]) => v !== undefined),
          );
        } else {
          notify(
            resolveRes.value?.message ||
              resolveRes.error?.message ||
              t(lang, '无法定位当前页原文版本', 'Unable to resolve current page revision'),
            'error',
          );
          return;
        }
      }
      const operationId = `tui-qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await tryAction<{
        status?: string;
        deckId?: string;
        cardId?: string;
        error?: string;
      }>(host, 'generation.selection.saveAnswer', {
        selection,
        question,
        answer,
        operationId,
        uiLanguage: lang,
      });
      if (!mountedRef.current || seq !== askActionSeqRef.current) return;
      if (!res.ok || !res.value) {
        notify(
          res.error?.message || t(lang, '保存闪卡失败', 'Failed to save flashcard'),
          'error',
        );
        return;
      }
      if (res.value.status === 'complete') {
        setSavedCard(true);
        const snapRes = await tryAction(host, 'snapshot');
        if (mountedRef.current && seq === askActionSeqRef.current && snapRes.ok && snapRes.value && typeof snapRes.value === 'object') {
          setSnapshot(snapRes.value as never);
        }
        if (mountedRef.current && seq === askActionSeqRef.current) {
          notify(t(lang, '已保存为原文关联闪卡', 'Saved as passage-linked flashcard'), 'success');
        }
      } else if (res.value.status === 'duplicate') {
        setSavedCard(true);
        notify(t(lang, '该问答卡片已存在于题组中', 'This Q&A flashcard already exists'), 'info');
      } else {
        notify(
          res.value.error || t(lang, '保存闪卡时发生冲突，请重试', 'Conflict while saving flashcard, please retry'),
          'error',
        );
      }
    } catch (err) {
      if (mountedRef.current && seq === askActionSeqRef.current) notify(errorMessage(err, lang), 'error');
    } finally {
      if (seq === askActionSeqRef.current) {
        saveCardBusyRef.current = false;
        if (mountedRef.current) setSavingCard(false);
      }
    }
  }, [pageData, aiBusy, askQuestion, aiAnswer, host, lang, notify, setSnapshot]);

  return {
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
  };
}
