import React from 'react';
import { Box, Text } from 'ink';
import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, ProgressBar, Spinner } from '../../components/Badge.js';
import { ClickableBox } from '../../components/mouse.js';
import { truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import { buildStuckNudgeMessage } from './stuck-nudge.js';

export interface ReviewCardTopBarProps {
  innerW: number;
  progressRatio: number;
  answeredCount: number;
  totalCount: number;
  retry: boolean;
  isCardFocused: boolean;
  busy: boolean;
  translating: boolean;
  isActive: boolean;
  hasTranslation: boolean;
  mathUnicode: boolean;
  lang: UiLanguage;
  asciiMode: boolean;
  panelHeaderTruncated: boolean;
  panelTitleStr: string;
  panelSubtitleStr: string;
}

export function ReviewCardTopBar({
  innerW,
  progressRatio,
  answeredCount,
  totalCount,
  retry,
  isCardFocused,
  busy,
  translating,
  isActive,
  hasTranslation,
  mathUnicode,
  lang,
  asciiMode,
  panelHeaderTruncated,
  panelTitleStr,
  panelSubtitleStr,
}: ReviewCardTopBarProps) {
  const theme = useTheme();
  return (
    <>
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" flexShrink={0} width={innerW} marginBottom={0}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <ProgressBar
            ratio={progressRatio}
            width={Math.min(20, Math.max(8, Math.floor(innerW * 0.25)))}
            showPercent={false}
          />
          <Text color={theme.muted}>{`${answeredCount}/${totalCount}`}</Text>
          {retry ? <Badge label={t(lang, '再练', 'Retry')} tone="warning" variant="soft" /> : null}
          {isCardFocused ? (
            <Badge
              label={
                asciiMode
                  ? lang === 'en'
                    ? '* Focus'
                    : '* 重点'
                  : lang === 'en'
                    ? '★ Focus'
                    : '★ 重点'
              }
              tone="accent"
              variant="soft"
            />
          ) : null}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {busy || translating ? <Spinner tone="primary" active={isActive} /> : null}
          {hasTranslation ? <Badge label="EN 译" tone="info" variant="soft" /> : null}
          <Badge
            label={mathUnicode ? (asciiMode ? 'Unicode' : '∑ Unicode') : 'TeX Raw'}
            tone="neutral"
            variant="outline"
          />
        </Box>
      </Box>
      {panelHeaderTruncated ? (
        <Box flexDirection="column" flexShrink={0} width={innerW}>
          {wrapDisplay(`${panelTitleStr}${asciiMode ? ' | ' : ' · '}${panelSubtitleStr}`, innerW).map((line, i) => (
            <Text key={`hdr-${i}`} color={theme.muted}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </>
  );
}

export interface ReviewStuckNudgeBannerProps {
  innerW: number;
  lang: UiLanguage;
  asciiMode: boolean;
  cardScopeActive: boolean;
  onDisableProactiveHints: () => void;
}

export function ReviewStuckNudgeBanner({
  innerW,
  lang,
  asciiMode,
  cardScopeActive,
  onDisableProactiveHints,
}: ReviewStuckNudgeBannerProps) {
  const theme = useTheme();
  return (
    <Box height={1} width={innerW} flexDirection="row" justifyContent="space-between" overflow="hidden" marginTop={0}>
      <Text color={theme.accent} wrap="truncate">
        {truncateDisplay(buildStuckNudgeMessage(lang, asciiMode), Math.max(12, innerW - 10), asciiMode ? '...' : '…')}
      </Text>
      <ClickableBox clickActive={cardScopeActive} onClick={onDisableProactiveHints}>
        <Text color={theme.dim}>{t(lang, '[关闭]', '[Off]')}</Text>
      </ClickableBox>
    </Box>
  );
}
