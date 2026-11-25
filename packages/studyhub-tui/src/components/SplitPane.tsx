import React, { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { t, useTuiStore } from '../state/store.js';
import { glyph, hairline } from '../render/glyphs.js';
import { LAYOUT_BP } from './layout-tokens.js';

export interface PaneSize {
  width: number;
  height: number;
  /** true when this pane is visible (in narrow mode only the active pane is). */
  visible: boolean;
  /** true when layout is stacked/tabbed (width < breakpoint). */
  narrow: boolean;
}

export type PaneContent = ReactNode | ((size: PaneSize) => ReactNode);

export interface SplitPaneProps {
  width: number;
  height: number;
  left: PaneContent;
  right: PaneContent;
  /** Left pane width: ratio (0..1) or absolute columns (>1). Default 0.4. */
  leftWidth?: number;
  minLeft?: number;
  minRight?: number;
  /** Width threshold (of this pane's own width) below which layout collapses to tabbed mode. Default 86 (120-col terminal minus 24-col rail has contentW=94). */
  breakpoint?: number;
  /** Which pane has focus — highlighted divider side; and the pane shown when narrow. */
  activePane?: 'left' | 'right';
  /** Narrow mode: 'tabs' shows one pane + tab strip; 'stack' stacks vertically. */
  narrowMode?: 'tabs' | 'stack';
  leftLabel?: string;
  rightLabel?: string;
  /** Columns of gap between panes (default 1, rendered as a muted divider). */
  gap?: number;
  divider?: boolean;
}

function resolve(content: PaneContent, size: PaneSize): ReactNode {
  return typeof content === 'function' ? (content as (s: PaneSize) => ReactNode)(size) : content;
}

/** Pure layout math, exported for tests & views that pre-compute widths. */
export function computeSplit(
  width: number,
  opts: { leftWidth?: number; minLeft?: number; minRight?: number; breakpoint?: number; gap?: number } = {},
): { narrow: boolean; left: number; right: number; gap: number } {
  const { leftWidth = 0.4, minLeft = 24, minRight = 32, breakpoint = LAYOUT_BP.SPLIT_DEFAULT, gap = 1 } = opts;
  if (width < breakpoint) return { narrow: true, left: width, right: width, gap: 0 };
  let left = leftWidth <= 1 ? Math.round(width * leftWidth) : Math.round(leftWidth);
  left = Math.max(minLeft, Math.min(left, width - minRight - gap));
  const right = Math.max(1, width - left - gap);
  return { narrow: false, left, right, gap };
}

/** Responsive master-detail: side-by-side ≥ breakpoint, tabbed/stacked below. */
export const SplitPane = memo(function SplitPane({
  width,
  height,
  left,
  right,
  leftWidth = 0.4,
  minLeft = 24,
  minRight = 32,
  breakpoint = LAYOUT_BP.SPLIT_DEFAULT,
  activePane = 'left',
  narrowMode = 'tabs',
  leftLabel,
  rightLabel,
  gap = 1,
  divider = false,
}: SplitPaneProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const resolvedLeftLabel = leftLabel ?? t(lang, '列表', 'List');
  const resolvedRightLabel = rightLabel ?? t(lang, '详情', 'Detail');
  const layout = computeSplit(width, { leftWidth, minLeft, minRight, breakpoint, gap });

  if (layout.narrow) {
    if (narrowMode === 'stack') {
      const topH = Math.max(3, Math.floor((height - 1) * 0.45));
      const botH = Math.max(1, height - topH - 1);
      return (
        <Box flexDirection="column" width={width} height={height}>
          <Box height={topH} width={width} overflow="hidden">
            {resolve(left, { width, height: topH, visible: true, narrow: true })}
          </Box>
          <Text color={theme.border}>{hairline(width, asciiMode)}</Text>
          <Box height={botH} width={width} overflow="hidden">
            {resolve(right, { width, height: botH, visible: true, narrow: true })}
          </Box>
        </Box>
      );
    }
    const bodyH = Math.max(1, height - 1);
    const tab = (label: string, active: boolean, key: string) => (
      <Text key={key} color={active ? theme.primary : theme.muted} bold={active} backgroundColor={active ? theme.surface : undefined}>
        {` ${active ? glyph('dot', asciiMode) : glyph('dotOpen', asciiMode)} ${label} `}
      </Text>
    );
    const navHint =
      activePane === 'left'
        ? t(lang, `Enter/${glyph('arrowRight', asciiMode)} 详情 `, `Enter/${glyph('arrowRight', asciiMode)} Detail `)
        : t(lang, `Esc/${glyph('arrowLeft', asciiMode)} 返回 `, `Esc/${glyph('arrowLeft', asciiMode)} Back `);
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box height={1} width={width}>
          {tab(resolvedLeftLabel, activePane === 'left', 'l')}
          <Text color={theme.dim}> </Text>
          {tab(resolvedRightLabel, activePane === 'right', 'r')}
          <Box flexGrow={1} />
          <Text color={theme.dim}>{navHint}</Text>
        </Box>
        <Box height={bodyH} width={width} overflow="hidden">
          {activePane === 'left'
            ? resolve(left, { width, height: bodyH, visible: true, narrow: true })
            : resolve(right, { width, height: bodyH, visible: true, narrow: true })}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" width={width} height={height}>
      <Box width={layout.left} height={height} overflow="hidden" flexShrink={0}>
        {resolve(left, { width: layout.left, height, visible: true, narrow: false })}
      </Box>
      {layout.gap > 0 ? (
        <Box width={layout.gap} height={height} flexDirection="column" flexShrink={0}>
          {divider
            ? Array.from({ length: height }, (_, i) => (
                <Text key={i} color={theme.border}>
                  {' '.repeat(Math.max(0, layout.gap - 1))}
                  {i === 0 ? ' ' : glyph('vrule', asciiMode)}
                </Text>
              ))
            : null}
        </Box>
      ) : null}
      <Box width={layout.right} height={height} overflow="hidden" flexShrink={0}>
        {resolve(right, { width: layout.right, height, visible: true, narrow: false })}
      </Box>
    </Box>
  );
});
