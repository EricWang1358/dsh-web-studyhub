// Round 87 comprehensive behavior & layout tests:
// - Track A6: Compact / Relaxed spacing density (`resolveDensitySpacing`, live `<Panel>` paddingX response,
//             default relaxed, and `/density` command in CommandPalette)
// - Track C4: OSC 2 terminal title progress & OSC 9 completion notifications (`terminal-title.ts` safe
//             emission, control-char stripping, NO_COLOR/asciiMode/TERM=dumb/non-TTY fallback)
// - Track B5: Home "Today" Quick-Launch Hub (`today-hub.ts` counters + clickable/1-key strip on LibraryView
//             at 120x36 & 80x24 ASCII)
// node --test tests/round-87-ux.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Text, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  layoutMod,
  panelMod,
  titleMod,
  hubMod,
  { LibraryView },
  storeMod,
] = await Promise.all([
  import('../src/components/Layout.tsx'),
  import('../src/components/Panel.tsx'),
  import('../src/render/terminal-title.ts'),
  import('../src/views/library/today-hub.ts'),
  import('../src/views/library/LibraryView.tsx'),
  import('../src/state/store.ts'),
]);

const { resolveDensitySpacing } = layoutMod;
const { Panel } = panelMod;
const {
  sanitizeOscText,
  supportsOscTitle,
  supportsOscNotify,
  formatOsc2Title,
  formatOsc9Notification,
  buildReviewWindowTitle,
  writeTerminalTitle,
  writeTerminalNotification,
} = titleMod;
const { buildTodayHubMetrics, buildTodayHubItems } = hubMod;
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

describe('Round 87 Track A6 — Compact / Relaxed spacing density', () => {
  test('defaults to relaxed spacing and toggles live Panel horizontal padding via compactMode', async () => {
    const relaxed = resolveDensitySpacing(false);
    const compact = resolveDensitySpacing(true);
    assert.equal(relaxed.mode, 'relaxed');
    assert.equal(relaxed.panelPaddingX, 1);
    assert.equal(relaxed.sectionGap, 1);
    assert.equal(compact.mode, 'compact');
    assert.equal(compact.panelPaddingX, 0);
    assert.equal(compact.sectionGap, 0);

    // Relaxed panel adds 1-col inner horizontal padding (`| Body`)
    useTuiStore.setState({
      preferences: { ...useTuiStore.getState().preferences, asciiMode: true, compactMode: false },
    });
    const tty1 = createTtyHarness(40, 6);
    const p1 = render(
      React.createElement(Panel, { title: 'Demo', width: 24, height: 4 }, React.createElement(Text, null, 'Body')),
      { stdout: tty1.stdout, stdin: tty1.stdin, exitOnCtrlC: false, interactive: true },
    );
    const out1 = await tty1.waitFor((s) => s.includes('Body'));
    assert.match(out1, /\| Body/, 'Relaxed Panel should have 1-space left padding');
    p1.unmount();

    // Compact panel removes horizontal padding (`|Body`)
    useTuiStore.setState({
      preferences: { ...useTuiStore.getState().preferences, asciiMode: true, compactMode: true },
    });
    const tty2 = createTtyHarness(40, 6);
    const p2 = render(
      React.createElement(Panel, { title: 'Demo', width: 24, height: 4 }, React.createElement(Text, null, 'Body')),
      { stdout: tty2.stdout, stdin: tty2.stdin, exitOnCtrlC: false, interactive: true },
    );
    const out2 = await tty2.waitFor((s) => s.includes('Body'));
    assert.match(out2, /\|Body/, 'Compact Panel should have 0-space left padding');
    p2.unmount();

    // Restore default relaxed
    useTuiStore.setState({
      preferences: { ...useTuiStore.getState().preferences, compactMode: false },
    });
  });
});

