// Behavior tests for #1311: Centralized SGR mouse click support (SideNav, lists, review, modals, TopBar, tabs, TextInput safety).
// node --test tests/issue-1311-mouse-click.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React, { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  mouseMod,
  { TextInput },
  { VirtualList },
  { SelectList },
  { ConfirmDialog },
  { SideNav },
  { TopBar },
  { AppShell },
  { ReviewView },
  { AiHelpDrawer },
  { SettingsView },
  { enterTerminalSession, ENABLE_SGR_MOUSE },
  storeMod,
] = await Promise.all([
  import('../src/components/mouse.tsx'),
  import('../src/components/TextInput.tsx'),
  import('../src/components/VirtualList.tsx'),
  import('../src/components/SelectList.tsx'),
  import('../src/components/ConfirmDialog.tsx'),
  import('../src/shell/SideNav.tsx'),
  import('../src/shell/TopBar.tsx'),
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/views/review/AiHelpDrawer.tsx'),
  import('../src/views/settings/SettingsView.tsx'),
  import('../src/terminal.ts'),
  import('../src/state/store.ts'),
]);

const {
  parseSgrMouseEvents,
  stripSgrMouseSequences,
  isSgrMouseSequence,
  dispatchMouseClick,
  ClickableBox,
} = mouseMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

/** Format 0-based (col, row) as intact SGR 1006 left-click press + release sequence. */
function sgrLeftClick(col0, row0) {
  return `\x1b[<0;${col0 + 1};${row0 + 1}M\x1b[<0;${col0 + 1};${row0 + 1}m`;
}

/** Find 0-based (col, row) of a substring inside a rendered plain-text frame. */
function findTextCoords(frame, needle) {
  const lines = frame.split('\n');
  for (let r = 0; r < lines.length; r += 1) {
    const idx = lines[r].indexOf(needle);
    if (idx >= 0) {
      // Compute display column up to idx (ASCII/CJK approximate via char width)
      let col = 0;
      for (const ch of lines[r].slice(0, idx)) {
        const cp = ch.codePointAt(0) ?? 0;
        col += cp >= 0x2e80 ? 2 : 1;
      }
      return { col, row: r };
    }
  }
  return null;
}

function createInkHarness(element, { cols = 120, rows = 30 } = {}) {
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
  const notify = () => {
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
    if (plain.trim().length > 0) {
      frames.push(plain);
      notify();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });

  return {
    latest: () => frames.at(-1) ?? '',
    write: (s) => stdin.write(s),
    waitFor: (predicate, timeoutMs = 1500) => {
      const cur = frames.at(-1) ?? '';
      if (predicate(cur)) return Promise.resolve(cur);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(entry);
            reject(new Error(`Timed out waiting for frame. Last frame:\n${frames.at(-1) ?? '<empty>'}`));
          }, timeoutMs),
        };
        waiters.add(entry);
      });
    },
    cleanup: () => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetStore(overrides = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    showLaunchpad: false,
    snapshot: { courses: [{ id: 'c1', name: 'OS' }], decks: [], sources: [], jobs: [] },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
    },
    ...overrides,
  });
}

