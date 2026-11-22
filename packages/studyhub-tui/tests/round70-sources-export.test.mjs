// Round 70 Track 2: SourcesView [x] Atomic Sources Catalog & Citation Coverage Markdown Export (0 LLM tokens):
// `node --test --test-concurrency=1 tests/round70-sources-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

// Bundle SourcesView from TypeScript source to unit-test formatSourcesCatalogMarkdown directly
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r70-src-unit-'));
const bundleFile = path.join(bundleDir, 'sources.mjs');
await build({
  stdin: {
    contents: `export { formatSourcesCatalogMarkdown } from './src/views/sources/SourcesView.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(bundleDir, 'node_modules'), 'junction');
const SourcesMod = await import(pathToFileURL(bundleFile).href);
assert.equal(
  typeof SourcesMod.formatSourcesCatalogMarkdown,
  'function',
  'SourcesView must export formatSourcesCatalogMarkdown',
);

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
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
      language,
      asciiMode,
    },
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r70-src-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function createVirtualTty(cols = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(30);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    assert.ok(!screen.includes('\x1b'), `${label}: unparsed escape sequence leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 70 Track 2: SourcesView [x] Atomic Sources Catalog & Citation Coverage Markdown Export', () => {
  test('1) Unit: formatSourcesCatalogMarkdown renders zh & en tables, pipe escaping, pinned/archived/active statuses, filters & empty list', () => {
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

    const zhMd = SourcesMod.formatSourcesCatalogMarkdown({
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

    const enMd = SourcesMod.formatSourcesCatalogMarkdown({
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

    const emptyEn = SourcesMod.formatSourcesCatalogMarkdown({
      groups: [],
      lang: 'en',
      generatedAt: '2026-11-22',
    });
    assert.ok(emptyEn.includes('**Total Documents**: 0'));
    assert.ok(emptyEn.includes('No materials match the current filters.'));
    assert.ok(!emptyEn.includes('| # | Title |'), 'empty list must not emit summary table');
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): add 2 sample sources -> SourcesView (2) -> [x] exports studyhub-sources-*.md (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
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

    const add1 = await host.call('source.add', {
      title: 'Operating Systems Ch1 Notes',
      text: '# Operating Systems\nVirtual memory and TLB lookup flow.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add1.ok, true, add1.error?.message);

    const add2 = await host.call('source.add', {
      title: 'Computer Networks | Routing Lab',
      text: '# Routing Lab\nLink-state vs distance-vector protocols.',
      courses: ['CS302'],
      format: 'md',
    });
    assert.equal(add2.ok, true, add2.error?.message);

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
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
      await tty.waitFor(
        () => useDistTuiStore.getState().page === 'library' && Boolean(useDistTuiStore.getState().snapshot),
        { label: 'zh LibraryView ready' },
      );

      // Navigate to SourcesView via '2'
      tty.send('2');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'sources' &&
          s.includes('Operating Systems Ch1 Notes') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === '导出目录'),
        { timeoutMs: 10_000, label: 'zh SourcesView rendered with CS301 source & [x] hint' },
      );

      // Toggle course filter off ('f') so both CS301 & CS302 sources are visible
      tty.send('f');
      const srcScreen = await tty.waitFor(
        (s) =>
          s.includes('全部课程') &&
          s.includes('Operating Systems Ch1') &&
          s.includes('Computer Networks | Routing Lab'),
        { timeoutMs: 10_000, label: 'zh SourcesView All Courses showing both sources' },
      );
      tty.assertHealthyScreen(srcScreen, 120, 36, 'zh SourcesView 120x36');

      const expectedPath = join(libraryRoot, 'backups', `studyhub-sources-${todayLocalYmd()}.md`);
      tty.send('x');
      const afterExport = await tty.waitFor(
        (s) =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出 2 份资料目录') && toast.text.includes(expectedPath)) &&
          s.includes('已导出 2 份资料目录'),
        { timeoutMs: 10_000, label: 'zh SourcesView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh SourcesView after [x] export');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub 学习资料目录与引用覆盖'), 'exported MD must have zh heading');
      assert.ok(exportedMd.includes('| # | 标题 | 课程 | 文件夹 | 页数 | 关联题 | 状态 |'), 'exported MD must have table header');
      assert.ok(exportedMd.includes('Operating Systems Ch1 Notes'), 'exported MD must include source 1 title');
      assert.ok(exportedMd.includes('Computer Networks \\| Routing Lab'), 'exported MD must escape pipe in source 2 title');
      assert.ok(exportedMd.includes('**资料总数**: 2'), 'exported MD must include document count');
      assert.ok(!exportedMd.includes('**课程筛选**:'), 'exported MD should omit course filter when All Courses active');
      assert.equal(modelCalls, 0, 'SourcesView [x] export must invoke 0 model calls');
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

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): SourcesView (2) -> [x] export -> assertHealthyScreen + assertAsciiPure + valid .md', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'en',
      eventDebounceMs: 30,
    });

    const add1 = await host.call('source.add', {
      title: 'Algorithms Lecture 1',
      text: '# Asymptotic Analysis\nBig-O and Master Theorem.',
      courses: ['CS201'],
      format: 'md',
    });
    assert.equal(add1.ok, true, add1.error?.message);

    const add2 = await host.call('source.add', {
      title: 'Database Systems Summary',
      text: '# B+ Trees\nConcurrency control and ARIES recovery.',
      courses: ['CS201'],
      format: 'md',
    });
    assert.equal(add2.ok, true, add2.error?.message);

    const tty = createVirtualTty(80, 24);
    let inkInst = null;
    try {
      resetDistStore('en', true);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
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
      await tty.waitFor(
        () => useDistTuiStore.getState().page === 'library' && Boolean(useDistTuiStore.getState().snapshot),
        { label: 'en LibraryView ready' },
      );

      tty.send('2');
      const srcScreen = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'sources' &&
          s.includes('Algorithms Lecture 1') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === 'Export MD'),
        { timeoutMs: 10_000, label: 'en SourcesView 80x24 with sources & [x] hint' },
      );
      tty.assertHealthyScreen(srcScreen, 80, 24, 'en SourcesView 80x24');
      tty.assertAsciiPure(srcScreen, 'en SourcesView 80x24');

      const expectedPath = join(libraryRoot, 'backups', `studyhub-sources-${todayLocalYmd()}.md`);
      tty.send('x');
      const afterExport = await tty.waitFor(
        () =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported 2 source(s) ->') &&
                toast.text.includes(expectedPath),
            ),
        { timeoutMs: 10_000, label: 'en SourcesView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 80, 24, 'en SourcesView after [x] export 80x24');
      tty.assertAsciiPure(afterExport, 'en SourcesView after [x] export 80x24');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub Materials Catalog & Citation Coverage'), 'exported MD must have en heading');
      assert.ok(exportedMd.includes('| # | Title | Course(s) | Folder | Pages | Linked Cards | Status |'), 'exported MD must have en table header');
      assert.ok(exportedMd.includes('Algorithms Lecture 1'), 'exported MD must include source 1');
      assert.ok(exportedMd.includes('Database Systems Summary'), 'exported MD must include source 2');
      assert.ok(exportedMd.includes('**Course Filter**: CS201'), 'exported MD must include active course filter');
      assert.ok(exportedMd.includes('**Total Documents**: 2'), 'exported MD must include total documents');
      assert.equal(modelCalls, 0, 'SourcesView [x] export must invoke 0 model calls');
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
