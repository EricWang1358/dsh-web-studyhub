// Round 49 TextInput grapheme-cluster editing, CSI-u / bracketed-paste sanitization & width-bounding tests:
// `node --test tests/round49-textinput-edge.test.mjs`
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React, { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ TextInput, sanitizePastedText }, { displayWidth, splitGraphemes }, storeMod] = await Promise.all([
  import('../src/components/TextInput.tsx'),
  import('../src/render/cjk.ts'),
  import('../src/state/store.js'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function createInkHarness({
  initialValue = '',
  width = 40,
  height = 4,
  multiline = false,
  submitOnEnter = false,
  mask,
  prompt,
  cols = 80,
  rows = 12,
} = {}) {
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

  const frames = [];
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    // Ignore ANSI-only control chunks (e.g. bracketed-paste toggle \x1b[?2004h)
    if (plain.trim().length > 0) {
      frames.push(plain);
    }
  });

  const changes = [];
  const submits = [];
  let latestValue = initialValue;

  function Wrapper() {
    const [val, setVal] = useState(initialValue);
    latestValue = val;
    return React.createElement(TextInput, {
      value: val,
      onChange: (next) => {
        latestValue = next;
        changes.push(next);
        setVal(next);
      },
      onSubmit: (submitted) => {
        submits.push(submitted);
      },
      width,
      height,
      multiline,
      submitOnEnter,
      mask,
      prompt,
      isActive: true,
    });
  }

  const inst = render(React.createElement(Wrapper), {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  async function send(seq, waitMs = 20) {
    stdin.write(seq);
    await sleep(waitMs);
  }

  function lastFrame() {
    return frames.at(-1) ?? '';
  }

  function cleanup() {
    inst.unmount();
    stdin.destroy();
    stdout.destroy();
  }

  return {
    send,
    lastFrame,
    getValue: () => latestValue,
    changes,
    submits,
    cleanup,
  };
}

describe('sanitizePastedText cross-platform & CSI-u hardening', () => {
  test('strips Windows Terminal CRLF, full bracketed paste, and orphaned 200~/201~ wrappers', () => {
    assert.equal(
      sanitizePastedText('\u001b[200~line1\r\nline2\rline3\u001b[201~'),
      'line1 line2 line3',
    );
    assert.equal(
      sanitizePastedText('\u001b[200~line1\r\nline2\rline3\u001b[201~', { multiline: true }),
      'line1\nline2\nline3',
    );
    assert.equal(sanitizePastedText('200~C:\\Users\\Alice\\file.txt201~'), 'C:\\Users\\Alice\\file.txt');
    assert.equal(sanitizePastedText('[200~C:\\Users\\Alice\\file.txt[201~'), 'C:\\Users\\Alice\\file.txt');
    assert.equal(sanitizePastedText('200~201~'), '');
    assert.equal(sanitizePastedText('[200~[201~'), '');
  });

  test('strips stray/orphaned CSI-u and modifyOtherKeys sequences without harming legitimate text', () => {
    assert.equal(sanitizePastedText('\u001b[13;2u'), '');
    assert.equal(sanitizePastedText('\u001b[13;5u'), '');
    assert.equal(sanitizePastedText('[13;2u'), '');
    assert.equal(sanitizePastedText('13;2u'), '');
    assert.equal(sanitizePastedText('[13;5u'), '');
    assert.equal(sanitizePastedText('13;5u'), '');
    assert.equal(sanitizePastedText('[97;5:1u'), '');
    assert.equal(sanitizePastedText('27;2;13~'), '');
    assert.equal(sanitizePastedText('\u001b[27;5;13~'), '');
    assert.equal(sanitizePastedText('hello\u001b[13;2uworld'), 'helloworld');
    assert.equal(sanitizePastedText('hello[13;2uworld'), 'helloworld');
    assert.equal(sanitizePastedText('foo\u001b['), 'foo');

    // Legitimate paths, array syntax, CSS/physics units remain intact
    assert.equal(sanitizePastedText('x = [1, 2, 3]; cap = 10u'), 'x = [1, 2, 3]; cap = 10u');
    assert.equal(sanitizePastedText('D:\\Work\\200_archive\\file~1.txt'), 'D:\\Work\\200_archive\\file~1.txt');
  });

  test('preserves Windows drive paths, UNC paths, CJK, ZWJ emoji, flags, and combining accents', () => {
    const winPath = 'C:\\Users\\Alice\\StudyHub Notes\\高数讲义.pdf';
    assert.equal(sanitizePastedText(`\u001b[200~${winPath}\u001b[201~`), winPath);

    const uncPath = '\\\\server\\share\\资料库\\笔记.md';
    assert.equal(sanitizePastedText(`200~${uncPath}201~`), uncPath);

    const unicode = '中文测试 👨‍💻 🇨🇳 e\u0301 café';
    assert.equal(sanitizePastedText(`\u001b[36m${unicode}\u001b[0m`), unicode);
  });
});

describe('TextInput real Ink grapheme-cluster, multiline CSI-u, mask & width tests', () => {
  test('a) ZWJ emoji, regional flag, and combining mark cursor Left/Right & single Backspace delete whole grapheme', async () => {
    const initial = 'a👨‍💻🇨🇳e\u0301b';
    const h = createInkHarness({ initialValue: initial, width: 30 });
    try {
      await sleep(20);
      assert.deepEqual(splitGraphemes(h.getValue()), ['a', '👨‍💻', '🇨🇳', 'e\u0301', 'b']);

      // Cursor starts at end (after 'b'). Move Left 1 -> before 'b', Backspace deletes 'e\u0301' cleanly!
      await h.send('\u001b[D'); // Left -> on 'b'
      await h.send('\u007f'); // Backspace -> deletes 'e\u0301'
      assert.equal(h.getValue(), 'a👨‍💻🇨🇳b');

      // Backspace again -> deletes regional flag '🇨🇳' as one unit (zero lone regional indicator!)
      await h.send('\u007f');
      assert.equal(h.getValue(), 'a👨‍💻b');

      // Move Left onto '👨‍💻', then Right back onto 'b', then Backspace deletes '👨‍💻' as one unit (zero lone ZWJ/codepoint!)
      await h.send('\u001b[D');
      await h.send('\u001b[C');
      await h.send('\u007f');
      assert.equal(h.getValue(), 'ab');
    } finally {
      h.cleanup();
    }
  });

  test('a2) Delete key, Home/End, and Ctrl+A/Ctrl+E operate on grapheme boundaries', async () => {
    const initial = '👨‍💻🇨🇳e\u0301';
    const h = createInkHarness({ initialValue: initial, width: 30 });
    try {
      await sleep(20);
      await h.send('\u0001'); // Ctrl+A -> index 0
      await h.send('\u001b[3~'); // Delete -> deletes '👨‍💻' whole grapheme
      assert.equal(h.getValue(), '🇨🇳e\u0301');

      await h.send('\u0005'); // Ctrl+E -> end
      await h.send('\u007f'); // Backspace -> deletes 'e\u0301' whole grapheme
      assert.equal(h.getValue(), '🇨🇳');
    } finally {
      h.cleanup();
    }
  });

  test('b) Multiline Ctrl+J, intact & orphaned Shift+Enter newline insertion, and Ctrl+S / Ctrl+Enter submission', async () => {
    const h = createInkHarness({ initialValue: 'L1', multiline: true, width: 30, height: 5 });
    try {
      await sleep(20);

      // Ctrl+J via Kitty CSI-u (\x1b[106;5u)
      await h.send('\u001b[106;5u');
      await h.send('L2');
      assert.equal(h.getValue(), 'L1\nL2');

      // Intact CSI-u Shift+Enter (\x1b[13;2u)
      await h.send('\u001b[13;2u');
      await h.send('L3');
      assert.equal(h.getValue(), 'L1\nL2\nL3');

      // Orphaned CSI-u Shift+Enter ([13;2u and 13;2u) must insert newline without leaking literal text
      await h.send('[13;2u');
      await h.send('L4');
      await h.send('13;2u');
      await h.send('L5');
      assert.equal(h.getValue(), 'L1\nL2\nL3\nL4\nL5');
      assert.equal(h.getValue().includes('13;2u'), false);

      // Ctrl+S submits
      await h.send('\u0013');
      assert.deepEqual(h.submits, ['L1\nL2\nL3\nL4\nL5']);

      // Intact CSI-u Ctrl+Enter (\x1b[13;5u) & orphaned [13;5u / 13;5u submit without leaking
      await h.send('\u001b[13;5u');
      await h.send('[13;5u');
      await h.send('13;5u');
      assert.equal(h.submits.length, 4);
      assert.equal(h.getValue(), 'L1\nL2\nL3\nL4\nL5');
    } finally {
      h.cleanup();
    }
  });

  test('c) Masked secret input (mask={true}) renders one mask glyph per grapheme and respects asciiMode', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    try {
      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: false } });
      const h = createInkHarness({ initialValue: 'a👨‍💻🇨🇳e\u0301', mask: true, width: 20 });
      try {
        await sleep(20);
        const frame = h.lastFrame().trimEnd();
        assert.equal(frame, '••••', `expected 4 mask bullets for 4 graphemes, got ${JSON.stringify(frame)}`);
      } finally {
        h.cleanup();
      }

      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: true } });
      const hAscii = createInkHarness({ initialValue: '秘👨‍💻e\u0301', mask: true, width: 20 });
      try {
        await sleep(20);
        const frame = hAscii.lastFrame().trimEnd();
        assert.equal(frame, '***', `expected 3 ASCII * masks for 3 graphemes, got ${JSON.stringify(frame)}`);
      } finally {
        hAscii.cleanup();
      }
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });

  test('c2) Strict width bounding with wide CJK characters and scrolled left indicator', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    try {
      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: false } });
      const width = 10;
      const value = '中文测试输入超宽文本测试';
      const h = createInkHarness({ initialValue: value, width, cols: 40, rows: 4 });
      try {
        await sleep(20);
        const checkWidth = (label) => {
          const lines = h.lastFrame().split('\n').filter((l) => l.trim().length > 0);
          assert.ok(lines.length > 0, `${label}: expected non-empty rendered frame`);
          for (const line of lines) {
            const w = displayWidth(line.trimEnd());
            assert.ok(w <= width, `${label}: rendered width ${w} > ${width} (${JSON.stringify(line)})`);
          }
        };

        checkWidth('initial end cursor');
        assert.ok(h.lastFrame().includes('‹'), `expected left scroll indicator in ${JSON.stringify(h.lastFrame())}`);
        // Step cursor left across the CJK window boundary (including win.start === cursor with win.start > 0)
        for (let i = 0; i < 10; i += 1) {
          await h.send('\u001b[D');
          checkWidth(`after Left #${i + 1}`);
        }
      } finally {
        h.cleanup();
      }
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });
});
