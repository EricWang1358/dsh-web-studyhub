// Round 54 Task 1: OrganizeSourcesModal P2 Silent AI Quota Leak Guard
// @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round54-org-sources-guard.test.mjs
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

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && mod.useTuiStore?.getState && mod.DEFAULT_PREFERENCES) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
assert.ok(S?.DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { createTuiHost, saveTuiPreferences } = H;
const { displayWidth } = R;
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round54-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
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
    ...extra,
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

async function seedTwoMaterials(host) {
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

  const snap = await host.refreshSnapshot();
  assert.equal((snap.snapshot?.sources ?? []).length, 2, 'Expected 2 seeded sources in snapshot');
}

function createOrganizeCompleteStub(counterRef) {
  return async (system, prompt) => {
    const s = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    counterRef.calls += 1;
    if (s.includes('Organize study sources into courses')) {
      const req = JSON.parse(p);
      const sources = Array.isArray(req.sources) ? req.sources : [];
      return JSON.stringify({
        proposals: sources.map((src) => ({
          id: src.id,
          courses: String(src.title || '').includes('Linear') ? ['Linear Algebra'] : ['Operating Systems'],
          reason: 'Matched topic keywords',
        })),
      });
    }
    return JSON.stringify({ proposals: [] });
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 54: OrganizeSourcesModal P2 Silent AI Quota Leak Guard', () => {
  test('1) @xterm/headless E2E (120x36 zh): [G] opens ConfirmDialog with 0 calls -> [n] & [Esc] close with 0 calls -> [G]+[y] suggests -> [r] re-confirms', async () => {
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
      injectedComplete: createOrganizeCompleteStub(counter),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    await seedTwoMaterials(host);
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
        (s) =>
          s.includes('Linear Algebra Lecture Notes') &&
          s.includes('Operating Systems Vi') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'SourcesView with 2 seeded materials zh' },
      );
      tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView zh');
      assert.equal(counter.calls, 0, 'SourcesView mount must make 0 model calls');

      // Press 'G' -> P2 ConfirmDialog renders with 0 model calls
      tty.send('G');
      const confirmScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 分析资料所属课程') &&
          s.includes('将分析 2 份资料并调用 AI') &&
          s.includes('建议课程归属'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal P2 ConfirmDialog zh' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'OrganizeSourcesModal P2 ConfirmDialog zh');
      await sleep(250);
      await tty.flush();
      assert.equal(counter.calls, 0, 'Opening OrganizeSourcesModal via [G] MUST make 0 automatic AI calls');

      // Press 'n' -> closes modal cleanly back to SourcesView with 0 model calls
      tty.send('n');
      const afterCancelN = await tty.waitFor(
        (s) =>
          !s.includes('AI 分析资料所属课程') &&
          !s.includes('AI 智能整理课程归属') &&
          s.includes('学习资料库') &&
          s.includes('Linear Algebra Lectu'),
        { timeoutMs: 8_000, label: 'SourcesView after [n] cancel' },
      );
      tty.assertHealthyScreen(afterCancelN, 120, 36, 'SourcesView after [n] cancel');
      assert.equal(counter.calls, 0, 'Pressing [n] on ConfirmDialog must make 0 AI calls');

      // Press 'G' -> Esc -> closes modal cleanly back to SourcesView with 0 model calls
      tty.send('G');
      await tty.waitFor(
        (s) => s.includes('AI 分析资料所属课程'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal P2 ConfirmDialog reopened' },
      );
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('AI 分析资料所属课程') && s.includes('学习资料库') && s.includes('Linear Algebra Lectu'),
        { timeoutMs: 8_000, label: 'SourcesView after Esc cancel' },
      );
      assert.equal(counter.calls, 0, 'Pressing Esc on ConfirmDialog must make 0 AI calls');

      // Press 'G' then 'y' -> invokes source.organize.suggest and renders proposals
      tty.send('G');
      await tty.waitFor(
        (s) => s.includes('AI 分析资料所属课程'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog before [y]' },
      );
      tty.send('y');

      const proposalsScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 智能整理课程归属') &&
          !s.includes('正在分析') &&
          s.includes('建议 2') &&
          s.includes('Linear Algebra') &&
          s.includes('Operating Systems'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal proposals rendered zh' },
      );
      tty.assertHealthyScreen(proposalsScreen, 120, 36, 'OrganizeSourcesModal proposals zh');
      assert.equal(counter.calls, 1, 'Confirming [G] -> [y] must call model exactly once');

      // Press 'r' in results -> re-opens P2 ConfirmDialog rather than silently calling AI
      tty.send('r');
      const reanalyzeConfirmScreen = await tty.waitFor(
        (s) => s.includes('AI 分析资料所属课程') && s.includes('重新分析'),
        { timeoutMs: 8_000, label: 'Re-analyze P2 ConfirmDialog zh' },
      );
      tty.assertHealthyScreen(reanalyzeConfirmScreen, 120, 36, 'Re-analyze ConfirmDialog zh');
      await sleep(150);
      await tty.flush();
      assert.equal(counter.calls, 1, 'Pressing [r] must open ConfirmDialog with 0 extra AI calls');

      // Press 'n' on reanalyze ConfirmDialog -> stays on results without extra AI calls
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('AI 分析资料所属课程') && s.includes('AI 智能整理课程归属') && s.includes('建议 2'),
        { timeoutMs: 8_000, label: 'Back to proposals after [r] -> [n]' },
      );
      assert.equal(counter.calls, 1, 'Cancelling re-analyze with [n] must make 0 extra AI calls');

      // Press 'r' then 'y' -> runs model a second time
      tty.send('r');
      await tty.waitFor(
        (s) => s.includes('AI 分析资料所属课程'),
        { timeoutMs: 8_000, label: 'Re-analyze ConfirmDialog before [y]' },
      );
      tty.send('y');
      await tty.waitFor(
        (s) =>
          s.includes('AI 智能整理课程归属') &&
          !s.includes('正在分析') &&
          s.includes('建议 2'),
        { timeoutMs: 8_000, label: 'Proposals re-rendered after [r] -> [y]' },
      );
      assert.equal(counter.calls, 2, 'Confirming [r] -> [y] must invoke model a second time');

      // Esc closes OrganizeSourcesModal cleanly
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('AI 智能整理课程归属') && s.includes('学习资料库') && s.includes('Linear Algebra Lectu'),
        { timeoutMs: 8_000, label: 'SourcesView after closing OrganizeSourcesModal' },
      );
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('2) @xterm/headless E2E (80x24 --ascii en): P2 guard, [n] cancel, [G]+[y] proposals, 100% ASCII pure', async () => {
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
      injectedComplete: createOrganizeCompleteStub(counter),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    await seedTwoMaterials(host);
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
        (s) => s.includes('Library') || s.includes('Sources'),
        { timeoutMs: 8_000, label: 'Initial screen en 80x24' },
      );

      // Navigate to SourcesView ('2')
      tty.send('2');
      const sourcesScreen = await tty.waitFor(
        (s) => s.includes('Linear Algebra Lecture Notes') && s.includes('Operating Systems Virtual Memory'),
        { timeoutMs: 8_000, label: 'SourcesView en 80x24' },
      );
      tty.assertHealthyScreen(sourcesScreen, 80, 24, 'SourcesView --ascii en 80x24');
      tty.assertAsciiPure(sourcesScreen, 'SourcesView --ascii en 80x24');
      assert.equal(counter.calls, 0);

      // Press 'G' -> P2 ConfirmDialog opens with 0 model calls & 100% ASCII pure
      tty.send('G');
      const confirmScreen = await tty.waitFor(
        (s) =>
          s.includes('AI Organize Materials by Course') &&
          s.includes('Analyze 2 material(s) with AI'),
        { timeoutMs: 8_000, label: 'ConfirmDialog --ascii en 80x24' },
      );
      tty.assertHealthyScreen(confirmScreen, 80, 24, 'ConfirmDialog --ascii en 80x24');
      tty.assertAsciiPure(confirmScreen, 'ConfirmDialog --ascii en 80x24');
      await sleep(200);
      await tty.flush();
      assert.equal(counter.calls, 0, 'Opening OrganizeSourcesModal in --ascii en must make 0 AI calls');

      // Press 'n' -> closes cleanly with 0 model calls
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('AI Organize Materials by Course') && s.includes('Linear Algebra Lecture Notes'),
        { timeoutMs: 8_000, label: 'Cancelled back to SourcesView --ascii en' },
      );
      assert.equal(counter.calls, 0);

      // Press 'G' then 'y' -> invokes model once, renders proposals 100% ASCII pure
      tty.send('G');
      await tty.waitFor((s) => s.includes('AI Organize Materials by Course'), { timeoutMs: 8_000 });
      tty.send('y');

      const proposalsScreen = await tty.waitFor(
        (s) =>
          s.includes('AI Organize Courses') &&
          !s.includes('Analyzing') &&
          s.includes('Proposals 2') &&
          s.includes('Linear Algebra'),
        { timeoutMs: 8_000, label: 'Proposals rendered --ascii en 80x24' },
      );
      tty.assertHealthyScreen(proposalsScreen, 80, 24, 'OrganizeSourcesModal proposals --ascii en 80x24');
      tty.assertAsciiPure(proposalsScreen, 'OrganizeSourcesModal proposals --ascii en 80x24');
      assert.equal(counter.calls, 1, 'Expected exactly 1 model call after [G] -> [y]');

      // Esc closes cleanly
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('AI Organize Courses') && s.includes('Linear Algebra Lecture Notes'),
        { timeoutMs: 8_000, label: 'Closed back to SourcesView --ascii en' },
      );
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('3) @xterm/headless E2E: empty library (0 materials) skips ConfirmDialog, renders EmptyState with 0 AI calls', async () => {
    const base = await makeTempDir('e2e-empty');
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
      injectedComplete: createOrganizeCompleteStub(counter),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

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
      await tty.waitFor((s) => s.includes('Library') || s.includes('Sources'), { timeoutMs: 8_000 });
      tty.send('2');
      await tty.waitFor(
        (s) => s.includes('0 sources') || s.includes('No materials') || s.includes('Sources'),
        { timeoutMs: 8_000, label: 'Empty SourcesView' },
      );

      tty.send('G');
      const emptyScreen = await tty.waitFor(
        (s) =>
          s.includes('AI Organize Courses') &&
          s.includes('No organization suggestions') &&
          s.includes('No visible materials to organize'),
        { timeoutMs: 8_000, label: 'EmptyState rendered immediately without ConfirmDialog' },
      );
      tty.assertHealthyScreen(emptyScreen, 80, 24, 'OrganizeSourcesModal EmptyState --ascii en');
      tty.assertAsciiPure(emptyScreen, 'OrganizeSourcesModal EmptyState --ascii en');
      assert.equal(counter.calls, 0, 'Empty library must make 0 AI calls');

      // Pressing 'r' on 0-material EmptyState must not trigger ConfirmDialog or AI call
      tty.send('r');
      await sleep(150);
      await tty.flush();
      assert.ok(!tty.readScreen().includes('AI Organize Materials by Course'), 'Pressing [r] with 0 sources must not open ConfirmDialog');
      assert.equal(counter.calls, 0);

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('AI Organize Courses'), { timeoutMs: 8_000 });
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
