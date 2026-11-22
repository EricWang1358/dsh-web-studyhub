// Round 57 Task 3: SGR 1006 mouse wheel scrolling (`parseSgrWheelDelta`) in VirtualList & ScrollView
// `node --test --test-concurrency=1 tests/round57-scroll-mouse.test.mjs`
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Text, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ VirtualList, parseSgrWheelDelta }, { ScrollView }, storeMod] = await Promise.all([
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

function createInkHarness(element, { cols = 60, rows = 16 } = {}) {
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
    if (plain.trim().length > 0) {
      frames.push(plain);
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  async function send(seq, waitMs = 30) {
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

  return { send, lastFrame, cleanup };
}

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
    const items = Array.from({ length: 20 }, (_, i) => `Item-${String(i).padStart(2, '0')}`);

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
      );

      try {
        await sleep(30);
        assert.match(h.lastFrame(), /> Item-00/);
        if (ascii) {
          assert.equal(UNICODE_BAR_RE.test(h.lastFrame()), false, 'ascii VirtualList must not emit Unicode box chars');
          assert.ok(h.lastFrame().includes('#') || h.lastFrame().includes('|'));
        }

        // Wheel down (+3)
        await h.send('\u001b[<65;10;5M');
        assert.equal(seenIndices.at(-1), 3);
        assert.match(h.lastFrame(), /> Item-03/);

        // Burst wheel down (+6 -> 9)
        await h.send('\u001b[<65;1;1M\u001b[<65;1;1M');
        assert.equal(seenIndices.at(-1), 9);
        assert.match(h.lastFrame(), /> Item-09/);

        // Wheel up (-3 -> 6)
        await h.send('\u001b[<64;10;5M');
        assert.equal(seenIndices.at(-1), 6);
        assert.match(h.lastFrame(), /> Item-06/);

        // ESC-stripped SGR wheel via useInput ([<65;10;5M -> 9, <64;10;5M -> 6)
        await h.send('[<65;10;5M');
        assert.equal(seenIndices.at(-1), 9);
        await h.send('<64;10;5M');
        assert.equal(seenIndices.at(-1), 6);

        // Non-wheel click and release must be ignored
        const countBeforeIgnored = seenIndices.length;
        await h.send('\u001b[<0;10;5M');
        await h.send('\u001b[<64;10;5m');
        assert.equal(seenIndices.length, countBeforeIgnored);

        // Normal keyboard navigation still works without corruption
        await h.send('j');
        assert.equal(seenIndices.at(-1), 7);
        assert.match(h.lastFrame(), /> Item-07/);
      } finally {
        h.cleanup();
      }
    }
  });

  test('ScrollView scrolls viewport smoothly with SGR wheel in default and ascii modes', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line-${String(i).padStart(2, '0')} content`);

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
      );

      try {
        await sleep(30);
        assert.match(h.lastFrame(), /Line-00 content/);
        if (ascii) {
          assert.equal(UNICODE_BAR_RE.test(h.lastFrame()), false, 'ascii ScrollView must not emit Unicode box chars');
          assert.ok(h.lastFrame().includes('#') || h.lastFrame().includes('|'));
        }

        // Wheel down (+3)
        await h.send('\u001b[<65;5;5M');
        assert.equal(seenTops.at(-1), 3);
        assert.match(h.lastFrame(), /Line-03 content/);

        // Burst wheel down (+6 -> 9)
        await h.send('\u001b[<65;1;1M\u001b[<65;1;1M');
        assert.equal(seenTops.at(-1), 9);
        assert.match(h.lastFrame(), /Line-09 content/);

        // Wheel up (-3 -> 6)
        await h.send('\u001b[<64;5;5M');
        assert.equal(seenTops.at(-1), 6);
        assert.match(h.lastFrame(), /Line-06 content/);

        // ESC-stripped SGR wheel via useInput ([<65;5;5M -> 9, <64;5;5M -> 6)
        await h.send('[<65;5;5M');
        assert.equal(seenTops.at(-1), 9);
        await h.send('<64;5;5M');
        assert.equal(seenTops.at(-1), 6);

        // Non-wheel click and release must be ignored
        const countBeforeIgnored = seenTops.length;
        await h.send('\u001b[<0;5;5M');
        await h.send('\u001b[<65;5;5m');
        assert.equal(seenTops.length, countBeforeIgnored);

        // Normal keyboard navigation still works without corruption
        await h.send('k');
        assert.equal(seenTops.at(-1), 5);
        assert.match(h.lastFrame(), /Line-05 content/);
      } finally {
        h.cleanup();
      }
    }
  });
});
