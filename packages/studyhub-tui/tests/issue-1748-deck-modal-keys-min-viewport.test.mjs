// #1748: DeckManageModal browse keys (k moves up like j/Up/Down, v opens card-kind conversion) and
// DeckOpsModal at the minimum supported viewport (60x18): the Split topic cursor, title input and error row,
// and the Import fields with their hint/error rows, must all stay inside the frame Modal really draws.
// Before the fix the body asked for more rows than Modal leaves; Yoga then squeezed rows out of sight
// (the Import course label vanished, the Split list drew fewer rows than it scrolled by).
// Real StudyHubTuiApp from dist/ in an @xterm/headless terminal; 0 model calls, 0 network.
// Run: node scripts/build.mjs && node --test tests/issue-1748-deck-modal-keys-min-viewport.test.mjs
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();
const { LAYOUT_BP } = await import('../src/layout/breakpoints.ts');

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-1748-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

function resetStore(language, asciiMode) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
  });
}

async function startApp({ label, cols, rows, sample = false, seed }) {
  const base = await temps.make(label);
  const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
  process.env.DSH_HOME = env.DSH_HOME;
  await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
  resetStore('en', true);
  const libraryRoot = join(base, 'library');
  if (sample) await cloneSampleLibrary('en', libraryRoot);
  const host = await createTuiHost({
    libraryRoot,
    env,
    home: base,
    documentsDir: base,
    providerDiscovery: fakeDiscovery(),
    skipAutoProbe: true,
    language: 'en',
  });
  const seeded = seed ? await seed(host, base) : null;
  const tty = createVirtualTty(cols, rows);
  const ink = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
    stdin: tty.stdin,
    stdout: tty.stdout,
    stderr: tty.stderr,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await tty.firstFramePromise;
  const stop = async () => {
    try {
      ink.unmount();
    } catch {
      // ignore teardown unmount errors
    }
    tty.dispose();
    await host.dispose();
  };
  return { host, tty, base, seeded, stop };
}

/** The rows between the DeckOpsModal title row and its bottom border, i.e. what the user can see of it. */
function modalRows(screen) {
  const lines = screen.split('\n');
  const top = lines.findIndex((l) => l.includes('Deck Operations'));
  assert.ok(top >= 0, `DeckOpsModal title row not found:\n${screen}`);
  let bottom = top + 1;
  while (bottom < lines.length && !/\+-{10,}\+/.test(lines[bottom])) bottom += 1;
  assert.ok(bottom < lines.length, `DeckOpsModal bottom border not found on screen:\n${screen}`);
  return lines.slice(top, bottom).join('\n');
}

// Seven topics: enough rows that the Split topic list fills its box, so an over-tall body cannot hide the
// overflow in blank list rows and must push the title input or the error row out of the frame.
const SPLIT_TOPICS = ['Paging', 'Scheduling', 'Files', 'Locks', 'Memory', 'Devices', 'Signals'];

async function seedTwoTopicDeck(host) {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Kernel Mix',
      course: 'OS 1748',
      cards: [
        { kind: 'flashcard', prompt: 'What is a TLB?', answer: 'A cache of page translations.', topic: 'Paging' },
        ...SPLIT_TOPICS.map((topic) => ({
          kind: 'flashcard',
          prompt: `Name one idea in ${topic}.`,
          answer: `A core idea of ${topic}.`,
          topic,
        })),
      ],
    }),
    folder: 'OS 1748',
  });
  assert.equal(imp.ok, true, imp.error?.message);
  const focus = await host.call('focus.set', { course: 'OS 1748' });
  assert.equal(focus.ok, true, focus.error?.message);
  await host.refreshSnapshot();
}

