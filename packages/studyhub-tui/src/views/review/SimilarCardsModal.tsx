import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { startReview, tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { SplitPane } from '../../components/SplitPane.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { ClickableBox } from '../../components/mouse.js';
import { originReviewFrame } from '../../state/practice-stack.js';
import { padDisplay, truncateDisplay } from '../../render/cjk.js';
import {
  currentDeckIdOf,
  kindLabel,
  normalizeCardKind,
  type NormalizedKind,
  type SimilarCardItem,
  type SimilarCardReason,
} from './review-helpers.js';
import { NextStepFollowupBar } from './NextStepFollowupBar.js';

export interface SimilarCardsModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  onClose: () => void;
  onStartRun: (nextRun: ReviewRun) => void;
}

function normalizeRemoteKind(raw: string | undefined): NormalizedKind {
  return normalizeCardKind({ id: 'tmp', index: 0, total: 1, card: { id: 'tmp', kind: raw } });
}

function formatReasons(reasons: readonly SimilarCardReason[] | undefined, lang: 'zh' | 'en'): string[] {
  if (!reasons || reasons.length === 0) return [];
  return reasons.map((r) => {
    if (r.type === 'topic' && r.topic) {
      return t(lang, `同知识点: ${r.topic}`, `Same topic: ${r.topic}`);
    }
    if (r.type === 'terms' && Array.isArray(r.terms) && r.terms.length > 0) {
      return t(lang, `共有关键词: ${r.terms.join('、')}`, `Shared terms: ${r.terms.join(', ')}`);
    }
    if (r.type === 'source' && r.sourceTitle) {
      return t(lang, `同源资料: ${r.sourceTitle}`, `Same source: ${r.sourceTitle}`);
    }
    return String(r.type || '');
  }).filter(Boolean);
}

