// Consolidated Skeleton & Outline Domain Suite
// Merges: round38-skeleton-e2e, round45-outline-update, round50-skel-diagrams, round67-skeleton-export
// node --test tests/domain-skeleton.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

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

const { formatSkeletonMarkdown, todayLocalYmd } = await tsImport(
  '../src/views/skeleton/SkeletonView.tsx',
  import.meta.url,
);
assert.equal(typeof formatSkeletonMarkdown, 'function', 'SkeletonView must export formatSkeletonMarkdown');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-skeleton-');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
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

after(async () => {
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

async function seedDeckWithCard(host, { title, course, topic, prompt }) {
  const impRes = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        {
          kind: 'flashcard',
          topic,
          prompt,
          answer: 'Sample answer',
          explanation: 'Sample explanation',
        },
      ],
    }),
    folder: course,
  });
  assert.equal(impRes.ok, true, `deck.import failed: ${impRes.error?.message || ''}`);
  const snap = await host.call('snapshot', {});
  assert.equal(snap.ok, true, `snapshot failed: ${snap.error?.message || ''}`);
  const deckSummary = (snap.value?.decks ?? []).find((d) => d.title === title);
  assert.ok(deckSummary?.id, 'snapshot must include imported deck');
  const deckRes = await host.call('deck.get', { id: deckSummary.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message || ''}`);
  const cardId = deckRes.value?.cards?.[0]?.id;
  assert.ok(cardId, 'deck.get must return created card id');
  return { deckId: deckSummary.id, cardId, topic };
}

async function seedDeckWithCards(host, { title, course, topic, prompts }) {
  const impRes = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: prompts.map((prompt, idx) => ({
        kind: 'flashcard',
        topic,
        prompt,
        answer: `Answer ${idx + 1}`,
        explanation: `Explanation ${idx + 1}`,
      })),
    }),
    folder: course,
  });
  assert.equal(impRes.ok, true, `deck.import failed: ${impRes.error?.message || ''}`);
  const snap = await host.call('snapshot', {});
  assert.equal(snap.ok, true, `snapshot failed: ${snap.error?.message || ''}`);
  const deckSummary = (snap.value?.decks ?? []).find((d) => d.title === title);
  assert.ok(deckSummary?.id, 'snapshot must include imported deck');
  const deckRes = await host.call('deck.get', { id: deckSummary.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message || ''}`);
  const cardIds = (deckRes.value?.cards ?? []).map((c) => c.id).filter(Boolean);
  assert.ok(cardIds.length === prompts.length, 'deck.get must return all created card ids');
  return { deckId: deckSummary.id, cardIds, topic };
}

async function saveTestSkeleton(host, { title, deckId, cardId, topic }) {
  const res = await host.call('skeleton.save', {
    title,
    overview: `${title} overview`,
    scope: [{ deckId, topic }],
    nodes: [
      { id: 'n-root', term: 'Root Concept', meaning: 'Top-level core concept', cards: [cardId] },
      { id: 'n-child', term: 'Child Concept', meaning: 'Detailed sub-concept', parent: 'n-root', cards: [] },
    ],
    relations: [{ from: 'n-root', to: 'n-child', type: 'part-of', note: 'Contains sub-concept' }],
  });
  assert.equal(res.ok, true, `skeleton.save failed: ${res.error?.message || ''}`);
  assert.ok(res.value?.id, 'skeleton.save must return skeleton id');
  return res.value;
}

