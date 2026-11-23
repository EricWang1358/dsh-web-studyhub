// Round 85 comprehensive behavior & layout tests:
// - Track A4: VirtualList partial row refresh (moving cursor re-renders only the 2 changed rows, not all visible rows)
// - Track C3: Flicker-free terminal resize coalescer (`createResizeCoalescer` coalesces burst SIGWINCH into 1 trailing commit)
// - Track D2: Proactive Daily Study Briefing (`buildDailyBriefing` priority, disable toggle, 1/day dismissal persistence,
//             and calm non-interrupting inline banner on LibraryView at 120x36 & 80x24 ASCII)
// node --test tests/round-85-ux.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Text, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
const tempDirs = [];
after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const [
  vlistMod,
  resizeMod,
  briefMod,
  prefsMod,
  { LibraryView },
  storeMod,
] = await Promise.all([
  import('../src/components/VirtualList.tsx'),
  import('../src/components/resize.ts'),
  import('../src/views/library/daily-briefing.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/views/library/LibraryView.tsx'),
  import('../src/state/store.ts'),
]);

const { VirtualList } = vlistMod;
const { createResizeCoalescer, clampDimensions, resolveResizeDebounceMs } = resizeMod;
const { buildDailyBriefing, formatLocalDateKey } = briefMod;
const { saveTuiPreferences, loadTuiPreferences } = prefsMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createTtyHarness(columns, rows) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns, rows });
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    stdout,
    stdin,
    getPlain: () => stripAnsi(output),
    async waitFor(pred, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const plain = stripAnsi(output);
        if (pred(plain)) return plain;
        await wait(20);
      }
      throw new Error(`waitFor timed out. Last output:\n${stripAnsi(output).slice(-800)}`);
    },
  };
}

describe('Round 85 Track A4 — VirtualList partial row refresh', () => {
  test('moving cursor within viewport re-renders only the 2 changed rows instead of all visible rows', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, label: `Deck Item #${i}` }));
    const renderCounts = new Map();
    const renderItem = (item, ctx) => {
      renderCounts.set(item.id, (renderCounts.get(item.id) || 0) + 1);
      return React.createElement(Text, null, `${ctx.selected ? '>' : ' '} ${item.label}`);
    };
    const keyExtractor = (item) => item.id;

    const tty = createTtyHarness(80, 24);
    const inst = render(
      React.createElement(VirtualList, {
        items,
        height: 10,
        width: 50,
        isActive: true,
        keyExtractor,
        renderItem,
      }),
      { stdout: tty.stdout, stdin: tty.stdin, exitOnCtrlC: false },
    );

    await tty.waitFor((s) => s.includes('> Deck Item #0'));
    const initialCalls = [...renderCounts.values()].reduce((a, b) => a + b, 0);
    assert.equal(initialCalls, 10, 'Initial mount should render only the 10 visible rows');

    renderCounts.clear();
    tty.stdin.write('j');
    await tty.waitFor((s) => s.includes('> Deck Item #1'));
    await wait(30);

    const deltaCalls = [...renderCounts.values()].reduce((a, b) => a + b, 0);
    assert.equal(deltaCalls, 2, `Cursor move should only re-render 2 rows (prev & next), got ${deltaCalls}`);
    assert.equal(renderCounts.get('row-0'), 1);
    assert.equal(renderCounts.get('row-1'), 1);
    assert.equal(renderCounts.get('row-5'), undefined, 'Unchanged visible rows must NOT re-render');

    inst.unmount();
  });
});

describe('Round 85 Track C3 — Flicker-free terminal resize coalescer', () => {
  test('coalesces rapid burst resize events into 1 trailing commit and deduplicates unchanged sizes', async () => {
    const commits = [];
    const c = createResizeCoalescer({ columns: 120, rows: 36 }, (next) => commits.push(next), 35);

    // Simulate 25 rapid drag ticks in < 10ms
    for (let i = 1; i <= 25; i += 1) {
      c.push(120 - i, 36 - Math.floor(i / 5));
    }
    assert.equal(commits.length, 0, 'Burst events must not commit synchronously before debounce settles');

    await wait(65);
    assert.equal(commits.length, 1, '25 burst ticks should coalesce into exactly 1 trailing commit');
    assert.deepEqual(commits[0], { columns: 95, rows: 31 });

    // Moving away and back to already-committed size cancels redundant commit
    c.push(100, 31);
    c.push(95, 31);
    await wait(65);
    assert.equal(commits.length, 1, 'Returning to committed size must produce 0 extra commits');

    // Dispose cancels pending timer cleanly
    c.push(80, 24);
    c.dispose();
    await wait(65);
    assert.equal(commits.length, 1, 'dispose() must cancel pending commit');

    // Clamping & env override parsing
    assert.deepEqual(clampDimensions(5, 2), { columns: 20, rows: 6 });
    assert.equal(resolveResizeDebounceMs({ STUDYHUB_TUI_RESIZE_DEBOUNCE_MS: '0' }), 0);
    assert.equal(resolveResizeDebounceMs({ STUDYHUB_TUI_RESIZE_DEBOUNCE_MS: '80' }), 80);
  });
});

