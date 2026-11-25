// Regression test for #1349: Pressing `g` in LibraryView on the 2nd deck must open
// GuidedStudyModal for the 2nd deck without VirtualList jumping cursor back to the 1st deck.
// node --test tests/issue-1349-library-g-key.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ LibraryView }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/views/library/LibraryView.tsx'),
  import('../src/state/store.ts'),
]);

function createHarness(element, { cols = 120, rows = 36 } = {}) {
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

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const inst = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true });

  return {
    write: (s) => stdin.write(s),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 5000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test('#1349: pressing g on 2nd deck in LibraryView opens AI Guided Study for 2nd deck and keeps cursor on 2nd deck', async (t) => {
  const snapshot = {
    root: '/tmp/test-1349',
    decks: [
      { id: 'd-1', title: '第一个题组：数据结构', course: 'CS101', cards: [{ id: 'c1', prompt: 'P1', answer: 'A1' }] },
      { id: 'd-2', title: '第二个题组：操作系统', course: 'CS101', cards: [{ id: 'c2', prompt: 'P2', answer: 'A2' }] },
      { id: 'd-3', title: '第三个题组：计算机网络', course: 'CS101', cards: [{ id: 'c3', prompt: 'P3', answer: 'A3' }] },
    ],
    courses: [{ id: 'cs101', name: 'CS101' }],
    today: { due: 3, new: 0, weak: 0, done: 0 },
    progress: {
      'd-1': { total: 1, due: 1, mastered: 0, learning: 0, new: 0, weak: 0 },
      'd-2': { total: 1, due: 1, mastered: 0, learning: 0, new: 0, weak: 0 },
      'd-3': { total: 1, due: 1, mastered: 0, learning: 0, new: 0, weak: 0 },
    },
    inbox: [],
  };

  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name) => {
      if (name === 'study.session.list') return { ok: true, value: { sessions: [], total: 0 } };
      if (name === 'study.session.get') return { ok: true, value: null };
      if (name === 'daily.plan.get') return { ok: true, value: { plan: null } };
      return { ok: true, value: {} };
    },
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, dismissedBriefingDate: new Date().toISOString().slice(0, 10) },
    snapshot,
    page: 'library',
    course: null,
    toasts: [],
  });

  const h = createHarness(
    React.createElement(
      Box,
      { width: 120, height: 34 },
      React.createElement(LibraryView, {
        host,
        width: 116,
        height: 32,
        isActive: true,
      }),
    ),
  );
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('第一个题组') && s.includes('第二个题组'), 4000, 'library decks rendered');
  await new Promise((r) => setTimeout(r, 40));

  // Move cursor to 2nd deck via 'j' and confirm detail panel switched to 2nd deck
  h.write('j');
  await h.waitFor((s) => s.includes('▤ 第二个题组：操作系统'), 3000, '2nd deck selected in detail panel');
  await new Promise((r) => setTimeout(r, 40));

  // Press 'g' to open Guided Study -> MUST target 2nd deck, NOT jump cursor to 1st deck!
  h.write('g');
  const modalFrame = await h.waitFor(
    (s) => s.includes('新建带学目标'),
    5000,
    'guided study modal opened',
  );
  assert.ok(
    modalFrame.includes('为「第二个题组：操作系统」'),
    `GuidedStudyModal must target 2nd deck, NOT 1st deck! Frame:\n${modalFrame}`,
  );

  // Close modal with Esc -> cursor must still be on 2nd deck (detail pane title shows 2nd deck)
  h.write('\x1b');
  const afterClose = await h.waitFor((s) => s.includes('题量分布') && !s.includes('新建带学目标'), 4000, 'back to library');
  assert.ok(afterClose.includes('▤ 第二个题组：操作系统'), `after closing GuidedStudyModal, cursor must remain on 2nd deck:\n${afterClose}`);
});
