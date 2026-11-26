import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { ScrollView } from '../../components/ScrollView.js';
import { truncateDisplay, wrapDisplay } from '../../render/cjk.js';

export interface CoachNudgeCheck {
  q: string;
  options: string[];
  answer?: number;
  why?: string;
}

export interface CoachNudgeFollowup {
  explain: string;
  at?: string;
}

export interface CoachNudgeNote {
  id: string;
  type: string;
  runId?: string;
  entryIndex?: number;
  deckId?: string;
  cardId?: string;
  point: string;
  explain: string;
  check?: CoachNudgeCheck | null;
  checked?: { choice: number; correct: boolean };
  reply?: 'got' | 'confused';
  followups?: CoachNudgeFollowup[];
  createdAt?: string;
}

export interface CoachNudgeModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  width: number;
  height: number;
  isActive: boolean;
  initialNote?: CoachNudgeNote | null;
  onNoteUpdate?: (note: CoachNudgeNote) => void;
  onClose: () => void;
}

type ConfirmKind = 'nudge' | 'confused' | null;
type BusyAction = 'nudge' | 'confused' | 'check' | 'got' | null;

function pickActiveNudge(thread: unknown, runId: string, entryIndex: number): CoachNudgeNote | null {
  if (!Array.isArray(thread)) return null;
  const notes = thread.filter(
    (item): item is CoachNudgeNote =>
      Boolean(item && typeof item === 'object' && (item as CoachNudgeNote).type === 'nudge'),
  );
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i];
    if (note.runId === runId && note.entryIndex === entryIndex) {
      return note;
    }
  }
  return notes.length > 0 ? notes[notes.length - 1] : null;
}

function isModelUnavailableMsg(message: string): boolean {
  return /configure a model|model.*unavailable|no.*model|api.?key|unauthorized|forbidden|\b401\b|\b403\b|econnrefused|timed out|timeout|未配置|可用.*模型|模型不可用|没有可用模型/i.test(
    message,
  );
}