describe('Round 87 Track C4 — OSC 2 terminal title & OSC 9 completion notifications', () => {
  test('emits sanitized OSC 2/9 sequences on capable TTYs and degrades safely under NO_COLOR/ascii/dumb/non-TTY', () => {
    assert.equal(supportsOscTitle({ env: { TERM: 'xterm-256color' }, isTTY: true }), true);
    assert.equal(supportsOscTitle({ env: { TERM: 'dumb' }, isTTY: true }), false);
    assert.equal(supportsOscTitle({ env: { NO_COLOR: '1' }, isTTY: true }), false);
    assert.equal(supportsOscTitle({ env: {}, isTTY: true, asciiMode: true }), false);
    assert.equal(supportsOscTitle({ env: {}, isTTY: false }), false);

    assert.equal(supportsOscNotify({ env: { WT_SESSION: '1' }, isTTY: true }), true);
    assert.equal(supportsOscNotify({ env: { TERM_PROGRAM: 'WezTerm' }, isTTY: true }), true);
    assert.equal(supportsOscNotify({ env: { WT_SESSION: '1', NO_COLOR: '1' }, isTTY: true }), false);
    assert.equal(supportsOscNotify({ env: { WT_SESSION: '1' }, isTTY: true, asciiMode: true }), false);

    // Control-char sanitization prevents escape injection
    assert.equal(sanitizeOscText('Hello\x07\x1b[31mWorld\n!'), 'Hello [31mWorld !');
    const title = buildReviewWindowTitle({ at: 3, total: 20, title: 'Linear Algebra', lang: 'zh' });
    assert.equal(title, 'StudyHub · 刷题 3/20 · Linear Algebra');
    assert.equal(formatOsc2Title(title), `\x1b]2;${title}\x07`);
    assert.equal(formatOsc9Notification('Task Done'), '\x1b]9;Task Done\x07');

    const written = [];
    const fakeStream = { isTTY: true, write: (s) => written.push(s) };
    assert.equal(writeTerminalTitle(title, { stream: fakeStream, env: { TERM: 'xterm-256color' } }), true);
    assert.equal(writeTerminalNotification('Done!', { stream: fakeStream, env: { WT_SESSION: '1' } }), true);
    assert.deepEqual(written, [`\x1b]2;${title}\x07`, '\x1b]9;Done!\x07']);

    // asciiMode skips writing cleanly
    assert.equal(writeTerminalTitle(title, { stream: fakeStream, asciiMode: true }), false);
    assert.equal(written.length, 2);
  });
});

