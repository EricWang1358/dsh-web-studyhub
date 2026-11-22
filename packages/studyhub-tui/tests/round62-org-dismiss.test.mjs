// Round 62 Track 3: OrganizeSourcesModal & FolderModal pending dismiss (`source.organize.dismiss`, `source.folder.dismiss`)
// createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round62-org-dismiss.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { Store } from '../../../lib/store.js';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') {
      H = {
        createTuiHost: mod.createTuiHost,
        saveTuiPreferences: mod.saveTuiPreferences,
      };
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

for (const prefix of ['OrganizeSourcesModal-', 'FolderModal-']) {
  const chunk = distFiles.find((f) => f.startsWith(prefix) && f.endsWith('.mjs'));
  assert.ok(chunk, `dist/ must emit lazy ${prefix}*.mjs chunk, found: ${distFiles.join(', ')}`);
  const code = fs.readFileSync(join(distDir, chunk), 'utf8');
  assert.equal(/\bmarked\b/.test(code), false, `${chunk} must be marked-free`);
  assert.equal(/\bcli-highlight\b/.test(code), false, `${chunk} must not bundle cli-highlight`);
  assert.equal(/src\/components\/MarkdownView\.tsx/.test(code), false, `${chunk} must not bundle MarkdownView`);
}

const { createTuiHost, saveTuiPreferences } = H;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round62-org-dismiss-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
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
      language,
      asciiMode,
    },
  });
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
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${label}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
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

function createZeroCallStub(counterRef) {
  return async () => {
    counterRef.calls += 1;
    throw new Error('Unexpected LLM call during pending dismiss flow');
  };
}

