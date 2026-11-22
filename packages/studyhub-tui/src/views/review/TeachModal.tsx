import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, type ReviewRun } from '../../host/index.js';
import {
  Badge,
  Divider,
  MarkdownView,
  Modal,
  Spinner,
  TextInput,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { kindLabel, type NormalizedKind } from './review-helpers.js';

export interface TeachingSessionView {
  id: string;
  mode: 'understanding' | 'calculation' | string;
  index: number;
  total: number;
  lesson?: string;
  check?: string;
  feedback?: string;
  stage?: string;
  assumptions?: string;
  units?: string;
  rounding?: string;
  citations?: Array<{ sourceId?: string; quote?: string }>;
  complete: boolean;
  transfer?: string;
}

export interface TeachModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  onClose: () => void;
}

interface TeachTurn {
  role: 'tutor' | 'learner' | 'feedback';
  text: string;
  passed?: boolean;
}

function isModelUnavailableError(message: string): boolean {
  return /configure a model|model.*unavailable|no.*model|api.?key|unauthorized|forbidden|\b401\b|\b403\b|econnrefused|timed out|timeout|未配置|可用.*模型|模型不可用/i.test(
    message,
  );
}

function needsAnswerFirstError(message: string): boolean {
  return /answer the original question before guided teaching/i.test(message);
}

function formatStepMarkdown(session: TeachingSessionView, lang: UiLanguage): string {
  const stepNum = Math.min(session.total || 1, (session.index ?? 0) + 1);
  const total = Math.max(1, session.total || 1);
  const stageTag = session.stage ? ` · ${session.stage}` : '';
  const parts: string[] = [`### ${t(lang, `第 ${stepNum}/${total} 步${stageTag}`, `Step ${stepNum}/${total}${stageTag}`)}`];
  if (session.lesson) parts.push(session.lesson);
  const metaLines: string[] = [];
  if (session.assumptions) metaLines.push(`- **${t(lang, '假设', 'Assumptions')}**: ${session.assumptions}`);
  if (session.units) metaLines.push(`- **${t(lang, '单位', 'Units')}**: ${session.units}`);
  if (session.rounding) metaLines.push(`- **${t(lang, '精度', 'Rounding')}**: ${session.rounding}`);
  if (Array.isArray(session.citations) && session.citations.length > 0) {
    const firstQuote = session.citations[0]?.quote?.trim();
    if (firstQuote) metaLines.push(`- **${t(lang, '依据', 'Citation')}**: "${firstQuote}"`);
  }
  if (metaLines.length > 0) parts.push(metaLines.join('\n'));
  if (session.check) {
    parts.push(`> **${t(lang, '检验提问', 'Check')}**: ${session.check}`);
  }
  return parts.join('\n\n');
}

function formatCompletionMarkdown(session: TeachingSessionView, lang: UiLanguage): string {
  const parts: string[] = [`### ${t(lang, '带学完成 · 核心迁移法则', 'Teaching Complete · Transfer Rule')}`];
  if (session.transfer) parts.push(session.transfer);
  else parts.push(t(lang, '已完成全部前置阶梯检验，可以继续下一题复习。', 'All prerequisite steps mastered. Ready to continue your review.'));
  return parts.join('\n\n');
}

