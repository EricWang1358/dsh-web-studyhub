// Consolidated Ink UI component unit tests (TextInput edge cases, VirtualList & ScrollView SGR mouse wheel):
// `node --test tests/components.test.mjs`
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Text, render } from 'ink';
import React, { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { TextInput, sanitizePastedText },
  { displayWidth, splitGraphemes },
  { VirtualList, parseSgrWheelDelta },
  { ScrollView },
  storeMod,
] = await Promise.all([
  import('../src/components/TextInput.tsx'),
  import('../src/render/cjk.ts'),
  import('../src/components/VirtualList.tsx'),
  import('../src/components/ScrollView.tsx'),
  import('../src/state/store.js'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_BAR_RE = /[\u2500-\u257F]/;

function resetStore(asciiMode = false) {
  useTuiStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'en',
      asciiMode,
    },
  });
}

function createInkHarness(element, { cols = 80, rows = 12, defaultWaitMs = 20 } = {}) {
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
  const waiters = new Set();
  const notifyWaiters = () => {
    const latest = frames.at(-1) ?? '';
    for (const w of [...waiters]) {
      if (w.predicate(latest)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(latest);
      }
    }
  };
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    // Ignore ANSI-only control chunks (e.g. bracketed-paste toggle \x1b[?2004h)
    if (plain.trim().length > 0) {
      frames.push(plain);
      notifyWaiters();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  async function send(seq, waitMs = defaultWaitMs) {
    stdin.write(seq);
    await sleep(waitMs);
  }

  function lastFrame() {
    return frames.at(-1) ?? '';
  }

  function waitForFrame(predicate, timeoutMs = 2_000, label = 'matching frame') {
    const cur = lastFrame();
    if (predicate(cur)) return Promise.resolve(cur);
    return new Promise((resolvePromise, reject) => {
      const entry = {
        predicate,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          waiters.delete(entry);
          reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms. Last frame:\n${lastFrame()}`));
        }, timeoutMs),
      };
      waiters.add(entry);
    });
  }

  function cleanup() {
    for (const w of waiters) clearTimeout(w.timer);
    waiters.clear();
    inst.unmount();
    stdin.destroy();
    stdout.destroy();
  }

  return { send, lastFrame, waitForFrame, cleanup };
}

function createTextInputHarness({
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

  const base = createInkHarness(React.createElement(Wrapper), { cols, rows, defaultWaitMs: 20 });
  return {
    ...base,
    getValue: () => latestValue,
    changes,
    submits,
  };
}

// ---------------------------------------------------------------------------
// 1. TextInput paste sanitization, grapheme editing, CSI-u & width bounding
// ---------------------------------------------------------------------------

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
    const h = createTextInputHarness({ initialValue: initial, width: 30 });
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
    const h = createTextInputHarness({ initialValue: initial, width: 30 });
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
    const h = createTextInputHarness({ initialValue: 'L1', multiline: true, width: 30, height: 5 });
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

  test("b2) Multiline orphaned modifyOtherKeys Ctrl+Enter submits; conhost's bare LF stays a newline, so Ctrl+Enter is never advertised (#1736)", async () => {
    const h = createTextInputHarness({ initialValue: 'A', multiline: true, width: 30, height: 5 });
    try {
      await sleep(20);
      // Ink drops an intact ESC[27;5;13~ before any handler runs, so only the orphaned tail can be handled here.
      await h.send('[27;5;13~');
      assert.deepEqual(h.submits, ['A'], 'orphaned modifyOtherKeys Ctrl+Enter must submit');
      assert.equal(h.getValue(), 'A', 'it must not leak literal text into the value');
      // conhost reports Ctrl+Enter as a bare LF, which cannot be told from Ctrl+J: a newline, never a submit.
      await h.send('\n');
      assert.equal(h.submits.length, 1);
      assert.equal(h.getValue(), 'A\n');
    } finally {
      h.cleanup();
    }
  });

  test('c) Masked secret input (mask={true}) renders one mask glyph per grapheme and respects asciiMode', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    try {
      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: false } });
      const h = createTextInputHarness({ initialValue: 'a👨‍💻🇨🇳e\u0301', mask: true, width: 20 });
      try {
        await sleep(20);
        const frame = h.lastFrame().trimEnd();
        assert.equal(frame, '••••', `expected 4 mask bullets for 4 graphemes, got ${JSON.stringify(frame)}`);
      } finally {
        h.cleanup();
      }

      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: true } });
      const hAscii = createTextInputHarness({ initialValue: '秘👨‍💻e\u0301', mask: true, width: 20 });
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
      const h = createTextInputHarness({ initialValue: value, width, cols: 40, rows: 4 });
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

  test('c3) Horizontal scroll offset resets after Ctrl+U clears an overflowed path and shorter text is typed', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    try {
      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: false } });
      const longInitial = '/tmp/very-long-studyhub-directory-name/backups/note-deep-views-e2e-note-2026-11-23-030845.md';
      const h = createTextInputHarness({ initialValue: longInitial, width: 32, cols: 50, rows: 4 });
      try {
        await sleep(20);
        assert.ok(h.lastFrame().includes('‹'), `expected overflowed initial value to scroll left: ${JSON.stringify(h.lastFrame())}`);

        // Ctrl+U clears the entire line and resets hStart; typing a shorter value must render in full with no ‹
        await h.send('\u0015');
        await h.send('exported-deep-note.md');
        assert.equal(h.getValue(), 'exported-deep-note.md');
        const frame = h.lastFrame();
        assert.ok(frame.includes('exported-deep-note.md'), `expected full shorter value visible, got ${JSON.stringify(frame)}`);
        assert.ok(!frame.includes('‹'), `expected no stale scroll indicator when value fits width, got ${JSON.stringify(frame)}`);
      } finally {
        h.cleanup();
      }
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. parseSgrWheelDelta, VirtualList & ScrollView SGR 1006 mouse wheel
// ---------------------------------------------------------------------------

describe('parseSgrWheelDelta unit tests', () => {
  test('parses intact and ESC-stripped SGR 1006 wheel sequences across terminals', () => {
    assert.equal(parseSgrWheelDelta('\u001b[<64;10;5M'), -3);
    assert.equal(parseSgrWheelDelta('\u001b[<65;10;5M'), 3);
    assert.equal(parseSgrWheelDelta('[<64;10;5M'), -3);
    assert.equal(parseSgrWheelDelta('<65;10;5M'), 3);
    assert.equal(parseSgrWheelDelta('[<65;1;1M'), 3);
    assert.equal(parseSgrWheelDelta('<64;120;40M'), -3);
    assert.equal(parseSgrWheelDelta('\u001b[<64;10;5M', 5), -5);
  });

  test('supports modifier wheel bits (Shift/Alt/Ctrl: 68, 69, 72, 73, 80, 81)', () => {
    assert.equal(parseSgrWheelDelta('\u001b[<68;10;5M'), -3);
    assert.equal(parseSgrWheelDelta('\u001b[<69;10;5M'), 3);
    assert.equal(parseSgrWheelDelta('[<72;10;5M'), -3);
    assert.equal(parseSgrWheelDelta('[<73;10;5M'), 3);
    assert.equal(parseSgrWheelDelta('\u001b[<80;10;5M'), -3);
    assert.equal(parseSgrWheelDelta('\u001b[<81;10;5M'), 3);
  });

  test('aggregates concatenated bursts and clamps extreme single-chunk bursts', () => {
    assert.equal(parseSgrWheelDelta('\u001b[<65;1;1M\u001b[<65;1;1M'), 6);
    assert.equal(parseSgrWheelDelta('[<64;1;1M[<64;1;1M'), -6);
    assert.equal(parseSgrWheelDelta('\u001b[<64;1;1M\u001b[<65;1;1M'), 0);
    const hugeBurst = '\u001b[<65;1;1M'.repeat(20);
    assert.equal(parseSgrWheelDelta(hugeBurst), 24);
  });

  test('ignores non-wheel clicks, releases (m), and ordinary text/keystrokes', () => {
    assert.equal(parseSgrWheelDelta('\u001b[<0;1;1M'), 0);
    assert.equal(parseSgrWheelDelta('\u001b[<1;1;1M'), 0);
    assert.equal(parseSgrWheelDelta('\u001b[<2;1;1M'), 0);
    assert.equal(parseSgrWheelDelta('\u001b[<32;1;1M'), 0);
    assert.equal(parseSgrWheelDelta('\u001b[<64;1;1m'), 0);
    assert.equal(parseSgrWheelDelta('[<65;1;1m'), 0);
    assert.equal(parseSgrWheelDelta(''), 0);
    assert.equal(parseSgrWheelDelta('64'), 0);
    assert.equal(parseSgrWheelDelta('M'), 0);
    assert.equal(parseSgrWheelDelta('j'), 0);
    assert.equal(parseSgrWheelDelta('k'), 0);
    assert.equal(parseSgrWheelDelta('\u001b[A'), 0);
    assert.equal(parseSgrWheelDelta('text <64;1;1M'), 0);
  });
});

describe('VirtualList & ScrollView Ink SGR mouse wheel rendering', () => {
  test('VirtualList scrolls selection smoothly with SGR wheel in default and ascii modes', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    const items = Array.from({ length: 20 }, (_, i) => `Item-${String(i).padStart(2, '0')}`);

    try {
      for (const ascii of [false, true]) {
        resetStore(ascii);
        const seenIndices = [];
        const h = createInkHarness(
          React.createElement(VirtualList, {
            items,
            height: 5,
            width: 24,
            ascii,
            onChange: (idx) => seenIndices.push(idx),
            renderItem: (item, { selected }) => React.createElement(Text, null, `${selected ? '>' : ' '} ${item}`),
          }),
          { cols: 60, rows: 16, defaultWaitMs: 30 },
        );

        try {
          const initFrame = await h.waitForFrame((f) => /> Item-00/.test(f), 2_000, 'initial Item-00');
          assert.match(initFrame, /> Item-00/);
          if (ascii) {
            assert.equal(UNICODE_BAR_RE.test(initFrame), false, 'ascii VirtualList must not emit Unicode box chars');
            assert.ok(initFrame.includes('#') || initFrame.includes('|'));
          }

          // Wheel down (+3)
          await h.send('\u001b[<65;10;5M');
          assert.match(await h.waitForFrame((f) => /> Item-03/.test(f), 2_000, 'Item-03'), /> Item-03/);
          assert.equal(seenIndices.at(-1), 3);

          // Burst wheel down (+6 -> 9)
          await h.send('\u001b[<65;1;1M\u001b[<65;1;1M');
          assert.match(await h.waitForFrame((f) => /> Item-09/.test(f), 2_000, 'Item-09'), /> Item-09/);
          assert.equal(seenIndices.at(-1), 9);

          // Wheel up (-3 -> 6)
          await h.send('\u001b[<64;10;5M');
          assert.match(await h.waitForFrame((f) => /> Item-06/.test(f), 2_000, 'Item-06'), /> Item-06/);
          assert.equal(seenIndices.at(-1), 6);

          // ESC-stripped SGR wheel via useInput ([<65;10;5M -> 9, <64;10;5M -> 6)
          await h.send('[<65;10;5M');
          await h.waitForFrame((f) => /> Item-09/.test(f), 2_000, 'ESC-stripped Item-09');
          assert.equal(seenIndices.at(-1), 9);
          await h.send('<64;10;5M');
          await h.waitForFrame((f) => /> Item-06/.test(f), 2_000, 'ESC-stripped Item-06');
          assert.equal(seenIndices.at(-1), 6);

          // Release events and right-click must be ignored by wheel/selection
          const countBeforeIgnored = seenIndices.length;
          await h.send('\u001b[<2;10;5M');
          await h.send('\u001b[<64;10;5m');
          await h.send('\u001b[<0;10;5m');
          assert.equal(seenIndices.length, countBeforeIgnored);

          // Normal keyboard navigation still works without corruption
          await h.send('j');
          assert.match(await h.waitForFrame((f) => /> Item-07/.test(f), 2_000, 'Item-07'), /> Item-07/);
          assert.equal(seenIndices.at(-1), 7);
        } finally {
          h.cleanup();
        }
      }
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });

  test('ScrollView scrolls viewport smoothly with SGR wheel in default and ascii modes', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    const lines = Array.from({ length: 30 }, (_, i) => `Line-${String(i).padStart(2, '0')} content`);

    try {
      for (const ascii of [false, true]) {
        resetStore(ascii);
        const seenTops = [];
        const h = createInkHarness(
          React.createElement(ScrollView, {
            lines,
            height: 6,
            width: 30,
            ascii,
            onScroll: (top) => seenTops.push(top),
          }),
          { cols: 60, rows: 16, defaultWaitMs: 30 },
        );

        try {
          const initFrame = await h.waitForFrame((f) => /Line-00 content/.test(f), 2_000, 'initial Line-00');
          assert.match(initFrame, /Line-00 content/);
          if (ascii) {
            assert.equal(UNICODE_BAR_RE.test(initFrame), false, 'ascii ScrollView must not emit Unicode box chars');
            assert.ok(initFrame.includes('#') || initFrame.includes('|'));
          }

          // Wheel down (+3)
          await h.send('\u001b[<65;5;5M');
          assert.match(await h.waitForFrame((f) => /Line-03 content/.test(f), 2_000, 'Line-03'), /Line-03 content/);
          assert.equal(seenTops.at(-1), 3);

          // Burst wheel down (+6 -> 9)
          await h.send('\u001b[<65;1;1M\u001b[<65;1;1M');
          assert.match(await h.waitForFrame((f) => /Line-09 content/.test(f), 2_000, 'Line-09'), /Line-09 content/);
          assert.equal(seenTops.at(-1), 9);

          // Wheel up (-3 -> 6)
          await h.send('\u001b[<64;5;5M');
          assert.match(await h.waitForFrame((f) => /Line-06 content/.test(f), 2_000, 'Line-06'), /Line-06 content/);
          assert.equal(seenTops.at(-1), 6);

          // ESC-stripped SGR wheel via useInput ([<65;5;5M -> 9, <64;5;5M -> 6)
          await h.send('[<65;5;5M');
          await h.waitForFrame((f) => /Line-09 content/.test(f), 2_000, 'ESC-stripped Line-09');
          assert.equal(seenTops.at(-1), 9);
          await h.send('<64;5;5M');
          await h.waitForFrame((f) => /Line-06 content/.test(f), 2_000, 'ESC-stripped Line-06');
          assert.equal(seenTops.at(-1), 6);

          // Non-wheel click and release must be ignored
          const countBeforeIgnored = seenTops.length;
          await h.send('\u001b[<0;5;5M');
          await h.send('\u001b[<65;5;5m');
          assert.equal(seenTops.length, countBeforeIgnored);

          // Normal keyboard navigation still works without corruption
          await h.send('k');
          assert.match(await h.waitForFrame((f) => /Line-05 content/.test(f), 2_000, 'Line-05'), /Line-05 content/);
          assert.equal(seenTops.at(-1), 5);
        } finally {
          h.cleanup();
        }
      }
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });

  test('ScrollView highlight (plain + ANSI) and n/N match jumping wrap cleanly', async () => {
    const prevPrefs = useTuiStore.getState().preferences;
    const { highlightLine } = await import('../src/components/ScrollView.tsx');
    try {
      resetStore(false);
      // Plain + ANSI-colored highlightLine preserves escape sequences and inverts matched tokens
      const plainHi = highlightLine('Memento pattern stores snapshot', 'snapshot');
      assert.ok(plainHi.includes('\u001b[7msnapshot\u001b[27m'), `expected inverse highlight, got ${JSON.stringify(plainHi)}`);
      const ansiHi = highlightLine('\u001b[36mBridge\u001b[0m decouples Bridge', 'bridge');
      assert.equal((ansiHi.match(/\u001b\[7mBridge\u001b\[27m/g) ?? []).length, 2, 'must highlight all case-insensitive occurrences without breaking ANSI');

      const lines = Array.from({ length: 24 }, (_, i) =>
        i === 2 || i === 10 || i === 18 ? `Row-${String(i).padStart(2, '0')} TARGET match` : `Row-${String(i).padStart(2, '0')} filler`,
      );
      const seenTops = [];
      const h = createInkHarness(
        React.createElement(ScrollView, {
          lines,
          height: 5,
          width: 30,
          highlight: 'target',
          onScroll: (top) => seenTops.push(top),
        }),
        { cols: 60, rows: 16, defaultWaitMs: 30 },
      );
      try {
        await h.waitForFrame((f) => /Row-00 filler/.test(f), 2_000, 'initial Row-00');
        await h.send('n');
        await h.waitForFrame((f) => /Row-02 TARGET/.test(f) && !/Row-00 filler/.test(f), 2_000, 'jump to match 2');
        assert.equal(seenTops.at(-1), 2);
        await h.send('n');
        await h.waitForFrame((f) => /Row-10 TARGET/.test(f), 2_000, 'jump to match 10');
        assert.equal(seenTops.at(-1), 10);
        await h.send('n');
        await h.waitForFrame((f) => /Row-18 TARGET/.test(f), 2_000, 'jump to match 18');
        assert.equal(seenTops.at(-1), 18);
        // Wrap around forward -> 2
        await h.send('n');
        await h.waitForFrame((f) => /Row-02 TARGET/.test(f) && !/Row-18/.test(f), 2_000, 'wrap forward to match 2');
        assert.equal(seenTops.at(-1), 2);
        // Reverse jump wrap around -> 18, then back to 10
        await h.send('N');
        await h.waitForFrame((f) => /Row-18 TARGET/.test(f), 2_000, 'wrap reverse to match 18');
        assert.equal(seenTops.at(-1), 18);
        await h.send('N');
        await h.waitForFrame((f) => /Row-10 TARGET/.test(f), 2_000, 'reverse to match 10');
        assert.equal(seenTops.at(-1), 10);
      } finally {
        h.cleanup();
      }
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });
});
