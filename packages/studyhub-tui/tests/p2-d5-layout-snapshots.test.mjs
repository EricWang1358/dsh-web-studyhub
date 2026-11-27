// P2 (#1354 D5): Authoritative Breakpoints, <Prose>/<ScrollArea>/<ChromeLabel> Primitives,
// 5-View Migration Guardrails (Review -> Reader -> Library -> Sources -> Tasks),
// and 80x24 / 120x36 Rendered Layout Snapshots inside AppShell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { render, Text } from 'ink';
import { register } from 'tsx/esm/api';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();
const temps = createTempTracker('studyhub-p2-d5-');
after(async () => {
  await temps.cleanup();
  disposeTerminalPool();
  unregisterTsx?.();
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForFrame(harness, predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = harness.lastFrame();
    if (predicate(frame)) return frame;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for ${label}.\nLast frame:\n${harness.lastFrame()}`);
}

function createScrollHarness(element, { cols = 60, rows = 10 } = {}) {
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
    const plain = String(chunk).replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '');
    if (plain.trim().length > 0) frames.push(plain);
  });

  const inst = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
  return { inst, stdin, stdout, lastFrame: () => frames.at(-1) ?? '' };
}

describe('P2 (#1354 D5): Breakpoints, Typography/Scroll Primitives & 80x24 / 120x36 Layout Snapshots', () => {
  test('1. src/layout/breakpoints.ts defines 4 content-width tiers and guarantees monotonic layout with SideNav & docked Assistant', async () => {
    const bp = await import('../src/layout/breakpoints.ts');
    const tokens = await import('../src/components/layout-tokens.ts');
    const { shellLayout, assistantDockWidth } = await import('../src/shell/AppShell.tsx');

    // Single source of truth: layout-tokens re-exports breakpoints.ts directly.
    assert.equal(tokens.LAYOUT_BP, bp.LAYOUT_BP);
    assert.equal(tokens.LAYOUT_CHROME, bp.LAYOUT_CHROME);
    assert.equal(tokens.resolveContentTier, bp.resolveContentTier);
    assert.equal(tokens.isViewportTooSmall, bp.isViewportTooSmall);

    // 4 canonical content-width tiers: narrow (<60), compact (60-84), regular (85-119), wide (>=120)
    assert.deepEqual(bp.CONTENT_TIERS, { NARROW_MAX: 59, COMPACT_MAX: 84, REGULAR_MAX: 119 });
    assert.equal(bp.resolveContentTier(40), 'narrow');
    assert.equal(bp.resolveContentTier(59), 'narrow');
    assert.equal(bp.isNarrowContent(59), true);
    assert.equal(bp.isNarrowContent(60), false);

    assert.equal(bp.resolveContentTier(60), 'compact');
    assert.equal(bp.resolveContentTier(84), 'compact');
    assert.equal(bp.isCompactContent(84), true);
    assert.equal(bp.isCompactContent(85), false);

    assert.equal(bp.resolveContentTier(85), 'regular');
    assert.equal(bp.resolveContentTier(119), 'regular');
    assert.equal(bp.isWideContent(119), false);

    assert.equal(bp.resolveContentTier(120), 'wide');
    assert.equal(bp.isWideContent(120), true);

    // Monotonicity sweep (60..240 cols): both raw shell AND docked-assistant content width transition monotonically.
    let enteredSplit = false;
    let enteredDockedSplit = false;
    for (let cols = 60; cols <= 240; cols += 1) {
      const { navW, contentW } = shellLayout(cols, 36, { sidebarCollapsed: false, showKeyHints: true });
      const canSplit = contentW >= bp.LAYOUT_BP.SPLIT_DEFAULT;
      if (canSplit) enteredSplit = true;
      assert.ok(!enteredSplit || canSplit, `Non-monotonic split eligibility at cols=${cols} (contentW=${contentW})`);

      const availRight = cols - navW - 2;
      const dockedContentW = Math.max(20, availRight - assistantDockWidth(availRight));
      const canDockedSplit = dockedContentW >= bp.LAYOUT_BP.SPLIT_DEFAULT;
      if (canDockedSplit) enteredDockedSplit = true;
      assert.ok(
        !enteredDockedSplit || canDockedSplit,
        `Non-monotonic docked split eligibility at cols=${cols} (dockedContentW=${dockedContentW})`,
      );
    }
    assert.equal(enteredSplit, true);
    assert.equal(enteredDockedSplit, true);
  });

  test('2. <ScrollArea>, <Prose>, and <ChromeLabel> are exported from layout/ & components/ and <ScrollArea> scrolls only when focused', async () => {
    const layoutMod = await import('../src/layout/index.ts');
    const compMod = await import('../src/components/index.ts');
    const { KeyScopeProvider, useKeyDispatcherBridge } = await import('../src/components/key-dispatcher.ts');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');

    assert.ok(layoutMod.Prose && (typeof layoutMod.Prose === 'function' || typeof layoutMod.Prose.type === 'function'));
    assert.ok(layoutMod.ScrollArea && (typeof layoutMod.ScrollArea === 'function' || typeof layoutMod.ScrollArea.type === 'function'));
    assert.ok(layoutMod.ChromeLabel && (typeof layoutMod.ChromeLabel === 'function' || typeof layoutMod.ChromeLabel.type === 'function'));
    assert.equal(compMod.Prose, layoutMod.Prose);
    assert.equal(compMod.ScrollArea, layoutMod.ScrollArea);
    assert.equal(compMod.ChromeLabel, layoutMod.ChromeLabel);

    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true } });

    const longLines = Array.from({ length: 20 }, (_, i) => `LINE_${String(i + 1).padStart(2, '0')} learner content row`);

    function BridgeHost({ isActive }) {
      useKeyDispatcherBridge();
      return React.createElement(
        KeyScopeProvider,
        null,
        React.createElement(layoutMod.ScrollArea, {
          lines: longLines,
          width: 48,
          height: 5,
          isActive,
          ascii: true,
        }),
      );
    }

    // Active ScrollArea scrolls on key input
    const activeH = createScrollHarness(React.createElement(BridgeHost, { isActive: true }), { cols: 50, rows: 8 });
    try {
      await sleep(30);
      assert.ok(activeH.lastFrame().includes('LINE_01'), `Initial ScrollArea must show LINE_01:\n${activeH.lastFrame()}`);
      assert.ok(!activeH.lastFrame().includes('LINE_08'), 'Initial 5-row ScrollArea must not show LINE_08 yet');

      for (let step = 0; step < 5; step += 1) {
        activeH.stdin.write('j');
        await sleep(15);
      }
      await sleep(30);
      assert.ok(
        activeH.lastFrame().includes('LINE_06') || activeH.lastFrame().includes('LINE_07'),
        `Focused ScrollArea must scroll down on j keys:\n${activeH.lastFrame()}`,
      );
    } finally {
      activeH.inst.unmount();
    }

    // Inactive ScrollArea must NOT consume keys or scroll
    const inactiveH = createScrollHarness(React.createElement(BridgeHost, { isActive: false }), { cols: 50, rows: 8 });
    try {
      await sleep(30);
      assert.ok(inactiveH.lastFrame().includes('LINE_01'));
      for (let step = 0; step < 5; step += 1) {
        inactiveH.stdin.write('j');
        await sleep(15);
      }
      await sleep(30);
      assert.ok(inactiveH.lastFrame().includes('LINE_01'), 'Unfocused ScrollArea must ignore scroll keys');
      assert.ok(!inactiveH.lastFrame().includes('LINE_06'), 'Unfocused ScrollArea must stay at top');
    } finally {
      inactiveH.inst.unmount();
    }
  });

  test('3. ReviewFeedbackSections, LibraryView, and SourcesView wrap diffs/banners/topics without truncation and switch at centralized LAYOUT_BP thresholds', async () => {
    const { LAYOUT_BP } = await import('../src/layout/breakpoints.ts');
    const { KeyScopeProvider, useKeyDispatcherBridge } = await import('../src/components/key-dispatcher.ts');
    const { SplitPane } = await import('../src/components/SplitPane.tsx');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');
    const { ReviewFeedbackHeader, ReviewPostAnswerFooter } = await import('../src/views/review/ReviewFeedbackSections.tsx');
    const { LibraryView } = await import('../src/views/library/LibraryView.tsx');
    const { SourcesView } = await import('../src/views/sources/SourcesView.tsx');

    const prevStore = {
      preferences: useTuiStore.getState().preferences,
      snapshot: useTuiStore.getState().snapshot,
      navContext: useTuiStore.getState().navContext,
    };

    function ViewBridge({ children }) {
      useKeyDispatcherBridge();
      return React.createElement(KeyScopeProvider, null, children);
    }

    const noop = () => {};
    const stubHost = {
      call: async () => ({ ok: true, value: {} }),
      subscribe: () => () => {},
      dispose: async () => {},
      getLibraryRoot: () => '',
    };

    try {
      // 1) ReviewFeedbackHeader: narrow innerW=36 wraps long cloze diff userValue & expected with zero ellipsis truncation
      useTuiStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, proactiveHints: true },
        navContext: {},
      });
      const headerH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(ReviewFeedbackHeader, {
            innerW: 36,
            lang: 'zh',
            asciiMode: false,
            isActive: true,
            gradingBusy: false,
            gradeError: null,
            feedback: null,
            userAnswerText: '',
            canUndo: false,
            clozeBlankDiffs: [
              {
                id: 'blank-wrap-1',
                index: 1,
                userValue: 'DIFF_USER_HEAD virtual memory page table entry translation DIFF_USER_TAIL',
                expected: 'DIFF_EXPECT_HEAD inverted page table hash lookup mechanism DIFF_EXPECT_TAIL',
                matched: false,
              },
            ],
            activeRubric: null,
            gradeResult: null,
            canAckCorrection: false,
            revealed: false,
            referenceAnswer: '',
            activeTranslation: null,
          }),
        ),
        { cols: 44, rows: 16 },
      );
      try {
        const diffFrame = await waitForFrame(
          headerH,
          (f) => f.includes('DIFF_USER_HEAD'),
          'ReviewFeedbackHeader wrapped cloze diff',
        );
        assert.ok(diffFrame.includes('DIFF_USER_TAIL'), `cloze userValue tail must not be truncated:\n${diffFrame}`);
        assert.ok(diffFrame.includes('DIFF_EXPECT_HEAD'), `cloze expected head missing:\n${diffFrame}`);
        assert.ok(diffFrame.includes('DIFF_EXPECT_TAIL'), `cloze expected tail must not be truncated:\n${diffFrame}`);
        assert.ok(!diffFrame.includes('…') && !diffFrame.includes('...'), `cloze diff must not contain ellipsis:\n${diffFrame}`);
      } finally {
        headerH.inst.unmount();
      }

      // 2) ReviewPostAnswerFooter: narrow innerW=36 wraps wrongStreakBanner & fatigueBanner with zero truncation
      const footerBaseProps = {
        innerW: 36,
        lang: 'zh',
        asciiMode: false,
        cardScopeActive: false,
        proactiveHints: true,
        revealed: false,
        citation: null,
        citationUrl: '',
        needsRating: false,
        canRubricGrade: false,
        activeRubric: null,
        intervals: null,
        onClickWrongStreak: noop,
        onDismissFatigue: noop,
        onOpenCitation: noop,
        onRubricGrade: noop,
        onFsrsGrade: noop,
      };

      const streakH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(ReviewPostAnswerFooter, {
            ...footerBaseProps,
            wrongStreakBanner: 'STREAK_HEAD repeated misses on paging translation flow review STREAK_TAIL',
            fatigueBanner: null,
          }),
        ),
        { cols: 44, rows: 12 },
      );
      try {
        const streakFrame = await waitForFrame(
          streakH,
          (f) => f.includes('STREAK_HEAD'),
          'ReviewPostAnswerFooter wrongStreakBanner',
        );
        assert.ok(streakFrame.includes('STREAK_TAIL'), `wrongStreakBanner tail must not be truncated:\n${streakFrame}`);
        assert.ok(!streakFrame.includes('…') && !streakFrame.includes('...'), `wrongStreakBanner must not contain ellipsis:\n${streakFrame}`);
      } finally {
        streakH.inst.unmount();
      }

      const fatigueH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(ReviewPostAnswerFooter, {
            ...footerBaseProps,
            wrongStreakBanner: null,
            fatigueBanner: 'FATIGUE_HEAD long continuous review session consider a short break FATIGUE_TAIL',
          }),
        ),
        { cols: 44, rows: 12 },
      );
      try {
        const fatigueFrame = await waitForFrame(
          fatigueH,
          (f) => f.includes('FATIGUE_HEAD'),
          'ReviewPostAnswerFooter fatigueBanner',
        );
        assert.ok(fatigueFrame.includes('FATIGUE_TAIL'), `fatigueBanner tail must not be truncated:\n${fatigueFrame}`);
        assert.ok(!fatigueFrame.includes('…') && !fatigueFrame.includes('...'), `fatigueBanner must not contain ellipsis:\n${fatigueFrame}`);
      } finally {
        fatigueH.inst.unmount();
      }

      // 3) ReviewPostAnswerFooter: rating header switches at LAYOUT_BP.CONTENT_NARROW (59 vs 60)
      const rateNarrowH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(ReviewPostAnswerFooter, {
            ...footerBaseProps,
            innerW: LAYOUT_BP.CONTENT_NARROW - 1,
            asciiMode: true,
            wrongStreakBanner: null,
            fatigueBanner: null,
            needsRating: true,
          }),
        ),
        { cols: 72, rows: 8 },
      );
      try {
        const narrowRateFrame = await waitForFrame(
          rateNarrowH,
          (f) => f.includes('FSRS评分 [0-5]:'),
          'ReviewPostAnswerFooter narrow rating header (innerW=59)',
        );
        assert.ok(
          !narrowRateFrame.includes('FSRS-6 记忆评分（按数字键 0-5）:'),
          `innerW=${LAYOUT_BP.CONTENT_NARROW - 1} must use compact rating header:\n${narrowRateFrame}`,
        );
      } finally {
        rateNarrowH.inst.unmount();
      }

      const rateRegularH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(ReviewPostAnswerFooter, {
            ...footerBaseProps,
            innerW: LAYOUT_BP.CONTENT_NARROW,
            asciiMode: true,
            wrongStreakBanner: null,
            fatigueBanner: null,
            needsRating: true,
          }),
        ),
        { cols: 72, rows: 8 },
      );
      try {
        const regularRateFrame = await waitForFrame(
          rateRegularH,
          (f) => f.includes('FSRS-6 记忆评分（按数字键 0-5）:'),
          'ReviewPostAnswerFooter regular rating header (innerW=60)',
        );
        assert.ok(
          !regularRateFrame.includes('FSRS评分 [0-5]:'),
          `innerW=${LAYOUT_BP.CONTENT_NARROW} must use full rating header:\n${regularRateFrame}`,
        );
      } finally {
        rateRegularH.inst.unmount();
      }

      // 4) LibraryView: 5 long topics wrap without truncation at 96x28 & SplitPane switches at LAYOUT_BP.SPLIT_DEFAULT (85 vs 86)
      useTuiStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, proactiveHints: false },
        snapshot: {
          decks: [
            {
              id: 'deck-wrap-1',
              title: 'DECK_WRAP_TITLE',
              course: 'CS162',
              cards: [{ id: 'c1' }],
              topics: [
                'TOPIC_FIRST_TOKEN alpha concept',
                'Second architectural pattern module',
                'Third concurrency scheduling layer',
                'Fourth distributed storage engine',
                'Fifth summary TOPIC_LAST_TOKEN',
              ],
            },
          ],
          progress: {
            'deck-wrap-1': {
              total: 5,
              due: 2,
              mastery: 40,
              counts: { new: 2, weak: 1, learning: 1, familiar: 0, mastered: 1 },
            },
          },
          sources: [],
          jobs: [],
          archivedJobs: [],
          drafts: [],
          focus: { courses: ['CS162'] },
        },
        navContext: {},
      });

      const libTopicsH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(LibraryView, { host: stubHost, width: 96, height: 28, isActive: false }),
        ),
        { cols: 100, rows: 30 },
      );
      try {
        const libFrame = await waitForFrame(
          libTopicsH,
          (f) => f.includes('涵盖主题') && f.includes('TOPIC_FIRST_TOKEN'),
          'LibraryView wrapped topics at 96x28',
        );
        assert.ok(libFrame.includes('TOPIC_LAST_TOKEN'), `LibraryView topics tail must wrap instead of truncating:\n${libFrame}`);
        const topicSectionLines = libFrame
          .split('\n')
          .filter((line) => /涵盖主题|TOPIC_FIRST_TOKEN|Second architectural|Third concurrency|Fourth distributed|TOPIC_LAST_TOKEN/.test(line));
        assert.ok(
          topicSectionLines.every((line) => !line.includes('…') && !line.includes('...')),
          `LibraryView topics lines must not contain ellipsis:\n${topicSectionLines.join('\n')}`,
        );
      } finally {
        libTopicsH.inst.unmount();
      }

      const libStackedH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(LibraryView, {
            host: stubHost,
            width: LAYOUT_BP.SPLIT_DEFAULT - 1,
            height: 22,
            isActive: false,
          }),
        ),
        { cols: 90, rows: 24 },
      );
      try {
        const stackedFrame = await waitForFrame(
          libStackedH,
          (f) => f.includes('题组列表') && f.includes('DECK_WRAP_TITLE'),
          'LibraryView stacked at SPLIT_DEFAULT - 1 (85)',
        );
        const listHeaderLine = stackedFrame.split('\n').find((line) => line.includes('题组列表')) ?? '';
        assert.ok(
          !listHeaderLine.includes('DECK_WRAP_TITLE'),
          `LibraryView at width=${LAYOUT_BP.SPLIT_DEFAULT - 1} must stack panes vertically:\n${stackedFrame}`,
        );
      } finally {
        libStackedH.inst.unmount();
      }

      const libDualH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(LibraryView, {
            host: stubHost,
            width: LAYOUT_BP.SPLIT_DEFAULT,
            height: 22,
            isActive: false,
          }),
        ),
        { cols: 90, rows: 24 },
      );
      try {
        const dualFrame = await waitForFrame(
          libDualH,
          (f) => f.includes('题组列表') && f.includes('DECK_WRAP_TITLE'),
          'LibraryView dual-pane at SPLIT_DEFAULT (86)',
        );
        const listHeaderLine = dualFrame.split('\n').find((line) => line.includes('题组列表')) ?? '';
        assert.ok(
          listHeaderLine.includes('DECK_WRAP_TITLE'),
          `LibraryView at width=${LAYOUT_BP.SPLIT_DEFAULT} must render dual panes side-by-side:\n${dualFrame}`,
        );
      } finally {
        libDualH.inst.unmount();
      }

      // Direct SplitPane default threshold check (85 stacked vs 86 dual-pane)
      const splitStackedH = createScrollHarness(
        React.createElement(SplitPane, {
          width: LAYOUT_BP.SPLIT_DEFAULT - 1,
          height: 8,
          narrowMode: 'stack',
          left: ({ narrow }) => React.createElement(Text, null, narrow ? 'LEFT_STACKED' : 'LEFT_DUAL'),
          right: ({ narrow }) => React.createElement(Text, null, narrow ? 'RIGHT_STACKED' : 'RIGHT_DUAL'),
        }),
        { cols: 90, rows: 10 },
      );
      try {
        const splitStacked = await waitForFrame(splitStackedH, (f) => f.includes('LEFT_STACKED'), 'SplitPane stacked at 85');
        assert.ok(splitStacked.includes('RIGHT_STACKED'), `SplitPane at 85 must report narrow=true:\n${splitStacked}`);
      } finally {
        splitStackedH.inst.unmount();
      }

      const splitDualH = createScrollHarness(
        React.createElement(SplitPane, {
          width: LAYOUT_BP.SPLIT_DEFAULT,
          height: 8,
          narrowMode: 'stack',
          left: ({ narrow }) => React.createElement(Text, null, narrow ? 'LEFT_STACKED' : 'LEFT_DUAL'),
          right: ({ narrow }) => React.createElement(Text, null, narrow ? 'RIGHT_STACKED' : 'RIGHT_DUAL'),
        }),
        { cols: 90, rows: 10 },
      );
      try {
        const splitDual = await waitForFrame(splitDualH, (f) => f.includes('LEFT_DUAL'), 'SplitPane dual at 86');
        assert.ok(splitDual.includes('RIGHT_DUAL'), `SplitPane at 86 must report narrow=false:\n${splitDual}`);
      } finally {
        splitDualH.inst.unmount();
      }

      // 5) SourcesView: top bar switches at LAYOUT_BP.SPLIT_COMPACT (83 narrow vs 84 full)
      useTuiStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
        snapshot: {
          sources: [
            {
              id: 'src-bp-1',
              title: '断点测试资料',
              format: 'md',
              chars: 42,
              courses: [],
            },
          ],
          decks: [],
          jobs: [],
          archivedJobs: [],
          focus: { courses: [] },
        },
        navContext: {},
      });

      const srcNarrowH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(SourcesView, {
            host: stubHost,
            width: LAYOUT_BP.SPLIT_COMPACT - 1,
            height: 14,
            isActive: false,
          }),
        ),
        { cols: 90, rows: 16 },
      );
      try {
        const srcNarrow = await waitForFrame(
          srcNarrowH,
          (f) => f.includes('资料') && f.includes('断点测试资料'),
          'SourcesView narrow top bar at SPLIT_COMPACT - 1 (83)',
        );
        assert.ok(
          !srcNarrow.includes('学习资料库'),
          `SourcesView at width=${LAYOUT_BP.SPLIT_COMPACT - 1} must show compact header '资料':\n${srcNarrow}`,
        );
        assert.ok(
          !srcNarrow.includes('[i] 导入'),
          `SourcesView at width=${LAYOUT_BP.SPLIT_COMPACT - 1} must hide [i] 导入 hint:\n${srcNarrow}`,
        );
      } finally {
        srcNarrowH.inst.unmount();
      }

      const srcFullH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(SourcesView, {
            host: stubHost,
            width: LAYOUT_BP.SPLIT_COMPACT,
            height: 14,
            isActive: false,
          }),
        ),
        { cols: 90, rows: 16 },
      );
      try {
        const srcFull = await waitForFrame(
          srcFullH,
          (f) => f.includes('学习资料库') && f.includes('[i] 导入'),
          'SourcesView full top bar at SPLIT_COMPACT (84)',
        );
        assert.ok(srcFull.includes('学习资料库'), `SourcesView at width=${LAYOUT_BP.SPLIT_COMPACT} must show '学习资料库':\n${srcFull}`);
        assert.ok(srcFull.includes('[i] 导入'), `SourcesView at width=${LAYOUT_BP.SPLIT_COMPACT} must show '[i] 导入':\n${srcFull}`);
      } finally {
        srcFullH.inst.unmount();
      }
    } finally {
      useTuiStore.setState(prevStore);
    }
  });

  test('3b. DocumentReader, SourcesView, and TasksView behaviorally clamp and scroll overflow content within viewport bounds', async () => {
    const { KeyScopeProvider, useKeyDispatcherBridge } = await import('../src/components/key-dispatcher.ts');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');
    const { DocumentReader } = await import('../src/views/sources/DocumentReader.tsx');
    const { SourcesView } = await import('../src/views/sources/SourcesView.tsx');
    const { TasksView } = await import('../src/views/tasks/TasksView.tsx');

    const prevStore = {
      preferences: useTuiStore.getState().preferences,
      snapshot: useTuiStore.getState().snapshot,
      navContext: useTuiStore.getState().navContext,
    };

    function ViewBridge({ children }) {
      useKeyDispatcherBridge();
      return React.createElement(KeyScopeProvider, null, children);
    }

    try {
      useTuiStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true, compactMode: true },
        navContext: {},
      });

      // 1) DocumentReader: long page text clamps to viewport height and scrolls on 'j' / PgDn
      const readerText = Array.from({ length: 30 }, (_, i) => `READER_ROW_${String(i + 1).padStart(2, '0')} longform prose`).join('\n\n');
      const readerHost = {
        call: async (action) => {
          if (action === 'materials.document.get') {
            return { ok: true, value: { documentId: 'doc-scroll', title: '长文阅读测试', format: 'md', sources: [{ id: 'src-scroll-1' }] } };
          }
          if (action === 'source.pages') {
            return {
              ok: true,
              value: {
                documentId: 'doc-scroll',
                title: '长文阅读测试',
                pages: '1-1',
                shown: [{ page: 1, sourceId: 'src-scroll-1', text: readerText, chars: readerText.length }],
              },
            };
          }
          return { ok: true, value: {} };
        },
        subscribe: () => () => {},
        dispose: async () => {},
      };

      const readerH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(DocumentReader, {
            host: readerHost,
            sourceId: 'src-scroll-1',
            documentId: 'doc-scroll',
            initialPage: 1,
            initialTitle: '长文阅读测试',
            width: 78,
            height: 14,
            isActive: true,
            onClose: () => {},
          }),
        ),
        { cols: 80, rows: 16 },
      );
      try {
        const initialReader = await waitForFrame(readerH, (f) => f.includes('READER_ROW_01'), 'DocumentReader initial clamped frame');
        assert.ok(!initialReader.includes('READER_ROW_30'), `DocumentReader must clamp overflow tail initially:\n${initialReader}`);
        assert.ok(initialReader.includes('0%'), `DocumentReader must show 0% scroll indicator:\n${initialReader}`);
        assert.ok(initialReader.split('\n').length <= 16, `DocumentReader exceeded viewport height: ${initialReader.split('\n').length}`);

        for (let step = 0; step < 8; step += 1) {
          readerH.stdin.write('j');
          await sleep(15);
        }
        const scrolledReader = await waitForFrame(
          readerH,
          (f) => !f.includes('READER_ROW_01') && /READER_ROW_(?:0[7-9]|1\d|2\d|30)/.test(f),
          'DocumentReader scrolled down via j',
        );
        assert.match(scrolledReader, /\b(?:[1-9]\d?|100)%/, `DocumentReader scroll percentage must advance:\n${scrolledReader}`);
      } finally {
        readerH.inst.unmount();
      }

      // 2) SourcesView: overflow excerpt clamps cleanly inside the detail ScrollArea
      const excerptText = Array.from({ length: 30 }, (_, i) => `EXCERPT_ROW_${String(i + 1).padStart(2, '0')} source detail`).join('\n');
      useTuiStore.setState({
        snapshot: {
          sources: [
            {
              id: 'src-excerpt-1',
              title: '溢出摘录资料',
              format: 'md',
              chars: excerptText.length,
              courses: [],
            },
          ],
          decks: [],
          jobs: [],
          archivedJobs: [],
          focus: { courses: [] },
        },
        navContext: {},
      });
      const sourcesHost = {
        call: async (action) => {
          if (action === 'source.get') {
            return { ok: true, value: { id: 'src-excerpt-1', text: excerptText } };
          }
          return { ok: true, value: {} };
        },
        subscribe: () => () => {},
        dispose: async () => {},
      };

      const sourcesH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(SourcesView, {
            host: sourcesHost,
            width: 108,
            height: 18,
            isActive: true,
          }),
        ),
        { cols: 110, rows: 20 },
      );
      try {
        const sourcesFrame = await waitForFrame(sourcesH, (f) => f.includes('EXCERPT_ROW_01'), 'SourcesView clamped excerpt');
        assert.ok(!sourcesFrame.includes('EXCERPT_ROW_30'), `SourcesView excerpt must clamp overflow rows:\n${sourcesFrame}`);
        assert.ok(sourcesFrame.includes('0%'), `SourcesView excerpt must show scroll indicator:\n${sourcesFrame}`);
        assert.ok(sourcesFrame.split('\n').length <= 20, `SourcesView exceeded viewport height: ${sourcesFrame.split('\n').length}`);
      } finally {
        sourcesH.inst.unmount();
      }

      // 3) TasksView: overflow job output clamps to detail ScrollArea and follows tail for running jobs
      const taskLogText = Array.from({ length: 30 }, (_, i) => `TASK_LOG_${String(i + 1).padStart(2, '0')} streaming step`).join('\n');
      const runningJob = {
        id: 'job-scroll-1',
        title: '长日志任务',
        type: 'generate',
        status: 'running',
        progress: 0.5,
        phase: 'generate',
        calls: [{ id: 'call-1', status: 'running', stage: 'generate' }],
      };
      useTuiStore.setState({
        snapshot: {
          sources: [],
          decks: [],
          jobs: [runningJob],
          archivedJobs: [],
          focus: { courses: [] },
        },
        navContext: {},
      });
      const tasksHost = {
        call: async (action) => {
          if (action === 'job.list') return { ok: true, value: { jobs: [runningJob] } };
          if (action === 'job.output') return { ok: true, value: { text: taskLogText, supported: true } };
          if (action === 'job.trace') return { ok: true, value: { calls: [] } };
          return { ok: true, value: {} };
        },
        subscribe: () => () => {},
        dispose: async () => {},
      };

      const tasksH = createScrollHarness(
        React.createElement(
          ViewBridge,
          null,
          React.createElement(TasksView, {
            host: tasksHost,
            width: 108,
            height: 18,
            isActive: true,
          }),
        ),
        { cols: 110, rows: 20 },
      );
      try {
        const tasksFrame = await waitForFrame(tasksH, (f) => f.includes('TASK_LOG_30'), 'TasksView tail-following output ScrollArea');
        assert.ok(!tasksFrame.includes('TASK_LOG_01'), `TasksView running job log must clamp head rows when following tail:\n${tasksFrame}`);
        assert.ok(tasksFrame.includes('100%'), `TasksView running job log must show 100% tail indicator:\n${tasksFrame}`);
        assert.ok(tasksFrame.split('\n').length <= 20, `TasksView exceeded viewport height: ${tasksFrame.split('\n').length}`);
      } finally {
        tasksH.inst.unmount();
      }
    } finally {
      useTuiStore.setState(prevStore);
    }
  });

  test('4. Golden 80x24 & 120x36 rendered snapshots inside AppShell across all 5 migrated views + <60x18 too-small guard (0 model calls)', async () => {
    const base = await temps.make('d5-snapshots');
    const dshHome = path.join(base, 'dsh-home');
    const libraryRoot = path.join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    const env = sanitizedTestEnv({ DSH_HOME: dshHome });
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;

    const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
    const storeFile = fs.readdirSync(distDir).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
    assert.ok(storeFile, 'dist/ must include store-*.mjs');
    const { useTuiStore } = await import(pathToFileURL(path.join(distDir, storeFile)).href);
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, sidebarCollapsed: false, showKeyHints: true, theme: 'dsh-dark' },
      { env },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: path.join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Layout snapshot suite must make 0 model calls');
      },
    });

    const tty = createVirtualTty(120, 36);
    let inst = null;
    const assertSnapshotFrame = (screen, cols, rows, label, expectedTokens) => {
      tty.assertHealthyScreen(screen, cols, rows, label);
      const lines = screen.split('\n');
      assert.ok(lines.length <= rows, `${label}: rendered ${lines.length} rows > ${rows}`);
      for (const token of expectedTokens) {
        assert.ok(
          typeof token === 'string' ? screen.includes(token) : token.test(screen),
          `${label} (${cols}x${rows}) missing expected layout marker ${String(token)}.\n--- FRAME ---\n${screen}\n--- END ---`,
        );
      }
    };

    try {
      useTuiStore.setState({
        page: 'library',
        loading: true,
        snapshot: null,
        activeRunId: null,
        toasts: [],
        showLaunchpad: false,
        commandPaletteOpen: false,
        helpOpen: false,
        coursePickerOpen: false,
        inboxOpen: false,
        notificationHistoryOpen: false,
        quitConfirmOpen: false,
        assistantOpen: false,
        assistantFocused: false,
      });
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      // 1) LibraryView (学习库页): 120x36 (expanded SideNav + dual pane + 题量分布) & 80x24 (collapsed rail + tabbed single pane)
      const libWide = await tty.waitFor(
        (s) => s.includes('示例 · Memento 与 Bridge') && s.includes('题量分布') && !useTuiStore.getState().loading,
        { timeoutMs: 12_000, label: 'LibraryView 120x36' },
      );
      assertSnapshotFrame(libWide, 120, 36, 'LibraryView 120x36', ['学习库', '示例 · Memento 与 Bridge', '题量分布']);

      tty.resize(80, 24);
      const libNarrow = await tty.waitFor(
        (s) => s.includes('示例 · Memento 与 Bridge') && s.split('\n').length <= 24,
        { timeoutMs: 8_000, label: 'LibraryView 80x24' },
      );
      assertSnapshotFrame(libNarrow, 80, 24, 'LibraryView 80x24', ['示例 · Memento 与 Bridge']);

      // 2) ReviewView (刷题页): Enter starts review round -> snapshot at 80x24 & 120x36
      tty.send('\r');
      const reviewNarrow = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'review' &&
          Boolean(useTuiStore.getState().activeRunId) &&
          !s.includes('正在加载练习') &&
          s.includes('1/9') &&
          s.split('\n').length <= 24,
        { timeoutMs: 10_000, label: 'ReviewView 80x24' },
      );
      assertSnapshotFrame(reviewNarrow, 80, 24, 'ReviewView 80x24', ['1/9']);

      tty.resize(120, 36);
      const reviewWide = await tty.waitFor(
        (s) => s.includes('1/9') && s.includes('刷题') && !s.includes('正在加载练习'),
        { timeoutMs: 8_000, label: 'ReviewView 120x36' },
      );
      assertSnapshotFrame(reviewWide, 120, 36, 'ReviewView 120x36', ['1/9', '刷题']);

      // Exit review round cleanly via X -> y so global nav keys are active
      tty.send('X');
      await tty.waitFor((s) => s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'Review end confirm' });
      tty.send('y');
      await tty.waitFor((s) => s.includes('本轮练习总结') || s.includes('Round Summary'), {
        timeoutMs: 6_000,
        label: 'RoundSummary settled',
      });

      // 3) SourcesView (资料页): key '2' -> snapshot at 120x36 & 80x24
      tty.send('2');
      const sourcesWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          (s.includes('学习资料库') || s.includes('资料')) &&
          s.includes('内容摘录') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'SourcesView 120x36' },
      );
      assertSnapshotFrame(sourcesWide, 120, 36, 'SourcesView 120x36', ['学习资料库', '内容摘录']);

      tty.resize(80, 24);
      const sourcesNarrow = await tty.waitFor(
        (s) => (s.includes('资料') || s.includes('学习资料库')) && s.split('\n').length <= 24,
        { timeoutMs: 8_000, label: 'SourcesView 80x24' },
      );
      assertSnapshotFrame(sourcesNarrow, 80, 24, 'SourcesView 80x24', [/资料/]);

      // 4) DocumentReader (阅读器): Enter opens reader from SourcesView -> snapshot at 80x24 & 120x36
      tty.send('\r');
      const readerNarrow = await tty.waitFor(
        (s) =>
          !s.includes('资料列表') &&
          !s.includes('正在读取页面内容') &&
          (/第\s*1|1\//.test(s)) &&
          s.split('\n').length <= 24,
        { timeoutMs: 10_000, label: 'DocumentReader 80x24' },
      );
      assertSnapshotFrame(readerNarrow, 80, 24, 'DocumentReader 80x24', [/第\s*1|1\//]);

      tty.resize(120, 36);
      const readerWide = await tty.waitFor(
        (s) => !s.includes('资料列表') && !s.includes('正在读取页面内容') && (/第\s*1|1\//.test(s)),
        { timeoutMs: 8_000, label: 'DocumentReader 120x36' },
      );
      assertSnapshotFrame(readerWide, 120, 36, 'DocumentReader 120x36', [/第\s*1|1\//]);

      // Close DocumentReader with Esc
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('学习资料库'), { timeoutMs: 8_000, label: 'Returned to SourcesView from Reader' });

      // 5) TasksView (后台任务页): key 't' -> snapshot at 120x36 & 80x24
      tty.send('t');
      const tasksWide = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'tasks' && s.includes('后台任务') && !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'TasksView 120x36' },
      );
      assertSnapshotFrame(tasksWide, 120, 36, 'TasksView 120x36', ['后台任务']);

      tty.resize(80, 24);
      const tasksNarrow = await tty.waitFor(
        (s) => s.includes('任务') && s.split('\n').length <= 24,
        { timeoutMs: 8_000, label: 'TasksView 80x24' },
      );
      assertSnapshotFrame(tasksNarrow, 80, 24, 'TasksView 80x24', ['任务']);

      // 6) < 60x18 too-small viewport guard inside real AppShell, then restore to 120x36
      tty.resize(50, 14);
      const tooSmallScreen = await tty.waitFor(
        (s) => /50[x×]14/.test(s) && /60[x×]18/.test(s),
        { timeoutMs: 8_000, label: 'Too-small guard 50x14' },
      );
      assert.ok(tooSmallScreen.includes('终端窗口太小'), `Expected Chinese too-small notice:\n${tooSmallScreen}`);

      tty.resize(120, 36);
      const restoredTasks = await tty.waitFor(
        (s) => !/50[x×]14/.test(s) && s.includes('后台任务'),
        { timeoutMs: 8_000, label: 'Restored TasksView 120x36 after too-small' },
      );
      assertSnapshotFrame(restoredTasks, 120, 36, 'Restored TasksView 120x36', ['后台任务']);

      assert.equal(modelCalls, 0, 'Layout snapshot suite must trigger 0 model calls');
    } finally {
      if (inst) inst.unmount();
      tty.dispose();
      await host.dispose();
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });
});
