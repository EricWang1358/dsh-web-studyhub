import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { isModelUnavailableError, type UnifiedRetellVerdict } from '../../host/ai-dialogue.js';
import {
  RETELL_TEXT_MAX,
  classifyRetellVerdict,
  formatRetellVerdictMarkdown,
  retellVerdictBadge,
  submitBookRetellEvaluation,
} from '../../host/retell-dialogue.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture } from '../../components/focus.js';
import { truncateDisplay } from '../../render/cjk.js';
import type { FlatTocItem } from './types.js';

export const BOOK_RETELL_TEXT_MAX = RETELL_TEXT_MAX;

export type BookRetellVerdict = UnifiedRetellVerdict;

export interface BookRetellModalProps {
  host: HostClient;
  course: string | null;
  selectedItem: FlatTocItem | null;
  isActive: boolean;
  width: number;
  height: number;
  mathUnicode: boolean;
  onClose: () => void;
  onRetold?: (record?: BookRetellVerdict['record']) => void;
}

function hasPassedRetell(item: FlatTocItem | null): boolean {
  if (!item?.node) return false;
  const raw = item.node.retold as
    | { passes?: number; passed?: boolean }
    | undefined;
  const extra = item.node as { retell?: { passed?: boolean; passes?: number } };
  return Boolean(
    (raw?.passes ?? 0) > 0 ||
      raw?.passed === true ||
      extra.retell?.passed === true ||
      (extra.retell?.passes ?? 0) > 0,
  );
}

