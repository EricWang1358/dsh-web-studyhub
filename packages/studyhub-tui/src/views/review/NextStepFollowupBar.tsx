/**
 * Unified "What would you like to do next?" agent-style follow-up bar for AI result modals (#1313).
 *
 * Design:
 * - Zero `marked` dependency (uses ScrollView + wrapDisplay) so non-markdown chunks like
 *   CardToolsModal stay `marked`-free and pass strict perf-budget checks.
 * - Consistent across all AI result pages: same key (`a`), same prompt copy, same quick presets,
 *   same streaming reply & `[N]` save-to-followup/notes action (reuses `card.followup.add` + `note.qa.add`).
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import type { ReviewRun } from '../../host/sample-actions.js';
import {
  buildCardDialogueUserPrompt,
  buildUnifiedAiSystemPrompt,
  canExposeReferenceAnswer,
  persistCardQaToFollowupAndNote,
} from '../../host/ai-dialogue.js';
import { AiConversation } from '../../components/AiConversation.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture } from '../../components/focus.js';
import { ClickableBox, useMouseLayer, useMouseModalBarrier } from '../../components/mouse.js';
import { useAiConversation } from '../../components/useAiConversation.js';
import { truncateDisplay } from '../../render/cjk.js';
import {
  MAX_AI_TURNS,
  buildDailyQuestionNoteTitle,
  currentDeckIdOf,
  extractReferenceAnswer,
  kindLabel,
  type AiTurn,
  type NormalizedKind,
} from './review-helpers.js';

export interface NextStepPreset {
  key: '1' | '2' | '3' | '4';
  labelZh: string;
  labelEn: string;
  promptZh: string;
  promptEn: string;
}

export const NEXT_STEP_PRESETS: readonly NextStepPreset[] = Object.freeze([
  {
    key: '1',
    labelZh: '通俗讲解',
    labelEn: 'Plain explain',
    promptZh: '请结合上面的结果，给每个要点写一段通俗易懂的讲解。',
    promptEn: 'Based on the result above, give a plain, intuitive explanation for each key point.',
  },
  {
    key: '2',
    labelZh: '举个例子',
    labelEn: 'Example',
    promptZh: '请结合上面的结果举一个具体例子，并说明关键步骤。',
    promptEn: 'Give a concrete example based on the result above and walk through the key steps.',
  },
  {
    key: '3',
    labelZh: '换个讲法',
    labelEn: 'Rephrase',
    promptZh: '请换一种更直观的角度重新讲一遍，并指出最容易混淆的地方。',
    promptEn: 'Explain this from a different, more intuitive angle and highlight common pitfalls.',
  },
  {
    key: '4',
    labelZh: '出前置题',
    labelEn: 'Prereq Q',
    promptZh: '请围绕上面涉及的核心概念，各出一道打基础的前置练习题（含参考答案与简短解析）。',
    promptEn: 'Write one foundational prerequisite practice question per core concept above (with answer and brief explanation).',
  },
]);

export const NEXT_STEP_ACTIVATION_KEY = 'a';

export function nextStepIdlePrompt(lang: UiLanguage): string {
  return t(
    lang,
    '接下来想做什么？按 [a] 自由输入指令（或点击此处）',
    'What next? Press [a] to give a custom instruction (or click here)',
  );
}

export function buildNextStepSystemPrompt(lang: UiLanguage): string {
  return buildUnifiedAiSystemPrompt('followup', lang);
}

export function buildNextStepUserPrompt(params: {
  run: ReviewRun;
  kind: NormalizedKind;
  userAnswer?: string;
  toolLabel: string;
  resultContext: string;
  history: readonly AiTurn[];
  instruction: string;
  lang: UiLanguage;
}): string {
  const { run, kind, userAnswer, toolLabel, resultContext, history, instruction, lang } = params;
  const revealed = canExposeReferenceAnswer(run);
  return buildCardDialogueUserPrompt({
    kindLabel: kindLabel(kind, lang),
    topic: typeof run.card?.topic === 'string' ? run.card.topic.trim() : undefined,
    prompt: String(run.card?.prompt ?? '').trim(),
    userAnswer,
    revealed,
    referenceAnswer: revealed ? extractReferenceAnswer(run, kind, lang) : undefined,
    toolLabel,
    toolOutput: resultContext,
    history,
    maxHistoryTurns: 6,
    question: instruction,
    lang,
  });
}

export interface NextStepFollowupBarProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  userAnswer?: string;
  toolLabel: string;
  resultContext: string;
  width: number;
  expandedHeight?: number;
  isActive: boolean;
  onFocusChange?: (engaged: boolean) => void;
}

export const NextStepFollowupBar = memo(function NextStepFollowupBar({
  host,
  run,
  cardId,
  kind,
  userAnswer,
  toolLabel,
  resultContext,
  width,
  expandedHeight = 11,
  isActive,
  onFocusChange,
}: NextStepFollowupBarProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const ell = asciiMode ? '...' : '…';

  const [expanded, setExpanded] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const mountedRef = useRef(true);
  const conversation = useAiConversation({
    host,
    scopeKey: `${cardId}\0${toolLabel}`,
    lang,
    maxTurns: MAX_AI_TURNS,
  });
  const {
    turns,
    turnsRef,
    streaming,
    streamingText,
    errorText,
    send: sendConversation,
    abort: abortConversation,
  } = conversation;

  const engaged = expanded || inputFocused;

  // #1344: Host modals set Modal.isActive=false while this bar is engaged; keep global
  // shortcut capture and modal mouse barrier active for the entire engaged period.
  useInputCapture(isActive && engaged);
  const mouseLayer = useMouseLayer();
  useMouseModalBarrier(isActive && engaged && mouseLayer > 0, mouseLayer);

  useEffect(() => {
    onFocusChange?.(engaged);
  }, [engaged, onFocusChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onFocusChange?.(false);
    };
  }, [onFocusChange]);

  // Reset UI expansion state when card or tool changes (conversation hook handles stream/scope reset).
  useEffect(() => {
    setExpanded(false);
    setInputFocused(false);
    setInputValue('');
  }, [cardId, toolLabel]);

  const sendInstruction = useCallback(
    async (raw: string) => {
      const instruction = raw.trim();
      if (!instruction) return;
      setExpanded(true);
      setInputFocused(false);
      await sendConversation({
        question: instruction,
        system: buildNextStepSystemPrompt(lang),
        buildPrompt: (q, prior) =>
          buildNextStepUserPrompt({
            run,
            kind,
            userAnswer,
            toolLabel,
            resultContext,
            history: prior,
            instruction: q,
            lang,
          }),
      });
    },
    [sendConversation, lang, run, kind, userAnswer, toolLabel, resultContext],
  );

  const saveLatestToNotes = useCallback(async () => {
    if (savingNote) return;
    const deckId = currentDeckIdOf(run);
    if (!deckId) {
      notify(t(lang, '未找到题组 ID，无法保存', 'Missing deck ID; cannot save'), 'warning');
      return;
    }
    const list = turnsRef.current;
    const revIdx = [...list].reverse().findIndex((x) => x.role === 'assistant');
    if (revIdx === -1) {
      notify(t(lang, '还没有可保存的 AI 回答', 'No AI reply to save yet'), 'warning');
      return;
    }
    const realIdx = list.length - 1 - revIdx;
    const answerText = list[realIdx].text;
    const prevUser = list.slice(0, realIdx).reverse().find((x) => x.role === 'user');
    const questionText = prevUser?.text || `[${toolLabel}] ${t(lang, '后续指令', 'Follow-up')}`;

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
    if (!saved.ok) {
      notify(saved.error || t(lang, '保存追问失败', 'Failed to save follow-up'), 'error');
      return;
    }
    if (!saved.noteSaved && saved.warning) {
      notify(saved.warning, 'warning');
      return;
    }
    notify(t(lang, '已保存为本题追问与学习笔记', 'Saved as card follow-up & study note'), 'success');
  }, [savingNote, run, host, lang, cardId, toolLabel, notify, turnsRef]);

  const openAndFocus = useCallback(() => {
    setExpanded(true);
    setInputFocused(true);
  }, []);

  const fillPreset = useCallback(
    (preset: NextStepPreset) => {
      const text = lang === 'en' ? preset.promptEn : preset.promptZh;
      setInputValue(text);
      setExpanded(true);
      setInputFocused(true);
    },
    [lang],
  );

  // Idle activation via uniform key 'a'
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      if (input === NEXT_STEP_ACTIVATION_KEY) {
        openAndFocus();
      }
    },
    { isActive: isActive && !engaged },
  );

  // Expanded (non-typing) controls: [a]/Enter continue, [1-4] fill preset, [N] save, [Esc] collapse
  useInput(
    (input, key) => {
      if (key.escape) {
        abortConversation();
        setExpanded(false);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input === NEXT_STEP_ACTIVATION_KEY || input === 'i' || key.return) {
        setInputFocused(true);
        return;
      }
      if (input === 'N' && !streaming) {
        void saveLatestToNotes();
        return;
      }
      const preset = NEXT_STEP_PRESETS.find((p) => p.key === input);
      if (preset && !streaming) {
        fillPreset(preset);
      }
    },
    { isActive: isActive && expanded && !inputFocused },
  );

  const innerW = Math.max(20, width);

  if (!expanded) {
    return (
      <ClickableBox
        borderStyle={asciiMode ? 'classic' : 'single'}
        borderColor={theme.border}
        paddingX={1}
        height={3}
        width={innerW}
        flexShrink={0}
        overflow="hidden"
        clickActive={isActive}
        onClick={openAndFocus}
      >
        <Box flexDirection="row" alignItems="center" width={Math.max(12, innerW - 4)} overflow="hidden">
          <Text color={theme.ai} bold>{`${asciiMode ? '>' : '›'} `}</Text>
          <Text color={theme.muted} wrap="truncate">
            {truncateDisplay(nextStepIdlePrompt(lang), Math.max(10, innerW - 6), ell)}
          </Text>
        </Box>
      </ClickableBox>
    );
  }

  // Expanded panel: header(1) + presets(1) + conversation(convH) + input(3)
  const boxH = Math.max(8, expandedHeight);
  const convH = Math.max(2, boxH - 5);

  return (
    <Box flexDirection="column" width={innerW} height={boxH} flexShrink={0} overflow="hidden">
      {/* Header row */}
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" height={1} width={innerW} overflow="hidden">
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Badge label={t(lang, '接下来想做什么', 'Next Step AI')} tone="ai" variant="soft" />
          {streaming ? <Spinner label={t(lang, `生成中${ell}`, `Streaming${ell}`)} tone="ai" active={isActive} /> : null}
          {savingNote ? <Spinner label={t(lang, `保存中${ell}`, `Saving${ell}`)} tone="success" active={isActive} /> : null}
        </Box>
        <Text color={theme.dim} wrap="truncate">
          {truncateDisplay(
            inputFocused
              ? t(lang, 'Enter 发送 · Esc 收起', 'Enter send · Esc close')
              : t(lang, '[a] 追问 · [N] 存追问/笔记 · [Esc] 收起', '[a] Ask · [N] Save · [Esc] Collapse'),
            Math.max(12, innerW - 18),
            ell,
          )}
        </Text>
      </Box>

      {/* Quick preset pills (fill input, never restrict free-form typing) */}
      <Box flexDirection="row" gap={1} height={1} width={innerW} overflow="hidden">
        <Text color={theme.dim}>{t(lang, '快捷:', 'Quick:')}</Text>
        {NEXT_STEP_PRESETS.map((p) => (
          <ClickableBox
            key={p.key}
            clickActive={isActive && !streaming}
            onClick={() => fillPreset(p)}
            flexShrink={0}
          >
            <Text color={theme.ai}>{`[${p.key}]${lang === 'en' ? p.labelEn : p.labelZh}`}</Text>
          </ClickableBox>
        ))}
      </Box>

      {/* Unified Transcript / Error / Empty hint (#1354 D7) */}
      <AiConversation
        turns={turns}
        streaming={streaming}
        streamingText={streamingText}
        errorText={errorText}
        width={innerW}
        height={convH}
        isActive={isActive && expanded && !inputFocused}
        emptyText={t(
          lang,
          `已自动带上本题与「${toolLabel}」结果，直接输入要求或点上方快捷项`,
          `Card & "${toolLabel}" output attached automatically — type your instruction or pick a preset`,
        )}
      />

      {/* Free-form input */}
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
            t(
              lang,
              '接下来想做什么？直接输入要求，Enter 发送',
              'What next? Type any instruction and press Enter',
            ),
            Math.max(10, innerW - 6),
            ell,
          )}
          onSubmit={(val) => {
            const trimmed = val.trim();
            if (!trimmed) return;
            setInputValue('');
            void sendInstruction(trimmed);
          }}
          onCancel={() => {
            setInputFocused(false);
            if (turnsRef.current.length === 0 && !streaming && !errorText) {
              setExpanded(false);
            }
          }}
        />
      </ClickableBox>
    </Box>
  );
});
