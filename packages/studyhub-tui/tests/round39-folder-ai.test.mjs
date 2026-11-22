// Round 39 FolderModal AI Auto-Classify (source.folder.suggest + source.folder.apply) E2E verification:
// node --test tests/round39-folder-ai.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round39-folder-ai-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
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
    resize,
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

function resetTuiStore() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: true,
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
  });
}

async function addTextSource(host, title, text) {
  const res = await host.call('source.add', { title, text });
  assert.equal(res.ok, true, `source.add(${title}) failed: ${res.error?.message || ''}`);
  const id = res.value?.source?.id || res.value?.id;
  assert.ok(id, `source.add(${title}) must return source id`);
  return `source:${id}`;
}

function buildFolderSuggestReply(prompt, folderByTitle) {
  const firstBreak = prompt.indexOf('\n');
  const payload = JSON.parse(firstBreak >= 0 ? prompt.slice(0, firstBreak) : prompt);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const assignments = items.map((item) => ({
    id: item.id,
    folder: folderByTitle[item.title] || 'General Topics',
  }));
  const folders = [...new Set(assignments.map((a) => a.folder))];
  return JSON.stringify({ folders, assignments });
}

describe('Round 39: FolderModal AI Auto-Classify (source.folder.suggest + source.folder.apply)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: source.folder.suggest -> source.folder.apply persists folders in snapshot', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const folderMap = {
      'OS Kernel Notes': 'Operating Systems',
      'SQL B-Tree Index': 'Databases',
      'TCP Congestion Control': 'Networking',
    };
    let modelCalls = 0;

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        return buildFolderSuggestReply(prompt, folderMap);
      },
    });

    try {
      const keyOs = await addTextSource(host, 'OS Kernel Notes', 'Virtual memory and page tables.');
      const keyDb = await addTextSource(host, 'SQL B-Tree Index', 'Database indexing and B+ trees.');
      const keyNet = await addTextSource(host, 'TCP Congestion Control', 'AIMD and slow start.');

      const suggestRes = await host.call('source.folder.suggest', {
        mode: 'auto',
        language: 'en',
      });
      assert.equal(suggestRes.ok, true, `source.folder.suggest failed: ${suggestRes.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'source.folder.suggest must invoke model exactly once for <=60 items');

      const suggestions = suggestRes.value?.suggestions;
      assert.ok(Array.isArray(suggestions) && suggestions.length === 3, 'Expected 3 folder suggestions');
      const suggestedByKey = new Map(suggestions.map((s) => [s.key, s]));
      assert.equal(suggestedByKey.get(keyOs)?.suggestedFolder, 'Operating Systems');
      assert.equal(suggestedByKey.get(keyDb)?.suggestedFolder, 'Databases');
      assert.equal(suggestedByKey.get(keyNet)?.suggestedFolder, 'Networking');
      assert.equal(suggestedByKey.get(keyOs)?.currentFolder, null);

      // Verify suggest is strictly read-only before apply
      const snapBefore = await host.call('snapshot', {});
      assert.equal(snapBefore.ok, true);
      assert.deepEqual(snapBefore.value?.settings?.materialFolders?.folders ?? [], []);
      assert.deepEqual(snapBefore.value?.settings?.materialFolders?.items ?? {}, {});

      // Apply suggestions via source.folder.apply
      const applyRes = await host.call('source.folder.apply', {
        assignments: suggestions.map((s) => ({ key: s.key, folder: s.suggestedFolder })),
      });
      assert.equal(applyRes.ok, true, `source.folder.apply failed: ${applyRes.error?.message || ''}`);
      assert.equal(applyRes.value?.updated, 3);

      const snapAfter = await host.call('snapshot', {});
      assert.equal(snapAfter.ok, true);
      const mf = snapAfter.value?.settings?.materialFolders;
      assert.ok(mf, 'snapshot.settings.materialFolders must be populated');
      assert.equal(mf.items[keyOs], 'Operating Systems');
      assert.equal(mf.items[keyDb], 'Databases');
      assert.equal(mf.items[keyNet], 'Networking');
      assert.ok(mf.folders.includes('Operating Systems'));
      assert.ok(mf.folders.includes('Databases'));
      assert.ok(mf.folders.includes('Networking'));

      // Re-open host to confirm persistence on disk
      await host.dispose();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      const reloaded = await host.call('snapshot', {});
      assert.equal(reloaded.ok, true);
      assert.equal(reloaded.value?.settings?.materialFolders?.items?.[keyOs], 'Operating Systems');
      assert.equal(reloaded.value?.settings?.materialFolders?.items?.[keyDb], 'Databases');
      assert.equal(reloaded.value?.settings?.materialFolders?.items?.[keyNet], 'Networking');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: FolderModal [g] P2 ConfirmDialog guard, Esc/n cancel (0 calls), preview & apply in zh and --ascii en', async () => {
    // --- Part A: Default mode (zh) ---
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetTuiStore();

    const zhFolderMap = {
      'OS Kernel Notes': '操作系统',
      'SQL B-Tree Index': '数据库原理',
      'TCP Congestion Control': '计算机网络',
    };
    let zhModelCalls = 0;

    let releaseSuggest = null;
    let suggestGate = null;

    const hostZh = await createTuiHost({
      libraryRoot: join(baseZh, 'library'),
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, prompt) => {
        zhModelCalls += 1;
        if (suggestGate) await suggestGate;
        return buildFolderSuggestReply(prompt, zhFolderMap);
      },
    });

    const keyOs = await addTextSource(hostZh, 'OS Kernel Notes', 'Virtual memory and scheduling.');
    const keyDb = await addTextSource(hostZh, 'SQL B-Tree Index', 'Indexes and transactions.');
    const keyNet = await addTextSource(hostZh, 'TCP Congestion Control', 'Routing and TCP.');

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;

      await ttyZh.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Open SourcesView ('2') then FolderModal ('F')
      ttyZh.send('2');
      await ttyZh.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('OS Kernel Notes'),
        { label: 'zh SourcesView ready' },
      );

      ttyZh.send('F');
      const folderListScreen = await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && s.includes('AI分类'),
        { label: 'zh FolderModal open with [g] AI分类 hint' },
      );
      ttyZh.assertHealthyScreen(folderListScreen, 120, 36, 'zh FolderModal list');
      assert.equal(zhModelCalls, 0, 'Opening FolderModal must make 0 model calls');

      // Press 'g' -> ConfirmDialog appears with 0 model calls
      ttyZh.send('g');
      const confirmScreen1 = await ttyZh.waitFor(
        (s) => s.includes('AI 智能文件夹分类') && s.includes('确认应用前不会修改任何文件夹'),
        { label: 'zh P2 ConfirmDialog open after g' },
      );
      ttyZh.assertHealthyScreen(confirmScreen1, 120, 36, 'zh ConfirmDialog');
      assert.equal(zhModelCalls, 0, 'P2 guard: 0 model calls before ConfirmDialog confirmation');

      // Press Esc to cancel cleanly (still 0 model calls)
      ttyZh.send('\u001b');
      await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && !s.includes('AI 智能文件夹分类'),
        { label: 'zh ConfirmDialog cancelled with Esc' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling ConfirmDialog with Esc must keep model calls at 0');

      // Open ConfirmDialog again and cancel with 'n'
      ttyZh.send('g');
      await ttyZh.waitFor((s) => s.includes('AI 智能文件夹分类'), { label: 'zh ConfirmDialog re-open' });
      assert.equal(zhModelCalls, 0, 'Re-opening ConfirmDialog must keep model calls at 0');
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && !s.includes('AI 智能文件夹分类'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling ConfirmDialog with n must keep model calls at 0');

      // Press 'g' -> 'y' with an active gate to verify busyRef ignores keys while running
      suggestGate = new Promise((resolveFn) => {
        releaseSuggest = resolveFn;
      });
      ttyZh.send('g');
      await ttyZh.waitFor((s) => s.includes('AI 智能文件夹分类'), { label: 'zh ConfirmDialog before gated y' });
      ttyZh.send('y');
      await ttyZh.waitFor(
        (s) => s.includes('正在调用 AI 生成文件夹建议'),
        { label: 'zh FolderModal spinner while suggesting' },
      );
      // While running, Esc and extra 'g' must be ignored by busyRef
      ttyZh.send('\u001b');
      ttyZh.send('g');
      await ttyZh.flush();
      assert.equal(zhModelCalls, 1, 'busyRef must prevent duplicate model calls while running');

      releaseSuggest();
      suggestGate = null;

      // Inspect preview list with { source -> folder }
      const previewScreen = await ttyZh.waitFor(
        (s) => s.includes('AI 文件夹分类预览') && s.includes('→') && s.includes('操作系统') && s.includes('数据库原理'),
        { label: 'zh AI Folder Preview rendered' },
      );
      ttyZh.assertHealthyScreen(previewScreen, 120, 36, 'zh AI Folder Preview');

      // Test Esc discards preview cleanly without applying
      ttyZh.send('\u001b');
      await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && !s.includes('AI 文件夹分类预览'),
        { label: 'zh Esc discards preview back to folder list' },
      );
      assert.deepEqual(
        useTuiStore.getState().snapshot?.settings?.materialFolders?.folders ?? [],
        [],
        'Discarding preview with Esc must not persist any folders',
      );

      // Re-run 'g' -> 'y' -> inspect preview -> 'Enter' to apply
      ttyZh.send('g');
      await ttyZh.waitFor((s) => s.includes('AI 智能文件夹分类'), { label: 'zh ConfirmDialog before apply' });
      ttyZh.send('y');
      await ttyZh.waitFor(
        (s) => s.includes('AI 文件夹分类预览') && s.includes('计算机网络'),
        { label: 'zh AI Folder Preview before Enter' },
      );
      assert.equal(zhModelCalls, 2);

      // Scroll preview list with j / k
      ttyZh.send('j');
      await ttyZh.flush();
      ttyZh.send('k');
      await ttyZh.flush();

      // Apply with Enter
      useTuiStore.setState({ toasts: [] });
      ttyZh.send('\r');
      await ttyZh.waitFor(
        (s) =>
          s.includes('资料文件夹管理') &&
          !s.includes('AI 文件夹分类预览') &&
          s.includes('操作系统') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已应用 3 份资料')),
        { label: 'zh Enter applies AI folder suggestions' },
      );

      const snapZh = useTuiStore.getState().snapshot;
      assert.equal(snapZh?.settings?.materialFolders?.items?.[keyOs], '操作系统');
      assert.equal(snapZh?.settings?.materialFolders?.items?.[keyDb], '数据库原理');
      assert.equal(snapZh?.settings?.materialFolders?.items?.[keyNet], '计算机网络');

      // Check 80x24 narrow layout in zh default mode
      ttyZh.resize(80, 24);
      const narrowZh = await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && s.includes('操作系统') && s.split('\n').length <= 24,
        { label: 'zh FolderModal 80x24' },
      );
      ttyZh.assertHealthyScreen(narrowZh, 80, 24, 'zh FolderModal 80x24');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();
    }

    // --- Part B: --ascii mode (en) ---
    const baseEn = await makeTempDir('pty-en');
    const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
    process.env.DSH_HOME = envEn.DSH_HOME;

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
    resetTuiStore();

    const enFolderMap = {
      'OS Kernel Notes': 'Operating Systems',
      'SQL B-Tree Index': 'Databases',
      'TCP Congestion Control': 'Networking',
    };
    let enModelCalls = 0;

    const hostEn = await createTuiHost({
      libraryRoot: join(baseEn, 'library'),
      env: envEn,
      home: baseEn,
      documentsDir: baseEn,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, prompt) => {
        enModelCalls += 1;
        return buildFolderSuggestReply(prompt, enFolderMap);
      },
    });

    const enKeyOs = await addTextSource(hostEn, 'OS Kernel Notes', 'Virtual memory and scheduling.');
    const enKeyDb = await addTextSource(hostEn, 'SQL B-Tree Index', 'Indexes and transactions.');
    const enKeyNet = await addTextSource(hostEn, 'TCP Congestion Control', 'Routing and TCP.');

    const ttyEn = createVirtualTty(120, 36);
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
        stdin: ttyEn.stdin,
        stdout: ttyEn.stdout,
        stderr: ttyEn.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyEn.firstFramePromise;

      await ttyEn.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      ttyEn.send('2');
      await ttyEn.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('OS Kernel Notes'),
        { label: 'en --ascii SourcesView ready' },
      );

      ttyEn.send('F');
      const enFolderScreen = await ttyEn.waitFor(
        (s) => s.includes('Material Folders') && s.includes('AI Classify'),
        { label: 'en --ascii FolderModal open' },
      );
      ttyEn.assertHealthyScreen(enFolderScreen, 120, 36, 'en --ascii FolderModal 120x36');
      ttyEn.assertAsciiPure(enFolderScreen, 'en --ascii FolderModal 120x36');
      assert.equal(enModelCalls, 0);

      // Press 'g' -> ConfirmDialog -> 0 model calls
      ttyEn.send('g');
      const enConfirmScreen = await ttyEn.waitFor(
        (s) => s.includes('AI Auto-Classify Folders') && s.includes('Preview only - no') && s.includes('Analyze (y)'),
        { label: 'en --ascii ConfirmDialog open' },
      );
      ttyEn.assertHealthyScreen(enConfirmScreen, 120, 36, 'en --ascii ConfirmDialog');
      ttyEn.assertAsciiPure(enConfirmScreen, 'en --ascii ConfirmDialog');
      assert.equal(enModelCalls, 0);

      // Press 'y' -> inspect preview with ASCII '->'
      ttyEn.send('y');
      const enPreviewWide = await ttyEn.waitFor(
        (s) => s.includes('AI Folder Preview') && s.includes('->') && s.includes('Operating Systems') && s.includes('Databases'),
        { label: 'en --ascii AI Folder Preview 120x36' },
      );
      ttyEn.assertHealthyScreen(enPreviewWide, 120, 36, 'en --ascii Preview 120x36');
      ttyEn.assertAsciiPure(enPreviewWide, 'en --ascii Preview 120x36');
      assert.equal(enModelCalls, 1);

      // Resize preview to 80x24 and verify ASCII purity & bounds
      ttyEn.resize(80, 24);
      const enPreviewNarrow = await ttyEn.waitFor(
        (s) => s.includes('AI Folder Preview') && s.includes('->') && s.split('\n').length <= 24,
        { label: 'en --ascii AI Folder Preview 80x24' },
      );
      ttyEn.assertHealthyScreen(enPreviewNarrow, 80, 24, 'en --ascii Preview 80x24');
      ttyEn.assertAsciiPure(enPreviewNarrow, 'en --ascii Preview 80x24');

      // Apply with 'y' in preview
      useTuiStore.setState({ toasts: [] });
      ttyEn.send('y');
      const enAfterApply = await ttyEn.waitFor(
        (s) =>
          s.includes('Material Folders') &&
          !s.includes('AI Folder Preview') &&
          s.includes('Operating Systems') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Applied AI folder classification to 3 material(s)')),
        { label: 'en --ascii y applies AI folder suggestions' },
      );
      ttyEn.assertHealthyScreen(enAfterApply, 80, 24, 'en --ascii after apply 80x24');
      ttyEn.assertAsciiPure(enAfterApply, 'en --ascii after apply 80x24');

      const snapEn = useTuiStore.getState().snapshot;
      assert.equal(snapEn?.settings?.materialFolders?.items?.[enKeyOs], 'Operating Systems');
      assert.equal(snapEn?.settings?.materialFolders?.items?.[enKeyDb], 'Databases');
      assert.equal(snapEn?.settings?.materialFolders?.items?.[enKeyNet], 'Networking');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyEn.dispose();
      await hostEn.dispose();
    }
  });
});
