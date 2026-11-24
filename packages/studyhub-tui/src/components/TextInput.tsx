import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, usePaste, type DOMElement } from 'ink';
import stripAnsi from 'strip-ansi';
import { useTheme } from '../theme/tokens.js';
import { displayWidth, splitGraphemes } from '../render/cjk.js';
import { useTuiStore } from '../state/store.js';
import { normalizeAsciiChrome } from './Badge.js';
import { useInputCapture } from './focus.js';
import { ImeCursorAnchor } from './ime-cursor.js';
import { KEY_LAYER_TEXT_INPUT, useScopedInput } from './key-dispatcher.js';
import { isSgrMouseSequence, stripSgrMouseSequences } from './mouse.js';

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

/**
 * Sanitize raw pasted or chunked input from Windows ConPTY / PowerShell / Kitty / WezTerm / Ghostty.
 * Strips bracketed-paste wrappers (including split/orphaned `200~`/`201~` markers), ANSI escapes,
 * and orphaned CSI-u / modifyOtherKeys tails, normalizes CRLF/CR line endings, removes control
 * characters, and flattens newlines in single-line mode.
 */
export function sanitizePastedText(raw: string, opts?: { multiline?: boolean }): string {
  const multiline = opts?.multiline ?? false;
  let clean = stripSgrMouseSequences(raw);
  clean = clean.replace(/\u001b\[[0-9;:]*[u~]/g, '');
  clean = stripAnsi(clean).replace(/\u001b\[?$/g, '');
  clean = stripSgrMouseSequences(clean);
  clean = clean
    .replace(/\[(?:\d+(?:[:;]\d*)*)[u~]/g, '')
    .replace(/(?<![A-Za-z0-9])\d+(?::\d*)*;\d+(?:[:;]\d*)*[u~]/g, '');
  clean = clean.replace(/^(?:20[01]~)+/, '').replace(/(?:20[01]~)+$/, '');
  clean = clean.replace(/\r\n?/g, '\n');
  clean = clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!multiline) {
    clean = clean.replace(/\n+/g, ' ');
  }
  return clean;
}

const ORPHAN_SHIFT_ENTER_RE = /^\[?(?:13;2(?::[12])?u|27;2;13~)$/;
const ORPHAN_CTRL_ENTER_RE = /^\[?(?:13;5(?::[12])?u|27;5;13~)$/;

function chars(s: string): string[] {
  return splitGraphemes(s);
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
  // If the entire string + trailing cursor fits within width, never stay scrolled right.
  let totalWidth = cursor >= cells.length ? 1 : 0;
  for (let i = 0; i < cells.length; i += 1) totalWidth += w(cells[i]);
  if (totalWidth <= width) {
    return { start: 0, end: cells.length };
  }
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
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  useInputCapture(isActive && captureInput);

  const [cursor, setCursor] = useState(() => chars(value).length);
  const lastValue = useRef(value);
  const hStart = useRef(0);
  const vStart = useRef(0);
  const rootRef = useRef<DOMElement>(null);

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
    (clean: string) => {
      if (!clean) return;
      const cs = chars(value);
      const at = Math.min(cursor, cs.length);
      const ins = chars(clean);
      commit([...cs.slice(0, at), ...ins, ...cs.slice(at)].join(''), at + ins.length);
    },
    [value, cursor, commit],
  );

  usePaste((text) => insert(sanitizePastedText(text, { multiline })), { isActive });

  useScopedInput(
    (input, key) => {
      if (key.eventType === 'release') return false;
      if (input && isSgrMouseSequence(input)) return false;
      const cs = chars(value);
      const at = Math.min(cursor, cs.length);
      if (key.escape) {
        if (onCancel) {
          onCancel();
          return true;
        }
        return false;
      }
      if (key.return) {
        if (key.ctrl) {
          onSubmit?.(value);
        } else if (multiline && (key.shift || submitOnEnter === Boolean(key.meta))) {
          insert('\n');
        } else {
          onSubmit?.(value);
        }
        return true;
      }
      if (multiline && ORPHAN_SHIFT_ENTER_RE.test(input)) {
        insert('\n');
        return true;
      }
      if (multiline && ORPHAN_CTRL_ENTER_RE.test(input)) {
        onSubmit?.(value);
        return true;
      }
      if (key.ctrl && input === 'j' && multiline) {
        insert('\n');
        return true;
      }
      if (key.ctrl && input === 's' && multiline) {
        onSubmit?.(value);
        return true;
      }
      if (key.tab) {
        if (onTab) {
          const completed = onTab(value, at);
          if (typeof completed === 'string') commit(completed, chars(completed).length);
          return true;
        }
        return false;
      }
      if (key.backspace) {
        if (at === 0) return true;
        const from = key.meta ? prevWordIndex(cs, at) : at - 1;
        commit([...cs.slice(0, from), ...cs.slice(at)].join(''), from);
        return true;
      }
      if (key.delete) {
        if (at >= cs.length) return true;
        commit([...cs.slice(0, at), ...cs.slice(at + 1)].join(''), at);
        return true;
      }
      if (key.leftArrow) {
        setCursor(key.meta || key.ctrl ? prevWordIndex(cs, at) : Math.max(0, at - 1));
        return true;
      }
      if (key.rightArrow) {
        setCursor(key.meta || key.ctrl ? nextWordIndex(cs, at) : Math.min(cs.length, at + 1));
        return true;
      }
      if (multiline && (key.upArrow || key.downArrow)) {
        const { row, col } = cursorRowCol(cs, at);
        const target = key.upArrow ? row - 1 : row + 1;
        if (target >= 0) setCursor(indexFromRowCol(cs, target, col));
        return true;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        if (multiline) {
          const { row } = cursorRowCol(cs, at);
          setCursor(indexFromRowCol(cs, row, 0));
        } else setCursor(0);
        return true;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        if (multiline) {
          const { row } = cursorRowCol(cs, at);
          setCursor(indexFromRowCol(cs, row, Number.MAX_SAFE_INTEGER));
        } else setCursor(cs.length);
        // Allow parent modals that bind Ctrl+E (e.g. AddFocusModal extract/match) to handle it too.
        return Boolean(key.end);
      }
      if (key.ctrl && input === 'u') {
        commit(cs.slice(at).join(''), 0);
        return true;
      }
      if (key.ctrl && input === 'k') {
        commit(cs.slice(0, at).join(''), at);
        return true;
      }
      if (key.ctrl && input === 'w') {
        const from = prevWordIndex(cs, at);
        commit([...cs.slice(0, from), ...cs.slice(at)].join(''), from);
        return true;
      }
      if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return false;
      if (input) {
        const clean = sanitizePastedText(input, { multiline });
        if (clean) insert(clean);
        return true;
      }
      return false;
    },
    { isActive, layer: KEY_LAYER_TEXT_INPUT, id: 'TextInput' },
  );

  const maskChar = mask === true ? (asciiMode ? '*' : '•') : typeof mask === 'string' && mask ? mask : null;
  const renderedPrompt = prompt ? normalizeAsciiChrome(prompt, asciiMode) : prompt;
  const renderedPlaceholder = placeholder ? normalizeAsciiChrome(placeholder, asciiMode) : placeholder;
  const promptEl = renderedPrompt ? (
    <Text color={isActive ? theme.primary : theme.muted}>{`${renderedPrompt} `}</Text>
  ) : null;
  const fieldWidth = Math.max(1, width);
  const promptW = renderedPrompt ? displayWidth(renderedPrompt) + 1 : 0;

  if (value.length === 0) {
    hStart.current = 0;
    vStart.current = 0;
    return (
      <Box ref={rootRef} width={fieldWidth + promptW} height={multiline ? height : 1}>
        {isActive ? <ImeCursorAnchor anchorRef={rootRef} dx={promptW} dy={0} /> : null}
        {promptEl}
        <Text>
          {isActive ? <Text inverse>{renderedPlaceholder ? chars(renderedPlaceholder)[0] : ' '}</Text> : null}
          <Text color={theme.dim}>
            {isActive ? chars(renderedPlaceholder).slice(1).join('') : renderedPlaceholder}
          </Text>
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
    let afterCells = display.slice(at + 1, win.end);
    if (win.start > 0 && at === win.start) {
      let used = 1 + Math.max(1, displayWidth(atChar));
      let keep = 0;
      while (keep < afterCells.length && used + Math.max(1, displayWidth(afterCells[keep])) <= fieldWidth) {
        used += Math.max(1, displayWidth(afterCells[keep]));
        keep += 1;
      }
      afterCells = afterCells.slice(0, keep);
    }
    const after = afterCells.join('');
    const shownBefore = win.start > 0 ? chars(before).slice(1).join('') : before;
    const caretDx = promptW + (win.start > 0 ? 1 : 0) + displayWidth(shownBefore);
    return (
      <Box ref={rootRef} height={1}>
        {isActive ? <ImeCursorAnchor anchorRef={rootRef} dx={caretDx} dy={0} /> : null}
        {promptEl}
        <Text color={theme.text} wrap="truncate">
          {win.start > 0 ? <Text color={theme.dim}>{asciiMode ? '<' : '‹'}</Text> : null}
          {shownBefore}
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
  const caretLine = lines[curRow] ?? [];
  const caretWin = hWindow(caretLine, curCol, fieldWidth, 0);
  const caretDx = promptW + displayWidth(caretLine.slice(caretWin.start, curCol).join(''));

  return (
    <Box ref={rootRef} flexDirection="column" height={rows}>
      {isActive ? <ImeCursorAnchor anchorRef={rootRef} dx={caretDx} dy={curRow - vs} /> : null}
      {lines.slice(vs, vs + rows).map((line, i) => {
        const r = vs + i;
        const isCurRow = r === curRow;
        const win = hWindow(line, isCurRow ? curCol : 0, fieldWidth, 0);
        if (!isCurRow || !isActive) {
          return (
            <Box key={r} height={1}>
              {i === 0 ? promptEl : renderedPrompt ? <Text>{' '.repeat(displayWidth(renderedPrompt) + 1)}</Text> : null}
              <Text color={theme.text}>{line.slice(win.start, win.end).join('') || ' '}</Text>
            </Box>
          );
        }
        return (
          <Box key={r} height={1}>
            {i === 0 ? promptEl : renderedPrompt ? <Text>{' '.repeat(displayWidth(renderedPrompt) + 1)}</Text> : null}
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
