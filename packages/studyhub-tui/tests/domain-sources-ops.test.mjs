// Consolidated Sources Operations Domain Suite:
// Merged from: round37-sources-e2e, round43-reread-queue, round47-source-links,
//              round48-sources-batch, round50-orig-file, round70-sources-export
// node --test tests/domain-sources-ops.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const sourcesViewFile = distFiles.find((f) => f.startsWith('SourcesView-') && f.endsWith('.mjs'));
assert.ok(sourcesViewFile, 'dist/ must include SourcesView-*.mjs');
const { formatSourcesCatalogMarkdown } = await import(pathToFileURL(join(distDir, sourcesViewFile)).href);
assert.equal(
  typeof formatSourcesCatalogMarkdown,
  'function',
  'SourcesView chunk must export formatSourcesCatalogMarkdown',
);

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-dom-src-ops-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
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
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
    ...extra,
  });
}

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

function sourceListText(screen) {
  const lines = screen.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('资料列表') || l.includes('Materials'));
  if (headerIdx < 0) return screen;
  return lines.slice(headerIdx + 1).join('\n');
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function addTextSource(host, title, text, extra = {}) {
  const res = await host.call('source.add', { title, text, ...extra });
  assert.equal(res.ok, true, `source.add(${title}) failed: ${res.error?.message || ''}`);
  const id = res.value?.source?.id || res.value?.id;
  assert.ok(id, `source.add(${title}) must return source id`);
  return { id, key: `source:${id}` };
}

function safeUnmount(inkInstance) {
  if (!inkInstance) return;
  try {
    inkInstance.unmount();
  } catch {
    // Ignore Ink unmount cleanup errors on already-closed streams
  }
}

function switchMountedLocale(host, language, asciiMode) {
  host.setLanguage(language);
  useTuiStore.getState().setPreferences({ language, asciiMode });
  useTuiStore.setState({ toasts: [] });
}

const DAY_MS = 86_400_000;
const REREAD_COURSE = 'CS101';
const QUOTE_ALPHA = 'Invariant preservation guarantees safety across iterations';
const QUOTE_BETA = 'Amortized potential bounds total sequence cost tightly';
const QUOTE_GAMMA = 'Binary heaps maintain partial order in logarithmic time';

async function seedRereadFixture(base, libraryRoot, env, quotes) {
  const docDir = join(base, 'docs');
  await mkdir(docDir, { recursive: true });
  const mdPath = join(docDir, 'algorithms-reread.md');
  await writeFile(
    mdPath,
    [
      '# Algorithms Fundamentals',
      '',
      `${QUOTE_ALPHA}.`,
      '',
      `${QUOTE_BETA}.`,
      '',
      `${QUOTE_GAMMA}.`,
      '',
    ].join('\n'),
    'utf8',
  );

  const host = await createTuiHost({
    libraryRoot,
    env,
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language: 'en',
  });

  let documentId;
  let revision;
  let sourceId;
  const markIds = [];
  try {
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'Algorithms Notes',
      format: 'md',
    });
    assert.equal(imp.ok, true, `materials.document.import failed: ${imp.error?.message || ''}`);
    documentId = imp.value.documentId;
    revision = imp.value.revision;
    sourceId = imp.value.sourceIds[0];
    assert.ok(documentId && revision && sourceId, 'Imported document must return documentId, revision, sourceId');

    const assign = await host.call('source.courses.set', {
      assignments: [{ id: sourceId, courses: [REREAD_COURSE] }],
    });
    assert.equal(assign.ok, true, `source.courses.set failed: ${assign.error?.message || ''}`);

    for (const { quote, style } of quotes) {
      const saved = await host.call('materials.marks.save', {
        documentId,
        revision,
        style,
        selection: { documentId, revision, sourceId, quote },
      });
      assert.equal(saved.ok, true, `materials.marks.save(${style}) failed: ${saved.error?.message || ''}`);
      assert.equal(saved.value?.status, 'saved');
      assert.ok(saved.value?.item?.id, 'materials.marks.save must return item.id');
      markIds.push(saved.value.item.id);
    }
  } finally {
    await host.dispose();
  }

  const oldIso = new Date(Date.now() - 5 * DAY_MS).toISOString();
  const service = new StudyService(libraryRoot);
  try {
    await service.call('snapshot');
    await service.store.update((state) => {
      const doc = state.documents.find((d) => d.id === documentId);
      const ver = doc?.versions?.find((v) => v.revision === revision);
      assert.ok(ver?.marks?.items?.length >= quotes.length, 'Expected persisted marks on document version');
      for (const item of ver.marks.items) {
        item.at = oldIso;
      }
      state.decks.push({
        id: 'deck-reread-cs101',
        title: 'Algorithms Weak Deck',
        course: REREAD_COURSE,
        cards: [
          {
            id: 'card-weak-1',
            kind: 'flashcard',
            topic: 'Algorithms Fundamentals',
            prompt: 'Why does an invariant guarantee safety?',
            answer: 'Because it holds at initialization and every iteration.',
            citations: [{ sourceId, quote: QUOTE_ALPHA }],
          },
        ],
      });
      state.attempts.push({
        deckId: 'deck-reread-cs101',
        quiz_id: 'card-weak-1',
        grade: 1,
        at: oldIso,
      });
    });
  } finally {
    service.dispose();
  }

  return { documentId, revision, sourceId, markIds };
}

const LINKS_COURSE = 'Distributed Systems';
const LINKS_SOURCE_TITLE = 'Raft Consensus Lecture';
const QUOTE_LEADER = 'Leader election uses randomized election timeouts to avoid split votes.';
const QUOTE_COMMIT = 'A log entry is committed once stored on a majority of servers.';

