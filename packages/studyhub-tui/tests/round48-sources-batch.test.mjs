// Round 48 SourcesView Multi-Select Batch Ops ([Space], [m], [a], [Esc]) & 0-Token Enrich ([E]) E2E verification:
// node --test tests/round48-sources-batch.test.mjs
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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-') || f.startsWith('store-')) {
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round48-batch-${label}-`));
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
  return { id, key: `source:${id}` };
}

describe('Round 48: SourcesView multi-select batch ops & 0-token materials.enrich E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: source.folder.set { keys } batch assign & 0-token materials.enrich', async () => {
    const base = await makeTempDir('host');
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

      // Deterministic idempotency on second enrich pass
      const enrich2 = await host.call('materials.enrich', { sourceIds: [s1.id, s2.id] });
      assert.equal(enrich2.ok, true, enrich2.error?.message);
      assert.equal(enrich2.value?.updated, 0);
      assert.equal(enrich2.value?.changes?.length, 0);
      assert.equal(modelCalls, 0, 'batch folder assign & materials.enrich must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: Space multi-select, [E] enrich toast, [m] batch folder move, [a] batch archive, and Esc clear in zh & --ascii en (120x36 & 80x24)', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore();

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
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
      const initialScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Alpha Notes') &&
          s.includes('Beta Slides') &&
          s.includes('Gamma Paper'),
        { label: 'zh SourcesView initial render' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, 'zh SourcesView initial 120x36');

      // 1. Multi-select 2 sources with Space -> [✓] + 已选 2 份 badge
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 1 份') && s.includes('[✓]'), {
        label: 'zh 1 source selected with Space',
      });
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      const twoSelectedScreen = await tty.waitFor((s) => s.includes('已选 2 份') && s.includes('[✓]'), {
        label: 'zh 2 sources selected with Space',
      });
      tty.assertHealthyScreen(twoSelectedScreen, 120, 36, 'zh SourcesView 2 selected 120x36');

      // 2. Esc clears multi-select cleanly
      tty.send('\u001b');
      const clearedScreen = await tty.waitFor((s) => !s.includes('已选') && !s.includes('[✓]'), {
        label: 'zh Esc clears multi-select',
      });
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'zh SourcesView after Esc clear');

      // 3. Re-select 2 sources, test [E] 0-token enrich toast
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
      assert.equal(modelCalls, 0, '[E] enrich must make 0 model calls');

      // 4. Test [m] batch move to folder ('Lectures')
      useTuiStore.setState({ toasts: [] });
      tty.send('m');
      const batchModalScreen = await tty.waitFor(
        (s) => s.includes('批量移动资料到文件夹') && s.includes('已选 2 份') && s.includes('Lectures'),
        { label: 'zh BatchFolderModal opened' },
      );
      tty.assertHealthyScreen(batchModalScreen, 120, 36, 'zh BatchFolderModal 120x36');

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
      await tty.waitFor((s) => !s.includes('已选') && !s.includes('批量移动资料到文件夹'), {
        label: 'zh selection cleared and modal closed after batch move',
      });

      // 5. Test [a] batch archive & restore on 2 selected sources
      tty.send(' ');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 2 份'), { label: 'zh 2 sources selected for batch archive' });

      useTuiStore.setState({ toasts: [] });
      tty.send('a');
      await tty.waitFor(
        () => {
          const st = useTuiStore.getState();
          const archivedCount = (st.snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && src.archived).length;
          return st.toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已归档 2 份资料')) && archivedCount === 2;
        },
        { label: 'zh [a] batch archive applied to 2 sources' },
      );

      // Re-select both archived sources (at index 1 & 2) and restore them with [a]
      tty.send(' ');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 2 份'), { label: 'zh 2 archived sources selected for batch restore' });

      useTuiStore.setState({ toasts: [] });
      tty.send('a');
      await tty.waitFor(
        () => {
          const st = useTuiStore.getState();
          const activeCount = (st.snapshot?.sources ?? []).filter((src) => (src.id === s1.id || src.id === s2.id) && !src.archived).length;
          return st.toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已恢复 2 份资料')) && activeCount === 2;
        },
        { label: 'zh [a] batch restore applied to 2 sources' },
      );

      // Check narrow 80x24 layout with multi-select active in default zh mode
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

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // 6. Dedicated --ascii mode & 80x24 verification in English
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
      resetTuiStore();
      host = await createTuiHost({
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
        await asciiTty.waitFor(
          (s) => useTuiStore.getState().page === 'sources' && s.includes('Alpha Notes') && s.includes('Beta Slides'),
          { label: 'ASCII SourcesView 120x36' },
        );

        // Select 2 items with Space -> [x] + 2 selected
        asciiTty.send(' ');
        await asciiTty.flush();
        asciiTty.send('j');
        await asciiTty.flush();
        asciiTty.send(' ');
        const asciiSelected = await asciiTty.waitFor((s) => s.includes('2 selected') && s.includes('[x]'), {
          label: 'ASCII en 2 selected with [x]',
        });
        asciiTty.assertHealthyScreen(asciiSelected, 120, 36, 'ASCII SourcesView 2 selected 120x36');
        asciiTty.assertAsciiPure(asciiSelected, 'ASCII SourcesView 2 selected 120x36');

        // [E] enrich in English --ascii (already enriched -> 0 changes, 2 unresolved)
        useTuiStore.setState({ toasts: [] });
        asciiTty.send('E');
        await asciiTty.waitFor(
          () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Metadata checked (0 changes, 2 unresolved)')),
          { label: 'ASCII en [E] enrich toast' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII SourcesView after [E]');

        // [m] batch move to second folder ('Labs')
        useTuiStore.setState({ toasts: [] });
        asciiTty.send('m');
        const asciiModal = await asciiTty.waitFor(
          (s) => s.includes('Batch Move to Folder') && s.includes('2 selected') && s.includes('Labs'),
          { label: 'ASCII en BatchFolderModal' },
        );
        asciiTty.assertHealthyScreen(asciiModal, 120, 36, 'ASCII BatchFolderModal 120x36');
        asciiTty.assertAsciiPure(asciiModal, 'ASCII BatchFolderModal 120x36');

        asciiTty.send('j');
        await asciiTty.flush();
        asciiTty.send('\r');
        await asciiTty.waitFor(
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

        // Esc clears selection in ASCII en mode + 80x24 purity check
        asciiTty.send(' ');
        await asciiTty.flush();
        asciiTty.send('k');
        await asciiTty.flush();
        asciiTty.send(' ');
        asciiTty.resize(80, 24);
        const asciiNarrow = await asciiTty.waitFor(
          (s) => s.includes('2 selected') && s.includes('[x]') && s.split('\n').length <= 24,
          { label: 'ASCII SourcesView 80x24 with 2 selected' },
        );
        asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII SourcesView 80x24 multi-select');
        asciiTty.assertAsciiPure(asciiNarrow, 'ASCII SourcesView 80x24 multi-select');

        asciiTty.send('\u001b');
        const asciiCleared = await asciiTty.waitFor((s) => !s.includes('selected') && !s.includes('[x]'), {
          label: 'ASCII Esc clears selection at 80x24',
        });
        asciiTty.assertHealthyScreen(asciiCleared, 80, 24, 'ASCII SourcesView 80x24 after Esc');
        asciiTty.assertAsciiPure(asciiCleared, 'ASCII SourcesView 80x24 after Esc');
        assert.equal(modelCalls, 0, 'Total model calls across all operations must remain 0');
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
