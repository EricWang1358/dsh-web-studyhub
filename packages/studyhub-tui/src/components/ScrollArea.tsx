/**
 * Scrollable learner-content primitive (`<ScrollArea>`, #1354 D5).
 *
 * Design contract:
 * - Content never truncates silently: long text wraps to width and scrolls cleanly.
 * - Registers its own scroll keys (Arrow Up/Down, PageUp/PageDown, Home/End, Ctrl+D/Ctrl+U,
 *   SGR mouse wheel, and optional `j`/`k`) ONLY while `isActive` is true.
 * - Optional `prose` / `maxCols` centers long-form prose within a comfortable measure on wide terminals.
 * - Zero `marked` dependency: safe to import from core App.mjs and all lazy chunks.
 */
import React, { memo } from 'react';
import { Box } from 'ink';
import { computeProseLayout, PROSE_MAX_COLS } from './Layout.js';
import { ScrollView, type ScrollViewProps } from './ScrollView.js';

export interface ScrollAreaProps extends ScrollViewProps {
  /** Center content within a comfortable reading measure on ultrawide terminals (default false). */
  prose?: boolean;
  /** Custom reading measure cap when `prose` is true (default `PROSE_MAX_COLS = 96`). */
  maxCols?: number;
}

export const ScrollArea = memo(function ScrollArea({
  prose = false,
  maxCols = PROSE_MAX_COLS,
  width,
  height,
  vimJumpKeys = false,
  ...rest
}: ScrollAreaProps) {
  if (!prose) {
    return <ScrollView width={width} height={height} vimJumpKeys={vimJumpKeys} {...rest} />;
  }
  const { proseWidth, marginLeft } = computeProseLayout(width, maxCols);
  return (
    <Box width={width} height={height} paddingLeft={marginLeft} overflow="hidden">
      <ScrollView width={proseWidth} height={height} vimJumpKeys={vimJumpKeys} {...rest} />
    </Box>
  );
});
