import React, { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { glyph, hairline } from '../render/glyphs.js';
import { useTuiStore } from '../state/store.js';

export interface PanelProps {
  /** Title rendered inside the top border: `╭─ Title ─────── meta ─╮`. */
  title?: string;
  /** Optional icon before the title (e.g. page icon). */
  icon?: string;
  /** Small count/status badge right after the title. */
  badge?: string | number;
  badgeTone?: Tone;
  /** Right-aligned meta text inside the top border. */
  subtitle?: string;
  /** Focused panels get the active border colour + bold title. */
  focused?: boolean;
  /** Override border tone (e.g. 'error' for a failure card). */
  tone?: Tone;
  width?: number | string;
  height?: number | string;
  minHeight?: number;
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number | string;
  paddingX?: number;
  paddingY?: number;
  /** Body flex direction (default column). */
  direction?: 'row' | 'column';
  /** Disable border completely (keeps title as a header line). */
  borderless?: boolean;
  /** Quiet whitespace-first style (Round 82 Track A1): borderless with a subtle hairline header rule. */
  quiet?: boolean;
  /** Override store asciiMode preference (`classic` borders when true). */
  ascii?: boolean;
  children?: ReactNode;
}

const UNICODE_RULE = hairline(400, false);
const ASCII_RULE = hairline(400, true);

/**
 * Rounded card (or classic ASCII `+---+` card when `asciiMode` is enabled). When `width` is
 * numeric the title border is computed exactly; for flex widths a clipped flex-grow rule fills
 * the gap, so it works in both modes.
 */
export const Panel = memo(function Panel({
  title,
  icon,
  badge,
  badgeTone = 'primary',
  subtitle,
  focused = false,
  tone,
  width,
  height,
  minHeight,
  flexGrow,
  flexShrink,
  flexBasis,
  paddingX: paddingXProp,
  paddingY = 0,
  direction = 'column',
  borderless = false,
  quiet = false,
  ascii: asciiProp,
  children,
}: PanelProps) {
  const effectiveBorderless = borderless || quiet;
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const compactMode = useTuiStore((s) => Boolean(s.preferences.compactMode));
  const paddingX = paddingXProp ?? (compactMode ? 0 : 1);
  const ascii = asciiProp ?? storeAscii;
  const borderColor = tone ? toneColor(theme, tone) : focused ? theme.borderActive : theme.border;
  const titleColor = focused ? theme.primary : theme.text;
  const hasHeader = Boolean(title || subtitle || badge !== undefined);
  const ellipsis = glyph('ellipsis', ascii);

  const numericWidth = typeof width === 'number' ? width : undefined;
  const badgeText = badge !== undefined && badge !== '' ? ` ${badge} ` : '';
  const metaRaw = subtitle ?? '';
  let titleText = title ? `${icon ? `${icon} ` : ''}${title}` : '';
  let metaText = metaRaw;
  if (numericWidth !== undefined) {
    // corners + spaces around title/badge/meta + at least 1 rule dash
    const capsW = effectiveBorderless ? 0 : 4;
    const titleChrome = titleText ? 2 : 1;
    const badgeChrome = badgeText ? displayWidth(badgeText) + 1 : 0;
    const metaChrome = metaRaw ? 2 : 0;
    const avail = Math.max(0, numericWidth - capsW - titleChrome - badgeChrome - metaChrome - 1);
    const tW = displayWidth(titleText);
    const mW = displayWidth(metaRaw);
    if (tW + mW <= avail) {
      metaText = metaRaw;
    } else if (!metaRaw) {
      titleText = truncateDisplay(titleText, avail, ellipsis);
    } else if (!titleText) {
      metaText = truncateDisplay(metaRaw, avail, ellipsis);
    } else {
      const baseTitle = Math.floor(avail * 0.58);
      const baseMeta = avail - baseTitle;
      let titleBudget = baseTitle;
      let metaBudget = baseMeta;
      if (tW <= baseTitle) {
        titleBudget = tW;
        metaBudget = Math.max(0, avail - tW);
      } else if (mW <= baseMeta) {
        metaBudget = mW;
        titleBudget = Math.max(0, avail - mW);
      }
      titleText = truncateDisplay(titleText, titleBudget, ellipsis);
      metaText = truncateDisplay(metaRaw, metaBudget, ellipsis);
    }
  }

  const ruleText = ascii ? ASCII_RULE : UNICODE_RULE;
  const leftCap = effectiveBorderless ? '' : ascii ? '+-' : '╭─';
  const dashChar = ascii ? '-' : '─';
  const rightCap = effectiveBorderless ? '' : ascii ? '-+' : '─╮';

  const header = hasHeader ? (
    <Box height={1} width={numericWidth} flexShrink={0}>
      <Text color={borderColor}>{leftCap}</Text>
      {titleText ? (
        <Text color={titleColor} bold>
          {effectiveBorderless ? `${titleText} ` : ` ${titleText} `}
        </Text>
      ) : (
        <Text color={borderColor}>{dashChar}</Text>
      )}
      {badgeText ? (
        <Text backgroundColor={toneColor(theme, badgeTone)} color={theme.dark ? theme.bg : '#ffffff'} bold>
          {badgeText}
        </Text>
      ) : null}
      {badgeText ? <Text> </Text> : null}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} height={1} overflow="hidden">
        <Text color={effectiveBorderless ? theme.border : borderColor}>{ruleText}</Text>
      </Box>
      {metaText ? <Text color={theme.muted}>{` ${metaText} `}</Text> : null}
      <Text color={borderColor}>{rightCap}</Text>
    </Box>
  ) : null;

  if (effectiveBorderless) {
    return (
      <Box flexDirection="column" width={width} height={height} minHeight={minHeight} flexGrow={flexGrow} flexShrink={flexShrink} flexBasis={flexBasis}>
        {header}
        <Box flexDirection={direction} paddingX={paddingX} paddingY={paddingY} flexGrow={1} overflow="hidden">
          {children}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height} minHeight={minHeight} flexGrow={flexGrow} flexShrink={flexShrink} flexBasis={flexBasis}>
      {header}
      <Box
        flexDirection={direction}
        borderStyle={ascii ? 'classic' : 'round'}
        borderColor={borderColor}
        borderTop={!hasHeader}
        paddingX={paddingX}
        paddingY={paddingY}
        flexGrow={1}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
});