async function seedCitedSourceAndCards(base, libraryRoot, env, lang = 'zh') {
  const mdPath = join(base, 'raft-lecture.md');
  await writeFile(
    mdPath,
    [
      '# Raft Consensus',
      '',
      '## Leader Election',
      QUOTE_LEADER,
      '',
      '## Log Replication',
      QUOTE_COMMIT,
      '',
    ].join('\n'),
    'utf8',
  );

  const host = await createTuiHost({
    env,
    home: base,
    libraryRoot,
    documentsDir: base,
    providerDiscovery: fakeDiscovery(),
    skipAutoProbe: true,
    language: lang,
  });

  let documentId;
  let revision;
  let sourceId;
  let deckId;
  let weakCardId;
  let newCardId;

  try {
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: LINKS_SOURCE_TITLE,
      format: 'md',
    });
    assert.equal(imp.ok, true, `materials.document.import failed: ${imp.error?.message || ''}`);
    documentId = imp.value.documentId;
    revision = imp.value.revision;
    sourceId = imp.value.sourceIds[0];
    assert.ok(documentId && revision && sourceId, 'Imported document must return documentId, revision, sourceId');

    const courseRes = await host.call('source.courses.set', {
      assignments: [{ id: sourceId, courses: [LINKS_COURSE] }],
    });
    assert.equal(courseRes.ok, true, `source.courses.set failed: ${courseRes.error?.message || ''}`);

    const deckRes = await host.call('deck.import', {
      text: JSON.stringify({
        title: 'Raft Consensus Deck',
        course: LINKS_COURSE,
        cards: [
          {
            kind: 'flashcard',
            topic: 'Leader Election',
            prompt: 'How does Raft prevent split votes during leader election?',
            answer: 'By using randomized election timeouts.',
            citations: [{ sourceId, quote: QUOTE_LEADER }],
          },
          {
            kind: 'flashcard',
            topic: 'Log Replication',
            prompt: 'When is a Raft log entry considered committed?',
            answer: 'Once stored on a majority of servers.',
            citations: [{ sourceId, quote: QUOTE_COMMIT }],
          },
        ],
      }),
      folder: LINKS_COURSE,
    });
    assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message || ''}`);
    assert.equal(deckRes.value?.failed, 0, `deck.import failed entries: ${JSON.stringify(deckRes.value?.results)}`);

    deckId = deckRes.value?.results?.[0]?.deckId;
    assert.ok(deckId, 'deck.import must return deckId');

    const deckGet = await host.call('deck.get', { id: deckId });
    assert.equal(deckGet.ok, true, `deck.get failed: ${deckGet.error?.message || ''}`);
    const cards = deckGet.value?.cards ?? [];
    assert.equal(cards.length, 2, 'Imported deck must contain 2 cited cards');
    const c1 = cards.find((c) => c.prompt.includes('split votes'));
    const c2 = cards.find((c) => c.prompt.includes('considered committed'));
    assert.ok(c1 && c2, 'Both imported cards must be found');
    weakCardId = c1.id;
    newCardId = c2.id;

    const sel1 = await host.call('materials.selection.resolve', {
      documentId,
      revision,
      sourceId,
      quote: QUOTE_LEADER,
    });
    assert.equal(sel1.ok, true, `materials.selection.resolve(1) failed: ${sel1.error?.message || ''}`);
    assert.equal(sel1.value?.status, 'resolved');

    const sel2 = await host.call('materials.selection.resolve', {
      documentId,
      revision,
      sourceId,
      quote: QUOTE_COMMIT,
    });
    assert.equal(sel2.ok, true, `materials.selection.resolve(2) failed: ${sel2.error?.message || ''}`);
    assert.equal(sel2.value?.status, 'resolved');

    const oldIso = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const service = new StudyService(libraryRoot);
    try {
      await service.call('snapshot');
      await service.store.update((state) => {
        const deck = state.decks.find((d) => d.id === deckId);
        assert.ok(deck, 'Seeded deck must exist in library state');
        const card1 = deck.cards.find((c) => c.id === weakCardId);
        const card2 = deck.cards.find((c) => c.id === newCardId);
        assert.ok(card1 && card2, 'Seeded cards must exist in deck');
        card1.citations = [{ sourceId, quote: QUOTE_LEADER, selection: sel1.value.selection }];
        card2.citations = [{ sourceId, quote: QUOTE_COMMIT, selection: sel2.value.selection }];
        card1.review = { ...(card1.review || {}), due_at: oldIso };
        state.attempts.push({
          deckId,
          quiz_id: weakCardId,
          grade: 1,
          at: oldIso,
        });
      });
    } finally {
      service.dispose();
    }
  } finally {
    await host.dispose();
  }

  return { documentId, revision, sourceId, deckId, weakCardId, newCardId };
}

const MATCHING_MD_TEXT = [
  '# Linear Algebra Core',
  '',
  'An eigenvector v of matrix A satisfies Av = lambda v for eigenvalue lambda.',
  '',
  'Symmetric real matrices have orthogonal eigenvectors for distinct eigenvalues.',
  '',
].join('\n');

const MISMATCH_MD_TEXT = [
  '# Unrelated Cooking Guide',
  '',
  'Preheat the oven to 200C and bake sourdough bread for 40 minutes.',
  '',
].join('\n');

describe('Domain Sources Operations: Pins, Reread, Links, Batch, Original File & Export', () => {
  test('1) Pinned ordering integration: source.pin & source.pin.move persist across host reload', async () => {
    const base = await temps.make('pin-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { key: keyA } = await addTextSource(host, 'Alpha Notes', 'Alpha notes text');
      const { key: keyB } = await addTextSource(host, 'Beta Slides', 'Beta slides text');
      const { key: keyC } = await addTextSource(host, 'Gamma Paper', 'Gamma paper text');

      for (const key of [keyA, keyB, keyC]) {
        const pinRes = await host.call('source.pin', { key, pinned: true });
        assert.equal(pinRes.ok, true, pinRes.error?.message);
      }

      const snap1 = await host.call('snapshot', {});
      assert.equal(snap1.ok, true);
      assert.deepEqual(snap1.value?.settings?.materialPins, [keyA, keyB, keyC]);

      const badMove = await host.call('source.pin.move', { key: keyA, before: 'source:nonexistent' });
      assert.equal(badMove.ok, false, 'source.pin.move must reject non-pinned target');

      const moveBefore = await host.call('source.pin.move', { key: keyC, before: keyA });
      assert.equal(moveBefore.ok, true, moveBefore.error?.message);
      assert.deepEqual(moveBefore.value?.pins, [keyC, keyA, keyB]);

      const moveAfter = await host.call('source.pin.move', { key: keyC, after: keyB });
      assert.equal(moveAfter.ok, true, moveAfter.error?.message);
      assert.deepEqual(moveAfter.value?.pins, [keyA, keyB, keyC]);

      const moveFront = await host.call('source.pin.move', { key: keyB, front: true });
      assert.equal(moveFront.ok, true, moveFront.error?.message);
      assert.deepEqual(moveFront.value?.pins, [keyB, keyA, keyC]);

      const snap2 = await host.call('snapshot', {});
      assert.equal(snap2.ok, true);
      assert.deepEqual(snap2.value?.settings?.materialPins, [keyB, keyA, keyC]);

      await host.dispose();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      const reloadedSnap = await host.call('snapshot', {});
      assert.equal(reloadedSnap.ok, true);
      assert.deepEqual(
        reloadedSnap.value?.settings?.materialPins,
        [keyB, keyA, keyC],
        'persisted pinned order must survive host reload',
      );
    } finally {
      await host.dispose();
    }
  });

  test('2) Pinned ordering PTY E2E: [ / ] reorders, preserves focus, renders 120x36 & 80x24 (zh & en --ascii toasts)', async () => {
    const base = await temps.make('pin-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    const { key: keyA } = await addTextSource(host, 'Alpha Notes', 'Alpha notes body');
    const { key: keyB } = await addTextSource(host, 'Beta Slides', 'Beta slides body');
    await addTextSource(host, 'Gamma Paper', 'Gamma paper body');

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false, autoLaunchpad: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready',
      });
      tty.send('2');
      const initialScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Alpha Notes') &&
          s.includes('Beta Slides') &&
          s.includes('Gamma Paper') &&
          s.includes('[/]'),
        { label: 'SourcesView initial render with 3 materials and [/] hint' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, 'SourcesView initial 120x36');
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.ok(initialScreen.includes('Alpha Notes'));
      assert.ok(initialScreen.includes('Beta Slides'));
      assert.ok(initialScreen.includes('Gamma Paper'));

      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先按 [p] 置顶资料后再调整顺序')),
        { label: 'Unpinned [ toast in zh' },
      );
      assert.equal(useTuiStore.getState().page, 'sources', '[ must be claimed by SourcesView');
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先按 [p] 置顶资料后再调整顺序')));

      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先按 [p] 置顶资料后再调整顺序')),
        { label: 'Unpinned ] toast in zh' },
      );
      assert.equal(useTuiStore.getState().page, 'sources', '] must be claimed by SourcesView');

      tty.send('j');
      await tty.flush();
      useTuiStore.setState({ toasts: [] });
      tty.send('p');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已置顶')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB]),
        { label: 'Pinned Beta Slides' },
      );
      assert.deepEqual(useTuiStore.getState().snapshot?.settings?.materialPins, [keyB]);

      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个置顶资料')),
        { label: 'First pinned boundary toast' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个置顶资料')));

      tty.send('j');
      await tty.flush();
      useTuiStore.setState({ toasts: [] });
      tty.send('p');
      await tty.waitFor(
        () =>
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB, keyA]) &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('置顶')),
        { label: 'Pinned Alpha Notes second' },
      );
      await tty.flush();
      assert.deepEqual(useTuiStore.getState().snapshot?.settings?.materialPins, [keyB, keyA]);

      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是最后一个置顶资料')),
        { label: 'Last pinned boundary toast' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是最后一个置顶资料')));

      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已上移置顶「Alpha Notes」')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyA, keyB]),
        { label: 'Moved Alpha Notes up with [' },
      );
      const afterUpScreen = await tty.waitFor(
        (s) => {
          const list = sourceListText(s);
          const idxA = list.indexOf('Alpha Notes');
          const idxB = list.indexOf('Beta Slides');
          return idxA >= 0 && idxB > idxA;
        },
        { label: 'Updated pinned order rendered after [' },
      );
      tty.assertHealthyScreen(afterUpScreen, 120, 36, 'SourcesView after [');
      assert.deepEqual(useTuiStore.getState().snapshot?.settings?.materialPins, [keyA, keyB]);

      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个置顶资料')),
        { label: 'Confirm focus stayed on moved Alpha Notes at index 0' },
      );

      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已下移置顶「Alpha Notes」')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB, keyA]),
        { label: 'Moved Alpha Notes down with ]' },
      );
      const afterDownScreen = await tty.waitFor(
        (s) => {
          const list = sourceListText(s);
          const idxB = list.indexOf('Beta Slides');
          const idxA = list.indexOf('Alpha Notes');
          return idxB >= 0 && idxA > idxB;
        },
        { label: 'Restored pinned order rendered after ]' },
      );
      tty.assertHealthyScreen(afterDownScreen, 120, 36, 'SourcesView after ]');
      assert.deepEqual(useTuiStore.getState().snapshot?.settings?.materialPins, [keyB, keyA]);

      tty.resize(80, 24);
      const narrowDefault = await tty.waitFor(
        (s) => s.includes('Beta Slides') && s.includes('Alpha Notes') && s.split('\n').length <= 24,
        { label: 'SourcesView 80x24 default mode' },
      );
      tty.assertHealthyScreen(narrowDefault, 80, 24, 'SourcesView 80x24 default');

      // Switch in-place to English --ascii at 120x36 (no second PTY mount)
      tty.resize(120, 36);
      switchMountedLocale(host, 'en', true);
      const asciiWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Materials') &&
          s.includes('Beta Slides') &&
          s.includes('Alpha Notes') &&
          s.includes('Gamma Paper') &&
          s.includes('[/]'),
        { label: 'ASCII SourcesView 120x36' },
      );
      tty.assertHealthyScreen(asciiWide, 120, 36, 'ASCII SourcesView 120x36');
      tty.assertAsciiPure(asciiWide, 'ASCII SourcesView 120x36');

      tty.send('[');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Moved pinned "Alpha Notes" up')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyA, keyB]),
        { label: 'ASCII English [ move up' },
      );
      assert.deepEqual(useTuiStore.getState().snapshot?.settings?.materialPins, [keyA, keyB]);
      tty.assertAsciiPure(tty.readScreen(), 'ASCII SourcesView after [');

      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Already the first pinned material')),
        { label: 'ASCII English first-pinned boundary toast' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('Already the first pinned material')));
      tty.assertAsciiPure(tty.readScreen(), 'ASCII SourcesView after boundary [');

      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Moved pinned "Alpha Notes" down')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB, keyA]),
        { label: 'ASCII English ] move down' },
      );
      assert.deepEqual(useTuiStore.getState().snapshot?.settings?.materialPins, [keyB, keyA]);
      tty.assertAsciiPure(tty.readScreen(), 'ASCII SourcesView after ]');

      tty.send('j');
      await tty.flush();
      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Press [p] to pin this material before reordering')),
        { label: 'ASCII English unpinned [ toast' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('Press [p] to pin this material before reordering')));
      tty.assertAsciiPure(tty.readScreen(), 'ASCII SourcesView unpinned [');
    } finally {
      safeUnmount(inkInstance);
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) RereadQueueModal integration: materials.marks.save -> materials.marks.reread -> materials.marks.seen', async () => {
    const base = await temps.make('reread-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const { documentId, revision, sourceId, markIds } = await seedRereadFixture(base, libraryRoot, env, [
      { quote: QUOTE_ALPHA, style: 'highlight' },
      { quote: QUOTE_BETA, style: 'bold' },
    ]);
    assert.equal(markIds.length, 2);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const before = await host.call('materials.marks.reread', { course: REREAD_COURSE });
      assert.equal(before.ok, true, `materials.marks.reread failed: ${before.error?.message || ''}`);
      assert.equal(before.value?.count, 2, `Expected 2 due marks, got ${before.value?.count}`);
      assert.equal(before.value?.total, 2);

      const first = before.value.items.find((it) => it.id === markIds[0]);
      assert.ok(first, 'First saved mark must appear in materials.marks.reread');
      assert.equal(first.title, 'Algorithms Notes');
      assert.equal(first.style, 'highlight');
      assert.equal(first.selection?.sourceId, sourceId);
      assert.equal(first.selection?.quote, QUOTE_ALPHA);
      assert.equal(first.documentId, documentId);
      assert.equal(first.revision, revision);
      assert.ok((first.risk?.weak ?? 0) >= 1, 'Expected weak risk count >= 1');

      const seenRes = await host.call('materials.marks.seen', {
        documentId,
        sourceId,
        revision,
        id: markIds[0],
      });
      assert.equal(seenRes.ok, true, `materials.marks.seen failed: ${seenRes.error?.message || ''}`);
      assert.equal(seenRes.value?.status, 'saved');
      assert.ok(seenRes.value?.item?.rereadAt, 'materials.marks.seen must stamp rereadAt');

      const after = await host.call('materials.marks.reread', { course: REREAD_COURSE });
      assert.equal(after.ok, true);
      assert.equal(after.value?.count, 1, 'Seen mark must leave the reread queue for 3 days');
      assert.equal(after.value?.total, 1);
      assert.equal(after.value?.items[0]?.id, markIds[1]);
    } finally {
      await host.dispose();
    }
  });

  test('4) RereadQueueModal PTY E2E: [R] opens modal, [r] marks seen, [Enter] opens DocumentReader, [Esc] closes, en empty state', async () => {
    const base = await temps.make('reread-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await seedRereadFixture(base, libraryRoot, env, [
      { quote: QUOTE_ALPHA, style: 'highlight' },
      { quote: QUOTE_BETA, style: 'bold' },
      { quote: QUOTE_GAMMA, style: 'highlight' },
    ]);

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false, autoLaunchpad: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready',
      });
      tty.send('2');

      const sourcesScreen = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('Algorithms Notes') && s.includes('重读清单'),
        { label: 'SourcesView ready with Reread footer hint' },
      );
      tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView zh 120x36');
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.ok(sourcesScreen.includes('重读清单'));

      tty.send('R');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('今日重读清单') &&
          s.includes('Invariant preservation') &&
          s.includes('Amortized potential'),
        { label: 'RereadQueueModal rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'RereadQueueModal zh 120x36');
      assert.ok(modalScreen.includes('今日重读清单'));

      useTuiStore.setState({ toasts: [] });
      tty.send('r');
      const afterSeenZh = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已标记为重读')) &&
          s.includes('今日推荐 2'),
        { label: 'Marked reread via [r] in zh' },
      );
      tty.assertHealthyScreen(afterSeenZh, 120, 36, 'RereadQueueModal after [r] zh 120x36');
      assert.ok(afterSeenZh.includes('今日推荐 2'));
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('已标记为重读')));

      tty.send('\u001b');
      const afterEscZh = await tty.waitFor(
        (s) => !s.includes('今日重读清单') && s.includes('学习资料库'),
        { label: 'Esc closes RereadQueueModal cleanly' },
      );
      assert.ok(!afterEscZh.includes('今日重读清单'));

      tty.resize(80, 24);
      await tty.flush();
      tty.send('R');
      const narrowModal = await tty.waitFor(
        (s) => s.includes('今日重读清单') && s.includes('今日推荐 2'),
        { label: 'RereadQueueModal rendered in zh 80x24' },
      );
      tty.assertHealthyScreen(narrowModal, 80, 24, 'RereadQueueModal zh 80x24');

      tty.send('\r');
      const readerScreen = await tty.waitFor(
        (s) => !s.includes('今日重读清单') && s.includes('Algorithms Notes') && s.includes('Invariant preservation'),
        { label: 'Enter opens DocumentReader from RereadQueueModal' },
      );
      tty.assertHealthyScreen(readerScreen, 80, 24, 'DocumentReader opened from RereadQueueModal 80x24');
      assert.ok(readerScreen.includes('Invariant preservation'));

      // Return from DocumentReader and switch in-place to English --ascii at 120x36 (no second PTY mount)
      tty.send('\u001b');
      await tty.waitFor(() => useTuiStore.getState().page === 'sources', {
        label: 'Esc returns from DocumentReader to SourcesView',
      });
      tty.resize(120, 36);
      switchMountedLocale(host, 'en', true);
      const asciiSources = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('Algorithms Notes') && s.includes('Reread'),
        { label: 'ASCII SourcesView ready' },
      );
      tty.assertHealthyScreen(asciiSources, 120, 36, 'ASCII SourcesView 120x36');
      tty.assertAsciiPure(asciiSources, 'ASCII SourcesView 120x36');

      tty.send('R');
      const asciiWideModal = await tty.waitFor(
        (s) => s.includes('Reread Marks Queue') && s.includes('Due 2'),
        { label: 'ASCII RereadQueueModal 120x36' },
      );
      tty.assertHealthyScreen(asciiWideModal, 120, 36, 'ASCII RereadQueueModal 120x36');
      tty.assertAsciiPure(asciiWideModal, 'ASCII RereadQueueModal 120x36');
      assert.ok(asciiWideModal.includes('Due 2'));

      useTuiStore.setState({ toasts: [] });
      tty.send('r');
      const asciiOneLeft = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Marked as reread')) &&
          s.includes('Due 1'),
        { label: 'ASCII [r] marks first remaining item seen' },
      );
      tty.assertAsciiPure(asciiOneLeft, 'ASCII RereadQueueModal after 1st [r]');
      assert.ok(asciiOneLeft.includes('Due 1'));
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('Marked as reread')));

      useTuiStore.setState({ toasts: [] });
      tty.send('r');
      const asciiEmpty = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Marked as reread')) &&
          s.includes('No marks due for reread today'),
        { label: 'ASCII [r] marks last item seen and renders empty state' },
      );
      tty.assertHealthyScreen(asciiEmpty, 120, 36, 'ASCII RereadQueueModal empty state 120x36');
      tty.assertAsciiPure(asciiEmpty, 'ASCII RereadQueueModal empty state 120x36');
      assert.ok(asciiEmpty.includes('No marks due for reread today'));

      tty.send('\u001b');
      const afterEsc = await tty.waitFor(
        (s) => !s.includes('Reread Marks Queue') && s.includes('Algorithms Notes'),
        { label: 'ASCII Esc closes RereadQueueModal cleanly' },
      );
      tty.assertAsciiPure(afterEsc, 'ASCII SourcesView after Esc');
      assert.ok(!afterEsc.includes('Reread Marks Queue'));
    } finally {
      safeUnmount(inkInstance);
      tty.dispose();
      await host.dispose();
    }
  });

  test('5) SourceCoverageModal Tab 2 integration: materials.pages.cards and materials.links.list return linked cards & citations', async () => {
    const base = await temps.make('links-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');

    const { documentId, sourceId, deckId, weakCardId, newCardId } = await seedCitedSourceAndCards(
      base,
      libraryRoot,
      env,
      'en',
    );

    const host = await createTuiHost({
      env,
      home: base,
      libraryRoot,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const pagesRes = await host.call('materials.pages.cards', { documentId, sourceId });
      assert.equal(pagesRes.ok, true, `materials.pages.cards failed: ${pagesRes.error?.message || ''}`);
      assert.equal(pagesRes.value?.status, 'ok');
      assert.equal(pagesRes.value?.summary?.total, 2, 'summary.total must equal 2');
      assert.equal(pagesRes.value?.summary?.weak, 1, 'summary.weak must equal 1');
      assert.equal(pagesRes.value?.summary?.due, 1, 'summary.due must equal 1');
      assert.equal(pagesRes.value?.summary?.fresh, 1, 'summary.fresh must equal 1');

      const cards = pagesRes.value?.cards ?? [];
      assert.equal(cards.length, 2, 'materials.pages.cards must return 2 linked cards');
      const weakEntry = cards.find((c) => c.deckId === deckId && c.cardId === weakCardId);
      const newEntry = cards.find((c) => c.deckId === deckId && c.cardId === newCardId);
      assert.ok(weakEntry && newEntry, 'Both seeded cards must be returned by materials.pages.cards');
      assert.equal(weakEntry.level, 'weak');
      assert.equal(weakEntry.due, true);
      assert.equal(newEntry.level, 'new');
      assert.ok(weakEntry.links?.some((l) => l.sourceId === sourceId), 'weak card link must reference sourceId');

      const linksRes = await host.call('materials.links.list', { documentId });
      assert.equal(linksRes.ok, true, `materials.links.list failed: ${linksRes.error?.message || ''}`);
      const links = linksRes.value?.links ?? [];
      assert.equal(links.length, 2, 'materials.links.list must return 2 resolved passage links');
      const link1 = links.find((l) => l.cardId === weakCardId);
      const link2 = links.find((l) => l.cardId === newCardId);
      assert.ok(link1 && link2, 'Both card links must appear in materials.links.list');
      assert.equal(link1.status, 'resolved');
      assert.equal(link2.status, 'resolved');
      assert.equal(link1.selection?.quote, QUOTE_LEADER);
      assert.equal(link2.selection?.quote, QUOTE_COMMIT);
    } finally {
      await host.dispose();
    }
  });

  test('6) SourceCoverageModal Tab 2 PTY E2E: [V] -> Tab/2 Linked Cards & mastery -> [p] ReviewView (zh 120x36 & 80x24 + en --ascii labels)', async () => {
    const baseZh = await temps.make('links-ui-zh');
    const envZh = sanitizedTestEnv({ DSH_HOME: join(baseZh, 'dsh-home') });
    process.env.DSH_HOME = envZh.DSH_HOME;
    const libraryRootZh = join(baseZh, 'library');

    await seedCitedSourceAndCards(baseZh, libraryRootZh, envZh, 'zh');
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetTuiStore('zh', false);

    const hostZh = await createTuiHost({
      env: envZh,
      home: baseZh,
      libraryRoot: libraryRootZh,
      documentsDir: baseZh,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    const tty = createVirtualTty(120, 36);
    let app = null;
    try {
      app = render(React.createElement(StudyHubTuiApp, { host: hostZh, initialLanguage: 'zh', initialAsciiMode: false, autoLaunchpad: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready (zh)',
      });

      tty.send('2');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes(LINKS_SOURCE_TITLE),
        { label: 'SourcesView rendered with Raft Consensus Lecture' },
      );
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选资料:'), { label: 'SourcesView filter input opened (zh)' });
      tty.send(LINKS_SOURCE_TITLE);
      await tty.waitFor((s) => !s.includes('JSON 导入'), { label: 'SourcesView filtered to LINKS_SOURCE_TITLE (zh)' });
      tty.send('\r');
      const filteredZh = await tty.waitFor((s) => s.includes('(/ 修改)'), { label: 'SourcesView filter committed (zh)' });
      assert.ok(filteredZh.includes(LINKS_SOURCE_TITLE));

      tty.send('V');
      const tab1Screen = await tty.waitFor(
        (s) =>
          s.includes('资料引用与章节覆盖率') &&
          s.includes('1:章节覆盖') &&
          s.includes('2:关联题卡') &&
          !s.includes('正在统计章节与引用覆盖率'),
        { label: 'SourceCoverageModal opened on Tab 1 (zh, 120x36)' },
      );
      tty.assertHealthyScreen(tab1Screen, 120, 36, 'SourceCoverageModal Tab 1 zh 120x36');
      assert.ok(tab1Screen.includes('1:章节覆盖'));
      assert.ok(tab1Screen.includes('2:关联题卡'));

      tty.send('2');
      const tab2Wide = await tty.waitFor(
        (s) =>
          s.includes('题卡掌握') &&
          s.includes('8%') &&
          s.includes('[薄弱]') &&
          s.includes('[到期]') &&
          s.includes('[新题]') &&
          s.includes('split votes') &&
          s.includes('When is a Raft log entry'),
        { label: 'Tab 2 Linked Cards rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(tab2Wide, 120, 36, 'SourceCoverageModal Tab 2 zh 120x36');
      assert.ok(tab2Wide.includes('[薄弱]'));
      assert.ok(tab2Wide.includes('[到期]'));
      assert.ok(tab2Wide.includes('[新题]'));

      tty.resize(80, 24);
      const tab2Narrow = await tty.waitFor(
        (s) =>
          s.includes('2:关联题卡') &&
          s.includes('题卡掌握') &&
          s.includes('8%') &&
          s.includes('1-2 / Tab') &&
          s.includes('How does Raft prevent') &&
          s.split('\n').length <= 24,
        { label: 'Tab 2 Linked Cards rendered cleanly at 80x24 (zh)' },
      );
      tty.assertHealthyScreen(tab2Narrow, 80, 24, 'SourceCoverageModal Tab 2 zh 80x24');

      tty.send('\t');
      const backTab1 = await tty.waitFor(
        (s) => (s.includes('章节覆盖') || s.includes('直接引用来源')) && !s.includes('题卡掌握'),
        { label: 'Switched back to Tab 1 via Tab' },
      );
      assert.ok(!backTab1.includes('题卡掌握'));

      tty.send('\t');
      const backTab2 = await tty.waitFor(
        (s) => s.includes('题卡掌握') && s.includes('How does Raft prevent'),
        { label: 'Switched to Tab 2 via Tab' },
      );
      assert.ok(backTab2.includes('题卡掌握'));

      tty.send('\x1b');
      const closedNarrow = await tty.waitFor(
        (s) => !s.includes('资料引用与章节覆盖率') && s.includes(LINKS_SOURCE_TITLE),
        { label: 'SourceCoverageModal closed on Esc at 80x24 (zh)' },
      );
      tty.assertHealthyScreen(closedNarrow, 80, 24, 'SourcesView after Esc zh 80x24');

      // Switch in-place to English --ascii at 120x36 (no second seed or second PTY mount)
      tty.resize(120, 36);
      switchMountedLocale(hostZh, 'en', true);
      const sourcesWide = await tty.waitFor(
        (s) => s.includes('(/ edit)') && s.includes(LINKS_SOURCE_TITLE),
        { label: 'SourcesView filter committed (en ascii 120x36)' },
      );
      tty.assertHealthyScreen(sourcesWide, 120, 36, 'SourcesView en ascii 120x36');
      tty.assertAsciiPure(sourcesWide, 'SourcesView en ascii 120x36 pure');
      assert.ok(sourcesWide.includes('(/ edit)'));

      tty.send('/');
      await tty.waitFor((s) => s.includes('Filter: '), { label: 'SourcesView filter input opened (en)' });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('(/ edit)') && s.includes(LINKS_SOURCE_TITLE), {
        label: 'SourcesView filter re-committed (en)',
      });

      tty.send('V');
      const tab1Wide = await tty.waitFor(
        (s) =>
          s.includes('Source Coverage') &&
          s.includes('1:Coverage') &&
          s.includes('2:Linked Cards') &&
          !s.includes('Loading citation'),
        { label: 'SourceCoverageModal Tab 1 rendered (en ascii 120x36)' },
      );
      tty.assertHealthyScreen(tab1Wide, 120, 36, 'SourceCoverageModal Tab 1 en ascii 120x36');
      tty.assertAsciiPure(tab1Wide, 'SourceCoverageModal Tab 1 en ascii 120x36 pure');
      assert.ok(tab1Wide.includes('1:Coverage'));
      assert.ok(tab1Wide.includes('2:Linked Cards'));

      tty.send('\t');
      const tab2WideEn = await tty.waitFor(
        (s) =>
          s.includes('Mastery') &&
          s.includes('[weak]') &&
          s.includes('[due]') &&
          s.includes('[new]') &&
          s.includes('split votes'),
        { label: 'SourceCoverageModal Tab 2 rendered (en ascii 120x36)' },
      );
      tty.assertHealthyScreen(tab2WideEn, 120, 36, 'SourceCoverageModal Tab 2 en ascii 120x36');
      tty.assertAsciiPure(tab2WideEn, 'SourceCoverageModal Tab 2 en ascii 120x36 pure');
      assert.ok(tab2WideEn.includes('[weak]'));
      assert.ok(tab2WideEn.includes('[due]'));
      assert.ok(tab2WideEn.includes('[new]'));

      tty.send('\x1b');
      const closedEn = await tty.waitFor(
        (s) => !s.includes('Source Coverage') && s.includes(LINKS_SOURCE_TITLE),
        { label: 'SourceCoverageModal closed via Esc (en ascii)' },
      );
      tty.assertAsciiPure(closedEn, 'SourcesView after Esc en ascii pure');
      assert.ok(!closedEn.includes('Source Coverage'));

      tty.send('V');
      await tty.waitFor((s) => s.includes('2:Linked Cards'), { label: 'SourceCoverageModal reopened (en)' });
      tty.send('2');
      await tty.waitFor((s) => s.includes('split votes'), { label: 'Tab 2 loaded again (en)' });
      tty.send('p');
      const reviewScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'review' &&
          Boolean(useTuiStore.getState().activeRunId) &&
          (s.includes('split votes') || s.includes('considered committed')),
        { label: 'Pressing [p] on Tab 2 launches ReviewView with activeRunId' },
      );
      tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from Tab 2 [p] 120x36');
      tty.assertAsciiPure(reviewScreen, 'ReviewView launched from Tab 2 [p] 120x36');
      assert.equal(useTuiStore.getState().page, 'review');
      assert.ok(useTuiStore.getState().activeRunId, 'ReviewView must receive activeRunId');
    } finally {
      safeUnmount(app);
      app = null;
      tty.dispose();
      await hostZh.dispose();
    }
  });

  test('7) Multi-select batch integration: source.folder.set { keys } & 0-token idempotent materials.enrich', async () => {
    const base = await temps.make('batch-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        modelCalls += 1;
        return 'unused';
      },
    });

    try {
      const s1 = await addTextSource(host, 'Alpha Notes', 'Alpha notes body');
      const s2 = await addTextSource(host, 'Beta Slides', 'Beta slides body');
      const s3 = await addTextSource(host, 'Gamma Paper', 'Gamma paper body');

      const folderRes = await host.call('source.folder.create', { name: 'Week 1' });
      assert.equal(folderRes.ok, true, folderRes.error?.message);

      const batchSet = await host.call('source.folder.set', {
        keys: [s1.key, s2.key],
        folder: 'Week 1',
      });
      assert.equal(batchSet.ok, true, batchSet.error?.message);
      assert.equal(batchSet.value?.updated, 2);
      assert.equal(batchSet.value?.folder, 'Week 1');

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const itemsMap = snap.value?.settings?.materialFolders?.items ?? {};
      assert.equal(itemsMap[s1.key], 'Week 1');
      assert.equal(itemsMap[s2.key], 'Week 1');
      assert.equal(itemsMap[s3.key], undefined);

      const enrich1 = await host.call('materials.enrich', { sourceIds: [s1.id, s2.id] });
      assert.equal(enrich1.ok, true, enrich1.error?.message);
      assert.equal(enrich1.value?.updated, 2);
      assert.equal(enrich1.value?.changes?.length, 2);
      for (const ch of enrich1.value?.changes ?? []) {
        assert.ok(ch.fields.includes('format'), `expected format field enriched on ${ch.id}`);
        assert.ok(ch.fields.includes('contentRevision'), `expected contentRevision field enriched on ${ch.id}`);
      }
      assert.ok(Array.isArray(enrich1.value?.unresolved));
      assert.equal(enrich1.value?.unresolved?.length, 2);

      const enrich2 = await host.call('materials.enrich', { sourceIds: [s1.id, s2.id] });
      assert.equal(enrich2.ok, true, enrich2.error?.message);
      assert.equal(enrich2.value?.updated, 0);
      assert.equal(enrich2.value?.changes?.length, 0);
      assert.equal(modelCalls, 0, 'batch folder assign & materials.enrich must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('8) Multi-select batch PTY E2E: Space, [E], [m], [a], Esc in zh (120x36 & 80x24) & en --ascii (0 model calls)', async () => {
    const base = await temps.make('batch-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'unused';
      },
    });

    const s1 = await addTextSource(host, 'Alpha Notes', 'Alpha notes body');
    const s2 = await addTextSource(host, 'Beta Slides', 'Beta slides body');
    const s3 = await addTextSource(host, 'Gamma Paper', 'Gamma paper body');
    const mkFolder = await host.call('source.folder.create', { name: 'Lectures' });
    assert.equal(mkFolder.ok, true, mkFolder.error?.message);
    const mkFolder2 = await host.call('source.folder.create', { name: 'Labs' });
    assert.equal(mkFolder2.ok, true, mkFolder2.error?.message);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false, autoLaunchpad: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready',
      });
      tty.send('2');
      const initialScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Alpha Notes') &&
          s.includes('Beta Slides') &&
          s.includes('Gamma Paper'),
        { label: 'zh SourcesView initial render' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, 'zh SourcesView initial 120x36');
      assert.equal(useTuiStore.getState().page, 'sources');

      tty.send(' ');
      const oneSelected = await tty.waitFor((s) => s.includes('已选 1 份') && s.includes('[✓]'), {
        label: 'zh 1 source selected with Space',
      });
      assert.ok(oneSelected.includes('已选 1 份'));

      tty.send('j');
      await tty.flush();
      tty.send(' ');
      const twoSelectedScreen = await tty.waitFor((s) => s.includes('已选 2 份') && s.includes('[✓]'), {
        label: 'zh 2 sources selected with Space',
      });
      tty.assertHealthyScreen(twoSelectedScreen, 120, 36, 'zh SourcesView 2 selected 120x36');
      assert.ok(twoSelectedScreen.includes('已选 2 份'));
      assert.ok(twoSelectedScreen.includes('[✓]'));

      tty.send('\u001b');
      const clearedScreen = await tty.waitFor((s) => !s.includes('已选') && !s.includes('[✓]'), {
        label: 'zh Esc clears multi-select',
      });
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'zh SourcesView after Esc clear');
      assert.ok(!clearedScreen.includes('[✓]'));

      tty.send(' ');
      await tty.flush();
      tty.send('k');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 2 份'), { label: 'zh re-selected 2 sources' });

      useTuiStore.setState({ toasts: [] });
      tty.send('E');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已补全 2 份元信息')),
        { label: 'zh [E] enrich toast for 2 selected sources' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('已补全 2 份元信息')));
      assert.equal(modelCalls, 0, '[E] enrich must make 0 model calls');

      useTuiStore.setState({ toasts: [] });
      tty.send('m');
      const batchModalScreen = await tty.waitFor(
        (s) => s.includes('批量移动资料到文件夹') && s.includes('已选 2 份') && s.includes('Lectures'),
        { label: 'zh BatchFolderModal opened' },
      );
      tty.assertHealthyScreen(batchModalScreen, 120, 36, 'zh BatchFolderModal 120x36');
      assert.ok(batchModalScreen.includes('批量移动资料到文件夹'));

      tty.send('\r');
      await tty.waitFor(
        () => {
          const st = useTuiStore.getState();
          const items = st.snapshot?.settings?.materialFolders?.items ?? {};
          return (
            st.toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已将 2 份资料移入「Lectures」')) &&
            items[s1.key] === 'Lectures' &&
            items[s2.key] === 'Lectures' &&
            items[s3.key] === undefined
          );
        },
        { label: 'zh batch folder move applied to both selected sources' },
      );
      const itemsAfterMove = useTuiStore.getState().snapshot?.settings?.materialFolders?.items ?? {};
      assert.equal(itemsAfterMove[s1.key], 'Lectures');
      assert.equal(itemsAfterMove[s2.key], 'Lectures');
      assert.equal(itemsAfterMove[s3.key], undefined);
      await tty.waitFor((s) => !s.includes('已选') && !s.includes('批量移动资料到文件夹'), {
        label: 'zh selection cleared and modal closed after batch move',
      });

      tty.send(' ');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 2 份'), { label: 'zh 2 sources selected for batch archive' });

      useTuiStore.setState({ toasts: [] });
      tty.send('a');
      await tty.waitFor((s) => s.includes('归档 2 份资料') && s.includes('中断'), {
        label: 'zh [a] batch archive opens ConfirmDialog with active practice warning',
      });
      // Cancel first with n — must NOT archive anything
      tty.send('n');
      await tty.waitFor((s) => !s.includes('归档 2 份资料'), {
        label: 'zh [a] batch archive cancelled by n',
      });
      assert.equal(
        (useTuiStore.getState().snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && src.archived).length,
        0,
      );
      tty.send('a');
      await tty.waitFor((s) => s.includes('归档 2 份资料'), {
        label: 'zh [a] batch archive ConfirmDialog reopened',
      });
      tty.send('y');
      await tty.waitFor(
        () => {
          const st = useTuiStore.getState();
          const archivedCount = (st.snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && src.archived).length;
          return st.toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已归档 2 份资料')) && archivedCount === 2;
        },
        { label: 'zh [a] batch archive applied to 2 sources' },
      );
      assert.equal(
        (useTuiStore.getState().snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && src.archived).length,
        2,
      );

      tty.send(' ');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 2 份'), { label: 'zh 2 archived sources selected for batch restore' });

      useTuiStore.setState({ toasts: [] });
      tty.send('a');
      await tty.waitFor((s) => s.includes('恢复 2 份资料'), {
        label: 'zh [a] batch restore opens ConfirmDialog',
      });
      tty.send('y');
      await tty.waitFor(
        () => {
          const st = useTuiStore.getState();
          const activeCount = (st.snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && !src.archived).length;
          return st.toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已恢复 2 份资料')) && activeCount === 2;
        },
        { label: 'zh [a] batch restore applied to 2 sources' },
      );
      assert.equal(
        (useTuiStore.getState().snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && !src.archived).length,
        2,
      );

      tty.send('k');
      await tty.flush();
      tty.send('k');
      await tty.flush();
      tty.send(' ');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      tty.resize(80, 24);
      const narrowZh = await tty.waitFor(
        (s) => s.includes('已选 2 份') && s.includes('[✓]') && s.split('\n').length <= 24,
        { label: 'zh SourcesView 80x24 with 2 selected' },
      );
      tty.assertHealthyScreen(narrowZh, 80, 24, 'zh SourcesView 80x24 multi-select');

      // Switch in-place to English --ascii at 120x36 (no second PTY mount)
      tty.resize(120, 36);
      tty.send('\u001b');
      await tty.waitFor((s) => !s.includes('已选') && !s.includes('[✓]'), {
        label: 'Clear selection before switching to English --ascii',
      });
      switchMountedLocale(host, 'en', true);
      await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Materials') &&
          s.includes('Alpha Notes') &&
          s.includes('Beta Slides'),
        { label: 'ASCII SourcesView 120x36' },
      );

      // Reset cursor to index 0 (Alpha Notes) before selecting Alpha Notes & Beta Slides
      tty.send('k');
      await tty.flush();
      tty.send('k');
      await tty.flush();
      tty.send(' ');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      const asciiSelected = await tty.waitFor((s) => s.includes('2 selected') && s.includes('[x]'), {
        label: 'ASCII en 2 selected with [x]',
      });
      tty.assertHealthyScreen(asciiSelected, 120, 36, 'ASCII SourcesView 2 selected 120x36');
      tty.assertAsciiPure(asciiSelected, 'ASCII SourcesView 2 selected 120x36');
      assert.ok(asciiSelected.includes('2 selected'));
      assert.ok(asciiSelected.includes('[x]'));

      useTuiStore.setState({ toasts: [] });
      tty.send('E');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Metadata checked (0 changes, 2 unresolved)')),
        { label: 'ASCII en [E] enrich toast' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('Metadata checked (0 changes, 2 unresolved)')));
      tty.assertAsciiPure(tty.readScreen(), 'ASCII SourcesView after [E]');

      useTuiStore.setState({ toasts: [] });
      tty.send('m');
      const asciiModal = await tty.waitFor(
        (s) => s.includes('Batch Move to Folder') && s.includes('2 selected') && s.includes('Labs'),
        { label: 'ASCII en BatchFolderModal' },
      );
      tty.assertHealthyScreen(asciiModal, 120, 36, 'ASCII BatchFolderModal 120x36');
      tty.assertAsciiPure(asciiModal, 'ASCII BatchFolderModal 120x36');
      assert.ok(asciiModal.includes('Batch Move to Folder'));

      tty.send('j');
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        () => {
          const st = useTuiStore.getState();
          const items = st.snapshot?.settings?.materialFolders?.items ?? {};
          return (
            st.toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Moved 2 materials to "Labs"')) &&
            items[s1.key] === 'Labs' &&
            items[s2.key] === 'Labs'
          );
        },
        { label: 'ASCII en batch moved 2 materials to Labs' },
      );
      const itemsEn = useTuiStore.getState().snapshot?.settings?.materialFolders?.items ?? {};
      assert.equal(itemsEn[s1.key], 'Labs');
      assert.equal(itemsEn[s2.key], 'Labs');

      tty.send(' ');
      await tty.flush();
      tty.send('k');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('2 selected') && s.includes('[x]'), {
        label: 'ASCII SourcesView 2 selected before Esc',
      });

      tty.send('\u001b');
      const asciiCleared = await tty.waitFor((s) => !s.includes('selected') && !s.includes('[x]'), {
        label: 'ASCII Esc clears selection',
      });
      tty.assertAsciiPure(asciiCleared, 'ASCII SourcesView after Esc');
      assert.ok(!asciiCleared.includes('[x]'));
      assert.equal(modelCalls, 0, 'Total model calls across all operations must remain 0');
    } finally {
      safeUnmount(inkInstance);
      tty.dispose();
      await host.dispose();
    }
  });

  test('9) OriginalFileModal integration: materials.original.status / probe / attach / detach keeps disk file intact', async () => {
    const base = await temps.make('orig-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const filesDir = join(base, 'files');
    await mkdir(filesDir, { recursive: true });

    const mdPath = join(filesDir, 'linear-algebra.md');
    const mismatchPath = join(filesDir, 'unrelated.md');
    await writeFile(mdPath, MATCHING_MD_TEXT, 'utf8');
    await writeFile(mismatchPath, MISMATCH_MD_TEXT, 'utf8');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { id: sourceId } = await addTextSource(host, 'Linear Algebra Notes', MATCHING_MD_TEXT, { format: 'md' });

      const st0 = await host.call('materials.original.status', { sourceId });
      assert.equal(st0.ok, true, st0.error?.message);
      assert.equal(st0.value?.status, 'none');
      assert.equal(st0.value?.mode, null);
      assert.equal(st0.value?.format, 'md');

      const probeOk = await host.call('materials.original.probe', { sourceId, path: mdPath });
      assert.equal(probeOk.ok, true, probeOk.error?.message);
      assert.equal(probeOk.value?.accepted, true);
      assert.equal(probeOk.value?.format, 'md');

      const attachedRef = await host.call('materials.original.attach', {
        sourceId,
        path: mdPath,
        mode: 'reference',
      });
      assert.equal(attachedRef.ok, true, attachedRef.error?.message);
      assert.equal(attachedRef.value?.status, 'attached');
      assert.equal(attachedRef.value?.mode, 'reference');
      assert.equal(attachedRef.value?.originalAvailable, true);

      const st1 = await host.call('materials.original.status', { sourceId });
      assert.equal(st1.ok, true, st1.error?.message);
      assert.equal(st1.value?.status, 'ok');
      assert.equal(st1.value?.mode, 'reference');
      assert.equal(st1.value?.path, mdPath);

      const needsConfirm = await host.call('materials.original.attach', {
        sourceId,
        path: mismatchPath,
        mode: 'reference',
      });
      assert.equal(needsConfirm.ok, true, needsConfirm.error?.message);
      assert.equal(needsConfirm.value?.status, 'needs-confirmation');
      assert.equal(needsConfirm.value?.report?.accepted, false);

      const detached = await host.call('materials.original.detach', { sourceId });
      assert.equal(detached.ok, true, detached.error?.message);
      assert.equal(detached.value?.status, 'detached');

      const st2 = await host.call('materials.original.status', { sourceId });
      assert.equal(st2.ok, true, st2.error?.message);
      assert.equal(st2.value?.status, 'none');
      assert.equal(st2.value?.mode, null);
      assert.equal(await fileExists(mdPath), true, 'external original file on disk must never be deleted by detach');
      assert.equal(await fileExists(mismatchPath), true, 'unrelated file on disk must still exist');
    } finally {
      await host.dispose();
    }
  });

  test('10) OriginalFileModal PTY E2E: [O] inspect, [a] attach/Tab mode, [d]/[y] detach (zh 120x36 & 80x24 + en --ascii Esc back)', async () => {
    const base = await temps.make('orig-e2e');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const filesDir = join(base, 'files');
    await mkdir(filesDir, { recursive: true });

    const mdPath = join(filesDir, 'linear-algebra.md');
    await writeFile(mdPath, MATCHING_MD_TEXT, 'utf8');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    await addTextSource(host, 'Linear Algebra Notes', MATCHING_MD_TEXT, { format: 'md' });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false, autoLaunchpad: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready',
      });

      tty.send('2');
      const sourcesZh = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('Linear Algebra Notes') && s.includes('重读清单'),
        { label: 'SourcesView zh ready with Reread hint' },
      );
      tty.assertHealthyScreen(sourcesZh, 120, 36, 'SourcesView zh 120x36');
      assert.equal(useTuiStore.getState().page, 'sources');

      tty.send('O');
      const modalZh = await tty.waitFor(
        (s) => s.includes('原文件信息与关联') && s.includes('未关联') && s.includes('MD'),
        { label: 'OriginalFileModal inspect rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(modalZh, 120, 36, 'OriginalFileModal inspect zh 120x36');
      assert.ok(modalZh.includes('原文件信息与关联'));
      assert.ok(modalZh.includes('未关联'));
      assert.ok(modalZh.includes('MD'));

      tty.send('a');
      const attachZh = await tty.waitFor(
        (s) => s.includes('本地原文件路径') && s.includes('1. reference') && s.includes('仅记忆磁盘路径'),
        { label: 'OriginalFileModal attach sub-mode rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(attachZh, 120, 36, 'OriginalFileModal attach zh 120x36');
      assert.ok(attachZh.includes('本地原文件路径'));

      tty.send('\t');
      const copyModeZh = await tty.waitFor(
        (s) => s.includes('复制一份到学习库内部存储'),
        { label: 'Tab toggles attach mode to copy' },
      );
      assert.ok(copyModeZh.includes('复制一份到学习库内部存储'));

      tty.send('\t');
      const refModeZh = await tty.waitFor(
        (s) => s.includes('仅记忆磁盘路径'),
        { label: 'Tab toggles attach mode back to reference' },
      );
      assert.ok(refModeZh.includes('仅记忆磁盘路径'));

      tty.send(mdPath);
      await tty.waitFor((s) => s.includes('linear-algebra.md'), { label: 'Path entered in TextInput' });
      tty.send('\r');

      const attachedZh = await tty.waitFor(
        (s) => s.includes('已关联') && s.includes('reference（仅引用路径') && s.includes('linear-algebra.md'),
        { label: 'Original file attached via TUI' },
      );
      tty.assertHealthyScreen(attachedZh, 120, 36, 'OriginalFileModal attached zh 120x36');
      assert.ok(attachedZh.includes('已关联'));
      assert.ok(attachedZh.includes('linear-algebra.md'));

      tty.send('d');
      const confirmDetachZh = await tty.waitFor(
        (s) => s.includes('解除原文件关联') && s.includes('不会删除磁盘上的原始文件'),
        { label: 'Detach ConfirmDialog shown' },
      );
      tty.assertHealthyScreen(confirmDetachZh, 120, 36, 'OriginalFileModal detach ConfirmDialog zh 120x36');
      assert.ok(confirmDetachZh.includes('解除原文件关联'));

      tty.send('y');
      const detachedZh = await tty.waitFor(
        (s) => !s.includes('解除原文件关联') && s.includes('未关联') && s.includes('原文件信息与关联'),
        { label: 'Original file detached back to 未关联' },
      );
      assert.ok(detachedZh.includes('未关联'));
      assert.equal(await fileExists(mdPath), true, 'Disk file must remain intact after TUI detach');

      tty.resize(80, 24);
      const modalNarrowZh = await tty.waitFor(
        (s) => s.includes('原文件信息与关联') && s.includes('未关联') && s.split('\n').length <= 24,
        { label: 'OriginalFileModal 80x24 zh' },
      );
      tty.assertHealthyScreen(modalNarrowZh, 80, 24, 'OriginalFileModal zh 80x24');

      tty.send('\u001b');
      const afterEscZh = await tty.waitFor(
        (s) => !s.includes('原文件信息与关联') && s.includes('资料列表') && s.includes('Linear Algebra Notes'),
        { label: 'Esc closes OriginalFileModal cleanly in zh' },
      );
      assert.ok(!afterEscZh.includes('原文件信息与关联'));

      // Switch in-place to English --ascii at 120x36 (no second PTY mount)
      tty.resize(120, 36);
      switchMountedLocale(host, 'en', true);
      const asciiSources = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('Linear Algebra Notes') && s.includes('Reread'),
        { label: 'ASCII SourcesView ready with Reread hint' },
      );
      tty.assertHealthyScreen(asciiSources, 120, 36, 'ASCII SourcesView 120x36');
      tty.assertAsciiPure(asciiSources, 'ASCII SourcesView 120x36');

      tty.send('O');
      const asciiModalWide = await tty.waitFor(
        (s) => s.includes('Original File') && s.includes('Not attached') && s.includes('MD'),
        { label: 'ASCII OriginalFileModal 120x36' },
      );
      tty.assertHealthyScreen(asciiModalWide, 120, 36, 'ASCII OriginalFileModal 120x36');
      tty.assertAsciiPure(asciiModalWide, 'ASCII OriginalFileModal 120x36');
      assert.ok(asciiModalWide.includes('Not attached'));

      tty.send('a');
      const asciiAttach = await tty.waitFor(
        (s) => s.includes('Original File Path:') && s.includes('Stores path reference only'),
        { label: 'ASCII OriginalFileModal attach sub-mode 120x36' },
      );
      tty.assertHealthyScreen(asciiAttach, 120, 36, 'ASCII OriginalFileModal attach 120x36');
      tty.assertAsciiPure(asciiAttach, 'ASCII OriginalFileModal attach 120x36');
      assert.ok(asciiAttach.includes('Stores path reference only'));

      tty.send('\t');
      const asciiAttachCopy = await tty.waitFor(
        (s) => s.includes('Copies file into library storage'),
        { label: 'ASCII Tab toggles mode to copy 120x36' },
      );
      tty.assertHealthyScreen(asciiAttachCopy, 120, 36, 'ASCII OriginalFileModal attach copy 120x36');
      tty.assertAsciiPure(asciiAttachCopy, 'ASCII OriginalFileModal attach copy 120x36');
      assert.ok(asciiAttachCopy.includes('Copies file into library storage'));

      tty.send('\u001b');
      const asciiBackInspect = await tty.waitFor(
        (s) => s.includes('Not attached') && !s.includes('Original File Path:'),
        { label: 'ASCII Esc returns from attach sub-mode to inspect' },
      );
      tty.assertAsciiPure(asciiBackInspect, 'ASCII OriginalFileModal inspect after Esc');
      assert.ok(!asciiBackInspect.includes('Original File Path:'));

      tty.send('\u001b');
      const asciiAfterEsc = await tty.waitFor(
        (s) => !s.includes('Original File') && s.includes('Linear Algebra Notes'),
        { label: 'ASCII Esc closes OriginalFileModal cleanly' },
      );
      tty.assertAsciiPure(asciiAfterEsc, 'ASCII SourcesView after Esc');
      assert.ok(!asciiAfterEsc.includes('Original File'));
    } finally {
      safeUnmount(inkInstance);
      tty.dispose();
      await host.dispose();
    }
  });

  test('11) Unit: formatSourcesCatalogMarkdown renders zh & en tables, pipe escaping, pinned/archived/active statuses, filters & empty list', () => {
    const sampleGroups = [
      {
        key: 'pdf:abc',
        title: 'OS | Lecture 01: Virtual Memory',
        format: 'pdf',
        pageCount: 24,
        sourceIds: ['s1', 's2'],
        pages: [
          { sourceId: 's1', page: 1, title: 'p1', chars: 500 },
          { sourceId: 's2', page: 2, title: 'p2', chars: 700 },
        ],
        courses: ['CS301', 'Systems | Core'],
        folder: 'Lectures | Week 1',
        cardCount: 14,
        chars: 1200,
        pinned: true,
        archived: false,
        originalStatus: 'verified',
        originalPath: '/docs/os-lec01.pdf',
      },
      {
        key: 'source:s3',
        title: 'Past Exam 2024',
        format: 'md',
        pageCount: 3,
        sourceIds: ['s3'],
        pages: [{ sourceId: 's3', page: 1, title: 'Past Exam 2024', chars: 900 }],
        courses: [],
        cardCount: 5,
        chars: 900,
        pinned: false,
        archived: true,
      },
      {
        key: 'source:s4',
        title: 'Lab 2 Guide',
        format: 'txt',
        pageCount: 2,
        sourceIds: ['s4'],
        pages: [{ sourceId: 's4', page: 1, title: 'Lab 2 Guide', chars: 450 }],
        courses: ['CS301'],
        folder: 'Labs',
        cardCount: 0,
        chars: 450,
        pinned: false,
        archived: false,
      },
    ];

    const zhMd = formatSourcesCatalogMarkdown({
      groups: sampleGroups,
      course: 'CS301 | OS',
      folderLabel: 'All | Filtered',
      lang: 'zh',
      generatedAt: '2026-11-22 22:20',
    });
    assert.ok(zhMd.includes('# StudyHub 学习资料目录与引用覆盖'), 'zh title missing');
    assert.ok(zhMd.includes('**生成日期**: 2026-11-22 22:20'), 'zh date missing');
    assert.ok(zhMd.includes('**课程筛选**: CS301 \\| OS'), 'zh escaped course filter missing');
    assert.ok(zhMd.includes('**文件夹筛选**: All \\| Filtered'), 'zh escaped folder filter missing');
    assert.ok(zhMd.includes('**资料总数**: 3'), 'zh total documents missing');
    assert.ok(zhMd.includes('**总页数**: 29'), 'zh total pages missing');
    assert.ok(zhMd.includes('**关联题目总数**: 19'), 'zh total cards missing');
    assert.ok(zhMd.includes('| # | 标题 | 课程 | 文件夹 | 页数 | 关联题 | 状态 |'), 'zh table header missing');
    assert.ok(
      zhMd.includes('| 1 | OS \\| Lecture 01: Virtual Memory | CS301, Systems \\| Core | Lectures \\| Week 1 | 24 | 14 | 已置顶 |'),
      'zh row 1 with pipe escaping and pinned status missing',
    );
    assert.ok(
      zhMd.includes('| 2 | Past Exam 2024 | 未分配 | 未归类 | 3 | 5 | 已归档 |'),
      'zh row 2 with unassigned/unfiled/archived status missing',
    );
    assert.ok(
      zhMd.includes('| 3 | Lab 2 Guide | CS301 | Labs | 2 | 0 | 正常 |'),
      'zh row 3 active status missing',
    );
    assert.ok(zhMd.includes('(PDF)'), 'breakdown format missing');
    assert.ok(zhMd.includes('原文件: verified `/docs/os-lec01.pdf`'), 'zh original file status missing');

    const enMd = formatSourcesCatalogMarkdown({
      groups: sampleGroups,
      course: 'CS301',
      folderLabel: 'Lectures',
      lang: 'en',
      generatedAt: new Date(2026, 10, 22, 9, 5),
    });
    assert.ok(enMd.includes('# StudyHub Materials Catalog & Citation Coverage'), 'en title missing');
    assert.ok(enMd.includes('**Date**: 2026-11-22 09:05'), 'en formatted Date missing');
    assert.ok(enMd.includes('**Course Filter**: CS301'), 'en course filter missing');
    assert.ok(enMd.includes('**Folder Filter**: Lectures'), 'en folder filter missing');
    assert.ok(enMd.includes('**Total Documents**: 3'), 'en total docs missing');
    assert.ok(enMd.includes('**Total Pages**: 29'), 'en total pages missing');
    assert.ok(enMd.includes('**Total Linked Cards**: 19'), 'en total cards missing');
    assert.ok(enMd.includes('| # | Title | Course(s) | Folder | Pages | Linked Cards | Status |'), 'en table header missing');
    assert.ok(enMd.includes('| 1 | OS \\| Lecture 01: Virtual Memory | CS301, Systems \\| Core | Lectures \\| Week 1 | 24 | 14 | Pinned |'));
    assert.ok(enMd.includes('| 2 | Past Exam 2024 | Unassigned | Unfiled | 3 | 5 | Archived |'));
    assert.ok(enMd.includes('| 3 | Lab 2 Guide | CS301 | Labs | 2 | 0 | Active |'));
    assert.ok(enMd.includes('Original: verified `/docs/os-lec01.pdf`'), 'en original file status missing');

    const emptyEn = formatSourcesCatalogMarkdown({
      groups: [],
      lang: 'en',
      generatedAt: '2026-11-22',
    });
    assert.ok(emptyEn.includes('**Total Documents**: 0'));
    assert.ok(emptyEn.includes('No materials match the current filters.'));
    assert.ok(!emptyEn.includes('| # | Title |'), 'empty list must not emit summary table');

    const emptyZh = formatSourcesCatalogMarkdown({
      groups: [],
      lang: 'zh',
      generatedAt: '2026-11-22',
    });
    assert.ok(emptyZh.includes('**资料总数**: 0'));
    assert.ok(!emptyZh.includes('| # | 标题 |'), 'empty zh list must not emit summary table');
  });

  test('12) Sources catalog export PTY E2E (120x36 zh all courses & --ascii en course filter): [f] -> [x] exports studyhub-sources-*.md (0 model calls)', async () => {
    const base = await temps.make('export-pty');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    let modelCalls = 0;
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
      eventDebounceMs: 25,
    });

    await addTextSource(
      host,
      'Operating Systems Ch1 Notes',
      '# Operating Systems\nVirtual memory and TLB lookup flow.',
      { courses: ['CS301'], format: 'md' },
    );
    await addTextSource(
      host,
      'Algorithms Lecture 1',
      '# Asymptotic Analysis\nBig-O and Master Theorem.',
      { courses: ['CS301'], format: 'md' },
    );
    await addTextSource(
      host,
      'Computer Networks | Routing Lab',
      '# Routing Lab\nLink-state vs distance-vector protocols.',
      { courses: ['CS302'], format: 'md' },
    );

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetTuiStore('zh', false, { loading: false });
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => safeUnmount(inkInst),
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
      await tty.waitFor(
        () => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot),
        { label: 'zh LibraryView ready' },
      );

      tty.send('2');
      await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Algorithms Lecture 1') &&
          s.includes('Operating Systems Ch1') &&
          useTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === '导出目录'),
        { timeoutMs: 10_000, label: 'zh SourcesView rendered with CS301 source & [x] hint' },
      );
      assert.ok(useTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === '导出目录'));

      tty.send('f');
      const srcScreen = await tty.waitFor(
        (s) =>
          s.includes('全部课程') &&
          s.includes('Operating Systems Ch1') &&
          s.includes('Algorithms Lecture 1') &&
          s.includes('Computer Networks |'),
        { timeoutMs: 10_000, label: 'zh SourcesView All Courses showing all 3 sources' },
      );
      tty.assertHealthyScreen(srcScreen, 120, 36, 'zh SourcesView 120x36');
      assert.ok(srcScreen.includes('全部课程'));

      const backupsDir = join(libraryRoot, 'backups');
      const todayYmd = todayLocalYmd();
      tty.send('x');
      const afterExport = await tty.waitFor(
        (s) =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出 3 份资料目录') && toast.text.includes('studyhub-sources-')) &&
          s.includes('已导出 3 份资料目录'),
        { timeoutMs: 10_000, label: 'zh SourcesView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh SourcesView after [x] export');
      const zhExport = await findExportedBackupFile(backupsDir, 'studyhub-sources', 'md', todayYmd);
      assert.ok(zhExport, `expected studyhub-sources-${todayYmd}-HHmmss.md in ${backupsDir}`);
      assert.equal(fs.existsSync(zhExport.path), true);
      assert.equal(afterExport.includes('\uFFFD'), false, 'No replacement char U+FFFD leaked');

      const exportedMd = await readFile(zhExport.path, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub 学习资料目录与引用覆盖'), 'exported MD must have zh heading');
      assert.ok(exportedMd.includes('| # | 标题 | 课程 | 文件夹 | 页数 | 关联题 | 状态 |'), 'exported MD must have table header');
      assert.ok(exportedMd.includes('Operating Systems Ch1 Notes'), 'exported MD must include source 1 title');
      assert.ok(exportedMd.includes('Computer Networks \\| Routing Lab'), 'exported MD must escape pipe in source 3 title');
      assert.ok(exportedMd.includes('**资料总数**: 3'), 'exported MD must include document count');
      assert.ok(!exportedMd.includes('**课程筛选**:'), 'exported MD should omit course filter when All Courses active');

      // Switch in-place to --ascii en and filter to CS301 before exporting again (no second PTY mount)
      await rm(backupsDir, { recursive: true, force: true });
      switchMountedLocale(host, 'en', true);
      await tty.waitFor(
        () => useTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === 'Export MD'),
        { timeoutMs: 10_000, label: 'en SourcesView [x] Export MD hint' },
      );
      assert.ok(useTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === 'Export MD'));

      tty.send('f');
      const enFilteredScreen = await tty.waitFor(
        (s) =>
          !s.includes('All Courses') &&
          s.includes('CS301') &&
          s.includes('Operating Systems Ch1') &&
          s.includes('Algorithms Lecture 1') &&
          !s.includes('Computer Networks |'),
        { timeoutMs: 10_000, label: 'en SourcesView 120x36 filtered to CS301' },
      );
      tty.assertHealthyScreen(enFilteredScreen, 120, 36, 'en SourcesView 120x36');
      tty.assertAsciiPure(enFilteredScreen, 'en SourcesView 120x36');

      tty.send('x');
      const afterExportEn = await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported 2 source(s) ->') &&
                toast.text.includes('studyhub-sources-'),
            ),
        { timeoutMs: 10_000, label: 'en SourcesView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExportEn, 120, 36, 'en SourcesView after [x] export 120x36');
      tty.assertAsciiPure(afterExportEn, 'en SourcesView after [x] export 120x36');
      const enExport = await findExportedBackupFile(backupsDir, 'studyhub-sources', 'md', todayYmd);
      assert.ok(enExport, `expected studyhub-sources-${todayYmd}-HHmmss.md in ${backupsDir}`);
      assert.equal(fs.existsSync(enExport.path), true);
      assert.ok(
        useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Exported 2 source(s) ->')),
      );

      const exportedEnMd = await readFile(enExport.path, 'utf8');
      assert.ok(exportedEnMd.includes('# StudyHub Materials Catalog & Citation Coverage'), 'exported MD must have en heading');
      assert.ok(exportedEnMd.includes('| # | Title | Course(s) | Folder | Pages | Linked Cards | Status |'), 'exported MD must have en table header');
      assert.ok(exportedEnMd.includes('Operating Systems Ch1 Notes'), 'exported MD must include source 1');
      assert.ok(exportedEnMd.includes('Algorithms Lecture 1'), 'exported MD must include source 2');
      assert.ok(exportedEnMd.includes('**Course Filter**: CS301'), 'exported MD must include active course filter');
      assert.ok(exportedEnMd.includes('**Total Documents**: 2'), 'exported MD must include total documents');
      assert.equal(modelCalls, 0, 'SourcesView [x] export must invoke 0 model calls');
    } finally {
      safeUnmount(inkInst);
      inkInst = null;
      await host.dispose();
      tty.dispose();
    }
  });
});
