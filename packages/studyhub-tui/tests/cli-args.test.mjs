// Unit tests for cli-args capabilities and TextInput paste sanitization:
// `node --test tests/cli-args.test.mjs`
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const cliArgsMod = await tsImport('../src/cli-args.ts', import.meta.url);
const textInputMod = await tsImport('../src/components/TextInput.tsx', import.meta.url);

const { resolveColorCapability, shouldAutoAscii } = cliArgsMod;
const { sanitizePastedText } = textInputMod;

describe('sanitizePastedText', () => {
  test('strips full bracketed-paste ANSI wrappers and preserves Windows paths', () => {
    const raw = '\u001b[200~C:\\Users\\Alice\\StudyHub Notes\\lecture1.pdf\u001b[201~';
    assert.equal(sanitizePastedText(raw), 'C:\\Users\\Alice\\StudyHub Notes\\lecture1.pdf');
  });

  test('strips orphaned 200~/201~ wrappers when ESC was split by input parser', () => {
    assert.equal(sanitizePastedText('200~D:\\Work\\notes201~'), 'D:\\Work\\notes');
    assert.equal(sanitizePastedText('[200~D:\\Work\\notes[201~'), 'D:\\Work\\notes');
    assert.equal(sanitizePastedText('200~chapter1'), 'chapter1');
    assert.equal(sanitizePastedText('chapter1201~'), 'chapter1');
    assert.equal(sanitizePastedText('200~'), '');
    assert.equal(sanitizePastedText('201~'), '');
  });

  test('normalizes Windows CRLF and lone CR line breaks cleanly', () => {
    assert.equal(sanitizePastedText('line1\r\nline2\rline3\nline4'), 'line1 line2 line3 line4');
    assert.equal(sanitizePastedText('first\r\n\r\nsecond'), 'first second');
    assert.equal(
      sanitizePastedText('line1\r\nline2\rline3', { multiline: true }),
      'line1\nline2\nline3',
    );
  });

  test('removes control characters while preserving CJK, emoji, quotes, backslashes, and spaces', () => {
    const raw = '\u001b[31m"C:\\学习资料\\笔记 📚"\u001b[0m\u0000\u0007\u000b\u000c\u001f\u007f  ok';
    assert.equal(sanitizePastedText(raw), '"C:\\学习资料\\笔记 📚"  ok');
  });
});

describe('resolveColorCapability', () => {
  test('honors NO_COLOR when non-empty and ignores empty NO_COLOR', () => {
    const disabled = resolveColorCapability(
      { NO_COLOR: '1', FORCE_COLOR: '3', COLORTERM: 'truecolor' },
      { isTTY: true },
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.level, 0);

    const emptyNoColor = resolveColorCapability(
      { NO_COLOR: '', COLORTERM: 'truecolor' },
      { isTTY: true },
    );
    assert.equal(emptyNoColor.enabled, true);
    assert.equal(emptyNoColor.level, 3);
  });

  test('honors FORCE_COLOR=0/1/2/3/true/false even on non-TTY', () => {
    assert.deepEqual(
      { enabled: resolveColorCapability({ FORCE_COLOR: '0' }, { isTTY: true }).enabled, level: resolveColorCapability({ FORCE_COLOR: '0' }, { isTTY: true }).level },
      { enabled: false, level: 0 },
    );
    assert.deepEqual(
      { enabled: resolveColorCapability({ FORCE_COLOR: 'false' }, { isTTY: true }).enabled, level: resolveColorCapability({ FORCE_COLOR: 'false' }, { isTTY: true }).level },
      { enabled: false, level: 0 },
    );
    assert.equal(resolveColorCapability({ FORCE_COLOR: '1' }, { isTTY: false }).level, 1);
    assert.equal(resolveColorCapability({ FORCE_COLOR: '2' }, { isTTY: false }).level, 2);
    assert.equal(resolveColorCapability({ FORCE_COLOR: '3' }, { isTTY: false }).level, 3);
    assert.equal(resolveColorCapability({ FORCE_COLOR: 'true' }, { isTTY: false }).level, 3);
  });

  test('detects TERM=dumb and non-TTY as level 0', () => {
    const dumb = resolveColorCapability({ TERM: 'dumb', COLORTERM: 'truecolor' }, { isTTY: true });
    assert.equal(dumb.enabled, false);
    assert.equal(dumb.level, 0);

    const nonTty = resolveColorCapability({ COLORTERM: 'truecolor' }, { isTTY: false });
    assert.equal(nonTty.enabled, false);
    assert.equal(nonTty.level, 0);
  });

  test('detects truecolor via WT_SESSION, COLORTERM, and TERM_PROGRAM', () => {
    const wt = resolveColorCapability({ WT_SESSION: 'guid-123' }, { isTTY: true, platform: 'win32' });
    assert.equal(wt.enabled, true);
    assert.equal(wt.level, 3);

    const ct = resolveColorCapability({ COLORTERM: 'truecolor' }, { isTTY: true });
    assert.equal(ct.enabled, true);
    assert.equal(ct.level, 3);

    const ct24 = resolveColorCapability({ COLORTERM: '24bit' }, { isTTY: true });
    assert.equal(ct24.enabled, true);
    assert.equal(ct24.level, 3);

    for (const tp of ['WezTerm', 'iTerm.app', 'vscode', 'Hyper', 'Alacritty', 'kitty']) {
      const cap = resolveColorCapability({ TERM_PROGRAM: tp }, { isTTY: true });
      assert.equal(cap.enabled, true);
      assert.equal(cap.level, 3);
    }
  });

  test('detects 256-color TERM as level 2 and basic TTY as level 1', () => {
    const xterm256 = resolveColorCapability({ TERM: 'xterm-256color' }, { isTTY: true });
    assert.equal(xterm256.enabled, true);
    assert.equal(xterm256.level, 2);

    const basic = resolveColorCapability({ TERM: 'xterm' }, { isTTY: true });
    assert.equal(basic.enabled, true);
    assert.equal(basic.level, 1);
  });
});

describe('shouldAutoAscii (cross-platform & simulated win32)', () => {
  test('falls back to ASCII on legacy Windows PowerShell 5.1 conhost', () => {
    assert.equal(shouldAutoAscii({}, 'win32'), true);
  });

  test('keeps Unicode enabled on modern win32 terminals', () => {
    assert.equal(shouldAutoAscii({ WT_SESSION: 'guid-123' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ TERM_PROGRAM: 'vscode' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ MSYSTEM: 'MINGW64' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ ConEmuANSI: 'ON' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ ANSICON: '180x50' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ TERM: 'xterm-256color' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ TERM: 'vt100' }, 'win32'), false);
  });

  test('respects explicit STUDYHUB_TUI_ASCII overrides on win32 and TERM=dumb', () => {
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: '0' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: 'false' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: '1', WT_SESSION: 'guid' }, 'win32'), true);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: 'true', WT_SESSION: 'guid' }, 'win32'), true);
    assert.equal(shouldAutoAscii({ WT_SESSION: 'guid', TERM: 'dumb' }, 'win32'), true);
  });
});
