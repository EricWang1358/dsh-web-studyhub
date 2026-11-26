import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, type ReviewRun } from '../../host/sample-actions.js';
import {
  describeAiDialogueError,
  isModelUnavailableError,
  submitRetellEvaluation,
  type UnifiedRetellVerdict,
} from '../../host/ai-dialogue.js';
import {
  RETELL_TEXT_MAX,
  classifyRetellVerdict,
  formatRetellVerdictMarkdown,
  retellVerdictBadge,
} from '../../host/retell-dialogue.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import {
  currentDeckIdOf,
  extractCitation,
  extractSolution,
  kindLabel,
  type CardSourceLocation,
  type NormalizedKind,
} from './review-helpers.js';
import { NextStepFollowupBar } from './NextStepFollowupBar.js';

export { RETELL_TEXT_MAX };

export type RetellVerdict = UnifiedRetellVerdict;

interface HydratedCitation {
  sourceId?: string;
  page?: number;
  pageNumber?: number;
  title?: string;
  unit?: string;
  quote?: string;
}

export interface RetellModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  onClose: () => void;
  onNavigateToSource: (location: CardSourceLocation) => void;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const RetellModal = memo(function RetellModal({
  host,
  run,
  cardId,
  kind,
  width,
  height,
  isActive,
  mathUnicode,
  onClose,
  onNavigateToSource,
}: RetellModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const deckId = currentDeckIdOf(run);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [verdict, setVerdict] = useState<RetellVerdict | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hydratedCitations, setHydratedCitations] = useState<HydratedCitation[]>([]);
  const [hydratedHint, setHydratedHint] = useState<string>('');

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const reqSeqRef = useRef(0);
  const cardIdRef = useRef(cardId);
  cardIdRef.current = cardId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset modal state if card changes while open
  useEffect(() => {
    reqSeqRef.current += 1;
    busyRef.current = false;
    setDraft('');
    setEditing(true);
    setSubmitting(false);
    setVerdict(null);
    setErrorText(null);
    setHydratedCitations([]);
    setHydratedHint('');
  }, [cardId]);

  // Hydrate full card citations & hint (0-token read) so [o] citation jump works pre-reveal too
  useEffect(() => {
    let alive = true;
    const targetCardId = cardId;
    void (async () => {
      const res = await tryAction<{ card?: { citations?: HydratedCitation[]; hint?: string } }>(
        host,
        'card.get',
        {
          ...(deckId ? { deckId } : {}),
          cardId: targetCardId,
        },
      );
      if (!alive || !mountedRef.current || cardIdRef.current !== targetCardId) return;
      if (!res.ok || !res.value?.card) return;
      if (Array.isArray(res.value.card.citations)) {
        setHydratedCitations(res.value.card.citations);
      }
      if (typeof res.value.card.hint === 'string') {
        setHydratedHint(res.value.card.hint.trim());
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, deckId, cardId]);

  const fallbackCitation = useMemo(() => extractCitation(run), [run]);
  const solution = useMemo(() => extractSolution(run), [run]);

  const allCitations = useMemo<HydratedCitation[]>(() => {
    if (hydratedCitations.length > 0) return hydratedCitations;
    if (Array.isArray(solution?.citations) && solution.citations.length > 0) {
      return solution.citations as HydratedCitation[];
    }
    if (Array.isArray(run.card?.citations)) {
      return run.card.citations as HydratedCitation[];
    }
    return [];
  }, [hydratedCitations, solution, run.card]);

  const targetCitation = useMemo<CardSourceLocation | null>(() => {
    if (verdict?.cite !== null && verdict?.cite !== undefined && Number.isInteger(verdict.cite)) {
      const cited = allCitations[verdict.cite];
      if (cited && typeof cited.sourceId === 'string' && cited.sourceId) {
        return {
          sourceId: cited.sourceId,
          pageNumber: toNumberOrUndefined(cited.pageNumber ?? cited.page),
          title:
            typeof cited.title === 'string' && cited.title
              ? cited.title
              : fallbackCitation?.sourceId === cited.sourceId
                ? fallbackCitation.title
                : undefined,
          unit: typeof cited.unit === 'string' ? cited.unit : undefined,
        };
      }
    }
    return fallbackCitation;
  }, [verdict, allCitations, fallbackCitation]);

  const citedQuote = useMemo(() => {
    if (verdict?.cite === null || verdict?.cite === undefined || !Number.isInteger(verdict.cite)) return '';
    const cited = allCitations[verdict.cite];
    return typeof cited?.quote === 'string' ? cited.quote.trim() : '';
  }, [verdict, allCitations]);

  const cardHint = useMemo(() => {
    const raw = typeof run.card?.hint === 'string' ? run.card.hint.trim() : '';
    return raw || hydratedHint;
  }, [run.card, hydratedHint]);

  const handleSubmit = useCallback(
    async (rawText?: string) => {
      if (busyRef.current || submitting) return;
      const text = (rawText ?? draft).trim();
      if (!text) {
        notify(t(lang, '请先用自己的话写出理解，再提交评估', 'Type your explanation first before submitting'), 'warning');
        return;
      }
      if (text.length > RETELL_TEXT_MAX) {
        notify(
          t(lang, `复述内容请控制在 ${RETELL_TEXT_MAX} 字以内`, `Keep explanation under ${RETELL_TEXT_MAX} characters`),
          'warning',
        );
        return;
      }
      if (!deckId) {
        setEditing(false);
        setErrorText(t(lang, '缺少题组信息，无法调用费曼复述评估', 'Missing deck context; cannot evaluate Feynman retell'));
        return;
      }
      const targetCardId = cardId;
      const seq = ++reqSeqRef.current;
      busyRef.current = true;
      setSubmitting(true);
      setEditing(false);
      setErrorText(null);
      try {
        const res = await submitRetellEvaluation(host, {
          deckId,
          cardId: targetCardId,
          text,
          language: lang,
        });
        if (!mountedRef.current || cardIdRef.current !== targetCardId || reqSeqRef.current !== seq) return;
        if (!res.ok) {
          setErrorText(describeAiDialogueError(res.error, lang));
          return;
        }
        setVerdict(res.verdict);
      } catch (err) {
        if (!mountedRef.current || cardIdRef.current !== targetCardId || reqSeqRef.current !== seq) return;
        setErrorText(describeAiDialogueError(err, lang));
      } finally {
        if (reqSeqRef.current === seq) {
          busyRef.current = false;
          if (mountedRef.current) setSubmitting(false);
        }
      }
    },
    [submitting, draft, deckId, cardId, host, lang, notify],
  );

  const [followupEngaged, setFollowupEngaged] = useState(false);

  useInput(
    (input) => {
      if (submitting || editing) return;
      if (input === 'i' || input === 'e') {
        setErrorText(null);
        setEditing(true);
        return;
      }
      if (input === 'r') {
        if (errorText && draft.trim()) {
          void handleSubmit(draft);
        } else {
          setErrorText(null);
          setEditing(true);
        }
        return;
      }
      if (input === 'o' && targetCitation) {
        onNavigateToSource(targetCitation);
        onClose();
      }
    },
    { isActive: isActive && !editing && !submitting && !followupEngaged },
  );

  const verdictTier = useMemo(() => classifyRetellVerdict(verdict), [verdict]);

  const verdictMarkdown = useMemo(() => {
    if (!verdict) return '';
    return formatRetellVerdictMarkdown(verdict, {
      surface: 'card',
      lang,
      cardHint,
      targetCitation,
      citedQuote,
    });
  }, [verdict, lang, cardHint, targetCitation, citedQuote]);

  const frameW = Math.max(48, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);

  const topicName = typeof run.card?.topic === 'string' && run.card.topic ? run.card.topic : '';
  const stemText = String(run.card?.prompt ?? '').trim() || t(lang, '(无题干)', '(No prompt)');
  const stemH = editing ? Math.min(5, Math.max(2, Math.floor(bodyH * 0.28))) : Math.min(3, Math.max(2, Math.floor(bodyH * 0.18)));
  const inputRows = Math.max(3, Math.min(8, bodyH - stemH - 6));

  const hints = useMemo<KeyHint[]>(() => {
    if (submitting) {
      return [{ key: 'Esc', label: t(lang, '取消关闭', 'Close') }];
    }
    if (editing) {
      return [
        { key: 'Enter/Ctrl+S', label: t(lang, '提交评估', 'Submit') },
        { key: 'Alt+Enter', label: t(lang, '换行', 'Newline') },
        { key: 'Esc', label: verdict ? t(lang, '返回结果', 'Back') : t(lang, '关闭', 'Close') },
      ];
    }
    const items: KeyHint[] = [{ key: 'i/r', label: t(lang, '修改重讲', 'Re-tell') }];
    if (targetCitation) items.push({ key: 'o', label: t(lang, '跳转原文', 'Source') });
    if (verdict) items.push({ key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') });
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [submitting, editing, verdict, targetCitation, lang, asciiMode]);

  const modelUnavailable = errorText ? isModelUnavailableError(errorText) : false;

  const badge = verdictTier ? retellVerdictBadge(verdictTier, { surface: 'card', lang, asciiMode }) : null;
  const pillLabel = badge?.label ?? '';
  const pillTone = badge?.tone ?? 'warning';

  return (
    <Modal
      title={t(lang, '用自己的话讲一遍 (费曼复述)', 'Feynman Retell — Explain in Your Own Words')}
      icon={asciiMode ? '*' : '✦'}
      tone="ai"
      subtitle={`${kindLabel(kind, lang)}${topicName ? ` · ${topicName}` : ''}`}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive && (!editing || submitting) && !followupEngaged}
      hints={hints}
    >
      {/* Question Stem Preview */}
      <Box flexDirection="column" height={stemH} width={innerW} overflow="hidden">
        <MarkdownView
          markdown={stemText}
          width={innerW}
          height={stemH}
          mathUnicode={mathUnicode}
        />
      </Box>

      <Divider width={innerW} />

      {submitting ? (
        <Box height={Math.max(4, bodyH - stemH - 2)} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
          <Spinner label={t(lang, `正在评估你的费曼复述${ell}`, `Evaluating your Feynman explanation${ell}`)} tone="ai" active={isActive} />
          <Text color={theme.dim}>{t(lang, '仅对照题目与原文进行理解检查，不会存储你的原话', 'Checking against source material — your wording is never stored')}</Text>
        </Box>
      ) : editing ? (
        <Box flexDirection="column" width={innerW} flexGrow={1}>
          <Box flexDirection="row" justifyContent="space-between" width={innerW}>
            <Text color={theme.ai} bold>
              {t(lang, '用自己的话复述核心原理（不要看答案）：', 'Explain the core idea in your own words:')}
            </Text>
            <Text color={theme.dim}>{`${draft.length}/${RETELL_TEXT_MAX}`}</Text>
          </Box>
          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={theme.ai}
            paddingX={1}
            marginTop={0}
            width={innerW}
          >
            <TextInput
              value={draft}
              onChange={setDraft}
              multiline
              submitOnEnter
              height={inputRows}
              width={Math.max(12, innerW - 4)}
              maxLength={RETELL_TEXT_MAX}
              isActive={isActive && editing && !submitting}
              placeholder={t(
                lang,
                `试着像教一位初学者一样讲清楚因果关系与边界条件${ell} (Enter / Ctrl+S 提交)`,
                `Explain as if teaching a beginner${ell} (Enter / Ctrl+S submits)`,
              )}
              onSubmit={(val) => void handleSubmit(val)}
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
                '提示: Enter 或 Ctrl+S 提交 · Alt+Enter 换行 · 不会保存原话也不影响正式成绩',
                'Tip: Enter or Ctrl+S to submit · Alt+Enter for newline · Words are not saved',
              ),
              innerW,
            )}
          </Text>
        </Box>
      ) : errorText ? (
        <Box flexDirection="column" width={innerW} flexGrow={1} justifyContent="center" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Badge label={asciiMode ? '! 模型暂不可用' : '▲ 评估暂不可用'} tone="warning" />
            <Text color={theme.error} bold>
              {errorText}
            </Text>
          </Box>
          <Text color={theme.muted}>
            {modelUnavailable
              ? t(
                  lang,
                  '当前未检测到可用 AI 模型或模型响应超时。请按 [,] 前往设置检查模型配置，或关闭弹窗后按 [Space] 翻看参考答案自行对照。',
                  'No working AI model is available right now. Open Settings ([,]) to configure a model, or close and reveal the reference answer to self-check.',
                )
              : t(
                  lang,
                  '本次评估未能完成。你可以按 [r] 重试、按 [i] 修改复述内容，或按 [Esc] 返回复习。',
                  'Could not complete retell evaluation. Press [r] to retry, [i] to edit your text, or [Esc] to close.',
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
                    `第 ${verdict.record.tries} 次 · 通过 ${verdict.record.passes ?? 0}`,
                    `Try #${verdict.record.tries} · ${verdict.record.passes ?? 0} pass`,
                  )}
                  tone="neutral"
                  variant="soft"
                />
              ) : null}
            </Box>
            {targetCitation ? (
              <Text color={theme.accent} bold>
                {truncateDisplay(
                  `[o] ${targetCitation.title ? `${targetCitation.title} ` : ''}${
                    targetCitation.pageNumber != null ? `p.${targetCitation.pageNumber}` : ''
                  }`,
                  Math.max(12, Math.floor(innerW * 0.45)),
                )}
              </Text>
            ) : null}
          </Box>
          <Box marginTop={0} flexGrow={1} overflow="hidden" width={innerW}>
            <MarkdownView
              markdown={verdictMarkdown}
              width={innerW}
              height={Math.max(3, bodyH - stemH - 3 - (followupEngaged ? Math.min(11, Math.max(8, Math.floor(bodyH * 0.5))) : 3))}
              isActive={isActive && !editing && !submitting && !followupEngaged}
              mathUnicode={mathUnicode}
            />
          </Box>
          <NextStepFollowupBar
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            userAnswer={draft}
            toolLabel={t(lang, '费曼复述评估', 'Feynman Retell')}
            resultContext={verdictMarkdown}
            width={innerW}
            expandedHeight={Math.min(11, Math.max(8, Math.floor(bodyH * 0.5)))}
            isActive={isActive && !editing && !submitting && Boolean(verdict)}
            onFocusChange={setFollowupEngaged}
          />
        </Box>
      ) : null}
    </Modal>
  );
});
