// Consolidated Library Decks Domain Suite
// Merges: round36-library-e2e, round39-deck-restore, round46-batch-slay, round47-batch-topic,
//         round49-batch-link, round53-deck-merge-guard, round55-import-propose, round56-deck-course,
//         round69-library-export, round71-library-filter
// node --test tests/domain-library-decks.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Box, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const [
  { DeckManageModal },
  { formatDeckMarkdown },
  { ToastStack },
  { useTuiStore: useSrcTuiStore },
] = await Promise.all([
  import('../src/views/library/DeckManageModal.tsx'),
  import('../src/views/library/deck-export.ts'),
  import('../src/components/Badge.tsx'),
  import('../src/state/store.ts'),
]);

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-decks-');

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
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
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

function resetStore(store, language = 'zh', asciiMode = false, extra = {}) {
  store.setState({
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
    ...extra,
  });
}

function DeckManageModalHarness({ host, deckId, width = 120, height = 36, onClose = () => {}, onUpdated }) {
  const toasts = useSrcTuiStore((s) => s.toasts);
  const dismissToast = useSrcTuiStore((s) => s.dismissToast);
  return React.createElement(
    Box,
    { width, height, flexDirection: 'column', position: 'relative' },
    React.createElement(DeckManageModal, {
      host,
      deckId,
      isActive: true,
      width,
      height,
      onClose,
      onUpdated,
    }),
    React.createElement(ToastStack, {
      toasts,
      width: Math.min(60, width - 4),
      onDismiss: dismissToast,
      autoDismissMs: 0,
    }),
  );
}

function deckListTextAfterHeader(screen) {
  const lines = screen.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('题组列表') || l.includes('Decks'));
  if (headerIdx < 0) return screen;
  return lines.slice(headerIdx + 1).join('\n');
}

function cardNodeId(deckId, cardId) {
  return `card:${JSON.stringify([deckId, cardId])}`;
}

function todayLocalYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function seedSampleDeck(host) {
  const sampleRes = await host.call('sample.status', {});
  assert.equal(sampleRes.ok, true, sampleRes.error?.message);
  assert.equal(sampleRes.value?.loaded, true, 'sample library must be pre-seeded via cloneSampleLibrary');

  const snap0 = await host.call('snapshot', {});
  assert.equal(snap0.ok, true);
  const origDeck = (snap0.value?.decks ?? []).find((d) => !d.systemKind);
  assert.ok(origDeck, 'sample course must include an ordinary deck');

  const origGet0 = await host.call('deck.get', { id: origDeck.id });
  assert.equal(origGet0.ok, true, origGet0.error?.message);
  return { snap0: snap0.value, origDeck, origDetail: origGet0.value };
}

async function seedTwoCourseDecks(host, course = 'Linear Algebra') {
  const d1 = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Matrices Part 1',
      course,
      cards: [
        { kind: 'flashcard', prompt: 'What is matrix rank?', answer: 'Dimension of column space.', topic: 'Matrices' },
      ],
    }),
    folder: course,
  });
  assert.equal(d1.ok, true, `deck.import 1 failed: ${d1.error?.message}`);

  const d2 = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Matrices Part 2',
      course,
      cards: [
        { kind: 'flashcard', prompt: 'What is matrix trace?', answer: 'Sum of diagonal entries.', topic: 'Matrices' },
      ],
    }),
    folder: course,
  });
  assert.equal(d2.ok, true, `deck.import 2 failed: ${d2.error?.message}`);

  const focusRes = await host.call('focus.set', { course });
  assert.equal(focusRes.ok, true, `focus.set failed: ${focusRes.error?.message}`);

  const snapRes = await host.refreshSnapshot();
  const decks = (snapRes.snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind && d.course === course);
  assert.equal(decks.length, 2, 'Expected 2 active decks in seeded course');
  return decks;
}

