import React, { memo, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { UiLanguage } from '../../types/contracts.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { truncateDisplay } from '../../render/cjk.js';
import { renderBarChart, renderStatTable } from '../../render/charts.js';
import { t, useTuiStore } from '../../state/store.js';
import type { CaseQuestionReport, ExamReport, ReportItem, ReportState } from './types.js';
import {
  buildCaseQuestionMarkdown,
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

const CLAIMED = ['b', 'h', 'l', 'w', 'p'];

function scoreBandBadge(
  scorePct: number,
  lang: UiLanguage,
): { label: string; tone: 'success' | 'warning' | 'error' } {
  if (scorePct >= 80) return { label: t(lang, '优秀', 'Strong'), tone: 'success' };
  if (scorePct >= 60) return { label: t(lang, '及格', 'Pass'), tone: 'warning' };
  return { label: t(lang, '待提升', 'Weak'), tone: 'error' };
}

function comparisonLabel(
  comparison: ExamReport['comparison'],
  lang: UiLanguage,
): { label: string; tone: 'success' | 'warning' | 'info' } | null {
  if (!comparison) return null;
  const delta = comparison.deltaPct;
  const sign = delta > 0 ? '+' : '';
  const tone = delta > 0 ? 'success' : delta < 0 ? 'warning' : 'info';
  if (typeof comparison.scorePct === 'number') {
    return {
      label: t(
        lang,
        `上次 ${Math.round(comparison.scorePct)}% (${sign}${delta}%)`,
        `Prev ${Math.round(comparison.scorePct)}% (${sign}${delta}%)`,
      ),
      tone,
    };
  }
  return delta !== 0 ? { label: `${sign}${delta}%`, tone } : null;
}

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
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ellipsis = asciiMode ? '...' : '…';
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useClaimKeys(CLAIMED, isActive);

  const isCaseReport = state.kind === 'written' && Boolean(state.report.case);

  const writtenItems: ReportItem[] = useMemo(() => {
    if (state.kind !== 'written' || state.report.case) return [];
    const wrong = (state.report.wrong ?? []).map((x) => ({ ...x, skipped: false }));
    const skipped = (state.report.skipped ?? []).map((x) => ({ ...x, skipped: true }));
    return [...wrong, ...skipped];
  }, [state]);

  const caseQuestions: CaseQuestionReport[] =
    state.kind === 'written' && state.report.case ? state.report.case.questions : [];
  const oralEntries = state.kind === 'oral' ? state.report.entries : [];

  const totalList = isCaseReport
    ? caseQuestions.length
    : state.kind === 'written'
      ? writtenItems.length
      : oralEntries.length;
  const safeIdx = Math.max(0, Math.min(selectedIdx, Math.max(0, totalList - 1)));

  const weakScope = state.report.weakScope ?? [];
  const topicBarItems = useMemo(
    () => (state.kind === 'written' && !state.report.case ? reportTopicBars(state.report, lang) : []),
    [state, lang],
  );

  useInput(
    (input, key) => {
      if (busy) return;
      if (input === 'b' || key.escape) {
        onBack();
        return true;
      }
      if ((input === 'w' || input === 'p') && weakScope.length > 0) {
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
      if (state.report.case) {
        const q = caseQuestions[safeIdx];
        if (!q) return t(lang, '暂无案例题目明细。', 'No case question details.');
        return buildCaseQuestionMarkdown(q, lang, state.report.case.pacing);
      }
      const item = writtenItems[safeIdx];
      if (!item) return t(lang, '全部答对！本次没有错题或漏答题。', 'All correct! No wrong or skipped questions.');
      return buildWrongItemMarkdown(item, lang);
    }
    const entry = oralEntries[safeIdx];
    if (!entry) return t(lang, '暂无题目明细。', 'No question details.');
    return buildOralEntryMarkdown(entry, lang);
  }, [state, caseQuestions, writtenItems, oralEntries, safeIdx, lang]);

  const renderLeftPane = (paneW: number, paneH: number) => {
    const innerW = Math.max(20, paneW - 4);
    const cursor = (selected: boolean) => (selected ? (asciiMode ? '> ' : '❯ ') : '  ');

    // Case Study Report
    if (state.kind === 'written' && state.report.case) {
      const r = state.report;
      const c = r.case!;
      const scoreTone = r.scorePct >= 80 ? 'success' : r.scorePct >= 60 ? 'warning' : 'error';
      const comp = comparisonLabel(r.comparison, lang);
      const band = scoreBandBadge(r.scorePct, lang);
      const weakBarsData = (c.weakest ?? [])
        .filter((w) => w.label)
        .slice(0, 4)
        .map((w) => {
          const pct = Math.round((Number(w.ratio) || 0) * 100);
          return {
            label: String(w.label),
            value: pct,
            color: pct < 60 ? theme.error : theme.warning,
          };
        });
      const bars = renderBarChart(weakBarsData, innerW, theme, { ascii: asciiMode });
      const summaryLines = 5 + (bars.length > 0 ? bars.length + 2 : 0);
      const listH = Math.max(4, paneH - summaryLines - 2);

      return (
        <Panel
          title={t(lang, '案例评估报告', 'Case Exam Report')}
          badge={`${Math.round(r.scorePct)}%`}
          badgeTone={scoreTone}
          focused={pane === 'list'}
          width={paneW}
          height={paneH}
          ascii={asciiMode}
        >
          <Box columnGap={1} marginBottom={1} flexWrap="wrap">
            <Badge label={`${c.total}/${c.max} ${t(lang, '分', 'pts')}`} tone={scoreTone} />
            <Badge label={band.label} tone={band.tone} variant="soft" />
            {c.pending > 0 ? (
              <Badge label={`${c.pending} ${t(lang, '待批改', 'pending')}`} tone="warning" variant="soft" />
            ) : null}
            {r.durationMs ? (
              <Badge label={formatDurationMs(r.durationMs)} tone="info" variant="soft" />
            ) : null}
            {comp ? <Badge label={comp.label} tone={comp.tone} variant="soft" /> : null}
            {weakScope.length > 0 ? (
              <Badge label={t(lang, 'w 练薄弱项', 'w Practise Weak')} tone="primary" />
            ) : null}
          </Box>

          {bars.length > 0 ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={theme.muted} bold>
                {t(lang, '薄弱评分维度 (%):', 'Weakest Criteria (%):')}
              </Text>
              {bars.map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
            </Box>
          ) : null}

          <Text color={theme.muted} bold>
            {t(lang, `各题评分 (${caseQuestions.length}):`, `Questions (${caseQuestions.length}):`)}
          </Text>
          {caseQuestions.length === 0 ? (
            <EmptyState
              icon={asciiMode ? 'o' : '◷'}
              title={t(lang, '暂无案例题目', 'No case questions')}
              hint={t(lang, '按 b 返回模拟考主页', 'Press b to return')}
              height={listH}
            />
          ) : (
            <VirtualList
              items={caseQuestions}
              width={innerW}
              height={listH}
              selectedIndex={safeIdx}
              onChange={(idx) => setSelectedIdx(idx)}
              onSelect={() => setPane('detail')}
              isActive={isActive && pane === 'list'}
              keyExtractor={(q, i) => `${q.cardId}:${i}`}
              renderItem={(q, ctx) => {
                const bandTag = q.band ?? q.status;
                const scoreStr = q.total !== null && q.total !== undefined ? `${q.total}/${q.marks}` : `-/${q.marks}`;
                const txt = truncateDisplay(
                  `${cursor(ctx.selected)}Q${q.n} [${bandTag}] ${scoreStr} ${q.prompt || ''}`,
                  ctx.width,
                  ellipsis,
                );
                return (
                  <Text
                    color={
                      ctx.selected
                        ? theme.selectionFg
                        : q.band === 'strong'
                          ? theme.success
                          : q.band === 'weak' || q.status === 'unanswered'
                            ? theme.error
                            : q.status === 'pending'
                              ? theme.warning
                              : theme.text
                    }
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

    // Written MCQ Report
    if (state.kind === 'written') {
      const r = state.report;
      const bars = renderBarChart(topicBarItems, innerW, theme, { ascii: asciiMode });
      // Round 96 Track A14: Borderless stat table for question-kind score breakdown
      const kindTableLines =
        (r.byKind ?? []).length > 0
          ? renderStatTable(
              [
                { key: 'kind', label: t(lang, '题型', 'Kind'), align: 'left', minWidth: 6 },
                { key: 'ratio', label: t(lang, '正确/总数', 'OK/Total'), align: 'right', minWidth: 8 },
                { key: 'pct', label: t(lang, '正确率', 'Acc'), align: 'right', minWidth: 6 },
              ],
              (r.byKind ?? []).map((k) => {
                const kLabel =
                  k.kind === 'multi'
                    ? t(lang, '多选', 'Multi')
                    : k.kind === 'truefalse'
                      ? t(lang, '判断', 'T/F')
                      : t(lang, '单选', 'Single');
                const pct = k.total > 0 ? Math.round((k.correct / k.total) * 100) : 0;
                return { kind: kLabel, ratio: `${k.correct}/${k.total}`, pct: `${pct}%` };
              }),
              innerW,
              theme,
              { ascii: asciiMode, headerRule: paneH >= 20 },
            )
          : [];
      const showKindTable = kindTableLines.length > 0 && paneH >= 16;
      const summaryLines = 5 + bars.length + (showKindTable ? kindTableLines.length + 1 : 0);
      const listH = Math.max(4, paneH - summaryLines - 2);
      const scoreTone = r.scorePct >= 80 ? 'success' : r.scorePct >= 60 ? 'warning' : 'error';
      const band = scoreBandBadge(r.scorePct, lang);
      const comp = comparisonLabel(r.comparison, lang);

      return (
        <Panel
          title={t(lang, '考试成绩单', 'Exam Report')}
          badge={`${Math.round(r.scorePct)}%`}
          badgeTone={scoreTone}
          focused={pane === 'list'}
          width={paneW}
          height={paneH}
          ascii={asciiMode}
        >
          <Box columnGap={1} marginBottom={1} flexWrap="wrap">
            <Badge label={`${r.correct}/${r.total} ${t(lang, '正确', 'OK')}`} tone={scoreTone} />
            <Badge label={band.label} tone={band.tone} variant="soft" />
            {r.durationMs ? (
              <Badge label={formatDurationMs(r.durationMs)} tone="info" variant="soft" />
            ) : null}
            {comp ? <Badge label={comp.label} tone={comp.tone} variant="soft" /> : null}
            {weakScope.length > 0 ? (
              <Badge label={t(lang, 'w 练错题', 'w Practise Weak')} tone="primary" />
            ) : null}
          </Box>

          {showKindTable ? (
            <Box flexDirection="column" marginBottom={1}>
              {kindTableLines.map((line, i) => (
                <Text key={`kt-${i}`}>{line}</Text>
              ))}
            </Box>
          ) : null}

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
              icon={asciiMode ? '+' : '✓'}
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
                const tag = asciiMode ? (item.skipped ? 'o' : 'x') : item.skipped ? '○' : '✕';
                const txt = truncateDisplay(
                  `${cursor(ctx.selected)}${tag} [${item.topic || ''}] ${item.prompt || ''}`,
                  ctx.width,
                  ellipsis,
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

    // Oral Report
    const r = state.report;
    const unassessed = Math.max(0, r.total - r.assessed);
    const showBandBars = paneH >= 18 && r.total > 0;
    const bandBars = showBandBars
      ? renderBarChart(
          [
            { label: t(lang, '优秀', 'Strong'), value: r.strong, color: theme.success },
            { label: t(lang, '尚可', 'Dev'), value: r.developing, color: theme.warning },
            { label: t(lang, '薄弱', 'Weak'), value: r.weak, color: theme.error },
            ...(unassessed > 0 ? [{ label: t(lang, '未评', 'N/A'), value: unassessed, color: theme.dim }] : []),
          ],
          innerW,
          theme,
          { ascii: asciiMode },
        )
      : [];
    const weakTopicsLine =
      (r.weakTopics ?? []).length > 0
        ? `${t(lang, '薄弱主题', 'Weak Topics')}: ${r.weakTopics!.map((w) => w.topic).join(', ')}`
        : '';
    const extraOverhead = (bandBars.length > 0 ? bandBars.length + 1 : 0) + (weakTopicsLine ? 1 : 0);
    const listH = Math.max(4, paneH - 8 - extraOverhead);

    return (
      <Panel
        title={t(lang, '口试评估报告', 'Oral Report')}
        badge={`${r.assessed}/${r.total}`}
        badgeTone="ai"
        focused={pane === 'list'}
        width={paneW}
        height={paneH}
        ascii={asciiMode}
      >
        <Box columnGap={1} marginBottom={1} flexWrap="wrap">
          {r.role ? <Badge label={r.role} tone="ai" variant="soft" /> : null}
          <Badge label={`${t(lang, '优秀', 'Strong')} ${r.strong}`} tone="success" />
          <Badge label={`${t(lang, '尚可', 'Dev')} ${r.developing}`} tone="warning" variant="soft" />
          <Badge label={`${t(lang, '薄弱', 'Weak')} ${r.weak}`} tone="error" variant="soft" />
          {weakScope.length > 0 ? (
            <Badge label={t(lang, 'w 练薄弱项', 'w Practise Weak')} tone="primary" />
          ) : null}
        </Box>

        {bandBars.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            {bandBars.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        ) : null}

        {weakTopicsLine ? (
          <Box marginBottom={1}>
            <Text color={theme.warning}>{truncateDisplay(weakTopicsLine, innerW, ellipsis)}</Text>
          </Box>
        ) : null}

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
            const gradeStr = item.assessment ? ` ${item.assessment.grade}/5` : '';
            const txt = truncateDisplay(
              `${cursor(ctx.selected)}[${band}${gradeStr}] ${item.topic || ''} · ${item.prompt || ''}`,
              ctx.width,
              ellipsis,
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
        ascii={asciiMode}
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
