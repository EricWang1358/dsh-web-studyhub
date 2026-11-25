/**
 * Unified grid, spacing, and quiet borderless section primitives (Round 82 Track A1).
 *
 * Design principles:
 * - Prefer whitespace + a subtle hairline rule over stacked nested box borders.
 * - Consistent horizontal padding (`PAGE_PADDING_X = 1`), gutter (`GRID_GUTTER = 1`),
 *   and section rhythm (`SECTION_GAP = 1`) across wide (120x36) and narrow (80x24) viewports.
 * - Zero external dependencies (`marked`-free, safe to import from any lazy chunk).
 */
import React, { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { glyph, hairline } from '../render/glyphs.js';
import { useTuiStore } from '../state/store.js';
import { normalizeAsciiChrome } from './Badge.js';
import { LAYOUT_CHROME } from './layout-tokens.js';

export const GRID_GUTTER = LAYOUT_CHROME.GRID_GUTTER;
export const PAGE_PADDING_X = LAYOUT_CHROME.PAGE_PADDING_X;
export const SECTION_GAP = LAYOUT_CHROME.SECTION_GAP;
/** Comfortable reading measure cap (Round 83 Track A2): ultrawide screens center prose within 96 columns. */
export const PROSE_MAX_COLS: number = LAYOUT_CHROME.PROSE_MAX_COLS;

export type DensityMode = 'relaxed' | 'compact';

export interface DensitySpacing {
  mode: DensityMode;
  panelPaddingX: number;
  sectionGap: number;
  rowGap: number;
}

/**
 * Resolve layout spacing from user's compact/relaxed density preference (Round 87 Track A6).
 * Defaults to `relaxed` (`compactMode = false`) for lower visual fatigue.
 */
export function resolveDensitySpacing(compactMode = false): DensitySpacing {
  return compactMode
    ? { mode: 'compact', panelPaddingX: 0, sectionGap: 0, rowGap: 0 }
    : { mode: 'relaxed', panelPaddingX: PAGE_PADDING_X, sectionGap: SECTION_GAP, rowGap: 1 };
}

export interface ProseLayout {
  proseWidth: number;
  marginLeft: number;
  centered: boolean;
}

/**
 * Compute comfortable reading measure and horizontal centering offset.
 * - When `availableWidth <= maxCols` (e.g. 80x24 or 120x36 with SideNav), uses full available width (`marginLeft = 0`).
 * - When `availableWidth > maxCols` (ultrawide screens), caps prose width at `maxCols` and centers with balanced whitespace.
 */
export function computeProseLayout(availableWidth: number, maxCols = PROSE_MAX_COLS): ProseLayout {
  const safeAvail = Math.max(12, Math.floor(availableWidth));
  const cap = Math.max(20, Math.floor(maxCols));
  if (safeAvail <= cap) {
    return { proseWidth: safeAvail, marginLeft: 0, centered: false };
  }
  const marginLeft = Math.floor((safeAvail - cap) / 2);
  return { proseWidth: cap, marginLeft, centered: marginLeft > 0 };
}

export interface ProseContainerProps {
  width: number;
  maxCols?: number;
  height?: number;
  flexGrow?: number;
  children?: ReactNode | ((proseWidth: number) => ReactNode);
}

/** Centers long-form prose cleanly within `maxCols` (default 96) on ultrawide terminals. */
export const ProseContainer = memo(function ProseContainer({
  width,
  maxCols = PROSE_MAX_COLS,
  height,
  flexGrow,
  children,
}: ProseContainerProps) {
  const { proseWidth, marginLeft } = computeProseLayout(width, maxCols);
  return (
    <Box width={width} height={height} flexGrow={flexGrow} paddingLeft={marginLeft} flexDirection="column" overflow="hidden">
      <Box width={proseWidth} height={height} flexGrow={flexGrow} flexDirection="column" overflow="hidden">
        {typeof children === 'function' ? children(proseWidth) : children}
      </Box>
    </Box>
  );
});

const UNICODE_HAIRLINE = hairline(400, false);
const ASCII_HAIRLINE = hairline(400, true);

export interface ChromeLabelProps {
  text: string;
  maxWidth: number;
  color?: string;
  tone?: Tone;
  bold?: boolean;
  dimColor?: boolean;
  ascii?: boolean;
}

/**
 * Single-line UI chrome truncation primitive (#1354 D5).
 * Only chrome titles, badges, and rail labels should truncate; learner content uses `<Prose>`.
 */
export const ChromeLabel = memo(function ChromeLabel({
  text,
  maxWidth,
  color,
  tone,
  bold,
  dimColor,
  ascii: asciiProp,
}: ChromeLabelProps) {
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const resolvedColor = color ?? (tone ? toneColor(theme, tone) : theme.text);
  const clipped = truncateDisplay(normalizeAsciiChrome(text, ascii), Math.max(0, Math.floor(maxWidth)), glyph('ellipsis', ascii));
  return (
    <Text color={resolvedColor} bold={bold} dimColor={dimColor} wrap="truncate-end">
      {clipped}
    </Text>
  );
});

export interface ProseProps {
  width?: number;
  maxCols?: number;
  color?: string;
  tone?: Tone;
  bold?: boolean;
  ascii?: boolean;
  children: ReactNode;
}

/**
 * Wrapping learner-content typography primitive (#1354 D5): never truncates content.
 * Wraps cleanly within `computeProseLayout(width, maxCols)` on wide terminals.
 */
export const Prose = memo(function Prose({
  width,
  maxCols = PROSE_MAX_COLS,
  color,
  tone,
  bold,
  ascii: asciiProp,
  children,
}: ProseProps) {
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const resolvedColor = color ?? (tone ? toneColor(theme, tone) : theme.text);
  const layout = typeof width === 'number' ? computeProseLayout(width, maxCols) : null;
  const body = typeof children === 'string' ? normalizeAsciiChrome(children, ascii) : children;
  if (!layout) {
    return (
      <Text color={resolvedColor} bold={bold} wrap="wrap">
        {body}
      </Text>
    );
  }
  return (
    <Box width={width} paddingLeft={layout.marginLeft} flexDirection="column">
      <Box width={layout.proseWidth} flexDirection="column">
        <Text color={resolvedColor} bold={bold} wrap="wrap">
          {body}
        </Text>
      </Box>
    </Box>
  );
});

export interface SectionHeaderProps {
  title: string;
  icon?: string;
  badge?: string | number;
  badgeTone?: Tone;
  meta?: string;
  width?: number;
  ascii?: boolean;
  /** Render a subtle trailing hairline rule (default true). */
  rule?: boolean;
  focused?: boolean;
}

/**
 * Quiet borderless section header: `Title [badge] ──────────── meta`.
 * Replaces nested heavy boxes inside already-framed panes.
 */
export const SectionHeader = memo(function SectionHeader({
  title,
  icon,
  badge,
  badgeTone = 'primary',
  meta,
  width,
  ascii: asciiProp,
  rule = true,
  focused = false,
}: SectionHeaderProps) {
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const ell = glyph('ellipsis', ascii);
  const ruleText = ascii ? ASCII_HAIRLINE : UNICODE_HAIRLINE;

  const badgeText = badge !== undefined && badge !== '' ? ` ${badge} ` : '';
  let titleText = icon ? `${icon} ${title}` : title;
  let metaText = meta ?? '';

  if (typeof width === 'number' && width > 0) {
    const badgeW = badgeText ? displayWidth(badgeText) + 1 : 0;
    const ruleMin = rule ? 2 : 0;
    const avail = Math.max(0, width - badgeW - ruleMin - (metaText ? 1 : 0));
    const tW = displayWidth(titleText);
    const mW = displayWidth(metaText);
    if (tW + mW > avail) {
      if (!metaText) {
        titleText = truncateDisplay(titleText, avail, ell);
      } else {
        const metaBudget = Math.min(mW, Math.max(0, Math.floor(avail * 0.42)));
        const titleBudget = Math.max(0, avail - metaBudget);
        titleText = truncateDisplay(titleText, titleBudget, ell);
        metaText = truncateDisplay(metaText, metaBudget, ell);
      }
    }
  }

  return (
    <Box height={1} width={width} flexDirection="row" overflow="hidden" flexShrink={0}>
      <Text color={focused ? theme.primary : theme.heading} bold>
        {titleText}
      </Text>
      {badgeText ? (
        <>
          <Text> </Text>
          <Text backgroundColor={toneColor(theme, badgeTone)} color={theme.dark ? theme.bg : '#ffffff'} bold>
            {badgeText}
          </Text>
        </>
      ) : null}
      {rule ? (
        <Box flexGrow={1} flexShrink={1} flexBasis={0} height={1} paddingLeft={1} overflow="hidden">
          <Text color={focused ? theme.borderActive : theme.border}>{ruleText}</Text>
        </Box>
      ) : (
        <Box flexGrow={1} />
      )}
      {metaText ? <Text color={theme.muted}>{` ${metaText}`}</Text> : null}
    </Box>
  );
});

export interface PageHeaderProps {
  title: string;
  icon?: string;
  badge?: string | number;
  meta?: string;
  right?: ReactNode;
  width?: number;
  ascii?: boolean;
  divider?: boolean;
}

/**
 * Unified top-of-page header bar with consistent title hierarchy and optional 1px hairline divider.
 */
export const PageHeader = memo(function PageHeader({
  title,
  icon,
  badge,
  meta,
  right,
  width,
  ascii: asciiProp,
  divider = true,
}: PageHeaderProps) {
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const ell = glyph('ellipsis', ascii);
  const ruleText = ascii ? ASCII_HAIRLINE : UNICODE_HAIRLINE;
  const titleText = icon ? `${icon} ${title}` : title;
  const badgeText = badge !== undefined && badge !== '' ? ` ${badge} ` : '';

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box height={1} width={width} flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Box flexDirection="row" flexShrink={1} overflow="hidden">
          <Text color={theme.primary} bold>
            {typeof width === 'number' ? truncateDisplay(titleText, Math.max(8, width - 8), ell) : titleText}
          </Text>
          {badgeText ? (
            <>
              <Text> </Text>
              <Text backgroundColor={theme.surface} color={theme.accent} bold>
                {badgeText}
              </Text>
            </>
          ) : null}
          {meta ? (
            <Text color={theme.muted} wrap="truncate">
              {`  ${meta}`}
            </Text>
          ) : null}
        </Box>
        {right ? <Box flexShrink={0}>{right}</Box> : null}
      </Box>
      {divider ? (
        <Box height={1} width={width} overflow="hidden">
          <Text color={theme.border}>{ruleText}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
