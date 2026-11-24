import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import { kindLabel, type NormalizedKind } from './review-helpers.js';
import { NextStepFollowupBar } from './NextStepFollowupBar.js';

export interface SkippedTeachingStep {
  index: number;
  lesson?: string;
  answer?: string;
}

export interface TeachingSessionView {
  id: string;
  mode: 'understanding' | 'calculation' | string;
  index: number;
  total: number;
  lesson?: string;
  check?: string;
  feedback?: string;
  skippedSteps?: SkippedTeachingStep[];
  masteredCount?: number;
  wrongTries?: number;
  skipped?: boolean;
  skippedAll?: boolean;
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
  const skipped = Array.isArray(session.skippedSteps) ? session.skippedSteps : [];
  const mastered = typeof session.masteredCount === 'number'
    ? session.masteredCount
    : Math.max(0, (session.total || 0) - skipped.length);
  const total = Math.max(1, session.total || 1);
  const parts: string[] = [
    `### ${t(lang, '带学完成 · 核心迁移法则', 'Teaching Complete · Transfer Rule')}`,
  ];
  if (session.transfer) parts.push(session.transfer);
  else parts.push(t(lang, '已完成本轮带学，可以继续下一题复习。', 'Guided teaching finished. Ready to continue your review.'));
  if (skipped.length > 0) {
    const summaryTitle = t(
      lang,
      `#### 已跳过步骤（${skipped.length} 步未计为已掌握，已掌握 ${mastered}/${total} 步）`,
      `#### Skipped Steps (${skipped.length} not counted as mastered; mastered ${mastered}/${total})`,
    );
    const items = skipped.map((item) => {
      const num = (item.index ?? 0) + 1;
      const body = item.lesson ? item.lesson : t(lang, '（见上方要点）', '(see key point above)');
      return t(lang, `- 第 ${num} 步：${body}`, `- Step ${num}: ${body}`);
    });
    parts.push(`${summaryTitle}\n${items.join('\n')}`);
  }
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
      const skipped = Boolean(next.skipped);
      const passed = skipped ? undefined : Boolean(next.complete || next.index > prevIndex);
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