async function seedMaterialsAndPending(host, libraryRoot) {
  const s1 = await host.call('source.add', {
    title: 'Linear Algebra Lecture Notes',
    text: '# Eigenvalues and Eigenvectors\nA matrix A satisfies Av = lambda v for nonzero vector v.',
  });
  assert.equal(s1.ok, true, `source.add 1 failed: ${s1.error?.message}`);

  const s2 = await host.call('source.add', {
    title: 'Operating Systems Virtual Memory',
    text: '# Page Tables and TLB\nVirtual addresses translate to physical frames via multi-level page tables.',
  });
  assert.equal(s2.ok, true, `source.add 2 failed: ${s2.error?.message}`);

  const snapBefore = await host.refreshSnapshot();
  const sources = snapBefore.snapshot?.sources ?? [];
  assert.equal(sources.length, 2, 'Expected 2 seeded sources');

  const organizeJobId = 'job-org-pending-r62';
  const classifyJobId = 'job-cls-pending-r62';
  const createdAt = '2026-11-22T12:00:00.000Z';

  await new Store(libraryRoot).update((s) => {
    s.settings ||= {};
    s.settings.materialOrganizePending = {
      jobId: organizeJobId,
      createdAt,
      proposals: [
        {
          id: sources[0].id,
          title: sources[0].title,
          courses: ['Linear Algebra'],
          expectedCourses: [],
          reason: 'Covers matrix eigenvalues and linear transforms',
        },
        {
          id: sources[1].id,
          title: sources[1].title,
          courses: ['Operating Systems'],
          expectedCourses: [],
          reason: 'Covers page tables and TLB',
        },
      ],
    };
    const classifyEntry = {
      jobId: classifyJobId,
      createdAt,
      course: '',
      folders: ['Algebra', 'Systems'],
      suggestions: [
        {
          key: `source:${sources[0].id}`,
          title: sources[0].title,
          currentFolder: null,
          suggestedFolder: 'Algebra',
        },
        {
          key: `source:${sources[1].id}`,
          title: sources[1].title,
          currentFolder: null,
          suggestedFolder: 'Systems',
        },
      ],
      unmatchedKeys: [],
    };
    s.settings.materialClassifyPending = classifyEntry;
    s.settings.materialClassifyPendingByCourse = { '*': classifyEntry };
  });

  const snapAfter = await host.refreshSnapshot();
  return {
    organizeJobId,
    classifyJobId,
    snapshot: snapAfter.snapshot,
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 62 Track 3: OrganizeSourcesModal & FolderModal pending dismiss', () => {
  test('1) createTuiHost integration (0 model calls): source.organize.dismiss & source.folder.dismiss empty vs seeded', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createZeroCallStub(counter),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    try {
      // Empty dismiss calls return { dismissed: false }
      const emptyOrg = await host.call('source.organize.dismiss', {});
      assert.equal(emptyOrg.ok, true);
      assert.equal(emptyOrg.value?.dismissed, false);

      const emptyCls = await host.call('source.folder.dismiss', {});
      assert.equal(emptyCls.ok, true);
      assert.equal(emptyCls.value?.dismissed, false);

      // Seed materials + pending proposals
      const seeded = await seedMaterialsAndPending(host, libraryRoot);
      assert.ok(seeded.snapshot?.settings?.materialOrganizePending, 'snapshot must expose materialOrganizePending');
      assert.ok(seeded.snapshot?.settings?.materialClassifyPending, 'snapshot must expose materialClassifyPending');

      // Dismiss seeded pending organize proposals
      const orgRes = await host.call('source.organize.dismiss', { jobId: seeded.organizeJobId });
      assert.equal(orgRes.ok, true, `source.organize.dismiss failed: ${orgRes.error?.message}`);
      assert.equal(orgRes.value?.dismissed, true);

      // Dismiss seeded pending folder classification proposals
      const clsRes = await host.call('source.folder.dismiss', {});
      assert.equal(clsRes.ok, true, `source.folder.dismiss failed: ${clsRes.error?.message}`);
      assert.equal(clsRes.value?.dismissed, true);

      // Verify snapshot cleared and subsequent dismiss returns false
      const afterSnap = await host.refreshSnapshot();
      assert.equal(afterSnap.snapshot?.settings?.materialOrganizePending, undefined);
      assert.equal(afterSnap.snapshot?.settings?.materialClassifyPending, undefined);
      assert.equal(afterSnap.snapshot?.settings?.materialClassifyPendingByCourse, undefined);

      const secondOrg = await host.call('source.organize.dismiss', {});
      assert.equal(secondOrg.ok, true);
      assert.equal(secondOrg.value?.dismissed, false);

      const secondCls = await host.call('source.folder.dismiss', {});
      assert.equal(secondCls.ok, true);
      assert.equal(secondCls.value?.dismissed, false);

      assert.equal(counter.calls, 0, 'All dismiss operations must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): G -> pending banner -> X dismiss -> Esc -> F -> pending banner -> X dismiss -> Esc', async () => {
    const base = await makeTempDir('e2e-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createZeroCallStub(counter),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    await seedMaterialsAndPending(host, libraryRoot);

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
      await tty.waitFor(
        (s) => s.includes('学习库') || s.includes('Library'),
        { timeoutMs: 8_000, label: 'Initial LibraryView zh' },
      );

      // Navigate to SourcesView ('2')
      tty.send('2');
      const sourcesScreen = await tty.waitFor(
        (s) => s.includes('Linear Algebra Lecture Notes') && !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'SourcesView zh' },
      );
      tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView zh');
      assert.equal(counter.calls, 0);

      // Press 'G' -> OrganizeSourcesModal shows pending banner (0 model calls)
      tty.send('G');
      const orgPendingScreen = await tty.waitFor(
        (s) => s.includes('待审归类建议 2') && s.includes('[X] 清除'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal pending banner zh' },
      );
      tty.assertHealthyScreen(orgPendingScreen, 120, 36, 'OrganizeSourcesModal pending zh');
      assert.equal(counter.calls, 0);

      // Press 'X' -> dismisses pending organize proposals & shows toast
      tty.send('X');
      const orgDismissedScreen = await tty.waitFor(
        (s) =>
          s.includes('已清除待处理的课程归类建议') &&
          !s.includes('待审归类建议'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal dismissed toast zh' },
      );
      tty.assertHealthyScreen(orgDismissedScreen, 120, 36, 'OrganizeSourcesModal dismissed zh');
      assert.equal(counter.calls, 0);

      // Press 'Esc' -> returns to SourcesView
      tty.send('\x1b');
      const afterOrgClose = await tty.waitFor(
        (s) =>
          !s.includes('AI 分析资料所属课程') &&
          !s.includes('AI 智能整理课程归属') &&
          s.includes('学习资料库'),
        { timeoutMs: 8_000, label: 'SourcesView after OrganizeSourcesModal Esc zh' },
      );
      tty.assertHealthyScreen(afterOrgClose, 120, 36, 'SourcesView after Org Esc zh');

      // Press 'F' -> FolderModal shows pending classify banner (0 model calls)
      tty.send('F');
      const folderPendingScreen = await tty.waitFor(
        (s) => s.includes('待审分夹 2') && s.includes('[X] 清除待审分夹建议'),
        { timeoutMs: 8_000, label: 'FolderModal pending banner zh' },
      );
      tty.assertHealthyScreen(folderPendingScreen, 120, 36, 'FolderModal pending zh');
      assert.equal(counter.calls, 0);

      // Press 'X' -> dismisses pending folder classify proposals & shows toast
      tty.send('X');
      const folderDismissedScreen = await tty.waitFor(
        (s) =>
          s.includes('已清除待审文件夹分类建议') &&
          !s.includes('待审分夹 2'),
        { timeoutMs: 8_000, label: 'FolderModal dismissed toast zh' },
      );
      tty.assertHealthyScreen(folderDismissedScreen, 120, 36, 'FolderModal dismissed zh');
      assert.equal(counter.calls, 0);

      // Press 'Esc' -> closes FolderModal cleanly
      tty.send('\x1b');
      const afterFolderClose = await tty.waitFor(
        (s) => !s.includes('资料文件夹管理') && s.includes('学习资料库'),
        { timeoutMs: 8_000, label: 'SourcesView after FolderModal Esc zh' },
      );
      tty.assertHealthyScreen(afterFolderClose, 120, 36, 'SourcesView after Folder Esc zh');

      const finalSnap = await host.refreshSnapshot();
      assert.equal(finalSnap.snapshot?.settings?.materialOrganizePending, undefined);
      assert.equal(finalSnap.snapshot?.settings?.materialClassifyPending, undefined);
      assert.equal(counter.calls, 0);
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore teardown errors
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): pending dismiss flow passes assertHealthyScreen & assertAsciiPure with 0 model calls', async () => {
    const base = await makeTempDir('e2e-ascii');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    resetDistStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createZeroCallStub(counter),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    await seedMaterialsAndPending(host, libraryRoot);

    const tty = createVirtualTty(80, 24);
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
      await tty.waitFor(
        (s) => s.includes('Library'),
        { timeoutMs: 8_000, label: 'Initial LibraryView en ascii' },
      );

      // Navigate to SourcesView ('2')
      tty.send('2');
      const sourcesScreen = await tty.waitFor(
        (s) => s.includes('Linear Algebra') && !s.includes('Loading'),
        { timeoutMs: 8_000, label: 'SourcesView en ascii' },
      );
      tty.assertHealthyScreen(sourcesScreen, 80, 24, 'SourcesView en ascii');
      tty.assertAsciiPure(sourcesScreen, 'SourcesView en ascii');
      assert.equal(counter.calls, 0);

      // Press 'G' -> OrganizeSourcesModal pending banner
      tty.send('G');
      const orgPending = await tty.waitFor(
        (s) => s.includes('Pending organize 2') && s.includes('[X] Dismiss'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal pending en ascii' },
      );
      tty.assertHealthyScreen(orgPending, 80, 24, 'OrganizeSourcesModal pending en ascii');
      tty.assertAsciiPure(orgPending, 'OrganizeSourcesModal pending en ascii');
      assert.equal(counter.calls, 0);

      // Press 'X' -> dismisses pending organize proposals
      tty.send('X');
      const orgDismissed = await tty.waitFor(
        (s) =>
          s.includes('Dismissed pending') &&
          !s.includes('Pending organize 2'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal dismissed en ascii' },
      );
      tty.assertHealthyScreen(orgDismissed, 80, 24, 'OrganizeSourcesModal dismissed en ascii');
      tty.assertAsciiPure(orgDismissed, 'OrganizeSourcesModal dismissed en ascii');
      assert.equal(counter.calls, 0);

      // Press 'Esc' -> close OrganizeSourcesModal
      tty.send('\x1b');
      const afterOrgEsc = await tty.waitFor(
        (s) =>
          !s.includes('AI Organize Materials by Course') &&
          !s.includes('AI Organize Courses') &&
          s.includes('Sources'),
        { timeoutMs: 8_000, label: 'SourcesView after Org Esc en ascii' },
      );
      tty.assertHealthyScreen(afterOrgEsc, 80, 24, 'SourcesView after Org Esc en ascii');
      tty.assertAsciiPure(afterOrgEsc, 'SourcesView after Org Esc en ascii');

      // Press 'F' -> FolderModal pending banner
      tty.send('F');
      const folderPending = await tty.waitFor(
        (s) => s.includes('Pending classify 2') && s.includes('[X] Dismiss pending'),
        { timeoutMs: 8_000, label: 'FolderModal pending en ascii' },
      );
      tty.assertHealthyScreen(folderPending, 80, 24, 'FolderModal pending en ascii');
      tty.assertAsciiPure(folderPending, 'FolderModal pending en ascii');
      assert.equal(counter.calls, 0);

      // Press 'X' -> dismisses pending folder classify proposals
      tty.send('X');
      const folderDismissed = await tty.waitFor(
        (s) =>
          s.includes('Dismissed pending') &&
          !s.includes('Pending classify 2'),
        { timeoutMs: 8_000, label: 'FolderModal dismissed en ascii' },
      );
      tty.assertHealthyScreen(folderDismissed, 80, 24, 'FolderModal dismissed en ascii');
      tty.assertAsciiPure(folderDismissed, 'FolderModal dismissed en ascii');
      assert.equal(counter.calls, 0);

      // Press 'Esc' -> close FolderModal
      tty.send('\x1b');
      const afterFolderEsc = await tty.waitFor(
        (s) => !s.includes('Material Folders') && s.includes('Sources'),
        { timeoutMs: 8_000, label: 'SourcesView after Folder Esc en ascii' },
      );
      tty.assertHealthyScreen(afterFolderEsc, 80, 24, 'SourcesView after Folder Esc en ascii');
      tty.assertAsciiPure(afterFolderEsc, 'SourcesView after Folder Esc en ascii');

      const finalSnap = await host.refreshSnapshot();
      assert.equal(finalSnap.snapshot?.settings?.materialOrganizePending, undefined);
      assert.equal(finalSnap.snapshot?.settings?.materialClassifyPending, undefined);
      assert.equal(counter.calls, 0);
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore teardown errors
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
