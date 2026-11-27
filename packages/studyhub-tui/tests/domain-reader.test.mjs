// Consolidated Reader Domain Suite (DocumentReader, Outline/Notes Drawers, Marks, Glossary, Resume, Translation, SaveCard):
// Merged from: round36-reader-e2e, round42-reader-marks, round44-mark-save,
//   round46-trans-glossary, round48-reader-resume, round51-reader-trans, round52-reader-savecard
// node --test tests/domain-reader.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences, loadTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(loadTuiPreferences, 'dist/ must export loadTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const [prefsMod, readerMod] = await Promise.all([
  import('../src/host/tui-prefs.ts'),
  import('../src/views/sources/DocumentReader.tsx'),
]);
const { extractPageAnchorSlice } = readerMod;
assert.equal(typeof prefsMod.parseTuiPreferences, 'function', 'tui-prefs must export parseTuiPreferences');
assert.equal(typeof extractPageAnchorSlice, 'function', 'DocumentReader must export extractPageAnchorSlice');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-dom-reader-');

after(async () => {
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);

function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
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

async function mountAppSession(host, dshHome, { initialPage = 'sources', language = 'zh', asciiMode = false, cols = 120, rows = 36 } = {}) {
  resetTuiStore(language, asciiMode);
  await saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
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
  await tty.firstFramePromise;
  return { tty, inkInstance };
}

function cleanupAppSession(session) {
  if (!session) return;
  try {
    session.inkInstance?.unmount();
  } catch {
    // Ignore teardown unmount errors
  }
  session.tty?.dispose();
}

async function openSourceInReader(tty, titleNeedle, expectedBodyNeedle) {
  await tty.waitFor(
    (s) => s.includes(titleNeedle) && !s.includes('正在加载页面') && !s.includes('Loading page'),
    { timeoutMs: 10_000, label: `SourcesView showing ${titleNeedle}` },
  );

  tty.send('/');
  await tty.waitFor(
    (s) => s.includes('筛选资料:') || s.includes('Filter:'),
    { timeoutMs: 5_000, label: 'Sources filter bar opened' },
  );
  tty.send(titleNeedle);
  await tty.waitFor(
    (s) => s.includes(`筛选资料: ${titleNeedle}`) || s.includes(`Filter: ${titleNeedle}`),
    { timeoutMs: 5_000, label: `Filter typed ${titleNeedle}` },
  );
  tty.send('\r');
  await tty.waitFor(
    (s) =>
      (s.includes(`筛选: "${titleNeedle}"`) || s.includes(`Filter: "${titleNeedle}"`)) &&
      (s.includes('(/ 修改)') || s.includes('(/ edit)')),
    { timeoutMs: 5_000, label: `Sources filter applied for ${titleNeedle}` },
  );
  await tty.flush();
  tty.send('\r');

  return tty.waitFor(
    (s) =>
      s.includes(titleNeedle) &&
      s.includes(expectedBodyNeedle) &&
      (s.includes('第 ') || s.includes('P. ')),
    { timeoutMs: 10_000, label: `DocumentReader opened for ${titleNeedle}` },
  );
}

/**
 * Event-driven wait on `study/tui.json` updates via `fs.watch` (zero sleep polling).
 */
async function waitForLastReadPage(dshHome, docKey, expectedPage, timeoutMs = 4_000) {
  const initial = await loadTuiPreferences({ env: { DSH_HOME: dshHome } });
  if (initial.lastReadPages?.[docKey] === expectedPage) return initial;

  const studyDir = join(dshHome, 'study');
  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    let checking = false;
    let watcher = null;
    let timer = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        // Ignore fs.watch close error
      }
    };

    const recheck = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        const prefs = await loadTuiPreferences({ env: { DSH_HOME: dshHome } });
        if (!settled && prefs.lastReadPages?.[docKey] === expectedPage) {
          cleanup();
          resolveWait(prefs);
        }
      } catch {
        // Ignore transient read during atomic rename
      } finally {
        checking = false;
      }
    };

    try {
      watcher = fs.watch(studyDir, () => {
        void recheck();
      });
    } catch {
      // Fallback if studyDir does not exist yet
    }

    timer = setTimeout(() => {
      if (settled) return;
      void (async () => {
        const finalPrefs = await loadTuiPreferences({ env: { DSH_HOME: dshHome } }).catch(() => ({}));
        if (!settled && finalPrefs.lastReadPages?.[docKey] === expectedPage) {
          cleanup();
          resolveWait(finalPrefs);
          return;
        }
        cleanup();
        rejectWait(
          new Error(
            `Timed out waiting for lastReadPages[${docKey}] === ${expectedPage} (got ${finalPrefs.lastReadPages?.[docKey]})`,
          ),
        );
      })();
    }, timeoutMs);

    setImmediate(() => {
      void recheck();
    });
  });
}

async function importThreePageMarkdown(host, boxDir, filename, title) {
  const mdPath = join(boxDir, filename);
  await writeFile(
    mdPath,
    [
      '<!-- page: 1 -->',
      `# ${title} - Page One`,
      '',
      `R48 Page One Alpha (${title}) content for resume verification.`,
      '',
      '<!-- page: 2 -->',
      `# ${title} - Page Two`,
      '',
      `R48 Page Two Beta (${title}) content for resume verification.`,
      '',
      '<!-- page: 3 -->',
      `# ${title} - Page Three`,
      '',
      `R48 Page Three Gamma (${title}) content for resume verification.`,
      '',
    ].join('\n'),
    'utf8',
  );
  const imp = await host.call('materials.document.import', {
    path: mdPath,
    title,
    format: 'md',
  });
  assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
  assert.equal(imp.value.sourceIds.length, 3, 'Expected 3-page document');
  return imp.value;
}

describe('Reader Domain Suite 1: Lazy-Split Chunks & Pure Unit Helpers', () => {
  test('1.1) dist/ lazy-splits ReaderOutlineDrawer, ReaderNotesDrawer, MarkPassageModal & TranslationGlossaryModal', async () => {
    const outlineChunk = distFiles.find((f) => f.startsWith('ReaderOutlineDrawer-') && f.endsWith('.mjs'));
    const notesChunk = distFiles.find((f) => f.startsWith('ReaderNotesDrawer-') && f.endsWith('.mjs'));
    const markModalChunk = distFiles.find((f) => f.startsWith('MarkPassageModal-') && f.endsWith('.mjs'));
    const glossaryChunk = distFiles.find((f) => f.startsWith('TranslationGlossaryModal-') && f.endsWith('.mjs'));
    const readerChunk = distFiles.find((f) => f.startsWith('DocumentReader-') && f.endsWith('.mjs'));

    assert.ok(outlineChunk, 'Expected separate ReaderOutlineDrawer-*.mjs chunk in dist/');
    assert.ok(notesChunk, 'Expected separate ReaderNotesDrawer-*.mjs chunk in dist/');
    assert.ok(markModalChunk, 'Expected separate MarkPassageModal-*.mjs chunk in dist/');
    assert.ok(glossaryChunk, 'Expected separate TranslationGlossaryModal-*.mjs chunk in dist/');
    assert.ok(readerChunk, 'Expected DocumentReader-*.mjs chunk in dist/');

    const readerCode = await readFile(join(distDir, readerChunk), 'utf8');
    assert.equal(readerCode.includes('Document Outline'), false, 'DocumentReader chunk must not inline ReaderOutlineDrawer');
    assert.equal(readerCode.includes('Annotations & Marks'), false, 'DocumentReader chunk must not inline ReaderNotesDrawer');
    assert.equal(readerCode.includes('Mark Passage'), false, 'DocumentReader chunk must not inline MarkPassageModal');
    assert.equal(readerCode.includes('Translation Glossary & Saved'), false, 'DocumentReader chunk must not inline TranslationGlossaryModal');
  });

  test('1.2) parseTuiPreferences omits empty/corrupt lastReadPages and filters invalid entries cleanly', () => {
    assert.equal('lastReadPages' in prefsMod.DEFAULT_TUI_PREFERENCES, false);

    const overflowInput = Object.fromEntries(
      Array.from({ length: 105 }, (_, i) => [`doc-cap-${i}`, i + 1]),
    );
    const capped = prefsMod.parseTuiPreferences({ lastReadPages: overflowInput });
    assert.equal(
      Object.keys(capped.lastReadPages ?? {}).length,
      100,
      'parseTuiPreferences must cap lastReadPages at 100 entries',
    );

    const empty = prefsMod.parseTuiPreferences({ lastReadPages: {} });
    assert.equal('lastReadPages' in empty, false);

    for (const bad of [null, [], 'str', 42, true]) {
      const parsedBad = prefsMod.parseTuiPreferences({ lastReadPages: bad });
      assert.equal('lastReadPages' in parsedBad, false);
    }

    const longValidKey = 'k'.repeat(160);
    const overlongKey = 'x'.repeat(161);
    const parsed = prefsMod.parseTuiPreferences({
      lastReadPages: {
        '': 2,
        '   ': 4,
        [overlongKey]: 3,
        'doc-neg': -1,
        'doc-zero': 0,
        'doc-float': 2.5,
        'doc-nan': Number.NaN,
        'doc-inf': Number.POSITIVE_INFINITY,
        'doc-over-max': 50_001,
        'doc-str': '3',
        'doc-null': null,
        '  doc-alpha  ': 3,
        'doc-beta': 1,
        'doc-max': 50_000,
        [longValidKey]: 17,
      },
    });

    assert.deepEqual(parsed.lastReadPages, {
      'doc-alpha': 3,
      'doc-beta': 1,
      'doc-max': 50_000,
      [longValidKey]: 17,
    });
  });

  test('1.3) parseTuiPreferences caps lastReadPages at 100 entries keeping newest', () => {
    const input = {};
    for (let i = 1; i <= 125; i += 1) {
      input[`doc-${String(i).padStart(3, '0')}`] = i;
    }
    const parsed = prefsMod.parseTuiPreferences({ lastReadPages: input });
    const keys = Object.keys(parsed.lastReadPages || {});
    assert.equal(keys.length, 100);
    assert.equal(keys[0], 'doc-026');
    assert.equal(keys[99], 'doc-125');
    assert.equal(parsed.lastReadPages['doc-001'], undefined);
    assert.equal(parsed.lastReadPages['doc-025'], undefined);
    assert.equal(parsed.lastReadPages['doc-026'], 26);
    assert.equal(parsed.lastReadPages['doc-125'], 125);
  });

  test('1.4) saveTuiPreferences & loadTuiPreferences round-trip lastReadPages atomically', async () => {
    const base = await temps.make('prefs-unit');
    const location = { env: { DSH_HOME: base } };

    const saved = await prefsMod.saveTuiPreferences(
      {
        lastReadPages: {
          'doc-one': 3,
          'doc-bad': -5,
          'doc-two': 12,
        },
      },
      location,
    );
    assert.deepEqual(saved.lastReadPages, { 'doc-one': 3, 'doc-two': 12 });

    const merged = await prefsMod.saveTuiPreferences({ compactMode: true }, location);
    assert.equal(merged.compactMode, true);
    assert.deepEqual(merged.lastReadPages, { 'doc-one': 3, 'doc-two': 12 });

    const reloaded = await prefsMod.loadTuiPreferences(location);
    assert.deepEqual(reloaded, merged);

    const files = await readdir(join(base, 'study'));
    assert.deepEqual(files, ['tui.json']);
  });

  test('1.5) extractPageAnchorSlice trims whitespace, isolates first paragraph, and caps at 240 chars', () => {
    assert.equal(extractPageAnchorSlice(''), null);
    assert.equal(extractPageAnchorSlice('   \n\t  \n '), null);

    const sampleLeading = '   \n\nFirst passage line one.\nLine two.   \n\nSecond paragraph ignored.';
    const sliced = extractPageAnchorSlice(sampleLeading);
    assert.ok(sliced, 'expected non-null anchor slice');
    assert.equal(sampleLeading.slice(sliced.start, sliced.end), sliced.quote);
    assert.equal(sliced.quote, 'First passage line one.\nLine two.');
    assert.ok(sliced.start >= 0 && sliced.end > sliced.start);

    const exact240 = 'B'.repeat(240);
    const exactSlice = extractPageAnchorSlice(exact240);
    assert.ok(exactSlice);
    assert.equal(exactSlice.quote.length, 240);
    assert.equal(exact240.slice(exactSlice.start, exactSlice.end), exactSlice.quote);

    const longText = `  ${'A'.repeat(300)}  `;
    const longSlice = extractPageAnchorSlice(longText);
    assert.ok(longSlice, 'expected non-null slice for long text');
    assert.equal(longText.slice(longSlice.start, longSlice.end), longSlice.quote);
    assert.ok(longSlice.quote.length <= 240, 'slice must be capped at 240 chars');
  });
});

