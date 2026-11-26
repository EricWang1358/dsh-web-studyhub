import React from 'react';
import { Box, Text } from 'ink';
import type { UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { isModelUnavailableError } from '../../host/ai-dialogue.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ChromeLabel, LAYOUT_BP, Prose } from '../../layout/index.js';
import { ClickableBox } from '../../components/mouse.js';
import { displayWidth, truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import { formatOsc8Link } from '../../render/osc8.js';
import { buildReviewQuickActions } from './quick-actions.js';
import {
  FSRS_GRADES,
  formatGapDays,
  type CardSourceLocation,
  type CardFeedbackShape,
  type CardTranslation,
  type ClozeBlankDiff,
} from './review-helpers.js';
import type { CardGradeResponse, RubricSummaryShape } from './review-view-model.js';

export interface ReviewFeedbackHeaderProps {
  innerW: number;
  lang: UiLanguage;
  asciiMode: boolean;
  isActive: boolean;
  gradingBusy: boolean;
  gradeError: string | null;
  feedback: CardFeedbackShape | null;
  userAnswerText: string;
  canUndo: boolean;
  clozeBlankDiffs: readonly ClozeBlankDiff[];
  activeRubric: RubricSummaryShape | null;
  gradeResult: CardGradeResponse | null;
  canAckCorrection: boolean;
  revealed: boolean;
  referenceAnswer: string;
  activeTranslation: CardTranslation | null;
}

export function ReviewFeedbackHeader({
  innerW,
  lang,
  asciiMode,
  isActive,
  gradingBusy,
  gradeError,
  feedback,
  userAnswerText,
  canUndo,
  clozeBlankDiffs,
  activeRubric,
  gradeResult,
  canAckCorrection,
  revealed,
  referenceAnswer,
  activeTranslation,
}: ReviewFeedbackHeaderProps) {
  const theme = useTheme();
  const undoLabel = asciiMode
    ? t(lang, '[u] 可撤销', '[u] Undoable')
    : t(lang, '↺ [u] 可撤销', '↺ [u] Undoable');
  const yoursFull = userAnswerText ? `${t(lang, '你的作答', 'Yours')}: ${userAnswerText}` : '';

  const renderFeedbackRow = () => {
    if (feedback) {
      const statusLabel = feedback.correct
        ? asciiMode
          ? t(lang, '+ 回答正确', '+ Correct')
          : t(lang, '✓ 回答正确', '✓ Correct')
        : feedback.selfReported
          ? asciiMode
            ? t(lang, 'o 已自报', 'o Self-reported')
            : t(lang, '○ 已自报', '○ Self-reported')
          : asciiMode
            ? t(lang, 'x 回答有误', 'x Incorrect')
            : t(lang, '✕ 回答有误', '✕ Incorrect');
      const usedW =
        displayWidth(statusLabel) +
        2 +
        (feedback.level ? displayWidth(String(feedback.level)) + 3 : 0) +
        (canUndo ? displayWidth(undoLabel) + 3 : 0);
      const fitsInline = Boolean(yoursFull) && usedW + 1 + displayWidth(yoursFull) <= innerW;
      return (
        <Box flexDirection="column" flexShrink={0} marginBottom={0} width={innerW}>
          <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} columnGap={1} width={innerW}>
            <Badge
              label={statusLabel}
              tone={feedback.correct ? 'success' : feedback.selfReported ? 'neutral' : 'error'}
            />
            {feedback.level ? <Badge label={String(feedback.level)} tone="accent" variant="soft" /> : null}
            {canUndo ? <Badge label={undoLabel} tone="info" variant="soft" /> : null}
            {fitsInline ? <Text color={theme.muted}>{yoursFull}</Text> : null}
          </Box>
          {yoursFull && !fitsInline ? (
            <Box flexDirection="column" flexShrink={0} width={innerW}>
              {wrapDisplay(yoursFull, innerW).map((line, i) => (
                <Text key={`ans-${i}`} color={theme.muted}>
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }

    if (userAnswerText || canUndo) {
      const usedW = canUndo ? displayWidth(undoLabel) + 3 : 0;
      const fitsInline = Boolean(yoursFull) && usedW + (canUndo ? 1 : 0) + displayWidth(yoursFull) <= innerW;
      return (
        <Box flexDirection="column" flexShrink={0} marginBottom={0} width={innerW}>
          {canUndo || fitsInline ? (
            <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} columnGap={1} width={innerW}>
              {canUndo ? <Badge label={undoLabel} tone="info" variant="soft" /> : null}
              {fitsInline ? <Text color={theme.muted}>{yoursFull}</Text> : null}
            </Box>
          ) : null}
          {yoursFull && !fitsInline ? (
            <Box flexDirection="column" flexShrink={0} width={innerW}>
              {wrapDisplay(yoursFull, innerW).map((line, i) => (
                <Text key={`ans-${i}`} color={theme.muted}>
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }

    return null;
  };

  return (
    <>
      {gradingBusy ? (
        <Box marginY={0}>
          <Spinner
            label={
              asciiMode
                ? t(lang, '正在按评分标准 AI 批改...', 'Grading against rubric criteria...')
                : t(lang, '正在按评分标准 AI 批改…', 'Grading against rubric criteria…')
            }
            tone="ai"
            active={isActive}
          />
        </Box>
      ) : null}

      {gradeError ? (
        <Box flexDirection="column" marginY={0}>
          <Box flexDirection="row" gap={1}>
            <Badge label={asciiMode ? '! AI评分不可用' : '▲ AI评分不可用'} tone="warning" />
            <Text color={theme.error} wrap="wrap">
              {gradeError}
            </Text>
          </Box>
          <Text color={theme.muted}>
            {isModelUnavailableError(gradeError)
              ? t(
                  lang,
                  '未检测到可用 AI 模型：请按 [,] 配置模型，或按 [Space] 对照参考答案后用 [0-5] 自评。',
                  'Model unavailable: configure one in Settings ([,]), or reveal reference answer and self-rate [0-5].',
                )
              : t(
                  lang,
                  '暂无法按评分标准批改，请对照参考答案后用 [0-5] 自评。',
                  'Could not run rubric grading; reveal reference answer and self-rate [0-5].',
                )}
          </Text>
        </Box>
      ) : null}

      {renderFeedbackRow()}

      {clozeBlankDiffs.length > 0 ? (
        <Box flexDirection="column" marginY={0} width={innerW}>
          {clozeBlankDiffs.map((diff) => {
            const icon =
              diff.matched === true
                ? asciiMode
                  ? '+'
                  : '✓'
                : diff.matched === false
                  ? asciiMode
                    ? 'x'
                    : '✕'
                  : asciiMode
                    ? '?'
                    : '·';
            const statusColor =
              diff.matched === true ? theme.success : diff.matched === false ? theme.error : theme.muted;
            const rawUser = diff.userValue || t(lang, '(未填)', '(empty)');
            const arrowText = asciiMode ? ' -> ' : ' → ';
            const showMismatch = diff.matched === false && diff.expected.length > 0;
            const userColor = !diff.userValue
              ? theme.muted
              : diff.matched === true
                ? theme.success
                : diff.matched === false
                  ? theme.error
                  : theme.text;
            return (
              <Box key={diff.id} flexDirection="row" width={innerW}>
                <Box flexShrink={0}>
                  <Text color={theme.muted}>{`#${diff.index} `}</Text>
                  <Text color={statusColor} bold>{`${icon} `}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Prose color={userColor} ascii={asciiMode}>
                    {rawUser}
                    {showMismatch ? (
                      <>
                        <Text color={theme.muted}>{arrowText}</Text>
                        <Text color={theme.success} bold>
                          {diff.expected}
                        </Text>
                      </>
                    ) : null}
                  </Prose>
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {activeRubric ? (
        <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} columnGap={1} marginY={0} width={innerW}>
          <Badge
            label={`${t(lang, 'Rubric 得分', 'Rubric')} ${activeRubric.total}/${activeRubric.max}`}
            tone={
              activeRubric.max > 0 && activeRubric.total / activeRubric.max >= 0.7
                ? 'success'
                : activeRubric.max > 0 && activeRubric.total / activeRubric.max > 0.5
                  ? 'warning'
                  : 'error'
            }
          />
          {activeRubric.band ? <Badge label={String(activeRubric.band)} tone="ai" variant="soft" /> : null}
          {feedback?.grade !== undefined || gradeResult?.grade !== undefined ? (
            <Badge label={`FSRS ${feedback?.grade ?? gradeResult?.grade}/5`} tone="accent" variant="soft" />
          ) : null}
          {feedback && typeof feedback.gradeOriginal === 'number' && feedback.gradeOriginal !== feedback.grade ? (
            <Badge
              label={t(
                lang,
                `已改分 ${feedback.grade} (AI 原评 ${feedback.gradeOriginal})`,
                `Adjusted ${feedback.grade} (AI: ${feedback.gradeOriginal})`,
              )}
              tone="info"
              variant="soft"
            />
          ) : null}
        </Box>
      ) : feedback && typeof feedback.gradeOriginal === 'number' && feedback.gradeOriginal !== feedback.grade ? (
        <Box flexDirection="row" alignItems="center" flexShrink={0} gap={1} marginY={0} width={innerW}>
          <Badge
            label={t(
              lang,
              `已改分 ${feedback.grade} (AI 原评 ${feedback.gradeOriginal})`,
              `Adjusted ${feedback.grade} (AI: ${feedback.gradeOriginal})`,
            )}
            tone="info"
            variant="soft"
          />
        </Box>
      ) : null}

      {canAckCorrection ? (
        <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} columnGap={1} marginY={0} width={innerW}>
          <Badge
            label={truncateDisplay(
              asciiMode
                ? t(lang, '待确认订正 - 按 [K] 确认并加入本轮重练', 'Correction pending - press [K] to confirm & queue retry')
                : t(lang, '待确认订正 · 按 [K] 确认并加入本轮重练', 'Correction pending · press [K] to confirm & queue retry'),
              Math.max(12, innerW - 2),
              asciiMode ? '...' : '…',
            )}
            tone="warning"
            variant="soft"
          />
        </Box>
      ) : null}

      {revealed ? (
        <Box flexDirection="column" flexShrink={0} width={innerW}>
          <Text color={theme.success} bold>
            {`${t(lang, '参考答案', 'Reference')}: ${referenceAnswer}`}
          </Text>
          {activeTranslation?.answer ? <Text color={theme.muted}>{`EN: ${activeTranslation.answer}`}</Text> : null}
        </Box>
      ) : null}
    </>
  );
}

export interface ReviewPostAnswerFooterProps {
  innerW: number;
  lang: UiLanguage;
  asciiMode: boolean;
  cardScopeActive: boolean;
  proactiveHints: boolean;
  wrongStreakBanner: string | null;
  fatigueBanner: string | null;
  revealed: boolean;
  citation: CardSourceLocation | null;
  citationUrl: string;
  needsRating: boolean;
  canRubricGrade: boolean;
  activeRubric: RubricSummaryShape | null;
  intervals: Array<number | null | undefined> | null;
  onClickWrongStreak: () => void;
  onDismissFatigue: () => void;
  onOpenCitation: () => void;
  onRubricGrade: () => void;
  onFsrsGrade: (grade: number) => void;
}

export function ReviewPostAnswerFooter({
  innerW,
  lang,
  asciiMode,
  cardScopeActive,
  proactiveHints,
  wrongStreakBanner,
  fatigueBanner,
  revealed,
  citation,
  citationUrl,
  needsRating,
  canRubricGrade,
  activeRubric,
  intervals,
  onClickWrongStreak,
  onDismissFatigue,
  onOpenCitation,
  onRubricGrade,
  onFsrsGrade,
}: ReviewPostAnswerFooterProps) {
  const theme = useTheme();

  return (
    <>
      {wrongStreakBanner && proactiveHints ? (
        <ClickableBox marginTop={0} clickActive={cardScopeActive} onClick={onClickWrongStreak}>
          <Prose tone="warning" ascii={asciiMode}>
            {wrongStreakBanner}
          </Prose>
        </ClickableBox>
      ) : null}

      {fatigueBanner && proactiveHints && !wrongStreakBanner ? (
        <ClickableBox marginTop={0} clickActive={cardScopeActive} onClick={onDismissFatigue}>
          <Prose tone="info" ascii={asciiMode}>
            {fatigueBanner}
          </Prose>
        </ClickableBox>
      ) : null}

      {revealed && citation ? (
        <ClickableBox marginTop={0} clickActive={cardScopeActive} onClick={onOpenCitation}>
          <Text color={theme.info}>
            {`${formatOsc8Link(
              `${asciiMode ? '#' : '▤'} ${citation.title ? `${citation.title} ` : ''}${
                citation.pageNumber != null ? t(lang, `第 ${citation.pageNumber} 页`, `p.${citation.pageNumber}`) : ''
              }`,
              citationUrl,
              { asciiMode },
            )} `}
          </Text>
          <Text color={theme.accent} bold>
            {t(lang, '[o] 跳转原文', '[o] Open Source')}
          </Text>
        </ClickableBox>
      ) : null}

      {needsRating ? (
        <Box flexDirection="column" marginTop={1} width={innerW}>
          <Box flexDirection="row" justifyContent="space-between" width={innerW} overflow="hidden">
            <Text color={theme.muted} bold wrap="truncate">
              {innerW < LAYOUT_BP.CONTENT_NARROW
                ? t(lang, 'FSRS评分 [0-5]:', 'Rate [0-5]:')
                : t(lang, 'FSRS-6 记忆评分（按数字键 0-5）:', 'FSRS-6 Rating (Press 0-5):')}
            </Text>
            {canRubricGrade && !activeRubric ? (
              <ClickableBox clickActive={cardScopeActive} onClick={onRubricGrade}>
                <Text color={theme.ai} bold>
                  {t(lang, '[G] AI 按标准评分', '[G] AI Rubric Grade')}
                </Text>
              </ClickableBox>
            ) : null}
          </Box>
          <Box flexDirection="row" gap={1} marginTop={0} width={innerW} overflow="hidden">
            {FSRS_GRADES.map((g) => {
              const gap = innerW >= LAYOUT_BP.WIDE && intervals ? formatGapDays(intervals[g.intervalIndex], lang) : '';
              const textLabel = lang === 'en' ? g.labelEn : g.labelZh;
              const label =
                innerW < LAYOUT_BP.SPLIT_COMPACT
                  ? `${g.key}${lang === 'en' ? `:${textLabel}` : textLabel}`
                  : `${g.key} ${textLabel}${gap ? `${asciiMode ? ' - ' : ' · '}${gap}` : ''}`;
              return (
                <ClickableBox key={g.key} clickActive={cardScopeActive} onClick={() => onFsrsGrade(g.grade)}>
                  <Badge label={label} tone={g.tone} variant="soft" />
                </ClickableBox>
              );
            })}
          </Box>
        </Box>
      ) : null}
    </>
  );
}

export interface ReviewQuickActionStripProps {
  innerW: number;
  lang: UiLanguage;
  asciiMode: boolean;
  cardScopeActive: boolean;
  isCardFocused: boolean;
  canRubricGrade: boolean;
  canRedo: boolean;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  canCoachNudge: boolean;
  actionHandlers: Record<string, () => void>;
}

export function ReviewQuickActionStrip({
  innerW,
  lang,
  asciiMode,
  cardScopeActive,
  isCardFocused,
  canRubricGrade,
  canRedo,
  canAdjustGrade,
  canAckCorrection,
  canCoachNudge,
  actionHandlers,
}: ReviewQuickActionStripProps) {
  const theme = useTheme();
  const ell = asciiMode ? '...' : '…';
  const items = buildReviewQuickActions({
    lang,
    isCardFocused,
    canRubricGrade,
    canRedo,
    canAdjustGrade,
    canAckCorrection,
    canCoachNudge,
  }).map((a) => ({
    ...a,
    onClick: actionHandlers[a.id] ?? (() => {}),
  }));
  const fullW = items.reduce((n, it, i) => n + displayWidth(it.text) + (i > 0 ? 1 : 0), 0);
  let kept = items;
  let moreHint = '';
  if (fullW > innerW) {
    moreHint = innerW >= 32 ? ` ${ell} ${t(lang, '按?看全部', '[?]All')}` : ` ${ell} [?]`;
    const budget = Math.max(0, innerW - displayWidth(moreHint));
    kept = [];
    let used = 0;
    for (const item of items) {
      const w = displayWidth(item.text);
      const sepW = kept.length > 0 ? 1 : 0;
      if (used + sepW + w > budget) break;
      kept.push(item);
      used += sepW + w;
    }
  }

  return (
    <Box height={1} width={innerW} flexDirection="row" overflow="hidden">
      {kept.map((item, i) => (
        <React.Fragment key={item.id}>
          {i > 0 ? <Text color={theme.dim}> </Text> : null}
          <ClickableBox clickActive={cardScopeActive} onClick={item.onClick} flexShrink={0}>
            <Text color={item.primary ? theme.accent : theme.dim}>{item.text}</Text>
          </ClickableBox>
        </React.Fragment>
      ))}
      {moreHint ? (
        <ClickableBox
          clickActive={cardScopeActive}
          onClick={() => useTuiStore.getState().setHelpOpen(true)}
          flexShrink={0}
        >
          <ChromeLabel text={moreHint} maxWidth={Math.max(1, innerW)} color={theme.dim} ascii={asciiMode} />
        </ClickableBox>
      ) : null}
    </Box>
  );
}
