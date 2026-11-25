import React, { memo, useCallback, useRef, useState } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { t, useTuiStore } from '../state/store.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { DIGIT_KEYS, useClaimKeys } from './focus.js';
import { KEY_LAYER_WIDGET, useScopedInput } from './key-dispatcher.js';
import { nextScrollOffset, pageStep, parseSgrWheelDelta, useSgrMouseWheel } from './VirtualList.js';
import { useClickRegion } from './mouse.js';

export interface SelectOption<V = string> {
  value: V;
  label: string;
  /** Dim secondary text after the label. */
  hint?: string;
  /** Right-aligned badge. */
  badge?: string | number;
  badgeTone?: Tone;
  disabled?: boolean;
  /** Optional leading icon. */
  icon?: string;
}

export interface SelectListProps<V = string> {
  options: readonly SelectOption<V>[];
  onSelect: (option: SelectOption<V>, index: number) => void;
  onChange?: (option: SelectOption<V>, index: number) => void;
  /** Controlled cursor. */
  selectedIndex?: number;
  initialIndex?: number;
  isActive?: boolean;
  width?: number;
  /** Max visible rows (windowed). */
  maxHeight?: number;
  /** `1`-`9` jump-and-select shortcuts (default true). Claims digit keys from AppShell while active. */
  numberShortcuts?: boolean;
  /** Mark the option whose value equals `currentValue` with ✓. */
  currentValue?: V;
  emptyText?: string;
  /** Opt in to Vim `g` (top) / `G` (bottom) jump keys. Default false so parent shortcuts never conflict (#1375). */
  vimJumpKeys?: boolean;
}