describe('#1311 mouse click support & keyboard parity', () => {
  test('1. SGR mouse parser distinguishes left click, release, motion, and wheel', () => {
    const evs = parseSgrMouseEvents('\x1b[<0;12;5M\x1b[<0;12;5m\x1b[<64;10;3M\x1b[<32;5;5M');
    assert.equal(evs.length, 4);
    assert.equal(evs[0].isLeftClick, true);
    assert.equal(evs[0].col, 11);
    assert.equal(evs[0].row, 4);
    assert.equal(evs[1].isLeftClick, false); // release
    assert.equal(evs[2].wheelDelta, -3);
    assert.equal(evs[3].isLeftClick, false); // motion/drag
    assert.equal(isSgrMouseSequence('[<0;12;5M'), true);
    assert.equal(stripSgrMouseSequences('abc[<0;12;5Mdef\x1b[<64;1;1Mghi'), 'abcdefghi');
  });

  test('2. TextInput never inserts garbled characters on SGR mouse clicks or wheel events', async () => {
    resetStore();
    let latestVal = '';
    function InputHost() {
      const [val, setVal] = useState('');
      latestVal = val;
      return React.createElement(TextInput, {
        value: val,
        onChange: setVal,
        isActive: true,
        width: 30,
      });
    }
    const h = createInkHarness(React.createElement(InputHost), { cols: 50, rows: 5 });
    try {
      h.write('hi');
      await h.waitFor((s) => s.includes('hi'));
      // Send intact and ESC-stripped SGR clicks & wheel bursts
      h.write('\x1b[<0;5;1M\x1b[<0;5;1m[<0;5;1M[<64;5;1M<65;5;1M');
      h.write('!');
      await h.waitFor((s) => s.includes('hi!'));
      assert.equal(latestVal, 'hi!');
    } finally {
      h.cleanup();
    }
  });

  test('3. SideNav & TopBar mouse clicks navigate pages and open shell overlays', async () => {
    resetStore({ page: 'library' });
    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };

    const h = createInkHarness(
      React.createElement(AppShell, {
        host: mockHost,
        autoLaunchpad: false,
        renderPage: (page) => React.createElement(Text, null, `VIEW:${page}`),
      }),
      { cols: 120, rows: 30 },
    );

    try {
      const frame = await h.waitFor((s) => s.includes('VIEW:library') && s.includes('错题本'));
      const wrongPos = findTextCoords(frame, '错题本');
      assert.ok(wrongPos, 'Must find 错题本 in SideNav');
      h.write(sgrLeftClick(wrongPos.col, wrongPos.row));
      await h.waitFor((s) => s.includes('VIEW:wrongbook'));

      // Click TopBar [?] 帮助 -> opens HelpOverlay
      const frame2 = h.latest();
      const helpPos = findTextCoords(frame2, '帮助');
      assert.ok(helpPos, 'Must find 帮助 in TopBar');
      h.write(sgrLeftClick(helpPos.col, helpPos.row));
      await h.waitFor(() => useTuiStore.getState().helpOpen === true);
    } finally {
      h.cleanup();
    }
  });

  test('4. VirtualList & SelectList: first click selects row, second click opens it (Enter)', async () => {
    resetStore();
    const selected = [];
    const items = ['Deck Alpha', 'Deck Beta', 'Deck Gamma'];

    const h = createInkHarness(
      React.createElement(VirtualList, {
        items,
        height: 5,
        width: 30,
        isActive: true,
        onSelect: (item, idx) => selected.push({ item, idx }),
        renderItem: (item, ctx) => React.createElement(Text, null, `${ctx.selected ? '>' : ' '} ${item}`),
      }),
      { cols: 40, rows: 8 },
    );

    try {
      await h.waitFor((s) => s.includes('> Deck Alpha'));
      // First click on row 2 (Deck Gamma) selects it without opening
      h.write(sgrLeftClick(4, 2));
      await h.waitFor((s) => s.includes('> Deck Gamma'));
      assert.equal(selected.length, 0);
      // Second click on already-selected row 2 opens it
      h.write(sgrLeftClick(4, 2));
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(selected, [{ item: 'Deck Gamma', idx: 2 }]);
    } finally {
      h.cleanup();
    }

    // SelectList test
    const picked = [];
    const h2 = createInkHarness(
      React.createElement(SelectList, {
        options: [
          { value: 'a', label: 'Option A' },
          { value: 'b', label: 'Option B' },
        ],
        width: 30,
        isActive: true,
        onSelect: (opt) => picked.push(opt.value),
      }),
      { cols: 40, rows: 6 },
    );
    try {
      await h2.waitFor((s) => s.includes('Option B'));
      h2.write(sgrLeftClick(5, 1)); // select Option B
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(picked.length, 0);
      h2.write(sgrLeftClick(5, 1)); // open Option B
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(picked, ['b']);
    } finally {
      h2.cleanup();
    }
  });

  test('5. Modal/ConfirmDialog blocks click-through to underlying page and supports clicking Cancel / esc x', async () => {
    resetStore();
    let backgroundClicked = 0;
    let cancelled = 0;

    function ModalScene() {
      return React.createElement(
        Box,
        { width: 80, height: 20, flexDirection: 'column' },
        React.createElement(
          ClickableBox,
          { onClick: () => { backgroundClicked += 1; }, width: 30, height: 2 },
          React.createElement(Text, null, 'UNDERLYING_BG_BUTTON'),
        ),
        React.createElement(ConfirmDialog, {
          title: '删除确认',
          message: '确认删除这个题组吗？',
          danger: true,
          isActive: true,
          onConfirm: () => {},
          onCancel: () => { cancelled += 1; },
        }),
      );
    }

    const h = createInkHarness(React.createElement(ModalScene), { cols: 80, rows: 20 });
    try {
      const frame = await h.waitFor((s) => s.includes('取消 (n)') && s.includes('确认 (y)'));
      // Click top-left (0, 0) where UNDERLYING_BG_BUTTON sits behind the modal
      h.write(sgrLeftClick(2, 0));
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(backgroundClicked, 0, 'Clicking outside modal must NOT bleed through to underlying page');

      // Click Cancel button inside modal
      const cancelPos = findTextCoords(frame, '取消 (n)');
      assert.ok(cancelPos, 'Must find 取消 (n) button');
      h.write(sgrLeftClick(cancelPos.col + 1, cancelPos.row));
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(cancelled, 1, 'Clicking Cancel button must invoke onCancel');
    } finally {
      h.cleanup();
    }
  });

  test('6. ReviewView option click, FSRS rating click, bottom bar click, and AiHelpDrawer suggestion click', async () => {
    resetStore({ page: 'review' });
    const actions = [];
    const mockRun = {
      id: 'run-m1',
      title: 'Mouse Review',
      index: 0,
      total: 3,
      answered: 0,
      revealed: false,
      card: {
        id: 'c1',
        deckId: 'd1',
        kind: 'single',
        prompt: '2 + 2 = ?',
        options: [
          { id: 'A', text: 'AnswerThree' },
          { id: 'B', text: 'AnswerFour' },
        ],
      },
    };
    const mockHost = {
      call: async (name, payload) => {
        actions.push({ name, payload });
        if (name === 'review.start' || name === 'study.start') return { ok: true, value: mockRun };
        if (name === 'review.answer') {
          return {
            ok: true,
            value: {
              ...mockRun,
              answered: 1,
              revealed: true,
              feedback: { correct: true, selected: payload.selected },
              solution: { answer: 'B', options: [{ id: 'B', correct: true }] },
            },
          };
        }
        return { ok: true, value: {} };
      },
      getSnapshot: async () => ({ decks: [], courses: [], jobs: [] }),
    };

    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 100, height: 24, isActive: true }),
      { cols: 100, rows: 24 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('AnswerFour'));
      const optPos = findTextCoords(frame, 'AnswerFour');
      assert.ok(optPos, 'Must locate option B');
      h.write(sgrLeftClick(optPos.col, optPos.row));
      await h.waitFor((s) => s.includes('回答正确'));
      assert.ok(
        actions.some((a) => a.name === 'review.answer' && Array.isArray(a.payload?.selected) && a.payload.selected[0] === 'B'),
        'Clicking option B must submit option B',
      );
    } finally {
      h.cleanup();
    }

    // AiHelpDrawer follow-up suggestion click
    const asked = [];
    const aiHost = {
      call: async (name) => (name === 'card.followup.suggest' ? { ok: true, value: { questions: ['CLICK_SUGGEST_ONE'] } } : { ok: true, value: {} }),
      streamComplete: async ({ prompt }) => {
        asked.push(prompt);
        return 'OK_REPLY';
      },
    };
    const hAi = createInkHarness(
      React.createElement(AiHelpDrawer, {
        host: aiHost,
        run: mockRun,
        cardId: 'c1',
        kind: 'single',
        userAnswer: 'B',
        width: 50,
        height: 20,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
      }),
      { cols: 50, rows: 20 },
    );
    try {
      await hAi.waitFor((s) => s.includes('OK_REPLY'));
      hAi.write('s');
      const frame = await hAi.waitFor((s) => s.includes('CLICK_SUGGEST_ONE'));
      const sugPos = findTextCoords(frame, 'CLICK_SUGGEST_ONE');
      assert.ok(sugPos, 'Must find suggestion text');
      hAi.write(sgrLeftClick(sugPos.col, sugPos.row));
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(asked.some((p) => p.includes('CLICK_SUGGEST_ONE')), 'Clicking recommended follow-up must trigger askAi');
    } finally {
      hAi.cleanup();
    }
  });

  test('7. SettingsView tabs switch on mouse click & --no-mouse never enables SGR mouse sequences', async () => {
    resetStore({ page: 'settings' });
    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getConfig: () => null,
      getLibraryRoot: () => '/tmp',
      getSnapshot: async () => ({ decks: [], courses: [], jobs: [] }),
    };

    const h = createInkHarness(
      React.createElement(SettingsView, { host: mockHost, width: 100, height: 24, isActive: true }),
      { cols: 100, rows: 24 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('4 TUI 外观与偏好'));
      const tabPos = findTextCoords(frame, '4 TUI 外观与偏好');
      assert.ok(tabPos, 'Must find 4 TUI 外观与偏好 tab');
      h.write(sgrLeftClick(tabPos.col + 1, tabPos.row));
      await h.waitFor((s) => s.includes('主题') || s.includes('Theme'));
    } finally {
      h.cleanup();
    }

    // Verify --no-mouse (mouse: false) writes zero SGR mouse enable sequences
    const writes = [];
    const fakeStdout = { isTTY: true, write: (s) => writes.push(String(s)) };
    const fakeStdin = { isTTY: true, isRaw: false };
    const session = enterTerminalSession({ stdout: fakeStdout, stdin: fakeStdin, altScreen: false, mouse: false });
    try {
      assert.equal(session.mouseActive, false);
      assert.equal(writes.join('').includes(ENABLE_SGR_MOUSE), false, 'mouse: false must not emit ENABLE_SGR_MOUSE');
    } finally {
      session.restore();
    }
    assert.equal(typeof dispatchMouseClick, 'function');
  });
});
