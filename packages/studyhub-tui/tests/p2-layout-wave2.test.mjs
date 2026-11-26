// #1354 P2 Layout Convergence Wave 2 Guardrail & Regression Suite:
// Verifies breakpoints monotonicity, Prose/ChromeLabel/ScrollArea primitives,
// and real Ink renders at 80x24 & 120x36 across WrongBookView, ExamCoachView,
// AudioView, ExamPrepView, ExamRunner, and ExamReportView — ensuring zero silent
// learner-content truncation and zero horizontal/vertical viewport overflow.
//
// node --test packages/studyhub-tui/tests/p2-layout-wave2.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  {
    CONTENT_TIERS,
    LAYOUT_BP,
    LAYOUT_CHROME,
    isCompactContent,
    isNarrowContent,
    isViewportTooSmall,
    isWideContent,
    resolveContentTier,
    resolvePaneBreakpoint,
  },
  { ChromeLabel, Prose, computeProseLayout },
  { ScrollArea },
  { displayWidth },
  { ExamReportView },
  { ExamPrepView },
  { ExamCoachView },
  { WrongBookView },
  { AudioView },
  { ExamRunner },
  { DEFAULT_PREFERENCES, useTuiStore },
] = await Promise.all([
  import('../src/layout/breakpoints.ts'),
  import('../src/components/Layout.tsx'),
  import('../src/components/ScrollArea.tsx'),
  import('../src/render/cjk.ts'),
  import('../src/views/exam/ExamReportView.tsx'),
  import('../src/views/examprep/ExamPrepView.tsx'),
  import('../src/views/examcoach/ExamCoachView.tsx'),
  import('../src/views/wrongbook/WrongBookView.tsx'),
  import('../src/views/audio/AudioView.tsx'),
  import('../src/views/exam/ExamRunner.tsx'),
  import('../src/state/store.ts'),
]);