export const BookRetellModal = memo(function BookRetellModal({
  host,
  course,
  selectedItem,
  isActive,
  width,
  height,
  mathUnicode,
  onClose,
  onRetold,
}: BookRetellModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  // Hold input capture for the modal lifetime even while ConfirmDialog mounts on top.
  useInputCapture(isActive);

  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verdict, setVerdict] = useState<BookRetellVerdict | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [errorIsModel, setErrorIsModel] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const reqSeqRef = useRef(0);
  const pendingTextRef = useRef('');
  const hidRef = useRef(selectedItem?.hid ?? null);
  hidRef.current = selectedItem?.hid ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset only when switching to a different knowledge point (not when book refreshes same hid).
  useEffect(() => {
    reqSeqRef.current += 1;
    busyRef.current = false;
    setDraft('');
    setEditing(true);
    setConfirmOpen(false);
    setSubmitting(false);
    setVerdict(null);
    setErrorText(null);
    setErrorIsModel(false);
    pendingTextRef.current = '';
  }, [selectedItem?.hid]);

  const requestConfirmSubmit = useCallback(
    (rawText?: string) => {
      if (busyRef.current || submitting || confirmOpen) return;
      const text = (rawText ?? draft).trim();
      if (!text) {
        notify(t(lang, '请先用自己的话写出理解，再提交评估', 'Type your explanation first before submitting'), 'warning');
        return;
      }
      if (text.length > BOOK_RETELL_TEXT_MAX) {
        notify(
          t(lang, `复述内容请控制在 ${BOOK_RETELL_TEXT_MAX} 字以内`, `Keep explanation under ${BOOK_RETELL_TEXT_MAX} characters`),
          'warning',
        );
        return;
      }
      if (!selectedItem?.hid || !selectedItem.leaf) {
        notify(
          t(lang, '请先选择一个叶子知识点再提交复述', 'Select a leaf knowledge point before submitting'),
          'warning',
        );
        return;
      }
      pendingTextRef.current = text;
      setConfirmOpen(true);
    },
    [confirmOpen, draft, lang, notify, selectedItem?.hid, selectedItem?.leaf, submitting],
  );

  const executeRetell = useCallback(
    async (rawText: string) => {
      if (busyRef.current || !selectedItem?.hid) return;
      const text = rawText.trim();
      if (!text) return;

      const targetHid = selectedItem.hid;
      const seq = ++reqSeqRef.current;
      busyRef.current = true;
      setSubmitting(true);
      setEditing(false);
      setErrorText(null);
      setErrorIsModel(false);
      try {
        const res = await submitBookRetellEvaluation(host, {
          course,
          hid: targetHid,
          text,
          language: lang,
        });
        if (!mountedRef.current || hidRef.current !== targetHid || reqSeqRef.current !== seq) return;
        if (!res.ok) {
          setErrorText(res.error);
          setErrorIsModel(res.isModelError);
          return;
        }
        setVerdict(res.verdict);
        onRetold?.(res.verdict.record);
      } finally {
        if (reqSeqRef.current === seq) {
          busyRef.current = false;
          if (mountedRef.current) setSubmitting(false);
        }
      }
    },
    [course, host, lang, onRetold, selectedItem?.hid],
  );

  useInput(
    (input) => {
      if (submitting || editing || confirmOpen) return;
      if (input === 'i' || input === 'e') {
        setErrorText(null);
        setErrorIsModel(false);
        setEditing(true);
        return;
      }
      if (input === 'r') {
        if (errorText && draft.trim()) {
          requestConfirmSubmit(draft);
        } else {
          setErrorText(null);
          setErrorIsModel(false);
          setEditing(true);
        }
      }
    },
    { isActive: isActive && !editing && !confirmOpen && !submitting },
  );

  const verdictTier = useMemo(() => classifyRetellVerdict(verdict), [verdict]);

  const verdictMarkdown = useMemo(() => {
    if (!verdict) return '';
    return formatRetellVerdictMarkdown(verdict, { surface: 'book', lang });
  }, [verdict, lang]);

  const frameW = Math.max(48, Math.min(92, width - 4));
  const frameH = Math.max(16, Math.min(32, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 6);
  const inputRows = Math.max(3, Math.min(8, bodyH - 5));

  const hints = useMemo<KeyHint[]>(() => {
    if (submitting || confirmOpen) {
      return [{ key: 'Esc', label: t(lang, '取消', 'Cancel') }];
    }
    if (editing) {
      return [
        { key: 'Enter/Ctrl+S', label: t(lang, '提交评估', 'Submit') },
        { key: 'Alt+Enter', label: t(lang, '换行', 'Newline') },
        { key: 'Esc', label: verdict ? t(lang, '返回结果', 'Back') : t(lang, '关闭', 'Close') },
      ];
    }
    const items: KeyHint[] = [{ key: 'i/r', label: t(lang, '修改重讲', 'Re-tell') }];
    if (verdict) items.push({ key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [submitting, confirmOpen, editing, verdict, lang, asciiMode]);

  const modelUnavailable = errorIsModel || (errorText ? isModelUnavailableError(errorText) : false);
  const pointTitle = selectedItem ? `${selectedItem.number} ${selectedItem.title}` : t(lang, '未选择知识点', 'No point selected');
  const alreadyRetold = hasPassedRetell(selectedItem) || Boolean((verdict?.record?.passes ?? 0) > 0 || verdictTier === 'pass');

  const badge = verdictTier ? retellVerdictBadge(verdictTier, { surface: 'book', lang, asciiMode }) : null;
  const pillLabel = badge?.label ?? '';
  const pillTone = badge?.tone ?? 'warning';

  return (
    <Modal
      title={t(lang, '用自己的话讲一遍 (费曼复述)', 'Feynman Retell — Explain in Your Own Words')}
      icon={asciiMode ? '*' : '✦'}
      tone="ai"
      subtitle={course ?? undefined}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive && !confirmOpen && (!editing || submitting)}
      hints={hints}
    >
      {/* Selected knowledge point title + existing Retold badge */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" width={innerW} height={1}>
        <Text color={theme.heading} bold>
          {truncateDisplay(pointTitle, Math.max(12, innerW - (alreadyRetold ? 16 : 2)), ell)}
        </Text>
        {alreadyRetold ? (
          <Badge
            label={t(lang, asciiMode ? '+ 讲清楚过' : '✓ 讲清楚过', asciiMode ? '+ Retold' : '✓ Retold')}
            tone="success"
            variant="soft"
          />
        ) : null}
      </Box>

      <Divider width={innerW} />

      {submitting ? (
        <Box height={Math.max(4, bodyH - 2)} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
          <Spinner label={t(lang, `正在评估你的费曼复述${ell}`, `Evaluating your Feynman explanation${ell}`)} tone="ai" active={isActive} />
          <Text color={theme.dim}>{t(lang, '仅对照本节讲义检查理解，不会保存你的原话', 'Checking against this section — your raw words are never saved')}</Text>
        </Box>
      ) : editing ? (
        <Box flexDirection="column" width={innerW} flexGrow={1}>
          <Box flexDirection="row" justifyContent="space-between" width={innerW}>
            <Text color={theme.ai} bold>
              {t(lang, '不看讲义，用自己的话讲一遍这个知识点：', 'Explain this point in your own words:')}
            </Text>
            <Text color={theme.dim}>{`${draft.length}/${BOOK_RETELL_TEXT_MAX}`}</Text>
          </Box>
          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={theme.ai}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={draft}
              onChange={setDraft}
              multiline
              submitOnEnter
              height={inputRows}
              width={Math.max(12, innerW - 4)}
              maxLength={BOOK_RETELL_TEXT_MAX}
              isActive={isActive && editing && !confirmOpen && !submitting}
              placeholder={t(
                lang,
                `讲清核心概念、因果关系与适用边界${ell} (Enter / Ctrl+S 提交)`,
                `Explain core idea, why it works, and boundaries${ell} (Enter / Ctrl+S)`,
              )}
              onSubmit={(val) => requestConfirmSubmit(val)}
              onCancel={() => {
                if (verdict) setEditing(false);
                else onClose();
              }}
            />
          </Box>
          <Text color={theme.dim}>
            {truncateDisplay(
              t(
                lang,
                '提示: Enter / Ctrl+S 提交确认 · Alt+Enter 换行 · 原话不落盘，仅记「讲清楚过」次数',
                'Tip: Enter / Ctrl+S to submit · Alt+Enter newline · Raw words are never stored',
              ),
              innerW,
              ell,
            )}
          </Text>
        </Box>
      ) : errorText ? (
        <Box flexDirection="column" width={innerW} flexGrow={1} justifyContent="center" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Badge label={asciiMode ? '! 评估暂不可用' : '▲ 评估暂不可用'} tone="warning" />
            <Text color={theme.error} bold>
              {errorText}
            </Text>
          </Box>
          <Text color={theme.muted}>
            {modelUnavailable
              ? t(
                  lang,
                  '当前未检测到可用 AI 模型或模型响应超时。请按 [,] 检查模型设置，或按 [i] 修改、[r] 重试。',
                  'No working AI model available or request timed out. Press [,] for settings, [i] to edit, or [r] to retry.',
                )
              : t(
                  lang,
                  '本次评估未能完成，你写的内容仍保留。可按 [r] 重试、按 [i] 修改内容，或按 [Esc] 关闭。',
                  'Evaluation failed; your draft is kept. Press [r] to retry, [i] to edit, or [Esc] to close.',
                )}
          </Text>
        </Box>
      ) : verdict ? (
        <Box flexDirection="column" width={innerW} flexGrow={1} overflow="hidden">
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" width={innerW} height={1}>
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Badge label={pillLabel} tone={pillTone} />
              {verdict.record?.tries ? (
                <Badge
                  label={t(
                    lang,
                    `第 ${verdict.record.tries} 次 · 通过 ${verdict.record.passes ?? 0} 次`,
                    `Try #${verdict.record.tries} · ${verdict.record.passes ?? 0} pass`,
                  )}
                  tone="neutral"
                  variant="soft"
                />
              ) : null}
            </Box>
          </Box>
          <Box flexGrow={1} overflow="hidden" width={innerW}>
            <MarkdownView
              markdown={verdictMarkdown}
              width={innerW}
              height={Math.max(4, bodyH - 3)}
              isActive={isActive && !editing && !confirmOpen && !submitting}
              mathUnicode={mathUnicode}
            />
          </Box>
        </Box>
      ) : null}

      {confirmOpen ? (
        <ConfirmDialog
          title={t(lang, '确认提交费曼复述评估', 'Confirm Feynman Retell Check')}
          message={t(
            lang,
            `将发起 1 次 AI 模型调用，对照「${selectedItem?.title ?? ''}」讲义原文评估你的复述。\n不会保存你的原话，仅记录「讲清楚过」的通过次数与缺口汇总。确认继续吗？`,
            `This will make 1 AI model call to evaluate your explanation against "${selectedItem?.title ?? ''}".\nYour raw wording is never persisted — only the Retold pass/gap aggregate is stored. Continue?`,
          )}
          confirmLabel={t(lang, '提交评估', 'Evaluate')}
          cancelLabel={t(lang, '返回修改', 'Cancel')}
          width={Math.min(64, Math.max(44, width - 6))}
          isActive={isActive && confirmOpen}
          onConfirm={() => {
            setConfirmOpen(false);
            void executeRetell(pendingTextRef.current || draft);
          }}
          onCancel={() => {
            setConfirmOpen(false);
          }}
        />
      ) : null}
    </Modal>
  );
});