export const TeachModal = memo(function TeachModal({
  host,
  run,
  cardId,
  kind,
  width,
  height,
  isActive,
  mathUnicode,
  onClose,
}: TeachModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const initialTeaching = (run as { teaching?: TeachingSessionView | null } | null)?.teaching ?? null;
  const [teachMode, setTeachMode] = useState<'understanding' | 'calculation'>(
    initialTeaching?.mode === 'calculation' ? 'calculation' : 'understanding',
  );
  const [session, setSession] = useState<TeachingSessionView | null>(null);
  const [turns, setTurns] = useState<TeachTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [inputFocused, setInputFocused] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSession = useCallback(
    async (targetMode: 'understanding' | 'calculation', allowGetExisting: boolean) => {
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setErrorText(null);
      setTurns([]);
      setSession(null);
      setDraft('');

      let loaded: TeachingSessionView | null = null;
      if (allowGetExisting && initialTeaching?.id && (initialTeaching.mode || 'understanding') === targetMode) {
        const existingRes = await tryAction<TeachingSessionView>(host, 'teach.get', {
          id: initialTeaching.id,
        });
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        if (existingRes.ok && existingRes.value?.id) {
          loaded = existingRes.value;
        }
      }

      if (!loaded) {
        const startRes = await tryAction<TeachingSessionView>(host, 'teach.start', {
          runId: run.id,
          cardId,
          index: run.index,
          queueVersion: run.queueVersion ?? 0,
          mode: targetMode,
          language: lang,
        });
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        if (!startRes.ok || !startRes.value?.id) {
          setLoading(false);
          setErrorText(
            startRes.error?.message || t(lang, '无法开启苏格拉底带学', 'Failed to start guided teaching'),
          );
          return;
        }
        loaded = startRes.value;
      }

      setLoading(false);
      setSession(loaded);
      const nextTurns: TeachTurn[] = [];
      if (loaded.feedback) {
        nextTurns.push({ role: 'feedback', text: loaded.feedback });
      }
      if (loaded.complete) {
        nextTurns.push({ role: 'tutor', text: formatCompletionMarkdown(loaded, lang) });
        setInputFocused(false);
      } else {
        nextTurns.push({ role: 'tutor', text: formatStepMarkdown(loaded, lang) });
        setInputFocused(true);
      }
      setTurns(nextTurns);
    },
    [host, run.id, run.index, run.queueVersion, cardId, lang, initialTeaching],
  );

  useEffect(() => {
    void loadSession(teachMode, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, cardId, teachMode]);

  const handleSubmitAnswer = useCallback(
    async (rawText?: string) => {
      if (submitting || loading || !session || session.complete) return;
      const answer = (rawText ?? draft).trim();
      if (!answer) {
        notify(t(lang, '请先输入你的回答再按 Enter 提交', 'Type your response before submitting'), 'warning');
        return;
      }
      const seq = reqSeqRef.current;
      const prevIndex = session.index;
      setSubmitting(true);
      setErrorText(null);
      setDraft('');
      setTurns((prev) => [...prev, { role: 'learner', text: answer }]);

      const res = await tryAction<TeachingSessionView>(host, 'teach.answer', {
        id: session.id,
        answer,
        stepIndex: prevIndex,
      });
      if (!mountedRef.current || reqSeqRef.current !== seq) return;
      setSubmitting(false);

      if (!res.ok || !res.value) {
        setErrorText(res.error?.message || t(lang, '提交带学回答失败', 'Failed to submit teaching answer'));
        setInputFocused(false);
        return;
      }

      const next = res.value;
      const passed = Boolean(next.complete || next.index > prevIndex);
      setSession(next);
      setTurns((prev) => {
        const appended = [...prev];
        if (next.feedback) {
          appended.push({ role: 'feedback', text: next.feedback, passed });
        }
        if (next.complete) {
          appended.push({ role: 'tutor', text: formatCompletionMarkdown(next, lang) });
        } else if (next.index > prevIndex) {
          appended.push({ role: 'tutor', text: formatStepMarkdown(next, lang) });
        }
        return appended;
      });
      if (next.complete) {
        setInputFocused(false);
      }
    },
    [submitting, loading, session, draft, notify, lang, host],
  );

  const canType = Boolean(session && !session.complete && !loading && !errorText);
  const inputActive = isActive && canType && inputFocused && !submitting;

  useInput(
    (input, key) => {
      if (loading || submitting) return;
      if (input === 'r') {
        void loadSession(teachMode, false);
        return;
      }
      if (input === 'm') {
        setTeachMode((prev) => (prev === 'understanding' ? 'calculation' : 'understanding'));
        return;
      }
      if ((input === 'i' || key.return || key.tab) && canType) {
        setInputFocused(true);
      }
    },
    { isActive: isActive && !inputActive },
  );

  const dialogueMarkdown = useMemo(() => {
    const blocks: string[] = [];
    for (const turn of turns) {
      if (turn.role === 'learner') {
        blocks.push(`> **${t(lang, '你', 'You')}**: ${turn.text}`);
      } else if (turn.role === 'feedback') {
        const tag =
          turn.passed === true
            ? asciiMode
              ? '[+]'
              : '✓'
            : turn.passed === false
              ? asciiMode
                ? '[!]'
                : '▲'
              : '·';
        blocks.push(`**${tag} ${t(lang, '导师点评', 'Tutor Feedback')}**: ${turn.text}`);
      } else {
        blocks.push(turn.text);
      }
    }
    if (submitting) {
      blocks.push(t(lang, `_导师正在评估你的回答${ell}_`, `_Tutor is evaluating your response${ell}_`));
    }
    return blocks.join('\n\n---\n\n');
  }, [turns, submitting, lang, asciiMode, ell]);

  const frameW = Math.max(48, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);

  const showInput = canType;
  // Status bar (1) + Divider (1) + Input box (3 when shown)
  const scrollH = Math.max(3, bodyH - (showInput ? 5 : 2));

  const topicName = typeof run.card?.topic === 'string' && run.card.topic ? run.card.topic : '';
  const stepLabel = session
    ? session.complete
      ? `${session.total}/${session.total}`
      : `${Math.min(session.total || 1, (session.index ?? 0) + 1)}/${Math.max(1, session.total || 1)}`
    : '--';

  const hints = useMemo<KeyHint[]>(() => {
    if (loading || submitting) {
      return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    }
    if (inputActive) {
      return [
        { key: 'Enter', label: t(lang, '提交回答', 'Submit') },
        { key: 'Tab', label: t(lang, '滚动对话', 'Scroll') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    const items: KeyHint[] = [];
    if (canType) items.push({ key: 'i/Tab', label: t(lang, '继续作答', 'Reply') });
    if (turns.length > 0) items.push({ key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') });
    items.push({ key: 'm', label: teachMode === 'understanding' ? t(lang, '切计算', 'Calc') : t(lang, '切理解', 'Concept') });
    items.push({ key: 'r', label: t(lang, '刷新', 'Reload') });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [loading, submitting, inputActive, canType, turns.length, teachMode, lang, asciiMode]);

  const needAnswerFirst = errorText ? needsAnswerFirstError(errorText) : false;
  const modelUnavailable = errorText ? isModelUnavailableError(errorText) : false;

  return (
    <Modal
      title={t(lang, '苏格拉底带学模式', 'Socratic Teach Mode')}
      icon={asciiMode ? '*' : '✦'}
      tone="ai"
      subtitle={`${kindLabel(kind, lang)}${topicName ? ` · ${topicName}` : ''}`}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive && !inputActive}
      hints={hints}
    >
      {/* Top Session Progress & Mode Bar */}
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" width={innerW} height={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Badge
            label={
              teachMode === 'calculation'
                ? t(lang, '分步计算', 'Calculation')
                : t(lang, '概念引导', 'Understanding')
            }
            tone="ai"
            variant="soft"
          />
          <Badge label={`${t(lang, '阶梯', 'Step')} ${stepLabel}`} tone="primary" variant="soft" />
          {session?.complete ? (
            <Badge
              label={asciiMode ? '+ Complete' : '✓ 已掌握 · Complete'}
              tone="success"
            />
          ) : null}
        </Box>
        {submitting ? (
          <Spinner label={t(lang, `批改中${ell}`, `Checking${ell}`)} tone="ai" active={isActive} />
        ) : (
          <Text color={theme.dim}>
            {truncateDisplay(
              inputActive ? t(lang, '[Tab] 滚动对话', '[Tab] Scroll') : t(lang, '[m] 切模式 · [r] 重载', '[m] Mode · [r] Reload'),
              Math.max(10, Math.floor(innerW * 0.4)),
            )}
          </Text>
        )}
      </Box>

      <Divider width={innerW} />

      {loading ? (
        <Box height={scrollH} width={innerW} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
          <Spinner label={t(lang, `正在生成苏格拉底带学阶梯${ell}`, `Preparing Socratic teaching steps${ell}`)} tone="ai" active={isActive} />
          <Text color={theme.dim}>{t(lang, '紧扣本题前置知识与原文证据，逐步引导理解', 'Building prerequisite steps grounded in source material')}</Text>
        </Box>
      ) : errorText ? (
        <Box height={scrollH} width={innerW} flexDirection="column" justifyContent="center" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Badge label={asciiMode ? '! 暂不可用' : '▲ 无法开启'} tone="warning" />
            <Text color={theme.error} bold>
              {truncateDisplay(errorText, Math.max(12, innerW - 18))}
            </Text>
          </Box>
          <Text color={theme.muted}>
            {needAnswerFirst
              ? t(
                  lang,
                  '请先在复习界面完成本题作答（或翻看并评分），然后再按 [L] 开启苏格拉底带学。',
                  'Please answer or rate this card first in ReviewView, then press [L] to start Socratic Teach Mode.',
                )
              : modelUnavailable
                ? t(
                    lang,
                    '当前未检测到可用 AI 模型或模型超时。请按 [,] 前往设置配置模型后，按 [r] 重试。',
                    'No working AI model available or request timed out. Configure a model in Settings ([,]) and press [r] to retry.',
                  )
                : t(
                    lang,
                    '你可以按 [r] 重试、按 [m] 切换理解/计算模式，或按 [Esc] 返回复习。',
                    'Press [r] to retry, [m] to switch teaching mode, or [Esc] to return.',
                  )}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" width={innerW} flexGrow={1} overflow="hidden">
          <Box height={scrollH} width={innerW} overflow="hidden">
            <MarkdownView
              markdown={dialogueMarkdown}
              width={innerW}
              height={scrollH}
              isActive={isActive && !inputActive}
              mathUnicode={mathUnicode}
              follow={inputActive || submitting}
            />
          </Box>

          {showInput ? (
            <Box
              borderStyle={asciiMode ? 'classic' : 'single'}
              borderColor={inputActive ? theme.ai : theme.border}
              paddingX={1}
              height={3}
              width={innerW}
            >
              <TextInput
                value={draft}
                onChange={setDraft}
                isActive={inputActive}
                width={Math.max(12, innerW - 6)}
                prompt={asciiMode ? '>' : '›'}
                placeholder={
                  submitting
                    ? t(lang, `正在提交${ell}`, `Submitting${ell}`)
                    : t(lang, '输入你的回答，Enter 提交 · Tab 切换滚动 · Esc 关闭', 'Your answer (Enter submit · Tab scroll · Esc close)')
                }
                onTab={() => {
                  setInputFocused(false);
                  return undefined;
                }}
                onSubmit={(val) => void handleSubmitAnswer(val)}
                onCancel={onClose}
              />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
