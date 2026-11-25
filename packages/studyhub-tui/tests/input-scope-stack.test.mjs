// P1-a Unified Input Dispatcher & LIFO Scope Stack Guardrail + Regression Suite (#1354 D1).
// Verifies:
// 1. `src/input/dispatcher.ts` + `src/input/hooks.ts` provide the single dispatcher + LIFO opaque scope stack.
// 2. Migrated views (`ReviewView`, `LibraryView`, `SourcesView`) have ZERO `useInput`, ZERO `useClaimKeys`,
//    and ZERO manual `mainActive`/`anyModalOpen`/`viewActive`/`listActive` modal-gate boolean chains.
// 3. Runtime LIFO stack ordering (nested & sibling modals), automatic claimed-key sync, and live view modal/filter isolation.
// Run: node --test tests/input-scope-stack.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React, { useState } from 'react';
import { Box, Text, render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

const EMPTY_KEY = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function createMockStreams(columns = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  return { stdin, stdout };
}

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const MIGRATED_VIEWS = [
  'views/review/ReviewView.tsx',
  'views/library/LibraryView.tsx',
  'views/sources/SourcesView.tsx',
  'views/wrongbook/WrongBookView.tsx',
  'views/notes/NotesView.tsx',
  'views/board/BoardView.tsx',
  'views/tasks/TasksView.tsx',
  'views/audio/AudioView.tsx',
  'views/dashboard/DashboardView.tsx',
  'views/examcoach/ExamCoachView.tsx',
  'views/examprep/ExamPrepView.tsx',
  'views/skeleton/SkeletonView.tsx',
  'views/book/BookView.tsx',
  'views/generate/GenerateView.tsx',
  'views/settings/SettingsView.tsx',
  'views/exam/ExamSetup.tsx',
  'views/exam/ExamRunner.tsx',
  'views/exam/ExamReportView.tsx',
];

function collectIdentifiersAndCalls(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const importedNames = new Set();
  const callNames = new Set();
  const varDecls = new Set();

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        importedNames.add((el.propertyName ?? el.name).text);
        importedNames.add(el.name.text);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      callNames.add(node.expression.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      varDecls.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { code, importedNames, callNames, varDecls };
}

describe('P1 Unified Input Dispatcher & Scope Stack (#1354 D1)', () => {
  test('1. Static architecture guardrail: src/input/ exists and components/key-dispatcher.ts delegates to it', () => {
    const dispatcherPath = path.join(SRC_ROOT, 'input/dispatcher.ts');
    const hooksPath = path.join(SRC_ROOT, 'input/hooks.ts');
    const legacyShimPath = path.join(SRC_ROOT, 'components/key-dispatcher.ts');

    assert.ok(fs.existsSync(dispatcherPath), 'src/input/dispatcher.ts must exist');
    assert.ok(fs.existsSync(hooksPath), 'src/input/hooks.ts must exist');

    const shimSrc = fs.readFileSync(legacyShimPath, 'utf8');
    assert.match(shimSrc, /\.\.\/input\/dispatcher\.js/, 'components/key-dispatcher.ts must re-export from ../input/dispatcher.js');
    assert.match(shimSrc, /\.\.\/input\/hooks\.js/, 'components/key-dispatcher.ts must re-export from ../input/hooks.js');
    assert.ok(!shimSrc.includes("from 'ink'"), 'components/key-dispatcher.ts must NOT hold a second Ink useInput listener');
  });

  test('2. Static migration guardrail: ALL 16 primary page views have ZERO useInput/useClaimKeys/manual modal-gate booleans', () => {
    const FORBIDDEN_IMPORTS = ['useInput', 'useScopedInput', 'useClaimKeys'];
    const FORBIDDEN_CALLS = ['useInput', 'useScopedInput', 'useClaimKeys'];
    const FORBIDDEN_VARS = [
      'mainActive',
      'anyModalOpen',
      'viewActive',
      'listActive',
      'modalOpen',
      'noModalActive',
      'boardNavActive',
      'listNavActive',
      'viewInputActive',
      'hasOverlay',
    ];

    for (const rel of MIGRATED_VIEWS) {
      const full = path.join(SRC_ROOT, rel);
      const { code, importedNames, callNames, varDecls } = collectIdentifiersAndCalls(full);

      for (const name of FORBIDDEN_IMPORTS) {
        assert.ok(!importedNames.has(name), `${rel} must NOT import "${name}" after migration to src/input/`);
      }
      for (const name of FORBIDDEN_CALLS) {
        assert.ok(!callNames.has(name), `${rel} must NOT call "${name}()" after migration to src/input/`);
      }
      for (const name of FORBIDDEN_VARS) {
        assert.ok(!varDecls.has(name), `${rel} must NOT declare manual modal-gate variable "${name}" (use scope stack instead)`);
      }
      assert.match(code, /from '\.\.\/\.\.\/input\/hooks\.js'/, `${rel} must import KeyScope/useKeyScope from ../../input/hooks.js`);
      assert.ok(callNames.has('useKeyScope'), `${rel} must register its keyboard scope via useKeyScope()`);
    }
  });

  test('3. Pure LIFO Scope Stack dispatcher: sibling modals, nested modals, system layer, and single consumption', async () => {
    const disp = await import('../src/input/dispatcher.ts');
    const hub = disp.createTestKeyHub();
    const log = [];

    disp.registerTestHandler(hub, (ch) => { log.push(`sys:${ch}`); return ch === 'C'; }, { layer: disp.KEY_LAYER_SYSTEM, depth: 0, scopeId: 0 });
    disp.registerTestHandler(hub, (ch) => { log.push(`global:${ch}`); return true; }, { layer: disp.KEY_LAYER_GLOBAL, depth: 0, scopeId: 0 });
    disp.registerTestHandler(hub, (ch) => { log.push(`page:${ch}`); return ch === 'a'; }, { layer: disp.KEY_LAYER_VIEW, depth: 0, scopeId: 0 });

    // Base scope active: 'a' handled by page and stops before global; 'b' falls to global
    disp.dispatchToHub(hub, 'a', EMPTY_KEY);
    disp.dispatchToHub(hub, 'b', EMPTY_KEY);
    assert.deepEqual(log, ['sys:a', 'page:a', 'sys:b', 'page:b', 'global:b']);

    // Push opaque modal A (depth 1, scopeId 10)
    log.length = 0;
    const popA = disp.pushTestOpaqueScope(hub, { depth: 1, scopeId: 10, label: 'modalA' });
    const unregA = disp.registerTestHandler(hub, (ch) => { log.push(`modalA:${ch}`); return true; }, { layer: disp.KEY_LAYER_MODAL, depth: 1, scopeId: 10 });
    assert.equal(disp.isScopeMasked(hub, 0, 0), true, 'base scope must be masked while modalA is on stack');
    assert.equal(disp.isScopeMasked(hub, 1, 10), false, 'modalA itself is top of stack');

    disp.dispatchToHub(hub, 'a', EMPTY_KEY);
    assert.deepEqual(log, ['sys:a', 'modalA:a'], 'modalA masks base page and global');

    // Push sibling opaque modal B (depth 1, scopeId 20) while modalA is still mounted -> LIFO: modalB wins!
    log.length = 0;
    const popB = disp.pushTestOpaqueScope(hub, { depth: 1, scopeId: 20, label: 'modalB' });
    const unregB = disp.registerTestHandler(hub, (ch) => { log.push(`modalB:${ch}`); return true; }, { layer: disp.KEY_LAYER_MODAL, depth: 1, scopeId: 20 });
    assert.equal(disp.isScopeMasked(hub, 1, 10), true, 'sibling modalA must be masked once modalB pushes LIFO');
    assert.equal(disp.isScopeMasked(hub, 1, 20), false, 'modalB is top of stack');

    disp.dispatchToHub(hub, 'x', EMPTY_KEY);
    assert.deepEqual(log, ['sys:x', 'modalB:x'], 'LIFO sibling modalB exclusively receives key');

    // System key still penetrates both modals
    log.length = 0;
    disp.dispatchToHub(hub, 'C', EMPTY_KEY);
    assert.deepEqual(log, ['sys:C'], 'KEY_LAYER_SYSTEM penetrates opaque barriers and stops propagation');

    // Unmount modalB (pop barrier + unregister handler) -> modalA immediately resumes
    log.length = 0;
    unregB();
    popB();
    assert.equal(disp.isScopeMasked(hub, 1, 10), false);
    disp.dispatchToHub(hub, 'y', EMPTY_KEY);
    assert.deepEqual(log, ['sys:y', 'modalA:y']);

    // Unmount modalA -> base page resumes
    log.length = 0;
    unregA();
    popA();
    assert.equal(disp.isScopeMasked(hub, 0, 0), false);
    disp.dispatchToHub(hub, 'a', EMPTY_KEY);
    assert.deepEqual(log, ['sys:a', 'page:a']);
  });

  test('4. React hooks integration: useKeyScope auto-masks, auto-claims keys for SideNav, and restores on pop', async () => {
    const { KeyScope, useKeyScope, useKeyDispatcherBridge } = await import('../src/input/hooks.ts');
    const { isKeyClaimed } = await import('../src/components/focus.ts');

    const events = [];
    let setModalState = null;
    let latestPageActive = null;

    function ModalBox({ label }) {
      useKeyScope({
        id: `modal:${label}`,
        onKey: (ch) => {
          events.push(`${label}:${ch}`);
          return true;
        },
      });
      return React.createElement(Text, null, label);
    }

    function Harness() {
      useKeyDispatcherBridge(true);
      const [modals, setModals] = useState({ a: false, b: false });
      setModalState = setModals;

      const pageActive = useKeyScope({
        id: 'base-page',
        keys: ['b', 'x'],
        onKey: (ch) => {
          events.push(`page:${ch}`);
          return true;
        },
      });
      latestPageActive = pageActive;

      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, `pageActive=${String(pageActive)}`),
        modals.a ? React.createElement(KeyScope, { id: 'scopeA', opaque: true }, React.createElement(ModalBox, { label: 'A' })) : null,
        modals.b ? React.createElement(KeyScope, { id: 'scopeB', opaque: true }, React.createElement(ModalBox, { label: 'B' })) : null,
      );
    }

    const { stdin, stdout } = createMockStreams();
    const inst = render(React.createElement(Harness), { stdin, stdout, interactive: true, exitOnCtrlC: false });
    try {
      await wait(60);
      assert.equal(latestPageActive, true);
      assert.equal(isKeyClaimed('b'), true, 'base page useKeyScope must auto-claim its keys');
      stdin.write('b');
      await wait(40);
      assert.deepEqual(events, ['page:b']);

      // Mount modal A -> base page auto-masked & claimed keys released
      events.length = 0;
      setModalState({ a: true, b: false });
      await wait(60);
      assert.equal(latestPageActive, false, 'useKeyScope return value must reactively flip false when child KeyScope mounts');
      assert.equal(isKeyClaimed('b'), false, 'base page claimed keys must suspend while masked by opaque scope');
      stdin.write('b');
      await wait(40);
      assert.deepEqual(events, ['A:b']);

      // Mount sibling modal B -> LIFO modal B wins over modal A
      events.length = 0;
      setModalState({ a: true, b: true });
      await wait(60);
      stdin.write('z');
      await wait(40);
      assert.deepEqual(events, ['B:z']);

      // Unmount both -> base page & claims restored
      events.length = 0;
      setModalState({ a: false, b: false });
      await wait(60);
      assert.equal(latestPageActive, true);
      assert.equal(isKeyClaimed('b'), true);
      stdin.write('x');
      await wait(40);
      assert.deepEqual(events, ['page:x']);
    } finally {
      inst.unmount();
    }
  });

  test('5. Migrated views live isolation: LibraryView & SourcesView filter/search opaque scope never leaks to page or global nav', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const { LibraryView } = await import('../src/views/library/LibraryView.tsx');
    const { SourcesView } = await import('../src/views/sources/SourcesView.tsx');
    const { useTuiStore } = await import('../src/state/store.ts');

    const snapshot = {
      revision: 1,
      courses: [{ id: 'c1', name: 'OS' }],
      decks: [{ id: 'd1', title: 'Virtual Memory', course: 'OS', cardCount: 4, dueCount: 2 }],
      focus: { course: 'OS' },
      stats: { totalCards: 4, dueToday: 2, reviewedToday: 0 },
      sources: [{ id: 's1', title: 'Paging Lecture', format: 'pdf', course: 'OS', pageCount: 12 }],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    };
    const host = {
      getSnapshot: async () => snapshot,
      runAction: async () => ({ ok: true }),
      subscribe: () => () => {},
    };

    // --- LibraryView filter isolation ---
    useTuiStore.setState({
      page: 'library',
      navContext: {},
      history: [],
      loading: false,
      refreshing: false,
      showLaunchpad: false,
      inputCaptured: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      voicePackOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      snapshot,
    });

    const s1 = createMockStreams(120, 36);
    const i1 = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: (p, view) =>
          p === 'library' ? React.createElement(LibraryView, view) : React.createElement(SourcesView, view),
      }),
      { stdin: s1.stdin, stdout: s1.stdout, interactive: true, exitOnCtrlC: false },
    );
    try {
      await wait(80);
      // '/' activates inline filter KeyScope -> typing 'b', 'd', 'a' must NOT jump to board or trigger delete/archive!
      s1.stdin.write('/');
      await wait(60);
      s1.stdin.write('bda');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'library', 'typing b/d/a in LibraryView filter must not navigate away');
      // Esc cancels filter and returns to base LibraryView scope
      s1.stdin.write('\u001b');
      await wait(60);
      // Now 'b' navigates globally to board (confirming base scope & global fallback restored cleanly)
      s1.stdin.write('b');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'board', 'after closing LibraryView filter, global b navigates to board');

      // --- SourcesView search isolation ---
      useTuiStore.getState().navigate('sources');
      await wait(80);
      s1.stdin.write('/');
      await wait(60);
      s1.stdin.write('bdi');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'sources', 'typing b/d/i in SourcesView search must not navigate away or open modals');
      s1.stdin.write('\u001b');
      await wait(60);
      s1.stdin.write('b');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'board', 'after closing SourcesView search, global b navigates to board');
    } finally {
      i1.unmount();
    }
  });

  test('6. ReviewView live scope stack: choice key b stays on review (#1350), FlagModal opaque scope isolates typing, Esc restores card', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const { ReviewView } = await import('../src/views/review/ReviewView.tsx');
    const { useTuiStore } = await import('../src/state/store.ts');

    const answeredCalls = [];
    const flaggedCalls = [];
    const runObj = {
      id: 'run-p1-1',
      mode: 'deck',
      deckId: 'd1',
      title: 'OS Quiz',
      index: 0,
      total: 2,
      answered: 0,
      position: { at: 1, total: 2 },
      card: {
        id: 'c-choice-1',
        kind: 'single',
        prompt: 'Which page replacement algorithm is optimal?',
        options: [
          { id: 'opt-a', text: 'FIFO' },
          { id: 'opt-b', text: 'Belady OPT' },
          { id: 'opt-c', text: 'Random' },
        ],
      },
      solution: {
        options: [
          { id: 'opt-a', correct: false },
          { id: 'opt-b', correct: true },
          { id: 'opt-c', correct: false },
        ],
        explanation: 'OPT replaces the page not used for the longest time.',
      },
      navigation: [{ cardId: 'c-choice-1' }, { cardId: 'c-choice-2' }],
    };

    const snapshotObj = {
      revision: 1,
      courses: [{ id: 'c1', name: 'OS' }],
      decks: [{ id: 'd1', title: 'OS Quiz', course: 'OS', cardCount: 2, dueCount: 2 }],
      focus: { course: 'OS' },
      stats: { totalCards: 2, dueToday: 2, reviewedToday: 0 },
      sources: [],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    };
    const host = {
      call: async (action, payload) => {
        if (action === 'snapshot') return { ok: true, value: snapshotObj };
        if (action === 'review.get' || action === 'review.start') return { ok: true, value: runObj };
        if (action === 'review.answer') {
          answeredCalls.push(payload);
          return {
            ok: true,
            value: {
              ...runObj,
              answered: 1,
              feedback: { correct: true, selected: payload?.selected ?? ['opt-b'], grade: 4 },
            },
          };
        }
        if (action === 'card.flag') {
          flaggedCalls.push(payload);
          return { ok: true, value: { flagged: true } };
        }
        return { ok: true, value: {} };
      },
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp/demo',
      getConfig: () => null,
      dispose: async () => {},
    };

    useTuiStore.setState({
      page: 'review',
      navContext: { runId: 'run-p1-1' },
      activeRunId: 'run-p1-1',
      history: [],
      loading: false,
      refreshing: false,
      showLaunchpad: false,
      inputCaptured: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      voicePackOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      snapshot: snapshotObj,
    });

    const { stdin, stdout } = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: (_p, view) => React.createElement(ReviewView, view),
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(120);
      // Open FlagModal with 'E' -> opaque KeyScope pushes on stack!
      stdin.write('E');
      await wait(80);
      // Typing 'b', 'X', '1' inside FlagModal must NOT answer card, open EndConfirm, or navigate to board!
      stdin.write('bX1');
      await wait(80);
      assert.equal(answeredCalls.length, 0, 'typing b/1 inside FlagModal must not trigger card answer');
      assert.equal(useTuiStore.getState().page, 'review', 'typing b inside FlagModal must not jump to board');

      // Esc closes FlagModal -> pops opaque KeyScope, returning focus cleanly to card!
      stdin.write('\u001b');
      await wait(80);

      // Now pressing 'b' on the choice card answers option B and NEVER jumps to board (#1350)
      stdin.write('b');
      await wait(80);
      assert.equal(useTuiStore.getState().page, 'review', 'choice key b must stay on review page');
      assert.equal(answeredCalls.length, 1, 'choice key b must submit option B after FlagModal closes');
      assert.deepEqual(answeredCalls[0]?.selected, ['opt-b']);

      // Post-feedback 'b' must STILL stay on review page (claimed for entire card lifecycle)
      stdin.write('b');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'review', 'post-feedback b on choice card must not jump to board');
    } finally {
      inst.unmount();
    }
  });

  test('7. Batch 2 views live scope isolation: BoardView, NotesView, WrongBookView, TasksView & AudioView filter opaque scopes isolate typing and restore global nav', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const { BoardView } = await import('../src/views/board/BoardView.tsx');
    const { NotesView } = await import('../src/views/notes/NotesView.tsx');
    const { WrongBookView } = await import('../src/views/wrongbook/WrongBookView.tsx');
    const { TasksView } = await import('../src/views/tasks/TasksView.tsx');
    const { AudioView } = await import('../src/views/audio/AudioView.tsx');
    const { useTuiStore } = await import('../src/state/store.ts');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-p1-batch2-'));
    const snapshot = {
      revision: 1,
      courses: [{ id: 'c1', name: 'OS' }],
      decks: [{ id: 'd1', title: 'Virtual Memory', course: 'OS', cardCount: 2, dueCount: 1 }],
      focus: { course: 'OS' },
      stats: { totalCards: 2, dueToday: 1, reviewedToday: 0 },
      sources: [],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    };
    const host = {
      call: async (action) => {
        if (action === 'snapshot') return { ok: true, value: snapshot };
        if (action === 'wrongbook.list') return { ok: true, value: { items: [], counts: { active: 0, leech: 0, history: 0, total: 0 } } };
        if (action === 'wrongbook.recommend') return { ok: true, value: { items: [] } };
        if (action === 'notes.list') return { ok: true, value: { notes: [] } };
        if (action === 'notes.daily.status') return { ok: true, value: { groups: [] } };
        if (action === 'board.load') return { ok: true, value: { columns: { todo: [], doing: [], done: [] }, cards: [] } };
        if (action === 'audio.results' || action === 'audio.preflight' || action === 'audio.settings' || action === 'audio.usage') {
          return { ok: true, value: { items: [], results: [] } };
        }
        return { ok: true, value: {} };
      },
      subscribeEvents: () => () => {},
      getLibraryRoot: () => tmpRoot,
      getConfig: () => null,
      dispose: async () => {},
    };

    useTuiStore.setState({
      page: 'board',
      navContext: {},
      history: [],
      loading: false,
      refreshing: false,
      showLaunchpad: false,
      inputCaptured: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      voicePackOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      snapshot,
    });

    const { stdin, stdout } = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: (p, view) => {
          if (p === 'board') return React.createElement(BoardView, view);
          if (p === 'notes') return React.createElement(NotesView, view);
          if (p === 'wrongbook') return React.createElement(WrongBookView, view);
          if (p === 'tasks') return React.createElement(TasksView, view);
          return React.createElement(AudioView, view);
        },
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(100);
      // --- BoardView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('adn');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'board', 'typing a/d/n in BoardView filter must not navigate away or open add modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('n');
      await wait(80);
      assert.equal(useTuiStore.getState().page, 'notes', 'after closing BoardView filter, global n navigates to notes');

      // --- NotesView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('ba4t');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'notes', 'typing b/a/4/t in NotesView filter must not navigate away or open modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('4');
      await wait(80);
      assert.equal(useTuiStore.getState().page, 'wrongbook', 'after closing NotesView filter, global 4 navigates to wrongbook');

      // --- WrongBookView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('bea');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'wrongbook', 'typing b/e/a in WrongBookView filter must not navigate away');
      stdin.write('\u001b');
      await wait(60);
      // 't' is claimed by WrongBookView (triage), so after closing filter 't' stays on wrongbook, while unclaimed 'a' navigates to audio
      stdin.write('t');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'wrongbook', 'WrongBookView claimed key t must stay on wrongbook after filter closes');
      stdin.write('a');
      await wait(80);
      assert.equal(useTuiStore.getState().page, 'audio', 'after closing WrongBookView filter, unclaimed global a navigates to audio');

      // --- AudioView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('bis');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'audio', 'typing b/i/s in AudioView filter must not navigate away or open import/settings modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('b');
      await wait(80);
      assert.equal(useTuiStore.getState().page, 'board', 'after closing AudioView filter, unclaimed global b navigates to board');

      // --- TasksView filter isolation ---
      useTuiStore.getState().navigate('tasks');
      await wait(80);
      stdin.write('/');
      await wait(60);
      stdin.write('abw');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'tasks', 'typing a/b/w in TasksView filter must not navigate away or open workflow modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('b');
      await wait(80);
      assert.equal(useTuiStore.getState().page, 'board', 'after closing TasksView filter, unclaimed global b navigates to board');
    } finally {
      inst.unmount();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('8. Batch 3a views live scope isolation: DashboardView, ExamCoachView, ExamPrepView & SkeletonView filter opaque scopes isolate typing and restore global nav', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const { DashboardView } = await import('../src/views/dashboard/DashboardView.tsx');
    const { ExamCoachView } = await import('../src/views/examcoach/ExamCoachView.tsx');
    const { ExamPrepView } = await import('../src/views/examprep/ExamPrepView.tsx');
    const { SkeletonView } = await import('../src/views/skeleton/SkeletonView.tsx');
    const { useTuiStore } = await import('../src/state/store.ts');

    const snapshot = {
      revision: 1,
      courses: [{ id: 'c1', name: 'OS' }],
      decks: [{ id: 'd1', title: 'Virtual Memory', course: 'OS', cardCount: 4, dueCount: 2 }],
      focus: { course: 'OS' },
      stats: { totalCards: 4, dueToday: 2, reviewedToday: 0 },
      sources: [],
      tasks: [],
      wrongBook: [],
      notes: [],
      skeletons: [],
      modelReady: false,
    };
    const host = {
      call: async (action) => {
        if (action === 'snapshot') return { ok: true, value: snapshot };
        if (action === 'stats.overview') return { ok: true, value: { totals: { cards: 4, due: 2 }, weakTopics: [], forecast: [], heatmap: [] } };
        if (action === 'coach.calibration.get') return { ok: true, value: { spec: { course: 'OS', specVersion: 1, families: [{ id: 'f1', title: 'Paging', primaryFormat: 'single', quota: 4 }] }, evidence: null } };
        if (action === 'coach.status') return { ok: true, value: { enabled: false, ready: 0, preparing: false, tasks: [] } };
        if (action === 'coach.evidence.summary') return { ok: true, value: { summary: { total: 0, solid: 0, in_progress: 0, shaky: 0, unstarted: 0 }, points: [] } };
        if (action === 'wrongbook.list') return { ok: true, value: { items: [], counts: { active: 0, leech: 0, history: 0, total: 0 } } };
        if (action === 'focus.progress') return { ok: true, value: { topics: [{ topic: 'Paging', status: 'learning', cards: 2, mastery: 0.5, weakCards: [] }], done: 0, none: 0 } };
        if (action === 'book.crunch') return { ok: true, value: { status: 'ok', points: [] } };
        if (action === 'course.plan') return { ok: true, value: null };
        if (action === 'skeleton.list') return { ok: true, value: { skeletons: [] } };
        return { ok: true, value: {} };
      },
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp/demo',
      getConfig: () => null,
      dispose: async () => {},
    };

    useTuiStore.setState({
      page: 'dashboard',
      navContext: {},
      history: [],
      loading: false,
      refreshing: false,
      showLaunchpad: false,
      inputCaptured: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      voicePackOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      snapshot,
    });

    const { stdin, stdout } = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: (p, view) => {
          if (p === 'dashboard') return React.createElement(DashboardView, view);
          if (p === 'examcoach') return React.createElement(ExamCoachView, view);
          if (p === 'examprep') return React.createElement(ExamPrepView, view);
          return React.createElement(SkeletonView, view);
        },
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(100);
      // --- DashboardView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('bm9');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'dashboard', 'typing b/m/9 in DashboardView filter must not navigate away or open map modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('9');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'examcoach', 'after closing DashboardView filter, global 9 navigates to examcoach');

      // --- ExamCoachView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('0np');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'examcoach', 'typing 0/n/p in ExamCoachView filter must not navigate away or open modals');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('0');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'examprep', 'after closing ExamCoachView filter, global 0 navigates to examprep');

      // --- ExamPrepView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('8ap');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'examprep', 'typing 8/a/p in ExamPrepView filter must not navigate away or open AddFocusModal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('8');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'skeleton', 'after closing ExamPrepView filter, global 8 navigates to skeleton');

      // --- SkeletonView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('6gr');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'skeleton', 'typing 6/g/r in SkeletonView filter must not navigate away or open generate confirm');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('6');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'dashboard', 'after closing SkeletonView filter, global 6 navigates to dashboard');
    } finally {
      inst.unmount();
    }
  });

  test('9. Batch 3b views live scope isolation: BookView, GenerateView, SettingsView & ExamSetup opaque scopes isolate typing and restore global nav', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const { BookView } = await import('../src/views/book/BookView.tsx');
    const { GenerateView } = await import('../src/views/generate/GenerateView.tsx');
    const { SettingsView } = await import('../src/views/settings/SettingsView.tsx');
    const { ExamView } = await import('../src/views/exam/ExamView.tsx');
    const { useTuiStore } = await import('../src/state/store.ts');

    const snapshot = {
      revision: 1,
      courses: [{ id: 'c1', name: 'OS' }],
      decks: [{ id: 'd1', title: 'Virtual Memory', course: 'OS', cardCount: 4, dueCount: 2 }],
      focus: { course: 'OS' },
      stats: { totalCards: 4, dueToday: 2, reviewedToday: 0 },
      sources: [{ id: 's1', title: 'Paging Lecture', format: 'pdf', course: 'OS', pageCount: 12 }],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    };
    const host = {
      call: async (action) => {
        if (action === 'snapshot') return { ok: true, value: snapshot };
        if (action === 'book.open') {
          return {
            ok: true,
            value: {
              status: 'ok',
              title: 'OS Review Book',
              tree: [{ id: 'n1', hid: 'h1', number: '1', title: 'Paging', leaf: true, depth: 1, children: [] }],
            },
          };
        }
        if (action === 'book.toc') return { ok: true, value: { status: 'ok', title: 'OS Review Book', rows: [] } };
        if (action === 'book.read') return { ok: true, value: { markdown: '# Paging' } };
        if (action === 'book.qa.list') return { ok: true, value: { followupIds: [], answerCardIds: [] } };
        if (action === 'desktop.config.get') return { ok: true, value: { mode: 'openai', openai: { providerId: 'openai', baseUrl: '', model: '' }, effective: { ready: false } } };
        if (action === 'binding.get') return { ok: true, value: { root: '/tmp/demo' } };
        return { ok: true, value: {} };
      },
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp/demo',
      getConfig: () => null,
      dispose: async () => {},
    };

    useTuiStore.setState({
      page: 'book',
      navContext: {},
      history: [],
      loading: false,
      refreshing: false,
      showLaunchpad: false,
      inputCaptured: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      voicePackOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      snapshot,
    });

    const { stdin, stdout } = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: (p, view) => {
          if (p === 'book') return React.createElement(BookView, view);
          if (p === 'generate') return React.createElement(GenerateView, view);
          if (p === 'settings') return React.createElement(SettingsView, view);
          return React.createElement(ExamView, view);
        },
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(120);
      // --- BookView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('3ge');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'book', 'typing 3/g/e in BookView filter must not navigate away or open build/edit modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('3');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'generate', 'after closing BookView filter, global 3 navigates to generate');

      // --- GenerateView filter isolation ---
      stdin.write('/');
      await wait(60);
      stdin.write('5pf');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'generate', 'typing 5/p/f in GenerateView filter must not navigate away or open scope/focus modal');
      stdin.write('\u001b');
      await wait(60);
      stdin.write('5');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'exam', 'after closing GenerateView filter, global 5 navigates to exam');

      // --- ExamSetup claimed keys vs unclaimed global nav ---
      stdin.write('1');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'exam', 'ExamSetup claimed key 1 switches exam mode without jumping to library');
      stdin.write(',');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'settings', 'unclaimed global , from ExamSetup navigates to settings');

      // --- SettingsView claimed digits 1-4 vs unclaimed global nav ---
      stdin.write('2');
      await wait(60);
      assert.equal(useTuiStore.getState().page, 'settings', 'SettingsView claimed digit 2 switches settings tab without jumping to sources');
      stdin.write('7');
      await wait(100);
      assert.equal(useTuiStore.getState().page, 'book', 'unclaimed global 7 from SettingsView navigates to book');
    } finally {
      inst.unmount();
    }
  });
});
