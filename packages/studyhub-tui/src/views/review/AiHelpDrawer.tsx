import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, errorMessage, type ReviewRun } from '../../host/sample-actions.js';
import {
  buildInitialExplainPrompt,
  canExposeReferenceAnswer,
  persistCardQaToFollowupAndNote,
} from '../../host/ai-dialogue.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture, useModalFooterHints } from '../../components/focus.js';
import { ClickableBox } from '../../components/mouse.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import {
  MAX_AI_TURNS,
  buildCardHelpMessages,
  buildCardHelpSystemPrompt,
  buildCardHelpUserPrompt,
  buildDailyQuestionNoteTitle,
  currentDeckIdOf,
  extractCitation,
  extractRunFollowups,
  extractSolution,
  type AiTurn,
  type NormalizedKind,
} from './review-helpers.js';

export interface SavedFollowupItem {
  id: string;
  question: string;
  answer: string;
  at?: string;
}

export function followupsToAiTurns(
  followups: ReadonlyArray<{ question?: string; answer?: string }> | undefined,
): AiTurn[] {
  if (!Array.isArray(followups) || followups.length === 0) return [];
  const out: AiTurn[] = [];
  for (const f of followups) {
    const q = typeof f?.question === 'string' ? f.question.trim() : '';
    const a = typeof f?.answer === 'string' ? f.answer.trim() : '';
    if (q) out.push({ role: 'user', text: q });
    if (a) out.push({ role: 'assistant', text: a });
  }
  return out.slice(-MAX_AI_TURNS);
}

export interface AiHelpDrawerProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  userAnswer: string;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  /** Lifted per-card conversation history owned by ReviewView so closing/reopening never loses turns. */
  history?: readonly AiTurn[];
  onHistoryChange?: (cardId: string, nextTurns: AiTurn[]) => void;
  /** Extra saved follow-ups recorded during this round before backend run refreshes. */
  extraSavedFollowups?: readonly SavedFollowupItem[];
  onSavedFollowup?: (cardId: string, item: SavedFollowupItem) => void;
  onClose: () => void;
}

