import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, errorMessage, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { ClickableBox } from '../../components/mouse.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import {
  MAX_AI_TURNS,
  buildCardHelpSystemPrompt,
  buildCardHelpUserPrompt,
  currentDeckIdOf,
  type AiTurn,
  type NormalizedKind,
} from './review-helpers.js';

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
  onClose,
}: AiHelpDrawerProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  // Per-card history kept local and capped at MAX_AI_TURNS.
  const [historyByCard, setHistoryByCard] = useState<Record<string, AiTurn[]>>({});
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
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const cardIdRef = useRef(cardId);
  cardIdRef.current = cardId;
  const autoAskedRef = useRef<Set<string>>(new Set());

  // Capture global shortcuts while drawer is active.
  useInputCapture(isActive);

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
    setSuggestions([]);
    setSuggestLoading(false);
    setSuggestError(null);
  }, [cardId, resetStreaming]);

  const turns = useMemo(() => historyByCard[cardId] ?? [], [historyByCard, cardId]);

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

      const priorTurns = historyByCard[cardId] ?? [];
      const userTurn: AiTurn = { role: 'user', text: q };
      const withUser = [...priorTurns, userTurn].slice(-MAX_AI_TURNS);
      setHistoryByCard((prev) => ({ ...prev, [cardId]: withUser }));
      setStreaming(true);
      resetStreaming();
      setReasoningChars(0);
      setErrorText(null);

      try {
        const finalText = await host.streamComplete({
          system: buildCardHelpSystemPrompt(lang),
          prompt: buildCardHelpUserPrompt({
            run,
            kind,
            userAnswer,
            history: priorTurns,
            question: q,
            lang,
          }),
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
          setHistoryByCard((prev) => {
            const cur = prev[cardId] ?? withUser;
            return { ...prev, [cardId]: [...cur, assistantTurn].slice(-MAX_AI_TURNS) };
          });
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
          setHistoryByCard((prev) => {
            const cur = prev[cardId] ?? withUser;
            return { ...prev, [cardId]: [...cur, partialTurn].slice(-MAX_AI_TURNS) };
          });
          resetStreaming();
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
    [host, lang, historyByCard, cardId, run, kind, userAnswer, pushStreamingChunk, finishStreaming, resetStreaming],
  );

  // Auto-explain when opened for a card with no history yet.
  useEffect(() => {
    if (!isActive || !cardId) return;
    if ((historyByCard[cardId]?.length ?? 0) === 0 && !autoAskedRef.current.has(cardId)) {
      autoAskedRef.current.add(cardId);
      const initialPrompt = run.revealed || run.feedback
        ? t(lang, '请帮我深入讲解这道题的考点、解题思路和容易混淆的误区。', 'Explain the core concept, solution reasoning, and common pitfalls for this question.')
        : t(lang, '请先给我一点解题启发和思路提示，先不要直接剧透最终选项或答案。', 'Give me a conceptual hint and approach without spoiling the final answer yet.');
      void askAi(initialPrompt);
    }
  }, [isActive, cardId, historyByCard, run.revealed, run.feedback, lang, askAi]);

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
    const followupRes = await tryAction<{ item?: { id?: string } }>(host, 'card.followup.add', {
      deckId,
      cardId,
      question: questionText.slice(0, 1000),
      answer: answerText.slice(0, 8000),
      source: 'assistant',
      silent: true,
    });
    if (!mountedRef.current) return;
    if (!followupRes.ok || !followupRes.value?.item?.id) {
      setSavingNote(false);
      notify(followupRes.error?.message || t(lang, '保存追问失败', 'Failed to save follow-up'), 'error');
      return;
    }
    const noteRes = await tryAction<{ status?: string }>(host, 'note.qa.add', {
      deckId,
      cardId,
      followupId: followupRes.value.item.id,
      language: lang,
    });
    if (!mountedRef.current) return;
    setSavingNote(false);
    if (!noteRes.ok) {
      notify(noteRes.error?.message || t(lang, '写入学习笔记失败', 'Failed to add Q&A to notes'), 'error');
      return;
    }
    notify(t(lang, '已将问答保存到学习笔记', 'Saved Q&A to study notes'), 'success');
  }, [savingNote, run, turns, host, lang, cardId, notify]);

  const drawerHints: KeyHint[] = useMemo(
    () =>
      inputFocused
        ? [
            { key: 'Enter', label: t(lang, '发送追问', 'Send') },
            { key: 'Esc', label: t(lang, '退出输入', 'Blur') },
          ]
        : [
            { key: 'i / Enter', label: t(lang, '追问', 'Ask') },
            { key: 's', label: t(lang, '推荐追问', 'Suggest Qs') },
            ...(suggestions.length > 0
              ? [{ key: `1-${suggestions.length}`, label: t(lang, '快问', 'Quick') }]
              : []),
            { key: 'N', label: t(lang, '存笔记', 'Save Note') },
            { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') },
            { key: 'Esc / h', label: t(lang, '关闭', 'Close') },
          ],
    [inputFocused, suggestions.length, lang, asciiMode],
  );
  useFooterHints(drawerHints, isActive);

  useInput(
    (input, key) => {
      if (inputFocused) return;
      if (key.escape || input === 'h') {
        abortRef.current?.abort();
        resetStreaming();
        setStreaming(false);
        onClose();
        return;
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
      if (input === 'r' && errorText && turns.length > 0) {
        const lastUser = [...turns].reverse().find((x) => x.role === 'user');
        if (lastUser) void askAi(lastUser.text);
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
          ) : (
            <Badge label={t(lang, '已就绪', 'Ready')} tone="ai" variant="soft" />
          )}
          {savingNote ? <Spinner label={t(lang, `保存中${ell}`, `Saving${ell}`)} tone="success" active={isActive} /> : null}
        </Box>
        <Text color={theme.dim} wrap="truncate">
          {truncateDisplay(
            t(
              lang,
              asciiMode ? '[s]追问 [N]存笔记 [Esc]关' : '[s] 推荐追问 · [N] 存笔记 · [Esc] 关闭',
              asciiMode ? '[s]Qs [N]Note [Esc]Close' : '[s] Suggest Qs · [N] Note · [Esc] Close',
            ),
            Math.max(10, innerW - 10),
            ell,
          )}
        </Text>
      </Box>

      {errorText ? (
        <Box marginY={0} height={1} width={innerW} flexShrink={0} overflow="hidden">
          <Text color={theme.error} wrap="truncate">
            {`${asciiMode ? 'x' : '✕'} ${errorText} `}
            <Text color={theme.muted}>{t(lang, '([r] 重试)', '([r] Retry)')}</Text>
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