describe('Round 38: SkeletonView safe deletion ([D] + ConfirmDialog) E2E', () => {
  test('1) createTuiHost integration: skeleton.save -> snapshot/skeleton.get -> skeleton.delete -> removed & unknown id error', async () => {
    const base = await temps.make('r38-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { deckId, cardId, topic } = await seedDeckWithCard(host, {
        title: 'Algorithms Deck',
        course: 'CS101',
        topic: 'Graphs',
        prompt: 'What is BFS?',
      });

      const saved = await saveTestSkeleton(host, {
        title: 'CS101 Graph Skeleton',
        deckId,
        cardId,
        topic,
      });

      const snap1 = await host.call('snapshot', {});
      assert.equal(snap1.ok, true);
      assert.ok(
        Array.isArray(snap1.value?.skeletons) && snap1.value.skeletons.some((s) => s.id === saved.id),
        'snapshot.skeletons must include newly saved skeleton',
      );

      const getRes = await host.call('skeleton.get', { id: saved.id });
      assert.equal(getRes.ok, true, `skeleton.get failed: ${getRes.error?.message || ''}`);
      assert.equal(getRes.value?.id, saved.id);
      assert.equal(getRes.value?.title, 'CS101 Graph Skeleton');
      assert.equal(getRes.value?.overview, 'CS101 Graph Skeleton overview');
      assert.equal(getRes.value?.nodes?.length, 2);
      assert.equal(getRes.value?.relations?.length, 1);
      assert.equal(getRes.value?.nodes?.[0]?.term, 'Root Concept');
      assert.equal(getRes.value?.nodes?.[1]?.term, 'Child Concept');

      const delRes = await host.call('skeleton.delete', { id: saved.id });
      assert.equal(delRes.ok, true, `skeleton.delete failed: ${delRes.error?.message || ''}`);
      assert.equal(delRes.value?.deleted, saved.id);

      const snap2 = await host.call('snapshot', {});
      assert.equal(snap2.ok, true);
      assert.ok(
        !(snap2.value?.skeletons ?? []).some((s) => s.id === saved.id),
        'deleted skeleton must be removed from snapshot.skeletons',
      );
      assert.ok(
        (snap2.value?.decks ?? []).some((d) => d.id === deckId),
        'decks must remain untouched after skeleton.delete',
      );

      const getAfter = await host.call('skeleton.get', { id: saved.id });
      assert.equal(getAfter.ok, false, 'skeleton.get on deleted id must fail');

      const unknownDel = await host.call('skeleton.delete', { id: 'skel_nonexistent_id' });
      assert.equal(unknownDel.ok, false, 'skeleton.delete on unknown id must fail cleanly');
      assert.ok(unknownDel.error?.message, 'unknown skeleton.delete must return an error message');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SkeletonView [D] ConfirmDialog cancel (n/Esc) & confirm (y) at 120x36 & 80x24', async () => {
    const base = await temps.make('r38-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false, { loading: true });

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const seedZh = await seedDeckWithCard(host, {
      title: '操作系统题组',
      course: 'OS202',
      topic: '进程调度',
      prompt: '什么是时间片轮转？',
    });
    const skelZh = await saveTestSkeleton(host, {
      title: 'OS 知识骨架',
      ...seedZh,
    });
    const readSavedSkeleton = async () => {
      const manifest = JSON.parse(await readFile(join(libraryRoot, 'study-workspace.json'), 'utf8'));
      const rows = JSON.parse(await readFile(join(libraryRoot, 'shards', manifest.shards.skeletons), 'utf8'));
      return rows.find(row => row.id === skelZh.id);
    };

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

      await tty.waitFor(() => useDistTuiStore.getState().page === 'library' && Boolean(useDistTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready (zh)',
      });
      tty.send('8');

      const skelScreen = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'skeleton' &&
          s.includes('OS 知识骨架') &&
          s.includes('Root Concept') &&
          s.includes('D  删除'),
        { label: 'SkeletonView rendered with saved skeleton (zh)' },
      );
      tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView 120x36 zh');

      // Open ConfirmDialog via D, then cancel via 'n'
      tty.send('D');
      const dialogZh = await tty.waitFor(
        (s) => s.includes('确认删除知识骨架') && s.includes('图表') && s.includes('不受影响'),
        { label: 'ConfirmDialog opened via D (zh)' },
      );
      tty.assertHealthyScreen(dialogZh, 120, 36, 'ConfirmDialog 120x36 zh');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认删除知识骨架') && s.includes('OS 知识骨架') && s.includes('Root Concept'),
        { label: 'ConfirmDialog cancelled with n (zh)' },
      );
      const afterCancelN = await host.call('skeleton.get', { id: skelZh.id });
      assert.equal(afterCancelN.ok, true, 'Skeleton must remain intact after cancelling with n');

      // Open ConfirmDialog via D, then cancel via Esc
      tty.send('D');
      await tty.waitFor((s) => s.includes('确认删除知识骨架'), { label: 'ConfirmDialog re-opened for Esc (zh)' });
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('确认删除知识骨架') && s.includes('OS 知识骨架'),
        { label: 'ConfirmDialog cancelled with Esc (zh)' },
      );
      const afterCancelEsc = await host.call('skeleton.get', { id: skelZh.id });
      assert.equal(afterCancelEsc.ok, true, 'Skeleton must remain intact after cancelling with Esc');
      assert.equal((await readSavedSkeleton())?.title, skelZh.title, 'both cancellations preserve the saved file');

      // Resize to 80x24 and confirm ConfirmDialog + deletion via D -> y
      tty.resize(80, 24);
      const narrowZh = await tty.waitFor(
        (s) => s.includes('OS 知识骨架') && s.split('\n').length <= 24,
        { label: 'SkeletonView 80x24 zh' },
      );
      tty.assertHealthyScreen(narrowZh, 80, 24, 'SkeletonView 80x24 zh');

      tty.send('D');
      const dialogNarrowZh = await tty.waitFor(
        (s) => s.includes('确认删除知识骨架'),
        { label: 'ConfirmDialog 80x24 zh' },
      );
      tty.assertHealthyScreen(dialogNarrowZh, 80, 24, 'ConfirmDialog 80x24 zh');

      const previousNotices = new Set(useDistTuiStore.getState().toastHistory.map(item => item.id));
      tty.send('y');
      await tty.waitFor(
        (s) =>
          !s.includes('确认删除知识骨架') &&
          !s.includes('Root Concept') &&
          s.includes('课程主题预览') &&
          useDistTuiStore.getState().toastHistory.some(item => !previousNotices.has(item.id) &&
            item.tone === 'success' && item.text.includes(`已删除知识骨架「${skelZh.title}」`)),
        { label: 'Skeleton deleted via D -> y (zh)' },
      );
      const afterDeleteZh = await host.call('skeleton.get', { id: skelZh.id });
      assert.equal(afterDeleteZh.ok, false, 'Skeleton must be deleted after D -> y');
      assert.equal(await readSavedSkeleton(), undefined, 'confirmation removed this skeleton from the committed file');
      const snapAfterDel = await host.call('snapshot', {});
      assert.equal(snapAfterDel.ok, true);
      assert.equal((snapAfterDel.value?.skeletons ?? []).some((s) => s.id === skelZh.id), false);
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 45: ReaderOutlineDrawer [X] clear & WorkspaceTab [a] update.preferences', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let fetchCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'sources', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    resetDistStore(language, asciiMode);
    await saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    host.setLanguage(language);
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
        autoLaunchpad: false,
        onExit: () => inkInstance?.unmount(),
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
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    return tty;
  }

  before(async () => {
    boxDir = await temps.make('r45-main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during Round 45 tests');
      },
    });
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    await unmountActiveApp();
    await host?.dispose();
  });

  test('1) createTuiHost integration: materials.outline.save -> clear & update.preferences autoCheck toggle (0 network calls)', async () => {
    const docPath = join(boxDir, 'r45-host-outline.md');
    await writeFile(
      docPath,
      [
        '# Heading One Alpha',
        '',
        'First section details for Round 45 outline clear verification.',
        '',
        '# Heading Two Beta',
        '',
        'Second section details for Round 45 outline clear verification.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: docPath,
      title: 'R45 Host Outline Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;

    const saved = await host.call('materials.outline.save', {
      documentId: docId,
      revision: rev,
      mode: 'chapters',
      entries: [
        { title: 'Saved AI Chapter 1', level: 1, startBlock: 0 },
        { title: 'Saved AI Chapter 2', level: 1, startBlock: 2 },
      ],
    });
    assert.equal(saved.ok, true, `outline.save failed: ${saved.error?.message || ''}`);
    assert.equal(saved.value.saved, true);
    assert.equal(saved.value.outline?.entries?.length, 2);

    const docBefore = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docBefore.ok, true);
    assert.equal(docBefore.value.outline?.mode, 'chapters');
    assert.equal(docBefore.value.outline?.entries?.length, 2);
    assert.equal(docBefore.value.outline?.entries?.[0]?.title, 'Saved AI Chapter 1');
    assert.equal(docBefore.value.outline?.entries?.[1]?.title, 'Saved AI Chapter 2');
    assert.equal(docBefore.value.outline?.entries?.[0]?.startBlock, 0);
    assert.equal(docBefore.value.outline?.entries?.[1]?.startBlock, 2);

    const cleared = await host.call('materials.outline.clear', { documentId: docId, revision: rev });
    assert.equal(cleared.ok, true, `outline.clear failed: ${cleared.error?.message || ''}`);
    assert.equal(cleared.value.cleared, true);
    assert.equal(cleared.value.hadSegmentation, false);

    const clearedAgain = await host.call('materials.outline.clear', { documentId: docId, revision: rev });
    assert.equal(clearedAgain.ok, true);
    assert.equal(clearedAgain.value.cleared, false);
    assert.equal(clearedAgain.value.hadSegmentation, false);

    const docAfter = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docAfter.ok, true);
    assert.equal(docAfter.value.outline, undefined);
    assert.equal(docAfter.value.title, 'R45 Host Outline Doc');

    // update.preferences { autoCheck: false } -> { autoCheck: true } (0 network calls)
    const prefInit = await host.call('update.preferences', {});
    assert.equal(prefInit.ok, true, `update.preferences read failed: ${prefInit.error?.message || ''}`);
    assert.equal(prefInit.value.autoCheck, true);

    const prefOff = await host.call('update.preferences', { autoCheck: false });
    assert.equal(prefOff.ok, true, `update.preferences false failed: ${prefOff.error?.message || ''}`);
    assert.equal(prefOff.value.autoCheck, false);

    const prefReadOff = await host.call('update.preferences', {});
    assert.equal(prefReadOff.ok, true);
    assert.equal(prefReadOff.value.autoCheck, false);

    const prefOn = await host.call('update.preferences', { autoCheck: true });
    assert.equal(prefOn.ok, true, `update.preferences true failed: ${prefOn.error?.message || ''}`);
    assert.equal(prefOn.value.autoCheck, true);

    assert.equal(fetchCalls, 0, 'update.preferences and outline operations must trigger 0 network calls');
  });

  test('2) PTY E2E: ReaderOutlineDrawer [X] ConfirmDialog cancel (n/Esc)/confirm (y) & WorkspaceTab [a] toggle at 120x36 & 80x24', async () => {
    const e2ePath = join(boxDir, 'r45-e2e-outline.md');
    await writeFile(
      e2ePath,
      [
        '# Fallback Alpha',
        '',
        'Alpha body paragraph for Round 45 reader outline verification.',
        '',
        '# Fallback Beta',
        '',
        'Beta body paragraph for Round 45 reader outline verification.',
        '',
      ].join('\n'),
      'utf8',
    );
    const imp = await host.call('materials.document.import', {
      path: e2ePath,
      title: 'R45 E2E Outline Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import e2e doc failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;

    const saveOutline = async () => {
      const res = await host.call('materials.outline.save', {
        documentId: docId,
        revision: rev,
        mode: 'chapters',
        entries: [
          { title: 'Custom Chapter One', level: 1, startBlock: 0 },
          { title: 'Custom Chapter Two', level: 1, startBlock: 2 },
        ],
      });
      assert.equal(res.ok, true, `saveOutline failed: ${res.error?.message || ''}`);
    };

    // 2a) Default zh mode across 120x36 & 80x24
    await saveOutline();
    await host.call('update.preferences', { autoCheck: true });

    const ttyZh = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await ttyZh.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered (zh)' },
    );

    ttyZh.send('/');
    await ttyZh.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar (zh)' });
    await ttyZh.flush(20);
    ttyZh.send('R45 E2E Outline');
    await ttyZh.waitFor((s) => s.includes('R45 E2E Outline'), { label: 'Filter typed (zh)' });
    await ttyZh.flush(20);
    ttyZh.send('\r');
    await ttyZh.waitFor(
      (s) => !useDistTuiStore.getState().inputCaptured && s.includes('R45 E2E Outline Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R45 E2E Outline Doc selected (zh)' },
    );
    await ttyZh.flush(20);

    // Open DocumentReader -> ReaderOutlineDrawer ('O')
    ttyZh.send('\r');
    await ttyZh.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && s.includes('Alpha body paragraph') && s.includes('O  目录'),
      { timeoutMs: 10_000, label: 'DocumentReader opened (zh)' },
    );
    await ttyZh.flush();

    ttyZh.send('O');
    const outlineZh = await ttyZh.waitFor(
      (s) => s.includes('文档目录大纲') && s.includes('Custom Chapter One') && s.includes('AI 目录'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer opened with AI outline (zh)' },
    );
    ttyZh.assertHealthyScreen(outlineZh, 120, 36, 'ReaderOutlineDrawer 120x36 zh');

    // Press uppercase 'X' -> ConfirmDialog opens, then cancel with 'n'
    ttyZh.send('X');
    const clearConfirmZh = await ttyZh.waitFor(
      (s) => s.includes('清除自定义 AI 目录') && s.includes('清除目录'),
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer clear ConfirmDialog (zh)' },
    );
    ttyZh.assertHealthyScreen(clearConfirmZh, 120, 36, 'Outline clear ConfirmDialog 120x36 zh');

    ttyZh.send('n');
    await ttyZh.waitFor(
      (s) => !s.includes('清除自定义 AI 目录') && s.includes('Custom Chapter One'),
      { timeoutMs: 5_000, label: 'Outline clear ConfirmDialog cancelled (zh)' },
    );

    // Also test Esc cancel on clear outline ConfirmDialog
    ttyZh.send('X');
    await ttyZh.waitFor((s) => s.includes('清除自定义 AI 目录'), { label: 'Outline clear ConfirmDialog reopened for Esc (zh)' });
    ttyZh.send('\x1b');
    await ttyZh.waitFor(
      (s) => !s.includes('清除自定义 AI 目录') && s.includes('Custom Chapter One'),
      { timeoutMs: 5_000, label: 'Outline clear ConfirmDialog cancelled via Esc (zh)' },
    );
    const docAfterEscCancel = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docAfterEscCancel.value?.outline?.entries?.length, 2, 'Outline must stay intact after Esc cancel');

    // Resize to 80x24 and confirm clear with 'X' -> 'y'
    ttyZh.resize(80, 24);
    const outlineZhNarrow = await ttyZh.waitFor(
      (s) => s.includes('Custom Chapter One') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer resized 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(outlineZhNarrow, 80, 24, 'ReaderOutlineDrawer 80x24 zh');

    ttyZh.send('X');
    const clearConfirmZhNarrow = await ttyZh.waitFor(
      (s) => s.includes('清除自定义 AI 目录') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer clear ConfirmDialog 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(clearConfirmZhNarrow, 80, 24, 'Outline clear ConfirmDialog 80x24 zh');

    ttyZh.send('y');
    const afterClearZh = await ttyZh.waitFor(
      (s) =>
        !s.includes('清除目录') &&
        s.includes('Fallback Alpha') &&
        s.includes('标题提取') &&
        s.includes('已清除自定义 AI 目录'),
      { timeoutMs: 8_000, label: 'Outline cleared and reverted to headings (zh)' },
    );
    ttyZh.assertHealthyScreen(afterClearZh, 80, 24, 'ReaderOutlineDrawer after clear 80x24 zh');

    const docAfterZhClear = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docAfterZhClear.value?.outline, undefined);

    // Close drawer -> close reader -> switch to Settings (',') -> WorkspaceTab ('2')
    ttyZh.send('\x1b');
    await ttyZh.waitFor((s) => !s.includes('文档目录大纲'), { label: 'Outline drawer closed (zh)' });
    ttyZh.send('\x1b');
    await ttyZh.waitFor((s) => s.includes('资料列表'), { label: 'Reader closed (zh)' });

    ttyZh.send(',');
    await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), { label: 'SettingsView (zh)' });
    ttyZh.send('2');
    const wsZhNarrow = await ttyZh.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('已开启 ✓') && s.includes('[a]'),
      { timeoutMs: 8_000, label: 'WorkspaceTab 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhNarrow, 80, 24, 'WorkspaceTab 80x24 zh');

    // Toggle [a] off at 80x24 -> on at 120x36
    ttyZh.send('a');
    const wsZhOff = await ttyZh.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('已关闭') && s.includes('已关闭自动检查更新'),
      { timeoutMs: 5_000, label: 'Auto update toggled off (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhOff, 80, 24, 'WorkspaceTab autoCheck off 80x24 zh');
    assert.equal((await host.call('update.preferences', {})).value?.autoCheck, false);

    ttyZh.resize(120, 36);
    await ttyZh.waitFor((s) => s.includes('自动检查更新:') && s.includes('已关闭'), { label: 'WorkspaceTab 120x36 (zh)' });
    ttyZh.send('a');
    const wsZhOn = await ttyZh.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('已开启 ✓') && s.includes('已开启自动检查更新'),
      { timeoutMs: 5_000, label: 'Auto update toggled on (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhOn, 120, 36, 'WorkspaceTab autoCheck on 120x36 zh');
    assert.equal((await host.call('update.preferences', {})).value?.autoCheck, true);
    assert.equal(fetchCalls, 0, 'PTY E2E must trigger 0 network calls');
  });
});