describe('Round 85 Track D2 — Proactive Daily Study Briefing', () => {
  test('prioritizes due > weak > new, honors proactiveHints=false & daily dismissal, and persists in tui.json', async () => {
    const today = new Date(2026, 4, 15, 9, 0, 0);
    const todayKey = formatLocalDateKey(today);

    const dueSnap = {
      decks: [
        { id: 'd1', title: '微积分', due: 3, wrong: 1, newCount: 5 },
        { id: 'd2', title: '线性代数', due: 12, wrong: 2, newCount: 0 },
      ],
    };
    const dueBrief = buildDailyBriefing({ snapshot: dueSnap, course: null, lang: 'zh', now: today });
    assert.ok(dueBrief);
    assert.match(dueBrief.headline, /线性代数.*12 题到期/);
    assert.equal(dueBrief.target.kind, 'deck');
    assert.equal(dueBrief.target.deckId, 'd2');

    // Disable toggle must suppress briefing completely
    assert.equal(
      buildDailyBriefing({ snapshot: dueSnap, course: null, lang: 'zh', proactiveHints: false, now: today }),
      null,
    );

    // Rate limit: dismissed today -> null; dismissed yesterday -> shown
    assert.equal(
      buildDailyBriefing({ snapshot: dueSnap, course: null, lang: 'zh', dismissedBriefingDate: todayKey, now: today }),
      null,
    );
    assert.ok(
      buildDailyBriefing({ snapshot: dueSnap, course: null, lang: 'zh', dismissedBriefingDate: '2026-05-14', now: today }),
    );

    // Priority 2: weak cards when due === 0
    const weakBrief = buildDailyBriefing({
      snapshot: { decks: [{ id: 'd3', title: '概率论', due: 0, wrong: 5, newCount: 4 }] },
      course: null,
      lang: 'zh',
      now: today,
    });
    assert.ok(weakBrief);
    assert.match(weakBrief.headline, /概率论.*5 道薄弱错题/);

    // Priority 3: new cards when due === 0 & wrong === 0
    const newBrief = buildDailyBriefing({
      snapshot: { decks: [{ id: 'd4', title: '离散数学', due: 0, wrong: 0, newCount: 8 }], today: { reviewed: 2, goal: 20 } },
      course: null,
      lang: 'zh',
      now: today,
    });
    assert.ok(newBrief);
    assert.match(newBrief.headline, /离散数学.*8 题待学/);
    assert.match(newBrief.reason, /2\/20/);

    // Persistence round-trip in tui.json
    const dir = await mkdtemp(join(tmpdir(), 'studyhub-r85-prefs-'));
    tempDirs.push(dir);
    await saveTuiPreferences({ dismissedBriefingDate: todayKey }, { env: { DSH_HOME: dir } });
    const loaded = await loadTuiPreferences({ env: { DSH_HOME: dir } });
    assert.equal(loaded.dismissedBriefingDate, todayKey);
  });

  test('LibraryView renders calm inline briefing at 120x36 & 80x24 ASCII and supports [B] accept & [Z] dismiss', async () => {
    const snapshot = {
      decks: [
        { id: 'deck-calc', title: 'Calculus Ch1', due: 2, wrong: 0, newCount: 0, count: 10 },
        { id: 'deck-la', title: 'Linear Algebra', due: 9, wrong: 1, newCount: 0, count: 15 },
      ],
      today: { due: 11, reviewed: 4, streak: 3 },
      progress: {},
    };
    const host = {
      async call() {
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      page: 'library',
      preferences: {
        ...useTuiStore.getState().preferences,
        language: 'zh',
        asciiMode: true,
        proactiveHints: true,
        dismissedBriefingDate: undefined,
      },
      snapshot,
      navContext: null,
    });

    // 120x36 ASCII snapshot + [Z] dismiss
    const wideTty = createTtyHarness(120, 36);
    const wide = render(React.createElement(LibraryView, { host, width: 116, height: 34, isActive: true }), {
      stdout: wideTty.stdout,
      stdin: wideTty.stdin,
      exitOnCtrlC: false,
    });
    const wideText = await wideTty.waitFor((s) => s.includes('今日简报') && s.includes('Linear Algebra'));
    assert.match(wideText, /\[B\] 开始复习/);
    assert.match(wideText, /\[Z\]今日隐藏/);
    assert.ok(wideText.includes('Calculus Ch1'), 'Briefing banner must never cover the deck list');

    // Press [B] -> navigates to review for recommended deck
    wideTty.stdin.write('B');
    await wideTty.waitFor(() => useTuiStore.getState().page === 'review');
    assert.equal(useTuiStore.getState().navContext?.deckId, 'deck-la');

    // Return to library and press [Z] -> dismisses briefing for today
    useTuiStore.setState({ page: 'library' });
    wideTty.stdin.write('Z');
    await wideTty.waitFor(() => Boolean(useTuiStore.getState().preferences.dismissedBriefingDate));
    assert.equal(useTuiStore.getState().preferences.dismissedBriefingDate, formatLocalDateKey());
    wide.unmount();

    // 80x24 compact ASCII snapshot (fresh, not dismissed)
    useTuiStore.setState({
      preferences: {
        ...useTuiStore.getState().preferences,
        dismissedBriefingDate: undefined,
      },
    });
    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(React.createElement(LibraryView, { host, width: 76, height: 22, isActive: true }), {
      stdout: narrowTty.stdout,
      stdin: narrowTty.stdin,
      exitOnCtrlC: false,
    });
    const narrowText = await narrowTty.waitFor((s) => s.includes('今日简报'));
    assert.match(narrowText, /\[B\] 开始复习/);
    narrow.unmount();
  });
});
