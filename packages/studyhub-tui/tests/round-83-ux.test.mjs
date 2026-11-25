// Round 83 comprehensive behavior & layout tests:
// - Track A2: Prose max line width cap (<= 96 cols) & ultrawide centering (`computeProseLayout` / `ProseContainer`)
//             with 80x24, 120x36, and 160x40 ASCII layout snapshots
// - Track B2: CommandPalette recent command pinning across all scopes (all, /, :, @) + fuzzy tie boost
// - Track D1: Proactive 20s stuck nudge (disable switch, max 3/round + 60s cooldown + once/card rate limit,
//             non-interrupting during typing/modals, live ReviewView firing & instant disable)
// node --test tests/round-83-ux.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
const tempDirs = [];
after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const [
  layoutMod,
  paletteMod,
  stuckMod,
  prefsMod,
  { ReviewView },
  storeMod,
] = await Promise.all([
  import('../src/components/Layout.tsx'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/views/review/stuck-nudge.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

const { PROSE_MAX_COLS, computeProseLayout, ProseContainer } = layoutMod;
const { filterPaletteItems, parsePaletteScope } = paletteMod;
const {
  STUCK_NUDGE_DELAY_MS,
  MAX_STUCK_NUDGES_PER_ROUND,
  STUCK_NUDGE_COOLDOWN_MS,
  shouldScheduleStuckNudge,
  buildStuckNudgeMessage,
} = stuckMod;
const { saveTuiPreferences, loadTuiPreferences } = prefsMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function createInkHarness(element, { cols = 120, rows = 36 } = {}) {
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
    waitFor: (predicate, timeoutMs = 2000) => {
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
    page: 'review',
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
    practiceStack: [],
    pendingPracticeRestore: null,
    assistantOpen: false,
    assistantFocused: false,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantFullscreen: false,
    assistantCardContext: null,
    snapshot: { courses: [{ id: 'c1', name: '操作系统' }], decks: [], sources: [], jobs: [] },
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
      proactiveHints: true,
    },
    ...overrides,
  });
}

describe('Round 83 Track A2: Prose 96-col Max Width & Ultrawide Centering', () => {
  test('1. computeProseLayout keeps <=96 full-width and centers >96 ultrawide terminals symmetrically', () => {
    assert.equal(PROSE_MAX_COLS, 96);
    assert.deepEqual(computeProseLayout(76), { proseWidth: 76, marginLeft: 0, centered: false });
    assert.deepEqual(computeProseLayout(96), { proseWidth: 96, marginLeft: 0, centered: false });
    assert.deepEqual(computeProseLayout(140), { proseWidth: 96, marginLeft: 22, centered: true });
    assert.deepEqual(computeProseLayout(160), { proseWidth: 96, marginLeft: 32, centered: true });
  });

  test('2. ProseContainer renders cleanly across 80x24, 120x36, and 160x40 ASCII snapshots with centered ultrawide margin', async () => {
    const longProse = 'X'.repeat(110);
    for (const [cols, rows, expectIndent] of [
      [80, 24, 0],
      [120, 36, 12],
      [160, 40, 32],
    ]) {
      const h = createInkHarness(
        React.createElement(
          Box,
          { width: cols, height: 6 },
          React.createElement(ProseContainer, { width: cols }, (pw) =>
            React.createElement(Text, null, `${pw}:${longProse.slice(0, Math.min(pw - 5, 40))}`),
          ),
        ),
        { cols, rows },
      );
      try {
        const expectedPw = Math.min(cols, 96);
        const frame = await h.waitFor((s) => s.includes(`${expectedPw}:XXXX`));
        const firstLine = frame.split('\n').find((l) => l.includes(`${expectedPw}:XXXX`)) ?? '';
        const leadingSpaces = firstLine.length - firstLine.trimStart().length;
        assert.equal(leadingSpaces, expectIndent, `Expected leading margin ${expectIndent} at ${cols}x${rows}, got ${leadingSpaces}`);
      } finally {
        h.cleanup();
      }
    }
  });
});

describe('Round 83 Track B2: CommandPalette Recent Pinning Across Scopes', () => {
  const sampleItems = [
    { id: 'cmd:sample', label: '/sample', category: '命令', action: () => {} },
    { id: 'cmd:due', label: '/due', category: '命令', action: () => {} },
    { id: 'cmd:guide', label: '/guide', category: '命令', action: () => {} },
    { id: 'cmd:proactive', label: '/proactive', category: '命令', action: () => {} },
    { id: 'page:library', label: '学习库', category: '页面', action: () => {} },
    { id: 'page:wrongbook', label: '错题本', category: '页面', action: () => {} },
    { id: 'page:sources', label: '资料', category: '页面', action: () => {} },
    { id: 'course:os', label: '操作系统', category: '课程', action: () => {} },
    { id: 'course:net', label: '计算机网络', category: '课程', action: () => {} },
  ];

  test('1. Pins recently used commands in MRU order for empty all, /, :, and @ scopes', () => {
    const recent = ['cmd:proactive', 'page:wrongbook', 'cmd:guide', 'course:net'];

    // `/` command scope with empty term pins `/proactive` then `/guide` at the very top with category '最近'
    const slashRes = filterPaletteItems(sampleItems, parsePaletteScope('/'), recent, 'zh');
    assert.equal(slashRes[0].id, 'cmd:proactive');
    assert.equal(slashRes[0].category, '最近');
    assert.equal(slashRes[1].id, 'cmd:guide');
    assert.equal(slashRes[1].category, '最近');

    // `:` page scope pins `page:wrongbook` first
    const pageRes = filterPaletteItems(sampleItems, parsePaletteScope(':'), recent, 'zh');
    assert.equal(pageRes[0].id, 'page:wrongbook');
    assert.equal(pageRes[0].category, '最近');

    // `@` course scope pins `course:net` first
    const courseRes = filterPaletteItems(sampleItems, parsePaletteScope('@'), recent, 'zh');
    assert.equal(courseRes[0].id, 'course:net');
    assert.equal(courseRes[0].category, '最近');
  });
});

describe('Round 83 Track D1: Proactive 20s Stuck Nudge (Opt-out + Rate Limit + Non-Interrupting)', () => {
  test('1. Pure guardrail enforces disable switch, max 3/round, 60s cooldown, once/card, and never during editing/modals', () => {
    assert.equal(STUCK_NUDGE_DELAY_MS, 20_000);
    assert.equal(MAX_STUCK_NUDGES_PER_ROUND, 3);
    assert.equal(STUCK_NUDGE_COOLDOWN_MS, 60_000);

    const base = {
      enabled: true,
      isActive: true,
      revealed: false,
      hasFeedback: false,
      isEditing: false,
      anyModalOpen: false,
      cardId: 'c1',
      nudgedCardIds: new Set(),
      roundNudgeCount: 0,
      lastNudgeAt: null,
      now: 100_000,
    };
    assert.equal(shouldScheduleStuckNudge(base), true);
    assert.equal(shouldScheduleStuckNudge({ ...base, enabled: false }), false, 'Disable switch must block nudge');
    assert.equal(shouldScheduleStuckNudge({ ...base, isEditing: true }), false, 'Must NEVER interrupt typing');
    assert.equal(shouldScheduleStuckNudge({ ...base, anyModalOpen: true }), false, 'Must NEVER fire while modal open');
    assert.equal(shouldScheduleStuckNudge({ ...base, revealed: true }), false);
    assert.equal(shouldScheduleStuckNudge({ ...base, nudgedCardIds: new Set(['c1']) }), false, 'At most once per card');
    assert.equal(shouldScheduleStuckNudge({ ...base, roundNudgeCount: 3 }), false, 'Rate limit max 3 per round');
    assert.equal(shouldScheduleStuckNudge({ ...base, lastNudgeAt: 70_000, now: 100_000 }), false, '60s cooldown enforced');
    assert.equal(shouldScheduleStuckNudge({ ...base, lastNudgeAt: 30_000, now: 100_000 }), true);
    assert.ok(buildStuckNudgeMessage('zh', true).includes('[t]'));
  });

  test('2. ReviewView shows calm inline stuck nudge after delay, stays silent when disabled, and persists proactiveHints=false in tui.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studyhub-r83-prefs-'));
    tempDirs.push(dir);
    await saveTuiPreferences({ proactiveHints: false }, { env: { DSH_HOME: dir } });
    const loaded = await loadTuiPreferences({ env: { DSH_HOME: dir } });
    assert.equal(loaded.proactiveHints, false, 'proactiveHints must persist cleanly in tui.json');

    const mockRun = {
      id: 'run-r83',
      title: 'Stuck Nudge Test',
      index: 0,
      total: 3,
      answered: 0,
      revealed: false,
      card: {
        id: 'card-stuck-1',
        deckId: 'd1',
        kind: 'single',
        prompt: '请选出正确答案',
        options: [
          { id: 'A', text: 'OptA' },
          { id: 'B', text: 'OptB' },
        ],
      },
    };
    const mockHost = {
      call: async (name) => (name === 'review.start' || name === 'review.get' ? { ok: true, value: mockRun } : { ok: true, value: {} }),
      getSnapshot: async () => ({ decks: [], courses: [], jobs: [] }),
    };

    // 2a) Enabled -> fires calmly after stuckNudgeDelayMs without stealing focus
    resetStore({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, proactiveHints: true } });
    const h = createInkHarness(
      React.createElement(ReviewView, {
        host: mockHost,
        width: 100,
        height: 24,
        isActive: true,
        stuckNudgeDelayMs: 60,
      }),
      { cols: 100, rows: 24 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('卡住了？') && s.includes('[t] 带学提示'));
      assert.ok(frame.includes('OptA'), 'Calm inline stuck nudge must never cover question/options');
    } finally {
      h.cleanup();
    }

    // 2b) Disabled (`proactiveHints: false`) -> NEVER fires!
    resetStore({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, proactiveHints: false } });
    const hOff = createInkHarness(
      React.createElement(ReviewView, {
        host: mockHost,
        width: 100,
        height: 24,
        isActive: true,
        stuckNudgeDelayMs: 40,
      }),
      { cols: 100, rows: 24 },
    );
    try {
      await hOff.waitFor((s) => s.includes('OptA'));
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(hOff.latest().includes('卡住了？'), false, 'Disabled proactiveHints must never display stuck nudge');
    } finally {
      hOff.cleanup();
    }
  });
});
