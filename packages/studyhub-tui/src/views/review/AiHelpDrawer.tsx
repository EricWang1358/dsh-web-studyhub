import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, errorMessage, type ReviewRun } from '../../host/index.js';
import {
  Badge,
  MarkdownView,
  Panel,
  Spinner,
  TextInput,
  useFooterHints,
  useInputCapture,
  useTheme,
} from '../../components/index.js';
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
  const notify = useTuiStore((s) => s.notify);

  // Per-card history kept local and capped at MAX_AI_TURNS.
  const [historyByCard, setHistoryByCard] = useState<Record<string, AiTurn[]>>({});
  const [streamingText, setStreamingText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [reasoningChars, setReasoningChars] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [savingNote, setSavingNote] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
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

  // Abort any in-flight stream when card changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setStreamingText('');
    setReasoningChars(0);
    setErrorText(null);
  }, [cardId]);

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
      setStreamingText('');
      setReasoningChars(0);
      setErrorText(null);

      let accumulated = '';
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
            accumulated += delta;
            setStreamingText(accumulated);
          },
          onReasoning: (chars) => {
            if (!mountedRef.current || ctrl.signal.aborted) return;
            setReasoningChars(chars);
          },
        });
        if (!mountedRef.current || ctrl.signal.aborted) return;
        const reply = (finalText || accumulated).trim();
        if (reply) {
          const assistantTurn: AiTurn = { role: 'assistant', text: reply };
          setHistoryByCard((prev) => {
            const cur = prev[cardId] ?? withUser;
            return { ...prev, [cardId]: [...cur, assistantTurn].slice(-MAX_AI_TURNS) };
          });
        }
        setStreamingText('');
        setStreaming(false);
      } catch (err) {
        if (!mountedRef.current || ctrl.signal.aborted) return;
        setStreaming(false);
        if (accumulated.trim()) {
          const partialTurn: AiTurn = { role: 'assistant', text: accumulated.trim() };
          setHistoryByCard((prev) => {
            const cur = prev[cardId] ?? withUser;
            return { ...prev, [cardId]: [...cur, partialTurn].slice(-MAX_AI_TURNS) };
          });
          setStreamingText('');
        }
        setErrorText(errorMessage(err));
      }
    },
    [host, lang, historyByCard, cardId, run, kind, userAnswer],
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
            { key: 'N', label: t(lang, '存笔记', 'Save Note') },
            { key: '↑/↓', label: t(lang, '滚动', 'Scroll') },
            { key: 'Esc / h', label: t(lang, '关闭', 'Close') },
          ],
    [inputFocused, lang],
  );
  useFooterHints(drawerHints, isActive);

  useInput(
    (input, key) => {
      if (inputFocused) return;
      if (key.escape || input === 'h') {
        abortRef.current?.abort();
        onClose();
        return;
      }
      if (input === 'i' || key.return) {
        setInputFocused(true);
        return;
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
      blocks.push(streamingText || t(lang, '_正在生成讲解…_', '_Generating explanation…_'));
    }
    return blocks.join('\n\n---\n\n') || t(lang, '_正在准备 AI 助教…_', '_Preparing AI tutor…_');
  }, [turns, streaming, streamingText, lang]);

  const innerW = Math.max(20, width - 4);
  const bodyH = Math.max(4, height - 6);

  return (
    <Panel
      title={t(lang, 'AI 帮我理解', 'AI Tutor')}
      icon="✦"
      badge={`${Math.min(turns.length, MAX_AI_TURNS)}/${MAX_AI_TURNS}`}
      badgeTone="ai"
      tone="ai"
      focused={isActive}
      width={width}
      height={height}
      paddingX={1}
    >
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" marginBottom={0}>
        <Box flexDirection="row" gap={1}>
          {streaming ? (
            <Spinner
              label={
                reasoningChars > 0
                  ? t(lang, `思考中 · ${reasoningChars} 字符`, `Reasoning · ${reasoningChars} chars`)
                  : t(lang, '正在流式生成…', 'Streaming…')
              }
              tone="ai"
              active={isActive && streaming}
            />
          ) : (
            <Badge label={t(lang, '已就绪', 'Ready')} tone="ai" variant="soft" />
          )}
          {savingNote ? <Spinner label={t(lang, '保存中…', 'Saving…')} tone="success" active={isActive} /> : null}
        </Box>
        <Text color={theme.dim}>{t(lang, '[N] 存笔记 · [Esc] 关闭', '[N] Save Note · [Esc] Close')}</Text>
      </Box>

      {errorText ? (
        <Box marginY={0}>
          <Text color={theme.error}>{`✕ ${errorText} `}</Text>
          <Text color={theme.muted}>{t(lang, '([r] 重试)', '([r] Retry)')}</Text>
        </Box>
      ) : null}

      <Box height={bodyH} width={innerW} overflow="hidden" marginTop={0}>
        <MarkdownView
          markdown={transcriptMd}
          width={innerW}
          height={bodyH}
          isActive={isActive && !inputFocused}
          mathUnicode={mathUnicode}
          follow={streaming}
        />
      </Box>

      <Box
        borderStyle="single"
        borderColor={inputFocused ? theme.ai : theme.border}
        paddingX={1}
        height={3}
        width={innerW}
      >
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          isActive={isActive && inputFocused}
          width={Math.max(10, innerW - 6)}
          prompt="›"
          placeholder={
            inputFocused
              ? t(lang, '输入你的追问，Enter 发送…', 'Type your follow-up question, Enter to send…')
              : t(lang, '按 [i] 输入追问，[N] 保存问答到学习笔记', 'Press [i] to ask follow-up, [N] to save Q&A')
          }
          onSubmit={(val) => {
            const trimmed = val.trim();
            if (!trimmed) return;
            setInputValue('');
            setInputFocused(false);
            void askAi(trimmed);
          }}
          onCancel={() => setInputFocused(false)}
        />
      </Box>
    </Panel>
  );
});
