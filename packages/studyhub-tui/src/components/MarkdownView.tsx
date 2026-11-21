import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { useTuiStore } from '../state/store.js';
import { renderMarkdownLines } from '../render/index.js';
import { ScrollView } from './ScrollView.js';

export interface MarkdownViewProps {
  markdown: string;
  width: number;
  /** When set, content is windowed in a scrollable viewport of this many rows. */
  height?: number;
  /** Keyboard focus for scrolling (only meaningful with `height`). */
  isActive?: boolean;
  /** Override the user preference for LaTeX → Unicode. */
  mathUnicode?: boolean;
  highlight?: string;
  /** Follow the bottom (streaming answers). */
  follow?: boolean;
  scrollTop?: number;
  onScroll?: (top: number) => void;
}

/** Memoized Markdown + Math renderer (LRU-cached in render/markdown.ts). */
export const MarkdownView = memo(function MarkdownView({
  markdown,
  width,
  height,
  isActive = false,
  mathUnicode,
  highlight,
  follow,
  scrollTop,
  onScroll,
}: MarkdownViewProps) {
  const theme = useTheme();
  const prefMath = useTuiStore((s) => s.preferences.mathUnicode);
  const math = mathUnicode ?? prefMath;
  const scroll = height !== undefined;
  const renderWidth = Math.max(8, width - (scroll ? 1 : 0));
  const lines = useMemo(
    () => renderMarkdownLines(markdown || '', { width: renderWidth, theme, mathUnicode: math }),
    [markdown, renderWidth, theme, math],
  );

  if (scroll) {
    return (
      <ScrollView
        lines={lines}
        width={width}
        height={height as number}
        isActive={isActive}
        highlight={highlight}
        follow={follow}
        scrollTop={scrollTop}
        onScroll={onScroll}
      />
    );
  }
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((l, i) => (
        <Text key={i}>{l || ' '}</Text>
      ))}
    </Box>
  );
});
