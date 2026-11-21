import React, { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/index.js';

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
  children?: ReactNode;
}

const RULE = '─'.repeat(400);

/**
 * Rounded card. When `width` is numeric the title border is computed exactly; for
 * flex widths a clipped flex-grow rule fills the gap, so it works in both modes.
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
  paddingX = 1,
  paddingY = 0,
  direction = 'column',
  borderless = false,
  children,
}: PanelProps) {
  const theme = useTheme();
  const borderColor = tone ? toneColor(theme, tone) : focused ? theme.borderActive : theme.border;
  const titleColor = focused ? theme.primary : theme.text;
  const hasHeader = Boolean(title || subtitle || badge !== undefined);

  const numericWidth = typeof width === 'number' ? width : undefined;
  const badgeText = badge !== undefined && badge !== '' ? ` ${badge} ` : '';
  const metaRaw = subtitle ?? '';
  let titleText = title ? `${icon ? `${icon} ` : ''}${title}` : '';
  let metaText = metaRaw;
  if (numericWidth !== undefined) {
    // corners + dashes + spaces: "╭─ " + title + " " + badge + " " + rule + " " + meta + " ─╮"
    const chrome = 3 + 1 + 4;
    const avail = Math.max(0, numericWidth - chrome - displayWidth(badgeText));
    metaText = truncateDisplay(metaRaw, Math.max(0, Math.min(displayWidth(metaRaw), Math.floor(avail * 0.4))));
    titleText = truncateDisplay(titleText, Math.max(0, avail - displayWidth(metaText) - (metaText ? 1 : 0)));
  }

  const header = hasHeader ? (
    <Box height={1} width={numericWidth} flexShrink={0}>
      <Text color={borderColor}>{borderless ? '' : '╭─'}</Text>
      {titleText ? (
        <Text color={titleColor} bold>
          {` ${titleText} `}
        </Text>
      ) : (
        <Text color={borderColor}>─</Text>
      )}
      {badgeText ? (
        <Text backgroundColor={toneColor(theme, badgeTone)} color={theme.dark ? theme.bg : '#ffffff'} bold>
          {badgeText}
        </Text>
      ) : null}
      {badgeText ? <Text> </Text> : null}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} height={1} overflow="hidden">
        <Text color={borderless ? theme.border : borderColor}>{RULE}</Text>
      </Box>
      {metaText ? <Text color={theme.muted}>{` ${metaText} `}</Text> : null}
      <Text color={borderColor}>{borderless ? '' : '─╮'}</Text>
    </Box>
  ) : null;

  if (borderless) {
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
        borderStyle="round"
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
