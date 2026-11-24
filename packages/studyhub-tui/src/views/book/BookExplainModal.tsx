import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture } from '../../components/focus.js';
import { truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { FlatTocItem } from './types.js';

export const BOOK_EXPLAIN_MAX_CHARS = 600;

export type BookExplainMode = 'here' | 'explain';

export interface BookExplainResult {
  jobId?: string;
  status?: string;
  blockId?: string;
}

export interface BookExplainModalProps {
  host: HostClient;
  course: string | null;
  selectedItem: FlatTocItem | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onStarted?: (result?: BookExplainResult) => void;
}

interface PendingExplainConfirm {
  payload: Record<string, unknown>;
  mode: BookExplainMode;
  summary: string;
}

export const BookExplainModal = memo(function BookExplainModal({
  host,
  course,
  selectedItem,
  isActive,
  width,
  height: _height,
  onClose,
  onStarted,
}: BookExplainModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  // Hold input capture for the modal lifetime even while ConfirmDialog mounts on top.
  useInputCapture(isActive);

  const hid = selectedItem?.node?.hid ?? selectedItem?.hid ?? '';
  const pointTitle = selectedItem?.title ?? '';

  const [mode, setMode] = useState<BookExplainMode>('here');
  const [focus, setFocus] = useState<'mode' | 'input'>('input');
  const [instruction, setInstruction] = useState('');
  const [words, setWords] = useState(() => pointTitle.slice(0, BOOK_EXPLAIN_MAX_CHARS));
  const [pendingConfirm, setPendingConfirm] = useState<PendingExplainConfirm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const hidRef = useRef(hid);
  hidRef.current = hid;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setMode('here');
    setFocus('input');
    setInstruction('');
    setWords(pointTitle.slice(0, BOOK_EXPLAIN_MAX_CHARS));
    setPendingConfirm(null);
    setSubmitting(false);
    setErrorText(null);
  }, [hid, pointTitle]);

  const confirmOpen = Boolean(pendingConfirm);
  const activeValue = mode === 'here' ? instruction : words;

  const handleActiveChange = useCallback(
    (next: string) => {
      setErrorText(null);
      if (mode === 'here') setInstruction(next);
      else setWords(next);
    },
    [mode],
  );

  const requestConfirm = useCallback(
    (submittedRaw?: string) => {
      if (busyRef.current || submitting || confirmOpen) return;
      if (!course || !hid || !selectedItem?.leaf) {
        const msg = t(lang, '请先在目录中选择一个具体知识点（叶子节点）', 'Select a specific knowledge point (leaf) first');
        setErrorText(msg);
        notify(msg, 'warning');
        return;
      }
      const raw = submittedRaw ?? (mode === 'here' ? instruction : words);
      const cleaned = raw.replace(/\s+/g, ' ').trim();
      if (!cleaned) {
        const msg =
          mode === 'here'
            ? t(lang, '请输入要补充的段落要求', 'Enter an instruction for the paragraph to add')
            : t(lang, '请输入要深入讲解的词句或概念', 'Enter a phrase or concept to explain');
        setErrorText(msg);
        notify(msg, 'warning');
        return;
      }
      const clipped = cleaned.slice(0, BOOK_EXPLAIN_MAX_CHARS);
      setErrorText(null);
      setPendingConfirm({
        mode,
        summary: clipped,
        payload: {
          course,
          heading: hid,
          mode,
          language: lang,
          ...(mode === 'here' ? { instruction: clipped } : { words: clipped }),
        },
      });
    },
    [confirmOpen, course, hid, instruction, lang, mode, notify, selectedItem?.leaf, submitting, words],
  );

  const executeExplain = useCallback(
    async (payload: Record<string, unknown>) => {
      if (busyRef.current) return;
      const targetHid = hidRef.current;
      busyRef.current = true;
      setSubmitting(true);
      setErrorText(null);
      try {
        const res = await tryAction<BookExplainResult>(host, 'generation.courseBook.explain', payload);
        if (!mountedRef.current || hidRef.current !== targetHid) return;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '启动 AI 讲解任务失败', 'Failed to start AI explain job');
          setErrorText(msg);
          return;
        }
        notify(
          t(lang, '已启动 AI 讲解任务（可在后台任务页查看进度）', 'Started AI explain job (track in Tasks)'),
          'success',
        );
        onStarted?.(res.value);
        onClose();
      } catch (err) {
        if (!mountedRef.current || hidRef.current !== targetHid) return;
        setErrorText(err instanceof Error ? err.message : String(err));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    },
    [host, lang, notify, onClose, onStarted],
  );

  useInput(
    (input, key) => {
      if (submitting || confirmOpen) return;
      if (key.tab) {
        setMode((m) => (m === 'here' ? 'explain' : 'here'));
        setErrorText(null);
        return;
      }
      if (key.upArrow) {
        setFocus('mode');
        return;
      }
      if (key.downArrow) {
        setFocus('input');
        return;
      }
      if (key.ctrl && input === 's') {
        requestConfirm();
        return;
      }
      if (focus === 'mode') {
        if (input === '1') {
          setMode('here');
          setErrorText(null);
          return;
        }
        if (input === '2') {
          setMode('explain');
          setErrorText(null);
          return;
        }
        if (key.leftArrow || key.rightArrow || input === 'h' || input === 'l' || input === ' ') {
          setMode((m) => (m === 'here' ? 'explain' : 'here'));
          setErrorText(null);
          return;
        }
        if (key.return) {
          requestConfirm();
        }
      }
    },
    { isActive: isActive && !confirmOpen && !submitting },
  );

  const frameW = Math.max(44, Math.min(76, width - 4));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(12, innerW - 6);
  const navKey = asciiMode ? 'Up/Down' : '↑/↓';
  const sep = asciiMode ? ' | ' : ' · ';

  const hints = useMemo<KeyHint[]>(() => {
    if (submitting || confirmOpen) {
      return [{ key: 'Esc', label: t(lang, '取消', 'Cancel') }];
    }
    return [
      { key: 'Tab', label: t(lang, '切换模式', 'Mode') },
      { key: navKey, label: t(lang, '焦点', 'Focus') },
      ...(focus === 'mode' ? [{ key: '1/2', label: t(lang, '选模式', 'Pick') }] : []),
      { key: 'Enter/Ctrl+S', label: t(lang, '提交', 'Submit') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }, [confirmOpen, focus, lang, navKey, submitting]);

  const pointHeader = selectedItem
    ? `${selectedItem.number ? `${selectedItem.number} ` : ''}${selectedItem.title}`.trim()
    : t(lang, '未选择知识点', 'No point selected');

  const confirmMessage = useMemo(() => {
    if (!pendingConfirm) return '';
    const modeLabel =
      pendingConfirm.mode === 'here'
        ? t(lang, '1: 补充段落 (here)', '1: Add paragraph (here)')
        : t(lang, '2: 深入讲解 (explain)', '2: Explain phrase (explain)');
    const summary = truncateDisplay(pendingConfirm.summary, 64, ell);
    return t(
      lang,
      `课程: ${course ?? '-'}\n知识点: ${pointHeader} (${hid})\n模式: ${modeLabel}\n内容: ${summary}\n\n将发起 1 次 AI 模型调用作为后台任务运行，确认继续吗？`,
      `Course: ${course ?? '-'}\nPoint: ${pointHeader} (${hid})\nMode: ${modeLabel}\nRequest: ${summary}\n\nThis will start 1 AI background job. Continue?`,
    );
  }, [course, ell, hid, lang, pendingConfirm, pointHeader]);

  return (
    <>
      <Modal
        title={t(lang, 'AI 补充复习全书讲解', 'AI Explain Review Book Point')}
        subtitle={course ? truncateDisplay(course, 22, ell) : undefined}
        icon={asciiMode ? '*' : '✦'}
        tone="ai"
        width={frameW}
        onClose={submitting ? undefined : onClose}
        isActive={isActive && !confirmOpen && !submitting}
        hints={hints}
      >
      {/* Selected knowledge point + hid */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" width={innerW} height={1}>
        <Text color={theme.heading} bold>
          {truncateDisplay(pointHeader, Math.max(12, innerW - (hid ? hid.length + 4 : 2)), ell)}
        </Text>
        {hid ? <Badge label={hid} tone="accent" variant="soft" /> : null}
      </Box>

      <Divider width={innerW} />

      {/* Mode selector */}
      <Box flexDirection="row" alignItems="center" gap={1} width={innerW} height={1} overflow="hidden">
        <Text color={focus === 'mode' ? theme.ai : theme.muted} bold>
          {t(lang, '模式:', 'Mode:')}
        </Text>
        <Badge
          label={t(lang, '1: 补充段落 (here)', '1: Add paragraph (here)')}
          tone={mode === 'here' ? 'ai' : 'neutral'}
          variant={mode === 'here' ? 'solid' : 'outline'}
        />
        <Badge
          label={t(lang, '2: 深入讲解 (explain)', '2: Explain phrase (explain)')}
          tone={mode === 'explain' ? 'ai' : 'neutral'}
          variant={mode === 'explain' ? 'solid' : 'outline'}
        />
      </Box>

      <Box height={1} width={innerW} overflow="hidden">
        <Text color={theme.muted}>
          {truncateDisplay(
            mode === 'here'
              ? t(lang, '在当前知识点下新增一段 AI 讲解（基于本节资料，不修改原文）', 'Append a new AI paragraph under this heading from section materials')
              : t(lang, '针对指定词句或概念深入讲解（基于本节资料，不修改原文）', 'Explain a phrase or concept in depth from section materials'),
            innerW,
            ell,
          )}
        </Text>
      </Box>

      {/* Input label + char count */}
      <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1} marginTop={1}>
        <Text color={focus === 'input' ? theme.ai : theme.muted} bold>
          {mode === 'here'
            ? t(lang, '补充要求 (instruction):', 'Instruction:')
            : t(lang, '深入讲解词句 (words):', 'Phrase / concept (words):')}
        </Text>
        <Text color={theme.dim}>{`${activeValue.length}/${BOOK_EXPLAIN_MAX_CHARS}`}</Text>
      </Box>

      {/* TextInput */}
      <Box
        borderStyle={asciiMode ? 'classic' : 'single'}
        borderColor={focus === 'input' ? theme.ai : theme.border}
        paddingX={1}
        width={innerW}
      >
        <TextInput
          value={activeValue}
          onChange={handleActiveChange}
          placeholder={
            mode === 'here'
              ? t(lang, '补充直觉例子、推导步骤或易错对比', 'Add an intuition example, derivation step, or pitfall comparison')
              : t(lang, '输入要深入讲解的词句或概念', 'Enter a phrase or concept to explain')
          }
          width={inputW}
          maxLength={BOOK_EXPLAIN_MAX_CHARS}
          isActive={isActive && !confirmOpen && !submitting && focus === 'input'}
          onSubmit={(val) => requestConfirm(val)}
          onCancel={onClose}
          captureInput={false}
        />
      </Box>

      {/* Status / error / tip */}
      {submitting ? (
        <Box height={1} width={innerW}>
          <Spinner label={t(lang, `正在启动 AI 讲解任务${ell}`, `Starting AI explain job${ell}`)} tone="ai" active={isActive} />
        </Box>
      ) : errorText ? (
        <Box flexDirection="row" gap={1} width={innerW} height={1} overflow="hidden">
          <Badge label={asciiMode ? '! 错误' : '▲ 错误'} tone="error" />
          <Text color={theme.error} wrap="wrap">{errorText}</Text>
        </Box>
      ) : (
        <Box height={1} width={innerW} overflow="hidden">
          <Text color={theme.dim}>
            {truncateDisplay(
              t(
                lang,
                `Tab 切换模式${sep}${navKey} 切焦点${sep}Enter/Ctrl+S 提交确认${sep}Esc 取消`,
                `Tab mode${sep}${navKey} focus${sep}Enter/Ctrl+S submit${sep}Esc cancel`,
              ),
              innerW,
              ell,
            )}
          </Text>
        </Box>
      )}

      </Modal>

      {pendingConfirm ? (
        <ConfirmDialog
          title={t(lang, 'AI 补充复习全书讲解', 'AI Explain Review Book Point')}
          message={confirmMessage}
          confirmLabel={t(lang, '开始生成', 'Start AI')}
          cancelLabel={t(lang, '返回修改', 'Cancel')}
          width={Math.min(68, Math.max(44, width - 6))}
          isActive={isActive && confirmOpen}
          onConfirm={() => {
            const target = pendingConfirm;
            setPendingConfirm(null);
            if (target) void executeExplain(target.payload);
          }}
          onCancel={() => {
            setPendingConfirm(null);
          }}
        />
      ) : null}
    </>
  );
});