export const SimilarCardsModal = memo(function SimilarCardsModal({
  host,
  run,
  cardId,
  kind,
  width,
  height,
  isActive,
  mathUnicode,
  onClose,
  onStartRun,
}: SimilarCardsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const practiceStack = useTuiStore((s) => s.practiceStack);
  const originFrame = useMemo(() => originReviewFrame(practiceStack), [practiceStack]);
  const originCardId = originFrame?.cardId ?? cardId;
  const originCardNum = (originFrame?.cardIndex ?? run.index ?? 0) + 1;
  const originPromptText = originFrame?.promptPreview || String(run.card?.prompt || '').replace(/\s+/g, ' ').trim();

  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SimilarCardItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const currentDeckId = currentDeckIdOf(run);

  const fetchSimilar = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await tryAction<{ item?: SimilarCardItem | null; items?: SimilarCardItem[] }>(
      host,
      'review.similar',
      {
        runId: run.id,
        cardId,
        ...(currentDeckId ? { deckId: currentDeckId } : {}),
      },
    );
    if (!mountedRef.current) return;
    setLoading(false);
    if (!res.ok) {
      setItems([]);
      setError(res.error?.message || t(lang, '查找同类题目失败', 'Failed to find similar cards'));
      return;
    }
    const val = res.value;
    const found = Array.isArray(val?.items)
      ? val.items.filter(Boolean)
      : val?.item
        ? [val.item]
        : [];
    setItems(found);
    setSelectedIndex(0);
  }, [host, run.id, cardId, currentDeckId, lang]);

  useEffect(() => {
    void fetchSimilar();
  }, [fetchSimilar]);

  const selectedItem = items[selectedIndex] ?? null;

  const handleLaunchContrast = useCallback(
    async (item: SimilarCardItem) => {
      if (launching || !item?.deckId || !item?.cardId) return;
      setLaunching(true);
      const scope: Array<{ deckId: string; cardId: string }> = [];
      if (currentDeckId && !(currentDeckId === item.deckId && cardId === item.cardId)) {
        scope.push({ deckId: currentDeckId, cardId });
      }
      scope.push({ deckId: item.deckId, cardId: item.cardId });
      try {
        const nextRun = await startReview(host, {
          mode: 'path',
          scope,
          fresh: true,
        });
        if (!mountedRef.current) return;
        notify(t(lang, '已开启同类对比练习', 'Started focused contrast practice'), 'success');
        onStartRun(nextRun);
        onClose();
      } catch (err) {
        if (!mountedRef.current) return;
        notify(err instanceof Error ? err.message : String(err), 'error');
        setLaunching(false);
      }
    },
    [launching, currentDeckId, cardId, host, notify, lang, onStartRun, onClose],
  );

  const [followupEngaged, setFollowupEngaged] = useState(false);

  const handleReturnToOrigin = useCallback(() => {
    const st = useTuiStore.getState();
    if (st.practiceStack.length > 0) {
      onClose();
      st.returnViaPracticeStack();
      return;
    }
    onClose();
  }, [onClose]);

  useInput(
    (input, key) => {
      if (launching) return;
      if (input === 'B') {
        handleReturnToOrigin();
        return;
      }
      if (input === 'r' && !loading) {
        void fetchSimilar();
        return;
      }
      if (loading || items.length === 0) return;
      if (key.tab || key.leftArrow || key.rightArrow) {
        setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (activePane === 'right' && key.return && selectedItem) {
        void handleLaunchContrast(selectedItem);
      }
    },
    { isActive: isActive && !followupEngaged },
  );

  const frameW = Math.max(48, Math.min(112, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(7, frameH - 5);
  const canFollowup = items.length > 0 && !loading && !error;
  const followupExpandedH = Math.min(11, Math.max(8, Math.floor(bodyH * 0.5)));
  const splitBodyH = Math.max(4, bodyH - (canFollowup ? (followupEngaged ? followupExpandedH : 3) : 0));

  const hints = useMemo<KeyHint[]>(() => {
    if (items.length > 0) {
      return [
        { key: 'Enter', label: t(lang, '对比练习', 'Contrast Practice') },
        { key: 'B', label: t(lang, `回到原题(#${originCardNum})`, `Back Origin(#${originCardNum})`) },
        { key: asciiMode ? 'Tab' : 'Tab/←→', label: t(lang, '切换面板', 'Pane') },
        { key: 'a', label: t(lang, '后续指令', 'Next step') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'B', label: t(lang, '回到原题', 'Back Origin') },
      { key: 'r', label: t(lang, '重新查找', 'Retry') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [items.length, lang, asciiMode, originCardNum]);

  const contrastMarkdown = useMemo(() => {
    if (!selectedItem) return '';
    const currentPrompt = String(run.card?.prompt || '').trim() || t(lang, '(无题干)', '(No prompt)');
    const currentTopic = typeof run.card?.topic === 'string' && run.card.topic ? run.card.topic : '';
    const simKind = kindLabel(normalizeRemoteKind(selectedItem.kind), lang);
    const reasons = formatReasons(selectedItem.reasons, lang);
    const lines: string[] = [];

    if (reasons.length > 0) {
      lines.push(`> **${t(lang, '关联依据', 'Match')}**: ${reasons.join(' · ')}`);
      lines.push('');
    }

    lines.push(`### ${t(lang, '当前题目', 'Current Card')} · ${kindLabel(kind, lang)}${currentTopic ? ` (${currentTopic})` : ''}`);
    lines.push(currentPrompt);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(
      `### ${t(lang, '同类对比题', 'Similar Card')} · ${simKind}${selectedItem.topic ? ` (${selectedItem.topic})` : ''}`,
    );
    if (selectedItem.deckTitle) {
      lines.push(`*${t(lang, '来自题组', 'Deck')}: ${selectedItem.deckTitle}*`);
      lines.push('');
    }
    lines.push(String(selectedItem.prompt || '').trim() || t(lang, '(无题干)', '(No prompt)'));
    return lines.join('\n');
  }, [selectedItem, run.card, kind, lang]);

  const renderSimilarRow = useCallback(
    (item: SimilarCardItem, ctx: VirtualListRenderContext) => {
      const isOrigin = item.cardId === originCardId;
      const originTag = isOrigin ? t(lang, '[原题] ', '[Origin] ') : '';
      const k = `[${kindLabel(normalizeRemoteKind(item.kind), lang)}]`;
      const scoreText = typeof item.score === 'number' ? ` ${item.score.toFixed(1)}` : '';
      const prefix = `${ctx.index + 1}. ${originTag}${k} `;
      const avail = Math.max(6, ctx.width - prefix.length - scoreText.length);
      const labelSource = `${item.topic ? `${item.topic} · ` : ''}${String(item.prompt || '').replace(/\s+/g, ' ')}`;
      const line = padDisplay(truncateDisplay(labelSource, avail), avail);
      const fg = ctx.selected ? theme.selectionFg : isOrigin ? theme.success : theme.text;
      return (
        <Text color={fg} bold={ctx.selected || isOrigin}>
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{`${ctx.index + 1}. `}</Text>
          {isOrigin ? <Text color={ctx.selected ? theme.selectionFg : theme.success} bold>{originTag}</Text> : null}
          <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{`${k} `}</Text>
          {line}
          {scoreText ? <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{scoreText}</Text> : null}
        </Text>
      );
    },
    [lang, theme, originCardId],
  );

  return (
    <Modal
      title={t(lang, '同类 / 易混题对比', 'Similar & Confusable Cards')}
      icon={asciiMode ? '<>' : '⇄'}
      tone="info"
      subtitle={
        items.length > 0
          ? t(lang, `${items.length} 道相关题`, `${items.length} found`)
          : undefined
      }
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive && !followupEngaged}
      hints={hints}
    >
      {loading ? (
        <Box height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在检索同类易混题目…', 'Searching similar cards…')} active={isActive} />
        </Box>
      ) : error ? (
        <Box height={bodyH} flexDirection="column" justifyContent="center" paddingX={1} gap={1}>
          <Text color={theme.error} bold>{`${asciiMode ? 'x' : '✕'} ${error}`}</Text>
          <Text color={theme.muted}>{t(lang, '按 [r] 重试，或按 [Esc] 返回复习', 'Press [r] to retry, or [Esc] to return')}</Text>
        </Box>
      ) : items.length === 0 ? (
        <EmptyState
          icon={asciiMode ? '<>' : '⇄'}
          title={t(lang, '题库里暂无这一轮之外的同类题', 'No similar cards outside this round')}
          hint={t(lang, '同类题推荐会自动排除本轮已包含或最近刚做对的题目。', 'Similar recommendations exclude cards already in this round or recently mastered.')}
          actions={[
            { key: 'r', label: t(lang, '重试', 'Retry') },
            { key: 'Esc', label: t(lang, '返回', 'Close') },
          ]}
          width={innerW}
          height={bodyH}
        />
      ) : (
        <Box flexDirection="column" height={bodyH} width={innerW} overflow="hidden">
          <Box height={1} width={innerW} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
            <Text color={theme.success} bold wrap="truncate">
              {truncateDisplay(
                `${t(lang, `[原题 第${originCardNum}题]`, `[Origin #${originCardNum}]`)} ${originPromptText}`,
                Math.max(12, innerW - 18),
                asciiMode ? '...' : '…',
              )}
            </Text>
            <ClickableBox clickActive={isActive && !followupEngaged} onClick={handleReturnToOrigin}>
              <Text backgroundColor={theme.surface} color={theme.primary} bold>
                {` [B] ${t(lang, '回到原题', 'Back Origin')} `}
              </Text>
            </ClickableBox>
          </Box>
          {launching ? (
            <Box height={1} flexShrink={0}>
              <Spinner label={t(lang, '正在生成对比练习轮…', 'Starting contrast run…')} active={isActive} />
            </Box>
          ) : null}
          <SplitPane
            width={innerW}
            height={Math.max(4, splitBodyH - 1 - (launching ? 1 : 0))}
            leftWidth={0.4}
            minLeft={22}
            minRight={28}
            breakpoint={74}
            activePane={activePane}
            divider
            leftLabel={t(lang, '同类题', 'Similar')}
            rightLabel={t(lang, '差异对比', 'Contrast')}
            left={(size) => (
              <Box flexDirection="column" width={size.width} height={size.height}>
                <Box height={1} width={size.width}>
                  <Badge
                    label={t(lang, '同类匹配', 'Matches')}
                    tone={activePane === 'left' ? 'primary' : 'neutral'}
                    variant="soft"
                  />
                </Box>
                <VirtualList
                  items={items}
                  height={Math.max(1, size.height - 1)}
                  width={size.width}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  onSelect={(item) => {
                    void handleLaunchContrast(item);
                  }}
                  isActive={isActive && !launching && activePane === 'left' && !followupEngaged}
                  keyExtractor={(item) => `${item.deckId}:${item.cardId}`}
                  renderItem={renderSimilarRow}
                />
              </Box>
            )}
            right={(size) => (
              <Box flexDirection="column" width={size.width} height={size.height} overflow="hidden">
                <MarkdownView
                  markdown={contrastMarkdown}
                  width={size.width}
                  height={size.height}
                  isActive={isActive && activePane === 'right' && !followupEngaged}
                  mathUnicode={mathUnicode}
                />
              </Box>
            )}
          />
          {canFollowup ? (
            <NextStepFollowupBar
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              toolLabel={t(lang, '同类易混题对比', 'Similar Cards Contrast')}
              resultContext={contrastMarkdown}
              width={innerW}
              expandedHeight={followupExpandedH}
              isActive={isActive && canFollowup}
              onFocusChange={setFollowupEngaged}
            />
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
