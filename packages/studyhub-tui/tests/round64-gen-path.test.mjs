// Round 64 Track 1: GeneratePathModal (local planner + P2 ConfirmDialog guarded generate.path.suggest)
// node --test --test-concurrency=1 tests/round64-gen-path.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

// Verify lazy GeneratePathModal chunk exists and is marked-free
const pathModalChunk = distFiles.find((f) => f.startsWith('GeneratePathModal-') && f.endsWith('.mjs'));
assert.ok(pathModalChunk, `dist/ must emit lazy GeneratePathModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const pathModalChunkCode = fs.readFileSync(join(distDir, pathModalChunk), 'utf8');
assert.equal(/\bmarked\b/.test(pathModalChunkCode), false, `${pathModalChunk} must be marked-free`);
assert.equal(/\bcli-highlight\b/.test(pathModalChunkCode), false, `${pathModalChunk} must not bundle cli-highlight`);
assert.equal(/src\/components\/MarkdownView\.tsx/.test(pathModalChunkCode), false, `${pathModalChunk} must not bundle MarkdownView`);

const pathModalMod = await import(pathToFileURL(join(distDir, pathModalChunk)).href);
assert.equal(typeof pathModalMod.buildLocalPathSteps, 'function', `${pathModalChunk} must export buildLocalPathSteps`);
const { buildLocalPathSteps } = pathModalMod;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round64-gen-path-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false) {
  useTuiStore.setState({
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

async function seedMultiPagePdfLibrary(root, { course = 'Algorithms', docTitle = 'Graph Algorithms', totalPages = 25 } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    for (let p = 1; p <= totalPages; p += 1) {
      state.sources.push({
        id: `algo-p${p}`,
        title: `${docTitle} · p. ${p}`,
        createdAt: `2026-10-01T00:${String(p).padStart(2, '0')}:00.000Z`,
        courses: [course],
        text: `SECRET_RAW_PAGE_${p}_BODY: Dijkstra shortest paths and relaxation invariants.`,
        document: {
          materialId: 'doc-algo-25',
          page: p,
          totalPages,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'graph-algorithms.pdf',
          extractionVersion: 2,
        },
      });
    }
  });
}

describe('Round 64 Track 1: GeneratePathModal + generate.path.suggest', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) buildLocalPathSteps unit test + createTuiHost integration with generate.path.suggest', async () => {
    // Unit test: 45-page doc + 5-page doc -> 3 steps (20 + 20 + 5) and 1 step (5), counts in [5, 20]
    const doc45 = {
      key: 'pdf:doc-45',
      title: 'Distributed Systems',
      format: 'pdf',
      pageCount: 45,
      sourceIds: Array.from({ length: 45 }, (_, i) => `d45-p${i + 1}`),
      pages: Array.from({ length: 45 }, (_, i) => ({
        sourceId: `d45-p${i + 1}`,
        page: i + 1,
        title: `Distributed Systems p.${i + 1}`,
        chars: 4000,
      })),
      courses: ['CS401'],
      cardCount: 0,
      chars: 45 * 4000,
      pinned: false,
      archived: false,
    };
    const doc5 = {
      key: 'doc:notes-5',
      title: 'Consensus Notes',
      format: 'md',
      pageCount: 5,
      sourceIds: Array.from({ length: 5 }, (_, i) => `d5-p${i + 1}`),
      pages: Array.from({ length: 5 }, (_, i) => ({
        sourceId: `d5-p${i + 1}`,
        page: i + 1,
        title: `Consensus Notes p.${i + 1}`,
        chars: 1200,
      })),
      courses: ['CS401'],
      cardCount: 0,
      chars: 6000,
      pinned: false,
      archived: false,
    };

    const selectedIds = new Set([...doc45.sourceIds, ...doc5.sourceIds]);
    const steps = buildLocalPathSteps([doc45, doc5], selectedIds);
    assert.equal(steps.length, 4, '45p + 5p must partition into 4 sequential steps (20, 20, 5, 5)');
    assert.deepEqual(
      steps.map((s) => ({ id: s.id, pageScope: s.pageScope, pages: s.pages, documentTitle: s.documentTitle })),
      [
        { id: 'step-1', pageScope: '1-20', pages: 20, documentTitle: 'Distributed Systems' },
        { id: 'step-2', pageScope: '21-40', pages: 20, documentTitle: 'Distributed Systems' },
        { id: 'step-3', pageScope: '41-45', pages: 5, documentTitle: 'Distributed Systems' },
        { id: 'step-4', pageScope: '1-5', pages: 5, documentTitle: 'Consensus Notes' },
      ],
    );
    for (const s of steps) {
      assert.ok(s.count >= 5 && s.count <= 20, `step ${s.id} count ${s.count} must be clamped to [5, 20]`);
      assert.ok(s.chars > 0, `step ${s.id} must record chars`);
      assert.ok(s.title.includes(s.documentTitle), `step ${s.id} title must include documentTitle`);
    }

    // Empty selection yields []
    assert.deepEqual(buildLocalPathSteps([doc45], new Set()), []);

    // createTuiHost integration with injectedComplete
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    const seenPrompts = [];

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (system, prompt) => {
        modelCalls += 1;
        seenPrompts.push({ system, prompt: String(prompt) });
        return JSON.stringify({
          steps: [
            {
              id: 'step-2',
              title: 'Fault Tolerance & Paxos',
              focus: 'Compare Paxos prepare/accept phases and split-brain prevention',
              count: 16,
              reason: 'High-yield exam core',
            },
            {
              id: 'step-1',
              title: 'Clocks & Consistency Foundations',
              focus: 'Lamport timestamps and vector clock partial ordering',
              count: 12,
              reason: 'Prerequisite concepts',
            },
          ],
        });
      },
    });

    try {
      const res = await host.call('generate.path.suggest', {
        course: 'CS401',
        goal: 'exam',
        steps: steps.slice(0, 2).map((s) => ({
          id: s.id,
          title: s.title,
          pages: s.pages,
          chars: s.chars,
          count: s.count,
          range: s.range,
          documentTitle: s.documentTitle,
        })),
      });
      assert.equal(res.ok, true, `generate.path.suggest failed: ${res.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'generate.path.suggest must invoke model once');
      assert.equal(res.value?.source, 'model');
      assert.equal(res.value?.steps?.length, 2);
      assert.equal(res.value?.steps?.[0]?.id, 'step-2');
      assert.equal(res.value?.steps?.[0]?.title, 'Fault Tolerance & Paxos');
      assert.equal(res.value?.steps?.[0]?.count, 16);
      assert.match(res.value?.steps?.[0]?.focus || '', /Paxos/);
      assert.equal(res.value?.steps?.[1]?.id, 'step-1');

      const promptStr = seenPrompts[0]?.prompt || '';
      assert.ok(promptStr.includes('Distributed Systems'), 'prompt includes step titles');
      assert.ok(!promptStr.includes('SECRET_RAW_PAGE'), 'prompt must never send raw source body text');

      // Empty steps -> local no-steps with 0 extra model calls
      const emptyRes = await host.call('generate.path.suggest', { steps: [] });
      assert.equal(emptyRes.ok, true);
      assert.equal(emptyRes.value?.source, 'local');
      assert.equal(emptyRes.value?.unavailable?.reason, 'no-steps');
      assert.equal(modelCalls, 1);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): GenerateView [P] opens (0 calls) -> [g] ConfirmDialog -> [n] cancel (0 calls) -> [g]+[y] (1 call) -> [Enter] applies scope & toast', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);

    const libraryRoot = join(base, 'library');
    await seedMultiPagePdfLibrary(libraryRoot, {
      course: '图论算法',
      docTitle: '图论与最短路径讲义',
      totalPages: 25,
    });

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return JSON.stringify({
          steps: [
            {
              id: 'step-1',
              title: '核心：最短路径与松弛性质',
              focus: '掌握 Dijkstra 贪心不变量与负权边反例',
              count: 15,
              reason: '优先掌握基础最优化结构',
            },
            {
              id: 'step-2',
              title: '进阶：全源最短路与传递闭包',
              focus: '对比 Floyd-Warshall 动态规划状态转移',
              count: 10,
              reason: '承接单源路径延伸',
            },
          ],
        });
      },
    });

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
        label: 'zh LibraryView ready',
      });

      // Navigate to GenerateView ('3')
      tty.send('3');
      const genScreen = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'generate' && s.includes('新建出题任务') && s.includes('graph-algorithms.pdf'),
        { label: 'zh GenerateView ready' },
      );
      tty.assertHealthyScreen(genScreen, 120, 36, 'zh GenerateView initial');
      assert.equal(modelCalls, 0, 'Entering GenerateView must make 0 AI calls');

      // Press 'P' with no source selected -> warning toast, 0 AI calls
      useTuiStore.setState({ toasts: [] });
      tty.send('P');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('请至少选择一份资料')),
        { label: 'zh warning toast when pressing P without selection' },
      );
      assert.equal(modelCalls, 0);

      // Select the 25-page PDF source with Space
      tty.send(' ');
      await tty.waitFor((s) => s.includes('25p'), { label: 'zh 25-page source selected' });

      // Press 'P' -> GeneratePathModal opens with 0 model calls
      tty.send('P');
      const pathOpenScreen = await tty.waitFor(
        (s) =>
          s.includes('分步出题路径规划') &&
          s.includes('p.1-20') &&
          s.includes('p.21-25'),
        { label: 'zh GeneratePathModal opened with 2 local steps' },
      );
      tty.assertHealthyScreen(pathOpenScreen, 120, 36, 'zh GeneratePathModal open 120x36');
      assert.equal(modelCalls, 0, 'Opening GeneratePathModal must make 0 AI calls');

      // Press 'g' -> P2 ConfirmDialog appears with 0 model calls
      tty.send('g');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('AI 优化分步出题路径') && s.includes('仅发送步骤标题与页数'),
        { label: 'zh P2 ConfirmDialog open after g' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'zh Path ConfirmDialog 120x36');
      assert.equal(modelCalls, 0, 'ConfirmDialog must make 0 AI calls before confirmation');

      // Cancel with 'n' -> still 0 model calls, modal stays open
      tty.send('n');
      await tty.waitFor(
        (s) => s.includes('分步出题路径规划') && !s.includes('仅发送步骤标题与页数'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(modelCalls, 0, 'Cancelling ConfirmDialog with n must keep AI calls at 0');

      // Press 'g' then 'y' -> invokes generate.path.suggest once and shows refined title + focus
      tty.send('g');
      await tty.waitFor((s) => s.includes('仅发送步骤标题与页数'), { label: 'zh ConfirmDialog reopened' });
      tty.send('y');

      const refinedScreen = await tty.waitFor(
        (s) =>
          s.includes('核心：最短路径与松弛性质') &&
          s.includes('Dijkstra 贪心不变量'),
        { label: 'zh AI refined path rendered' },
      );
      tty.assertHealthyScreen(refinedScreen, 120, 36, 'zh refined path 120x36');
      assert.equal(modelCalls, 1, 'Confirming y must invoke AI exactly once');

      // Press Enter -> applies step scope (1-20), target count (15), focus note, closes modal, shows toast
      useTuiStore.setState({ toasts: [] });
      tty.send('\r');
      const appliedScreen = await tty.waitFor(
        (s) =>
          !s.includes('分步出题路径规划') &&
          s.includes('1-20') &&
          s.includes('Dijkstra 贪心不变量') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('p.1-20')),
        { label: 'zh Enter applied step scope, focus and toast' },
      );
      tty.assertHealthyScreen(appliedScreen, 120, 36, 'zh GenerateView after step apply');
      assert.equal(modelCalls, 1, 'Applying step via Enter must make 0 additional AI calls');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): [P] opens cleanly (assertHealthyScreen + assertAsciiPure), [j] navigates, [Enter] applies step with 0 model calls', async () => {
    const base = await makeTempDir('pty-en-ascii');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetDistStore('en', true);

    const libraryRoot = join(base, 'library');
    await seedMultiPagePdfLibrary(libraryRoot, {
      course: 'Algorithms',
      docTitle: 'Graph Algorithms Notes',
      totalPages: 25,
    });

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
        return '{"steps":[]}';
      },
    });

    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      tty.send('3');
      const genInit = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'generate' && s.includes('New Generation') && s.includes('graph-alg'),
        { label: 'en --ascii GenerateView ready' },
      );
      tty.assertHealthyScreen(genInit, 80, 24, 'en --ascii GenerateView 80x24');
      tty.assertAsciiPure(genInit, 'en --ascii GenerateView 80x24');

      // Select source with Space
      tty.send(' ');
      await tty.waitFor((s) => s.includes('25p'), { label: 'en --ascii 25p selected' });

      // Open GeneratePathModal with P
      tty.send('P');
      const pathScreen = await tty.waitFor(
        (s) =>
          s.includes('Generation Path Planner') &&
          s.includes('p.1-20') &&
          s.includes('p.21-25'),
        { label: 'en --ascii GeneratePathModal 80x24' },
      );
      tty.assertHealthyScreen(pathScreen, 80, 24, 'en --ascii GeneratePathModal 80x24');
      tty.assertAsciiPure(pathScreen, 'en --ascii GeneratePathModal 80x24');
      assert.equal(modelCalls, 0, 'Opening GeneratePathModal must make 0 model calls');

      // Navigate to step 2 with 'j'
      tty.send('j');
      const step2Screen = await tty.waitFor(
        (s) => s.includes('Step: p.21-25'),
        { label: 'en --ascii j navigates to step 2' },
      );
      tty.assertHealthyScreen(step2Screen, 80, 24, 'en --ascii step 2 selected 80x24');
      tty.assertAsciiPure(step2Screen, 'en --ascii step 2 selected 80x24');

      // Apply step 2 with Enter -> sets pageScope 21-25, closes modal, shows toast, 0 model calls
      useTuiStore.setState({ toasts: [] });
      tty.send('\r');
      const appliedScreen = await tty.waitFor(
        (s) =>
          !s.includes('Generation Path Planner') &&
          s.includes('21-25') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('p.21-25')),
        { label: 'en --ascii Enter applies step 2 cleanly' },
      );
      tty.assertHealthyScreen(appliedScreen, 80, 24, 'en --ascii GenerateView after apply 80x24');
      tty.assertAsciiPure(appliedScreen, 'en --ascii GenerateView after apply 80x24');
      assert.equal(modelCalls, 0, 'Local step apply must make 0 model calls');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });
});
