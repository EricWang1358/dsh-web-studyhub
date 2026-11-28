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

async function startApp({ label, cols, rows, sample = false, initialPage = 'library', seed }) {
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
  const ink = render(React.createElement(StudyHubTuiApp, { host, initialPage, asciiMode: true }), {
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

/** The rows between a modal's title row and its bottom border, i.e. what the user can see of it. */
function modalRows(screen, title = 'Deck Operations') {
  const lines = screen.split('\n');
  const top = lines.findIndex((l) => l.includes(title));
  assert.ok(top >= 0, `${title} title row not found:\n${screen}`);
  let bottom = top + 1;
  while (bottom < lines.length && !/\+-{10,}\+/.test(lines[bottom])) bottom += 1;
  assert.ok(bottom < lines.length, `${title} bottom border not found on screen:\n${screen}`);
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

  test('4) PTY (60x18 en ascii): DeckOpsModal Import with completions, preview, AI banner and a long error keeps every row and cuts a long error with an ellipsis', async () => {
    const cols = LAYOUT_BP.MIN_VIEWPORT_COLS;
    const rows = LAYOUT_BP.MIN_VIEWPORT_ROWS;
    const longError = 'Import was rejected by the library because every card in this deck failed the duplicate check against an older deck';
    // Reviewer repro: Ink wraps by words, so a character budget let this one wrap past the error rows and cut the ellipsis line.
    const wordWrapError =
      'Import refused: international characterisation requirements unsatisfied; incompatible representations encountered throughout';
    const scripted = { error: longError };
    const app = await startApp({
      label: 'import-long-error',
      cols,
      rows,
      seed: async (host, base) => {
        await seedTwoTopicDeck(host);
        const good = join(base, 'n.json');
        await writeFile(
          good,
          JSON.stringify({ title: 'Fresh deck', course: 'OS 1748', cards: [{ kind: 'flashcard', prompt: 'Q?', answer: 'A.' }] }),
          'utf8',
        );
        // A sibling that shares the prefix, so the Tab completions row shows next to the valid file.
        await writeFile(join(base, 'n.json.json'), '{}', 'utf8');
        // Scripted replies: no model, no real import. The point is only the rows the modal draws.
        const realCall = host.call.bind(host);
        host.call = async (name, args) => {
          if (name === 'draft.import.propose') {
            return { ok: true, value: { title: 'Fresh deck', course: 'OS 1748', mergeTargetId: null, method: 'rules' } };
          }
          if (name === 'deck.import' && args?.path) return { ok: false, error: { message: scripted.error } };
          return realCall(name, args);
        };
        return { good };
      },
    });
    const { tty, seeded } = app;
    try {
      await tty.waitFor((s) => useTuiStore.getState().page === 'library' && s.includes('Kernel Mix'), {
        label: 'LibraryView ready with the seeded deck',
      });
      tty.send('o');
      await tty.waitFor((s) => s.includes('Deck Operations') && s.includes('Local JSON Path'), { label: 'Import tab' });
      tty.send(seeded.good);
      await tty.waitFor((s) => s.includes('[OK]') && /Tab: /.test(modalRows(s)), { label: 'preview and completions rows' });
      tty.send('\x07');
      await tty.waitFor((s) => s.includes('Suggest'), { label: 'AI filing confirm dialog' });
      tty.send('\r');
      await tty.waitFor((s) => /Suggested: Course/.test(s), { label: 'AI filing banner' });
      useTuiStore.setState({ toasts: [] }); // the "Filing proposal" toast would cover the modal's bottom border
      tty.send('\r');
      const errScreen = await tty.waitFor((s) => s.includes('[X] '), { label: 'long import error row' });
      const errRows = modalRows(errScreen);
      assert.match(errRows, /Tab: /, `completions row stays:\n${errScreen}`);
      assert.match(errRows, /Preview:/, `the preview row must not be squeezed out by the error:
${errScreen}`);
      assert.match(errRows, /Suggested: Course/, `AI banner stays:\n${errScreen}`);
      assert.match(errRows, /Course Override/, `course field stays:\n${errScreen}`);
      assert.match(errRows, /\[X\] Import was rejected/, `error row must be inside the frame:\n${errScreen}`);
      assert.match(errRows, /\[X\] [\s\S]*\.\.\./, `a long error is cut with an ellipsis, not clipped mid-line:
${errScreen}`);
      assert.equal(errRows.includes('older deck'), false, `the error must not be left half-visible:\n${errScreen}`);
      tty.assertHealthyScreen(errScreen, cols, rows, 'DeckOpsModal import long error 60x18');

      // The reviewer's sentence: whole words, so it wraps by words; the ellipsis must still be on the last visible row.
      scripted.error = wordWrapError;
      tty.send('\r');
      const wrapScreen = await tty.waitFor((s) => s.includes('Import refused'), { label: 'word-wrapped import error row' });
      const wrapRows = modalRows(wrapScreen);
      assert.match(wrapRows, /\[X\] Import refused/, `error row must be inside the frame:\n${wrapScreen}`);
      assert.match(wrapRows, /\.\.\.\s*\|?\s*(?:\n|$)/, `the cut error ends with a visible ellipsis:\n${wrapScreen}`);
      assert.equal(wrapRows.includes('throughout'), false, `the error must not be left half-visible:\n${wrapScreen}`);
      assert.match(wrapRows, /Tab: /, `completions row stays:\n${wrapScreen}`);
      assert.match(wrapRows, /Preview:/, `the preview row stays:\n${wrapScreen}`);
      assert.match(wrapRows, /Suggested: Course/, `AI banner stays:\n${wrapScreen}`);
      assert.match(wrapRows, /Course Override/, `course field stays:\n${wrapScreen}`);
      tty.assertHealthyScreen(wrapScreen, cols, rows, 'DeckOpsModal import word-wrapped error 60x18');
    } finally {
      await app.stop();
    }
  });

  test('5) PTY (60x18 en ascii): CardToolsModal menu mode with placement summary fits within 60x18 without clipping borders, title, or footer and scrolls to [R]', async () => {
    const cols = LAYOUT_BP.MIN_VIEWPORT_COLS;
    const rows = LAYOUT_BP.MIN_VIEWPORT_ROWS;
    const app = await startApp({
      label: 'card-tools-60x18',
      cols,
      rows,
      initialPage: 'review',
      seed: async (host) => {
        const imp = await host.call('deck.import', {
          text: JSON.stringify({
            title: 'Kernel Quiz',
            course: 'OS 1748',
            cards: [{ kind: 'open', prompt: 'What is a TLB?', answer: 'Translation lookaside buffer.', topic: 'Paging' }],
          }),
          folder: 'OS 1748',
        });
        assert.equal(imp.ok, true, imp.error?.message);
        const snap = await host.call('snapshot', {});
        const deck = (snap.value?.decks ?? []).find((d) => d.title === 'Kernel Quiz');
        assert.ok(deck?.id, 'Kernel Quiz deck must exist');
        const startRes = await host.call('review.start', { mode: 'quiz', deckId: deck.id, fresh: true });
        assert.equal(startRes.ok, true, startRes.error?.message);
        const realCall = host.call.bind(host);
        host.call = async (name, args) => {
          if (name === 'card.place') {
            return {
              ok: true,
              value: {
                course: 'OS 1748',
                document: { key: 'd1', title: 'Virtual Memory' },
                chapter: { key: 'c1', title: 'Paging' },
                leaf: { key: 'l1', title: 'Page Tables', built: true },
              },
            };
          }
          if (name === 'card.focus') {
            return {
              ok: false,
              error: { message: 'Unable to update syllabus focus mark because the remote deck index could not be synchronized right now' },
            };
          }
          return realCall(name, args);
        };
        useTuiStore.setState({
          page: 'review',
          activeRunId: startRes.value.id,
          navContext: { runId: startRes.value.id },
        });
        return { runId: startRes.value.id };
      },
    });
    const { tty } = app;
    try {
      await tty.waitFor((s) => useTuiStore.getState().page === 'review' && /OS 1748|Paging|Scheduling/.test(s), {
        label: 'ReviewView ready at 60x18',
      });
      tty.send('D');
      const toolsScreen = await tty.waitFor(
        (s) => s.includes('Card Tools') && s.includes('Review Book:') && s.includes('Source:'),
        { timeoutMs: 8_000, label: 'CardToolsModal menu with placement summary opened at 60x18' },
      );
      const screenLines = toolsScreen.split('\n');
      const titleIdx = screenLines.findIndex((l) => l.includes('Card Tools'));
      assert.ok(titleIdx >= 1 && /\+-{10,}\+/.test(screenLines[titleIdx - 1]), `top border must stay visible above title:\n${toolsScreen}`);
      const rowsText = modalRows(toolsScreen, 'Card Tools');
      assert.match(rowsText, /Review Book: Page Tables/, `review book row must stay visible:\n${toolsScreen}`);
      assert.match(rowsText, /Source: Virtual Memory/, `source row must stay visible:\n${toolsScreen}`);
      assert.match(rowsText, /\[1\] Edit Question/, `first menu option must stay visible:\n${toolsScreen}`);
      assert.match(rowsText, /Esc Close/, `modal hints footer must stay inside frame:\n${toolsScreen}`);
      tty.assertHealthyScreen(toolsScreen, cols, rows, 'CardToolsModal menu 60x18');
      tty.assertAsciiPure(toolsScreen, 'CardToolsModal menu 60x18');

      // Wrap upward from [1] to [R] Retry Failed AI Rewrite and verify the scrolled window brings [R] into view cleanly.
      tty.send('k');
      const scrolledScreen = await tty.waitFor(
        (s) => s.includes('Retry Failed AI Rewrite') && s.includes('> [R]'),
        { timeoutMs: 5_000, label: 'CardToolsModal scrolled to [R] at 60x18' },
      );
      const scrolledLines = scrolledScreen.split('\n');
      const scrolledTitleIdx = scrolledLines.findIndex((l) => l.includes('Card Tools'));
      assert.ok(scrolledTitleIdx >= 1 && /\+-{10,}\+/.test(scrolledLines[scrolledTitleIdx - 1]), `top border must stay visible after scroll:\n${scrolledScreen}`);
      const scrolledRows = modalRows(scrolledScreen, 'Card Tools');
      assert.match(scrolledRows, /> \[R\] Retry Failed AI Rewrite/, `[R] must be visible and selected:\n${scrolledScreen}`);
      assert.match(scrolledRows, /Esc Close/, `modal hints footer must stay visible after scroll:\n${scrolledScreen}`);
      tty.assertHealthyScreen(scrolledScreen, cols, rows, 'CardToolsModal scrolled to [R] 60x18');
      tty.assertAsciiPure(scrolledScreen, 'CardToolsModal scrolled to [R] 60x18');

      // Pressing [4] when unavailable displays a multi-row wrapped error; menu window must shrink so frame stays within 60x18.
      tty.send('4');
      const errScreen = await tty.waitFor((s) => s.includes('Available only after'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal unavailable error at 60x18',
      });
      const errLines = errScreen.split('\n');
      const errTitleIdx = errLines.findIndex((l) => l.includes('Card Tools'));
      assert.ok(errTitleIdx >= 1 && /\+-{10,}\+/.test(errLines[errTitleIdx - 1]), `top border must stay visible with error:\n${errScreen}`);
      const errRows = modalRows(errScreen, 'Card Tools');
      assert.match(errRows, /x Available only after/, `error row must stay inside frame:\n${errScreen}`);
      assert.match(errRows, /Esc Close/, `modal hints footer must stay visible with error:\n${errScreen}`);
      tty.assertHealthyScreen(errScreen, cols, rows, 'CardToolsModal menu with error 60x18');
      tty.assertAsciiPure(errScreen, 'CardToolsModal menu with error 60x18');

      // Trigger a >2-row error via [5] (card.focus): truncated row 2 must use ASCII '...' (not Unicode '…') and stay inside 60x18.
      tty.send('5');
      const longErrScreen = await tty.waitFor((s) => s.includes('Unable to update syllabus focus'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal long error truncation at 60x18',
      });
      const longErrLines = longErrScreen.split('\n');
      const longErrTitleIdx = longErrLines.findIndex((l) => l.includes('Card Tools'));
      assert.ok(longErrTitleIdx >= 1 && /\+-{10,}\+/.test(longErrLines[longErrTitleIdx - 1]), `top border must stay visible with long error:\n${longErrScreen}`);
      const longErrRows = modalRows(longErrScreen, 'Card Tools');
      assert.match(longErrRows, /x Unable to update syllabus focus/, `long error must render inside frame:\n${longErrScreen}`);
      assert.match(longErrRows, /\.\.\./, `truncated >2-row error must end with ASCII '...' in asciiMode:\n${longErrScreen}`);
      assert.match(longErrRows, /Esc Close/, `modal hints footer must stay visible with long error:\n${longErrScreen}`);
      tty.assertHealthyScreen(longErrScreen, cols, rows, 'CardToolsModal menu with >2-row error 60x18');
      tty.assertAsciiPure(longErrScreen, 'CardToolsModal menu with >2-row error 60x18');
    } finally {
      await app.stop();
    }
  });
});
