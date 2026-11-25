// #1454: Board save failure must tell the user that their edit was NOT persisted and that the
// board was reverted to the last saved content — the raw error alone is misleading (cards vanish).
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp } = runtime;
const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore } = await import(pathToFileURL(join(distDir, storeFile)).href);

const temps = createTempTracker('studyhub-tui-1454-');

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

function createMockHost(libraryRoot) {
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
    call: async (action) => {
      if (action === 'snapshot') return { ok: true, value: baseSnapshot };
      if (action === 'binding.get') return { ok: true, value: { root: libraryRoot } };
      if (action === 'desktop.config.get') return { ok: true, value: baseConfig };
      // No upstream board in this fixture: local-only board, so the only failure is the disk save.
      return { ok: false, error: { message: `no upstream for ${action}`, code: 'UNKNOWN' } };
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

describe('#1454: board save failure notice', () => {
  test('save failure toast says edits were not saved and the board was reverted, and keeps the original error', async () => {
    const box = await temps.make('board-notice');
    const libRoot = join(box, 'lib');
    await mkdir(libRoot, { recursive: true });
    const stamp = '2026-11-24T00:00:00.000Z';
    await writeFile(
      join(libRoot, 'tui-board.json'),
      `${JSON.stringify(
        {
          version: 1,
          cards: [{ id: 'card-1', title: 'Rollback Task', column: 'todo', createdAt: stamp, updatedAt: stamp }],
          deletedUpstreamIds: [],
          updatedAt: stamp,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const host = createMockHost(libRoot);
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
      await tty.waitFor((s) => s.includes('Rollback Task'), {
        timeoutMs: 6_000,
        label: 'initial board card rendered',
      });
      await tty.waitFor((s) => /待办 Todo\s*\(?1\)?/.test(s), {
        timeoutMs: 4_000,
        label: 'todo column starts with 1 card',
      });

      // Make the next board save fail deterministically (ENOTDIR) without relying on permissions:
      // the library root stops being a directory after the board was loaded.
      await rm(libRoot, { recursive: true, force: true });
      await writeFile(libRoot, 'not a directory anymore\n', 'utf8');

      // Move the card right: the optimistic move is shown, then the disk write fails.
      tty.send('L');

      await tty.waitFor((s) => s.includes('修改没有保存'), {
        timeoutMs: 8_000,
        label: 'save failure toast explains the edit was not saved',
      });
      const screen = tty.readScreen();
      assert.match(screen, /已恢复到上次保存的内容/, 'toast must say the board reverted to the last saved content');
      assert.match(screen, /ENOTDIR|not a directory/i, 'toast must keep the original error detail');
      assert.match(screen, /待办 Todo\s*\(?1\)?/, 'failed save must roll the card back to the todo column');
      assert.match(screen, /进行中 Doing\s*\(?0\)?/, 'failed save must not leave the optimistic move on screen');

      const toast = useTuiStore.getState().toasts.at(-1);
      assert.ok(toast, 'a toast must be enqueued');
      assert.equal(toast.tone, 'error');
      assert.match(toast.text, /修改没有保存，已恢复到上次保存的内容/);
    } finally {
      inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
