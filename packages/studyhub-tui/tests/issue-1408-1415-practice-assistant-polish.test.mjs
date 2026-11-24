// Regression tests for the practice / assistant polish batch:
//   #1408 lowercase `t` opens Guided Study (true/false no longer answers with t / f)
//   #1409 coloured assistant transcript     #1410 the learner's own instruction is echoed
//   #1411 wider assistant dock              #1412 Esc hands the keyboard back, dock stays
//   #1413 IME cursor anchor                 #1414 visible code-block frame
//   #1426 the dock shows only the conversation about the card in view
// node --test tests/issue-1408-1415-practice-assistant-polish.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { AppShell, assistantDockWidth },
  { ReviewView },
  { useTuiStore, DEFAULT_PREFERENCES },
  { buildReviewQuickActions },
  { buildTranscriptPalette, formatTurnLines, turnsInScope },
  { getTheme, makeChalk, setColorLevel, getColorLevel },
  { renderMarkdownLines, clearMarkdownCache },
  { absoluteOrigin },
] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
  import('../src/views/review/quick-actions.ts'),
  import('../src/shell/assistant-transcript.ts'),
  import('../src/theme/tokens.ts'),
  import('../src/render/markdown.ts'),
  import('../src/components/ime-cursor.tsx'),
]);

