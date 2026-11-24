// Regression tests for #1430: BoardView concurrent saves must not overwrite newer state
// in memory or on disk, and in-flight upstream sync must not clobber queued local moves.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const boardStoreMod = await tsImport('../src/views/board/board-store.ts', import.meta.url);
const { createBoardSaveCoordinator, emptyBoard, loadBoardSafe, saveBoard } = boardStoreMod;

const runtime = await loadDistRuntime();
const { StudyHubTuiApp } = runtime;
const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore } = await import(pathToFileURL(join(distDir, storeFile)).href);

const temps = createTempTracker('studyhub-tui-1430-');

function resetStoreForTest() {
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
    showLaunchpad: false,
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    quitConfirmOpen: false,
    quitGuard: null,
    toasts: [],
    footerHints: [],
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDocWithColumn(column, updatedAt = '2026-11-24T00:00:00.000Z') {
  return {
    version: 1,
    cards: [
      {
        id: 'card-1',
        title: 'Race Guard Task',
        column,
        upstreamCardId: 'up-1',
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt,
      },
    ],
    deletedUpstreamIds: [],
    updatedAt,
  };
}

function createMockHost(libraryRoot, callImpl) {
  const baseSnapshot = {
    root: libraryRoot,
    revision: 1,
    modelReady: false,
    courses: [{ name: 'CS101', deckCount: 0, cardCount: 0, dueCount: 0 }],
    decks: [],
    sources: [],
    drafts: [],
    jobs: [],
    runs: [],
    notes: [],
  };
  const baseConfig = {
    mode: 'openai',
    openai: { providerId: 'deepseek', baseUrl: '', model: '', hasKey: false, keyLast4: '' },
    agy: { executablePath: '', model: '', effort: '' },
    codex: { executablePath: '', model: '', effort: '' },
    libraryRoot,
    libraryPlaceConfirmed: true,
    reasoningEffort: '',
    effective: { ready: false, label: 'Unconfigured', reason: 'no-credential' },
  };
  return {
    dshHome: libraryRoot,
    autoProbe: Promise.resolve({ outcome: 'skipped', providers: [] }),
    getLibraryRoot: () => libraryRoot,
    getConfig: () => baseConfig,
    setLanguage: () => {},
    getLanguage: () => 'zh',
    rescanProviders: async () => [],
    subscribeEvents: () => () => {},
    refreshSnapshot: async () => ({
      snapshot: baseSnapshot,
      binding: { root: libraryRoot, libraryPlaceConfirmed: true },
      config: baseConfig,
      error: null,
    }),
    dispose: async () => {},
    call: async (action, args = {}) => {
      const custom = await callImpl(action, args);
      if (custom !== undefined) return custom;
      if (action === 'snapshot') return { ok: true, value: baseSnapshot };
      if (action === 'binding.get') return { ok: true, value: { root: libraryRoot } };
      if (action === 'desktop.config.get') return { ok: true, value: baseConfig };
      return { ok: false, error: { message: `Unhandled action: ${action}`, code: 'UNKNOWN' } };
    },
  };
}

after(async () => {
  try {
    disposeTerminalPool();
  } finally {
    await temps.cleanup();
  }
});

describe('#1430: BoardView save serialization & stale-write protection', () => {
  test('createBoardSaveCoordinator serializes writes, skips stale intermediate writes, and never reverts memory', async () => {
    assert.equal(
      typeof createBoardSaveCoordinator,
      'function',
      'board-store must export createBoardSaveCoordinator',
    );

    const save1Started = createDeferred();
    const save1Gate = createDeferred();
    const saveFinalGate = createDeferred();
    let activeWrites = 0;
    let maxConcurrency = 0;
    const diskHistory = [];
    const uiHistory = [];

    const coordinator = createBoardSaveCoordinator({
      initialDoc: emptyBoard(),
      saveFn: async (doc) => {
        activeWrites += 1;
        maxConcurrency = Math.max(maxConcurrency, activeWrites);
        try {
          const col = doc.cards[0]?.column ?? 'none';
          if (diskHistory.length === 0) {
            save1Started.resolve();
            await save1Gate.promise;
          } else {
            await saveFinalGate.promise;
          }
          diskHistory.push(col);
          return { ...doc, updatedAt: `saved-${col}` };
        } finally {
          activeWrites -= 1;
        }
      },
    });

    const recordState = (d) => uiHistory.push(d.cards[0]?.column ?? 'none');

    // 1. Slow save #1 starts writing 'todo' and actually enters saveFn
    const p1 = coordinator.persist(() => makeDocWithColumn('todo'), recordState);
    await save1Started.promise;
    // 2. While save #1 is truly in flight, user moves card todo -> doing -> done
    const p2 = coordinator.persist(
      (prev) => ({ ...prev, cards: prev.cards.map((c) => ({ ...c, column: 'doing' })) }),
      recordState,
    );
    const p3 = coordinator.persist(
      (prev) => ({ ...prev, cards: prev.cards.map((c) => ({ ...c, column: 'done' })) }),
      recordState,
    );

    assert.equal(coordinator.getDoc().cards[0].column, 'done', 'in-memory doc must immediately reflect latest move');

    // Release slow save #1 ('todo'): must NOT revert memory or UI back to 'todo'
    save1Gate.resolve();
    await p1;
    assert.equal(coordinator.getDoc().cards[0].column, 'done', 'stale save #1 must NEVER revert in-memory doc');
    assert.equal(uiHistory[uiHistory.length - 1], 'done', 'stale save #1 must NEVER call onState with older doc');

    // Release final save ('done')
    saveFinalGate.resolve();
    await Promise.all([p2, p3]);
    await coordinator.flush();

    assert.equal(maxConcurrency, 1, 'disk saves must be strictly serialized (maxConcurrency === 1)');
    assert.deepEqual(
      diskHistory,
      ['todo', 'done'],
      'superseded intermediate write (doing) should be skipped; disk must end at done',
    );
    assert.equal(coordinator.getDoc().cards[0].column, 'done');
    assert.equal(coordinator.getDoc().updatedAt, 'saved-done');
    assert.ok(!uiHistory.slice(3).includes('todo'), `UI must never revert to todo after moving forward: ${uiHistory.join(' -> ')}`);
  });

  test('createBoardSaveCoordinator replaceDoc prevents an in-flight save from overwriting a reloaded doc', async () => {
    const saveGate = createDeferred();
    const uiHistory = [];

    const coordinator = createBoardSaveCoordinator({
      initialDoc: makeDocWithColumn('todo'),
      saveFn: async (doc) => {
        await saveGate.promise;
        return { ...doc, updatedAt: 'from-old-save' };
      },
    });

    const p1 = coordinator.persist(
      (prev) => ({ ...prev, cards: prev.cards.map((c) => ({ ...c, column: 'doing' })) }),
      (d) => uiHistory.push(d.cards[0]?.column),
    );

    // Reload replaces doc with 'done' while p1 is still in flight
    coordinator.replaceDoc(makeDocWithColumn('done', 'reloaded'));
    saveGate.resolve();
    await p1;

    assert.equal(coordinator.getDoc().cards[0].column, 'done', 'in-flight save must not overwrite reloaded doc');
    assert.equal(coordinator.getDoc().updatedAt, 'reloaded');
  });

  test('saveBoard per-file queue preserves last write across 20 rapid overlapping saves', async () => {
    const box = await temps.make('save-board-seq');
    const libRoot = join(box, 'lib');
    await mkdir(libRoot, { recursive: true });

    for (let i = 0; i < 20; i += 1) {
      const pTodo = saveBoard(libRoot, makeDocWithColumn('todo', `t-${i}-1`));
      const pDoing = saveBoard(libRoot, makeDocWithColumn('doing', `t-${i}-2`));
      await Promise.all([pTodo, pDoing]);
      const loaded = await loadBoardSafe(libRoot);
      assert.equal(loaded.ok, true);
      assert.equal(loaded.doc.cards[0].column, 'doing', `iteration ${i}: disk must keep latest write 'doing'`);
    }
  });

  test('BoardView: moving card during in-flight upstream sync never reverts card on disk or UI', async () => {
    const box = await temps.make('board-sync-race');
    const libRoot = join(box, 'lib');
    await mkdir(libRoot, { recursive: true });

    let boardGetCount = 0;
    const secondBoardGetGate = createDeferred();
    let secondBoardGetStarted = false;

    const host = createMockHost(libRoot, async (action) => {
      if (action === 'board.get') {
        boardGetCount += 1;
        // Second board.get (from manual [S]) pauses so user can press 'L' while sync is in flight!
        if (boardGetCount === 2) {
          secondBoardGetStarted = true;
          await secondBoardGetGate.promise;
        }
        return {
          ok: true,
          value: {
            readOnly: false,
            revision: 3,
            columns: [
              { id: 'todo', title: 'Todo', cardIds: ['up-1'] },
              { id: 'doing', title: 'Doing', cardIds: [] },
              { id: 'done', title: 'Done', cardIds: [], done: true },
            ],
            cards: {
              'up-1': { id: 'up-1', title: 'InFlight Sync Task' },
            },
          },
        };
      }
      if (action === 'board.card.move') {
        return { ok: false, error: { message: 'Upstream temporarily busy' } };
      }
      return undefined;
    });

    resetStoreForTest();
    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage: 'board',
        initialLanguage: 'zh',
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
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

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('InFlight Sync Task'), {
        timeoutMs: 6_000,
        label: 'Initial upstream card rendered',
      });

      // Trigger manual sync [S] which stalls in board.get
      tty.send('S');
      await tty.waitFor(() => secondBoardGetStarted, {
        timeoutMs: 4_000,
        label: 'Second board.get started',
      });

      // While board.get (returning stale 'todo') is in flight, move card right to 'doing'
      // and wait until the optimistic local move is visible on screen before releasing board.get!
      tty.send('L');
      await tty.waitFor(
        (s) => /进行中 Doing\s+1\b/.test(s) || /Doing\s+1\b/.test(s),
        { timeoutMs: 4_000, label: 'Card moved optimistically to Doing while board.get is in flight' },
      );

      // Release stale board.get -> must NOT revert the card back to 'todo'
      secondBoardGetGate.resolve();

      await tty.waitFor(
        (s) => s.includes('看板写回失败') && s.includes('Upstream temporarily busy'),
        { timeoutMs: 6_000, label: 'Writeback failure banner rendered after queued move' },
      );

      // Immediately inspect tui-board.json -> local 'doing' MUST already be flushed on disk
      const saved = JSON.parse(await readFile(join(libRoot, 'tui-board.json'), 'utf8'));
      assert.equal(saved.cards.length, 1);
      assert.equal(
        saved.cards[0].column,
        'doing',
        'In-flight stale board.get must NEVER overwrite queued local move to doing',
      );
    } finally {
      inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