describe('Round 50: SkeletonView Interactive Diagrams Manager (skeleton.diagram.*)', () => {
  test('1) createTuiHost integration: attach, unchanged re-attach, list, get, reject non-HTML, remove', async () => {
    const base = await temps.make('r50-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const seed = await seedDeckWithCard(host, {
        title: 'Algorithms Deck',
        course: 'CS101',
        topic: 'Graphs',
        prompt: 'What is BFS?',
      });
      const skel = await saveTestSkeleton(host, {
        title: 'CS101 Graph Skeleton',
        ...seed,
      });

      const htmlPath = join(libraryRoot, 'bfs-flow.html');
      await writeFile(
        htmlPath,
        '<!doctype html><html><head><title>Graph Traversal Flow</title></head><body><h1>BFS vs DFS</h1><p>Queue vs Stack</p></body></html>',
        'utf8',
      );

      const attach1 = await host.call('skeleton.diagram.attach', {
        id: skel.id,
        path: htmlPath,
      });
      assert.equal(attach1.ok, true, `skeleton.diagram.attach failed: ${attach1.error?.message || ''}`);
      assert.equal(attach1.value?.unchanged, false);
      assert.equal(attach1.value?.diagram?.title, 'Graph Traversal Flow');
      const diagramId = attach1.value?.diagram?.id;
      assert.ok(diagramId, 'attach must return diagram id');

      // Re-attach same file -> unchanged: true
      const attach2 = await host.call('skeleton.diagram.attach', {
        id: skel.id,
        path: htmlPath,
      });
      assert.equal(attach2.ok, true);
      assert.equal(attach2.value?.unchanged, true);
      assert.equal(attach2.value?.diagram?.id, diagramId);

      // List diagrams
      const list1 = await host.call('skeleton.diagram.list', { id: skel.id });
      assert.equal(list1.ok, true);
      assert.equal(list1.value?.diagrams?.length, 1);
      assert.equal(list1.value.diagrams[0].id, diagramId);
      assert.equal(list1.value.diagrams[0].title, 'Graph Traversal Flow');
      assert.equal(list1.value.diagrams[0].stale, false);
      assert.ok(typeof list1.value.diagrams[0].sha256 === 'string' && list1.value.diagrams[0].sha256.length > 0);
      assert.ok((list1.value.diagrams[0].bytes ?? 0) > 0);

      // Get diagram content + file
      const got = await host.call('skeleton.diagram.get', { id: skel.id, diagramId });
      assert.equal(got.ok, true, `skeleton.diagram.get failed: ${got.error?.message || ''}`);
      assert.ok(got.value?.html?.includes('BFS vs DFS'));
      assert.ok(got.value?.html?.includes('Queue vs Stack'));
      assert.ok(got.value?.file?.endsWith('.html'));
      assert.equal(typeof got.value?.html, 'string');

      // Reject non-HTML file cleanly
      const txtPath = join(libraryRoot, 'not-html.txt');
      await writeFile(txtPath, 'Plain text file, not HTML', 'utf8');
      const rejectRes = await host.call('skeleton.diagram.attach', {
        id: skel.id,
        path: txtPath,
      });
      assert.equal(rejectRes.ok, false, 'non-HTML file must be rejected');
      assert.ok(rejectRes.error?.message, 'non-HTML rejection must include error message');

      // Remove diagram -> list empty
      const remRes = await host.call('skeleton.diagram.remove', { id: skel.id, diagramId });
      assert.equal(remRes.ok, true, `skeleton.diagram.remove failed: ${remRes.error?.message || ''}`);
      assert.equal(remRes.value?.removed, diagramId);

      const list2 = await host.call('skeleton.diagram.list', { id: skel.id });
      assert.equal(list2.ok, true);
      assert.equal(list2.value?.diagrams?.length, 0);

      // Missing diagram removal fails cleanly
      const remMissing = await host.call('skeleton.diagram.remove', { id: skel.id, diagramId });
      assert.equal(remMissing.ok, false, 'removing already-removed diagram must fail cleanly');
      assert.ok(remMissing.error?.message);

      // Clean up skeleton still intact
      const skelAfter = await host.call('skeleton.get', { id: skel.id });
      assert.equal(skelAfter.ok, true);
      assert.equal(skelAfter.value?.title, 'CS101 Graph Skeleton');
      assert.equal(skelAfter.value?.nodes?.length, 2);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SkeletonView [M] SkeletonDiagramsModal (inspect, [a] attach, [d] remove) at 120x36 & 80x24', async () => {
    const base = await temps.make('r50-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false, { loading: true });

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const seedZh = await seedDeckWithCard(host, {
      title: '操作系统题组',
      course: 'OS202',
      topic: '进程调度',
      prompt: '什么是时间片轮转？',
    });
    const skelZh = await saveTestSkeleton(host, {
      title: 'OS 知识骨架',
      ...seedZh,
    });

    const zhHtmlPath = join(libraryRoot, 'os-sched.html');
    await writeFile(
      zhHtmlPath,
      '<!doctype html><html><head><title>进程调度全景图</title></head><body><h1>时间片轮转</h1><p>就绪队列与上下文切换</p></body></html>',
      'utf8',
    );
    const zhHtml2 = join(libraryRoot, 'os-paging.html');
    await writeFile(
      zhHtml2,
      '<!doctype html><html><head><title>虚拟内存分页图</title></head><body><h1>页表映射</h1><p>TLB 与缺页中断</p></body></html>',
      'utf8',
    );
    const zhAttach = await host.call('skeleton.diagram.attach', { id: skelZh.id, path: zhHtmlPath });
    assert.equal(zhAttach.ok, true);

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

      await tty.waitFor(() => useDistTuiStore.getState().page === 'library' && Boolean(useDistTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready (zh)',
      });
      tty.send('8');

      const skelScreen = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'skeleton' &&
          s.includes('OS 知识骨架') &&
          s.includes('互动图(1)'),
        { label: 'SkeletonView rendered with diagram badge/hint (zh)' },
      );
      tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView 120x36 zh');

      // Open SkeletonDiagramsModal via [M]
      tty.send('M');
      const modalZh = await tty.waitFor(
        (s) =>
          s.includes('互动图表 (1/8)') &&
          s.includes('进程调度全景图') &&
          s.includes('SHA256:') &&
          s.includes('时间片轮转'),
        { label: 'SkeletonDiagramsModal opened with diagram details (zh)' },
      );
      tty.assertHealthyScreen(modalZh, 120, 36, 'SkeletonDiagramsModal 120x36 zh');

      // Enter inspect sub-view and return via Esc
      tty.send('\r');
      const inspectZh = await tty.waitFor(
        (s) => s.includes('图表详情') && s.includes('就绪队列与上下文切换'),
        { label: 'Inspect sub-view opened via Enter (zh)' },
      );
      tty.assertHealthyScreen(inspectZh, 120, 36, 'SkeletonDiagramsModal inspect 120x36 zh');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => s.includes('互动图表 (1/8)') && !s.includes('图表详情:'),
        { label: 'Returned to list from inspect via Esc (zh)' },
      );

      // Test [a] Attach sub-mode in 120x36
      tty.send('a');
      const attachModalZh = await tty.waitFor(
        (s) => s.includes('挂载本地 HTML 互动图') && s.includes('UTF-8 HTML (<= 5 MB)'),
        { label: 'Attach mode opened (zh)' },
      );
      tty.assertHealthyScreen(attachModalZh, 120, 36, 'SkeletonDiagramsModal attach mode 120x36 zh');

      tty.send(zhHtml2);
      await tty.waitFor((s) => s.includes('os-paging.html'), {
        label: 'HTML path typed into TextInput (zh)',
      });
      tty.send('\r');
      const afterAttachZh = await tty.waitFor(
        (s) => s.includes('互动图表 (2/8)') && s.includes('虚拟内存分页图') && s.includes('TLB 与缺页中断'),
        { label: 'Diagram attached via [a] (zh)' },
      );
      tty.assertHealthyScreen(afterAttachZh, 120, 36, 'SkeletonDiagramsModal after attach 120x36 zh');
      const listAfterAttach = await host.call('skeleton.diagram.list', { id: skelZh.id });
      assert.equal(listAfterAttach.value?.diagrams?.length, 2, 'Diagram count must increase to 2 after attach');
      assert.ok(listAfterAttach.value?.diagrams?.some((d) => d.title === '虚拟内存分页图'), 'Attached diagram title must be listed');

      // Resize to 80x24 and test [d] ConfirmDialog cancel (n) & confirm (y)
      tty.resize(80, 24);
      const narrowModalZh = await tty.waitFor(
        (s) => s.includes('互动图表 (2/8)') && s.includes('虚拟内存分页图') && s.split('\n').length <= 24,
        { label: 'SkeletonDiagramsModal 80x24 zh' },
      );
      tty.assertHealthyScreen(narrowModalZh, 80, 24, 'SkeletonDiagramsModal 80x24 zh');

      tty.send('d');
      const dialogZh = await tty.waitFor(
        (s) => s.includes('确认移除互动图表') && s.includes('虚拟内存分页图'),
        { label: 'ConfirmDialog opened via d (zh)' },
      );
      tty.assertHealthyScreen(dialogZh, 80, 24, 'Remove Diagram ConfirmDialog 80x24 zh');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认移除互动图表') && s.includes('互动图表 (2/8)'),
        { label: 'ConfirmDialog cancelled via n (zh)' },
      );
      const afterCancel = await host.call('skeleton.diagram.list', { id: skelZh.id });
      assert.equal(afterCancel.value?.diagrams?.length, 2, 'Diagrams must remain 2 after cancelling with n');

      useDistTuiStore.setState({ toasts: [] });
      tty.send('d');
      await tty.waitFor((s) => s.includes('确认移除互动图表'), { label: 'ConfirmDialog re-opened for first remove (zh)' });
      tty.send('y');
      const afterFirstRemove = await tty.waitFor(
        (s) =>
          !s.includes('确认移除互动图表') &&
          s.includes('互动图表 (1/8)') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已移除图表')),
        { label: 'First diagram removed via d -> y (zh)' },
      );
      tty.assertHealthyScreen(afterFirstRemove, 80, 24, 'SkeletonDiagramsModal 1/8 80x24 zh');
      const listAfterFirst = await host.call('skeleton.diagram.list', { id: skelZh.id });
      assert.equal(listAfterFirst.value?.diagrams?.length, 1, 'Diagram count must drop to 1 after first removal');

      // Remove remaining diagram -> empty state (0/8)
      tty.send('d');
      await tty.waitFor((s) => s.includes('确认移除互动图表'), { label: 'ConfirmDialog re-opened for second remove (zh)' });
      tty.send('y');
      const afterRemoveZh = await tty.waitFor(
        (s) =>
          !s.includes('确认移除互动图表') &&
          s.includes('尚未挂载互动图表') &&
          s.includes('互动图表 (0/8)'),
        { label: 'Second diagram removed via d -> y (zh)' },
      );
      tty.assertHealthyScreen(afterRemoveZh, 80, 24, 'SkeletonDiagramsModal empty 80x24 zh');

      const listAfterRemove = await host.call('skeleton.diagram.list', { id: skelZh.id });
      assert.equal(listAfterRemove.value?.diagrams?.length, 0, 'Backend diagram list must be empty after removal');

      // Esc closes modal back to SkeletonView
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('尚未挂载互动图表') && s.includes('OS 知识骨架'),
        { label: 'Modal closed back to SkeletonView (zh)' },
      );
      assert.equal(useDistTuiStore.getState().page, 'skeleton');
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 67 Track 1: SkeletonView live filter, Markdown export, and SGR mouse wheel', () => {
  test('1. Pure formatSkeletonMarkdown generates hierarchical outline in zh and en with mastery %, card counts, and descriptions', () => {
    const detail = {
      id: 'skel-1',
      title: 'Operating Systems Core',
      overview: 'Core mechanisms for process scheduling and virtual memory.',
      classNote: 'Focus on page replacement algorithms for midterm.',
      scope: [{ deckId: 'deck-os', topic: 'OS' }],
      nodes: [
        {
          id: 'n-root',
          term: 'Kernel Architecture',
          meaning: 'Privilege separation and system call boundary',
          attributes: ['Ring 0', 'Syscall'],
          cards: [{ deckId: 'deck-os', cardId: 'c1' }],
        },
        {
          id: 'n-mem',
          term: 'Virtual Memory',
          meaning: 'Address translation and demand paging',
          parent: 'n-root',
          cards: [
            { deckId: 'deck-os', cardId: 'c2' },
            { deckId: 'deck-os', cardId: 'c3' },
          ],
        },
        {
          id: 'n-tlb',
          term: 'TLB Cache',
          meaning: 'Hardware translation lookaside buffer',
          parent: 'n-mem',
          cards: [{ deckId: 'deck-os', cardId: 'c4' }],
        },
      ],
      relations: [{ from: 'n-root', to: 'n-mem', type: 'part-of', note: 'Subsystem' }],
    };

    const masteryMap = new Map([
      [
        'n-root',
        {
          cardCount: 1,
          masteredCount: 1,
          weakCount: 0,
          masteryPct: 80,
          isFocus: true,
          level: 'mastered',
          samplePrompts: [],
          subtreeCards: [],
        },
      ],
      [
        'n-mem',
        {
          cardCount: 2,
          masteredCount: 1,
          weakCount: 0,
          masteryPct: 60,
          isFocus: false,
          level: 'learning',
          samplePrompts: [],
          subtreeCards: [],
        },
      ],
      [
        'n-tlb',
        {
          cardCount: 1,
          masteredCount: 1,
          weakCount: 0,
          masteryPct: 100,
          isFocus: false,
          level: 'mastered',
          samplePrompts: [],
          subtreeCards: [],
        },
      ],
    ]);

    const enMd = formatSkeletonMarkdown({
      detail,
      course: 'CS301',
      masteryMap,
      lang: 'en',
      generatedAt: new Date('2026-11-22T10:30:00.000Z'),
    });
    assert.ok(enMd.includes('# Operating Systems Core'));
    assert.ok(enMd.includes('Course: CS301 | Nodes: 3 | Relations: 1 | Cards: 4 | Avg Mastery: 80% | Generated: 2026-11-22 10:30'));
    assert.ok(enMd.includes('> Core mechanisms for process scheduling and virtual memory.'));
    assert.ok(enMd.includes('### Kernel Architecture [80% | 1 cards | Focus]'));
    assert.ok(enMd.includes('- Summary: Privilege separation and system call boundary'));
    assert.ok(enMd.includes('- **Virtual Memory** [60% | 2 cards]'));
    assert.ok(enMd.includes('  - Address translation and demand paging'));
    assert.ok(enMd.includes('  - **TLB Cache** [100% | 1 cards]'));
    assert.ok(enMd.includes('    - Hardware translation lookaside buffer'));
    assert.ok(enMd.includes('- Kernel Architecture --[part-of]-> Virtual Memory (Subsystem)'));
    assert.ok(enMd.includes('Focus on page replacement algorithms for midterm.'));
    assert.ok(enMd.includes('Ring 0'));
    assert.ok(enMd.includes('Syscall'));

    const zhMd = formatSkeletonMarkdown({
      detail,
      course: 'CS301',
      masteryMap,
      lang: 'zh',
      generatedAt: new Date('2026-11-22T10:30:00.000Z'),
    });
    assert.ok(zhMd.includes('# Operating Systems Core'));
    assert.ok(zhMd.includes('课程: CS301 | 节点: 3 | 关系: 1 | 题卡: 4 | 平均掌握度: 80% | 导出时间: 2026-11-22 10:30'));
    assert.ok(zhMd.includes('### Kernel Architecture [80% | 1题 | 考纲重点]'));
    assert.ok(zhMd.includes('- 释义: Privilege separation and system call boundary'));
    assert.ok(zhMd.includes('- **Virtual Memory** [60% | 2题]'));
    assert.ok(zhMd.includes('  - **TLB Cache** [100% | 1题]'));
    assert.ok(zhMd.includes('- Kernel Architecture --[属于]-> Virtual Memory (Subsystem)'));
    assert.ok(zhMd.includes('Address translation and demand paging'));
    assert.ok(zhMd.includes('Hardware translation lookaside buffer'));
    assert.ok(zhMd.includes('Focus on page replacement algorithms for midterm.'));

    const minimalMd = formatSkeletonMarkdown({
      detail: {
        id: 'skel-min',
        title: 'Minimal Skeleton',
        overview: '',
        scope: [],
        nodes: [{ id: 'n1', term: 'Single Node', meaning: 'Root only', cards: [] }],
        relations: [],
      },
      course: null,
      masteryMap: new Map(),
      lang: 'en',
      generatedAt: new Date('2026-11-22T10:30:00.000Z'),
    });
    assert.ok(minimalMd.includes('# Minimal Skeleton'));
    assert.ok(minimalMd.includes('Nodes: 1 | Relations: 0 | Cards: 0'));
    assert.ok(minimalMd.includes('### Single Node'));
    assert.ok(minimalMd.includes('- Summary: Root only'));
  });

  test('2. @xterm/headless PTY E2E (120x36 zh): / live filter, E on filtered node, x atomic export, Esc clear, and SGR 1006 wheel (0 LLM tokens)', async () => {
    const box = await temps.make('r67-e2e-zh');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: { DSH_HOME: dshHome } });
    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    let llmCalls = 0;
    host.streamComplete = async () => {
      llmCalls += 1;
      throw new Error('LLM should never be called during filter/export/wheel');
    };

    const seed = await seedDeckWithCards(host, {
      title: '操作系统核心题组',
      course: 'OS202',
      topic: '内存与调度',
      prompts: ['什么是系统调用？', '什么是页表？', '什么是时间片轮转？'],
    });

    const saved = await host.call('skeleton.save', {
      title: 'OS 知识骨架',
      overview: '操作系统核心知识图谱',
      scope: [{ deckId: seed.deckId, topic: seed.topic }],
      nodes: [
        { id: 'n-kernel', term: 'Kernel Trap', meaning: 'User to kernel mode switch', cards: [seed.cardIds[0]] },
        { id: 'n-paging', term: 'Virtual Memory', meaning: 'Page table translation', parent: 'n-kernel', cards: [seed.cardIds[1]] },
        { id: 'n-sched', term: 'CPU Scheduler', meaning: 'Round robin time slicing', parent: 'n-kernel', cards: [seed.cardIds[2]] },
      ],
      relations: [{ from: 'n-kernel', to: 'n-paging', type: 'part-of', note: 'Memory subsystem' }],
    });
    assert.equal(saved.ok, true, `skeleton.save failed: ${saved.error?.message || ''}`);

    resetDistStore('zh', false, {
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, sidebarCollapsed: false, showKeyHints: true },
    });
    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
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
      await tty.waitFor((s) => !s.includes('正在打开学习库'), { label: 'LibraryView ready (zh)' });

      tty.send('8');
      const initialScreen = await tty.waitFor(
        (s) => {
          const hints = useDistTuiStore.getState().footerHints;
          return (
            useDistTuiStore.getState().page === 'skeleton' &&
            s.includes('OS 知识骨架') &&
            s.includes('Kernel Trap') &&
            s.includes('Virtual Memory') &&
            s.includes('CPU Scheduler') &&
            hints.some((h) => h.key === '/' && h.label === '筛选') &&
            hints.some((h) => h.key === 'x' && h.label === '导出MD')
          );
        },
        { label: 'SkeletonView rendered with 3 nodes and footer hints (zh)' },
      );
      const hintKeys = useDistTuiStore.getState().footerHints.map((h) => h.key);
      assert.ok(hintKeys.indexOf('/') > hintKeys.indexOf('s'), '`/` hint must appear after existing hints');
      assert.ok(hintKeys.indexOf('x') > hintKeys.indexOf('/'), '`x` hint must appear after `/` hint');
      tty.assertHealthyScreen(initialScreen, 120, 36, 'SkeletonView initial 120x36 zh');

      // Press `/` to open live filter bar and type 'Virtual'
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 3/3]'), { label: 'SkeletonView filter bar opened' });
      tty.send('Virtual');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/3]') &&
          s.includes('Virtual Memory') &&
          !s.includes('CPU Scheduler') &&
          s.includes('Page table translation'),
        { label: 'Filter narrowed tree to Virtual Memory and clamped Inspector' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'SkeletonView filter editing');

      // Enter confirms filter keeping filter active
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => s.includes('[已筛选 1/3]') && s.includes('Virtual Memory') && !s.includes('CPU Scheduler'),
        { label: 'Enter confirmed filter bar' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'SkeletonView filter confirmed');

      // Press `E` to verify edit modal targets the clamped filtered node ('Virtual Memory')
      tty.send('E');
      const editModalScreen = await tty.waitFor(
        (s) => s.includes('编辑知识节点') && s.includes('Virtual Memory') && s.includes('Page table translation'),
        { label: 'NodeEditModal opened for filtered node Virtual Memory' },
      );
      tty.assertHealthyScreen(editModalScreen, 120, 36, 'SkeletonView NodeEditModal on filtered node');
      tty.send('\u001b');
      await tty.waitFor((s) => !s.includes('编辑知识节点') && s.includes('[已筛选 1/3]'), {
        label: 'NodeEditModal closed with Esc',
      });

      // Press `x` to export Markdown atomically
      tty.send('x');
      const exportToastScreen = await tty.waitFor(
        (s) => s.includes('已导出 3 个知识节点'),
        { label: 'Skeleton Markdown export success toast (zh)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 120, 36, 'SkeletonView after export');

      const skelExport = await findExportedBackupFile(join(libraryRoot, 'backups'), 'studyhub-skeleton', 'md', todayLocalYmd());
      assert.ok(skelExport, 'studyhub-skeleton-*.md must exist on disk');
      assert.equal(existsSync(skelExport.path), true, 'studyhub-skeleton-*.md must exist on disk');
      const exportedMd = await readFile(skelExport.path, 'utf8');
      assert.ok(exportedMd.includes('# OS 知识骨架'));
      assert.ok(exportedMd.includes('### Kernel Trap'));
      assert.ok(exportedMd.includes('- **Virtual Memory**'));
      assert.ok(exportedMd.includes('- **CPU Scheduler**'));
      assert.ok(exportedMd.includes('Page table translation'));
      assert.ok(exportedMd.includes('Round robin time slicing'));
      assert.ok(exportedMd.includes('User to kernel mode switch'));
      assert.ok(exportedMd.includes('Kernel Trap --[属于]-> Virtual Memory'));
      assert.ok(exportedMd.includes('Memory subsystem'));
      assert.ok(exportedMd.includes('操作系统核心知识图谱'));
      assert.ok(exportedMd.includes('OS202'));
      assert.ok(exportedMd.includes('节点: 3'));
      assert.ok(exportedMd.includes('关系: 1'));
      assert.ok(exportedMd.includes('题卡: 3'));

      // Press `Esc` in normal mode to clear active filter (keeps Virtual Memory selected in full tree)
      tty.send('\u001b');
      const clearedScreen = await tty.waitFor(
        (s) =>
          !s.includes('[已筛选') &&
          s.includes('Kernel Trap') &&
          s.includes('Virtual Memory') &&
          s.includes('CPU Scheduler') &&
          s.includes('Page table translation'),
        { label: 'Esc cleared active filter cleanly' },
      );
      assert.equal(useDistTuiStore.getState().page, 'skeleton');
      assert.equal(useDistTuiStore.getState().inputCaptured, false);
      assert.ok(!clearedScreen.includes('[已筛选'));
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'SkeletonView filter cleared');

      // SGR 1006 mouse wheel up moves selection: Virtual Memory -> Kernel Trap
      tty.send('\x1b[<64;10;10M');
      const wheelUpToRoot = await tty.waitFor(
        (s) => s.includes('User to kernel mode switch'),
        { label: 'SGR wheel up moved selection to Kernel Trap' },
      );
      assert.ok(wheelUpToRoot.includes('User to kernel mode switch'));
      tty.assertHealthyScreen(wheelUpToRoot, 120, 36, 'SkeletonView wheel up to root');

      // SGR 1006 mouse wheel down moves selection: Kernel Trap -> Virtual Memory
      tty.send('\x1b[<65;10;10M');
      const wheelDown1 = await tty.waitFor(
        (s) => s.includes('Page table translation'),
        { label: 'SGR wheel down moved selection to Virtual Memory' },
      );
      assert.ok(wheelDown1.includes('Page table translation'));
      tty.assertHealthyScreen(wheelDown1, 120, 36, 'SkeletonView wheel down 1');

      // SGR 1006 mouse wheel down again: Virtual Memory -> CPU Scheduler
      tty.send('\x1b[<65;10;10M');
      const wheelDown2 = await tty.waitFor(
        (s) => s.includes('Round robin time slicing'),
        { label: 'SGR wheel down moved selection to CPU Scheduler' },
      );
      assert.ok(wheelDown2.includes('Round robin time slicing'));
      tty.assertHealthyScreen(wheelDown2, 120, 36, 'SkeletonView wheel down 2');

      // SGR 1006 mouse wheel up moves selection back: CPU Scheduler -> Virtual Memory
      tty.send('\x1b[<64;10;10M');
      const wheelUp = await tty.waitFor(
        (s) => s.includes('Page table translation'),
        { label: 'SGR wheel up moved selection back to Virtual Memory' },
      );
      assert.ok(wheelUp.includes('Page table translation'));
      tty.assertHealthyScreen(wheelUp, 120, 36, 'SkeletonView wheel up');

      // Verify 80x24 viewport rendering in same mounted app
      tty.resize(80, 24);
      const narrowScreen = await tty.waitFor(
        (s) => s.includes('OS 知识骨架') && s.includes('Virtual Memory') && s.split('\n').length <= 24,
        { label: 'SkeletonView 80x24 clean render (zh)' },
      );
      tty.assertHealthyScreen(narrowScreen, 80, 24, 'SkeletonView 80x24 zh');
      assert.equal(useDistTuiStore.getState().page, 'skeleton');
      assert.equal(useDistTuiStore.getState().inputCaptured, false);
      assert.equal(llmCalls, 0, 'Skeleton filter, export, and wheel must use 0 LLM tokens');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
