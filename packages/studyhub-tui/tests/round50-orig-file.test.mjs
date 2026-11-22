// Round 50 SourcesView Original File Attachment Inspector & Attach/Detach ([O] -> OriginalFileModal) E2E verification:
// node --test tests/round50-orig-file.test.mjs
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

let H = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (
      !H &&
      (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) &&
      typeof mod.createTuiHost === 'function' &&
      typeof mod.saveTuiPreferences === 'function'
    ) {
      H = mod;
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(H, 'dist/ must export createTuiHost and saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const { createTuiHost, saveTuiPreferences } = H;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round50-${label}-`));
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

describe('Round 50: SourcesView OriginalFileModal (status, probe, attach, detach)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: materials.original.status / probe / attach / detach keeps disk file intact', async () => {
    const base = await makeTempDir('host');
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
      const added = await host.call('source.add', {
        title: 'Linear Algebra Notes',
        text: MATCHING_MD_TEXT,
        format: 'md',
      });
      assert.equal(added.ok, true, `source.add failed: ${added.error?.message || ''}`);
      const sourceId = added.value?.source?.id || added.value?.id;
      assert.ok(sourceId, 'source.add must return source id');

      // Initial status: none
      const st0 = await host.call('materials.original.status', { sourceId });
      assert.equal(st0.ok, true, st0.error?.message);
      assert.equal(st0.value?.status, 'none');
      assert.equal(st0.value?.mode, null);
      assert.equal(st0.value?.format, 'md');

      // Probe matching file
      const probeOk = await host.call('materials.original.probe', { sourceId, path: mdPath });
      assert.equal(probeOk.ok, true, probeOk.error?.message);
      assert.equal(probeOk.value?.accepted, true);
      assert.equal(probeOk.value?.format, 'md');

      // Attach as reference
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

      // Mismatch file requires confirmation before attaching
      const needsConfirm = await host.call('materials.original.attach', {
        sourceId,
        path: mismatchPath,
        mode: 'reference',
      });
      assert.equal(needsConfirm.ok, true, needsConfirm.error?.message);
      assert.equal(needsConfirm.value?.status, 'needs-confirmation');
      assert.equal(needsConfirm.value?.report?.accepted, false);

      // Detach clears attachment while preserving external file on disk
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

  test('2) @xterm/headless E2E: [O] OriginalFileModal at 120x36 & 80x24 (zh and --ascii en)', async () => {
    const base = await makeTempDir('e2e');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const filesDir = join(base, 'files');
    await mkdir(filesDir, { recursive: true });

    const mdPath = join(filesDir, 'linear-algebra.md');
    await writeFile(mdPath, MATCHING_MD_TEXT, 'utf8');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore();

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const seedRes = await host.call('source.add', {
      title: 'Linear Algebra Notes',
      text: MATCHING_MD_TEXT,
      format: 'md',
    });
    assert.equal(seedRes.ok, true, seedRes.error?.message);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
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
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Linear Algebra Notes') &&
          s.includes('重读清单'),
        { label: 'SourcesView zh ready with Reread hint' },
      );
      tty.assertHealthyScreen(sourcesZh, 120, 36, 'SourcesView zh 120x36');

      // Press O to open OriginalFileModal
      tty.send('O');
      const modalZh = await tty.waitFor(
        (s) => s.includes('原文件信息与关联') && s.includes('未关联') && s.includes('MD'),
        { label: 'OriginalFileModal inspect rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(modalZh, 120, 36, 'OriginalFileModal inspect zh 120x36');

      // Press a to enter attach sub-mode
      tty.send('a');
      const attachZh = await tty.waitFor(
        (s) => s.includes('本地原文件路径') && s.includes('1. reference') && s.includes('仅记忆磁盘路径'),
        { label: 'OriginalFileModal attach sub-mode rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(attachZh, 120, 36, 'OriginalFileModal attach zh 120x36');

      // Press Tab on empty path to toggle reference -> copy, then Tab back to reference
      tty.send('\t');
      await tty.waitFor(
        (s) => s.includes('复制一份到学习库内部存储'),
        { label: 'Tab toggles attach mode to copy' },
      );
      tty.send('\t');
      await tty.waitFor(
        (s) => s.includes('仅记忆磁盘路径'),
        { label: 'Tab toggles attach mode back to reference' },
      );

      // Type file path and press Enter to attach
      tty.send(mdPath);
      await tty.waitFor((s) => s.includes('linear-algebra.md'), { label: 'Path entered in TextInput' });
      tty.send('\r');

      const attachedZh = await tty.waitFor(
        (s) => s.includes('已关联') && s.includes('reference（仅引用路径') && s.includes('linear-algebra.md'),
        { label: 'Original file attached via TUI' },
      );
      tty.assertHealthyScreen(attachedZh, 120, 36, 'OriginalFileModal attached zh 120x36');

      // Press d to open detach ConfirmDialog, confirm with y
      tty.send('d');
      const confirmDetachZh = await tty.waitFor(
        (s) => s.includes('解除原文件关联') && s.includes('不会删除磁盘上的原始文件'),
        { label: 'Detach ConfirmDialog shown' },
      );
      tty.assertHealthyScreen(confirmDetachZh, 120, 36, 'OriginalFileModal detach ConfirmDialog zh 120x36');

      tty.send('y');
      await tty.waitFor(
        (s) => !s.includes('解除原文件关联') && s.includes('未关联') && s.includes('原文件信息与关联'),
        { label: 'Original file detached back to 未关联' },
      );
      assert.equal(await fileExists(mdPath), true, 'Disk file must remain intact after TUI detach');

      // Press Esc to close OriginalFileModal cleanly back to SourcesView
      tty.send('\u001b');
      await tty.waitFor(
        (s) => !s.includes('原文件信息与关联') && s.includes('学习资料库'),
        { label: 'Esc closes OriginalFileModal cleanly in zh' },
      );

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Switch to --ascii & English mode at 120x36 and 80x24
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
      resetTuiStore();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });

      const asciiTty = createVirtualTty(120, 36);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
          stdin: asciiTty.stdin,
          stdout: asciiTty.stdout,
          stderr: asciiTty.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await asciiTty.firstFramePromise;

        await asciiTty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
          label: 'ASCII LibraryView ready',
        });
        asciiTty.send('2');
        const asciiSources = await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().page === 'sources' &&
            s.includes('Linear Algebra Notes') &&
            s.includes('Reread'),
          { label: 'ASCII SourcesView ready with Reread hint' },
        );
        asciiTty.assertHealthyScreen(asciiSources, 120, 36, 'ASCII SourcesView 120x36');
        asciiTty.assertAsciiPure(asciiSources, 'ASCII SourcesView 120x36');

        // Open OriginalFileModal with O at 120x36
        asciiTty.send('O');
        const asciiModalWide = await asciiTty.waitFor(
          (s) => s.includes('Original File') && s.includes('Not attached') && s.includes('MD'),
          { label: 'ASCII OriginalFileModal 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiModalWide, 120, 36, 'ASCII OriginalFileModal 120x36');
        asciiTty.assertAsciiPure(asciiModalWide, 'ASCII OriginalFileModal 120x36');

        // Resize to 80x24 and verify clean fit + zero Unicode chrome
        asciiTty.resize(80, 24);
        const asciiModalNarrow = await asciiTty.waitFor(
          (s) => s.includes('Original File') && s.includes('Not attached') && s.split('\n').length <= 24,
          { label: 'ASCII OriginalFileModal 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiModalNarrow, 80, 24, 'ASCII OriginalFileModal 80x24');
        asciiTty.assertAsciiPure(asciiModalNarrow, 'ASCII OriginalFileModal 80x24');

        // Press a to enter attach sub-mode at 80x24, verify mode toggle & Esc return
        asciiTty.send('a');
        const asciiAttach = await asciiTty.waitFor(
          (s) => s.includes('Original File Path:') && s.includes('Stores path reference only'),
          { label: 'ASCII OriginalFileModal attach sub-mode 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiAttach, 80, 24, 'ASCII OriginalFileModal attach 80x24');
        asciiTty.assertAsciiPure(asciiAttach, 'ASCII OriginalFileModal attach 80x24');

        asciiTty.send('\t');
        const asciiAttachCopy = await asciiTty.waitFor(
          (s) => s.includes('Copies file into library storage'),
          { label: 'ASCII Tab toggles mode to copy 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiAttachCopy, 80, 24, 'ASCII OriginalFileModal attach copy 80x24');
        asciiTty.assertAsciiPure(asciiAttachCopy, 'ASCII OriginalFileModal attach copy 80x24');

        // Esc returns from attach sub-mode to inspect view
        asciiTty.send('\u001b');
        const asciiBackInspect = await asciiTty.waitFor(
          (s) => s.includes('Not attached') && !s.includes('Original File Path:'),
          { label: 'ASCII Esc returns from attach sub-mode to inspect' },
        );
        asciiTty.assertAsciiPure(asciiBackInspect, 'ASCII OriginalFileModal inspect after Esc');

        // Esc closes modal cleanly back to SourcesView at 80x24
        asciiTty.send('\u001b');
        const asciiAfterEsc = await asciiTty.waitFor(
          (s) => !s.includes('Original File') && s.includes('Linear Algebra Notes'),
          { label: 'ASCII Esc closes OriginalFileModal cleanly at 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiAfterEsc, 80, 24, 'ASCII SourcesView 80x24 after Esc');
        asciiTty.assertAsciiPure(asciiAfterEsc, 'ASCII SourcesView 80x24 after Esc');
      } finally {
        inkInstance?.unmount();
        inkInstance = null;
        asciiTty.dispose();
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
