// Regression test for #1413: TextInput must position the real terminal cursor
// via Ink 8's useCursor() at the insertion point (empty, single-line CJK/ASCII,
// multi-line) when active, hide it when inactive, and never let an inactive
// sibling TextInput clobber an active one's cursor.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React, { useState } from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const { TextInput } = await import('../src/components/TextInput.tsx');

/**
 * Parse Ink's buildCursorSuffix escape sequence (`\x1b[<up>A`? + `\x1b[<col1>G` + `\x1b[?25h`)
 * from raw stdout chunks. Returns the last `{ up, col0 }` seen where cursor was shown, or null if last event hid cursor.
 */
function parseLastCursorState(rawOutput) {
  const showRe = /(?:\u001b\[(\d+)A)?\u001b\[(\d+)G\u001b\[\?25h/g;
  const hideRe = /\u001b\[\?25l/g;
  let lastShow = null;
  let m;
  while ((m = showRe.exec(rawOutput)) !== null) {
    lastShow = {
      index: m.index,
      up: m[1] ? Number.parseInt(m[1], 10) : 0,
      col0: Number.parseInt(m[2], 10) - 1,
    };
  }
  let lastHideIndex = -1;
  while ((m = hideRe.exec(rawOutput)) !== null) {
    lastHideIndex = m.index;
  }
  if (!lastShow) return { shown: false, up: 0, col0: 0 };
  return {
    shown: lastShow.index > lastHideIndex,
    up: lastShow.up,
    col0: lastShow.col0,
  };
}

function mountInk(element, { cols = 80, rows = 16 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let raw = '';
  stdout.on('data', (chunk) => {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  });

  const instance = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  return {
    raw: () => raw,
    clearRaw: () => {
      raw = '';
    },
    rerender: (el) => instance.rerender(el),
    async waitFor(pred, timeoutMs = 3000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(raw)) return raw;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Raw tail:\n${JSON.stringify(raw.slice(-300))}`);
    },
    cleanup() {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test('#1413: TextInput positions real cursor for empty, single-line CJK, multi-line, hides on blur, and survives inactive sibling', async (t) => {
  // Layout: 2 rows header above input, 4 cols paddingLeft, 2 rows footer below input (total box rows = 2 + 1 + 2 = 5 for single-line).
  // Bottom line index = 4 (or 5 with trailing newline — wait: Ink's frame has lines 0..5, so input at y=2 means up = bottomLine - 2).
  function Harness({ value, isActive, multiline = false, height = 3, showInactiveSibling = false }) {
    const [, setVal] = useState(value);
    return React.createElement(
      Box,
      { flexDirection: 'column', width: 60 },
      React.createElement(Text, null, 'Header 1'),
      React.createElement(Text, null, 'Header 2'),
      React.createElement(
        Box,
        { paddingLeft: 4 },
        React.createElement(TextInput, {
          value,
          onChange: setVal,
          isActive,
          multiline,
          height,
          width: 30,
          prompt: '>',
        }),
      ),
      showInactiveSibling
        ? React.createElement(
            Box,
            { paddingLeft: 4 },
            React.createElement(TextInput, {
              value: 'sibling',
              onChange: () => {},
              isActive: false,
              width: 30,
            }),
          )
        : null,
      React.createElement(Text, null, 'Footer 1'),
      React.createElement(Text, null, 'Footer 2'),
    );
  }

  // 1) Empty input, active: prompt "> " occupies 2 columns, paddingLeft=4 -> col0 = 6
  const h = mountInk(React.createElement(Harness, { value: '', isActive: true, showInactiveSibling: true }));
  t.after(() => h.cleanup());

  await h.waitFor((r) => parseLastCursorState(r).shown, 3000, 'cursor shown on empty active input');
  const emptyState = parseLastCursorState(h.raw());
  assert.equal(emptyState.shown, true, 'real cursor must be shown even with inactive sibling mounted after it');
  assert.equal(emptyState.col0, 6, 'empty input cursor sits right after paddingLeft(4) + "> "(2)');
  assert.ok(emptyState.up >= 3, `empty input cursor must move up from bottom line (got up=${emptyState.up})`);

  // 2) Single-line with CJK ("你好a" -> displayWidth 2+2+1 = 5) -> col0 = 4 + 2 + 5 = 11
  h.clearRaw();
  h.rerender(React.createElement(Harness, { value: '你好a', isActive: true, showInactiveSibling: true }));
  await h.waitFor((r) => parseLastCursorState(r).col0 === 11, 3000, 'single-line CJK cursor col0 === 11');
  const singleState = parseLastCursorState(h.raw());
  assert.equal(singleState.shown, true);
  assert.equal(singleState.col0, 11);

  // 3) Multi-line ("第一行\n中文" -> row 1, col after "中文" = 4 cols) -> col0 = 4 + 2 + 4 = 10, up is 1 less than row 0
  h.clearRaw();
  h.rerender(React.createElement(Harness, { value: '第一行\n中文', isActive: true, multiline: true, height: 3 }));
  await h.waitFor((r) => parseLastCursorState(r).col0 === 10, 3000, 'multi-line cursor at row 1 col 10');
  const multiRow1 = parseLastCursorState(h.raw());
  assert.equal(multiRow1.shown, true);
  assert.equal(multiRow1.col0, 10);

  // Move to 3rd line ("第一行\n中文\nX" -> row 2, col after "X" = 1) -> col0 = 4 + 2 + 1 = 7, up decreases by 1
  h.clearRaw();
  h.rerender(React.createElement(Harness, { value: '第一行\n中文\nX', isActive: true, multiline: true, height: 3 }));
  await h.waitFor((r) => parseLastCursorState(r).col0 === 7, 3000, 'multi-line cursor at row 2 col 7');
  const multiRow2 = parseLastCursorState(h.raw());
  assert.equal(multiRow2.shown, true);
  assert.equal(multiRow2.up, multiRow1.up - 1, 'moving down one line in multiline decreases cursorUp by 1');

  // 4) Blur (isActive=false): real cursor must be hidden (\x1b[?25l)
  h.clearRaw();
  h.rerender(React.createElement(Harness, { value: '第一行\n中文\nX', isActive: false, multiline: true, height: 3 }));
  await h.waitFor((r) => r.includes('\u001b[?25l'), 3000, 'cursor hidden on blur');
  assert.equal(parseLastCursorState(h.raw()).shown, false, 'cursor must stay hidden when inactive');
});