describe('Round 87 Track B5 — Home Today Quick-Launch Hub', () => {
  test('aggregates Resume / Due / Wrong / Todo counters and renders cleanly on LibraryView at 120x36 & 80x24', async () => {
    const snapshot = {
      decks: [
        { id: 'd1', title: 'Organic Chem', due: 7, wrong: 3, count: 20 },
        { id: 'd2', title: 'Biochem', due: 4, wrong: 2, count: 15 },
      ],
      boardTasks: [
        { id: 't1', status: 'todo' },
        { id: 't2', status: 'doing' },
        { id: 't3', status: 'done' },
      ],
      today: { due: 11, reviewed: 2, streak: 5 },
      progress: {},
    };
    const metrics = buildTodayHubMetrics({ snapshot, course: null, activeRunId: 'run-9' });
    assert.deepEqual(metrics, { hasResume: true, due: 11, wrong: 5, todo: 2 });

    const items = buildTodayHubItems(metrics, 'zh');
    assert.deepEqual(
      items.map((x) => `${x.key}:${x.label}`),
      ['r:继续练习', 'Enter:到期复习(11)', '4:错题巩固(5)', 'b:今日待办(2)'],
    );

    const host = { async call() { return { ok: true, value: {} }; } };
    useTuiStore.setState({
      page: 'library',
      activeRunId: 'run-9',
      preferences: {
        ...useTuiStore.getState().preferences,
        language: 'zh',
        asciiMode: true,
        compactMode: false,
        proactiveHints: false,
      },
      snapshot,
    });

    const wideTty = createTtyHarness(120, 36);
    const wide = render(React.createElement(LibraryView, { host, width: 116, height: 34, isActive: true }), {
      stdout: wideTty.stdout,
      stdin: wideTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    const wideOut = await wideTty.waitFor((s) => s.includes('今日一键直达') && s.includes('到期复习(11)'));
    assert.match(wideOut, /\[r\] 继续练习/);
    assert.match(wideOut, /\[Enter\] 到期复习\(11\)/);
    assert.match(wideOut, /\[4\] 错题巩固\(5\)/);
    assert.match(wideOut, /\[b\] 今日待办\(2\)/);
    wide.unmount();

    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(React.createElement(LibraryView, { host, width: 76, height: 22, isActive: true }), {
      stdout: narrowTty.stdout,
      stdin: narrowTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    const narrowOut = await narrowTty.waitFor((s) => s.includes('Organic Chem'));
    assert.ok(narrowOut.length > 0);
    narrow.unmount();
  });

  test('#1342: header dueToday, daily briefing, today hub, and deck list share one consistent due source (progress.due, excluding system decks & unstudied new cards)', async () => {
    const [{ dueToday }, { buildDailyBriefing }] = await Promise.all([
      import('../src/shell/data.ts'),
      import('../src/views/library/daily-briefing.ts'),
    ]);

    const sampleLikeSnap = {
      today: { due: 2, reviewed: 0, goal: 20 },
      decks: [
        { id: 'd1', title: '示例 · 设计模式', course: '示例课', due: 4, count: 9, wrong: 2 },
        { id: 'd2', title: '示例 · 案例', course: '示例课', due: 1, count: 2, wrong: 1 },
        { id: 'sys1', title: '系统题组', course: '示例课', systemKind: 'onboarding', due: 5, count: 5 },
      ],
      progress: {
        d1: { due: 2, counts: { new: 2, weak: 2 } },
        d2: { due: 1, counts: { new: 0, weak: 1 } },
        sys1: { due: 5, counts: { new: 0, weak: 0 } },
      },
    };

    const headerDue = dueToday(sampleLikeSnap, '示例课');
    const hub = buildTodayHubMetrics({ snapshot: sampleLikeSnap, course: '示例课', activeRunId: null });
    const brief = buildDailyBriefing({ snapshot: sampleLikeSnap, course: '示例课', lang: 'zh', now: new Date('2026-06-01T10:00:00Z') });

    assert.equal(headerDue, 3, 'dueToday must sum progress[deck].due for active non-system decks (2 + 1 = 3)');
    assert.equal(hub.due, headerDue, 'Today Hub due count must match header dueToday');
    assert.ok(brief && brief.headline.includes('(2 题到期)'), `Briefing should show top deck due=2, got: ${brief?.headline}`);
    assert.ok(brief && brief.reason.includes('共 3 题到期'), `Briefing total should match header due=3, got: ${brief?.reason}`);

    // When all reviewed due cards are cleared (progress.due = 0) while deck.due still counts unstudied new cards,
    // daily briefing must reach Priority 3 (new cards) instead of claiming cards are due.
    const onlyNewSnap = {
      today: { due: 0, reviewed: 1, goal: 20 },
      decks: [{ id: 'd-new', title: '新章节', course: '示例课', due: 5, count: 5, wrong: 0 }],
      progress: { 'd-new': { due: 0, counts: { new: 5, weak: 0 } } },
    };
    assert.equal(dueToday(onlyNewSnap, '示例课'), 0);
    assert.equal(buildTodayHubMetrics({ snapshot: onlyNewSnap, course: '示例课', activeRunId: null }).due, 0);
    const newBrief = buildDailyBriefing({ snapshot: onlyNewSnap, course: '示例课', lang: 'zh', now: new Date('2026-06-01T10:00:00Z') });
    assert.ok(newBrief && !newBrief.headline.includes('题到期'), `Expected Priority 3 new-card brief, got: ${newBrief?.headline}`);
  });
});
