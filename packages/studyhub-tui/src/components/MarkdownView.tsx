import React, { memo, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { useTuiStore } from '../state/store.js';
import { renderMarkdownLines } from '../render/markdown.js';
import { ScrollView } from './ScrollView.js';

const EMPTY_LINES: string[] = [];

export interface MarkdownViewProps {
  markdown: string;
  width: number;
  /** When set, content is windowed in a scrollable viewport of this many rows. */
  height?: number;
  /** Keyboard focus for scrolling (only meaningful with `height`). */
  isActive?: boolean;
  /** Override the user preference for LaTeX → Unicode. */
  mathUnicode?: boolean;
  /** Override the user preference for ASCII-safe borders/rules. */
  ascii?: boolean;
  highlight?: string;
  /** Follow the bottom (streaming answers). */
  follow?: boolean;
  scrollTop?: number;
  onScroll?: (top: number) => void;
  /** Opt in to Vim `g` / `G` jump keys in scrollable mode (default false, #1374). */
  vimJumpKeys?: boolean;
  /** Enable Vim `j` / `k` scroll keys in scrollable mode (default true, #1386). */
  vimNavKeys?: boolean;
  /** Enable `Space` page-down in scrollable mode (default true, #1390). */
  spacePageDown?: boolean;
}

/** Memoized Markdown + Math renderer (LRU-cached in render/markdown.ts). */
export const MarkdownView = memo(function MarkdownView({
  markdown,
  width,
  height,
  isActive = false,
  mathUnicode,
  ascii,
  highlight,
  follow,
  scrollTop,
  onScroll,
  vimJumpKeys = false,
  vimNavKeys = true,
  spacePageDown = true,
}: MarkdownViewProps) {
  const theme = useTheme();
  const prefMath = useTuiStore((s) => s.preferences.mathUnicode);
  const prefAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const math = mathUnicode ?? prefMath;
  const asciiMode = ascii ?? prefAscii;
  const scroll = height !== undefined;
  const renderWidth = Math.max(8, width - (scroll ? 1 : 0));
  const text = markdown || '';
  const themeId = theme.id;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const lines = useMemo(
    () =>
      text
        ? renderMarkdownLines(text, {
            width: renderWidth,
            theme: themeRef.current,
            mathUnicode: math,
            ascii: asciiMode,
          })
        : EMPTY_LINES,
    [text, renderWidth, themeId, math, asciiMode],
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
        vimJumpKeys={vimJumpKeys}
        vimNavKeys={vimNavKeys}
        spacePageDown={spacePageDown}
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
