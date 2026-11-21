import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { displayWidth } from '../render/index.js';
import { useInputCapture } from './focus.js';

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter (single-line) / Ctrl+S or Alt+Enter (multi-line). */
  onSubmit?: (value: string) => void;
  /** Esc. */
  onCancel?: () => void;
  placeholder?: string;
  /** Keyboard focus. While focused, global shortcuts are suppressed (store.inputCaptured). */
  isActive?: boolean;
  /** Visible width in columns (excluding prompt). */
  width?: number;
  /** Multi-line mode: Enter inserts newline. */
  multiline?: boolean;
  /** Visible rows in multi-line mode (default 4). */
  height?: number;
  /** In multi-line mode, submit on Enter instead (Shift-less terminals: use Alt+Enter for newline). */
  submitOnEnter?: boolean;
  /** Masked mode for secrets: true → '•', or a custom mask character. */
  mask?: boolean | string;
  /** Tab completion: return the completed value (or undefined to ignore). */
  onTab?: (value: string, cursor: number) => string | undefined | void;
  /** Optional prompt glyph shown before the field (e.g. '›'). */
  prompt?: string;
  maxLength?: number;
  /** Set false to NOT mark input as captured (rare: e.g. palette search that still wants Esc routing). */
  captureInput?: boolean;
}

function chars(s: string): string[] {
  return Array.from(s);
}

