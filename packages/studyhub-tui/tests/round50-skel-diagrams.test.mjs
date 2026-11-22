// Round 50 SkeletonView Interactive Diagrams Manager (skeleton.diagram.*) integration + PTY E2E tests:
// node --test tests/round50-skel-diagrams.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') {
      H = mod;
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  } else if (f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round50-diagrams-${label}-`));
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

describe('Round 50: SkeletonView Interactive Diagrams Manager (skeleton.diagram.*)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: attach, unchanged re-attach, list, get, reject non-HTML, remove', async () => {
    const base = await makeTempDir('host');
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
      assert.equal(list1.value.diagrams[0].stale, false);

      // Get diagram content + file
      const got = await host.call('skeleton.diagram.get', { id: skel.id, diagramId });
      assert.equal(got.ok, true, `skeleton.diagram.get failed: ${got.error?.message || ''}`);
      assert.ok(got.value?.html?.includes('BFS vs DFS'));
      assert.ok(got.value?.file?.endsWith('.html'));

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
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SkeletonView [M] SkeletonDiagramsModal in default (zh) and --ascii (en) at 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    // Pass A: default mode (zh) at 120x36 & 80x24
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
    const zhAttach = await host.call('skeleton.diagram.attach', { id: skelZh.id, path: zhHtmlPath });
    assert.equal(zhAttach.ok, true);

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
        label: 'Initial LibraryView ready (zh)',
      });
      tty.send('8');

      const skelScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'skeleton' &&
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

      // Resize to 80x24 and test [d] ConfirmDialog cancel (n) & confirm (y)
      tty.resize(80, 24);
      const narrowModalZh = await tty.waitFor(
        (s) => s.includes('互动图表 (1/8)') && s.includes('进程调度全景图') && s.split('\n').length <= 24,
        { label: 'SkeletonDiagramsModal 80x24 zh' },
      );
      tty.assertHealthyScreen(narrowModalZh, 80, 24, 'SkeletonDiagramsModal 80x24 zh');

      tty.send('d');
      const dialogZh = await tty.waitFor(
        (s) => s.includes('确认移除互动图表') && s.includes('进程调度全景图'),
        { label: 'ConfirmDialog opened via d (zh)' },
      );
      tty.assertHealthyScreen(dialogZh, 80, 24, 'Remove Diagram ConfirmDialog 80x24 zh');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认移除互动图表') && s.includes('进程调度全景图'),
        { label: 'ConfirmDialog cancelled via n (zh)' },
      );
      const afterCancel = await host.call('skeleton.diagram.list', { id: skelZh.id });
      assert.equal(afterCancel.value?.diagrams?.length, 1, 'Diagram must remain after cancelling with n');

      useTuiStore.setState({ toasts: [] });
      tty.send('d');
      await tty.waitFor((s) => s.includes('确认移除互动图表'), { label: 'ConfirmDialog re-opened (zh)' });
      tty.send('y');
      const afterRemoveZh = await tty.waitFor(
        (s) =>
          !s.includes('确认移除互动图表') &&
          s.includes('尚未挂载互动图表') &&
          s.includes('互动图表 (0/8)') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已移除图表')),
        { label: 'Diagram removed via d -> y (zh)' },
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

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Pass B: --ascii mode (en) at 120x36 & 80x24
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
      const skelEn = await saveTestSkeleton(host, {
        title: 'Compilers Skeleton',
        ...seedZh,
      });

      const enHtml1 = join(libraryRoot, 'compiler-pipeline.html');
      await writeFile(
        enHtml1,
        '<!doctype html><html><head><title>Compiler Pipeline</title></head><body><h1>Lexer and Parser</h1><p>AST construction steps</p></body></html>',
        'utf8',
      );
      const enHtml2 = join(libraryRoot, 'ir-lowering.html');
      await writeFile(
        enHtml2,
        '<!doctype html><html><head><title>IR Lowering</title></head><body><h1>SSA Form</h1><p>Control flow graph</p></body></html>',
        'utf8',
      );
      const enAttach = await host.call('skeleton.diagram.attach', { id: skelEn.id, path: enHtml1 });
      assert.equal(enAttach.ok, true);

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
          label: 'ASCII LibraryView ready (en)',
        });
        asciiTty.send('8');

        const asciiSkel = await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().page === 'skeleton' &&
            s.includes('Compilers Skeleton') &&
            s.includes('Diagrams(1)'),
          { label: 'ASCII SkeletonView 120x36 (en)' },
        );
        asciiTty.assertHealthyScreen(asciiSkel, 120, 36, 'ASCII SkeletonView 120x36');
        asciiTty.assertAsciiPure(asciiSkel, 'ASCII SkeletonView 120x36');

        // Open modal via M
        asciiTty.send('M');
        const asciiModal = await asciiTty.waitFor(
          (s) =>
            s.includes('Diagrams (1/8)') &&
            s.includes('Compiler Pipeline') &&
            s.includes('SHA256:') &&
            s.includes('AST construction steps'),
          { label: 'ASCII SkeletonDiagramsModal 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiModal, 120, 36, 'ASCII SkeletonDiagramsModal 120x36');
        asciiTty.assertAsciiPure(asciiModal, 'ASCII SkeletonDiagramsModal 120x36');

        // Test [a] Attach sub-mode
        asciiTty.send('a');
        const asciiAttach = await asciiTty.waitFor(
          (s) => s.includes('Attach Local HTML Diagram') && s.includes('UTF-8 HTML (<= 5 MB)'),
          { label: 'ASCII Attach mode opened' },
        );
        asciiTty.assertHealthyScreen(asciiAttach, 120, 36, 'ASCII Attach mode 120x36');
        asciiTty.assertAsciiPure(asciiAttach, 'ASCII Attach mode 120x36');

        asciiTty.send(enHtml2);
        await asciiTty.waitFor((s) => s.includes('ir-lowering.html'), {
          label: 'HTML path typed into TextInput',
        });
        asciiTty.send('\r');
        const asciiAfterAttach = await asciiTty.waitFor(
          (s) => s.includes('Diagrams (2/8)') && s.includes('IR Lowering') && s.includes('Control flow graph'),
          { label: 'ASCII Diagram attached via [a] (en)' },
        );
        asciiTty.assertHealthyScreen(asciiAfterAttach, 120, 36, 'ASCII SkeletonDiagramsModal after attach 120x36');
        asciiTty.assertAsciiPure(asciiAfterAttach, 'ASCII SkeletonDiagramsModal after attach 120x36');

        // Resize to 80x24 and test [d] ConfirmDialog cancel (n) and confirm (y)
        asciiTty.resize(80, 24);
        const asciiNarrow = await asciiTty.waitFor(
          (s) => s.includes('Diagrams (2/8)') && s.includes('IR Lowering') && s.split('\n').length <= 24,
          { label: 'ASCII SkeletonDiagramsModal 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII SkeletonDiagramsModal 80x24');
        asciiTty.assertAsciiPure(asciiNarrow, 'ASCII SkeletonDiagramsModal 80x24');

        asciiTty.send('d');
        const asciiDialog = await asciiTty.waitFor(
          (s) => s.includes('Remove Interactive Diagram') && s.includes('IR Lowering'),
          { label: 'ASCII Remove ConfirmDialog 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiDialog, 80, 24, 'ASCII Remove ConfirmDialog 80x24');
        asciiTty.assertAsciiPure(asciiDialog, 'ASCII Remove ConfirmDialog 80x24');

        asciiTty.send('n');
        await asciiTty.waitFor(
          (s) => !s.includes('Remove Interactive Diagram') && s.includes('Diagrams (2/8)'),
          { label: 'ASCII Remove ConfirmDialog cancelled via n' },
        );
        const enListCancel = await host.call('skeleton.diagram.list', { id: skelEn.id });
        assert.equal(enListCancel.value?.diagrams?.length, 2, 'Diagrams must remain 2 after n');

        useTuiStore.setState({ toasts: [] });
        asciiTty.send('d');
        await asciiTty.waitFor((s) => s.includes('Remove Interactive Diagram'), { label: 'ASCII ConfirmDialog re-opened' });
        asciiTty.send('y');
        const asciiAfterRemove = await asciiTty.waitFor(
          (s) =>
            !s.includes('Remove Interactive Diagram') &&
            s.includes('Diagrams (1/8)') &&
            useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Removed diagram')),
          { label: 'ASCII Diagram removed via d -> y' },
        );
        asciiTty.assertHealthyScreen(asciiAfterRemove, 80, 24, 'ASCII SkeletonDiagramsModal after remove 80x24');
        asciiTty.assertAsciiPure(asciiAfterRemove, 'ASCII SkeletonDiagramsModal after remove 80x24');

        const enListRemove = await host.call('skeleton.diagram.list', { id: skelEn.id });
        assert.equal(enListRemove.value?.diagrams?.length, 1, 'Diagram count must drop to 1 after removal');
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
