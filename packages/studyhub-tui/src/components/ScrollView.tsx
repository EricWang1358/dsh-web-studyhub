import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stripAnsi from 'strip-ansi';
import { useTheme } from '../theme/tokens.js';
import { displayWidth, truncateDisplay, wrapDisplay } from '../render/index.js';
import { useTuiStore } from '../state/store.js';
import { pageStep, scrollbarThumb } from './VirtualList.js';

export { pageStep } from './VirtualList.js';

export interface ScrollViewProps {
  /** Pre-split lines (may contain ANSI). Takes precedence over `content`. */
  lines?: readonly string[];
  /** Raw text; wrapped to `width` with CJK-aware wrapping. */
  content?: string;
  height: number;
  width: number;
  isActive?: boolean;
  /** Controlled scroll top. */
  scrollTop?: number;
  onScroll?: (top: number) => void;
  /** Case-insensitive search term to highlight; `n` / `N` jump between matches. */
  highlight?: string;
  showIndicator?: boolean;
  /** Start scrolled to bottom and follow new lines (for logs / streaming output). */
  follow?: boolean;
  /** Override store asciiMode preference (`#` / `|` scrollbar when true). */
  ascii?: boolean;
}

const INV_ON = '\u001b[7m';
const INV_OFF = '\u001b[27m';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Highlight `term` in a plain/ANSI line (matches searched on visible text only when line has no ANSI). */
export function highlightLine(line: string, term: string): string {
  if (!term) return line;
  const re = new RegExp(escapeRegExp(term), 'gi');
  if (line.includes('\u001b')) {
    // Only highlight inside plain text runs between escape sequences.
    return line.replace(/((?:\u001b\[[0-9;]*m)+)|([^\u001b]+)/g, (m, esc: string | undefined, txt: string | undefined) =>
      esc ? esc : (txt ?? m).replace(re, (x) => `${INV_ON}${x}${INV_OFF}`),
    );
  }
  return line.replace(re, (x) => `${INV_ON}${x}${INV_OFF}`);
}

export const ScrollView = memo(function ScrollView({
  lines,
  content,
  height,
  width,
  isActive = true,
  scrollTop,
  onScroll,
  highlight,
  showIndicator = true,
  follow = false,
  ascii: asciiProp,
}: ScrollViewProps) {
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const rows = Math.max(1, height);
  const indicator = showIndicator;
  const textWidth = Math.max(1, width - (indicator ? 1 : 0));

  const all = useMemo<readonly string[]>(() => {
    if (lines) return lines;
    if (!content) return [];
    return wrapDisplay(content, textWidth);
  }, [lines, content, textWidth]);

  const maxTop = Math.max(0, all.length - rows);
  const controlled = scrollTop !== undefined;
  const [internal, setInternal] = useState(follow ? maxTop : 0);
  const top = Math.max(0, Math.min(controlled ? (scrollTop as number) : internal, maxTop));

  useEffect(() => {
    if (follow && !controlled) setInternal(maxTop);
  }, [follow, controlled, maxTop]);

  const matchRows = useMemo(() => {
    if (!highlight) return [] as number[];
    const needle = highlight.toLowerCase();
    const out: number[] = [];
    all.forEach((l, i) => {
      if (stripAnsi(l).toLowerCase().includes(needle)) out.push(i);
    });
    return out;
  }, [all, highlight]);

  const scrollTo = useCallback(
    (to: number) => {
      const next = Math.max(0, Math.min(to, maxTop));
      if (next === top) return;
      if (!controlled) setInternal(next);
      onScroll?.(next);
    },
    [maxTop, top, controlled, onScroll],
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'd') scrollTo(top + pageStep(rows, 'half'));
      else if (key.ctrl && input === 'u') scrollTo(top - pageStep(rows, 'half'));
      else if (key.pageDown || input === ' ' || (key.ctrl && input === 'f')) scrollTo(top + pageStep(rows, 'full'));
      else if (key.pageUp || (key.ctrl && input === 'b')) scrollTo(top - pageStep(rows, 'full'));
      else if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) scrollTo(top + 1);
      else if (key.upArrow || (!key.ctrl && !key.meta && input === 'k')) scrollTo(top - 1);
      else if (key.home || (!key.ctrl && !key.meta && input === 'g')) scrollTo(0);
      else if (key.end || (!key.ctrl && !key.meta && input === 'G')) scrollTo(maxTop);
      else if (input === 'n' && matchRows.length > 0) {
        const next = matchRows.find((r) => r > top) ?? matchRows[0];
        scrollTo(next);
      } else if (input === 'N' && matchRows.length > 0) {
        const prev = [...matchRows].reverse().find((r) => r < top) ?? matchRows[matchRows.length - 1];
        scrollTo(prev);
      }
    },
    { isActive },
  );

  const visible = all.slice(top, top + rows);
  const scrollable = indicator && all.length > rows;
  const thumb = scrollable ? scrollbarThumb(all.length, rows, top) : [];
  const pct = maxTop === 0 ? 100 : Math.round((top / maxTop) * 100);
  const thumbChar = ascii ? '#' : '┃';
  const trackChar = ascii ? '|' : '│';

  return (
    <Box flexDirection="row" width={width} height={rows}>
      <Box flexDirection="column" width={textWidth} height={rows} overflow="hidden">
        {visible.map((l, i) => {
          const raw = highlight ? highlightLine(l, highlight) : l || ' ';
          const cell = ascii && displayWidth(raw) > textWidth ? truncateDisplay(raw, textWidth, '...') : raw;
          return (
            <Box key={top + i} height={1} overflow="hidden">
              <Text wrap={ascii ? undefined : 'truncate-end'}>{cell}</Text>
            </Box>
          );
        })}
      </Box>
      {indicator ? (
        <Box flexDirection="column" width={1} height={rows}>
          {scrollable
            ? thumb.map((on, i) => (
                <Text key={i} color={on ? (isActive ? theme.primary : theme.muted) : theme.border}>
                  {on ? thumbChar : trackChar}
                </Text>
              ))
            : null}
        </Box>
      ) : null}
      {scrollable && rows >= 3 ? (
        <Box position="absolute" left={Math.max(0, width - 5)} top={rows - 1}>
          <Text color={theme.dim} backgroundColor={theme.surface}>{`${String(pct).padStart(3)}%`}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
