import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { t, useTuiStore } from '../state/store.js';
import { KEY_LAYER_WIDGET, useScopedInput } from './key-dispatcher.js';
import { useClickRegion, useSgrWheelTap } from './mouse.js';

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
  /** Opt in to Vim `g` (top) / `G` (bottom) jump keys. Default false so page shortcuts like `g` never conflict (#1349). */
  vimJumpKeys?: boolean;
  /** Enable Vim `j` / `k` navigation keys in addition to arrow keys. Set false when parent binds `j` or `k` (#1385). */
  vimNavKeys?: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const SGR_MOUSE_CHUNK_RE = /^(?:(?:\u001b+\[|\[)?<\d+;\d+;\d+[Mm])+$/;
const SGR_MOUSE_TOKEN_RE = /(?:\u001b+\[|\[)?<(\d+);\d+;\d+([Mm])/g;

/**
 * Parse SGR 1006 mouse wheel sequences (intact `\x1b[<64;c;rM` or ESC-stripped `[<64;c;rM` / `<64;c;rM`)
 * into a signed row delta; returns 0 for non-wheel mouse events, releases (`m`), or ordinary text.
 */
export function parseSgrWheelDelta(input: string, step = 3): number {
  if (!input || !input.includes('<') || !SGR_MOUSE_CHUNK_RE.test(input)) return 0;
  const unit = Number.isFinite(step) && step > 0 ? Math.floor(step) : 3;
  const maxBurst = unit * 8;
  let delta = 0;
  SGR_MOUSE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE_TOKEN_RE.exec(input)) !== null) {
    if (match[2] !== 'M') continue;
    const button = Number.parseInt(match[1], 10);
    const code = button & 0x43;
    if (code === 64) delta -= unit;
    else if (code === 65) delta += unit;
  }
  return delta === 0 ? 0 : clamp(delta, -maxBurst, maxBurst);
}

/**
 * Subscribe to intact SGR 1006 mouse wheel events on Ink's `stdin` stream before
 * Ink's `App` CSI filter drops complete non-Kitty control sequences (`key.name === ''`).
 * Delegates to the unified per-stdin mouse tap in `mouse.tsx`.
 */
export function useSgrMouseWheel(isActive: boolean, onWheel: (delta: number) => void): void {
  useSgrWheelTap(isActive, onWheel);
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

interface VirtualListRowProps<T> {
  item: T;
  index: number;
  selected: boolean;
  width: number;
  focused: boolean;
  backgroundColor: string | undefined;
  renderItem: (item: T, ctx: VirtualListRenderContext) => ReactNode;
}

function VirtualListRowInner<T>({
  item,
  index,
  selected,
  width,
  focused,
  backgroundColor,
  renderItem,
}: VirtualListRowProps<T>) {
  return (
    <Box height={1} width={width} overflow="hidden" backgroundColor={backgroundColor}>
      {renderItem(item, { index, selected, width, focused })}
    </Box>
  );
}

/**
 * Memoized single list row (Round 85 Track A4 — partial list refresh):
 * Moving cursor within a window only re-invokes `renderItem` for the 2 rows whose
 * `selected`/`backgroundColor` changed, skipping every unchanged visible row.
 */
const VirtualListRow = memo(VirtualListRowInner, (prev, next) => {
  return (
    prev.item === next.item &&
    prev.index === next.index &&
    prev.selected === next.selected &&
    prev.width === next.width &&
    prev.focused === next.focused &&
    prev.backgroundColor === next.backgroundColor &&
    prev.renderItem === next.renderItem
  );
}) as <T>(props: VirtualListRowProps<T>) => React.JSX.Element;

interface ScrollbarColumnProps {
  thumb: readonly boolean[];
  height: number;
  active: boolean;
  primaryColor: string;
  mutedColor: string;
  borderColor: string;
  thumbChar: string;
  trackChar: string;
}

const ScrollbarColumn = memo(function ScrollbarColumn({
  thumb,
  height,
  active,
  primaryColor,
  mutedColor,
  borderColor,
  thumbChar,
  trackChar,
}: ScrollbarColumnProps) {
  return (
    <Box flexDirection="column" width={1} height={height}>
      {thumb.map((on, i) => (
        <Text key={i} color={on ? (active ? primaryColor : mutedColor) : borderColor}>
          {on ? thumbChar : trackChar}
        </Text>
      ))}
    </Box>
  );
});

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
  emptyText,
  emptyHint,
  showScrollbar = true,
  highlightSelected = true,
  scrollPadding = 1,
  ascii: asciiProp,
  vimJumpKeys = false,
  vimNavKeys = true,
}: VirtualListProps<T>) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const storeAscii = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ascii = asciiProp ?? storeAscii;
  const resolvedEmptyText = emptyText ?? t(lang, '暂无内容', 'No items');
  const total = items.length;
  const rows = Math.max(1, height);
  const controlled = selectedIndex !== undefined;
  const [internal, setInternal] = useState(() => clamp(initialIndex, 0, Math.max(0, total - 1)));
  const cursor = clamp(controlled ? (selectedIndex as number) : internal, 0, Math.max(0, total - 1));
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
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
      if (next === cursorRef.current) return;
      cursorRef.current = next;
      if (!controlled) setInternal(next);
      onChange?.(next, items[next]);
    },
    [total, controlled, onChange, items],
  );

  useSgrMouseWheel(isActive && total > 0, (wheelDelta) => {
    move(cursorRef.current + wheelDelta);
  });

  const listRef = useRef<DOMElement | null>(null);
  useClickRegion(
    listRef,
    (ev) => {
      const idx = offsetRef.current + ev.localY;
      if (idx < 0 || idx >= total) return;
      if (idx === cursorRef.current) {
        const item = items[idx];
        if (item !== undefined) onSelect?.(item, idx);
      } else {
        move(idx);
      }
    },
    { active: isActive && total > 0 },
  );

  useScopedInput(
    (input, key) => {
      if (total === 0) return false;
      const wheelDelta = parseSgrWheelDelta(input);
      if (wheelDelta !== 0) {
        move(cursorRef.current + wheelDelta);
        return true;
      }
      if (key.ctrl && input === 'd') { move(cursor + pageStep(rows, 'half')); return true; }
      if (key.ctrl && input === 'u') { move(cursor - pageStep(rows, 'half')); return true; }
      if (key.pageDown || (key.ctrl && input === 'f')) { move(cursor + pageStep(rows, 'full')); return true; }
      if (key.pageUp || (key.ctrl && input === 'b')) { move(cursor - pageStep(rows, 'full')); return true; }
      if (key.downArrow || (vimNavKeys && !key.ctrl && !key.meta && input === 'j')) { move(cursor + 1); return true; }
      if (key.upArrow || (vimNavKeys && !key.ctrl && !key.meta && input === 'k')) { move(cursor - 1); return true; }
      if (key.home || (vimJumpKeys && !key.ctrl && !key.meta && input === 'g')) { move(0); return true; }
      if (key.end || (vimJumpKeys && !key.ctrl && !key.meta && input === 'G')) { move(total - 1); return true; }
      if (key.return) {
        const item = items[cursor];
        if (item !== undefined && onSelect) {
          onSelect(item, cursor);
          return true;
        }
      }
      return false;
    },
    { isActive, layer: KEY_LAYER_WIDGET, id: 'VirtualList' },
  );

  const scrollable = showScrollbar && total > rows;
  const contentWidth = Math.max(1, width - (scrollable ? 1 : 0));
  const thumb = useMemo(() => (scrollable ? scrollbarThumb(total, rows, offset) : []), [scrollable, total, rows, offset]);
  const thumbChar = ascii ? '#' : '┃';
  const trackChar = ascii ? '|' : '│';

  if (total === 0) {
    return (
      <Box width={width} height={rows} flexDirection="column" alignItems="center" justifyContent="center">
        <Text color={theme.muted}>{resolvedEmptyText}</Text>
        {emptyHint && rows > 1 ? <Text color={theme.dim}>{emptyHint}</Text> : null}
      </Box>
    );
  }

  const visible = items.slice(offset, offset + rows);
  const selectedBg = highlightSelected ? (isActive ? theme.selectionBg : theme.surface) : undefined;
  return (
    <Box width={width} height={rows} flexDirection="row">
      <Box ref={listRef} flexDirection="column" width={contentWidth} height={rows} overflow="hidden">
        {visible.map((item, i) => {
          const index = offset + i;
          const selected = index === cursor;
          const key = keyExtractor ? keyExtractor(item, index) : String(index);
          return (
            <VirtualListRow
              key={key}
              item={item}
              index={index}
              selected={selected}
              width={contentWidth}
              focused={isActive}
              backgroundColor={selected ? selectedBg : undefined}
              renderItem={renderItem}
            />
          );
        })}
      </Box>
      {scrollable ? (
        <ScrollbarColumn
          thumb={thumb}
          height={rows}
          active={isActive}
          primaryColor={theme.primary}
          mutedColor={theme.muted}
          borderColor={theme.border}
          thumbChar={thumbChar}
          trackChar={trackChar}
        />
      ) : null}
    </Box>
  );
}

/** Windowed list — renders only `height` rows regardless of item count. */
export const VirtualList = memo(VirtualListInner) as <T>(props: VirtualListProps<T>) => React.JSX.Element;