  const handleSkipStep = useCallback(
    async (all = false) => {
      if (submitting || loading || !session || session.complete) return;
      const seq = reqSeqRef.current;
      const prevIndex = session.index;
      setSubmitting(true);
      setErrorText(null);
      setDraft('');
      setTurns((prev) => [
        ...prev,
        {
          role: 'learner',
          text: all
            ? t(lang, '剩下的直接讲给我听', 'Show all remaining key points')
            : t(lang, '跳过这一步', 'Skip this step'),
        },
      ]);

      const res = await tryAction<TeachingSessionView>(host, 'teach.skip', {
        id: session.id,
        stepIndex: prevIndex,
        ...(all ? { all: true } : {}),
      });
      if (!mountedRef.current || reqSeqRef.current !== seq) return;
      setSubmitting(false);

      if (!res.ok || !res.value) {
        setErrorText(res.error?.message || t(lang, '跳过当前步骤失败', 'Failed to skip teaching step'));
        setInputFocused(false);
        return;
      }

      const next = res.value;
      setSession(next);
      setTurns((prev) => {
        const appended = [...prev];
        if (next.feedback) {
          appended.push({ role: 'feedback', text: next.feedback });
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
    [submitting, loading, session, lang, host],
  );

  const [followupEngaged, setFollowupEngaged] = useState(false);
  const canType = Boolean(session && !session.complete && !loading && !errorText);
  const canFollowup = Boolean(session?.complete && !loading && !errorText);
  const inputActive = isActive && canType && inputFocused && !submitting;
  const skippedCount = session?.skippedSteps?.length ?? 0;
  const wrongTries = session?.wrongTries ?? 0;
  const showWrongNudge = canType && wrongTries >= 2;

  useInput(
    (input, key) => {
      if (loading || submitting || !canType) return;
      if (key.ctrl && input === 'n') {
        void handleSkipStep(false);
      }
    },
    { isActive: isActive && canType && !followupEngaged },
  );

  useInput(
    (input, key) => {
      if (loading || submitting) return;
      if ((input === 's' || input === 'S') && canType) {
        void handleSkipStep(false);
        return;
      }
      if ((input === 'e' || input === 'E') && canType) {
        void handleSkipStep(true);
        return;
      }
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
    { isActive: isActive && !inputActive && !followupEngaged },
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
  const followupExpandedH = Math.min(11, Math.max(8, Math.floor(bodyH * 0.55)));
  const followupReservedH = canFollowup ? (followupEngaged ? followupExpandedH : 3) : 0;
  const nudgeReservedH = showWrongNudge ? 1 : 0;
  // Status bar (1) + Divider (1) + Input box (3 when shown) + Wrong-try nudge (1 when shown) + Follow-up bar (when complete)
  const scrollH = Math.max(3, bodyH - (showInput ? 5 : 2) - nudgeReservedH - followupReservedH);

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
        { key: 'Ctrl+N', label: t(lang, '跳过此步', 'Skip step') },
        { key: 'Tab', label: t(lang, '滚动/操作', 'Scroll/Actions') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    const items: KeyHint[] = [];
    if (canType) {
      items.push({ key: 'i/Tab', label: t(lang, '继续作答', 'Reply') });
      items.push({ key: 's', label: t(lang, '跳过此步', 'Skip') });
      items.push({ key: 'e', label: t(lang, '剩余直接讲', 'Show rest') });
    }
    if (canFollowup) items.push({ key: 'a', label: t(lang, '后续指令', 'Next step') });
    if (turns.length > 0) items.push({ key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') });
    items.push({ key: 'm', label: teachMode === 'understanding' ? t(lang, '切计算', 'Calc') : t(lang, '切理解', 'Concept') });
    items.push({ key: 'r', label: t(lang, '刷新', 'Reload') });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [loading, submitting, inputActive, canType, canFollowup, turns.length, teachMode, lang, asciiMode]);

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
      isActive={isActive && !inputActive && !followupEngaged}
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
          {skippedCount > 0 ? (
            <Badge
              label={t(lang, `已跳过 ${skippedCount}`, `Skipped ${skippedCount}`)}
              tone="warning"
              variant="soft"
            />
          ) : null}
          {session?.complete ? (
            skippedCount > 0 ? (
              <Badge
                label={t(
                  lang,
                  `已完成 (掌握 ${session.masteredCount ?? 0}/${session.total})`,
                  `Done (${session.masteredCount ?? 0}/${session.total} mastered)`,
                )}
                tone="primary"
              />
            ) : (
              <Badge
                label={asciiMode ? '+ Complete' : '✓ 已掌握 · Complete'}
                tone="success"
              />
            )
          ) : null}
        </Box>
        {submitting ? (
          <Spinner label={t(lang, `批改中${ell}`, `Checking${ell}`)} tone="ai" active={isActive} />
        ) : (
          <Text color={theme.dim}>
            {truncateDisplay(
              inputActive
                ? t(lang, '[Ctrl+N] 跳过 · [Tab] 操作', '[Ctrl+N] Skip · [Tab] Actions')
                : canType
                  ? t(lang, '[s] 跳过 · [e] 剩余直接讲', '[s] Skip · [e] Show rest')
                  : t(lang, '[m] 切模式 · [r] 重载', '[m] Mode · [r] Reload'),
              Math.max(10, Math.floor(innerW * 0.42)),
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
              {errorText}
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
              isActive={isActive && !inputActive && !followupEngaged}
              mathUnicode={mathUnicode}
              follow={inputActive || submitting || Boolean(session?.complete)}
            />
          </Box>

          {canFollowup ? (
            <NextStepFollowupBar
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              toolLabel={t(lang, '苏格拉底带学', 'Socratic Teach')}
              resultContext={dialogueMarkdown}
              width={innerW}
              expandedHeight={followupExpandedH}
              isActive={isActive && canFollowup}
              onFocusChange={setFollowupEngaged}
            />
          ) : null}

          {showWrongNudge ? (
            <Box height={1} width={innerW} flexDirection="row" alignItems="center">
              <Text color={theme.warning}>
                {truncateDisplay(
                  t(
                    lang,
                    `已连续答错 ${wrongTries} 次，可以看要点并继续：按 [Ctrl+N]（或 Tab 后按 [s]）跳过此步，或输入「跳过」`,
                    `${wrongTries} wrong tries - view key point & continue: press [Ctrl+N] (or Tab then [s]) to skip, or type "skip"`,
                  ),
                  innerW,
                )}
              </Text>
            </Box>
          ) : null}

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
                    : t(
                        lang,
                        '输入回答（或输入「跳过」），Enter 提交 · Ctrl+N 跳过 · Tab 操作',
                        'Your answer (or type "skip") | Enter submit | Ctrl+N skip | Tab actions',
                      )
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