describe('#1748 DeckManageModal j/k symmetry and DeckOpsModal at the 60x18 minimum viewport', () => {
  test('1) PTY (120x36 en ascii): in DeckManageModal browse, k moves up like Up, and v opens card-kind conversion', async () => {
    const app = await startApp({ label: 'jk', cols: 120, rows: 36, sample: true });
    const { tty } = app;
    try {
      await tty.waitFor((s) => useTuiStore.getState().page === 'library' && s.includes('Memento'), {
        label: 'LibraryView ready',
      });
      tty.send('m');
      const browse = await tty.waitFor(
        (s) => s.includes('Manage Deck') && s.includes('Sel') && !s.includes('Loading deck cards'),
        { label: 'DeckManageModal browse' },
      );
      assert.match(browse, / v Kind /, 'browse footer must advertise v for card-kind conversion');
      assert.doesNotMatch(browse, / k Kind /, 'browse footer must no longer bind k to conversion');

      tty.send('j');
      await tty.flush(60);
      tty.send('k');
      await tty.flush(120);
      assert.equal(tty.readScreen().includes('Convert Card Kind'), false, 'k must not open card-kind conversion');
      // Space marks the selected row: after j then k the selection is back on row 1, not on row 2.
      tty.send(' ');
      const marked = await tty.waitFor((s) => s.includes('[1 sel]'), { label: 'one card selected after j, k, Space' });
      assert.equal(marked.includes('Convert Card Kind'), false, 'k must not open card-kind conversion');
      assert.match(marked, /\[x\]\s+1\./, 'after j then k the first card must be the selected one');
      assert.match(marked, /\[ \]\s+2\./, 'after j then k the second card must not be selected');

      tty.send('x');
      await tty.waitFor((s) => !s.includes('[1 sel]'), { label: 'selection cleared' });
      tty.send('v');
      await tty.waitFor((s) => s.includes('Convert Card Kind') && s.includes('From:'), {
        label: 'v opens card-kind conversion',
      });
    } finally {
      await app.stop();
    }
  });

  test('2) PTY (60x18 en ascii): DeckOpsModal Split title input, cursor and error row stay inside the frame', async () => {
    const cols = LAYOUT_BP.MIN_VIEWPORT_COLS;
    const rows = LAYOUT_BP.MIN_VIEWPORT_ROWS;
    const app = await startApp({ label: 'split', cols, rows, seed: seedTwoTopicDeck });
    const { tty } = app;
    try {
      await tty.waitFor((s) => useTuiStore.getState().page === 'library' && s.includes('Kernel Mix'), {
        label: 'LibraryView ready with the seeded deck',
      });
      tty.send('o');
      await tty.waitFor((s) => s.includes('Deck Operations') && s.includes('Import JSON'), { label: 'DeckOpsModal open' });
      tty.send('\x1b[A');
      await tty.flush(60);
      tty.send('3');
      await tty.waitFor((s) => s.includes(`Topics: 0/${SPLIT_TOPICS.length}`), { label: 'Split tab with all topics' });
      // The topic list must scroll by the rows it really has: with a body taller than the frame, the list believed
      // it had a row more than it was drawn with, so the cursor sat on a row that was cut off.
      const last = SPLIT_TOPICS[SPLIT_TOPICS.length - 1];
      for (let i = 1; i < SPLIT_TOPICS.length; i += 1) {
        tty.send('\x1b[B');
        await tty.flush();
      }
      await tty.flush(80);
      const scrolled = await tty.waitFor((s) => s.includes('Topics: 0/'), { label: 'topic cursor moved' });
      assert.match(modalRows(scrolled), new RegExp(`\\[ \\] ${last}\\b`), `the topic under the cursor must be on screen:\n${scrolled}`);
      tty.send('\r');
      const titleFocus = await tty.waitFor((s) => s.includes('Up/Esc Topics'), { label: 'New Deck Title focused' });
      const titleRows = modalRows(titleFocus);
      assert.match(titleRows, /New Deck Title \(Enter to split\):/, `title label must be visible:\n${titleFocus}`);
      assert.match(titleRows, /> Kernel Mix - \w+/, `prefilled title input row must be visible:\n${titleFocus}`);

      // Clear the title and submit: the error row must appear inside the frame too.
      for (let i = 0; i < 'Kernel Mix - Scheduling'.length; i += 1) {
        tty.send('\x7f');
        await tty.flush();
      }
      const cleared = await tty.waitFor((s) => s.includes('Enter new deck title'), { label: 'title cleared to placeholder' });
      assert.match(modalRows(cleared), /> Enter new deck title/, `empty title input + cursor must be visible:\n${cleared}`);
      tty.send('\r');
      const withError = await tty.waitFor((s) => s.includes('Up/Esc Topics') && useTuiStore.getState().page === 'library', {
        label: 'still on the title field',
      });
      await tty.flush(120);
      const errScreen = await tty.waitFor((s) => s.includes('Please enter a title for the new deck'), {
        label: 'split title error row visible',
      });
      assert.ok(withError);
      const errRows = modalRows(errScreen);
      assert.match(errRows, /\[X\] Please enter a title for the new deck/, `error row must be inside the frame:\n${errScreen}`);
      assert.match(errRows, /> Enter new deck title/, `input row must stay visible with the error:\n${errScreen}`);
      tty.assertHealthyScreen(errScreen, cols, rows, 'DeckOpsModal split 60x18');
      tty.assertAsciiPure(errScreen, 'DeckOpsModal split 60x18');
    } finally {
      await app.stop();
    }
  });

  test('3) PTY (60x18 en ascii): DeckOpsModal Import hint and error rows stay inside the frame', async () => {
    const cols = LAYOUT_BP.MIN_VIEWPORT_COLS;
    const rows = LAYOUT_BP.MIN_VIEWPORT_ROWS;
    const app = await startApp({
      label: 'import',
      cols,
      rows,
      seed: async (host, base) => {
        await seedTwoTopicDeck(host);
        const bad = join(base, 'n.json');
        await writeFile(bad, JSON.stringify({ title: 'No cards here' }), 'utf8');
        return { bad };
      },
    });
    const { tty, seeded } = app;
    try {
      await tty.waitFor((s) => useTuiStore.getState().page === 'library' && s.includes('Kernel Mix'), {
        label: 'LibraryView ready with the seeded deck',
      });
      tty.send('o');
      await tty.waitFor((s) => s.includes('Deck Operations') && s.includes('Local JSON Path'), { label: 'Import tab' });
      tty.send(seeded.bad);
      const hinted = await tty.waitFor((s) => s.includes('[!] '), { label: 'invalid deck JSON hint row' });
      assert.match(modalRows(hinted), /\[!\] /, `hint row must be inside the frame:\n${hinted}`);
      tty.send('\r');
      const errScreen = await tty.waitFor((s) => s.includes('[X] '), { label: 'import error row' });
      const errRows = modalRows(errScreen);
      assert.match(errRows, /\[!\] /, `hint row must stay inside the frame with the error:\n${errScreen}`);
      assert.match(errRows, /\[X\] /, `error row must be inside the frame:\n${errScreen}`);
      assert.match(errRows, /Course Override/, `course field must stay visible:\n${errScreen}`);
      tty.assertHealthyScreen(errScreen, cols, rows, 'DeckOpsModal import 60x18');
    } finally {
      await app.stop();
    }
  });
});
