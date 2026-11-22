import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { useTuiStore } from '../state/store.js';

export interface VirtualListRenderContext {
  index: number;
  selected: boolean;
  /** Row content width (excludes scrollbar column). */
  width: number;
  /** Whether the list itself has keyboard focus. */
  focused: boolean;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Visible rows (each item renders as exactly ONE terminal row). */
  height: number;
  width: number;
  renderItem: (item: T, ctx: VirtualListRenderContext) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  /** Controlled selection. Omit for uncontrolled. */
  selectedIndex?: number;
  initialIndex?: number;
  onChange?: (index: number, item: T | undefined) => void;
  onSelect?: (item: T, index: number) => void;
  /** Keyboard focus (useInput isActive). */
  isActive?: boolean;
  emptyText?: string;
  emptyHint?: string;
  showScrollbar?: boolean;
  /** Paint the default selection highlight row background (default true). */
  highlightSelected?: boolean;
  /** Keep this many rows of context above/below the cursor while scrolling. */
  scrollPadding?: number;
  /** Override store asciiMode preference (`#` / `|` scrollbar when true). */
  ascii?: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Compute half-page or full-page step for a viewport of `height` rows. */
export function pageStep(height: number, mode: 'half' | 'full'): number {
  const h = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
  return mode === 'half' ? Math.max(1, Math.floor(h / 2)) : Math.max(1, h - 1);
}

/** Pure scrollbar geometry: returns per-row thumb flags. Exported for tests. */
export function scrollbarThumb(total: number, height: number, offset: number): boolean[] {
  const rows = new Array<boolean>(Math.max(0, height)).fill(false);
  if (total <= height || height <= 0) return rows;
  const size = Math.max(1, Math.round((height * height) / total));
  const maxOffset = total - height;
  const start = Math.round(((height - size) * offset) / Math.max(1, maxOffset));
  for (let i = start; i < start + size && i < height; i += 1) rows[i] = true;
  return rows;
}

/** Keep `index` visible inside a window of `height` rows starting at `offset`. */
export function nextScrollOffset(index: number, offset: number, height: number, total: number, padding = 1): number {
  if (total <= height) return 0;
  const pad = Math.min(padding, Math.floor((height - 1) / 2));
  let next = offset;
  if (index < next + pad) next = index - pad;
  if (index > next + height - 1 - pad) next = index - height + 1 + pad;
  return clamp(next, 0, total - height);
}

function VirtualListInner<T>({
  items,
  height,
  width,
  renderItem,
  keyExtractor,
  selectedIndex,
  initialIndex = 0,
  onChange,
  onSelect,
  isActive = true,
  emptyText = '暂无内容',
  emptyHint,
  showScrollbar = true,
  highlightSelected = true,
  scrollPadding = 1,
  ascii: asciiProp,
}: VirtualListProps<T>) {
  const theme = useTheme();
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const total = items.length;
  const rows = Math.max(1, height);
  const controlled = selectedIndex !== undefined;
  const [internal, setInternal] = useState(() => clamp(initialIndex, 0, Math.max(0, total - 1)));
  const cursor = clamp(controlled ? (selectedIndex as number) : internal, 0, Math.max(0, total - 1));
  const offsetRef = useRef(0);
  const offset = nextScrollOffset(cursor, offsetRef.current, rows, total, scrollPadding);
  offsetRef.current = offset;

  // Keep uncontrolled cursor in range when the list shrinks.
  useEffect(() => {
    if (!controlled && internal > Math.max(0, total - 1)) setInternal(Math.max(0, total - 1));
  }, [controlled, internal, total]);

  const move = useCallback(
    (to: number) => {
      if (total === 0) return;
      const next = clamp(to, 0, total - 1);
      if (next === cursor) return;
      if (!controlled) setInternal(next);
      onChange?.(next, items[next]);
    },
    [total, cursor, controlled, onChange, items],
  );

  useInput(
    (input, key) => {
      if (total === 0) return;
      if (key.ctrl && input === 'd') move(cursor + pageStep(rows, 'half'));
      else if (key.ctrl && input === 'u') move(cursor - pageStep(rows, 'half'));
      else if (key.pageDown || (key.ctrl && input === 'f')) move(cursor + pageStep(rows, 'full'));
      else if (key.pageUp || (key.ctrl && input === 'b')) move(cursor - pageStep(rows, 'full'));
      else if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) move(cursor + 1);
      else if (key.upArrow || (!key.ctrl && !key.meta && input === 'k')) move(cursor - 1);
      else if (key.home || (!key.ctrl && !key.meta && input === 'g')) move(0);
      else if (key.end || (!key.ctrl && !key.meta && input === 'G')) move(total - 1);
      else if (key.return) {
        const item = items[cursor];
        if (item !== undefined) onSelect?.(item, cursor);
      }
    },
    { isActive },
  );

  const scrollable = showScrollbar && total > rows;
  const contentWidth = Math.max(1, width - (scrollable ? 1 : 0));
  const thumb = useMemo(() => (scrollable ? scrollbarThumb(total, rows, offset) : []), [scrollable, total, rows, offset]);
  const thumbChar = ascii ? '#' : '┃';
  const trackChar = ascii ? '|' : '│';

  if (total === 0) {
    return (
      <Box width={width} height={rows} flexDirection="column" alignItems="center" justifyContent="center">
        <Text color={theme.muted}>{emptyText}</Text>
        {emptyHint && rows > 1 ? <Text color={theme.dim}>{emptyHint}</Text> : null}
      </Box>
    );
  }

  const visible = items.slice(offset, offset + rows);
  return (
    <Box width={width} height={rows} flexDirection="row">
      <Box flexDirection="column" width={contentWidth} height={rows} overflow="hidden">
        {visible.map((item, i) => {
          const index = offset + i;
          const selected = index === cursor;
          const key = keyExtractor ? keyExtractor(item, index) : String(index);
          return (
            <Box
              key={key}
              height={1}
              width={contentWidth}
              overflow="hidden"
              backgroundColor={selected && highlightSelected ? (isActive ? theme.selectionBg : theme.surface) : undefined}
            >
              {renderItem(item, { index, selected, width: contentWidth, focused: isActive })}
            </Box>
          );
        })}
      </Box>
      {scrollable ? (
        <Box flexDirection="column" width={1} height={rows}>
          {thumb.map((on, i) => (
            <Text key={i} color={on ? (isActive ? theme.primary : theme.muted) : theme.border}>
              {on ? thumbChar : trackChar}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/** Windowed list — renders only `height` rows regardless of item count. */
export const VirtualList = memo(VirtualListInner) as <T>(props: VirtualListProps<T>) => React.JSX.Element;