export const CoachNudgeModal = memo(function CoachNudgeModal({
  host,
  run,
  cardId,
  width,
  height,
  isActive,
  initialNote = null,
  onNoteUpdate,
  onClose,
}: CoachNudgeModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const shellOverlay = useTuiStore(
    (s) => s.commandPaletteOpen || s.helpOpen || s.coursePickerOpen || s.inboxOpen || s.notificationHistoryOpen,
  );
  const notify = useTuiStore((s) => s.notify);
  const ell = asciiMode ? '...' : '…';

  const contextKey = `${run.id}:${run.index}:${cardId}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;

  const [note, setNote] = useState<CoachNudgeNote | null>(initialNote);
  const [followBottom, setFollowBottom] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setNote(initialNote);
    setFollowBottom(false);
    setConfirmKind(null);
    setErrorText(null);
  }, [contextKey, initialNote]);

  const isBusy = busyAction !== null;
  const followupsCount = note?.followups?.length ?? 0;
  const canFollowup = Boolean(note && followupsCount < 2);

  const executeNudge = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction('nudge');
    setErrorText(null);
    const reqContext = contextKeyRef.current;
    const reqRunId = run.id;
    const reqIndex = run.index;
    try {
      const res = await tryAction<{ thread?: unknown }>(host, 'coach.nudge', {
        runId: reqRunId,
        index: reqIndex,
      });
      if (!mountedRef.current || contextKeyRef.current !== reqContext) return;
      if (!res.ok || !res.value) {
        setErrorText(
          res.error?.message || t(lang, '生成陪学点拨失败', 'Failed to generate coach nudge'),
        );
        return;
      }
      const nextNote = pickActiveNudge(res.value.thread, reqRunId, reqIndex);
      if (!nextNote) {
        setErrorText(t(lang, '未获取到陪学点拨内容', 'No coach nudge content returned'));
        return;
      }
      setNote(nextNote);
      onNoteUpdate?.(nextNote);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [host, run.id, run.index, lang, onNoteUpdate]);

  const executeReply = useCallback(
    async (reply: 'got' | 'confused' | 'check', choice?: number) => {
      if (busyRef.current || !note?.id) return;
      if (reply === 'check' && (!note.check || note.checked)) return;
      if (reply === 'confused' && (note.followups?.length ?? 0) >= 2) {
        notify(t(lang, '已达追问上限 (2/2)', 'Max 2 follow-up angles reached'), 'info');
        return;
      }
      busyRef.current = true;
      setBusyAction(reply);
      setErrorText(null);
      const reqContext = contextKeyRef.current;
      const reqRunId = run.id;
      const reqIndex = run.index;
      const targetNoteId = note.id;
      try {
        const res = await tryAction<{ thread?: unknown }>(host, 'coach.reply', {
          noteId: targetNoteId,
          reply,
          ...(reply === 'check' && typeof choice === 'number' ? { choice } : {}),
        });
        if (!mountedRef.current || contextKeyRef.current !== reqContext) return;
        if (!res.ok || !res.value) {
          setErrorText(
            res.error?.message || t(lang, '提交陪学反馈失败', 'Failed to submit coach reply'),
          );
          return;
        }
        const thread = Array.isArray(res.value.thread) ? (res.value.thread as CoachNudgeNote[]) : [];
        const nextNote =
          thread.find((item) => item?.id === targetNoteId) ??
          pickActiveNudge(thread, reqRunId, reqIndex);
        if (nextNote) {
          setNote(nextNote);
          onNoteUpdate?.(nextNote);
        }
        if (reply === 'confused') {
          setFollowBottom(true);
        } else if (reply === 'got') {
          notify(t(lang, '已标记为理解掌握', 'Marked as understood'), 'success');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyAction(null);
      }
    },
    [host, note, run.id, run.index, lang, notify, onNoteUpdate],
  );

  const modalActive = isActive && !shellOverlay && confirmKind === null;

  useInput(
    (input, key) => {
      if (isBusy) return;
      if (!note) {
        if (input === 'g' || input === 'G' || key.return) {
          setConfirmKind('nudge');
        }
        return;
      }

      if (note.check && !note.checked && /^[1-9]$/.test(input)) {
        const choiceIdx = Number(input) - 1;
        if (choiceIdx >= 0 && choiceIdx < note.check.options.length) {
          void executeReply('check', choiceIdx);
          return;
        }
      }

      if (input === 'c' || input === 'C') {
        if ((note.followups?.length ?? 0) < 2) {
          setConfirmKind('confused');
        } else {
          notify(t(lang, '已达追问上限 (2/2)', 'Max 2 follow-up angles reached'), 'info');
        }
        return;
      }

      if (input === 'k' || input === 'K' || input === 'o' || input === 'O') {
        void executeReply('got');
      }
    },
    { isActive: modalActive },
  );

  const frameW = Math.max(44, Math.min(88, width - 4));
  const frameH = Math.max(16, Math.min(30, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);
  const scrollTextW = Math.max(12, innerW - 1);

  const topicName =
    typeof run.card?.topic === 'string' && run.card.topic.trim()
      ? normalizeAsciiChrome(run.card.topic.trim(), asciiMode)
      : '';
  const promptPreview = useMemo(() => {
    const raw = normalizeAsciiChrome(String(run.card?.prompt ?? '').replace(/\s+/g, ' ').trim(), asciiMode);
    if (!raw) return '';
    return truncateDisplay(raw, Math.max(16, innerW - 2), ell);
  }, [run.card?.prompt, asciiMode, innerW, ell]);

  const scrollLines = useMemo<string[]>(() => {
    if (!note) return [];
    const lines: string[] = [];
    const pushWrapped = (text: string) => {
      for (const wrapped of wrapDisplay(normalizeAsciiChrome(text, asciiMode), scrollTextW)) {
        lines.push(wrapped);
      }
    };

    pushWrapped(`${t(lang, '[核心混淆点]', '[Key Confusion]')} ${note.point}`);
    lines.push('');
    pushWrapped(`${t(lang, '[针对解析]', '[Explanation]')} ${note.explain}`);

    if (note.check) {
      lines.push('');
      pushWrapped(`${t(lang, '[快速小检查]', '[Quick Check]')} ${note.check.q}`);
      note.check.options.forEach((opt, idx) => {
        const cleanOpt = normalizeAsciiChrome(opt, asciiMode);
        if (note.checked) {
          const isChosen = note.checked.choice === idx;
          const isAnswer = note.check?.answer === idx;
          const prefix = isAnswer
            ? asciiMode
              ? '[+]'
              : '[✓]'
            : isChosen
              ? asciiMode
                ? '[x]'
                : '[✕]'
              : '[ ]';
          pushWrapped(`  ${prefix} ${idx + 1}. ${cleanOpt}`);
        } else {
          pushWrapped(`  [${idx + 1}] ${cleanOpt}`);
        }
      });
      if (note.checked) {
        const verdict = note.checked.correct
          ? asciiMode
            ? t(lang, '+ 小检查答对了', '+ Check correct')
            : t(lang, '✓ 小检查答对了', '✓ Check correct')
          : asciiMode
            ? t(lang, 'x 小检查未答对', 'x Check incorrect')
            : t(lang, '✕ 小检查未答对', '✕ Check incorrect');
        pushWrapped(`  ${verdict}`);
        if (note.check.why) {
          pushWrapped(`  ${t(lang, '原因', 'Why')}: ${note.check.why}`);
        }
      } else {
        pushWrapped(
          t(
            lang,
            `  按 [1-${note.check.options.length}] 直接作答（0 模型消耗）`,
            `  Press [1-${note.check.options.length}] to answer (0 model calls)`,
          ),
        );
      }
    }

    const followups = Array.isArray(note.followups) ? note.followups : [];
    followups.forEach((item, idx) => {
      lines.push('');
      pushWrapped(
        `${t(lang, `[换个角度 ${idx + 1}/2]`, `[Simpler Angle ${idx + 1}/2]`)} ${item.explain}`,
      );
    });

    return lines;
  }, [note, asciiMode, scrollTextW, lang]);

  const hints = useMemo<KeyHint[]>(() => {
    if (isBusy) {
      return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    }
    if (!note) {
      return [
        { key: 'g/Enter', label: t(lang, '生成点拨', 'Generate') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    const items: KeyHint[] = [];
    if (note.check && !note.checked) {
      items.push({
        key: `1-${note.check.options.length}`,
        label: t(lang, '小检查', 'Check'),
      });
    }
    if (canFollowup) {
      items.push({ key: 'c', label: t(lang, '换角度再讲', 'Still confused') });
    }
    items.push({ key: 'o/k', label: t(lang, '我懂了', 'Got it') });
    items.push({
      key: asciiMode ? 'Up/Down' : '↑/↓',
      label: t(lang, '滚动', 'Scroll'),
    });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [isBusy, note, canFollowup, lang, asciiMode]);

  const replyBadge = useMemo(() => {
    if (!note?.reply) return null;
    if (note.reply === 'got') {
      return {
        label: asciiMode ? t(lang, '+ 已理解', '+ Understood') : t(lang, '✓ 已理解', '✓ Understood'),
        tone: 'success' as const,
      };
    }
    return {
      label: t(lang, '仍存疑问', 'Still confused'),
      tone: 'warning' as const,
    };
  }, [note?.reply, asciiMode, lang]);

  const cleanError = errorText ? normalizeAsciiChrome(errorText, asciiMode) : null;
  const scrollH = Math.max(4, bodyH - 2 - (isBusy ? 1 : 0) - (cleanError ? 1 : 0));

  const spinnerLabel =
    busyAction === 'nudge'
      ? t(lang, `正在生成陪学点拨${ell}`, `Generating coach nudge${ell}`)
      : busyAction === 'confused'
        ? t(lang, `正在换个角度重新讲解${ell}`, `Generating simpler explanation${ell}`)
        : t(lang, `正在记录陪学反馈${ell}`, `Saving coach reply${ell}`);

  return (
    <>
      <Modal
        title={t(lang, 'AI 陪学点拨', 'AI Coach Nudge')}
        icon={asciiMode ? '*' : '✦'}
        tone="ai"
        subtitle={topicName || undefined}
        width={frameW}
        height={frameH}
        isActive={modalActive}
        onClose={onClose}
        hints={hints}
      >
        {!note ? (
          <Box flexDirection="column" width={innerW} flexGrow={1}>
            <Box flexDirection="row" alignItems="center" gap={1} height={1}>
              <Badge label={t(lang, '0 模型调用预览', '0-Call Preview')} tone="ai" variant="soft" />
              <Text color={theme.muted}>
                {t(lang, '仅在确认后发起 1 次轻量调用', '1 light call only after confirm')}
              </Text>
            </Box>

            <Divider width={innerW} />

            {promptPreview ? (
              <Box marginBottom={1}>
                <Text color={theme.text} bold>
                  {promptPreview}
                </Text>
              </Box>
            ) : null}

            <Box flexDirection="column">
              {wrapDisplay(
                normalizeAsciiChrome(
                  t(
                    lang,
                    '针对本题答错或低分自评，AI 陪学助教将定位最可能的混淆点、给出清晰辨析，并附带一道 2 选 1 快速小检查（同题仅首次生成调用模型，之后自动缓存）。',
                    'For wrong answers or low ratings, the AI study coach pinpoints your likely misconception, explains the distinction, and adds a 2-option quick check (cached after first generation).',
                  ),
                  asciiMode,
                ),
                innerW,
              ).map((line, idx) => (
                <Text key={`intro-${idx}`} color={theme.muted}>
                  {line}
                </Text>
              ))}
            </Box>

            <Box marginTop={1} flexDirection="row" alignItems="center" gap={1}>
              <Badge
                label={t(lang, '[g] / [Enter] 生成陪学点拨', '[g] / [Enter] Generate Coach Nudge')}
                tone="primary"
                variant="soft"
              />
            </Box>

            {isBusy ? (
              <Box marginTop={1}>
                <Spinner label={spinnerLabel} tone="ai" active={isActive} />
              </Box>
            ) : null}

            {cleanError ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.error} wrap="wrap">
                  {cleanError}
                </Text>
                {isModelUnavailableMsg(cleanError) ? (
                  <Text color={theme.muted}>
                    {t(lang, '请先按 [,] 在设置中配置可用模型。', 'Configure a model in Settings ([,]) first.')}
                  </Text>
                ) : null}
              </Box>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="column" width={innerW} flexGrow={1}>
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" width={innerW} height={1}>
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Badge label={t(lang, '针对点拨', 'Coach Nudge')} tone="ai" variant="soft" />
                {replyBadge ? <Badge label={replyBadge.label} tone={replyBadge.tone} variant="soft" /> : null}
                {followupsCount > 0 ? (
                  <Badge
                    label={t(lang, `换角度 ${followupsCount}/2`, `Angles ${followupsCount}/2`)}
                    tone="info"
                    variant="outline"
                  />
                ) : null}
              </Box>
              <Text color={theme.dim}>
                {note.checked
                  ? t(lang, '小检查已完成', 'Check done')
                  : note.check
                    ? t(lang, '待答小检查', 'Check ready')
                    : ''}
              </Text>
            </Box>

            <Divider width={innerW} />

            <ScrollView
              lines={scrollLines}
              height={scrollH}
              width={innerW}
              isActive={modalActive && !isBusy}
              vimNavKeys={false}
              follow={followBottom}
              ascii={asciiMode}
            />

            {isBusy ? (
              <Box height={1}>
                <Spinner label={spinnerLabel} tone="ai" active={isActive} />
              </Box>
            ) : null}

            {cleanError ? (
              <Box>
                <Text color={theme.error} wrap="wrap">{cleanError}</Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Modal>

      {confirmKind === 'nudge' ? (
        <ConfirmDialog
          title={t(lang, '开启 AI 陪学点拨', 'Generate AI Coach Nudge')}
          message={t(
            lang,
            '将发起 1 次轻量 AI 模型调用，针对本题混淆点生成简明辨析与一道 2 选 1 小检查（同题仅首次生成调用模型）。确认继续吗？',
            'Uses 1 light AI model call to explain your likely misconception and add a 2-option quick check (cached per card). Continue?',
          )}
          confirmLabel={t(lang, '生成点拨', 'Generate')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && !shellOverlay}
          width={Math.min(58, Math.max(38, width - 8))}
          onConfirm={() => {
            setConfirmKind(null);
            void executeNudge();
          }}
          onCancel={() => setConfirmKind(null)}
        />
      ) : null}

      {confirmKind === 'confused' ? (
        <ConfirmDialog
          title={t(lang, '换个角度再讲', 'Explain From Simpler Angle')}
          message={t(
            lang,
            `将发起 1 次轻量 AI 模型调用，用更基础的例子或类比重新讲这个点（第 ${followupsCount + 1}/2 次追问）。确认继续吗？`,
            `Uses 1 light AI model call to explain this point from a simpler angle or analogy (follow-up ${followupsCount + 1}/2). Continue?`,
          )}
          confirmLabel={t(lang, '继续讲解', 'Explain Again')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && !shellOverlay}
          width={Math.min(58, Math.max(38, width - 8))}
          onConfirm={() => {
            setConfirmKind(null);
            void executeReply('confused');
          }}
          onCancel={() => setConfirmKind(null)}
        />
      ) : null}
    </>
  );
});
