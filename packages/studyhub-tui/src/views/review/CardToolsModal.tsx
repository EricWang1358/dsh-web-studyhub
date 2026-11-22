import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { getReview, tryAction, type ReviewRun } from '../../host/index.js';
import {
  Badge,
  Divider,
  Modal,
  Spinner,
  TextInput,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import {
  currentDeckIdOf,
  extractFeedback,
  extractReferenceAnswer,
  extractSolution,
  type NormalizedKind,
} from './review-helpers.js';

export interface CardToolsModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
  onRunUpdated: (nextRun: ReviewRun) => void;
  onCardEdited?: (cardId: string) => void;
  onRefreshSnapshot?: () => void;
}

type ToolMode = 'menu' | 'edit' | 'confirm-slay';
type EditField = 'prompt' | 'answer' | 'explanation';

interface CardDetailShape {
  id?: string;
  kind?: string;
  prompt?: string;
  answer?: string;
  explanation?: string;
  suspended?: boolean;
}

export const CardToolsModal = memo(function CardToolsModal({
  host,
  run,
  cardId,
  kind,
  width,
  height,
  isActive,
  onClose,
  onRunUpdated,
  onCardEdited,
  onRefreshSnapshot,
}: CardToolsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const notify = useTuiStore((s) => s.notify);

  const deckId = currentDeckIdOf(run) ?? '';
  const feedback = extractFeedback(run);
  const solution = extractSolution(run);

  const initialPrompt = String(run.card?.prompt ?? '');
  const initialAnswer = String(
    (run.card as { answer?: unknown } | null | undefined)?.answer ??
      solution?.answer ??
      (kind === 'flashcard' || kind === 'short_answer' ? extractReferenceAnswer(run, kind, lang) : ''),
  );
  const initialExplanation = String(solution?.explanation ?? '');

  const [mode, setMode] = useState<ToolMode>('menu');
  const [menuCursor, setMenuCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<boolean>(Boolean((run.card as { suspended?: unknown } | null | undefined)?.suspended));

  // Edit form fields
  const [editField, setEditField] = useState<EditField>('prompt');
  const [promptDraft, setPromptDraft] = useState(initialPrompt);
  const [answerDraft, setAnswerDraft] = useState(initialAnswer);
  const [explanationDraft, setExplanationDraft] = useState(initialExplanation);
  const baselineRef = useRef({
    prompt: initialPrompt,
    answer: initialAnswer,
    explanation: initialExplanation,
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hydrate full card details (authoritative suspended state, answer & explanation even pre-reveal)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await tryAction<{ card?: CardDetailShape }>(host, 'card.get', {
        ...(deckId ? { deckId } : {}),
        cardId,
      });
      if (!alive || !mountedRef.current || !res.ok || !res.value?.card) return;
      const c = res.value.card;
      const nextPrompt = typeof c.prompt === 'string' ? c.prompt : initialPrompt;
      const nextAnswer = typeof c.answer === 'string' ? c.answer : '';
      const nextExpl = typeof c.explanation === 'string' ? c.explanation : '';
      setSuspended(Boolean(c.suspended));
      setPromptDraft(nextPrompt);
      setAnswerDraft(nextAnswer);
      setExplanationDraft(nextExpl);
      baselineRef.current = {
        prompt: nextPrompt,
        answer: nextAnswer,
        explanation: nextExpl,
      };
    })();
    return () => {
      alive = false;
    };
  }, [host, deckId, cardId, initialPrompt]);

  const isExam = run.mode === 'exam';
  const isRetry = Boolean(run.retry);
  const canAdjustCloze = !isExam && !isRetry && kind === 'fill_blank' && Boolean(feedback) && !feedback?.correct;
  const canAdjustRubric =
    !isExam &&
    !isRetry &&
    kind === 'short_answer' &&
    Boolean(feedback) &&
    !feedback?.taskCheck &&
    (Boolean((feedback as { rubric?: unknown } | null)?.rubric) || (!feedback?.correct && !feedback?.selfReported));
  const canAdjustGrade = canAdjustCloze || canAdjustRubric;

  const canEditAnswer = kind === 'flashcard' || kind === 'short_answer' || baselineRef.current.answer.length > 0;

  const handleSaveEdit = useCallback(async () => {
    if (busy) return;
    const base = baselineRef.current;
    const patch: Record<string, string> = {};
    const p = promptDraft.trim();
    const a = answerDraft.trim();
    const e = explanationDraft.trim();
    if (p !== base.prompt.trim() && p.length > 0) patch.prompt = p;
    if (canEditAnswer && a !== base.answer.trim()) patch.answer = a;
    if (e !== base.explanation.trim()) patch.explanation = e;

    if (Object.keys(patch).length === 0) {
      setErrorText(t(lang, '内容未发生修改', 'No changes to save'));
      return;
    }

    setBusy(true);
    setErrorText(null);
    const res = await tryAction(host, 'card.update', {
      ...(deckId ? { deckId } : {}),
      cardId,
      patch,
      reason: 'Updated in StudyHub TUI review',
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setBusy(false);
      setErrorText(res.error?.message || t(lang, '保存题目修改失败', 'Failed to update card'));
      return;
    }
    onCardEdited?.(cardId);
    try {
      const refreshed = await getReview(host, run.id);
      if (!mountedRef.current) return;
      onRunUpdated(refreshed);
    } catch {
      // card.update succeeded even if run refresh failed
    }
    if (!mountedRef.current) return;
    setBusy(false);
    onRefreshSnapshot?.();
    notify(t(lang, '题目已更新并刷新当前复习', 'Card updated and review refreshed'), 'success');
    onClose();
  }, [
    busy,
    promptDraft,
    answerDraft,
    explanationDraft,
    canEditAnswer,
    lang,
    host,
    deckId,
    cardId,
    onCardEdited,
    run.id,
    onRunUpdated,
    onRefreshSnapshot,
    notify,
    onClose,
  ]);

  const handleToggleSuspend = useCallback(async () => {
    if (busy) return;
    if (!deckId) {
      setErrorText(t(lang, '缺少题组 ID，无法暂停/恢复', 'Missing deckId for card.suspend'));
      return;
    }
    const nextSuspended = !suspended;
    setBusy(true);
    setErrorText(null);
    const res = await tryAction<{ ok?: boolean }>(host, 'card.suspend', {
      deckId,
      cardId,
      suspended: nextSuspended,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error?.message || t(lang, '更新暂停状态失败', 'Failed to toggle suspend'));
      return;
    }
    setSuspended(nextSuspended);
    onRefreshSnapshot?.();
    notify(
      nextSuspended
        ? t(lang, '已暂停此题，将离开每日复习队列', 'Card suspended from daily queue')
        : t(lang, '已恢复此题到复习队列', 'Card resumed in queue'),
      'success',
    );
    onClose();
  }, [busy, deckId, suspended, host, cardId, onRefreshSnapshot, notify, lang, onClose]);

  const handleConfirmSlay = useCallback(async () => {
    if (busy) return;
    if (!deckId) {
      setErrorText(t(lang, '缺少题组 ID，无法斩题', 'Missing deckId for card.slay'));
      return;
    }
    setBusy(true);
    setErrorText(null);
    const res = await tryAction<ReviewRun>(host, 'card.slay', {
      deckId,
      cardId,
      runId: run.id,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error?.message || t(lang, '斩题失败', 'Failed to slay card'));
      return;
    }
    if (res.value && typeof res.value === 'object' && 'id' in res.value) {
      onRunUpdated(res.value);
    }
    onRefreshSnapshot?.();
    notify(t(lang, '已斩题：移入斩题组并推进到下一题', 'Card slain and advanced'), 'success');
    onClose();
  }, [busy, deckId, host, cardId, run.id, onRunUpdated, onRefreshSnapshot, notify, lang, onClose]);

  const handleAdjustGrade = useCallback(async () => {
    if (busy || !canAdjustGrade) return;
    setBusy(true);
    setErrorText(null);
    const args: Record<string, unknown> = canAdjustCloze
      ? {
          runId: run.id,
          cardId,
          entryIndex: run.index,
          clozeEquivalent: true,
          saveAccept: true,
        }
      : {
          runId: run.id,
          cardId,
          entryIndex: run.index,
          grade: 4,
        };
    const res = await tryAction<ReviewRun>(host, 'review.grade.adjust', args);
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok || !res.value) {
      setErrorText(res.error?.message || t(lang, '等效改判失败', 'Failed to adjust grade'));
      return;
    }
    onRunUpdated(res.value);
    onRefreshSnapshot?.();
    notify(t(lang, '已等效改判为正确', 'Judgment overridden as equivalent/correct'), 'success');
    onClose();
  }, [busy, canAdjustGrade, canAdjustCloze, run.id, run.index, cardId, host, onRunUpdated, onRefreshSnapshot, notify, lang, onClose]);

  const triggerOption = useCallback(
    (idx: number) => {
      setErrorText(null);
      if (idx === 0) {
        setEditField('prompt');
        setMode('edit');
      } else if (idx === 1) {
        void handleToggleSuspend();
      } else if (idx === 2) {
        setMode('confirm-slay');
      } else if (idx === 3) {
        if (!canAdjustGrade) {
          setErrorText(
            t(
              lang,
              '仅当填空题刚判错或简答题刚完成 AI 批改时可等效改判',
              'Available only after an auto-graded cloze or rubric-graded short answer',
            ),
          );
          return;
        }
        void handleAdjustGrade();
      }
    },
    [handleToggleSuspend, canAdjustGrade, handleAdjustGrade, lang],
  );

  useInput(
    (input, key) => {
      if (busy) return;
      if (mode === 'menu') {
        if (key.downArrow || input === 'j') {
          setMenuCursor((prev) => (prev + 1) % 4);
        } else if (key.upArrow || input === 'k') {
          setMenuCursor((prev) => (prev + 3) % 4);
        } else if (/^[1-4]$/.test(input)) {
          const idx = Number(input) - 1;
          setMenuCursor(idx);
          triggerOption(idx);
        } else if (key.return) {
          triggerOption(menuCursor);
        }
        return;
      }
      if (mode === 'confirm-slay') {
        if (input === 'y' || input === 'Y' || key.return) {
          void handleConfirmSlay();
        } else if (input === 'n' || input === 'N') {
          setMode('menu');
        }
      }
    },
    { isActive: isActive && mode !== 'edit' },
  );

  const cycleEditField = useCallback(() => {
    const order: EditField[] = canEditAnswer ? ['prompt', 'answer', 'explanation'] : ['prompt', 'explanation'];
    setEditField((cur) => {
      const idx = order.indexOf(cur);
      return order[(idx + 1) % order.length];
    });
  }, [canEditAnswer]);

  const frameW = Math.max(50, Math.min(82, width - 4));
  const innerW = modalContentWidth(frameW);
  const inputH = height <= 25 ? 2 : 3;

  const hints = useMemo<KeyHint[]>(() => {
    if (mode === 'edit') {
      return [
        { key: 'Tab', label: t(lang, '切换字段', 'Field') },
        { key: 'Enter/Ctrl+S', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (mode === 'confirm-slay') {
      return [
        { key: 'y/Enter', label: t(lang, '确认斩题', 'Confirm') },
        { key: 'n/Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    return [
      { key: '1-4 / Enter', label: t(lang, '执行', 'Select') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [mode, lang]);

  const menuItems = [
    {
      key: '1',
      title: t(lang, '编辑题目', 'Edit Question'),
      desc: t(lang, '修改题干、参考答案或解析并刷新队列', 'Edit prompt, reference answer, or explanation'),
      enabled: true,
      badge: 'card.update',
    },
    {
      key: '2',
      title: suspended ? t(lang, '恢复题目', 'Resume Card') : t(lang, '暂停题目', 'Suspend Card'),
      desc: suspended
        ? t(lang, '当前已暂停：恢复到每日复习队列', 'Currently suspended: restore to queue')
        : t(lang, '暂离每日队列但不删除题目与记录', 'Pause from daily queue without deleting'),
      enabled: true,
      badge: suspended ? t(lang, '已暂停', 'Paused') : t(lang, '激活中', 'Active'),
    },
    {
      key: '3',
      title: t(lang, '斩题 / 永久掌握', 'Slay / Mastered'),
      desc: t(lang, '移入斩题组不再复习，并推进下一题', 'Move to Slain deck and advance'),
      enabled: true,
      badge: 'card.slay',
    },
    {
      key: '4',
      title: t(lang, '判分等效改判', 'Override Grade'),
      desc: canAdjustGrade
        ? t(lang, '将本题自动判分改判为等效/正确', 'Mark current auto-graded answer as equivalent')
        : t(lang, '需在填空错题或 AI 批改简答题后使用', 'Available after auto-graded cloze or open rubric'),
      enabled: canAdjustGrade,
      badge: canAdjustGrade ? t(lang, '可用', 'Ready') : t(lang, '暂不可用', 'N/A'),
    },
  ];

  return (
    <Modal
      title={t(lang, '题目工具箱', 'Card Tools')}
      icon="⚙"
      tone={mode === 'confirm-slay' ? 'error' : 'accent'}
      subtitle={truncateDisplay(String(run.card?.topic || cardId), 24)}
      width={frameW}
      onClose={mode === 'menu' ? onClose : () => setMode('menu')}
      isActive={isActive && mode !== 'edit'}
      hints={hints}
    >
      {busy ? (
        <Box height={1} marginY={0}>
          <Spinner label={t(lang, '正在提交操作…', 'Applying action…')} active={isActive} />
        </Box>
      ) : null}

      {errorText ? (
        <Box marginBottom={0}>
          <Text color={theme.error}>{`✕ ${truncateDisplay(errorText, innerW - 2)}`}</Text>
        </Box>
      ) : null}

      {mode === 'menu' ? (
        <Box flexDirection="column" marginY={0}>
          {menuItems.map((item, idx) => {
            const focused = idx === menuCursor;
            return (
              <Box
                key={item.key}
                flexDirection="column"
                paddingX={1}
                backgroundColor={focused ? theme.selectionBg : undefined}
              >
                <Box flexDirection="row" justifyContent="space-between" width={Math.max(20, innerW - 2)}>
                  <Text
                    color={
                      focused
                        ? theme.selectionFg
                        : item.enabled
                          ? theme.text
                          : theme.dim
                    }
                    bold={focused}
                  >
                    {`${focused ? '▸ ' : '  '}[${item.key}] ${item.title}`}
                  </Text>
                  <Badge
                    label={item.badge}
                    tone={!item.enabled ? 'neutral' : idx === 2 ? 'error' : idx === 1 && suspended ? 'warning' : 'accent'}
                    variant="soft"
                  />
                </Box>
                <Text color={focused ? theme.selectionFg : theme.muted}>
                  {`      ${truncateDisplay(item.desc, Math.max(12, innerW - 8))}`}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {mode === 'edit' ? (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.accent} bold>
            {t(lang, '1. 题干 (prompt)', '1. Stem (prompt)')}
          </Text>
          <Box
            borderStyle="single"
            borderColor={editField === 'prompt' ? theme.primary : theme.border}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={promptDraft}
              onChange={setPromptDraft}
              multiline
              submitOnEnter
              height={inputH}
              width={Math.max(12, innerW - 4)}
              isActive={isActive && mode === 'edit' && editField === 'prompt' && !busy}
              onTab={() => {
                cycleEditField();
                return undefined;
              }}
              onSubmit={() => void handleSaveEdit()}
              onCancel={() => setMode('menu')}
            />
          </Box>

          {canEditAnswer ? (
            <>
              <Text color={theme.accent} bold>
                {t(lang, '2. 参考答案 (answer)', '2. Reference Answer')}
              </Text>
              <Box
                borderStyle="single"
                borderColor={editField === 'answer' ? theme.primary : theme.border}
                paddingX={1}
                width={innerW}
              >
                <TextInput
                  value={answerDraft}
                  onChange={setAnswerDraft}
                  multiline
                  submitOnEnter
                  height={Math.max(1, inputH - 1)}
                  width={Math.max(12, innerW - 4)}
                  isActive={isActive && mode === 'edit' && editField === 'answer' && !busy}
                  onTab={() => {
                    cycleEditField();
                    return undefined;
                  }}
                  onSubmit={() => void handleSaveEdit()}
                  onCancel={() => setMode('menu')}
                />
              </Box>
            </>
          ) : null}

          <Text color={theme.accent} bold>
            {t(
              lang,
              `${canEditAnswer ? '3' : '2'}. 解析 (explanation)`,
              `${canEditAnswer ? '3' : '2'}. Explanation`,
            )}
          </Text>
          <Box
            borderStyle="single"
            borderColor={editField === 'explanation' ? theme.primary : theme.border}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={explanationDraft}
              onChange={setExplanationDraft}
              multiline
              submitOnEnter
              height={inputH}
              width={Math.max(12, innerW - 4)}
              isActive={isActive && mode === 'edit' && editField === 'explanation' && !busy}
              onTab={() => {
                cycleEditField();
                return undefined;
              }}
              onSubmit={() => void handleSaveEdit()}
              onCancel={() => setMode('menu')}
            />
          </Box>
        </Box>
      ) : null}

      {mode === 'confirm-slay' ? (
        <Box flexDirection="column" marginY={1} gap={1}>
          <Text color={theme.error} bold>
            {t(lang, '确认永久斩掉这道题？', 'Slay / permanently master this card?')}
          </Text>
          <Text color={theme.text}>
            {t(
              lang,
              '题目将被移入「斩题组」并不再出现在复习计划中，当前队列会自动前进到下一题。',
              'The card will move to the Slain deck and leave future review queues. The current round will advance immediately.',
            )}
          </Text>
          <Divider width={innerW} />
          <Box flexDirection="row" justifyContent="flex-end" gap={2}>
            <Text color={theme.muted}>{t(lang, '[n / Esc] 取消', '[n / Esc] Cancel')}</Text>
            <Text color={theme.error} bold>{t(lang, '[y / Enter] 确认斩题', '[y / Enter] Confirm Slay')}</Text>
          </Box>
        </Box>
      ) : null}
    </Modal>
  );
});
