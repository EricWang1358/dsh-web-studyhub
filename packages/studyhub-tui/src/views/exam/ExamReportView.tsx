import React, { memo, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UiLanguage } from '../../types/contracts.js';
import {
  Badge,
  EmptyState,
  MarkdownView,
  Panel,
  SplitPane,
  VirtualList,
  useClaimKeys,
  useTheme,
} from '../../components/index.js';
import { renderBarChart, truncateDisplay } from '../../render/index.js';
import { t } from '../../state/store.js';
import type { ReportItem, ReportState } from './types.js';
import {
  buildOralEntryMarkdown,
  buildWrongItemMarkdown,
  formatDurationMs,
  reportTopicBars,
} from './utils.js';

export interface ExamReportViewProps {
  state: ReportState;
  width: number;
  height: number;
  lang: UiLanguage;
  isActive: boolean;
  busy: boolean;
  onPracticeWeak: (scope: Array<{ deckId: string; cardId?: string }>) => void;
  onBack: () => void;
}

const CLAIMED = ['b', 'h', 'l'];

export const ExamReportView = memo(function ExamReportView({
  state,
  width,
  height,
  lang,
  isActive,
  busy,
  onPracticeWeak,
  onBack,
}: ExamReportViewProps) {
  const theme = useTheme();
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useClaimKeys(CLAIMED, isActive);

  const writtenItems: ReportItem[] = useMemo(() => {
    if (state.kind !== 'written') return [];
    const wrong = (state.report.wrong ?? []).map((x) => ({ ...x, skipped: false }));
    const skipped = (state.report.skipped ?? []).map((x) => ({ ...x, skipped: true }));
    return [...wrong, ...skipped];
  }, [state]);

  const oralEntries = state.kind === 'oral' ? state.report.entries : [];
  const totalList = state.kind === 'written' ? writtenItems.length : oralEntries.length;
  const safeIdx = Math.max(0, Math.min(selectedIdx, Math.max(0, totalList - 1)));

  const weakScope = state.report.weakScope ?? [];
  const topicBarItems = useMemo(
    () => (state.kind === 'written' ? reportTopicBars(state.report, lang) : []),
    [state, lang],
  );

  useInput(
    (input, key) => {
      if (busy) return;
      if (input === 'b' || key.escape) {
        onBack();
        return;
      }
      if (input === 'p' && weakScope.length > 0) {
        onPracticeWeak(weakScope);
        return;
      }
      if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
        if (input === 'h' || key.leftArrow) setPane('list');
        else if (input === 'l' || key.rightArrow) setPane('detail');
        else setPane((p) => (p === 'list' ? 'detail' : 'list'));
      }
    },
    { isActive },
  );

  const detailMarkdown = useMemo(() => {
    if (state.kind === 'written') {
      if (state.report.case && writtenItems.length === 0) {
        return state.report.case.questions
          .map(
            (q) =>
              `### Q${q.n} (${q.total ?? '?'}/${q.marks} ${lang === 'en' ? 'pts' : '分'} · ${q.status})\n\n${q.prompt || ''}\n\n${q.response || ''}`,
          )
          .join('\n\n---\n\n');
      }
      const item = writtenItems[safeIdx];
      if (!item) return t(lang, '全部答对！本次没有错题或漏答题。', 'All correct! No wrong or skipped questions.');
      return buildWrongItemMarkdown(item, lang);
    }
    const entry = oralEntries[safeIdx];
    if (!entry) return t(lang, '暂无题目明细。', 'No question details.');
    return buildOralEntryMarkdown(entry, lang);
  }, [state, writtenItems, oralEntries, safeIdx, lang]);

  const renderLeftPane = (paneW: number, paneH: number) => {
    const innerW = Math.max(20, paneW - 4);
    if (state.kind === 'written') {
      const r = state.report;
      const bars = renderBarChart(topicBarItems, innerW, theme);
      const summaryLines = 5 + bars.length;
      const listH = Math.max(4, paneH - summaryLines - 2);
      const scoreTone = r.scorePct >= 80 ? 'success' : r.scorePct >= 60 ? 'warning' : 'error';
      const delta = r.comparison?.deltaPct;
      return (
        <Panel
          title={t(lang, '考试成绩单', 'Exam Report')}
          badge={`${Math.round(r.scorePct)}%`}
          badgeTone={scoreTone}
          focused={pane === 'list'}
          width={paneW}
          height={paneH}
        >
          <Box gap={1} marginBottom={1}>
            <Badge label={`${r.correct}/${r.total} ${t(lang, '正确', 'OK')}`} tone={scoreTone} />
            {r.durationMs ? (
              <Badge label={formatDurationMs(r.durationMs)} tone="info" variant="soft" />
            ) : null}
            {typeof delta === 'number' && delta !== 0 ? (
              <Badge
                label={`${delta > 0 ? '+' : ''}${delta}%`}
                tone={delta > 0 ? 'success' : 'warning'}
                variant="soft"
              />
            ) : null}
            {weakScope.length > 0 ? (
              <Badge label={t(lang, 'p 练错题', 'p Practise Weak')} tone="primary" />
            ) : null}
          </Box>

          {bars.length > 0 ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={theme.muted} bold>
                {t(lang, '各主题正确率 (%):', 'Accuracy by Topic (%):')}
              </Text>
              {bars.map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
            </Box>
          ) : null}

          <Text color={theme.muted} bold>
            {t(lang, `错题与未答 (${writtenItems.length}):`, `Wrong & Skipped (${writtenItems.length}):`)}
          </Text>
          {writtenItems.length === 0 ? (
            <EmptyState
              icon="✓"
              title={t(lang, '全对通关！', 'Perfect Score!')}
              hint={t(lang, '按 b 返回模拟考主页', 'Press b to return')}
              height={listH}
            />
          ) : (
            <VirtualList
              items={writtenItems}
              width={innerW}
              height={listH}
              selectedIndex={safeIdx}
              onChange={(idx) => setSelectedIdx(idx)}
              onSelect={() => setPane('detail')}
              isActive={isActive && pane === 'list'}
              keyExtractor={(item, i) => `${item.deckId}:${item.cardId}:${i}`}
              renderItem={(item, ctx) => {
                const tag = item.skipped ? '○' : '✕';
                const txt = truncateDisplay(
                  `${ctx.selected ? '❯ ' : '  '}${tag} [${item.topic || ''}] ${item.prompt || ''}`,
                  ctx.width,
                );
                return (
                  <Text
                    color={ctx.selected ? theme.selectionFg : item.skipped ? theme.warning : theme.error}
                    bold={ctx.selected}
                  >
                    {txt}
                  </Text>
                );
              }}
            />
          )}
        </Panel>
      );
    }

    // Oral report
    const r = state.report;
    const listH = Math.max(4, paneH - 8);
    return (
      <Panel
        title={t(lang, '口试评估报告', 'Oral Report')}
        badge={`${r.assessed}/${r.total}`}
        badgeTone="ai"
        focused={pane === 'list'}
        width={paneW}
        height={paneH}
      >
        <Box gap={1} marginBottom={1}>
          <Badge label={`${t(lang, '优秀', 'Strong')} ${r.strong}`} tone="success" />
          <Badge label={`${t(lang, '尚可', 'Dev')} ${r.developing}`} tone="warning" variant="soft" />
          <Badge label={`${t(lang, '薄弱', 'Weak')} ${r.weak}`} tone="error" variant="soft" />
          {weakScope.length > 0 ? (
            <Badge label={t(lang, 'p 练薄弱项', 'p Practise Weak')} tone="primary" />
          ) : null}
        </Box>

        <VirtualList
          items={oralEntries}
          width={innerW}
          height={listH}
          selectedIndex={safeIdx}
          onChange={(idx) => setSelectedIdx(idx)}
          onSelect={() => setPane('detail')}
          isActive={isActive && pane === 'list'}
          keyExtractor={(item, i) => `${item.deckId}:${item.cardId}:${i}`}
          renderItem={(item, ctx) => {
            const band = item.assessment?.band ?? 'n/a';
            const txt = truncateDisplay(
              `${ctx.selected ? '❯ ' : '  '}[${band}] ${item.topic || ''} · ${item.prompt || ''}`,
              ctx.width,
            );
            return (
              <Text
                color={
                  ctx.selected
                    ? theme.selectionFg
                    : band === 'strong'
                      ? theme.success
                      : band === 'weak'
                        ? theme.error
                        : theme.text
                }
                bold={ctx.selected}
              >
                {txt}
              </Text>
            );
          }}
        />
      </Panel>
    );
  };

  const renderRightPane = (paneW: number, paneH: number) => {
    const innerW = Math.max(20, paneW - 4);
    const viewH = Math.max(4, paneH - 3);
    return (
      <Panel
        title={t(lang, '解析与详情', 'Review Detail')}
        focused={pane === 'detail'}
        width={paneW}
        height={paneH}
      >
        <MarkdownView
          markdown={detailMarkdown}
          width={innerW}
          height={viewH}
          isActive={isActive && pane === 'detail'}
        />
      </Panel>
    );
  };

  return (
    <SplitPane
      width={width}
      height={height}
      leftWidth={0.48}
      minLeft={32}
      minRight={30}
      breakpoint={86}
      activePane={pane === 'list' ? 'left' : 'right'}
      leftLabel={t(lang, '成绩概览', 'Summary')}
      rightLabel={t(lang, '题目解析', 'Detail')}
      left={(size) => renderLeftPane(size.width, size.height)}
      right={(size) => renderRightPane(size.width, size.height)}
    />
  );
});