export const AiHelpDrawer = memo(function AiHelpDrawer({
  host,
  run,
  cardId,
  kind,
  userAnswer,
  width,
  height,
  isActive,
  mathUnicode,
  history: liftedHistory,
  onHistoryChange,
  extraSavedFollowups,
  onSavedFollowup,
  onClose,
}: AiHelpDrawerProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  // Local fallback history when rendered standalone without lifted history props.
  const [localHistoryByCard, setLocalHistoryByCard] = useState<Record<string, AiTurn[]>>({});
  const {
    text: streamingText,
    push: pushStreamingChunk,
    finish: finishStreaming,
    reset: resetStreaming,
  } = useStreamingBuffer();
  const [streaming, setStreaming] = useState(false);
  const [reasoningChars, setReasoningChars] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savedLatest, setSavedLatest] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const cardIdRef = useRef(cardId);
  cardIdRef.current = cardId;
  const autoAskedRef = useRef<Set<string>>(new Set());
  const sourceExcerptCacheRef = useRef<Map<string, string>>(new Map());

  // Opaque global input capture while drawer is mounted (#1376).
  useInputCapture(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Abort any in-flight stream and reset card-specific suggestions when card changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    resetStreaming();
    setReasoningChars(0);
    setErrorText(null);
    setSavedLatest(false);
    setSuggestions([]);
    setSuggestLoading(false);
    setSuggestError(null);
  }, [cardId, resetStreaming]);

  const savedTurns = useMemo(() => {
    const solFollowups = extractRunFollowups(run);
    const merged: Array<{ id?: string; question?: string; answer?: string }> = [...solFollowups];
    if (extraSavedFollowups && extraSavedFollowups.length > 0) {
      for (const extra of extraSavedFollowups) {
        const matchIdx = merged.findIndex(
          (f) => (extra.id && f.id === extra.id) || (extra.question && f.question === extra.question),
        );
        if (matchIdx >= 0) merged[matchIdx] = extra;
        else merged.push(extra);
      }
    }
    return followupsToAiTurns(merged);
  }, [run, extraSavedFollowups]);

  const turns = useMemo<AiTurn[]>(() => {
    if (liftedHistory && liftedHistory.length > 0) return [...liftedHistory];
    const local = localHistoryByCard[cardId];
    if (local && local.length > 0) return local;
    if (savedTurns.length > 0) return savedTurns;
    return [];
  }, [liftedHistory, localHistoryByCard, cardId, savedTurns]);

  const turnsRef = useRef<AiTurn[]>(turns);
  turnsRef.current = turns;

  const isReusedOnly = useMemo(
    () =>
      savedTurns.length > 0 &&
      !(liftedHistory && liftedHistory.length > savedTurns.length) &&
      !(localHistoryByCard[cardId] && localHistoryByCard[cardId].length > savedTurns.length),
    [savedTurns.length, liftedHistory, localHistoryByCard, cardId],
  );

  const commitTurns = useCallback(
    (targetCardId: string, nextTurns: AiTurn[]) => {
      const capped = nextTurns.slice(-MAX_AI_TURNS);
      if (onHistoryChange) {
        onHistoryChange(targetCardId, capped);
      } else {
        setLocalHistoryByCard((prev) => ({ ...prev, [targetCardId]: capped }));
      }
    },
    [onHistoryChange],
  );

  const buildInitialPrompt = useCallback(
    () => buildInitialExplainPrompt(canExposeReferenceAnswer(run), lang),
    [run, lang],
  );

  const resolveSourceExcerpt = useCallback(async (): Promise<string> => {
    const sol = extractSolution(run);
    const card = (run.card || {}) as Record<string, unknown>;
    const rawCites =
      sol?.citations ?? (Array.isArray(card.citations) ? (card.citations as Array<{ quote?: string }>) : undefined);
    if (Array.isArray(rawCites) && rawCites.some((c) => typeof c?.quote === 'string' && c.quote.trim().length > 0)) {
      return '';
    }
    const cite = extractCitation(run);
    if (!cite?.sourceId) return '';
    const cacheKey = `${cite.sourceId}#${cite.pageNumber ?? 0}`;
    if (sourceExcerptCacheRef.current.has(cacheKey)) {
      return sourceExcerptCacheRef.current.get(cacheKey) || '';
    }
    let excerpt = '';
    try {
      if (cite.pageNumber) {
        // The backend (lib/book-pages.js) addresses a material by sourceId/documentId and answers with `shown[]`;
        // `pages` is only the page-range string, and `{ id }` is refused with `source-pages-target`.
        const res = await tryAction<{ shown?: Array<{ text?: string }>; text?: string }>(host, 'source.pages', {
          sourceId: cite.sourceId,
          from: cite.pageNumber,
          to: cite.pageNumber,
        });
        if (res.ok && res.value) {
          const shown = Array.isArray(res.value.shown)
            ? res.value.shown.map((page) => (typeof page?.text === 'string' ? page.text.trim() : '')).filter(Boolean)
            : [];
          if (shown.length > 0) excerpt = shown.join('\n').slice(0, 800);
        }
      } else {
        const res = await tryAction<{ text?: string; source?: { text?: string } }>(host, 'source.get', {
          id: cite.sourceId,
          offset: 0,
          limit: 800,
        });
        if (res.ok && res.value) {
          const raw = res.value.text ?? res.value.source?.text ?? '';
          if (typeof raw === 'string') excerpt = raw.trim().slice(0, 800);
        }
      }
    } catch {
      excerpt = '';
    }
    sourceExcerptCacheRef.current.set(cacheKey, excerpt);
    return excerpt;
  }, [host, run]);

  const askAi = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;
      if (typeof host.streamComplete !== 'function') {
        setErrorText(t(lang, '当前 Host 未提供流式 AI 接口', 'Streaming AI completion is unavailable on this host'));
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const priorTurns = turnsRef.current;
      const isFollowup = priorTurns.length > 0;
      const userTurn: AiTurn = { role: 'user', text: q };
      const withUser = [...priorTurns, userTurn].slice(-MAX_AI_TURNS);
      turnsRef.current = withUser;
      commitTurns(cardId, withUser);
      setStreaming(true);
      setSavedLatest(false);
      resetStreaming();
      setReasoningChars(0);
      setErrorText(null);

      try {
        const sourceExcerpt = await resolveSourceExcerpt();
        if (!mountedRef.current || ctrl.signal.aborted) return;
        const messages = buildCardHelpMessages({
          run,
          kind,
          userAnswer,
          sourceExcerpt,
          history: priorTurns,
          question: q,
          lang,
        });
        const finalText = await host.streamComplete({
          system: buildCardHelpSystemPrompt(lang, isFollowup),
          prompt: buildCardHelpUserPrompt({
            run,
            kind,
            userAnswer,
            sourceExcerpt,
            history: priorTurns,
            question: q,
            lang,
          }),
          messages,
          signal: ctrl.signal,
          onChunk: (delta) => {
            if (!mountedRef.current || ctrl.signal.aborted) return;
            pushStreamingChunk(delta);
          },
          onReasoning: (chars) => {
            if (!mountedRef.current || ctrl.signal.aborted) return;
            setReasoningChars(chars);
          },
        });
        if (!mountedRef.current || ctrl.signal.aborted) return;
        const flushed = finishStreaming();
        const reply = (finalText || flushed).trim();
        if (reply) {
          const assistantTurn: AiTurn = { role: 'assistant', text: reply };
          const next = [...withUser, assistantTurn].slice(-MAX_AI_TURNS);
          turnsRef.current = next;
          commitTurns(cardId, next);
        } else {
          // Nothing came back: drop the unanswered user turn so the next request never sends two `user` messages in a row.
          turnsRef.current = priorTurns;
          commitTurns(cardId, priorTurns);
        }
        resetStreaming();
        setStreaming(false);
      } catch (err) {
        if (!mountedRef.current || ctrl.signal.aborted) return;
        const flushed = finishStreaming();
        setStreaming(false);
        const partial = flushed.trim();
        if (partial) {
          const partialTurn: AiTurn = { role: 'assistant', text: partial };
          const next = [...withUser, partialTurn].slice(-MAX_AI_TURNS);
          turnsRef.current = next;
          commitTurns(cardId, next);
          resetStreaming();
        } else {
          // A failed request produced nothing at all: drop the unanswered user turn (see the success path).
          turnsRef.current = priorTurns;
          commitTurns(cardId, priorTurns);
        }
        setErrorText(errorMessage(err));
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          if (!mountedRef.current || ctrl.signal.aborted) {
            resetStreaming();
            if (mountedRef.current) setStreaming(false);
          } else {
            finishStreaming();
          }
        }
      }
    },
    [host, lang, cardId, run, kind, userAnswer, commitTurns, pushStreamingChunk, finishStreaming, resetStreaming, resolveSourceExcerpt],
  );

  // Auto-explain ONLY when opened for a card with neither lifted history nor saved follow-ups.
  useEffect(() => {
    if (!isActive || !cardId) return;
    if (turns.length === 0 && savedTurns.length === 0 && !autoAskedRef.current.has(cardId)) {
      autoAskedRef.current.add(cardId);
      void askAi(buildInitialPrompt());
    }
  }, [isActive, cardId, turns.length, savedTurns.length, buildInitialPrompt, askAi]);

  const fetchSuggestions = useCallback(async () => {
    if (suggestLoading || !cardId) return;
    const deckId = currentDeckIdOf(run);
    const targetCardId = cardId;
    setSuggestLoading(true);
    setSuggestError(null);
    const res = await tryAction<{ questions?: unknown }>(host, 'card.followup.suggest', {
      ...(deckId ? { deckId } : {}),
      cardId: targetCardId,
    });
    if (!mountedRef.current || cardIdRef.current !== targetCardId) return;
    setSuggestLoading(false);
    if (!res.ok || !res.value) {
      setSuggestError(res.error?.message || t(lang, '获取推荐追问失败', 'Failed to suggest follow-up questions'));
      return;
    }
    const items = Array.isArray(res.value.questions)
      ? res.value.questions
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter(Boolean)
          .slice(0, 3)
      : [];
    if (items.length === 0) {
      setSuggestError(t(lang, '暂无可推荐的追问问题', 'No follow-up suggestions returned'));
      return;
    }
    setSuggestions(items);
  }, [suggestLoading, cardId, run, host, lang]);

  const saveLatestQaToNotes = useCallback(async () => {
    if (savingNote) return;
    const deckId = currentDeckIdOf(run);
    if (!deckId) {
      notify(t(lang, '未找到题组 ID，无法保存笔记', 'Missing deck ID; cannot save note'), 'warning');
      return;
    }
    const lastAssistantIdx = [...turns].reverse().findIndex((x) => x.role === 'assistant');
    if (lastAssistantIdx === -1) {
      notify(t(lang, '还没有可保存的 AI 讲解内容', 'No AI answer to save yet'), 'warning');
      return;
    }
    const realIdx = turns.length - 1 - lastAssistantIdx;
    const answerText = turns[realIdx].text;
    const prevUser = turns.slice(0, realIdx).reverse().find((x) => x.role === 'user');
    const questionText = prevUser?.text || t(lang, '帮我理解这道题', 'Help me understand this question');

    setSavingNote(true);
    const noteTitle = buildDailyQuestionNoteTitle(run, useTuiStore.getState().snapshot?.decks, lang);
    const saved = await persistCardQaToFollowupAndNote({
      host,
      deckId,
      cardId,
      question: questionText,
      answer: answerText,
      noteTitle,
      lang,
    });
    if (!mountedRef.current) return;
    setSavingNote(false);
    if (!saved.ok || !saved.savedItem) {
      notify(saved.error || t(lang, '保存追问失败', 'Failed to save follow-up'), 'error');
      return;
    }
    setSavedLatest(true);
    onSavedFollowup?.(cardId, saved.savedItem);
    if (!saved.noteSaved && saved.warning) {
      notify(saved.warning, 'warning');
      return;
    }
    notify(t(lang, '已保存到本题讲解与学习笔记，下次打开将直接复用', 'Saved Q&A to notes (reused next time)'), 'success');
  }, [savingNote, run, turns, host, lang, cardId, notify, onSavedFollowup]);

  const drawerHints: KeyHint[] = useMemo(
    () =>
      inputFocused
        ? [
            { key: 'Enter', label: t(lang, '发送追问', 'Send') },
            { key: 'Esc', label: t(lang, '退出输入', 'Blur') },
          ]
        : [
            { key: 'i / Enter', label: t(lang, '追问', 'Ask') },
            { key: 'R', label: t(lang, '重新生成(调用模型)', 'Regen (calls AI)') },
            { key: 's', label: t(lang, '推荐追问', 'Suggest Qs') },
            ...(suggestions.length > 0
              ? [{ key: `1-${suggestions.length}`, label: t(lang, '快问', 'Quick') }]
              : []),
            { key: 'N', label: t(lang, '保存(下次复用)', 'Save (reuse)') },
            { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') },
            { key: 'Esc / h', label: t(lang, '关闭', 'Close') },
          ],
    [inputFocused, suggestions.length, lang, asciiMode],
  );
  useModalFooterHints(drawerHints, isActive);

  useInput(
    (input, key) => {
      if (inputFocused) return;
      if (key.escape || input === 'h') {
        abortRef.current?.abort();
        resetStreaming();
        setStreaming(false);
        onClose();
        return true;
      }
      if (input === 'i' || key.return) {
        setInputFocused(true);
        return;
      }
      if (input === 's' && !suggestLoading && !streaming) {
        void fetchSuggestions();
        return;
      }
      if (/^[1-3]$/.test(input) && !streaming) {
        const idx = Number(input) - 1;
        if (suggestions[idx]) {
          void askAi(suggestions[idx]);
          return;
        }
      }
      if (input === 'N') {
        void saveLatestQaToNotes();
        return;
      }
      if (input === 'R' && !streaming) {
        if (errorText && turns.length > 0) {
          const lastUser = [...turns].reverse().find((x) => x.role === 'user');
          if (lastUser) {
            void askAi(lastUser.text);
            return;
          }
        }
        void askAi(buildInitialPrompt());
      }
    },
    { isActive: isActive && !inputFocused },
  );

  const transcriptMd = useMemo(() => {
    const blocks: string[] = [];
    for (const turn of turns) {
      if (turn.role === 'user') {
        blocks.push(`> **${t(lang, '你', 'You')}**: ${turn.text}`);
      } else {
        blocks.push(turn.text);
      }
    }
    if (streaming) {
      blocks.push(streamingText || t(lang, `_正在生成讲解${ell}_`, `_Generating explanation${ell}_`));
    }
    return blocks.join('\n\n---\n\n') || t(lang, `_正在准备 AI 助教${ell}_`, `_Preparing AI tutor${ell}_`);
  }, [turns, streaming, streamingText, lang, ell]);

  const innerW = Math.max(20, width - 4);
  const suggestTextW = Math.max(8, innerW - 4);
  const wrappedSuggestions = useMemo(
    () => suggestions.map((q, idx) => ({ idx, q, lines: wrapDisplay(q, suggestTextW) })),
    [suggestions, suggestTextW],
  );
  const errorH = errorText ? 1 : 0;
  // Overhead inside Panel: border top/bottom (2) + status bar (1) + error (0|1) + input box (3) = 6 + errorH.
  const flexSpace = Math.max(4, height - 6 - errorH);
  const rawSuggestH = suggestLoading
    ? 1
    : suggestError
      ? 1
      : wrappedSuggestions.reduce((n, item) => n + item.lines.length, 0);
  // Reserve at least 3 rows for transcript body (or 2 on ultra-short terminals) so input box is never pushed off screen.
  const minBodyH = Math.min(3, Math.max(2, Math.floor(flexSpace * 0.25)));
  const maxSuggestH = Math.max(0, flexSpace - minBodyH);
  const suggestH = Math.min(rawSuggestH, maxSuggestH);
  const bodyH = Math.max(2, flexSpace - suggestH);

  return (
    <Panel
      title={t(lang, 'AI 帮我理解', 'AI Tutor')}
      icon={asciiMode ? '*' : '✦'}
      badge={`${Math.min(turns.length, MAX_AI_TURNS)}/${MAX_AI_TURNS}`}
      badgeTone="ai"
      tone="ai"
      focused={isActive}
      width={width}
      height={height}
      paddingX={1}
    >
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" height={1} width={innerW} flexShrink={0} overflow="hidden">
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {streaming ? (
            <Spinner
              label={
                reasoningChars > 0
                  ? t(lang, `思考中 · ${reasoningChars} 字符`, `Reasoning · ${reasoningChars} chars`)
                  : t(lang, `正在流式生成${ell}`, `Streaming${ell}`)
              }
              tone="ai"
              active={isActive && streaming}
            />
          ) : isReusedOnly ? (
            <Badge label={t(lang, '已复用讲解', 'Saved')} tone="success" variant="soft" />
          ) : (
            <Badge label={t(lang, '已就绪', 'Ready')} tone="ai" variant="soft" />
          )}
          {savingNote ? <Spinner label={t(lang, `保存中${ell}`, `Saving${ell}`)} tone="success" active={isActive} /> : null}
        </Box>
        <Text color={theme.dim} wrap="truncate">
          {truncateDisplay(
            !streaming && !isReusedOnly && !savedLatest && turns.some((x) => x.role === 'assistant')
              ? t(
                  lang,
                  '[N]保存下次直接看 · [R]重生成(调用模型)',
                  '[N]Save to reuse · [R]Regen (AI call)',
                )
              : t(
                  lang,
                  asciiMode ? '[R]重生成(模型) [s]追问 [N]保存' : '[R] 重新生成(调用模型) · [s] 追问 · [N] 保存',
                  asciiMode ? '[R]Regen(AI) [s]Qs [N]Save' : '[R] Regen (AI call) · [s] Qs · [N] Save',
                ),
            Math.max(10, innerW - 14),
            ell,
          )}
        </Text>
      </Box>

      {errorText ? (
        <Box marginY={0} width={innerW} flexShrink={0}>
          <Text color={theme.error} wrap="wrap">
            {`${asciiMode ? 'x' : '✕'} ${errorText} `}
            <Text color={theme.muted}>{t(lang, '([R] 重试)', '([R] Retry)')}</Text>
          </Text>
        </Box>
      ) : null}

      <Box height={bodyH} width={innerW} flexShrink={0} overflow="hidden" marginTop={0}>
        <MarkdownView
          markdown={transcriptMd}
          width={innerW}
          height={bodyH}
          isActive={isActive && !inputFocused}
          mathUnicode={mathUnicode}
          follow={streaming}
        />
      </Box>

      {suggestLoading ? (
        <Box height={1} width={innerW} flexShrink={0} overflow="hidden">
          <Spinner label={t(lang, `正在生成推荐追问${ell}`, `Suggesting follow-up questions${ell}`)} tone="ai" active={isActive} />
        </Box>
      ) : suggestError ? (
        <Box height={1} width={innerW} flexShrink={0} overflow="hidden">
          <Text color={theme.warning} wrap="truncate">
            {`${asciiMode ? '!' : '▲'} ${suggestError}`}
          </Text>
        </Box>
      ) : wrappedSuggestions.length > 0 && suggestH > 0 ? (
        <Box flexDirection="column" height={suggestH} width={innerW} flexShrink={0} overflow="hidden">
          {wrappedSuggestions.map(({ idx, q, lines }) => (
            <ClickableBox
              key={`${idx}:${q}`}
              flexDirection="column"
              width={innerW}
              clickActive={isActive && !streaming}
              onClick={() => {
                if (!streaming) void askAi(q);
              }}
            >
              {lines.map((line, lineIdx) => (
                <Box key={`${idx}:${lineIdx}`} height={1} width={innerW} overflow="hidden">
                  {lineIdx === 0 ? (
                    <Text color={theme.ai} bold>{`[${idx + 1}] `}</Text>
                  ) : (
                    <Text>{'    '}</Text>
                  )}
                  <Text color={theme.text}>{line}</Text>
                </Box>
              ))}
            </ClickableBox>
          ))}
        </Box>
      ) : null}

      <ClickableBox
        borderStyle={asciiMode ? 'classic' : 'single'}
        borderColor={inputFocused ? theme.ai : theme.border}
        paddingX={1}
        height={3}
        width={innerW}
        flexShrink={0}
        overflow="hidden"
        clickActive={isActive && !inputFocused}
        onClick={() => setInputFocused(true)}
      >
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          isActive={isActive && inputFocused}
          width={Math.max(10, innerW - 6)}
          prompt={asciiMode ? '>' : '›'}
          placeholder={truncateDisplay(
            inputFocused
              ? t(lang, `输入你的追问，Enter 发送${ell}`, `Type your follow-up question, Enter to send${ell}`)
              : t(lang, '按 [i] 输入追问，[s] 推荐追问，[N] 存笔记', 'Press [i] to ask, [s] suggest Qs, [N] save note'),
            Math.max(10, innerW - 6),
            ell,
          )}
          onSubmit={(val) => {
            const trimmed = val.trim();
            if (!trimmed) return;
            setInputValue('');
            setInputFocused(false);
            void askAi(trimmed);
          }}
          onCancel={() => setInputFocused(false)}
        />
      </ClickableBox>
    </Panel>
  );
});