const WORD_SEP = /[\s,.;:!?，。；：！？、/\\()[\]{}"'`-]/;

function prevWordIndex(cs: string[], cursor: number): number {
  let i = cursor;
  while (i > 0 && WORD_SEP.test(cs[i - 1])) i -= 1;
  while (i > 0 && !WORD_SEP.test(cs[i - 1])) i -= 1;
  return i;
}

function nextWordIndex(cs: string[], cursor: number): number {
  let i = cursor;
  while (i < cs.length && WORD_SEP.test(cs[i])) i += 1;
  while (i < cs.length && !WORD_SEP.test(cs[i])) i += 1;
  return i;
}

/** Position of cursor inside a list of lines → {row, col} in code points. */
function cursorRowCol(cs: string[], cursor: number): { row: number; col: number } {
  let row = 0;
  let col = 0;
  for (let i = 0; i < cursor && i < cs.length; i += 1) {
    if (cs[i] === '\n') {
      row += 1;
      col = 0;
    } else col += 1;
  }
  return { row, col };
}

function indexFromRowCol(cs: string[], row: number, col: number): number {
  let r = 0;
  let i = 0;
  while (i < cs.length && r < row) {
    if (cs[i] === '\n') r += 1;
    i += 1;
  }
  let c = 0;
  while (i < cs.length && cs[i] !== '\n' && c < col) {
    i += 1;
    c += 1;
  }
  return i;
}

/** Choose a horizontal window [start, end) over `cells` so that `cursor` is visible within `width` columns. */
function hWindow(cells: string[], cursor: number, width: number, prevStart: number): { start: number; end: number } {
  const w = (c: string | undefined) => (c === undefined ? 1 : Math.max(1, displayWidth(c)));
  let start = Math.min(prevStart, cursor);
  // ensure cursor cell (or trailing caret) fits
  const fits = (s: number) => {
    let used = 0;
    for (let i = s; i <= cursor; i += 1) used += w(cells[i]);
    return used <= width;
  };
  while (start < cursor && !fits(start)) start += 1;
  let used = 0;
  let end = start;
  while (end < cells.length && used + w(cells[end]) <= width) {
    used += w(cells[end]);
    end += 1;
  }
  return { start, end };
}

export const TextInput = memo(function TextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = '',
  isActive = true,
  width = 40,
  multiline = false,
  height = 4,
  submitOnEnter = false,
  mask,
  onTab,
  prompt,
  maxLength,
  captureInput = true,
}: TextInputProps) {
  const theme = useTheme();
  useInputCapture(isActive && captureInput);

  const [cursor, setCursor] = useState(() => chars(value).length);
  const lastValue = useRef(value);
  const hStart = useRef(0);
  const vStart = useRef(0);

  // External value change → clamp / move cursor to end.
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setCursor(chars(value).length);
    }
  }, [value]);

  const commit = useCallback(
    (next: string, nextCursor: number) => {
      let v = next;
      if (!multiline) v = v.replace(/\r?\n/g, ' ');
      if (maxLength !== undefined && chars(v).length > maxLength) v = chars(v).slice(0, maxLength).join('');
      lastValue.current = v;
      setCursor(Math.min(nextCursor, chars(v).length));
      if (v !== value) onChange(v);
    },
    [multiline, maxLength, onChange, value],
  );

  const insert = useCallback(
    (text: string) => {
      const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      if (!clean) return;
      const cs = chars(value);
      const at = Math.min(cursor, cs.length);
      const ins = chars(clean);
      commit([...cs.slice(0, at), ...ins, ...cs.slice(at)].join(''), at + ins.length);
    },
    [value, cursor, commit],
  );

  usePaste((text) => insert(text), { isActive });

  useInput(
    (input, key) => {
      const cs = chars(value);
      const at = Math.min(cursor, cs.length);
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        if (!multiline || submitOnEnter !== Boolean(key.meta)) {
          onSubmit?.(value);
        } else {
          insert('\n');
        }
        return;
      }
      if (key.ctrl && input === 's' && multiline) {
        onSubmit?.(value);
        return;
      }
      if (key.tab) {
        if (onTab) {
          const completed = onTab(value, at);
          if (typeof completed === 'string') commit(completed, chars(completed).length);
        }
        return;
      }
      if (key.backspace) {
        if (at === 0) return;
        const from = key.meta ? prevWordIndex(cs, at) : at - 1;
        commit([...cs.slice(0, from), ...cs.slice(at)].join(''), from);
        return;
      }
      if (key.delete) {
        if (at >= cs.length) return;
        commit([...cs.slice(0, at), ...cs.slice(at + 1)].join(''), at);
        return;
      }
      if (key.leftArrow) {
        setCursor(key.meta || key.ctrl ? prevWordIndex(cs, at) : Math.max(0, at - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(key.meta || key.ctrl ? nextWordIndex(cs, at) : Math.min(cs.length, at + 1));
        return;
      }
      if (multiline && (key.upArrow || key.downArrow)) {
        const { row, col } = cursorRowCol(cs, at);
        const target = key.upArrow ? row - 1 : row + 1;
        if (target >= 0) setCursor(indexFromRowCol(cs, target, col));
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        if (multiline) {
          const { row } = cursorRowCol(cs, at);
          setCursor(indexFromRowCol(cs, row, 0));
        } else setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        if (multiline) {
          const { row } = cursorRowCol(cs, at);
          setCursor(indexFromRowCol(cs, row, Number.MAX_SAFE_INTEGER));
        } else setCursor(cs.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        commit(cs.slice(at).join(''), 0);
        return;
      }
      if (key.ctrl && input === 'k') {
        commit(cs.slice(0, at).join(''), at);
        return;
      }
      if (key.ctrl && input === 'w') {
        const from = prevWordIndex(cs, at);
        commit([...cs.slice(0, from), ...cs.slice(at)].join(''), from);
        return;
      }
      if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
      if (input) insert(input);
    },
    { isActive },
  );

  const maskChar = mask === true ? '•' : typeof mask === 'string' && mask ? mask : null;
  const promptEl = prompt ? <Text color={isActive ? theme.primary : theme.muted}>{`${prompt} `}</Text> : null;
  const fieldWidth = Math.max(1, width);

  if (value.length === 0) {
    return (
      <Box width={fieldWidth + (prompt ? displayWidth(prompt) + 1 : 0)} height={multiline ? height : 1}>
        {promptEl}
        <Text>
          {isActive ? <Text inverse>{placeholder ? chars(placeholder)[0] : ' '}</Text> : null}
          <Text color={theme.dim}>{isActive ? chars(placeholder).slice(1).join('') : placeholder}</Text>
        </Text>
      </Box>
    );
  }

  const cs = chars(value);
  const at = Math.min(cursor, cs.length);
  const display = maskChar ? cs.map((c) => (c === '\n' ? c : maskChar)) : cs;

  if (!multiline) {
    const win = hWindow(display, at, fieldWidth, hStart.current);
    hStart.current = win.start;
    const before = display.slice(win.start, at).join('');
    const atChar = at < display.length ? display[at] : ' ';
    const after = display.slice(at + 1, win.end).join('');
    return (
      <Box height={1}>
        {promptEl}
        <Text color={theme.text} wrap="truncate">
          {win.start > 0 ? <Text color={theme.dim}>‹</Text> : null}
          {win.start > 0 ? chars(before).slice(1).join('') : before}
          {isActive ? <Text inverse>{atChar}</Text> : at < display.length ? atChar : ''}
          {after}
        </Text>
      </Box>
    );
  }

  // multi-line
  const lines: string[][] = [[]];
  for (const c of display) {
    if (c === '\n') lines.push([]);
    else lines[lines.length - 1].push(c);
  }
  const { row: curRow, col: curCol } = cursorRowCol(cs, at);
  const rows = Math.max(1, height);
  let vs = vStart.current;
  if (curRow < vs) vs = curRow;
  if (curRow >= vs + rows) vs = curRow - rows + 1;
  vs = Math.max(0, Math.min(vs, Math.max(0, lines.length - rows)));
  vStart.current = vs;

  return (
    <Box flexDirection="column" height={rows}>
      {lines.slice(vs, vs + rows).map((line, i) => {
        const r = vs + i;
        const isCurRow = r === curRow;
        const win = hWindow(line, isCurRow ? curCol : 0, fieldWidth, 0);
        if (!isCurRow || !isActive) {
          return (
            <Box key={r} height={1}>
              {i === 0 ? promptEl : prompt ? <Text>{' '.repeat(displayWidth(prompt) + 1)}</Text> : null}
              <Text color={theme.text}>{line.slice(win.start, win.end).join('') || ' '}</Text>
            </Box>
          );
        }
        return (
          <Box key={r} height={1}>
            {i === 0 ? promptEl : prompt ? <Text>{' '.repeat(displayWidth(prompt) + 1)}</Text> : null}
            <Text color={theme.text}>
              {line.slice(win.start, curCol).join('')}
              <Text inverse>{curCol < line.length ? line[curCol] : ' '}</Text>
              {line.slice(curCol + 1, win.end).join('')}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});