function SelectListInner<V>({
  options,
  onSelect,
  onChange,
  selectedIndex,
  initialIndex = 0,
  isActive = true,
  width = 40,
  maxHeight,
  numberShortcuts = true,
  currentValue,
  emptyText,
  vimJumpKeys = false,
}: SelectListProps<V>) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const resolvedEmptyText = emptyText ?? t(lang, '没有可选项', 'No options');
  const total = options.length;
  const controlled = selectedIndex !== undefined;
  const [internal, setInternal] = useState(initialIndex);
  const cursor = Math.max(0, Math.min(controlled ? (selectedIndex as number) : internal, total - 1));
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const offsetRef = useRef(0);
  const rows = Math.max(1, Math.min(maxHeight ?? total, total));
  const off = nextScrollOffset(cursor, offsetRef.current, rows, total, 1);
  offsetRef.current = off;

  useClaimKeys(DIGIT_KEYS, isActive && numberShortcuts);

  const step = useCallback(
    (from: number, dir: 1 | -1): number => {
      for (let i = 1; i <= total; i += 1) {
        const idx = (from + dir * i + total * 2) % total;
        if (!options[idx]?.disabled) return idx;
      }
      return from;
    },
    [options, total],
  );

  const stepClamped = useCallback(
    (from: number, delta: number): number => {
      if (total === 0 || delta === 0) return from;
      const dir: 1 | -1 = delta > 0 ? 1 : -1;
      let cur = Math.max(0, Math.min(from, total - 1));
      let remaining = Math.abs(delta);
      while (remaining > 0) {
        let next = cur + dir;
        while (next >= 0 && next < total && options[next]?.disabled) {
          next += dir;
        }
        if (next < 0 || next >= total) break;
        cur = next;
        remaining -= 1;
      }
      return cur;
    },
    [options, total],
  );

  const moveTo = useCallback(
    (idx: number) => {
      cursorRef.current = idx;
      if (!controlled) setInternal(idx);
      const opt = options[idx];
      if (opt) onChange?.(opt, idx);
    },
    [controlled, onChange, options],
  );

  useSgrMouseWheel(isActive && total > 0, (delta) => {
    const next = stepClamped(cursorRef.current, delta);
    if (next !== cursorRef.current) moveTo(next);
  });

  const rowsRef = useRef<DOMElement | null>(null);
  useClickRegion(
    rowsRef,
    (ev) => {
      const idx = offsetRef.current + ev.localY;
      if (idx < 0 || idx >= total) return;
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      if (idx === cursorRef.current) {
        onSelect(opt, idx);
      } else {
        moveTo(idx);
      }
    },
    { active: isActive && total > 0 },
  );

  useScopedInput(
    (input, key) => {
      if (total === 0) return false;
      const wheelDelta = parseSgrWheelDelta(input);
      if (wheelDelta !== 0) {
        const next = stepClamped(cursorRef.current, wheelDelta);
        if (next !== cursorRef.current) moveTo(next);
        return true;
      }
      if (key.pageDown || (key.ctrl && input === 'd')) {
        const next = stepClamped(cursor, pageStep(rows, 'half'));
        if (next !== cursor) moveTo(next);
        return true;
      }
      if (key.pageUp || (key.ctrl && input === 'u')) {
        const next = stepClamped(cursor, -pageStep(rows, 'half'));
        if (next !== cursor) moveTo(next);
        return true;
      }
      if (key.downArrow || (!key.ctrl && !key.meta && input === 'j') || (key.tab && !key.shift)) {
        moveTo(step(cursor, 1));
        return true;
      }
      if (key.upArrow || (!key.ctrl && !key.meta && input === 'k') || (key.tab && key.shift)) {
        moveTo(step(cursor, -1));
        return true;
      }
      if (key.home || (vimJumpKeys && !key.ctrl && !key.meta && input === 'g')) {
        moveTo(0);
        return true;
      }
      if (key.end || (vimJumpKeys && !key.ctrl && !key.meta && input === 'G')) {
        moveTo(total - 1);
        return true;
      }
      if (key.return) {
        const opt = options[cursor];
        if (opt && !opt.disabled) onSelect(opt, cursor);
        return true;
      }
      if (numberShortcuts && /^[1-9]$/.test(input)) {
        const idx = Number(input) - 1;
        const opt = options[idx];
        if (opt && !opt.disabled) {
          moveTo(idx);
          onSelect(opt, idx);
          return true;
        }
      }
      return false;
    },
    { isActive, layer: KEY_LAYER_WIDGET, id: 'SelectList' },
  );

  if (total === 0) return <Text color={theme.muted}>{resolvedEmptyText}</Text>;

  return (
    <Box flexDirection="column" width={width}>
      {off > 0 ? <Text color={theme.dim}>{`  ${asciiMode ? '^' : '↑'} ${off}`}</Text> : null}
      <Box ref={rowsRef} flexDirection="column" width={width}>
        {options.slice(off, off + rows).map((opt, i) => {
          const idx = off + i;
          const active = idx === cursor;
          const num = numberShortcuts && idx < 9 ? `${idx + 1}` : ' ';
          const badgeText = opt.badge !== undefined && opt.badge !== '' ? ` ${opt.badge} ` : '';
          const isCurrent = currentValue !== undefined && opt.value === currentValue;
          const lead = `${active ? (asciiMode ? '>' : '❯') : ' '} ${num} ${opt.icon ? `${opt.icon} ` : ''}`;
          const tail = `${isCurrent ? (asciiMode ? ' *' : ' ✓') : ''}`;
          const avail = Math.max(1, width - displayWidth(lead) - displayWidth(badgeText) - displayWidth(tail) - 1);
          const label = truncateDisplay(opt.label, avail, ell);
          const hint = opt.hint ? truncateDisplay(`  ${opt.hint}`, Math.max(0, avail - displayWidth(label)), ell) : '';
          const fg = opt.disabled ? theme.dim : active ? (isActive ? theme.selectionFg : theme.text) : theme.text;
          return (
            <Box key={idx} height={1} width={width} backgroundColor={active ? (isActive ? theme.selectionBg : theme.surface) : undefined}>
              <Box flexGrow={1} overflow="hidden">
                <Text>
                  <Text color={active ? theme.primary : theme.dim}>{lead}</Text>
                  <Text color={fg} bold={active}>
                    {label}
                  </Text>
                  {hint ? <Text color={theme.muted}>{hint}</Text> : null}
                  {isCurrent ? <Text color={theme.success}>{tail}</Text> : null}
                </Text>
              </Box>
              {badgeText ? (
                <Text color={toneColor(theme, opt.badgeTone ?? 'accent')} backgroundColor={theme.surface}>
                  {badgeText}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {off + rows < total ? <Text color={theme.dim}>{`  ${asciiMode ? 'v' : '↓'} ${total - off - rows}`}</Text> : null}
    </Box>
  );
}

export const SelectList = memo(SelectListInner) as <V = string>(props: SelectListProps<V>) => React.JSX.Element;