describe('Reader Domain Suite 2: Host Integration Contracts', () => {
  let boxDir;
  let dshHome;
  let host;
  let modelCalls = 0;

  before(async () => {
    boxDir = await temps.make('host-contracts');
    dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return JSON.stringify({ translations: [] });
      },
    });
  });

  after(async () => {
    await host?.dispose();
  });

  test('2.1) materials.reading.get & materials.reading.save lifecycle (multi-chapter & legacy single-source)', async () => {
    const mdPath = join(boxDir, 'r36-host-guide.md');
    await writeFile(
      mdPath,
      [
        '# Chapter 1: Fundamentals',
        '',
        'Core definitions and axioms for Round 36 reading progress verification.',
        '',
        '# Chapter 2: Algorithms',
        '',
        'Divide and conquer recurrence relations and dynamic programming.',
        '',
      ].join('\n'),
      'utf8',
    );
    const impRes = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R36 Host Progress Guide',
      format: 'md',
    });
    assert.equal(impRes.ok, true, `materials.document.import failed: ${impRes.error?.message || ''}`);
    const docInfo = impRes.value;
    assert.ok(docInfo?.documentId, 'Imported document must have documentId');
    assert.ok(Array.isArray(docInfo?.sourceIds) && docInfo.sourceIds.length > 0, 'Imported document must have sourceIds');

    const src1Res = await host.call('source.add', {
      title: 'R36 MultiPage Ch1',
      text: 'Page 1 content covering foundational definitions and notation.',
    });
    assert.equal(src1Res.ok, true, `source.add p1 failed: ${src1Res.error?.message || ''}`);
    const src1Id = src1Res.value?.source?.id || src1Res.value?.id;
    assert.ok(src1Id, 'src1Id must exist');

    const chapters = [
      { id: 'ch-1', title: 'Chapter 1: Foundations', startPage: 1, endPage: 2 },
      { id: 'ch-2', title: 'Chapter 2: Applications', startPage: 3, endPage: 5 },
    ];

    const get0 = await host.call('materials.reading.get', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
    });
    assert.equal(get0.ok, true, `materials.reading.get initial failed: ${get0.error?.message || ''}`);
    assert.deepEqual(get0.value?.read, [], 'Initially 0 chapters should be read');
    assert.equal(get0.value?.count, 0);

    const saveRead = await host.call('materials.reading.save', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
      read: [chapters[0]],
      unread: [],
    });
    assert.equal(saveRead.ok, true, `materials.reading.save read failed: ${saveRead.error?.message || ''}`);
    assert.equal(saveRead.value?.saved, true);
    assert.deepEqual(saveRead.value?.read, ['ch-1']);

    const get1 = await host.call('materials.reading.get', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
    });
    assert.equal(get1.ok, true, `materials.reading.get after save failed: ${get1.error?.message || ''}`);
    assert.deepEqual(get1.value?.read, ['ch-1']);
    assert.equal(get1.value?.count, 1);

    const saveUnread = await host.call('materials.reading.save', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
      read: [],
      unread: [chapters[0]],
    });
    assert.equal(saveUnread.ok, true, `materials.reading.save unread failed: ${saveUnread.error?.message || ''}`);
    assert.equal(saveUnread.value?.saved, true);
    assert.deepEqual(saveUnread.value?.read, []);

    const get2 = await host.call('materials.reading.get', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
    });
    assert.equal(get2.ok, true, `materials.reading.get after unread failed: ${get2.error?.message || ''}`);
    assert.deepEqual(get2.value?.read, []);
    assert.equal(get2.value?.count, 0);

    const legacyCh = [{ id: 'md-1-1', title: 'R36 MultiPage Ch1', startPage: 1, endPage: 1 }];
    const legRead = await host.call('materials.reading.save', {
      sourceId: src1Id,
      chapters: legacyCh,
      read: legacyCh,
      unread: [],
    });
    assert.equal(legRead.ok, true, `legacy materials.reading.save failed: ${legRead.error?.message || ''}`);
    assert.equal(legRead.value?.saved, true);
    assert.deepEqual(legRead.value?.read, ['md-1-1']);
  });

  test('2.2) materials.marks lifecycle: save -> list -> seen (rereadAt) -> reread query -> delete & stale purge', async () => {
    const v1Path = join(boxDir, 'r42-host-v1.md');
    await writeFile(
      v1Path,
      [
        '# Chapter 1: Invariants',
        '',
        'A loop invariant holds before the loop begins and after every iteration.',
        '',
        'Termination guarantees the algorithm finishes in finite steps.',
        '',
      ].join('\n'),
      'utf8',
    );

    const impV1 = await host.call('materials.document.import', {
      path: v1Path,
      title: 'R42 Host Marks Guide',
      format: 'md',
    });
    assert.equal(impV1.ok, true, `import v1 failed: ${impV1.error?.message || ''}`);
    const docId = impV1.value.documentId;
    const rev1 = impV1.value.revision;
    const src1 = impV1.value.sourceIds[0];

    const save1 = await host.call('materials.marks.save', {
      documentId: docId,
      revision: rev1,
      style: 'highlight',
      selection: {
        documentId: docId,
        revision: rev1,
        sourceId: src1,
        quote: 'loop invariant holds before the loop begins',
      },
    });
    assert.equal(save1.ok, true, `marks.save 1 failed: ${save1.error?.message || ''}`);
    assert.equal(save1.value?.status, 'saved');
    const mark1Id = save1.value?.item?.id;
    assert.ok(mark1Id, 'Saved mark 1 must have id');

    const save2 = await host.call('materials.marks.save', {
      documentId: docId,
      revision: rev1,
      style: 'bold',
      selection: {
        documentId: docId,
        revision: rev1,
        sourceId: src1,
        quote: 'Termination guarantees the algorithm finishes',
      },
    });
    assert.equal(save2.ok, true, `marks.save 2 failed: ${save2.error?.message || ''}`);
    assert.equal(save2.value?.status, 'saved');
    const mark2Id = save2.value?.item?.id;
    assert.ok(mark2Id, 'Saved mark 2 must have id');

    const list1 = await host.call('materials.marks.list', { documentId: docId, revision: rev1 });
    assert.equal(list1.ok, true);
    assert.equal(list1.value?.count, 2);
    assert.equal(list1.value?.items?.length, 2);
    assert.equal(list1.value?.items?.find((m) => m.id === mark1Id)?.style, 'highlight');
    assert.equal(list1.value?.items?.find((m) => m.id === mark1Id)?.rereadAt, undefined);
    assert.equal(list1.value?.items?.find((m) => m.id === mark2Id)?.style, 'bold');

    const seenRes = await host.call('materials.marks.seen', {
      documentId: docId,
      revision: rev1,
      id: mark1Id,
    });
    assert.equal(seenRes.ok, true, `marks.seen failed: ${seenRes.error?.message || ''}`);
    assert.equal(seenRes.value?.status, 'saved');
    assert.ok(seenRes.value?.item?.rereadAt, 'materials.marks.seen must set rereadAt');
    assert.ok(Number.isFinite(Date.parse(seenRes.value.item.rereadAt)), 'rereadAt must be valid ISO timestamp');

    const list2 = await host.call('materials.marks.list', { documentId: docId, revision: rev1 });
    assert.equal(list2.ok, true);
    assert.equal(
      list2.value?.items?.find((m) => m.id === mark1Id)?.rereadAt,
      seenRes.value.item.rereadAt,
      'materials.marks.list must persist rereadAt',
    );

    const rereadList = await host.call('materials.marks.reread', {});
    assert.equal(rereadList.ok, true, `marks.reread failed: ${rereadList.error?.message || ''}`);
    assert.ok(Array.isArray(rereadList.value?.items));
    assert.equal(typeof rereadList.value?.count, 'number');

    const del1 = await host.call('materials.marks.delete', {
      documentId: docId,
      revision: rev1,
      ids: [mark1Id],
    });
    assert.equal(del1.ok, true, `marks.delete failed: ${del1.error?.message || ''}`);
    assert.equal(del1.value?.deleted, 1);

    const list3 = await host.call('materials.marks.list', { documentId: docId, revision: rev1 });
    assert.equal(list3.ok, true);
    assert.equal(list3.value?.count, 1);
    assert.equal(list3.value?.items?.some((m) => m.id === mark1Id), false);

    const v2Path = join(boxDir, 'r42-host-v2.md');
    await writeFile(
      v2Path,
      [
        '# Chapter 1: Invariants (Revised)',
        '',
        'Completely rewritten chapter text with no matching prior quotes.',
        '',
      ].join('\n'),
      'utf8',
    );
    const impV2 = await host.call('materials.document.import', {
      documentId: docId,
      path: v2Path,
      title: 'R42 Host Marks Guide',
      format: 'md',
    });
    assert.equal(impV2.ok, true, `import v2 failed: ${impV2.error?.message || ''}`);
    const rev2 = impV2.value.revision;
    assert.notEqual(rev2, rev1);

    const listStale = await host.call('materials.marks.list', { documentId: docId, revision: rev2 });
    assert.equal(listStale.ok, true);
    assert.ok(Array.isArray(listStale.value?.stale) && listStale.value.stale.length > 0, 'Expected stale marks from v1');
    assert.equal(listStale.value.stale[0].count, 1);

    const purgeRes = await host.call('materials.marks.delete', {
      documentId: docId,
      revision: rev2,
      stale: true,
    });
    assert.equal(purgeRes.ok, true, `marks.delete stale failed: ${purgeRes.error?.message || ''}`);
    assert.equal(purgeRes.value?.deleted, 1);
    assert.equal(purgeRes.value?.stale, true);

    const listAfterPurge = await host.call('materials.marks.list', { documentId: docId, revision: rev2 });
    assert.equal(listAfterPurge.ok, true);
    assert.equal(listAfterPurge.value?.count, 0);
    assert.deepEqual(listAfterPurge.value?.items, []);
    assert.deepEqual(listAfterPurge.value?.stale, []);
  });

  test('2.3) materials.marks.save queue-full limit (40) status contract', async () => {
    const lines = ['# Queue Limit Doc', ''];
    for (let i = 1; i <= 42; i += 1) {
      lines.push(`Unique queue passage number ${i} for limit verification.`);
    }
    const qPath = join(boxDir, 'r44-queue-limit.md');
    await writeFile(qPath, lines.join('\n'), 'utf8');

    const imp = await host.call('materials.document.import', {
      path: qPath,
      title: 'R44 Queue Limit Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;
    const srcId = imp.value.sourceIds[0];

    for (let i = 1; i <= 40; i += 1) {
      const res = await host.call('materials.marks.save', {
        documentId: docId,
        revision: rev,
        sourceId: srcId,
        style: 'queue',
        selection: {
          documentId: docId,
          revision: rev,
          sourceId: srcId,
          quote: `Unique queue passage number ${i} for limit verification.`,
        },
      });
      assert.equal(res.ok, true);
      assert.equal(res.value?.status, 'saved');
    }

    const listQueue = await host.call('materials.marks.list', { documentId: docId, revision: rev });
    assert.equal(listQueue.ok, true);
    assert.equal(listQueue.value?.count, 40);
    assert.equal(listQueue.value?.items?.length, 40);

    const overflow = await host.call('materials.marks.save', {
      documentId: docId,
      revision: rev,
      sourceId: srcId,
      style: 'queue',
      selection: {
        documentId: docId,
        revision: rev,
        sourceId: srcId,
        quote: 'Unique queue passage number 41 for limit verification.',
      },
    });
    assert.equal(overflow.ok, true);
    assert.equal(overflow.value?.status, 'queue-full');
    assert.equal(overflow.value?.limit, 40);
  });

  test('2.4) materials.translation glossary & saved translations lifecycle (get/set/save/list/delete/clear)', async () => {
    const mdPath = join(boxDir, 'r46-host-glossary.md');
    await writeFile(
      mdPath,
      [
        '# Spaced Repetition Notes',
        '',
        'FSRS schedules memory intervals using stability and difficulty.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R46 Host Glossary Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;

    const get0 = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(get0.ok, true);
    assert.deepEqual(get0.value.glossary, []);

    const set1 = await host.call('materials.translation.glossary.set', {
      documentId: docId,
      glossary: [{ term: 'FSRS', to: '间隔重复算法' }],
      target: 'zh',
    });
    assert.equal(set1.ok, true);
    assert.equal(set1.value.target, 'zh');
    assert.deepEqual(set1.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

    const get1 = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(get1.ok, true);
    assert.equal(get1.value.target, 'zh');
    assert.deepEqual(get1.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

    const list1 = await host.call('materials.translation.list', { documentId: docId });
    assert.equal(list1.ok, true);
    assert.equal(list1.value.target, 'zh');
    assert.deepEqual(list1.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);
    assert.deepEqual(list1.value.items, []);

    const docMeta = await host.call('materials.document.get', { documentId: docId });
    assert.equal(docMeta.ok, true);
    const firstSourceId = docMeta.value.sources[0].id;

    const saved = await host.call('materials.translation.save', {
      documentId: docId,
      target: 'zh',
      passages: [
        {
          sourceId: firstSourceId,
          text: 'FSRS schedules memory intervals using stability and difficulty.',
          translation: '间隔重复算法根据稳定性与难度安排记忆间隔。',
        },
      ],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.saved, 1);

    const list2 = await host.call('materials.translation.list', { documentId: docId });
    assert.equal(list2.ok, true);
    assert.equal(list2.value.items.length, 1);
    assert.equal(list2.value.items[0].target, 'zh');
    assert.ok(list2.value.items[0].quote.includes('FSRS schedules memory intervals'));
    const savedKey = list2.value.items[0].key;
    assert.ok(savedKey, 'saved translation item must have key');

    const del1 = await host.call('materials.translation.delete', {
      documentId: docId,
      target: 'zh',
      keys: [savedKey],
    });
    assert.equal(del1.ok, true);
    assert.equal(del1.value.deleted, 1);

    const listAfterDel = await host.call('materials.translation.list', { documentId: docId });
    assert.equal(listAfterDel.ok, true);
    assert.deepEqual(listAfterDel.value.items, []);

    const cleared = await host.call('materials.translation.glossary.set', {
      documentId: docId,
      glossary: [],
    });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.value.glossary, []);

    const getAfterClear = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(getAfterClear.ok, true);
    assert.deepEqual(getAfterClear.value.glossary, []);
  });

  test('2.5) materials.translation estimate:true (0 LLM) -> save -> list -> translate cache reuse (0 LLM)', async () => {
    modelCalls = 0;
    const headingText = '# Neural Networks';
    const bodyText = 'Backpropagation computes exact gradients through layered computational graphs.';

    const added = await host.call('source.add', {
      title: 'R51 Host Translation Doc',
      format: 'md',
      text: `${headingText}\n\n${bodyText}\n`,
    });
    assert.equal(added.ok, true, `source.add failed: ${added.error?.message || ''}`);
    const sourceId = added.value.id;
    assert.ok(sourceId, 'source.add must return id');

    const estRes = await host.call('materials.translation.translate', {
      sourceId,
      scope: { sourceIds: [sourceId] },
      target: 'zh',
      estimate: true,
    });
    assert.equal(estRes.ok, true, `estimate failed: ${estRes.error?.message || ''}`);
    assert.equal(estRes.value.status, 'estimate');
    assert.equal(estRes.value.target, 'zh');
    assert.equal(estRes.value.counts.cached, 0);
    assert.ok(estRes.value.counts.toTranslate > 0, 'expected counts.toTranslate > 0');
    assert.equal(modelCalls, 0, 'estimate:true must make 0 model calls');

    const saveRes = await host.call('materials.translation.save', {
      sourceId,
      target: 'zh',
      passages: [
        { sourceId, text: headingText, translation: '# 神经网络' },
        { sourceId, text: bodyText, translation: '反向传播通过分层计算图精确计算梯度。' },
      ],
    });
    assert.equal(saveRes.ok, true, `translation.save failed: ${saveRes.error?.message || ''}`);
    assert.equal(saveRes.value.saved, 2);

    const listRes = await host.call('materials.translation.list', {
      sourceId,
      target: 'zh',
    });
    assert.equal(listRes.ok, true, `translation.list failed: ${listRes.error?.message || ''}`);
    assert.equal(listRes.value.target, 'zh');
    assert.equal(listRes.value.items.length, 2);
    const bodyItem = listRes.value.items.find((it) => it.text === '反向传播通过分层计算图精确计算梯度。');
    assert.ok(bodyItem, 'translation.list must return saved item text');
    assert.ok(typeof bodyItem.quote === 'string' && bodyItem.quote.includes('Backpropagation'), 'item must include quote');
    assert.equal(bodyItem.target, 'zh');
    assert.equal(modelCalls, 0, 'translation.list must make 0 model calls');

    const reuseRes = await host.call('materials.translation.translate', {
      sourceId,
      scope: { sourceIds: [sourceId] },
      target: 'zh',
    });
    assert.equal(reuseRes.ok, true, `cached translate failed: ${reuseRes.error?.message || ''}`);
    assert.equal(reuseRes.value.status, 'done');
    assert.equal(reuseRes.value.counts.toTranslate, 0);
    assert.equal(reuseRes.value.counts.cached, 2);
    assert.equal(modelCalls, 0, 'fully cached materials.translation.translate must make 0 model calls');
  });

  test('2.6) generation.selection.saveAnswer 0-token deck & card creation, links tracking & duplicate guard', async () => {
    modelCalls = 0;
    const mdText = '# Backpropagation\n\nBackpropagation applies the chain rule across layers to compute exact gradients.\n';
    const added = await host.call('source.add', {
      title: 'R52 Host SaveCard Doc',
      format: 'md',
      text: mdText,
    });
    assert.equal(added.ok, true, `source.add failed: ${added.error?.message || ''}`);
    const sourceId = added.value.id;
    assert.ok(sourceId, 'source.add must return id');

    const anchor = extractPageAnchorSlice(mdText);
    assert.ok(anchor, 'anchor slice must resolve for markdown material');
    assert.equal(mdText.slice(anchor.start, anchor.end), anchor.quote);

    const docRes = await host.call('materials.document.get', { sourceId });
    assert.equal(docRes.ok, true, `materials.document.get failed: ${docRes.error?.message || ''}`);
    const documentId = docRes.value.documentId || docRes.value.id;
    assert.ok(documentId, 'materials.document.get must return documentId');

    const resolved = await host.call('materials.selection.resolve', {
      documentId,
      sourceId,
      start: anchor.start,
      end: anchor.end,
      quote: anchor.quote,
    });
    assert.equal(resolved.ok, true, `selection.resolve failed: ${resolved.error?.message || ''}`);
    assert.equal(resolved.value.status, 'resolved');
    const selection = Object.fromEntries(
      Object.entries(resolved.value.selection).filter(([, v]) => v !== undefined),
    );
    assert.ok(selection?.documentId, 'resolved selection must include documentId');
    assert.ok(selection?.revision, 'resolved selection must include revision');

    const question = 'How does backpropagation compute gradients?';
    const answer = 'It applies the chain rule recursively across each neural network layer.';

    const save1 = await host.call('generation.selection.saveAnswer', {
      selection,
      question,
      answer,
      operationId: 'r52-host-save-1',
      uiLanguage: 'en',
    });
    assert.equal(save1.ok, true, `saveAnswer #1 failed: ${save1.error?.message || ''}`);
    assert.equal(save1.value.status, 'complete');
    assert.ok(save1.value.deckId, 'saveAnswer must return deckId');
    assert.ok(save1.value.cardId, 'saveAnswer must return cardId');
    assert.equal(modelCalls, 0, 'saveAnswer must invoke 0 model calls');

    const refreshed = await host.refreshSnapshot();
    assert.ok(refreshed.snapshot, `refreshSnapshot failed: ${refreshed.error || ''}`);
    const createdDeck = refreshed.snapshot.decks.find((d) => d.id === save1.value.deckId);
    assert.ok(createdDeck, 'created deck must appear in refreshSnapshot().snapshot.decks');
    assert.equal(createdDeck.count, 1);

    const deckDetail = await host.call('deck.get', { id: save1.value.deckId });
    assert.equal(deckDetail.ok, true);
    const createdCard = (deckDetail.value.cards || []).find((c) => c.id === save1.value.cardId);
    assert.ok(createdCard, 'created card must exist in deck.get');
    assert.equal(createdCard.answer, answer);
    assert.ok(String(createdCard.prompt || '').includes(question), 'card prompt must include question');
    assert.ok(String(createdCard.prompt || '').includes(anchor.quote), 'card prompt must include quoted passage');

    const linksRes = await host.call('materials.links.list', { cardId: save1.value.cardId });
    assert.equal(linksRes.ok, true);
    assert.ok(linksRes.value.links.length >= 1, 'materials.links.list must have at least 1 link');
    const linkEntry = (linksRes.value.links || []).find((l) => l.cardId === save1.value.cardId);
    assert.ok(linkEntry, 'materials.links.list must return linked card');
    assert.equal(linkEntry.sourceQa, true);
    assert.equal(linkEntry.cardId, save1.value.cardId);

    const save2 = await host.call('generation.selection.saveAnswer', {
      selection,
      question,
      answer,
      operationId: 'r52-host-save-2',
      uiLanguage: 'en',
    });
    assert.equal(save2.ok, true, `saveAnswer #2 failed: ${save2.error?.message || ''}`);
    assert.equal(save2.value.status, 'duplicate');
    assert.equal(save2.value.deckId, save1.value.deckId);
    assert.equal(save2.value.cardId, save1.value.cardId);
    assert.equal(modelCalls, 0, 'duplicate saveAnswer must invoke 0 model calls');
  });
});

describe('Reader Domain Suite 3: DocumentReader Progress, Drawers & Persistent Page Resume E2E', () => {
  test('3.1) PTY E2E: DocumentReader [M] mark read, lazy Outline [O] (Space read + [m] unread) & Notes [B] drawers', async () => {
    const boxDir = await temps.make('r36-e2e');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let session = null;
    try {
      const mdPath = join(boxDir, 'r36-guide.md');
      await writeFile(
        mdPath,
        [
          '# Chapter 1: Fundamentals',
          '',
          'Core definitions and axioms for Round 36 reading progress verification.',
          '',
          '# Chapter 2: Algorithms',
          '',
          'Divide and conquer recurrence relations and dynamic programming.',
          '',
          '# Chapter 3: Practice',
          '',
          'Worked examples and checkpoint exercises.',
          '',
        ].join('\n'),
        'utf8',
      );
      const impRes = await host.call('materials.document.import', {
        path: mdPath,
        title: 'R36 Reading Progress Guide',
        format: 'md',
      });
      assert.equal(impRes.ok, true, `materials.document.import failed: ${impRes.error?.message || ''}`);
      assert.ok(impRes.value?.documentId, 'Imported document must have documentId');

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const { tty } = session;

      const readerInit = await openSourceInReader(tty, 'R36 Reading Progress Guide', 'Core definitions');
      tty.assertHealthyScreen(readerInit, 120, 36, 'DocumentReader initial');
      assert.ok(readerInit.includes('✓ 0/3'), 'Initial reading progress should be 0/3');
      assert.ok(readerInit.includes('未读'), 'Current chapter should initially be 未读');

      tty.send('M');
      const afterMark = await tty.waitFor(
        (s) => s.includes('✓ 1/3') && s.includes('已读') && s.includes('已标记章节为已读'),
        { timeoutMs: 8_000, label: 'DocumentReader updated to 1/3 read after M' },
      );
      tty.assertHealthyScreen(afterMark, 120, 36, 'DocumentReader after M toggle');
      assert.ok(afterMark.includes('✓ 1/3'), 'Header should show ✓ 1/3');
      assert.ok(afterMark.includes('已读'), 'Header should show 已读 status');

      tty.send('O');
      const outlineScreen = await tty.waitFor(
        (s) =>
          s.includes('文档目录大纲') &&
          s.includes('Chapter 1: Fundamentals') &&
          s.includes('Chapter 2: Algorithms') &&
          s.includes('✓ 1/3') &&
          !s.includes('正在读取目录结构'),
        { timeoutMs: 8_000, label: 'Lazy ReaderOutlineDrawer rendered with reading indicators' },
      );
      tty.assertHealthyScreen(outlineScreen, 120, 36, 'ReaderOutlineDrawer open');
      assert.ok(outlineScreen.includes('文档目录大纲'), 'Outline drawer header must render');
      assert.ok(outlineScreen.includes('○ Chapter 1: Fundamentals'), 'Chapter 1 should show ○ unread');
      assert.ok(outlineScreen.includes('○ Chapter 2: Algorithms'), 'Chapter 2 should show ○ unread');
      assert.ok(outlineScreen.includes('✓ Chapter 3: Practice'), 'Chapter 3 should show ✓ read');

      tty.send(' ');
      const outlineMarked = await tty.waitFor(
        (s) =>
          s.includes('✓ 2/3') &&
          s.includes('✓ Chapter 1: Fundamentals') &&
          s.includes('已标记章节为已读 (Chapter 1'),
        { timeoutMs: 8_000, label: 'ReaderOutlineDrawer toggled Chapter 1 read via Space' },
      );
      tty.assertHealthyScreen(outlineMarked, 120, 36, 'ReaderOutlineDrawer after Space');
      assert.ok(outlineMarked.includes('✓ 2/3'), 'Outline should show ✓ 2/3 after Space');
      assert.ok(outlineMarked.includes('✓ Chapter 1: Fundamentals'), 'Chapter 1 should show ✓ read after Space');

      // Press 'm' in ReaderOutlineDrawer on Chapter 1 to toggle unread -> ✓ 1/3 & ○ Chapter 1
      tty.send('m');
      const outlineUnmarked = await tty.waitFor(
        (s) =>
          s.includes('✓ 1/3') &&
          s.includes('○ Chapter 1: Fundamentals') &&
          s.includes('已取消章节已读标记'),
        { timeoutMs: 8_000, label: 'ReaderOutlineDrawer toggled Chapter 1 unread via m' },
      );
      tty.assertHealthyScreen(outlineUnmarked, 120, 36, 'ReaderOutlineDrawer after m unread');
      assert.ok(outlineUnmarked.includes('✓ 1/3'), 'Outline should revert to ✓ 1/3 after m');
      assert.ok(outlineUnmarked.includes('○ Chapter 1: Fundamentals'), 'Chapter 1 should revert to ○ unread after m');

      tty.send('\x1b');
      const afterOutlineClose = await tty.waitFor(
        (s) => !s.includes('文档目录大纲') && s.includes('✓ 1/3'),
        { timeoutMs: 8_000, label: 'ReaderOutlineDrawer closed with 1/3 progress preserved' },
      );
      tty.assertHealthyScreen(afterOutlineClose, 120, 36, 'DocumentReader after Outline close');
      assert.ok(afterOutlineClose.includes('✓ 1/3'), '1/3 progress preserved on reader header');

      tty.send('B');
      const notesScreen = await tty.waitFor(
        (s) => s.includes('批注问答与高亮标记') && !s.includes('正在加载批注与标记'),
        { timeoutMs: 8_000, label: 'Lazy ReaderNotesDrawer rendered' },
      );
      tty.assertHealthyScreen(notesScreen, 120, 36, 'ReaderNotesDrawer open');
      assert.ok(notesScreen.includes('批注问答与高亮标记'), 'Notes drawer header must render');

      tty.send('\x1b');
      const afterNotesClose = await tty.waitFor(
        (s) => !s.includes('批注问答与高亮标记') && s.includes('✓ 1/3'),
        { timeoutMs: 8_000, label: 'ReaderNotesDrawer closed cleanly' },
      );
      assert.ok(afterNotesClose.includes('Core definitions'), 'Reader body visible after closing Notes drawer');
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });

  test('3.2) PTY E2E: persistent page resume (1->3 -> remount auto-resumes 3/3 -> flush on immediate Esc) & zero leaked handles', async () => {
    const boxDir = await temps.make('r48-e2e');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    const baselineResources = resourceCounts();

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let session = null;
    try {
      const doc = await importThreePageMarkdown(host, boxDir, 'r48-zh-doc.md', 'R48 Zh Resume Doc');
      const docKey = doc.documentId;
      assert.ok(docKey, 'Imported doc must have documentId');

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const p1Screen = await openSourceInReader(session.tty, 'R48 Zh Resume Doc', 'R48 Page One Alpha');
      session.tty.assertHealthyScreen(p1Screen, 120, 36, 'DocumentReader page 1/3');
      assert.ok(p1Screen.includes('第 1 / 3 页'), 'Initial open should be at page 1/3');
      assert.ok(p1Screen.includes('R48 Page One Alpha'), 'Page 1 content visible');

      session.tty.send(']');
      const p2Screen = await session.tty.waitFor(
        (s) => s.includes('第 2 / 3 页') && s.includes('R48 Page Two Beta'),
        { timeoutMs: 5_000, label: 'Advanced to page 2/3' },
      );
      assert.ok(p2Screen.includes('第 2 / 3 页'), 'Header should show 2/3');
      assert.ok(p2Screen.includes('R48 Page Two Beta'), 'Page 2 content visible');

      session.tty.send(']');
      const p3Screen = await session.tty.waitFor(
        (s) => s.includes('第 3 / 3 页') && s.includes('R48 Page Three Gamma'),
        { timeoutMs: 5_000, label: 'Advanced to page 3/3' },
      );
      session.tty.assertHealthyScreen(p3Screen, 120, 36, 'DocumentReader page 3/3');
      assert.ok(p3Screen.includes('第 3 / 3 页'), 'Header should show 3/3');
      assert.ok(p3Screen.includes('R48 Page Three Gamma'), 'Page 3 content visible');

      const persisted3 = await waitForLastReadPage(dshHome, docKey, 3);
      assert.equal(persisted3.lastReadPages[docKey], 3);

      session.tty.send('\x1b');
      await session.tty.waitFor(
        (s) => s.includes('R48 Zh Resume Doc') && !s.includes('第 3 / 3 页'),
        { timeoutMs: 8_000, label: 'Closed DocumentReader back to SourcesView' },
      );

      cleanupAppSession(session);
      session = null;

      // Remount fresh app -> reopen DocumentReader -> auto-resumes at page 3/3 with toast
      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const resumedScreen = await openSourceInReader(session.tty, 'R48 Zh Resume Doc', 'R48 Page Three Gamma');
      assert.ok(resumedScreen.includes('第 3 / 3 页'), 'Reopen must auto-resume at page 3/3');
      if (!resumedScreen.includes('已恢复到上次阅读第 3 页')) {
        const toastScreen = await session.tty.waitFor(
          (s) => s.includes('已恢复到上次阅读第 3 页'),
          { timeoutMs: 5_000, label: 'Auto-resume toast displayed' },
        );
        assert.ok(toastScreen.includes('已恢复到上次阅读第 3 页'), 'Auto-resume toast must appear');
      }
      session.tty.assertHealthyScreen(resumedScreen, 120, 36, 'DocumentReader resumed 3/3');

      // Navigate back to page 2 and immediately close with Esc (verifies flush-on-close)
      session.tty.send('[');
      await session.tty.waitFor(
        (s) => s.includes('2 / 3') && s.includes('R48 Page Two Beta'),
        { timeoutMs: 5_000, label: 'Navigated back to page 2/3' },
      );
      session.tty.send('\x1b');
      await session.tty.waitFor(
        (s) => s.includes('R48 Zh Resume Doc') && !s.includes('R48 Page Two Beta'),
        { timeoutMs: 5_000, label: 'Closed immediately after page change' },
      );

      const persisted2 = await waitForLastReadPage(dshHome, docKey, 2);
      assert.equal(persisted2.lastReadPages[docKey], 2);
    } finally {
      cleanupAppSession(session);
      session = null;
      await host.dispose();
    }

    disposeTerminalPool();
    const deadline = Date.now() + 500;
    let afterResources = resourceCounts();
    while (
      Date.now() < deadline &&
      ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout'].some(
        (kind) => (afterResources[kind] || 0) > (baselineResources[kind] || 0),
      )
    ) {
      await new Promise((r) => setImmediate(r));
      afterResources = resourceCounts();
    }
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterResources[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0}, after=${afterResources[kind] || 0}`,
      );
    }
  });
});

describe('Reader Domain Suite 4: Marks Lifecycle & MarkPassageModal E2E', () => {
  test('4.1) PTY E2E: ReaderNotesDrawer Marks tab [r] reread, [d] delete (cancel/confirm) & [S] stale purge', async () => {
    const boxDir = await temps.make('r42-e2e');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let session = null;
    try {
      const e2eV1 = join(boxDir, 'r42-e2e-v1.md');
      await writeFile(
        e2eV1,
        '# E2E Marks v1\n\nLegacy passage from revision one that will become stale.\n',
        'utf8',
      );
      const imp1 = await host.call('materials.document.import', {
        path: e2eV1,
        title: 'R42 E2E Marks Doc',
        format: 'md',
      });
      assert.equal(imp1.ok, true);
      const docId = imp1.value.documentId;
      const staleSave = await host.call('materials.marks.save', {
        documentId: docId,
        revision: imp1.value.revision,
        style: 'underline',
        selection: {
          documentId: docId,
          revision: imp1.value.revision,
          sourceId: imp1.value.sourceIds[0],
          quote: 'Legacy passage from revision one',
        },
      });
      assert.equal(staleSave.ok, true);

      const e2eV2 = join(boxDir, 'r42-e2e-v2.md');
      await writeFile(
        e2eV2,
        '# E2E Marks v2\n\nAlpha highlight passage for Round 42 PTY verification.\n',
        'utf8',
      );
      const imp2 = await host.call('materials.document.import', {
        documentId: docId,
        path: e2eV2,
        title: 'R42 E2E Marks Doc',
        format: 'md',
      });
      assert.equal(imp2.ok, true);
      const e2eDoc = imp2.value;

      const saveZhMark = await host.call('materials.marks.save', {
        documentId: docId,
        revision: e2eDoc.revision,
        style: 'highlight',
        selection: {
          documentId: docId,
          revision: e2eDoc.revision,
          sourceId: e2eDoc.sourceIds[0],
          quote: 'Alpha highlight passage for Round 42',
        },
      });
      assert.equal(saveZhMark.ok, true);
      assert.equal(saveZhMark.value?.status, 'saved');

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const { tty } = session;

      await openSourceInReader(tty, 'R42 E2E Marks Doc', 'Alpha highlight passage');

      tty.send('B');
      await tty.waitFor(
        (s) => s.includes('批注问答与高亮标记') && !s.includes('正在加载批注与标记'),
        { timeoutMs: 8_000, label: 'ReaderNotesDrawer opened' },
      );

      tty.send('\t');
      const marksTabScreen = await tty.waitFor(
        (s) =>
          s.includes('高亮标记 (1)') &&
          s.includes('Alpha highlight passage') &&
          s.includes('旧版标记 1'),
        { timeoutMs: 8_000, label: 'Marks tab rendered with saved mark and stale count' },
      );
      tty.assertHealthyScreen(marksTabScreen, 120, 36, 'ReaderNotesDrawer Marks tab');
      assert.ok(marksTabScreen.includes('高亮标记 (1)'), 'Marks tab count must show (1)');
      assert.ok(marksTabScreen.includes('Alpha highlight passage'), 'Active mark quote must render');
      assert.ok(marksTabScreen.includes('旧版标记 1'), 'Stale badge count must render');

      tty.send('R');
      const afterRereadScreen = await tty.waitFor(
        (s) => s.includes('[已重读]') && s.includes('重读时间'),
        { timeoutMs: 8_000, label: 'Mark marked as reread with [已重读] badge' },
      );
      tty.assertHealthyScreen(afterRereadScreen, 120, 36, 'ReaderNotesDrawer after [r] reread');
      assert.ok(afterRereadScreen.includes('[已重读]'), '[已重读] badge must appear');
      assert.ok(afterRereadScreen.includes('重读时间'), 'Reread timestamp label must appear');

      const afterRereadHost = await host.call('materials.marks.list', { documentId: docId, revision: e2eDoc.revision });
      assert.equal(afterRereadHost.ok, true);
      assert.ok(afterRereadHost.value?.items?.[0]?.rereadAt, 'rereadAt must be persisted on host after [r]');

      tty.send('d');
      const deleteConfirmScreen = await tty.waitFor(
        (s) => s.includes('删除标记') && s.includes('确定要删除这条标记吗'),
        { timeoutMs: 5_000, label: 'Delete Mark ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(deleteConfirmScreen, 120, 36, 'Delete Mark ConfirmDialog');
      assert.ok(deleteConfirmScreen.includes('删除标记'), 'Delete dialog title must render');
      assert.ok(deleteConfirmScreen.includes('确定要删除这条标记吗'), 'Confirm prompt must render');

      tty.send('n');
      const afterCancelScreen = await tty.waitFor(
        (s) => !s.includes('确定要删除这条标记吗') && s.includes('高亮标记 (1)') && s.includes('Alpha highlight passage'),
        { timeoutMs: 5_000, label: 'Delete Mark ConfirmDialog cancelled cleanly' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'ReaderNotesDrawer after cancel delete');
      assert.ok(afterCancelScreen.includes('高亮标记 (1)'), 'Mark must remain after cancelling delete');
      assert.ok(afterCancelScreen.includes('Alpha highlight passage'), 'Quote must remain after cancel');

      tty.send('d');
      await tty.waitFor((s) => s.includes('删除标记'), { timeoutMs: 5_000, label: 'Delete Mark ConfirmDialog reopened' });
      tty.send('y');
      const afterDeleteScreen = await tty.waitFor(
        (s) => !s.includes('确定要删除这条标记吗') && s.includes('高亮标记 (0)') && s.includes('暂无高亮标记'),
        { timeoutMs: 8_000, label: 'Mark deleted cleanly after ConfirmDialog confirm' },
      );
      tty.assertHealthyScreen(afterDeleteScreen, 120, 36, 'ReaderNotesDrawer after delete confirm');
      assert.ok(afterDeleteScreen.includes('高亮标记 (0)'), 'Marks count must drop to (0)');
      assert.ok(afterDeleteScreen.includes('暂无高亮标记'), 'Empty marks state should show after deletion');

      tty.send('S');
      const purgeDialogScreen = await tty.waitFor(
        (s) => s.includes('清除旧版本标记') && s.includes('失效标记'),
        { timeoutMs: 5_000, label: 'Purge Stale Marks ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(purgeDialogScreen, 120, 36, 'Purge Stale ConfirmDialog');
      assert.ok(purgeDialogScreen.includes('清除旧版本标记'), 'Purge stale dialog must render');

      tty.send('y');
      const afterPurgeScreen = await tty.waitFor(
        (s) => !s.includes('清除旧版本标记') && !s.includes('旧版标记 1'),
        { timeoutMs: 8_000, label: 'Stale marks purged cleanly' },
      );
      tty.assertHealthyScreen(afterPurgeScreen, 120, 36, 'ReaderNotesDrawer after stale purge');

      const afterPurgeHost = await host.call('materials.marks.list', { documentId: docId, revision: e2eDoc.revision });
      assert.equal(afterPurgeHost.ok, true);
      assert.equal(afterPurgeHost.value?.count, 0);
      assert.deepEqual(afterPurgeHost.value?.stale, []);

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('批注问答与高亮标记'), { timeoutMs: 5_000, label: 'Drawer closed' });
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });

  test('4.2) PTY E2E: DocumentReader [H] -> MarkPassageModal (Tab cycle + key 3 + save + unchanged + ambiguous) -> ReaderNotesDrawer live', async () => {
    const boxDir = await temps.make('r44-e2e');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let session = null;
    try {
      const mdPath = join(boxDir, 'r44-mark-zh.md');
      await writeFile(
        mdPath,
        [
          '# Round 44 Invariants',
          '',
          'Unique theorem alpha states that convergence holds monotonically.',
          '',
          'Second distinct lemma beta bounds the residual error cleanly.',
          '',
          'Repeated ambiguous phrase.',
          '',
          'Repeated ambiguous phrase.',
          '',
        ].join('\n'),
        'utf8',
      );

      const imp = await host.call('materials.document.import', {
        path: mdPath,
        title: 'R44 Zh Mark Doc',
        format: 'md',
      });
      assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
      const docId = imp.value.documentId;
      const rev = imp.value.revision;

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const { tty } = session;

      const readerScreen = await openSourceInReader(tty, 'R44 Zh Mark Doc', 'Unique theorem alpha');
      tty.assertHealthyScreen(readerScreen, 120, 36, 'DocumentReader with [H] hint');
      assert.ok(readerScreen.includes('标记段落'), 'DocumentReader must show [H] 标记段落 footer hint');

      tty.send('H');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('标记当前页段落') &&
          s.includes('1:荧光笔') &&
          s.includes('2:下划线') &&
          s.includes('3:加粗') &&
          s.includes('4:待出题') &&
          s.includes('Unique theorem alpha'),
        { timeoutMs: 8_000, label: 'MarkPassageModal opened' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'MarkPassageModal open');
      assert.ok(modalScreen.includes('1:荧光笔'), 'Style option 1:荧光笔 must render');
      assert.ok(modalScreen.includes('4:待出题'), 'Style option 4:待出题 must render');
      assert.ok(modalScreen.includes('当前样式: 荧光笔'), 'Initial style should be Highlight');

      // Cycle style with Tab (荧光笔 -> 下划线)
      tty.send('\t');
      const afterTab = await tty.waitFor(
        (s) => s.includes('当前样式: 下划线') && s.includes('选中段落: 下划线'),
        { timeoutMs: 5_000, label: 'Tab cycled style to Underline' },
      );
      assert.ok(afterTab.includes('当前样式: 下划线'), 'Tab must cycle style to 下划线');
      assert.ok(afterTab.includes('选中段落: 下划线'), 'Submit label must update to 下划线');

      // Navigate with 'j' to "Unique theorem alpha..." (index 1) and select style '3' (加粗)
      tty.send('j');
      await tty.waitFor(
        (s) => s.includes('(2/5)') && s.includes('选中段落'),
        { timeoutMs: 5_000, label: 'Moved to passage 2 with j' },
      );
      tty.send('3');
      const boldSelected = await tty.waitFor(
        (s) => s.includes('当前样式: 加粗') && s.includes('选中段落: 加粗'),
        { timeoutMs: 5_000, label: 'Selected Bold style with key 3' },
      );
      assert.ok(boldSelected.includes('当前样式: 加粗'), 'Key 3 must select 加粗');

      tty.send('\r');
      const afterSaveScreen = await tty.waitFor(
        (s) => !s.includes('标记当前页段落') && s.includes('已添加加粗标记'),
        { timeoutMs: 8_000, label: 'Mark saved toast and modal closed' },
      );
      tty.assertHealthyScreen(afterSaveScreen, 120, 36, 'DocumentReader after mark save');
      assert.ok(afterSaveScreen.includes('已添加加粗标记'), 'Saved toast must appear');

      const listRes = await host.call('materials.marks.list', { documentId: docId, revision: rev });
      assert.equal(listRes.ok, true);
      assert.equal(listRes.value?.count, 1);
      assert.equal(listRes.value?.items?.[0]?.style, 'bold');
      assert.equal(
        listRes.value?.items?.[0]?.selection?.quote,
        'Unique theorem alpha states that convergence holds monotonically.',
      );

      // Open ReaderNotesDrawer (B -> Tab) and verify new mark renders live
      tty.send('B');
      await tty.waitFor(
        (s) => s.includes('批注问答与高亮标记') && !s.includes('正在加载批注与标记'),
        { timeoutMs: 8_000, label: 'ReaderNotesDrawer opened' },
      );
      tty.send('\t');
      const drawerMarksScreen = await tty.waitFor(
        (s) => s.includes('高亮标记 (1)') && s.includes('Unique theorem alpha') && s.includes('加粗'),
        { timeoutMs: 8_000, label: 'ReaderNotesDrawer Marks tab renders newly saved mark live' },
      );
      tty.assertHealthyScreen(drawerMarksScreen, 120, 36, 'ReaderNotesDrawer live mark');
      assert.ok(drawerMarksScreen.includes('Unique theorem alpha'), 'Live mark quote must render in drawer');

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('批注问答与高亮标记'), { timeoutMs: 5_000, label: 'Drawer closed' });

      // Reopen MarkPassageModal to verify unchanged + ambiguous handling
      tty.send('H');
      await tty.waitFor((s) => s.includes('标记当前页段落'), { timeoutMs: 5_000, label: 'MarkPassageModal reopened' });
      tty.send('j');
      await tty.waitFor((s) => s.includes('(2/5)'), { timeoutMs: 5_000, label: 'Moved to passage 2 on reopen' });
      tty.send('3');
      await tty.waitFor((s) => s.includes('(2/5)') && s.includes('当前样式: 加粗'), { label: 'Same passage & style' });
      tty.send('\r');
      const unchangedScreen = await tty.waitFor(
        (s) => s.includes('该段落已存在相同样式(加粗)标记'),
        { timeoutMs: 5_000, label: 'Unchanged toast shown cleanly' },
      );
      assert.ok(unchangedScreen.includes('该段落已存在相同样式(加粗)标记'), 'Unchanged toast expected');

      tty.send('j');
      await tty.waitFor((s) => s.includes('(3/5)'), { timeoutMs: 5_000, label: 'Moved to passage 3' });
      tty.send('j');
      await tty.waitFor((s) => s.includes('(4/5)'), { timeoutMs: 5_000, label: 'Moved to repeated passage' });
      tty.send('\r');
      const ambiguousScreen = await tty.waitFor(
        (s) => s.includes('出现多次') || s.includes('multiple times'),
        { timeoutMs: 5_000, label: 'Ambiguous toast shown cleanly' },
      );
      assert.ok(ambiguousScreen.includes('出现多次') || ambiguousScreen.includes('multiple times'), 'Ambiguous toast expected');
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });
});

describe('Reader Domain Suite 5: Glossary, P2 Translation Guard & Save Q&A Flashcard E2E', () => {
  test('5.1) PTY E2E: DocumentReader [G] -> add glossary -> toggle lang [l] -> Tab 2 Saved -> delete confirm -> Esc close', async () => {
    const boxDir = await temps.make('r46-e2e');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let session = null;
    try {
      const mdPath = join(boxDir, 'r46-pty-zh.md');
      await writeFile(
        mdPath,
        [
          '# Round 46 Translation Glossary',
          '',
          'FSRS updates memory stability after each recall attempt.',
          '',
        ].join('\n'),
        'utf8',
      );

      const imp = await host.call('materials.document.import', {
        path: mdPath,
        title: 'R46 Zh Glossary Doc',
        format: 'md',
      });
      assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
      const docId = imp.value.documentId;

      const docMeta = await host.call('materials.document.get', { documentId: docId });
      assert.equal(docMeta.ok, true);
      const srcId = docMeta.value.sources[0].id;

      const saved = await host.call('materials.translation.save', {
        documentId: docId,
        target: 'zh',
        passages: [
          {
            sourceId: srcId,
            text: 'FSRS updates memory stability after each recall attempt.',
            translation: 'FSRS 在每次回忆后更新记忆稳定性。',
          },
        ],
      });
      assert.equal(saved.ok, true);

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const { tty } = session;

      const readerScreen = await openSourceInReader(tty, 'R46 Zh Glossary Doc', 'FSRS updates memory stability');
      tty.assertHealthyScreen(readerScreen, 120, 36, 'DocumentReader with [G] hint');
      assert.ok(readerScreen.includes('术语译文'), 'DocumentReader must show [G] 术语译文 footer hint');

      tty.send('G');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('翻译术语表与已存译文') &&
          s.includes('1:术语表') &&
          s.includes('2:已存译文') &&
          s.includes('术语表为空'),
        { timeoutMs: 8_000, label: 'TranslationGlossaryModal opened' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'TranslationGlossaryModal open');
      assert.ok(modalScreen.includes('1:术语表'), 'Glossary tab 1 must render');
      assert.ok(modalScreen.includes('2:已存译文'), 'Saved tab 2 must render');
      assert.ok(modalScreen.includes('术语表为空'), 'Glossary should initially be empty');

      tty.send('a');
      await tty.waitFor(
        (s) => s.includes('添加术语 (1/2)') && s.includes('术语原文'),
        { timeoutMs: 5_000, label: 'Add glossary step 1 prompt' },
      );
      tty.send('FSRS');
      await tty.waitFor((s) => s.includes('术语原文: FSRS'), { timeoutMs: 5_000, label: 'Typed FSRS' });
      tty.send('\r');
      await tty.waitFor(
        (s) => s.includes('添加术语 (2/2)') && s.includes('FSRS'),
        { timeoutMs: 5_000, label: 'Add glossary step 2 prompt' },
      );
      tty.send('间隔重复算法');
      await tty.waitFor((s) => s.includes('间隔重复算法'), { timeoutMs: 5_000, label: 'Typed 间隔重复算法' });
      tty.send('\r');

      const addedScreen = await tty.waitFor(
        (s) => s.includes('FSRS → 间隔重复算法') && s.includes('1:术语表 (1)'),
        { timeoutMs: 8_000, label: 'Glossary entry persisted and rendered' },
      );
      tty.assertHealthyScreen(addedScreen, 120, 36, 'TranslationGlossaryModal after add');
      assert.ok(addedScreen.includes('1:术语表 (1)'), 'Glossary tab count must update to (1)');
      assert.ok(addedScreen.includes('FSRS → 间隔重复算法'), 'Added term mapping must render');

      const getCheck = await host.call('materials.translation.glossary.get', { documentId: docId });
      assert.equal(getCheck.ok, true);
      assert.deepEqual(getCheck.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

      // Toggle target language via 'l' (zh -> en), verify persisted, then toggle back to zh
      tty.send('l');
      const toggledEn = await tty.waitFor(
        (s) => s.includes('英文 (en)') && s.includes('EN'),
        { timeoutMs: 5_000, label: 'Target language toggled zh -> en' },
      );
      assert.ok(toggledEn.includes('英文 (en)'), 'UI must reflect switched target 英文 (en)');

      const getEnCheck = await host.call('materials.translation.glossary.get', { documentId: docId });
      assert.equal(getEnCheck.ok, true);
      assert.equal(getEnCheck.value.target, 'en');
      assert.deepEqual(getEnCheck.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

      tty.send('l');
      await tty.waitFor(
        (s) => s.includes('中文 (zh)'),
        { timeoutMs: 5_000, label: 'Target language toggled back en -> zh' },
      );

      // Switch to Tab 2 (Saved) via Tab
      tty.send('\t');
      const tab2Screen = await tty.waitFor(
        (s) => s.includes('2:已存译文 (1)') && s.includes('FSRS 在每次回忆后更新记忆稳定性'),
        { timeoutMs: 8_000, label: 'Switched to Tab 2 Saved translations' },
      );
      tty.assertHealthyScreen(tab2Screen, 120, 36, 'TranslationGlossaryModal Tab 2');
      assert.ok(tab2Screen.includes('2:已存译文 (1)'), 'Tab 2 must show 1 saved translation');

      tty.send('d');
      await tty.waitFor((s) => s.includes('删除已存译文'), { timeoutMs: 5_000, label: 'Delete ConfirmDialog' });
      tty.send('y');
      const afterDelScreen = await tty.waitFor(
        (s) => !s.includes('删除已存译文') && s.includes('2:已存译文 (0)') && s.includes('当前版本暂无已存译文'),
        { timeoutMs: 8_000, label: 'Saved translation deleted' },
      );
      assert.ok(afterDelScreen.includes('当前版本暂无已存译文'), 'Empty saved translations state expected after delete');

      tty.send('\x1b');
      const backReader = await tty.waitFor(
        (s) => !s.includes('翻译术语表与已存译文') && s.includes('FSRS updates memory stability'),
        { timeoutMs: 5_000, label: 'Closed modal back to DocumentReader' },
      );
      tty.assertHealthyScreen(backReader, 120, 36, 'DocumentReader after modal close');
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });

  test('5.2) PTY E2E: uncached page [t] opens P2 ConfirmDialog (0 model calls) -> [n] cancels -> [t]+[y] translates & caches', async () => {
    const boxDir = await temps.make('r51-uncached');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    let modelCalls = 0;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        let parsed = null;
        try {
          parsed = JSON.parse(String(prompt));
        } catch {
          parsed = null;
        }
        const passages = Array.isArray(parsed?.passages) ? parsed.passages : [];
        return JSON.stringify({
          translations: passages.map((p, idx) => ({
            id: p.id || `p${idx}`,
            text: `中文译文第 ${idx + 1} 段：反向传播通过计算图精确传播梯度。`,
          })),
        });
      },
    });

    let session = null;
    try {
      const title = 'R51 Uncached Zh Doc';
      const body = 'Attention mechanisms weigh token relevance across sequence positions dynamically.';
      const added = await host.call('source.add', { title, format: 'md', text: `${body}\n` });
      assert.equal(added.ok, true);

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const { tty } = session;

      await openSourceInReader(tty, title, 'Attention mechanisms');
      await tty.flush();

      tty.send('t');
      const confirmScreen = await tty.waitFor(
        (s) =>
          s.includes('确认翻译本页') &&
          s.includes('待翻译 1 段') &&
          s.includes('预计调用') &&
          s.includes('预计用量'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'ConfirmDialog open');
      assert.ok(confirmScreen.includes('确认翻译本页'), 'ConfirmDialog title must render');
      assert.ok(confirmScreen.includes('待翻译 1 段'), 'ConfirmDialog must show uncached passage count');
      assert.ok(confirmScreen.includes('预计调用'), 'ConfirmDialog must display estimated calls');
      assert.equal(modelCalls, 0, 'opening ConfirmDialog via [t] must invoke 0 model calls');

      tty.send('n');
      const cancelledScreen = await tty.waitFor(
        (s) => !s.includes('确认翻译本页') && s.includes('Attention mechanisms'),
        { timeoutMs: 5_000, label: 'ConfirmDialog cancelled cleanly' },
      );
      tty.assertHealthyScreen(cancelledScreen, 120, 36, 'After cancel ConfirmDialog');
      assert.ok(cancelledScreen.includes('Attention mechanisms'), 'Reader body visible after cancelling');
      assert.equal(modelCalls, 0, 'cancelling ConfirmDialog with [n] must invoke 0 model calls');

      tty.send('t');
      await tty.waitFor((s) => s.includes('确认翻译本页'), { timeoutMs: 5_000, label: 'ConfirmDialog reopened' });
      assert.equal(modelCalls, 0, 'reopening ConfirmDialog still 0 model calls');

      tty.send('y');
      const translatedScreen = await tty.waitFor(
        (s) =>
          !s.includes('确认翻译本页') &&
          s.includes('双语对照翻译') &&
          s.includes('已译 1 段') &&
          s.includes('中文译文第 1 段') &&
          s.includes('Attention mechanisms'),
        { timeoutMs: 8_000, label: 'translate-view rendered model output' },
      );
      tty.assertHealthyScreen(translatedScreen, 120, 36, 'translate-view after confirm');
      assert.ok(translatedScreen.includes('中文译文第 1 段'), 'Translated text must render');
      assert.equal(modelCalls, 1, 'confirmed translation must invoke model once');

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('双语对照翻译'), { timeoutMs: 5_000, label: 'Exited translate-view' });

      tty.send('t');
      const cachedReopen = await tty.waitFor(
        (s) => s.includes('双语对照翻译') && s.includes('已缓存 1 段') && s.includes('中文译文第 1 段'),
        { timeoutMs: 8_000, label: 'Re-pressing [t] hits cache immediately' },
      );
      tty.assertHealthyScreen(cachedReopen, 120, 36, 'translate-view cached reopen');
      assert.ok(cachedReopen.includes('已缓存 1 段'), 'Cached count must render on reopen');
      assert.equal(modelCalls, 1, 'reopening cached page must make 0 additional model calls');
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });

  test('5.3) PTY E2E: pre-cached page [t] skips P2 ConfirmDialog and renders translate-view with 0 model calls', async () => {
    const boxDir = await temps.make('r51-precached');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    let modelCalls = 0;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call on pre-cached page translation');
      },
    });

    let session = null;
    try {
      const title = 'R51 PreCached Doc';
      const zhPassage = '梯度下降法通过迭代更新参数以最小化损失函数。';
      const enTranslation = 'Gradient descent iteratively updates parameters to minimize the loss function.';

      const added = await host.call('source.add', { title, format: 'md', text: `${zhPassage}\n` });
      assert.equal(added.ok, true);
      const sourceId = added.value.id;

      const saved = await host.call('materials.translation.save', {
        sourceId,
        target: 'en',
        passages: [{ sourceId, text: zhPassage, translation: enTranslation }],
      });
      assert.equal(saved.ok, true);
      assert.equal(saved.value.saved, 1);

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'en', asciiMode: true });
      const { tty } = session;

      await openSourceInReader(tty, title, '梯度下降法通过迭代更新参数');
      await tty.flush();

      tty.send('t');
      const transScreen = await tty.waitFor(
        (s) =>
          s.includes('Bilingual Translation') &&
          s.includes('Cached 1 passages') &&
          s.includes('Gradient descent'),
        { timeoutMs: 8_000, label: 'Pre-cached translate-view rendered immediately' },
      );
      tty.assertHealthyScreen(transScreen, 120, 36, 'Pre-cached translate-view');
      tty.assertAsciiPure(transScreen, 'Pre-cached translate-view');
      assert.ok(!transScreen.includes('Confirm'), 'Pre-cached page must skip P2 ConfirmDialog');
      assert.ok(transScreen.includes('Bilingual Translation'), 'Bilingual Translation header must render');
      assert.ok(transScreen.includes('Cached 1 passages'), 'Pre-cached count must display');
      assert.ok(transScreen.includes('Gradient descent'), 'Pre-cached English translation must render');
      assert.equal(modelCalls, 0, 'pre-cached page must invoke 0 model calls');
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });

  test('5.4) PTY E2E: ask AI -> [f] hint -> save grounded Q&A flashcard (0 additional LLM calls) & duplicate guard', async () => {
    const boxDir = await temps.make('r52-e2e');
    const dshHome = join(boxDir, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    let modelCalls = 0;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot: join(boxDir, 'library'),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '依据本页原文：注意力机制通过查询与键的点积动态分配权重。';
      },
    });

    let session = null;
    try {
      const title = 'R52 Zh SaveCard Doc';
      const body = '注意力机制通过查询、键和值的缩放点积动态分配上下文权重。';
      const added = await host.call('source.add', { title, format: 'md', text: `${body}\n` });
      assert.equal(added.ok, true);

      const beforeSnap = await host.refreshSnapshot();
      const beforeDeck = beforeSnap.snapshot.decks.find(
        (d) => d.purpose === 'source-qa' || d.title === '原文问答' || d.title === 'Source Q&A',
      );
      const beforeCount = beforeDeck?.count ?? 0;

      session = await mountAppSession(host, dshHome, { initialPage: 'sources', language: 'zh', asciiMode: false });
      const { tty } = session;

      await openSourceInReader(tty, title, '注意力机制通过查询');

      tty.send('a');
      await tty.waitFor((s) => s.includes('向 AI 提问本页:'), {
        timeoutMs: 5_000,
        label: 'ask-input prompt',
      });

      tty.send('什么是注意力机制？');
      await tty.waitFor((s) => s.includes('什么是注意力机制？'), {
        timeoutMs: 5_000,
        label: 'ask-input typed question',
      });
      tty.send('\r');

      const answerScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 讲解') &&
          s.includes('依据本页原文') &&
          s.includes('[f] 存为闪卡'),
        { timeoutMs: 8_000, label: 'ask-view answer & [f] hint' },
      );
      tty.assertHealthyScreen(answerScreen, 120, 36, 'ask-view');
      assert.ok(answerScreen.includes('AI 讲解'), 'AI Answer view header must render');
      assert.ok(answerScreen.includes('依据本页原文'), 'Grounded answer must render');
      assert.ok(answerScreen.includes('[f] 存为闪卡'), '[f] Save card hint must render');
      assert.equal(modelCalls, 1, 'ask AI should invoke model once');

      tty.send('f');
      const savedScreen = await tty.waitFor(
        (s) => s.includes('已保存为原文关联闪卡') && s.includes('[f] 已存闪卡'),
        { timeoutMs: 8_000, label: 'success toast & saved state after pressing f' },
      );
      tty.assertHealthyScreen(savedScreen, 120, 36, 'after save card');
      assert.ok(savedScreen.includes('已保存为原文关联闪卡'), 'Saved flashcard toast must appear');
      assert.ok(savedScreen.includes('[f] 已存闪卡'), 'Hint must update to [f] 已存闪卡');
      assert.equal(modelCalls, 1, 'pressing f must invoke 0 additional model calls');

      const snap = await host.refreshSnapshot();
      const qaDeck = snap.snapshot.decks.find(
        (d) => d.purpose === 'source-qa' || d.title === '原文问答' || d.title === 'Source Q&A',
      );
      assert.ok(qaDeck, 'Q&A deck must be persisted in snapshot.decks');
      assert.equal(qaDeck.count, beforeCount + 1);

      const detail = await host.call('deck.get', { id: qaDeck.id });
      assert.equal(detail.ok, true);
      const persistedCard = (detail.value.cards || []).find((c) =>
        String(c.answer || '').includes('注意力机制通过查询与键的点积'),
      );
      assert.ok(persistedCard, 'persisted Q&A card must contain grounded zh answer');

      tty.send('f');
      const dupScreen = await tty.waitFor(
        (s) => s.includes('该问答卡片已存在于题组中'),
        { timeoutMs: 5_000, label: 'duplicate info toast on repeat f' },
      );
      tty.assertHealthyScreen(dupScreen, 120, 36, 'duplicate save card');
      assert.ok(dupScreen.includes('该问答卡片已存在于题组中'), 'Duplicate toast must surface cleanly');
      assert.equal(modelCalls, 1, 'repeat f must invoke 0 model calls');
    } finally {
      cleanupAppSession(session);
      await host.dispose();
    }
  });
});