function mountInk(element, { cols = 80, rows = 24 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdin.resume();

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;

  let latest = '';
  let allOutput = '';
  stdout.on('data', (chunk) => {
    const s = stripAnsi(chunk.toString('utf8'));
    allOutput += s;
    if (s.trim()) latest = s;
  });

  const instance = render(element, {
    stdin,
    stdout,
    stderr: stdout,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    stdin,
    frame: () => latest || allOutput,
    send: (raw) => stdin.write(raw),
    async waitFor(predicate, timeoutMs = 4000, label = 'condition') {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const cur = latest || allOutput;
        if (predicate(cur)) return cur;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for ${label}; last frame:\n${latest || allOutput}`);
    },
    async settle(ms = 50) {
      await new Promise((r) => setTimeout(r, ms));
    },
    cleanup() {
      try {
        instance.unmount();
      } catch {
        // already unmounted
      }
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function assertBoundedFrame(frame, cols, rows, label) {
  const lines = frame.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  assert.ok(lines.length > 0, `${label}: rendered empty frame`);
  assert.ok(lines.length <= rows, `${label}: rendered ${lines.length} rows > ${rows}:\n${frame}`);
  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    assert.ok(w <= cols, `${label}: line ${i + 1} displayWidth ${w} > ${cols}: ${JSON.stringify(lines[i])}`);
  }
}

describe('#1354 P2 Layout Convergence Wave 2', () => {
  test('1. breakpoints.ts monotonic tier order & Prose/ChromeLabel/ScrollArea rendering contracts', async (t) => {
    // Monotonic ordering across all canonical breakpoints
    assert.ok(LAYOUT_BP.FILTER_SHORT < LAYOUT_BP.MIN_VIEWPORT_COLS);
    assert.ok(LAYOUT_BP.MIN_VIEWPORT_COLS < LAYOUT_BP.FILTER_FULL);
    assert.ok(LAYOUT_BP.FILTER_FULL < LAYOUT_BP.SPLIT_MODAL);
    assert.ok(LAYOUT_BP.SPLIT_MODAL < LAYOUT_BP.DOCK_SIDE_BY_SIDE);
    assert.ok(LAYOUT_BP.DOCK_SIDE_BY_SIDE < LAYOUT_BP.SPLIT_COMPACT);
    assert.ok(LAYOUT_BP.SPLIT_COMPACT < LAYOUT_BP.SPLIT_DEFAULT);
    assert.ok(LAYOUT_BP.SPLIT_DEFAULT < LAYOUT_BP.NARROW);
    assert.ok(LAYOUT_BP.NARROW < LAYOUT_BP.COMPACT);
    assert.ok(LAYOUT_BP.COMPACT < LAYOUT_BP.WIDE);
    assert.ok(LAYOUT_BP.WIDE < LAYOUT_BP.AI_DRAWER_SIDE);
    assert.ok(LAYOUT_BP.AI_DRAWER_SIDE < LAYOUT_BP.EXTRA_WIDE);
    assert.ok(LAYOUT_BP.EXTRA_WIDE < LAYOUT_BP.SIDENAV_AUTO_COLLAPSE);
    assert.ok(LAYOUT_BP.SIDENAV_AUTO_COLLAPSE < LAYOUT_BP.CONTENT_WIDE);

    // 4-tier classification boundaries
    assert.equal(resolveContentTier(CONTENT_TIERS.NARROW_MAX), 'narrow');
    assert.equal(resolveContentTier(CONTENT_TIERS.NARROW_MAX + 1), 'compact');
    assert.equal(resolveContentTier(CONTENT_TIERS.COMPACT_MAX), 'compact');
    assert.equal(resolveContentTier(CONTENT_TIERS.COMPACT_MAX + 1), 'regular');
    assert.equal(resolveContentTier(CONTENT_TIERS.REGULAR_MAX), 'regular');
    assert.equal(resolveContentTier(CONTENT_TIERS.REGULAR_MAX + 1), 'wide');

    assert.equal(isNarrowContent(59), true);
    assert.equal(isCompactContent(84), true);
    assert.equal(isCompactContent(85), false);
    assert.equal(isWideContent(120), true);
    assert.equal(isViewportTooSmall(59, 24), true);
    assert.equal(isViewportTooSmall(80, 17), true);
    assert.equal(isViewportTooSmall(60, 18), false);

    assert.equal(resolvePaneBreakpoint(80).tier, 'narrow');
    assert.equal(resolvePaneBreakpoint(92).tier, 'medium');
    assert.equal(resolvePaneBreakpoint(100).tier, 'wide');
    assert.equal(resolvePaneBreakpoint(120).tier, 'xwide');

    // Prose measure cap on ultrawide vs full-width on 80 cols
    const narrowProse = computeProseLayout(76);
    assert.equal(narrowProse.proseWidth, 76);
    assert.equal(narrowProse.marginLeft, 0);
    const ultrawideProse = computeProseLayout(140);
    assert.equal(ultrawideProse.proseWidth, LAYOUT_CHROME.PROSE_MAX_COLS);
    assert.ok(ultrawideProse.marginLeft > 0);

    // Prose wraps long content without dropping tail; ChromeLabel clips cleanly to maxWidth
    const hProse = mountInk(
      React.createElement(Prose, { width: 32, ascii: true }, 'HEAD_MARKER intermediate text words TAIL_MARKER'),
      { cols: 36, rows: 6 },
    );
    t.after(() => hProse.cleanup());
    const proseFrame = await hProse.waitFor((s) => s.includes('TAIL_MARKER'), 2000, 'Prose wrap');
    assert.ok(proseFrame.includes('HEAD_MARKER') && proseFrame.includes('TAIL_MARKER'));
    hProse.cleanup();

    const hChrome = mountInk(
      React.createElement(ChromeLabel, { text: 'ABCDEFGHIJKLMNOPQRSTUVWX', maxWidth: 12, ascii: true }),
      { cols: 20, rows: 3 },
    );
    t.after(() => hChrome.cleanup());
    const chromeFrame = await hChrome.waitFor((s) => s.includes('...'), 2000, 'ChromeLabel clip');
    assertBoundedFrame(chromeFrame, 12, 3, 'ChromeLabel');
    hChrome.cleanup();

    const hScroll = mountInk(
      React.createElement(ScrollArea, {
        prose: true,
        width: 120,
        height: 4,
        isActive: false,
        ascii: true,
        content: 'SCROLL_AREA_PROSE_BODY',
      }),
      { cols: 120, rows: 6 },
    );
    t.after(() => hScroll.cleanup());
    const scrollFrame = await hScroll.waitFor((s) => s.includes('SCROLL_AREA_PROSE_BODY'), 2000, 'ScrollArea prose');
    assertBoundedFrame(scrollFrame, 120, 6, 'ScrollArea prose');
  });

  test('2. ExamReportView oral report wraps long weakTopicsLine with <Prose> instead of silently truncating at 80x24 & 120x36', async (t) => {
    const prev = useTuiStore.getState();
    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
    });
    t.after(() => useTuiStore.setState(prev));

    const oralReportState = {
      kind: 'oral',
      report: {
        role: 'OS Interviewer',
        total: 4,
        assessed: 4,
        strong: 1,
        developing: 1,
        weak: 2,
        weakTopics: [
          { topic: 'VirtualMemoryPageFaultRecovery' },
          { topic: 'DeadlockAvoidanceBankersAlgorithm' },
          { topic: 'FINAL_WEAK_TOPIC_TOKEN' },
        ],
        entries: [
          {
            deckId: 'd1',
            cardId: 'c1',
            topic: 'Deadlock',
            prompt: 'Explain Coffman conditions.',
            answer: 'Mutual exclusion, hold and wait, no preemption, circular wait.',
            assessment: { band: 'weak', grade: 2, summary: 'Missed circular wait details.' },
          },
        ],
      },
    };

    for (const [cols, rows] of [[80, 24], [120, 36]]) {
      const h = mountInk(
        React.createElement(ExamReportView, {
          state: oralReportState,
          width: cols,
          height: rows,
          lang: 'zh',
          isActive: false,
          onBack: () => {},
          onStartWeakPractice: () => {},
        }),
        { cols, rows },
      );
      t.after(() => h.cleanup());
      const frame = await h.waitFor((s) => s.includes('口试评估报告'), 3000, `ExamReportView ${cols}x${rows}`);
      assert.ok(
        frame.includes('FINAL_WEAK_TOPIC_TOKEN'),
        `ExamReportView (${cols}x${rows}) must wrap weakTopicsLine without truncating FINAL_WEAK_TOPIC_TOKEN:\n${frame}`,
      );
      assertBoundedFrame(frame, cols, rows, `ExamReportView ${cols}x${rows}`);
      h.cleanup();
    }
  });

  test('3. ExamPrepView Crunch detail shows the backend sample-paper and pitfall counts inside the frame at 80x24 & 120x36', async (t) => {
    const prev = useTuiStore.getState();
    useTuiStore.setState({
      page: 'examprep',
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      snapshot: {
        revision: 1,
        focus: { course: 'OS' },
        courses: [{ name: 'OS' }],
        decks: [],
        progress: {},
        sources: [],
        notes: [],
        drafts: [],
        jobs: [],
      },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prev));

    const prepHost = {
      mode: 'embedded',
      getLibraryRoot: () => '',
      subscribeEvents: () => () => {},
      call: async (action) => {
        if (action === 'exam.focus.list') {
          return { ok: true, value: { topics: [], groups: [], counts: { total: 0, mastered: 0, inProgress: 0, missing: 0 } } };
        }
        if (action === 'exam.plan.get') return { ok: true, value: { plan: null } };
        if (action === 'book.crunch') {
          return {
            ok: true,
            value: {
              points: [
                {
                  id: 'p1',
                  title: 'Page Replacement',
                  done: false,
                  seen: true,
                  questions: 6,
                  weak: 2,
                  due: 2,
                  fresh: 1,
                  // book.crunch returns counts, not texts (lib/course-book-crunch.js: tested = sample papers, pitfalls = 易错点).
                  tested: 2,
                  pitfalls: 3,
                },
              ],
            },
          };
        }
        return { ok: true, value: {} };
      },
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };

    for (const [cols, rows] of [[80, 24], [120, 36]]) {
      const h = mountInk(
        React.createElement(ExamPrepView, { host: prepHost, width: cols, height: rows, isActive: true }),
        { cols, rows },
      );
      t.after(() => h.cleanup());
      await h.waitFor((s) => s.includes('备考补习'), 3000, `ExamPrepView mount ${cols}x${rows}`);
      // Press '2' to switch to Crunch tab (tab 2); on collapsed 80x24 SplitPane press Tab to inspect right detail pane
      h.send('2');
      await h.waitFor((s) => s.includes('Page Replacement'), 3000, `ExamPrepView Crunch list ${cols}x${rows}`);
      if (cols < LAYOUT_BP.SPLIT_DEFAULT) {
        h.send('\t');
      }
      const frame = await h.waitFor((s) => s.includes('易错点：3 个'), 3000, `ExamPrepView Crunch detail ${cols}x${rows}`);
      assert.ok(frame.includes('样卷考过：2 套'), `ExamPrepView (${cols}x${rows}) must show the sample-paper count:\n${frame}`);
      assertBoundedFrame(frame, cols, rows, `ExamPrepView ${cols}x${rows}`);
      h.cleanup();
    }
  });

  test('4. WrongBookView, ExamCoachView, AudioView & ExamRunner render cleanly via LAYOUT_BP & <ScrollArea> at 80x24 & 120x36', async (t) => {
    const prev = useTuiStore.getState();
    useTuiStore.setState({
      page: 'wrongbook',
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      snapshot: {
        revision: 1,
        focus: { course: 'OS' },
        courses: [{ name: 'OS' }],
        decks: [],
        progress: {},
        sources: [],
        notes: [],
        drafts: [],
        jobs: [],
      },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prev));

    // (a) WrongBookView at 80x24 & 120x36 (wide KPI strip visible >= LAYOUT_BP.NARROW, hidden < NARROW)
    const wbHost = {
      mode: 'embedded',
      getLibraryRoot: () => '',
      call: async (action) => {
        if (action === 'wrongbook') {
          return { ok: true, value: { items: [], counts: { weak: 0, history: 3 } } };
        }
        if (action === 'wrongbook.recommend') {
          return { ok: true, value: { items: [] } };
        }
        return { ok: true, value: {} };
      },
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };
    for (const [cols, rows] of [[70, 24], [120, 36]]) {
      const h = mountInk(
        React.createElement(WrongBookView, { host: wbHost, width: cols, height: rows, isActive: false }),
        { cols, rows },
      );
      t.after(() => h.cleanup());
      const frame = await h.waitFor(
        (s) => s.includes('错题本') && !s.includes('正在加载错题本'),
        3000,
        `WrongBookView ${cols}x${rows}`,
      );
      if (cols >= LAYOUT_BP.NARROW) {
        assert.ok(frame.includes('已订正 3'), `Wide WrongBookView (${cols}) must show fixed count:\n${frame}`);
      } else {
        assert.ok(!frame.includes('已订正 3'), `Compact WrongBookView (${cols}) must hide wide KPI strip:\n${frame}`);
      }
      assertBoundedFrame(frame, cols, rows, `WrongBookView ${cols}x${rows}`);
      h.cleanup();
    }

    // (b) ExamCoachView with long error message wraps via <Prose> and calibration detail uses <ScrollArea>
    const coachHost = {
      mode: 'embedded',
      getLibraryRoot: () => '',
      subscribeEvents: () => () => {},
      call: async (action) => {
        if (action === 'coach.calibration.get') {
          return {
            ok: false,
            error: {
              message:
                'Calibration profile could not be loaded because the course metadata index is locked COACH_ERR_TAIL_TOKEN',
            },
          };
        }
        return { ok: true, value: {} };
      },
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };
    const hCoach = mountInk(
      React.createElement(ExamCoachView, { host: coachHost, width: 80, height: 24, isActive: false }),
      { cols: 80, rows: 24 },
    );
    t.after(() => hCoach.cleanup());
    const coachFrame = await hCoach.waitFor((s) => s.includes('考试教练') && s.includes('Calibration'), 3000, 'ExamCoachView error');
    assert.ok(
      coachFrame.includes('COACH_ERR_TAIL_TOKEN'),
      `ExamCoachView (80x24) must wrap long errorMsg via <Prose> without clipping COACH_ERR_TAIL_TOKEN:\n${coachFrame}`,
    );
    assertBoundedFrame(coachFrame, 80, 24, 'ExamCoachView 80x24');
    hCoach.cleanup();

    // (c) AudioView transcript renders cleanly via <ScrollArea prose> at 120x36
    const audioHost = {
      mode: 'embedded',
      getLibraryRoot: () => '',
      subscribeEvents: () => () => {},
      call: async (action) => {
        if (action === 'snapshot') {
          return {
            ok: true,
            value: {
              sources: [{ id: 'audio-1', title: 'Lecture 01', course: 'OS', format: 'audio', audio: { durationSec: 120 } }],
            },
          };
        }
        if (action === 'source.get') {
          return {
            ok: true,
            value: { id: 'audio-1', text: 'AUDIO_TRANSCRIPT_BODY_OK' },
          };
        }
        return { ok: true, value: {} };
      },
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };
    const hAudio = mountInk(
      React.createElement(AudioView, { host: audioHost, width: 120, height: 32, isActive: true }),
      { cols: 120, rows: 32 },
    );
    t.after(() => hAudio.cleanup());
    const audioFrame = await hAudio.waitFor(
      (s) => s.includes('Lecture 01') && s.includes('AUDIO_TRANSCRIPT_BODY_OK'),
      3000,
      'AudioView 120x32 transcript body',
    );
    assertBoundedFrame(audioFrame, 120, 32, 'AudioView 120x32');
    hAudio.cleanup();

    // (d) ExamRunner case mode renders scenario via <ScrollArea> at 80x24 & 120x36
    const caseCard = {
      id: 'card-1',
      deckId: 'd1',
      kind: 'short-answer',
      topic: 'Concurrency',
      prompt: 'Identify the race condition.',
    };
    const caseRun = {
      id: 'run-case-1',
      mode: 'case',
      title: 'Case Exam',
      index: 0,
      total: 1,
      startedAt: new Date().toISOString(),
      card: caseCard,
      paperCards: [caseCard],
      scenario: {
        title: 'Bank Ledger Scenario',
        text: 'Paragraph one describes concurrent transfers.\n\nParagraph two describes lock ordering.',
      },
    };
    for (const [cols, rows] of [[80, 24], [120, 36]]) {
      const hExam = mountInk(
        React.createElement(ExamRunner, {
          kind: 'case',
          run: caseRun,
          oral: null,
          width: cols,
          height: rows,
          lang: 'zh',
          isActive: false,
          busy: false,
          error: null,
          onSelectPick: () => {},
          onSaveCaseResponse: () => {},
          onJumpWritten: () => {},
          onSubmitWritten: () => {},
          onSaveOralAnswer: () => {},
          onOralFollowup: () => {},
          onOralNext: () => {},
          onSubmitOral: () => {},
          onAbortBack: () => {},
        }),
        { cols, rows },
      );
      t.after(() => hExam.cleanup());
      const examFrame = await hExam.waitFor((s) => s.includes('Identify the race condition'), 3000, `ExamRunner ${cols}x${rows}`);
      assertBoundedFrame(examFrame, cols, rows, `ExamRunner ${cols}x${rows}`);
      hExam.cleanup();
    }
  });
});