function makeReviewHarness(cards) {
  let idx = 0;
  const submitted = [];
  const makeRun = (i) => {
    const c = cards[i];
    if (!c) {
      return {
        id: 'run-1408',
        deckId: 'd-1',
        mode: 'quiz',
        index: i,
        total: cards.length,
        done: true,
        card: null,
        revealed: false,
        feedback: null,
        selected: null,
      };
    }
    return {
      id: 'run-1408',
      deckId: 'd-1',
      mode: 'quiz',
      index: i,
      total: cards.length,
      done: false,
      card: c,
      revealed: Boolean(c._revealed),
      feedback: c._feedback ?? null,
      selected: c._selected ?? null,
      position: { at: i + 1, total: cards.length },
    };
  };

  const snapshot = {
    root: '/tmp/test-1408',
    decks: [{ id: 'd-1', title: '测试题组', course: '计算机基础', cards }],
    courses: [{ id: 'course-1', name: '计算机基础' }],
    today: { due: cards.length, new: 0, weak: 0, done: 0 },
    progress: { 'd-1': { total: cards.length, due: cards.length, mastered: 0, learning: 0, new: 0, weak: 0 } },
    inbox: [],
  };

  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name, args) => {
      if (name === 'review.start' || name === 'review.get') {
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.reveal') {
        cards[idx]._revealed = true;
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.answer') {
        submitted.push({ cardId: args.cardId, selected: args.selected, grade: args.grade });
        cards[idx]._revealed = true;
        cards[idx]._selected = args.selected ?? null;
        cards[idx]._feedback = { correct: true, grade: args.grade ?? 4 };
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.move') {
        idx = Math.max(0, Math.min(cards.length - 1, idx + (args.delta ?? 1)));
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.draft.save') return { ok: true, value: { ok: true } };
      return { ok: true, value: {} };
    },
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'review',
    activeRunId: 'run-1408',
    navContext: { runId: 'run-1408' },
    coursePickerOpen: false,
    commandPaletteOpen: false,
    helpOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    assistantOpen: false,
    assistantFocused: false,
    showLaunchpad: false,
    inputCaptured: false,
    practiceStack: [],
    toasts: [],
  });

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 36;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const renderPage = (page, viewProps) => {
    if (page === 'review') return React.createElement(ReviewView, viewProps);
    return React.createElement('ink-text', null, `PAGE:${page}`);
  };

  const inst = render(
    React.createElement(AppShell, {
      host,
      renderPage,
      onRefresh: async () => {},
      onQuit: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    submitted,
    write: (s) => stdin.write(s),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
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

const LABELS = { user: '我', assistant: '助手', system: '状态', stage: '阶段' };

test('#1408: the quick-action bar documents lowercase t for Guided Study', () => {
  const actions = buildReviewQuickActions({
    lang: 'zh',
    isCardFocused: false,
    canRubricGrade: false,
    canRedo: false,
    canAdjustGrade: false,
    canAckCorrection: false,
    canCoachNudge: false,
  });
  const guided = actions.find((a) => a.id === 'T');
  assert.equal(guided?.key, 't');
  assert.equal(guided?.text, '[t]带学');
});

test('#1408/#1412: t on a true/false card opens Guided Study without answering; Esc returns the keyboard and keeps the dock; back folds it', async (t) => {
  const cards = [
    {
      id: 'tf1',
      kind: 'true_false',
      topic: '操作系统',
      prompt: '判断：时间片轮转调度不会产生饥饿。',
      options: [
        { id: 'true', text: '对' },
        { id: 'false', text: '错' },
      ],
      answer: 'true',
    },
  ];
  const h = makeReviewHarness(cards);
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('时间片轮转调度不会产生饥饿'), 4000, 'true/false card visible');
  assert.ok(h.frame().includes('[1]') && !h.frame().includes('[1/t]'), 'true/false options are tagged [1] / [2] only');
  await new Promise((r) => setTimeout(r, 50));

  h.write('t');
  await h.waitFor(() => useTuiStore.getState().assistantOpen, 4000, 'assistant opened by t');
  assert.equal(h.submitted.length, 0, 't must not submit "true"');
  assert.equal(useTuiStore.getState().assistantFocused, true);

  await h.waitFor((s) => s.includes('AI 助手'), 4000, 'assistant dock rendered');
  await new Promise((r) => setTimeout(r, 80));
  h.write('\u001b');
  await h.waitFor(() => !useTuiStore.getState().assistantFocused, 4000, 'Esc returned the keyboard');
  assert.equal(useTuiStore.getState().assistantOpen, true, 'dock stays visible after Esc');
  assert.equal(useTuiStore.getState().page, 'review');

  useTuiStore.getState().goBack();
  assert.equal(useTuiStore.getState().assistantOpen, false, 'page-level back folds the passive dock first');
  assert.equal(useTuiStore.getState().page, 'review', 'and does not leave the page');
});

test('#1409/#1410: transcript lines keep their text and give each speaker its own colour', () => {
  const theme = getTheme('warm-amber');
  const turns = [
    { role: 'user', text: '通俗讲解', stageLabel: '复述' },
    { role: 'assistant', text: '用 `merge` 才是原子操作。\n漏掉了：没有说明扩容', actionSummary: '已完成：回答已生成' },
    { role: 'system', text: '已保存。' },
  ];
  const plain = turns.flatMap((turn) =>
    formatTurnLines(turn, { wrapW: 40, labels: LABELS, palette: buildTranscriptPalette(theme, makeChalk(0)) }),
  );
  assert.deepEqual(plain.slice(0, 3), ['我 [阶段: 复述]:', '  通俗讲解', '']);
  assert.ok(plain.includes('助手:') && plain.includes('  > 已完成：回答已生成') && plain.includes('状态:'));
  assert.ok(!plain.join('').includes('\u001b'), 'colour level 0 emits no escape codes');

  const coloured = turns.flatMap((turn) =>
    formatTurnLines(turn, { wrapW: 40, labels: LABELS, palette: buildTranscriptPalette(theme, makeChalk(3)) }),
  );
  assert.deepEqual(coloured.map((l) => stripAnsi(l)), plain, 'colour never changes the text');
  const sgr = (line) => (line.match(/\u001b\[38;2;\d+;\d+;\d+m/) ?? [''])[0];
  const headers = ['我 [阶段: 复述]:', '助手:', '状态:'].map((header) => coloured[plain.indexOf(header)]);
  assert.equal(new Set(headers.map(sgr)).size, 3, 'three speakers, three colours');
  const codeLine = coloured[plain.indexOf('  用 `merge` 才是原子操作。')];
  assert.ok((codeLine.match(/\u001b\[38;2;/g) ?? []).length >= 2, 'inline code is tinted apart from the prose');
});

test('#1411: the assistant dock takes a little under half of the page area, within bounds', () => {
  assert.equal(assistantDockWidth(96), 44);
  assert.equal(assistantDockWidth(78), 36);
  assert.equal(assistantDockWidth(200), 66);
  for (const w of [78, 96, 120, 160, 240]) assert.ok(w - assistantDockWidth(w) >= w / 2 - 1, `page keeps half at ${w}`);
});

test('#1414: the code-block frame uses the visible dim colour, not the faint border colour', () => {
  const prev = getColorLevel();
  setColorLevel(3);
  clearMarkdownCache();
  try {
    const theme = getTheme('warm-amber');
    const lines = renderMarkdownLines('```java\nint a = 1;\n```', { width: 40, theme, ascii: true });
    const top = lines.find((l) => stripAnsi(l).includes(' java '));
    assert.ok(top, 'language label row exists');
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
    assert.ok(top.includes(`38;2;${rgb(theme.dim)}m`), 'frame painted with theme.dim');
    assert.ok(!top.includes(`38;2;${rgb(theme.border)}m`), 'frame no longer painted with theme.border');
  } finally {
    setColorLevel(prev);
    clearMarkdownCache();
  }
});

test('#1413: absoluteOrigin sums layout offsets up to the root and refuses unmeasured nodes', () => {
  const yoga = (left, top) => ({ getComputedLeft: () => left, getComputedTop: () => top });
  const root = { yogaNode: yoga(0, 0), parentNode: undefined };
  const panel = { yogaNode: yoga(70, 1), parentNode: root };
  const field = { yogaNode: yoga(2, 31), parentNode: panel };
  assert.deepEqual(absoluteOrigin(field), { x: 72, y: 32 });
  assert.equal(absoluteOrigin(null), null);
  assert.equal(absoluteOrigin({ parentNode: root }), null);
});

test('#1426: the dock shows only the turns about the card in view and counts the rest', () => {
  const turns = [
    { id: 'a', scope: 'card-1', text: '上一题的提问' },
    { id: 'b', scope: 'card-1', text: '上一题的回答' },
    { id: 'c', text: '在学习库问的' },
    { id: 'd', scope: 'card-2', text: '这道题的提问' },
  ];
  assert.deepEqual(turnsInScope(turns, 'card-2'), { current: [turns[3]], earlier: 3 });
  assert.deepEqual(turnsInScope(turns, 'card-3'), { current: [], earlier: 4 }, 'a new card opens clean');
  assert.deepEqual(turnsInScope(turns, ''), { current: [turns[2]], earlier: 3 }, 'away from a card: only card-less turns');
});

test('#1412: away from the practice page a passive dock never swallows "back"', () => {
  const store = useTuiStore.getState();
  store.navigate('sources');
  store.navigate('board');
  useTuiStore.setState({ assistantOpen: true, assistantFocused: false, assistantFullscreen: false });
  useTuiStore.getState().goBack();
  assert.equal(useTuiStore.getState().page, 'sources', 'back still goes back');
  assert.equal(useTuiStore.getState().assistantOpen, true, 'and leaves the passive dock alone');
  useTuiStore.setState({ assistantOpen: false });
});