async function seedCourseDeck(host, title = 'Eigenvalues Core', course = 'Linear Algebra') {
  const res = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        { kind: 'flashcard', prompt: 'Define an eigenvalue.', answer: 'Scalar lambda with Av = lambda v.', topic: 'Eigenvalues' },
      ],
    }),
    folder: course,
  });
  assert.equal(res.ok, true, `deck.import failed: ${res.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deck, `Expected seeded deck "${title}"`);
  return deck;
}

async function seedSimpleDeck(host, { title, course, prompt = 'What is a vector space?', answer = 'A set closed under linear combinations.' }) {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [{ kind: 'flashcard', prompt, answer, topic: 'Basics' }],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deck, `Seeded deck "${title}" must exist in snapshot`);
  return deck;
}

describe('Round 36: LibraryView deck reordering ([ / ]) E2E', () => {
  test('1) createTuiHost integration: load sample course, swap first two decks with deck.reorder, verify snapshot, swap back', async () => {
    const base = await temps.make('r36-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.status', {});
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const initialSnap = await host.call('snapshot', {});
      assert.equal(initialSnap.ok, true, initialSnap.error?.message);
      const initialIds = (initialSnap.value?.decks ?? []).map((d) => d.id);
      assert.ok(initialIds.length >= 2, `Expected at least 2 sample decks, got ${initialIds.length}`);

      const badRes = await host.call('deck.reorder', { ids: [initialIds[0]] });
      assert.equal(badRes.ok, false, 'deck.reorder must reject incomplete ids');
      assert.ok(badRes.error?.message, 'incomplete ids rejection must include error message');

      const swappedIds = [initialIds[1], initialIds[0], ...initialIds.slice(2)];
      const swapRes = await host.call('deck.reorder', { ids: swappedIds });
      assert.equal(swapRes.ok, true, swapRes.error?.message);
      assert.deepEqual(swapRes.value?.ids ?? swappedIds, swappedIds);

      const afterSwapSnap = await host.call('snapshot', {});
      assert.equal(afterSwapSnap.ok, true);
      assert.deepEqual(
        (afterSwapSnap.value?.decks ?? []).map((d) => d.id),
        swappedIds,
        'snapshot must reflect swapped deck order',
      );

      const restoreRes = await host.call('deck.reorder', { ids: initialIds });
      assert.equal(restoreRes.ok, true, restoreRes.error?.message);
      assert.deepEqual(restoreRes.value?.ids ?? initialIds, initialIds);

      const restoredSnap = await host.call('snapshot', {});
      assert.equal(restoredSnap.ok, true);
      assert.deepEqual(
        (restoredSnap.value?.decks ?? []).map((d) => d.id),
        initialIds,
        'snapshot must reflect restored deck order',
      );
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): LibraryView [ / ] reorders sample decks, keeps focus on moved deck, and handles boundaries', async () => {
    const base = await temps.make('r36-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetStore(useDistTuiStore, 'zh', false, { loading: true });
    await cloneSampleLibrary('zh', libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const sampleRes = await host.call('sample.status', {});
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);
    const snap0 = await host.call('snapshot', {});
    assert.equal(snap0.ok, true);
    const initialIds = (snap0.value?.decks ?? []).map((d) => d.id);
    assert.ok(initialIds.length >= 2, 'sample course must provide at least 2 decks');
    const firstDeckTitle = snap0.value.decks[0].title;
    const secondDeckTitle = snap0.value.decks[1].title;

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      const firstPrefix = firstDeckTitle.slice(0, 10);
      const secondPrefix = secondDeckTitle.slice(0, 10);
      const initialScreen = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'library' &&
          s.includes(firstDeckTitle) &&
          s.includes(secondPrefix) &&
          (s.includes('[/]') || s.includes('[ / ]')),
        { timeoutMs: 15_000, label: 'LibraryView initial render with sample decks and [/] hint' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, 'LibraryView initial 120x36');
      const initialList = deckListTextAfterHeader(initialScreen);
      assert.ok(
        initialList.indexOf(firstPrefix) >= 0 && initialList.indexOf(firstPrefix) < initialList.indexOf(secondPrefix),
        'first sample deck must appear before second sample deck initially',
      );

      tty.send('[');
      await tty.waitFor(
        () => useDistTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个题组')),
        { label: 'Boundary toast when pressing [ at index 0' },
      );
      assert.equal(useDistTuiStore.getState().page, 'library', '[ must be claimed by LibraryView and not navigate away');
      assert.ok(useDistTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个题组')));
      assert.deepEqual(
        (useDistTuiStore.getState().snapshot?.decks ?? []).map((d) => d.id),
        initialIds,
        'boundary [ must preserve deck order',
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'LibraryView after [ at index 0');

      tty.send(']');
      await tty.waitFor(
        () =>
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes(`已下移「${firstDeckTitle}」`)) &&
          (useDistTuiStore.getState().snapshot?.decks ?? [])[1]?.id === initialIds[0],
        { label: 'Moved first deck down with ]' },
      );
      const afterDownScreen = await tty.waitFor(
        (s) => {
          const list = deckListTextAfterHeader(s);
          const idx1 = list.indexOf(secondPrefix);
          const idx0 = list.indexOf(firstPrefix);
          return idx1 >= 0 && idx0 > idx1 && s.includes(firstDeckTitle);
        },
        { label: 'Updated deck order rendered after ]' },
      );
      tty.assertHealthyScreen(afterDownScreen, 120, 36, 'LibraryView after ]');
      assert.equal(useDistTuiStore.getState().snapshot?.decks?.[0]?.id, initialIds[1]);
      assert.equal(useDistTuiStore.getState().snapshot?.decks?.[1]?.id, initialIds[0]);

      tty.send(']');
      await tty.waitFor(
        () => useDistTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是最后一个题组')),
        { label: 'Boundary toast confirming focus stayed on moved deck at last index' },
      );
      assert.ok(useDistTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是最后一个题组')));

      tty.send('[');
      await tty.waitFor(
        () =>
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes(`已上移「${firstDeckTitle}」`)) &&
          (useDistTuiStore.getState().snapshot?.decks ?? [])[0]?.id === initialIds[0],
        { label: 'Moved deck back up with [' },
      );
      const afterUpScreen = await tty.waitFor(
        (s) => {
          const list = deckListTextAfterHeader(s);
          const idx0 = list.indexOf(firstPrefix);
          const idx1 = list.indexOf(secondPrefix);
          return idx0 >= 0 && idx1 > idx0 && s.includes(firstDeckTitle);
        },
        { label: 'Restored deck order rendered after [' },
      );
      tty.assertHealthyScreen(afterUpScreen, 120, 36, 'LibraryView after [');
      assert.ok(afterUpScreen.includes(firstDeckTitle));
      assert.deepEqual(
        (useDistTuiStore.getState().snapshot?.decks ?? []).map((d) => d.id),
        initialIds,
      );
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 39: Slain Card Restore (card.restore) & Deck Folder Move (deck.move)', () => {
  test('1) createTuiHost integration: card.slay -> Slain system deck -> card.restore -> deck.move round-trip & empty clear', async () => {
    const base = await temps.make('r39-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      const origCount0 = origDetail.cards.length;
      assert.ok(origCount0 >= 2, 'sample deck must have at least 2 cards');
      const targetCard = origDetail.cards[0];

      const slayRes = await host.call('card.slay', { deckId: origDeck.id, cardId: targetCard.id });
      assert.equal(slayRes.ok, true, `card.slay failed: ${slayRes.error?.message}`);
      const slainDeckId = slayRes.value?.deckId;
      assert.ok(slainDeckId, 'card.slay must return slain deckId');

      const snapSlain = await host.call('snapshot', {});
      assert.equal(snapSlain.ok, true);
      const slainSummary = (snapSlain.value?.decks ?? []).find((d) => d.id === slainDeckId);
      assert.ok(slainSummary, 'Slain system deck must appear in snapshot');
      assert.equal(slainSummary.systemKind, 'slain');
      assert.equal(slainSummary.count, 1);

      const slainGet = await host.call('deck.get', { id: slainDeckId });
      assert.equal(slainGet.ok, true);
      assert.equal(slainGet.value.systemKind, 'slain');
      const slainCard = slainGet.value.cards.find((c) => c.id === targetCard.id);
      assert.ok(slainCard, 'slain card must be inside Slain system deck');
      assert.equal(slainCard.slain?.deckId, origDeck.id, 'card.slain must record original deckId');
      assert.equal(slainCard.slain?.deckTitle, origDeck.title, 'card.slain must record original deckTitle');
      assert.equal(slainCard.suspended, true, 'slain card must be suspended');

      const origGetAfterSlay = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origGetAfterSlay.ok, true);
      assert.equal(origGetAfterSlay.value.cards.length, origCount0 - 1);
      assert.equal(origGetAfterSlay.value.cards.some((c) => c.id === targetCard.id), false);

      const restoreRes = await host.call('card.restore', { deckId: slainDeckId, cardId: targetCard.id });
      assert.equal(restoreRes.ok, true, `card.restore failed: ${restoreRes.error?.message}`);
      assert.equal(restoreRes.value?.deckId, origDeck.id);
      assert.equal(restoreRes.value?.cardId, targetCard.id);
      assert.equal(restoreRes.value?.title, origDeck.title);

      const origGetAfterRestore = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origGetAfterRestore.ok, true);
      assert.equal(origGetAfterRestore.value.cards.length, origCount0);
      const restoredCard = origGetAfterRestore.value.cards.find((c) => c.id === targetCard.id);
      assert.ok(restoredCard, 'restored card must return to original deck');
      assert.equal(restoredCard.slain, undefined, 'card.slain must be cleared after restore');
      assert.equal(restoredCard.suspended, false, 'card.suspended must return to pre-slay value');

      const slainGetAfterRestore = await host.call('deck.get', { id: slainDeckId });
      assert.equal(slainGetAfterRestore.ok, true);
      assert.equal(slainGetAfterRestore.value.cards.length, 0, 'Slain system deck must be empty after restore');

      const moveRes = await host.call('deck.move', { id: origDeck.id, folder: 'CS / Design Patterns' });
      assert.equal(moveRes.ok, true, `deck.move failed: ${moveRes.error?.message}`);
      assert.equal(moveRes.value?.id, origDeck.id);
      assert.equal(moveRes.value?.folder, 'CS / Design Patterns');

      const movedGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(movedGet.ok, true);
      assert.equal(movedGet.value.folder, 'CS / Design Patterns');
      const snapMoved = await host.call('snapshot', {});
      assert.equal(snapMoved.ok, true);
      assert.equal(snapMoved.value.decks.find((d) => d.id === origDeck.id)?.folder, 'CS / Design Patterns');

      const clearRes = await host.call('deck.move', { id: origDeck.id, folder: '' });
      assert.equal(clearRes.ok, true, `deck.move clear failed: ${clearRes.error?.message}`);
      assert.equal(clearRes.value?.id, origDeck.id);
      assert.equal(clearRes.value?.folder, '');

      const clearedGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(clearedGet.ok, true);
      assert.equal(clearedGet.value.folder, '');
      const snapCleared = await host.call('snapshot', {});
      assert.equal(snapCleared.ok, true);
      assert.equal(snapCleared.value.decks.find((d) => d.id === origDeck.id)?.folder, '');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: DeckManageModal on Slain deck (systemKind: "slain") shows origin + restore hint & restores both cards cleanly', async () => {
    const base = await temps.make('r39-slain-pty');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    let tty = null;
    let inkInstance = null;
    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      const origCount = origDetail.cards.length;
      assert.ok(origCount >= 2, 'sample deck needs >= 2 cards');
      const cardA = origDetail.cards[0];
      const cardB = origDetail.cards[1];

      const slayA = await host.call('card.slay', { deckId: origDeck.id, cardId: cardA.id });
      const slayB = await host.call('card.slay', { deckId: origDeck.id, cardId: cardB.id });
      assert.equal(slayA.ok, true);
      assert.equal(slayB.ok, true);
      const slainDeckId = slayA.value.deckId;

      resetStore(useSrcTuiStore, 'zh', false);
      tty = createVirtualTty(120, 36);
      inkInstance = render(React.createElement(DeckManageModalHarness, { host, deckId: slainDeckId, width: 120, height: 36 }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      const zhInitial = await tty.waitFor(
        (s) =>
          s.includes('题组管理') &&
          s.includes('2/2 题') &&
          s.includes('斩题来源') &&
          s.includes('恢复原题组') &&
          s.includes('[u]'),
        { label: 'DeckManageModal Slain deck rendered in zh mode with origin badge & [u] restore hint' },
      );
      tty.assertHealthyScreen(zhInitial, 120, 36, 'Slain DeckManageModal zh 120x36');
      assert.ok(zhInitial.includes('2/2 题'));
      assert.ok(zhInitial.includes('斩题来源'));

      tty.send('u');
      const zhAfterRestore = await tty.waitFor(
        (s) =>
          s.includes('1/1 题') &&
          useSrcTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes(`已恢复到「${origDeck.title}」`)),
        { label: 'Restored first slain card in zh mode' },
      );
      tty.assertHealthyScreen(zhAfterRestore, 120, 36, 'Slain DeckManageModal zh after restore #1');
      assert.ok(zhAfterRestore.includes('1/1 题'));

      const origAfter1 = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origAfter1.ok, true);
      assert.equal(origAfter1.value.cards.length, origCount - 1);
      const restoredA = origAfter1.value.cards.find((c) => c.id === cardA.id);
      assert.ok(restoredA, 'cardA must be back in original deck');
      assert.equal(restoredA.slain, undefined, 'cardA.slain must be cleared');
      assert.equal(restoredA.suspended, false, 'cardA.suspended must be false after restore');

      // Restore second (last) slain card -> empty 0/0 state
      await tty.flush(40);
      tty.send('u');
      const zhAfterRestore2 = await tty.waitFor(
        (s) => s.includes('0/0 题') && s.includes('斩题组已清空'),
        { label: 'Restored last slain card in zh mode' },
      );
      tty.assertHealthyScreen(zhAfterRestore2, 120, 36, 'Slain DeckManageModal zh after restore #2');
      assert.ok(zhAfterRestore2.includes('0/0 题'));
      assert.ok(zhAfterRestore2.includes('斩题组已清空'));

      const origFinal = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origFinal.ok, true);
      assert.equal(origFinal.value.cards.length, origCount, 'all slain cards returned to original deck');
      assert.equal(origFinal.value.cards.find((c) => c.id === cardB.id)?.slain, undefined);
      assert.equal(origFinal.value.cards.find((c) => c.id === cardB.id)?.suspended, false);
      const slainFinal = await host.call('deck.get', { id: slainDeckId });
      assert.equal(slainFinal.ok, true);
      assert.equal(slainFinal.value.cards.length, 0, 'Slain deck is now empty');
    } finally {
      inkInstance?.unmount();
      tty?.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E: StudyHubTuiApp -> LibraryView -> DeckManageModal [m] Folder Move set & clear in --ascii en mode', async () => {
    const base = await temps.make('r39-folder-pty');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetStore(useDistTuiStore, 'en', true);
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    let tty = null;
    let inkInstance = null;
    try {
      const sampleRes = await host.call('sample.status', {});
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);
      const snap0 = await host.call('snapshot', {});
      const targetDeck = (snap0.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(targetDeck, 'sample ordinary deck required');

      tty = createVirtualTty(120, 36);
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(
        (s) => useDistTuiStore.getState().page === 'library' && s.includes(targetDeck.title.slice(0, 12)),
        { label: 'LibraryView ready in --ascii en mode' },
      );

      tty.send('m');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Manage Deck') && s.includes('m Folder') && !s.includes('Loading deck cards'),
        { label: 'DeckManageModal opened with m Folder hint' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'DeckManageModal normal deck ascii');
      tty.assertAsciiPure(modalScreen, 'DeckManageModal normal deck ascii');

      tty.send('m');
      const folderPrompt = await tty.waitFor(
        (s) => s.includes('Deck folder (leave empty to clear'),
        { label: 'Folder Move input opened' },
      );
      tty.assertHealthyScreen(folderPrompt, 120, 36, 'Folder Move input ascii');
      tty.assertAsciiPure(folderPrompt, 'Folder Move input ascii');

      tty.send('Core / Patterns');
      const folderTyped = await tty.waitFor((s) => s.includes('Core / Patterns'), { label: 'Folder input typed' });
      assert.ok(folderTyped.includes('Core / Patterns'));
      tty.send('\r');
      const afterMove = await tty.waitFor(
        (s) =>
          !s.includes('Deck folder (leave empty to clear') &&
          s.includes('Folder: Core / Patterns') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Moved to folder "Core / Patterns"')),
        { label: 'Folder saved and badge displayed' },
      );
      tty.assertHealthyScreen(afterMove, 120, 36, 'DeckManageModal after folder move');
      tty.assertAsciiPure(afterMove, 'DeckManageModal after folder move');
      assert.ok(afterMove.includes('Folder: Core / Patterns'));
      assert.equal(
        useDistTuiStore.getState().snapshot?.decks?.find((d) => d.id === targetDeck.id)?.folder,
        'Core / Patterns',
        'store snapshot must reflect updated folder',
      );
      const movedHostDeck = await host.call('deck.get', { id: targetDeck.id });
      assert.equal(movedHostDeck.ok, true);
      assert.equal(movedHostDeck.value?.folder, 'Core / Patterns');

      tty.send('m');
      const prefilledFolder = await tty.waitFor(
        (s) => s.includes('Deck folder (leave empty to clear') && s.includes('Core / Patterns'),
        { label: 'Folder Move input prefilled with current folder' },
      );
      assert.ok(prefilledFolder.includes('Core / Patterns'));
      tty.send('\x15');
      await tty.flush();
      tty.send('\r');
      const afterClear = await tty.waitFor(
        (s) =>
          !s.includes('Deck folder (leave empty to clear') &&
          !s.includes('Folder: Core / Patterns') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Cleared deck folder')),
        { label: 'Folder cleared via empty submit' },
      );
      tty.assertHealthyScreen(afterClear, 120, 36, 'DeckManageModal after folder clear');
      tty.assertAsciiPure(afterClear, 'DeckManageModal after folder clear');
      assert.ok(!afterClear.includes('Folder: Core / Patterns'));
      assert.equal(
        useDistTuiStore.getState().snapshot?.decks?.find((d) => d.id === targetDeck.id)?.folder,
        '',
        'store snapshot must reflect cleared folder',
      );
      const clearedHostDeck = await host.call('deck.get', { id: targetDeck.id });
      assert.equal(clearedHostDeck.ok, true);
      assert.equal(clearedHostDeck.value?.folder, '');
    } finally {
      inkInstance?.unmount();
      tty?.dispose();
      await host.dispose();
    }
  });
});

describe('Round 46: Atomic Batch Slay (card.review.batch)', () => {
  test('1) createTuiHost integration: atomic rejection leaves c1 untouched; 2 valid cards move cleanly to Slain deck', async () => {
    const base = await temps.make('r46-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      const origCount0 = origDetail.cards.length;
      assert.ok(origCount0 >= 2, 'sample deck must have at least 2 cards');
      const c1 = origDetail.cards[0];
      const c2 = origDetail.cards[1];

      const rejectedRes = await host.call('card.review.batch', {
        atomic: true,
        items: [
          { deckId: origDeck.id, cardId: c1.id, slay: true },
          { deckId: origDeck.id, cardId: 'missing-id', slay: true },
        ],
      });
      assert.equal(rejectedRes.ok, false, 'card.review.batch must fail atomically when an item is missing');
      assert.ok(rejectedRes.error?.message, 'atomic rejection must return error message');

      const origAfterReject = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origAfterReject.ok, true);
      assert.equal(origAfterReject.value.cards.length, origCount0, 'atomic rejection must preserve deck card count');
      const untouchedC1 = origAfterReject.value.cards.find((c) => c.id === c1.id);
      assert.ok(untouchedC1, 'c1 must remain in original deck after atomic rejection');
      assert.equal(untouchedC1.slain, undefined, 'c1.slain must remain undefined');
      assert.equal(Boolean(untouchedC1.suspended), Boolean(c1.suspended), 'c1.suspended must be unchanged');

      const snapAfterReject = await host.call('snapshot', {});
      assert.equal(snapAfterReject.ok, true);
      const slainAfterReject = (snapAfterReject.value?.decks ?? []).find((d) => d.systemKind === 'slain');
      assert.equal(slainAfterReject?.count ?? 0, 0, 'Slain deck must remain empty after atomic rejection');

      const batchRes = await host.call('card.review.batch', {
        atomic: true,
        items: [
          { deckId: origDeck.id, cardId: c1.id, slay: true },
          { deckId: origDeck.id, cardId: c2.id, slay: true },
        ],
      });
      assert.equal(batchRes.ok, true, `card.review.batch failed: ${batchRes.error?.message}`);
      assert.equal(batchRes.value?.slain, 2, 'slain count must be 2');
      assert.equal(batchRes.value?.updated, 2, 'updated count must be 2');
      assert.equal(batchRes.value?.failed, 0, 'failed count must be 0');
      assert.equal(batchRes.value?.results?.length, 2);
      assert.ok(batchRes.value.results.every((r) => r.ok && r.slain === true));
      assert.equal(batchRes.value.results[0].cardId, c1.id);
      assert.equal(batchRes.value.results[1].cardId, c2.id);

      const origAfterSlay = await host.call('deck.get', { id: origDeck.id });
      assert.equal(origAfterSlay.ok, true);
      assert.equal(origAfterSlay.value.cards.length, origCount0 - 2);
      assert.equal(origAfterSlay.value.cards.some((c) => c.id === c1.id || c.id === c2.id), false);

      const snapAfterSlay = await host.call('snapshot', {});
      assert.equal(snapAfterSlay.ok, true);
      const slainSummary = (snapAfterSlay.value?.decks ?? []).find((d) => d.systemKind === 'slain');
      assert.ok(slainSummary, 'Slain system deck must appear in snapshot');
      assert.equal(slainSummary.count, 2, 'Slain system deck must hold 2 cards');

      const slainGet = await host.call('deck.get', { id: slainSummary.id });
      assert.equal(slainGet.ok, true);
      assert.equal(slainGet.value.systemKind, 'slain');
      assert.equal(slainGet.value.cards.length, 2);
      const slainC1 = slainGet.value.cards.find((c) => c.id === c1.id);
      const slainC2 = slainGet.value.cards.find((c) => c.id === c2.id);
      assert.ok(slainC1 && slainC2, 'both c1 and c2 must be inside Slain system deck');
      assert.equal(slainC1.slain?.deckId, origDeck.id);
      assert.equal(slainC1.slain?.deckTitle, origDeck.title);
      assert.equal(slainC2.slain?.deckId, origDeck.id);
      assert.equal(slainC2.slain?.deckTitle, origDeck.title);
      assert.equal(slainC1.suspended, true);
      assert.equal(slainC2.suspended, true);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): DeckManageModal Space multi-select 2 cards -> X -> n cancel (intact) -> X -> y confirm', async () => {
    const base = await temps.make('r46-pty-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    let tty = null;
    let inkInstance = null;
    let onUpdatedCount = 0;
    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      const origCount = origDetail.cards.length;
      assert.ok(origCount >= 2, 'sample deck needs >= 2 cards');
      const c1 = origDetail.cards[0];
      const c2 = origDetail.cards[1];

      resetStore(useSrcTuiStore, 'zh', false);
      tty = createVirtualTty(120, 36);
      inkInstance = render(
        React.createElement(DeckManageModalHarness, {
          host,
          deckId: origDeck.id,
          width: 120,
          height: 36,
          onUpdated: () => {
            onUpdatedCount += 1;
          },
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

      const zhInitial = await tty.waitFor(
        (s) =>
          s.includes('题组管理') &&
          s.includes(`${origCount}/${origCount} 题`) &&
          !s.includes('正在读取题组卡片'),
        { label: 'DeckManageModal loaded in zh mode' },
      );
      tty.assertHealthyScreen(zhInitial, 120, 36, 'DeckManageModal zh initial');

      tty.send(' ');
      const sel1 = await tty.waitFor((s) => s.includes('已选 1'), { label: 'first card selected in zh' });
      assert.ok(sel1.includes('已选 1'));
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      const zhSelected = await tty.waitFor(
        (s) => s.includes('已选 2') && s.includes('[X]斩题'),
        { label: '2 cards selected and [X]斩题 hint shown in zh' },
      );
      tty.assertHealthyScreen(zhSelected, 120, 36, 'DeckManageModal zh 2 selected');
      assert.ok(zhSelected.includes('已选 2'));
      assert.ok(zhSelected.includes('[X]斩题'));

      tty.send('X');
      const zhConfirm = await tty.waitFor(
        (s) =>
          s.includes('确认批量斩题') &&
          s.includes('2') &&
          s.includes('已斩题 / Slain') &&
          s.includes('[u]'),
        { label: 'ConfirmDialog opened in zh mode' },
      );
      tty.assertHealthyScreen(zhConfirm, 120, 36, 'DeckManageModal zh ConfirmDialog');
      assert.ok(zhConfirm.includes('确认批量斩题'));
      assert.ok(zhConfirm.includes('已斩题 / Slain'));

      tty.send('n');
      const zhCancelled = await tty.waitFor(
        (s) => !s.includes('确认批量斩题') && s.includes('已选 2'),
        { label: 'ConfirmDialog cancelled with n in zh mode' },
      );
      tty.assertHealthyScreen(zhCancelled, 120, 36, 'DeckManageModal zh after cancel');
      assert.ok(!zhCancelled.includes('确认批量斩题'));

      const afterCancelGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(afterCancelGet.ok, true);
      assert.equal(afterCancelGet.value.cards.length, origCount, 'cancelling with n must keep all cards intact');
      assert.ok(afterCancelGet.value.cards.some((c) => c.id === c1.id));
      assert.ok(afterCancelGet.value.cards.some((c) => c.id === c2.id));
      assert.equal(onUpdatedCount, 0, 'cancelling must not trigger onUpdated');

      tty.send('X');
      await tty.waitFor((s) => s.includes('确认批量斩题'), { label: 'ConfirmDialog reopened in zh mode' });
      tty.send('y');

      const zhAfterSlay = await tty.waitFor(
        (s) =>
          !s.includes('确认批量斩题') &&
          s.includes(`${origCount - 2}/${origCount - 2} 题`) &&
          !s.includes('已选 2') &&
          useSrcTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已原子斩除 2 题')),
        { label: '2 cards slain cleanly in zh mode' },
      );
      tty.assertHealthyScreen(zhAfterSlay, 120, 36, 'DeckManageModal zh after batch slay');
      assert.ok(!zhAfterSlay.includes('已选 2'));
      assert.ok(useSrcTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已原子斩除 2 题')));
      assert.equal(onUpdatedCount, 1, 'onUpdated must fire once after batch slay');

      const afterSlayGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(afterSlayGet.ok, true);
      assert.equal(afterSlayGet.value.cards.length, origCount - 2);
      assert.equal(afterSlayGet.value.cards.some((c) => c.id === c1.id || c.id === c2.id), false);

      const snapAfter = await host.call('snapshot', {});
      assert.equal(snapAfter.ok, true);
      const slainDeck = (snapAfter.value?.decks ?? []).find((d) => d.systemKind === 'slain');
      assert.ok(slainDeck, 'Slain system deck must exist after zh batch slay');
      assert.equal(slainDeck.count, 2, 'Slain deck must have 2 cards after zh batch slay');

      const slainGet = await host.call('deck.get', { id: slainDeck.id });
      assert.equal(slainGet.ok, true);
      assert.ok(slainGet.value.cards.some((c) => c.id === c1.id && c.suspended === true));
      assert.ok(slainGet.value.cards.some((c) => c.id === c2.id && c.suspended === true));
      assert.equal(slainGet.value.cards.find((c) => c.id === c1.id)?.slain?.deckId, origDeck.id);
      assert.equal(slainGet.value.cards.find((c) => c.id === c2.id)?.slain?.deckId, origDeck.id);
    } finally {
      inkInstance?.unmount();
      tty?.dispose();
      await host.dispose();
    }
  });
});

describe('Round 47: Batch Topic Retagging (card.update.batch)', () => {
  test('1) createTuiHost integration: load sample course -> card.update.batch updates topic on 2 cards -> deck.get reflects new topic', async () => {
    const base = await temps.make('r47-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      assert.ok(origDetail.cards.length >= 2, 'sample deck must have at least 2 cards');
      const c1 = origDetail.cards[0];
      const c2 = origDetail.cards[1];
      const c3 = origDetail.cards[2];

      const newTopic = 'Round47-Unified-Topic';
      const batchRes = await host.call('card.update.batch', {
        updates: [c1.id, c2.id].map((cardId) => ({
          deckId: origDeck.id,
          cardId,
          patch: { topic: newTopic },
          reason: 'Batch topic retag from TUI',
        })),
      });
      assert.equal(batchRes.ok, true, `card.update.batch failed: ${batchRes.error?.message}`);
      assert.equal(batchRes.value?.updated, 2, 'updated count must be 2');
      assert.equal(batchRes.value?.failed, 0, 'failed count must be 0');
      assert.equal(batchRes.value?.results?.length, 2);
      assert.ok(batchRes.value.results.every((r) => r.ok === true));

      const afterGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(afterGet.ok, true, afterGet.error?.message);
      assert.equal(afterGet.value.cards.length, origDetail.cards.length);
      const updatedC1 = afterGet.value.cards.find((c) => c.id === c1.id);
      const updatedC2 = afterGet.value.cards.find((c) => c.id === c2.id);
      assert.ok(updatedC1 && updatedC2);
      assert.equal(updatedC1?.topic, newTopic, 'c1 topic must be updated');
      assert.equal(updatedC2?.topic, newTopic, 'c2 topic must be updated');
      if (c3) {
        const untouchedC3 = afterGet.value.cards.find((c) => c.id === c3.id);
        assert.equal(untouchedC3?.topic, c3.topic, 'unselected c3 topic must remain untouched');
      }
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): DeckManageModal batch retag topic via [T] (Esc cancel then apply)', async () => {
    const base = await temps.make('r47-pty-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    let tty = null;
    let inkInstance = null;
    let onUpdatedCount = 0;
    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      const origCount = origDetail.cards.length;
      assert.ok(origCount >= 2, 'sample deck needs >= 2 cards');
      const c1 = origDetail.cards[0];
      const c2 = origDetail.cards[1];
      const origTopic1 = c1.topic;
      const origTopic2 = c2.topic;

      resetStore(useSrcTuiStore, 'zh', false);
      tty = createVirtualTty(120, 36);
      inkInstance = render(
        React.createElement(DeckManageModalHarness, {
          host,
          deckId: origDeck.id,
          width: 120,
          height: 36,
          onUpdated: () => {
            onUpdatedCount += 1;
          },
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

      const zhInitial = await tty.waitFor(
        (s) =>
          s.includes('题组管理') &&
          s.includes(`${origCount}/${origCount} 题`) &&
          !s.includes('正在读取题组卡片'),
        { label: 'DeckManageModal loaded in zh mode' },
      );
      tty.assertHealthyScreen(zhInitial, 120, 36, 'DeckManageModal zh initial');

      tty.send(' ');
      const topicSel1 = await tty.waitFor((s) => s.includes('已选 1'), { label: 'first card selected in zh' });
      assert.ok(topicSel1.includes('已选 1'));
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      const zhSelected = await tty.waitFor(
        (s) => s.includes('已选 2') && s.includes('[T]改主题'),
        { label: '2 cards selected and [T]改主题 hint shown in zh' },
      );
      tty.assertHealthyScreen(zhSelected, 120, 36, 'DeckManageModal zh 2 selected');
      assert.ok(zhSelected.includes('已选 2'));
      assert.ok(zhSelected.includes('[T]改主题'));

      tty.send('T');
      const zhTopicPrompt = await tty.waitFor(
        (s) => s.includes('批量修改主题标签 (2 题):'),
        { label: 'topic input opened in zh mode' },
      );
      tty.assertHealthyScreen(zhTopicPrompt, 120, 36, 'DeckManageModal zh topic prompt');
      assert.ok(zhTopicPrompt.includes('批量修改主题标签 (2 题):'));

      tty.send('\u001b');
      const zhCancelled = await tty.waitFor(
        (s) => !s.includes('批量修改主题标签') && s.includes('已选 2'),
        { label: 'topic input cancelled with Esc in zh mode' },
      );
      tty.assertHealthyScreen(zhCancelled, 120, 36, 'DeckManageModal zh after Esc cancel');
      assert.ok(!zhCancelled.includes('批量修改主题标签'));
      assert.equal(onUpdatedCount, 0, 'Esc cancel must not trigger onUpdated');

      const afterCancelGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(afterCancelGet.ok, true);
      assert.equal(afterCancelGet.value.cards.find((c) => c.id === c1.id)?.topic, origTopic1);
      assert.equal(afterCancelGet.value.cards.find((c) => c.id === c2.id)?.topic, origTopic2);

      const targetTopicZh = 'R47TopicZh';
      tty.send('T');
      await tty.waitFor((s) => s.includes('批量修改主题标签 (2 题):'), { label: 'topic input reopened in zh mode' });
      tty.send(targetTopicZh);
      await tty.flush();
      tty.send('\r');

      const zhAfterTopic = await tty.waitFor(
        (s) =>
          !s.includes('批量修改主题标签') &&
          !s.includes('已选 2') &&
          s.includes(targetTopicZh) &&
          useSrcTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text.includes('2') && toast.text.includes(targetTopicZh),
          ),
        { label: '2 cards retagged cleanly in zh mode' },
      );
      tty.assertHealthyScreen(zhAfterTopic, 120, 36, 'DeckManageModal zh after batch topic');
      assert.ok(zhAfterTopic.includes(targetTopicZh));
      assert.ok(!zhAfterTopic.includes('已选 2'));
      assert.equal(onUpdatedCount, 1, 'onUpdated must fire once after batch topic');

      const afterTopicGet = await host.call('deck.get', { id: origDeck.id });
      assert.equal(afterTopicGet.ok, true);
      assert.equal(afterTopicGet.value.cards.find((c) => c.id === c1.id)?.topic, targetTopicZh);
      assert.equal(afterTopicGet.value.cards.find((c) => c.id === c2.id)?.topic, targetTopicZh);
      if (origDetail.cards[2]) {
        assert.equal(afterTopicGet.value.cards.find((c) => c.id === origDetail.cards[2].id)?.topic, origDetail.cards[2].topic);
      }
    } finally {
      inkInstance?.unmount();
      tty?.dispose();
      await host.dispose();
    }
  });
});

describe('Round 49: Batch Prerequisite Linking (card.link.batch via [L])', () => {
  test('1) createTuiHost integration: load sample course -> card.link.batch links 2 cards to 3rd prereq -> graph {} has 2 prereq edges', async () => {
    const base = await temps.make('r49-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      assert.ok(origDetail.cards.length >= 3, 'sample deck must have at least 3 cards');
      const [c1, c2, c3] = origDetail.cards;

      const batchRes = await host.call('card.link.batch', {
        links: [c1.id, c2.id].map((cardId) => ({
          deckId: origDeck.id,
          cardId,
          requires: { deckId: origDeck.id, cardId: c3.id },
        })),
      });
      assert.equal(batchRes.ok, true, `card.link.batch failed: ${batchRes.error?.message}`);
      assert.equal(batchRes.value?.linked, 2, 'linked count must be 2');
      assert.equal(batchRes.value?.failed, 0, 'failed count must be 0');
      assert.equal(batchRes.value?.results?.length, 2);
      assert.ok(batchRes.value.results.every((r) => r.ok === true));
      assert.equal(batchRes.value.results[0].cardId, c1.id);
      assert.equal(batchRes.value.results[1].cardId, c2.id);

      const graphRes = await host.call('graph', {});
      assert.equal(graphRes.ok, true, graphRes.error?.message);
      const edges = graphRes.value?.edges ?? [];
      assert.ok(Array.isArray(edges), 'graph {} must expose edges array');
      const toNode = cardNodeId(origDeck.id, c3.id);
      const edge1 = edges.find(
        (e) => e.type === 'prereq' && e.from === cardNodeId(origDeck.id, c1.id) && e.to === toNode,
      );
      const edge2 = edges.find(
        (e) => e.type === 'prereq' && e.from === cardNodeId(origDeck.id, c2.id) && e.to === toNode,
      );
      assert.ok(edge1, 'graph {} must include prereq edge from c1 to c3');
      assert.ok(edge2, 'graph {} must include prereq edge from c2 to c3');
      assert.equal(edge1.from, cardNodeId(origDeck.id, c1.id));
      assert.equal(edge2.from, cardNodeId(origDeck.id, c2.id));
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): DeckManageModal Space multi-select 2 cards -> L -> Esc cancel -> L -> j/k select prereq -> Enter', async () => {
    const base = await temps.make('r49-pty-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    let tty = null;
    let inkInstance = null;
    let onUpdatedCount = 0;
    try {
      const { origDeck, origDetail } = await seedSampleDeck(host);
      const origCount = origDetail.cards.length;
      assert.ok(origCount >= 3, 'sample deck needs >= 3 cards');
      const c1 = origDetail.cards[0];
      const c2 = origDetail.cards[1];
      const targetPrereq = origDetail.cards.length >= 4 ? origDetail.cards[3] : origDetail.cards[2];

      resetStore(useSrcTuiStore, 'zh', false);
      tty = createVirtualTty(120, 36);
      inkInstance = render(
        React.createElement(DeckManageModalHarness, {
          host,
          deckId: origDeck.id,
          width: 120,
          height: 36,
          onUpdated: () => {
            onUpdatedCount += 1;
          },
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

      const zhInitial = await tty.waitFor(
        (s) =>
          s.includes('题组管理') &&
          s.includes(`${origCount}/${origCount} 题`) &&
          !s.includes('正在读取题组卡片'),
        { label: 'DeckManageModal loaded in zh mode' },
      );
      tty.assertHealthyScreen(zhInitial, 120, 36, 'DeckManageModal zh initial');

      tty.send(' ');
      const linkSel1 = await tty.waitFor((s) => s.includes('已选 1'), { label: 'first card selected in zh' });
      assert.ok(linkSel1.includes('已选 1'));
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      const zhSelected = await tty.waitFor(
        (s) => s.includes('已选 2') && s.includes('[L]前置'),
        { label: '2 cards selected and [L]前置 hint shown in zh' },
      );
      tty.assertHealthyScreen(zhSelected, 120, 36, 'DeckManageModal zh 2 selected');
      assert.ok(zhSelected.includes('已选 2'));
      assert.ok(zhSelected.includes('[L]前置'));

      tty.send('L');
      const zhLinkPicker = await tty.waitFor(
        (s) => s.includes('批量关联前置题') && s.includes('选择前置题目'),
        { label: 'link picker opened in zh mode' },
      );
      tty.assertHealthyScreen(zhLinkPicker, 120, 36, 'DeckManageModal zh link picker');
      assert.ok(zhLinkPicker.includes('批量关联前置题'));

      tty.send('\u001b');
      const zhCancelled = await tty.waitFor(
        (s) => !s.includes('批量关联前置题') && s.includes('已选 2'),
        { label: 'link picker cancelled with Esc in zh mode' },
      );
      tty.assertHealthyScreen(zhCancelled, 120, 36, 'DeckManageModal zh after Esc cancel');
      assert.ok(!zhCancelled.includes('批量关联前置题'));
      assert.equal(onUpdatedCount, 0, 'Esc cancel must not trigger onUpdated');

      const graphAfterCancel = await host.call('graph', {});
      assert.equal(graphAfterCancel.ok, true);
      const cancelEdges = (graphAfterCancel.value?.edges ?? []).filter(
        (e) =>
          e.type === 'prereq' &&
          (e.from === cardNodeId(origDeck.id, c1.id) || e.from === cardNodeId(origDeck.id, c2.id)) &&
          e.to === cardNodeId(origDeck.id, targetPrereq.id),
      );
      assert.equal(cancelEdges.length, 0, 'Esc cancel must not create prereq edges');

      tty.send('L');
      await tty.waitFor((s) => s.includes('批量关联前置题'), { label: 'link picker reopened in zh mode' });
      if (origDetail.cards.length >= 4) {
        tty.send('j');
        await tty.flush();
        tty.send('k');
        await tty.flush();
        tty.send('j');
        await tty.flush();
      }
      tty.send('\r');

      const zhAfterLink = await tty.waitFor(
        (s) =>
          !s.includes('批量关联前置题') &&
          !s.includes('已选 2') &&
          useSrcTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text.includes('2') && toast.text.includes('关联前置'),
          ),
        { label: '2 cards linked cleanly in zh mode' },
      );
      tty.assertHealthyScreen(zhAfterLink, 120, 36, 'DeckManageModal zh after batch link');
      assert.ok(!zhAfterLink.includes('批量关联前置题'));
      assert.ok(!zhAfterLink.includes('已选 2'));
      assert.equal(onUpdatedCount, 1, 'onUpdated must fire once after batch link');

      const graphAfterLink = await host.call('graph', {});
      assert.equal(graphAfterLink.ok, true);
      const edges = graphAfterLink.value?.edges ?? [];
      const toNode = cardNodeId(origDeck.id, targetPrereq.id);
      assert.ok(
        edges.some((e) => e.type === 'prereq' && e.from === cardNodeId(origDeck.id, c1.id) && e.to === toNode),
        'zh: graph {} must contain prereq edge for c1',
      );
      assert.ok(
        edges.some((e) => e.type === 'prereq' && e.from === cardNodeId(origDeck.id, c2.id) && e.to === toNode),
        'zh: graph {} must contain prereq edge for c2',
      );
    } finally {
      inkInstance?.unmount();
      tty?.dispose();
      await host.dispose();
    }
  });
});

describe('Round 53: DeckOpsModal P2 AI Merge Suggestion Guard', () => {
  test('1) @xterm/headless E2E (120x36 zh): 0 auto AI calls on Tab 2 mount -> [g] Confirm -> [n] cancel -> [g]+[y] suggest -> [a] -> [n] cancel -> [a]+[y] merge', async () => {
    const base = await temps.make('r53-e2e-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const trackingComplete = async (system, prompt) => {
      aiCalls += 1;
      const parsed = JSON.parse(String(prompt || '{}'));
      const decks = Array.isArray(parsed.decks) ? parsed.decks : [];
      if (String(system || '').includes('Inspect the deck titles') && decks.length >= 2) {
        return JSON.stringify({
          proposals: [
            {
              targetId: decks[1].id,
              sourceIds: [decks[0].id],
              reason: 'Duplicate Matrices topics',
            },
          ],
        });
      }
      return JSON.stringify({ proposals: [] });
    };

    resetStore(useDistTuiStore, 'zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const decks = await seedTwoCourseDecks(host, 'Linear Algebra');
    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
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
      const libScreen = await tty.waitFor(
        (s) => s.includes('Matrices Part 1') && s.includes('Matrices Part 2'),
        { timeoutMs: 8_000, label: 'LibraryView with 2 seeded decks' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh');
      assert.equal(aiCalls, 0, 'LibraryView mount must make 0 AI calls');

      tty.send('o');
      const tab1Screen = await tty.waitFor(
        (s) => s.includes('题组操作中心') && s.includes('导入 JSON'),
        { timeoutMs: 8_000, label: 'DeckOpsModal Tab 1 Import' },
      );
      assert.ok(tab1Screen.includes('题组操作中心'));

      tty.send('\x1b[A');
      await tty.flush();
      tty.send('2');

      const mergeTabScreen = await tty.waitFor(
        (s) => s.includes('并入下方所选目标题组') && s.includes('AI合并建议'),
        { timeoutMs: 8_000, label: 'DeckOpsModal Tab 2 Merge' },
      );
      tty.assertHealthyScreen(mergeTabScreen, 120, 36, 'DeckOpsModal Tab 2 Merge zh');
      assert.ok(mergeTabScreen.includes('并入下方所选目标题组'));
      assert.ok(mergeTabScreen.includes('AI合并建议'));

      await tty.flush(120);
      assert.equal(aiCalls, 0, 'Opening Tab 2 Merge MUST make 0 automatic AI calls');

      tty.send('g');
      const confirmSuggestScreen = await tty.waitFor(
        (s) => s.includes('AI 分析并推荐题组合并') && s.includes('deck.merge.suggest'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog for deck.merge.suggest' },
      );
      tty.assertHealthyScreen(confirmSuggestScreen, 120, 36, 'ConfirmDialog suggest-merge zh');
      assert.ok(confirmSuggestScreen.includes('deck.merge.suggest'));
      assert.equal(aiCalls, 0, 'Opening P2 ConfirmDialog with [g] must still make 0 AI calls');

      tty.send('n');
      const afterCancelSuggest = await tty.waitFor(
        (s) => !s.includes('AI 分析并推荐题组合并') && s.includes('并入下方所选目标题组'),
        { timeoutMs: 8_000, label: 'ConfirmDialog cancelled back to Tab 2' },
      );
      assert.ok(!afterCancelSuggest.includes('AI 分析并推荐题组合并'));
      await tty.flush(80);
      assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog with [n] must make 0 AI calls');

      tty.send('g');
      await tty.waitFor(
        (s) => s.includes('AI 分析并推荐题组合并'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog reopened' },
      );
      tty.send('y');

      const suggestedScreen = await tty.waitFor(
        (s) =>
          s.includes('[a] 应用建议') &&
          s.includes('Duplicate Matrice') &&
          s.includes('应用建议'),
        { timeoutMs: 8_000, label: 'AI merge suggestion banner rendered' },
      );
      tty.assertHealthyScreen(suggestedScreen, 120, 36, 'DeckOpsModal Tab 2 with suggestion zh');
      assert.ok(suggestedScreen.includes('[a] 应用建议'));
      assert.ok(suggestedScreen.includes('Duplicate Matrice'));
      assert.equal(aiCalls, 1, 'Confirming [g] -> [y] must invoke model exactly once');

      // Press [a] -> cancel Confirm Merge Decks with [n] -> verify decks still unmerged
      tty.send('a');
      const confirmApplyScreen = await tty.waitFor(
        (s) =>
          s.includes('确认合并题组') &&
          s.includes(decks[0].title) &&
          s.includes(decks[1].title),
        { timeoutMs: 8_000, label: 'Confirm Merge Decks opened via [a]' },
      );
      tty.assertHealthyScreen(confirmApplyScreen, 120, 36, 'Confirm Merge Decks zh');
      assert.ok(confirmApplyScreen.includes('确认合并题组'));
      assert.equal(aiCalls, 1, 'Pressing [a] to apply proposal must make 0 extra AI calls');

      tty.send('n');
      const cancelledApplyScreen = await tty.waitFor(
        (s) => !s.includes('确认合并题组') && s.includes('[a] 应用建议'),
        { timeoutMs: 8_000, label: 'Confirm Merge Decks cancelled with [n]' },
      );
      assert.ok(!cancelledApplyScreen.includes('确认合并题组'));
      const midSnap = await host.refreshSnapshot();
      assert.equal(
        (midSnap.snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind && d.course === 'Linear Algebra').length,
        2,
        'Cancelling [a] merge dialog must preserve both decks',
      );
      assert.equal(aiCalls, 1);

      // Press [a] then [y] -> merges source into target and closes modal
      tty.send('a');
      await tty.waitFor((s) => s.includes('确认合并题组'), { timeoutMs: 8_000, label: 'Confirm Merge Decks reopened via [a]' });
      tty.send('y');
      const closedAfterMerge = await tty.waitFor(
        (s) => !s.includes('题组操作中心') && !s.includes('确认合并题组'),
        { timeoutMs: 10_000, label: 'DeckOpsModal closed after applying suggestion merge' },
      );
      assert.ok(!closedAfterMerge.includes('题组操作中心'));
      const afterSnap = await host.refreshSnapshot();
      assert.equal(afterSnap.snapshot?.courses !== undefined, true);
      const remaining = (afterSnap.snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind && d.course === 'Linear Algebra');
      assert.equal(remaining.length, 1, 'Expected 1 merged deck remaining after applying suggestion');
      assert.equal(remaining[0].id, decks[1].id, 'Target deck should survive merge');
      assert.equal(remaining[0].title, decks[1].title);
      const mergedDetail = await host.call('deck.get', { id: decks[1].id });
      assert.equal(mergedDetail.ok, true);
      assert.equal(mergedDetail.value?.cards?.length, 2, 'Merged deck must preserve all 2 cards');
      assert.ok(mergedDetail.value?.cards?.some((c) => c.prompt.includes('matrix rank')));
      assert.ok(mergedDetail.value?.cards?.some((c) => c.prompt.includes('matrix trace')));
      assert.equal(aiCalls, 1, 'Total AI calls for entire flow must remain 1');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('2) createTuiHost deck.merge.suggest handles too-few-decks (0 AI calls) and unavailable model', async () => {
    const base = await temps.make('r53-guards');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });

    let aiCalls = 0;
    const host1 = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot: join(base, 'library'),
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{"proposals":[]}';
      },
      skipAutoProbe: true,
      language: 'en',
    });
    try {
      await host1.call('deck.import', {
        text: JSON.stringify({
          title: 'Solo Deck',
          course: 'Physics',
          cards: [{ kind: 'flashcard', prompt: 'F = ?', answer: 'ma', topic: 'Mechanics' }],
        }),
        folder: 'Physics',
      });
      await host1.call('focus.set', { course: 'Physics' });
      const resFew = await host1.call('deck.merge.suggest', {});
      assert.equal(resFew.ok, true);
      assert.equal(resFew.value?.method, 'too-few-decks');
      assert.deepEqual(resFew.value?.proposals, []);
      assert.equal(aiCalls, 0, 'too-few-decks must make 0 AI calls');
    } finally {
      await host1.dispose();
    }

    const base2 = await temps.make('r53-unavail');
    const env2 = sanitizedTestEnv({ DSH_HOME: join(base2, 'dsh-home') });
    const host2 = await createTuiHost({
      env: env2,
      home: join(base2, 'home'),
      libraryRoot: join(base2, 'library'),
      discovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });
    try {
      await seedTwoCourseDecks(host2, 'Calculus');
      const resUnavail = await host2.call('deck.merge.suggest', {});
      assert.equal(resUnavail.ok, true);
      assert.equal(resUnavail.value?.method, 'unavailable');
      assert.deepEqual(resUnavail.value?.proposals, []);
      assert.equal(resUnavail.value?.proposals?.length, 0);
    } finally {
      await host2.dispose();
    }
  });
});

describe('Round 55: DeckOpsModal Tab 1 On-Demand AI Filing Proposal', () => {
  test('1) createTuiHost draft.import.propose returns AI filing metadata (with model) and rules fallback (without model)', async () => {
    const base = await temps.make('r55-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });

    let aiCalls = 0;
    const hostAi = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot: join(base, 'library'),
      discovery: fakeDiscovery(),
      injectedComplete: async (system, prompt) => {
        aiCalls += 1;
        const parsed = JSON.parse(String(prompt || '{}'));
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const match = candidates.find((c) => c.course === 'Linear Algebra') ?? candidates[0];
        assert.ok(String(system || '').includes('Suggest filing metadata'));
        return JSON.stringify({
          title: 'Eigenvalue Practice Set',
          course: 'Linear Algebra',
          mergeTargetId: match?.id ?? null,
        });
      },
      skipAutoProbe: true,
      language: 'en',
    });

    const deckPayload = JSON.stringify({
      title: 'raw-eigen-upload',
      cards: [
        { kind: 'flashcard', prompt: 'What is the characteristic polynomial?', answer: 'det(A - lambda I)', topic: 'Eigenvalues' },
      ],
    });

    try {
      const targetDeck = await seedCourseDeck(hostAi, 'Eigenvalues Core', 'Linear Algebra');
      assert.equal(aiCalls, 0, 'Seeding deck must make 0 AI calls');

      const aiRes = await hostAi.call('draft.import.propose', { text: deckPayload });
      assert.equal(aiRes.ok, true, `draft.import.propose failed: ${aiRes.error?.message}`);
      assert.equal(aiCalls, 1, 'draft.import.propose must invoke model once');
      assert.equal(aiRes.value?.method, 'ai');
      assert.equal(aiRes.value?.originalTitle, 'raw-eigen-upload');
      assert.equal(aiRes.value?.title, 'Eigenvalue Practice Set');
      assert.equal(aiRes.value?.course, 'Linear Algebra');
      assert.equal(aiRes.value?.mergeTargetId, targetDeck.id);
      assert.equal(typeof aiRes.value?.title, 'string');
    } finally {
      await hostAi.dispose();
    }

    const baseRules = await temps.make('r55-rules');
    const envRules = sanitizedTestEnv({ DSH_HOME: join(baseRules, 'dsh-home') });
    const hostRules = await createTuiHost({
      env: envRules,
      home: join(baseRules, 'home'),
      libraryRoot: join(baseRules, 'library'),
      discovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });
    try {
      await seedCourseDeck(hostRules, 'Calc Core', 'Calculus');
      const focusCalc = await hostRules.call('focus.set', { course: 'Calculus' });
      assert.equal(focusCalc.ok, true);
      const rulesRes = await hostRules.call('draft.import.propose', { text: deckPayload });
      assert.equal(rulesRes.ok, true, `draft.import.propose rules failed: ${rulesRes.error?.message}`);
      assert.equal(rulesRes.value?.method, 'rules');
      assert.equal(rulesRes.value?.originalTitle, 'raw-eigen-upload');
      assert.equal(rulesRes.value?.title, 'raw-eigen-upload');
      assert.equal(rulesRes.value?.course, 'Calculus');
      assert.equal(rulesRes.value?.mergeTargetId, null);
    } finally {
      await hostRules.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): 0 auto calls, Ctrl+G P2 guard, n cancel, y propose + course fill + banner', async () => {
    const base = await temps.make('r55-e2e-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let capturedTargetId = null;
    const trackingComplete = async (system, prompt) => {
      aiCalls += 1;
      const parsed = JSON.parse(String(prompt || '{}'));
      const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      const match = candidates.find((c) => c.course === 'Linear Algebra') ?? candidates[0];
      capturedTargetId = match?.id ?? null;
      assert.ok(String(system || '').includes('Suggest filing metadata'));
      return JSON.stringify({
        title: '特征值精选题组',
        course: 'Linear Algebra',
        mergeTargetId: capturedTargetId,
      });
    };

    resetStore(useDistTuiStore, 'zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const seededDeck = await seedCourseDeck(host, 'Eigenvalues Core', 'Linear Algebra');
    const jsonPath = join(base, 'eigen-import.json');
    await writeFile(
      jsonPath,
      JSON.stringify(
        {
          title: 'Raw Eigen Draft',
          cards: [
            { kind: 'flashcard', prompt: 'What is trace(A)?', answer: 'Sum of eigenvalues.', topic: 'Eigenvalues' },
            { kind: 'flashcard', prompt: 'What is det(A)?', answer: 'Product of eigenvalues.', topic: 'Eigenvalues' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
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
      await tty.waitFor((s) => s.includes('Eigenvalues Core'), { timeoutMs: 8_000, label: 'LibraryView seeded zh' });
      assert.equal(aiCalls, 0);

      tty.send('o');
      const tab1Open = await tty.waitFor(
        (s) => s.includes('题组操作中心') && s.includes('Ctrl+G') && s.includes('AI归档建议'),
        { timeoutMs: 8_000, label: 'DeckOpsModal Tab 1 zh' },
      );
      tty.assertHealthyScreen(tab1Open, 120, 36, 'DeckOpsModal Tab 1 zh');
      assert.ok(tab1Open.includes('Ctrl+G'));

      tty.send('\u0007');
      const emptyPathToast = await tty.waitFor(
        (s) => s.includes('请先输入有效的 JSON 题组文件路径'),
        { timeoutMs: 8_000, label: 'Info toast on empty path Ctrl+G zh' },
      );
      assert.ok(emptyPathToast.includes('请先输入有效的 JSON 题组文件路径'));
      assert.equal(aiCalls, 0, 'Ctrl+G with empty path must make 0 AI calls');

      tty.send(jsonPath);
      const previewScreen = await tty.waitFor(
        (s) => s.includes('Raw Eigen Draft') && s.includes('2 题'),
        { timeoutMs: 8_000, label: 'JSON preview validated zh' },
      );
      tty.assertHealthyScreen(previewScreen, 120, 36, 'Tab 1 JSON preview zh');
      assert.ok(previewScreen.includes('Raw Eigen Draft'));
      assert.ok(previewScreen.includes('2 题'));
      await tty.flush(120);
      assert.equal(aiCalls, 0, 'JSON preview load must make 0 automatic AI calls');

      tty.send('\u0007');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('AI 建议导入归档信息') && s.includes('draft.import.propose') && s.includes('Raw Eigen Draft'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog opened via Ctrl+G zh' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'ConfirmDialog propose-import zh');
      assert.ok(confirmScreen.includes('draft.import.propose'));
      assert.equal(aiCalls, 0, 'Opening ConfirmDialog must make 0 AI calls');

      tty.send('n');
      const cancelledProposal = await tty.waitFor(
        (s) => !s.includes('AI 建议导入归档信息') && s.includes('本地题组 JSON 路径'),
        { timeoutMs: 8_000, label: 'ConfirmDialog cancelled with n zh' },
      );
      assert.ok(!cancelledProposal.includes('AI 建议导入归档信息'));
      await tty.flush(80);
      assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog with n must make 0 AI calls');

      tty.send('\x1b[B');
      await tty.flush();
      tty.send('\u0007');
      await tty.waitFor(
        (s) => s.includes('AI 建议导入归档信息'),
        { timeoutMs: 8_000, label: 'ConfirmDialog reopened from course field zh' },
      );
      tty.send('y');

      const proposedScreen = await tty.waitFor(
        (s) =>
          s.includes('建议归属: 课程 Linear Algebra') &&
          s.includes('标题 特征值精选题组') &&
          s.includes(seededDeck.title),
        { timeoutMs: 8_000, label: 'Proposal banner + auto-populated course zh' },
      );
      tty.assertHealthyScreen(proposedScreen, 120, 36, 'Tab 1 with proposal zh');
      assert.ok(proposedScreen.includes('建议归属: 课程 Linear Algebra'));
      assert.ok(proposedScreen.includes('标题 特征值精选题组'));
      assert.equal(aiCalls, 1, 'Confirming Ctrl+G -> y must invoke model exactly once');
      assert.equal(capturedTargetId, seededDeck.id);

      tty.send('\x1b[A');
      await tty.flush(40);
      tty.send('x');
      const clearedProposal = await tty.waitFor(
        (s) => !s.includes('建议归属:'),
        { timeoutMs: 8_000, label: 'Proposal cleared when filePath changes zh' },
      );
      assert.ok(!clearedProposal.includes('建议归属:'));
      assert.equal(aiCalls, 1, 'Editing path after proposal must make 0 extra AI calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });
});

describe('Round 56: DeckManageModal Reassign Deck Course (deck.course via [C])', () => {
  test('1) createTuiHost integration (0 model calls): deck.course updates deck & snapshot, blank course returns normalized error', async () => {
    const base = await temps.make('r56-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    let aiCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: join(base, 'home'),
      documentsDir: base,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const deck = await seedSimpleDeck(host, {
        title: '矩阵与行列式',
        course: '高等数学',
      });

      const moveRes = await host.call('deck.course', {
        id: deck.id,
        course: '线性代数',
      });
      assert.equal(moveRes.ok, true, `deck.course failed: ${moveRes.error?.message}`);
      assert.deepEqual(moveRes.value, { id: deck.id, course: '线性代数' });

      const afterSnap = await host.refreshSnapshot();
      assert.equal(afterSnap.snapshot !== null, true);
      const updated = (afterSnap.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.ok(updated, 'Updated deck must remain in snapshot');
      assert.equal(updated.course, '线性代数', 'Snapshot deck.course must reflect reassigned course');
      const getUpdated = await host.call('deck.get', { id: deck.id });
      assert.equal(getUpdated.ok, true);
      assert.equal(getUpdated.value?.course, '线性代数');

      const blankRes = await host.call('deck.course', {
        id: deck.id,
        course: '   ',
      });
      assert.equal(blankRes.ok, false, 'Blank course name must return an error');
      assert.ok(
        typeof blankRes.error?.message === 'string' && blankRes.error.message.trim().length > 0,
        'Blank course must return normalized error message',
      );

      const unchangedSnap = await host.refreshSnapshot();
      const unchanged = (unchangedSnap.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.ok(unchanged);
      assert.equal(unchanged?.course, '线性代数', 'Blank course rejection must preserve existing course');
      assert.equal(aiCalls, 0, 'deck.course flow must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): Library -> m -> C -> Esc cancel -> C -> blank reject -> type new course + Enter', async () => {
    const base = await temps.make('r56-e2e-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    let aiCalls = 0;
    resetStore(useDistTuiStore, 'zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot: join(base, 'library'),
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const deck = await seedSimpleDeck(host, {
      title: '特征值基础练习',
      course: '微积分',
    });
    await seedSimpleDeck(host, {
      title: '离散集合论',
      course: '离散数学',
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
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
      const libScreen = await tty.waitFor(
        (s) => s.includes('特征值基础练习') && s.includes('微积分'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready with seeded deck' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      tty.send('m');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('题组管理') && s.includes('特征值基础练习') && s.includes('C 改课程'),
        { timeoutMs: 8_000, label: 'DeckManageModal browse zh with C hint' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'DeckManageModal browse zh 120x36');
      assert.ok(modalScreen.includes('C 改课程'));

      tty.send('C');
      const courseInputScreen = await tty.waitFor(
        (s) => s.includes('修改题组所属课程') && s.includes('已有课程:') && s.includes('微积分'),
        { timeoutMs: 8_000, label: 'DeckManageModal course sub-mode zh' },
      );
      tty.assertHealthyScreen(courseInputScreen, 120, 36, 'DeckManageModal course sub-mode zh');
      assert.ok(courseInputScreen.includes('修改题组所属课程'));
      assert.ok(courseInputScreen.includes('微积分'));

      tty.send('\u001b');
      const afterCancelScreen = await tty.waitFor(
        (s) => !s.includes('修改题组所属课程') && s.includes('题组管理') && s.includes('C 改课程'),
        { timeoutMs: 8_000, label: 'Esc cancelled course sub-mode back to browse' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'DeckManageModal browse after Esc zh');
      assert.ok(!afterCancelScreen.includes('修改题组所属课程'));

      const snapAfterCancel = await host.refreshSnapshot();
      assert.equal(
        (snapAfterCancel.snapshot?.decks ?? []).find((d) => d.id === deck.id)?.course,
        '微积分',
        'Esc cancel must leave course unchanged',
      );

      // Reopen [C], clear with Ctrl+U, submit blank -> warning toast, then type '线性代数' + Enter
      tty.send('C');
      await tty.waitFor((s) => s.includes('修改题组所属课程'), { timeoutMs: 8_000, label: 'course sub-mode reopened zh' });

      tty.send('\x15');
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        () =>
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'warning' && toast.text.includes('课程名称不能为空'),
          ),
        { timeoutMs: 8_000, label: 'Blank course warning toast in zh mode' },
      );
      assert.ok(useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('课程名称不能为空')));

      tty.send('线性代数');
      await tty.flush();
      tty.send('\r');

      const afterSubmitScreen = await tty.waitFor(
        (s) =>
          !s.includes('修改题组所属课程') &&
          s.includes('已将题组归入课程「线性代数」') &&
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text.includes('线性代数'),
          ),
        { timeoutMs: 8_000, label: 'Deck course updated toast in zh mode' },
      );
      tty.assertHealthyScreen(afterSubmitScreen, 120, 36, 'DeckManageModal after course submit zh');
      assert.ok(afterSubmitScreen.includes('已将题组归入课程「线性代数」'));
      assert.ok(useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('线性代数')));

      const snapAfter = await host.refreshSnapshot();
      const persisted = (snapAfter.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.equal(persisted?.course, '线性代数', 'Reassigned course must persist in library snapshot');
      const deckDetail = await host.call('deck.get', { id: deck.id });
      assert.equal(deckDetail.ok, true);
      assert.equal(deckDetail.value?.course, '线性代数');
      assert.equal(aiCalls, 0, 'PTY zh course reassignment must make 0 model calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore teardown error
      }
      await host.dispose();
      tty.dispose();
    }
  });
});

describe('Round 69 Track 2: LibraryView [x] Atomic Deck Study Sheet Markdown Export', () => {
  test('1) Unit: formatDeckMarkdown renders zh & en study sheets with MCQ options, cloze, flashcard, hidden <details> answers/hints/explanations & empty deck', () => {
    const sampleDeck = {
      id: 'deck-os-1',
      title: 'Operating Systems: Virtual Memory',
      course: 'CS301 Operating Systems',
      cards: [
        {
          id: 'c1',
          kind: 'quiz',
          topic: 'TLB & Page Table',
          prompt: 'Which hardware cache speeds up virtual-to-physical address translation?',
          options: [
            { id: 'a', text: 'L1 Data Cache', correct: false },
            { id: 'b', text: 'Translation Lookaside Buffer (TLB)', correct: true },
            { id: 'c', text: 'Write Buffer', correct: false },
          ],
          hint: 'Think about page table entry caching.',
          explanation: 'The TLB caches recent virtual-to-physical page number mappings.',
        },
        {
          id: 'c2',
          kind: 'cloze',
          topic: 'Page Fault',
          cloze: {
            text: 'When a referenced page is not in RAM, the MMU triggers a {{b1}}.',
            answers: [{ id: 'b1', value: 'page fault' }],
          },
          hint: 'A trap handled by the OS kernel.',
          explanation: 'The OS loads the missing page from backing store and updates the PTE.',
        },
        {
          id: 'c3',
          kind: 'flashcard',
          topic: 'Thrashing',
          prompt: 'Define thrashing in virtual memory systems.',
          answer: 'Excessive paging where the CPU spends more time swapping pages than executing instructions.',
          explanation: 'Usually caused by working-set size exceeding available physical frames.',
        },
      ],
    };

    const zhMd = formatDeckMarkdown({
      deck: sampleDeck,
      lang: 'zh',
      generatedAt: '2026-11-22 22:00',
    });
    assert.ok(zhMd.includes('# Operating Systems: Virtual Memory'), 'zh deck title missing');
    assert.ok(zhMd.includes('**课程**: CS301 Operating Systems'), 'zh course missing');
    assert.ok(zhMd.includes('**生成日期**: 2026-11-22 22:00'), 'zh date missing');
    assert.ok(zhMd.includes('**题目数量**: 3'), 'zh card count missing');
    assert.ok(zhMd.includes('## 1. TLB & Page Table'), 'card 1 heading missing');
    assert.ok(zhMd.includes('`quiz` `TLB & Page Table`'), 'card 1 badges missing');
    assert.ok(zhMd.includes('- **A.** L1 Data Cache') && zhMd.includes('- **B.** Translation Lookaside Buffer (TLB)'), 'MCQ options missing');
    const beforeDetails1 = zhMd.slice(0, zhMd.indexOf('<details>'));
    assert.ok(!beforeDetails1.includes('参考答案') && !beforeDetails1.includes('Reference Answer'), 'answer leaked outside <details>');
    assert.ok(zhMd.includes('## 2. Page Fault'), 'card 2 heading missing');
    assert.ok(zhMd.includes('When a referenced page is not in RAM, the MMU triggers a {{b1}}.'), 'cloze text missing');
    assert.ok(zhMd.includes('## 3. Thrashing'), 'card 3 heading missing');
    assert.ok(zhMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'zh <summary> missing');
    assert.ok(zhMd.includes('**参考答案**: B. Translation Lookaside Buffer (TLB)'), 'MCQ answer inside <details> missing');
    assert.ok(zhMd.includes('**参考答案**: page fault'), 'cloze answer inside <details> missing');
    assert.ok(zhMd.includes('**参考答案**: Excessive paging'), 'flashcard answer inside <details> missing');
    assert.ok(zhMd.includes('**提示**: Think about page table entry caching.'), 'hint inside <details> missing');
    assert.ok(zhMd.includes('The TLB caches recent virtual-to-physical page number mappings.'), 'explanation inside <details> missing');
    assert.ok(zhMd.includes('</details>'), '</details> closing tag missing');

      const enMd = formatDeckMarkdown({
        deck: sampleDeck,
        lang: 'en',
        generatedAt: new Date(2026, 10, 22, 9, 5),
      });
      assert.ok(enMd.includes('# Operating Systems: Virtual Memory'), 'en deck title missing');
      assert.ok(enMd.includes('**Course**: CS301 Operating Systems'), 'en course missing');
      assert.ok(enMd.includes('**Generated**: 2026-11-22 09:05'), 'en formatted Date missing');
      assert.ok(enMd.includes('**Cards**: 3'), 'en card count missing');
      assert.ok(enMd.includes('- **A.** L1 Data Cache'), 'en option A missing');
      assert.ok(enMd.includes('- **B.** Translation Lookaside Buffer (TLB)'), 'en option B missing');
      assert.ok(enMd.includes('- **C.** Write Buffer'), 'en option C missing');
      assert.ok(enMd.includes('**Reference Answer**: B. Translation Lookaside Buffer (TLB)'), 'en reference answer missing');
      assert.ok(enMd.includes('**Reference Answer**: page fault'), 'en cloze answer missing');
      assert.ok(enMd.includes('**Reference Answer**: Excessive paging'), 'en flashcard answer missing');
      assert.ok(enMd.includes('**Hint**: Think about page table entry caching.'), 'en hint missing');
      assert.ok(enMd.includes('**Explanation**:'), 'en explanation heading missing');
      assert.ok(enMd.includes('</details>'), 'en closing details missing');

    const emptyMd = formatDeckMarkdown({
      deck: { id: 'empty-1', title: 'Empty Deck', course: '', cards: [] },
      lang: 'en',
      generatedAt: '2026-11-22 10:00',
    });
    assert.ok(emptyMd.includes('# Empty Deck'));
    assert.ok(emptyMd.includes('**Course**: General'));
    assert.ok(emptyMd.includes('**Generated**: 2026-11-22 10:00'));
    assert.ok(emptyMd.includes('**Cards**: 0'));
    assert.ok(emptyMd.includes('No cards in this deck.'));

    const emptyZhMd = formatDeckMarkdown({
      deck: { id: 'empty-2', title: '空题组', course: '', cards: [] },
      lang: 'zh',
      generatedAt: '2026-11-22 10:00',
    });
    assert.ok(emptyZhMd.includes('# 空题组'));
    assert.ok(emptyZhMd.includes('**题目数量**: 0'));
    assert.ok(!emptyZhMd.includes('<details>'));

      const openTaskMd = formatDeckMarkdown({
      deck: {
        id: 'open-1',
        title: 'Case Tasks',
        course: 'Software Engineering',
        cards: [
          {
            id: 'c4',
            kind: 'open',
            prompt: 'Design an undo stack.',
            answer: 'Use Memento or Command.',
          },
          {
            id: 'c5',
            kind: 'task',
            topic: 'Refactor',
            prompt: 'Extract interface for storage.',
            answer: 'Create StoragePort.',
            hint: 'Keep callers decoupled.',
            explanation: 'Dependency inversion improves testability.',
          },
          {
            id: 'c6',
            kind: 'cloze',
            cloze: {
              text: 'Single {{b1}} and {{b2}}.',
              answers: [
                { id: 'b1', value: 'first' },
                { id: 'b2', value: 'second' },
              ],
            },
          },
        ],
      },
      lang: 'en',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(openTaskMd.includes('# Case Tasks'));
    assert.ok(openTaskMd.includes('**Course**: Software Engineering'));
    assert.ok(openTaskMd.includes('**Cards**: 3'));
    assert.ok(openTaskMd.includes('`open`'));
    assert.ok(openTaskMd.includes('Design an undo stack.'));
    assert.ok(openTaskMd.includes('**Reference Answer**: Use Memento or Command.'));
    assert.ok(openTaskMd.includes('`task` `Refactor`'));
    assert.ok(openTaskMd.includes('Extract interface for storage.'));
    assert.ok(openTaskMd.includes('**Reference Answer**: Create StoragePort.'));
    assert.ok(openTaskMd.includes('**Hint**: Keep callers decoupled.'));
    assert.ok(openTaskMd.includes('Dependency inversion improves testability.'));
    assert.ok(openTaskMd.includes('Single {{b1}} and {{b2}}.'));
    assert.ok(openTaskMd.includes('first'));
    assert.ok(openTaskMd.includes('second'));

    const defaultDateMd = formatDeckMarkdown({
      deck: { id: 'def-1', title: 'Default Date Deck', course: '', cards: [] },
      lang: 'zh',
    });
    assert.ok(defaultDateMd.includes('# Default Date Deck'));
    assert.ok(defaultDateMd.includes('**课程**:'));
    assert.ok(defaultDateMd.includes('**生成日期**:'));
    assert.ok(defaultDateMd.includes('**题目数量**: 0'));
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): load sample -> LibraryView select first deck -> [x] exports studyhub-deck-*.md (0 model calls)', async () => {
    const base = await temps.make('r69-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    let modelCalls = 0;
    await cloneSampleLibrary('zh', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetStore(useDistTuiStore, 'zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
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
      const libScreen = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().loading &&
          useDistTuiStore.getState().page === 'library' &&
          s.includes('示例 · Memento 与 Bridge') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === '导出MD'),
        { timeoutMs: 12_000, label: 'zh LibraryView with sample deck & [x] hint' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'zh LibraryView 120x36');

      const snapDecks = useDistTuiStore.getState().snapshot?.decks ?? [];
      const firstDeck = snapDecks.find((d) => !d.archived && !d.systemKind);
      assert.ok(firstDeck?.id, 'sample course must provide at least one deck');
      const deckDetailRes = await host.call('deck.get', { id: firstDeck.id });
      assert.equal(deckDetailRes.ok, true, deckDetailRes.error?.message);
      const firstCardPrompt = String(
        deckDetailRes.value?.cards?.[0]?.cloze?.text || deckDetailRes.value?.cards?.[0]?.prompt || '',
      )
        .trim()
        .slice(0, 18);

      const backupsDir = join(libraryRoot, 'backups');
      const todayYmd = todayLocalYmd();
      let exportedInfo = null;
      tty.send('x');
      const afterExport = await tty.waitFor(
        (s) => {
          const hasToast = useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出') && toast.text.includes('studyhub-deck-'));
          return hasToast && s.includes('已导出');
        },
        { timeoutMs: 10_000, label: 'zh LibraryView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh LibraryView after [x] export');

      exportedInfo = await findExportedBackupFile(backupsDir, 'studyhub-deck', 'md', todayYmd);
      assert.ok(exportedInfo, `expected studyhub-deck-${todayYmd}-HHmmss.md in ${backupsDir}`);
      const exportedMd = await readFile(exportedInfo.path, 'utf8');
      assert.equal(fs.existsSync(exportedInfo.path), true);
      assert.ok(afterExport.includes('已导出'));
      assert.ok(exportedMd.includes(`# ${firstDeck.title}`), 'exported MD must have selected deck title');
      assert.ok(exportedMd.includes('**课程**:'), 'exported MD must have Course metadata');
      assert.ok(exportedMd.includes('**生成日期**:'), 'exported MD must have Generated metadata');
      assert.ok(exportedMd.includes('**题目数量**:'), 'exported MD must have Cards metadata');
      assert.ok(exportedMd.includes('## 1.'), 'exported MD must have numbered card');
      assert.ok(exportedMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedMd.includes('</details>'), 'exported MD must contain </details>');
      if (firstCardPrompt) {
        assert.ok(exportedMd.includes(firstCardPrompt), `exported MD must include card prompt "${firstCardPrompt}"`);
      }
      assert.equal(modelCalls, 0, 'LibraryView [x] export must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});

describe('Round 71 Track 2: LibraryView `/` Live Deck Search & Filter', () => {
  test('1) @xterm/headless PTY E2E (120x36 zh): load sample -> `/` type "Bridge" -> verify filtered deck & badge -> Enter -> Esc clears filter (0 model calls)', async () => {
    const base = await temps.make('r71-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    let modelCalls = 0;
    await cloneSampleLibrary('zh', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetStore(useDistTuiStore, 'zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
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
      const libScreen = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().loading &&
          useDistTuiStore.getState().page === 'library' &&
          s.includes('示例 · Memento 与 Bridge') &&
          s.includes('示例案例 · 墨笺笔记') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
        { timeoutMs: 12_000, label: 'zh LibraryView with sample decks & `/` hint' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'zh LibraryView 120x36');
      assert.ok(libScreen.includes('示例 · Memento 与 Bridge'));
      assert.ok(libScreen.includes('示例案例 · 墨笺笔记'));
      assert.equal(useDistTuiStore.getState().page, 'library');

      const totalDecks = (useDistTuiStore.getState().snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind).length;
      assert.ok(totalDecks >= 2, `Expected >= 2 sample decks, got ${totalDecks}`);

      tty.send('/');
      const filterOpened = await tty.waitFor(
        (s) => !useDistTuiStore.getState().commandPaletteOpen && s.includes(`[筛选 ${totalDecks}/${totalDecks}]`),
        { timeoutMs: 5_000, label: 'zh LibraryView filter bar opened' },
      );
      assert.equal(useDistTuiStore.getState().commandPaletteOpen, false);
      assert.equal(useDistTuiStore.getState().inputCaptured, true);
      assert.ok(filterOpened.includes(`[筛选 ${totalDecks}/${totalDecks}]`));

      tty.send('bridge');
      const topicFiltered = await tty.waitFor(
        (s) => s.includes(`[筛选 ${totalDecks}/${totalDecks}]`) && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 5_000, label: 'zh LibraryView topic filter for bridge' },
      );
      tty.assertHealthyScreen(topicFiltered, 120, 36, 'zh LibraryView topic filter');
      assert.ok(topicFiltered.includes('示例 · Memento 与 Bridge'));
      assert.equal(useDistTuiStore.getState().page, 'library', 'typing bridge must not navigate away');

      tty.send('\x1b');
      const escCleared = await tty.waitFor((s) => !s.includes('[筛选 '), { timeoutMs: 5_000, label: 'zh Esc clears while editing' });
      assert.ok(!escCleared.includes('[筛选 '));
      assert.equal(useDistTuiStore.getState().inputCaptured, false);

      tty.send('/');
      await tty.waitFor((s) => s.includes(`[筛选 ${totalDecks}/${totalDecks}]`), { timeoutMs: 5_000, label: 'zh re-open filter bar' });
      tty.send('Memento 与 Bridge');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes(`[筛选 1/${totalDecks}]`) &&
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('示例案例 · 墨笺笔记'),
        { timeoutMs: 5_000, label: 'zh LibraryView narrowed to 1 deck while editing' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'zh LibraryView filtered editing');
      assert.ok(filteredEditing.includes(`[筛选 1/${totalDecks}]`));
      assert.ok(!filteredEditing.includes('示例案例 · 墨笺笔记'));

      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[筛选 1/${totalDecks}]`) &&
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('示例案例 · 墨笺笔记') &&
          useDistTuiStore.getState().page === 'library',
        { timeoutMs: 5_000, label: 'zh LibraryView filter confirmed on Enter' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'zh LibraryView filter confirmed');
      assert.equal(useDistTuiStore.getState().inputCaptured, false);
      assert.equal(useDistTuiStore.getState().page, 'library');
      assert.ok(filteredConfirmed.includes(`[筛选 1/${totalDecks}]`));

      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) => !s.includes('[筛选 ') && s.includes('示例案例 · 墨笺笔记') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 5_000, label: 'zh LibraryView filter cleared on Esc' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'zh LibraryView restored');
      assert.ok(!restoredScreen.includes('[筛选 '));
      assert.ok(restoredScreen.includes('示例案例 · 墨笺笔记') && restoredScreen.includes('示例 · Memento 与 Bridge'));
      assert.equal(modelCalls, 0, 'LibraryView `/` filter must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
