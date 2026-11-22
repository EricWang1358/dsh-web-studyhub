// Round 58 Task 3: GuidedStudyModal Knowledge Branch Open/Return (`study.branch.open` & `study.branch.return`, 0 LLM tokens)
// + HelpOverlay & KEYBINDINGS sync tests:
// node --test --test-concurrency=1 tests/round58-study-branch.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round58-branch-${label}-`));
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

async function seedTwoCardDeckAndSession(host, { title, course, goalTitle, cardPrompts }) {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        { kind: 'flashcard', prompt: cardPrompts[0], answer: 'Definition of basis.', topic: 'Basis' },
        { kind: 'flashcard', prompt: cardPrompts[1], answer: 'Dimension equals basis size.', topic: 'Dimension' },
      ],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deckMeta = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deckMeta, `Seeded deck "${title}" must exist in snapshot`);

  const deckRes = await host.call('deck.get', { id: deckMeta.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message}`);
  const cards = deckRes.value?.cards ?? [];
  assert.equal(cards.length, 2, 'Seeded deck must contain 2 cards');

  const sessionRes = await host.call('study.session.start', {
    courseId: course,
    scope: [{ kind: 'deck', id: deckMeta.id }],
    goal: { title: goalTitle },
  });
  assert.equal(sessionRes.ok, true, `study.session.start failed: ${sessionRes.error?.message}`);
  assert.ok(sessionRes.value?.id, 'study.session.start must return a session id');
  return { deck: deckRes.value, cards, session: sessionRes.value };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 58: GuidedStudyModal Knowledge Branch Open/Return (0 LLM tokens)', () => {
  test('1) createTuiHost integration (0 model calls): study.branch.open & study.branch.return track focus & returnPath', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: join(base, 'home'),
      documentsDir: base,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during study.branch.open/return');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const { deck, cards, session } = await seedTwoCardDeckAndSession(host, {
        title: '线性空间基础',
        course: '线性代数',
        goalTitle: '掌握基与维数',
        cardPrompts: ['什么是线性空间的一组基？', '线性空间的维数如何定义？'],
      });
      const [card1, card2] = cards;

      const open1 = await host.call('study.branch.open', {
        sessionId: session.id,
        targetDeckId: deck.id,
        targetCardId: card1.id,
        branchKind: 'prerequisite',
      });
      assert.equal(open1.ok, true, `study.branch.open #1 failed: ${open1.error?.message}`);
      assert.equal(open1.value?.session?.focus?.id, card1.id, 'First branch must focus card1');
      assert.equal(open1.value?.session?.focus?.deckId, deck.id);
      assert.ok(open1.value?.branchRun?.id, 'study.branch.open must create isolated branchRun');
      assert.equal(open1.value?.branchRun?.mode, 'path');
      assert.equal(open1.value?.session?.returnPath?.length ?? 0, 0);

      const open2 = await host.call('study.branch.open', {
        sessionId: session.id,
        targetDeckId: deck.id,
        targetCardId: card2.id,
        branchKind: 'prerequisite',
      });
      assert.equal(open2.ok, true, `study.branch.open #2 failed: ${open2.error?.message}`);
      assert.equal(open2.value?.session?.focus?.id, card2.id, 'Second branch must focus card2');
      assert.equal(open2.value?.session?.returnPath?.length, 1, 'Second branch must push card1 onto returnPath');
      assert.equal(open2.value?.session?.returnPath?.[0]?.cardId, card1.id);

      const ret = await host.call('study.branch.return', {
        sessionId: session.id,
      });
      assert.equal(ret.ok, true, `study.branch.return failed: ${ret.error?.message}`);
      assert.equal(ret.value?.session?.focus?.id, card1.id, 'study.branch.return must restore focus to card1');
      assert.equal(ret.value?.session?.returnPath?.length, 0, 'study.branch.return must pop returnPath back to 0');

      const getRes = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(getRes.ok, true, `study.session.get failed: ${getRes.error?.message}`);
      assert.equal(getRes.value?.focus?.id, card1.id);
      assert.equal(getRes.value?.returnPath?.length ?? 0, 0);
      assert.equal(aiCalls, 0, 'study.branch.open/return must make 0 model calls');
      assert.equal(fetchCalls, 0, 'study.branch.open/return must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2a) @xterm/headless PTY E2E (120x36 zh): g -> B -> Enter -> B -> Enter -> u -> Esc -> ? HelpOverlay', async () => {
    const base = await makeTempDir('e2e-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during GuidedStudyModal branch E2E');
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const { cards, session } = await seedTwoCardDeckAndSession(host, {
      title: '特征值与相似矩阵',
      course: '线性代数',
      goalTitle: '攻克相似对角化',
      cardPrompts: ['前置基础：什么是特征向量？', '核心推导：矩阵何时可对角化？'],
    });

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
      const libScreen = await tty.waitFor(
        (s) => s.includes('特征值与相似矩阵') && s.includes('线性代数'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready with seeded deck' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      // Open GuidedStudyModal ('g')
      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('AI 带学工作台') && s.includes('攻克相似对角化') && !s.includes('正在读取带学工作台'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session zh' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'GuidedStudyModal active zh 120x36');

      // Press 'B' -> open branch card picker -> select card 1 + Enter
      tty.send('B');
      const pick1Screen = await tty.waitFor(
        (s) => s.includes('前置支线选卡') && s.includes('什么是特征向量'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch picker #1 zh' },
      );
      tty.assertHealthyScreen(pick1Screen, 120, 36, 'GuidedStudyModal branch picker #1 zh');

      tty.send('\r');
      const afterBranch1 = await tty.waitFor(
        (s) =>
          !s.includes('前置支线选卡') &&
          s.includes('已切入前置支线练习（按 [u] 返回原题）') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('前置支线')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch #1 opened toast zh' },
      );
      tty.assertHealthyScreen(afterBranch1, 120, 36, 'GuidedStudyModal after branch #1 zh');

      // Press 'B' again -> pick second card + Enter -> verify branch depth badge '支线深度 1'
      tty.send('B');
      const pick2Screen = await tty.waitFor(
        (s) => s.includes('前置支线选卡') && s.includes('矩阵何时可对角化'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch picker #2 zh' },
      );
      tty.assertHealthyScreen(pick2Screen, 120, 36, 'GuidedStudyModal branch picker #2 zh');

      tty.send('\r');
      const afterBranch2 = await tty.waitFor(
        (s) => !s.includes('前置支线选卡') && s.includes('支线深度 1'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch depth badge zh' },
      );
      tty.assertHealthyScreen(afterBranch2, 120, 36, 'GuidedStudyModal branch depth 1 zh');

      // Press 'u' -> verify returned from branch cleanly
      tty.send('u');
      const afterReturn = await tty.waitFor(
        (s) =>
          !s.includes('支线深度 1') &&
          s.includes('已从前置支线回到原学习焦点') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('回到原学习焦点')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch returned toast zh' },
      );
      tty.assertHealthyScreen(afterReturn, 120, 36, 'GuidedStudyModal after return zh');

      const sessionCheck = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionCheck.ok, true);
      assert.equal(sessionCheck.value?.focus?.id, cards[0].id, 'Returned session focus must be card 1');
      assert.equal(sessionCheck.value?.returnPath?.length ?? 0, 0, 'Returned session returnPath must be empty');

      // Close GuidedStudyModal ('Esc') and verify HelpOverlay ('?') documents Round 58 keys
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('AI 带学工作台'), { timeoutMs: 8_000, label: 'GuidedStudyModal closed zh' });

      tty.send('?');
      const helpTopScreen = await tty.waitFor(
        (s) =>
          s.includes('快捷键') &&
          (s.includes('B支线/u回') || s.includes('B开支线/u返回')),
        { timeoutMs: 8_000, label: 'HelpOverlay updated Library label zh' },
      );
      tty.assertHealthyScreen(helpTopScreen, 120, 36, 'HelpOverlay top zh 120x36');

      tty.send('G');
      const helpBottomScreen = await tty.waitFor(
        (s) => s.includes('语义检索诊断/试搜/镜像源'),
        { timeoutMs: 8_000, label: 'HelpOverlay updated Settings label zh' },
      );
      tty.assertHealthyScreen(helpBottomScreen, 120, 36, 'HelpOverlay bottom zh 120x36');
      assert.equal(aiCalls, 0, 'PTY zh flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY zh flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('2b) @xterm/headless PTY E2E (80x24 --ascii en): g -> B -> Enter -> B -> Enter -> u -> ? HelpOverlay (pure ASCII)', async () => {
    const base = await makeTempDir('e2e-en-ascii');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    resetDistStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during --ascii GuidedStudyModal branch E2E');
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const { cards, session } = await seedTwoCardDeckAndSession(host, {
      title: 'Eigenvalues Basics',
      course: 'Linear Algebra',
      goalTitle: 'Master Diagonalization',
      cardPrompts: ['Prereq: What is an eigenvector?', 'Core: When is a matrix diagonalizable?'],
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
      const libScreen = await tty.waitFor(
        (s) => s.includes('Eigenvalues Basics') && s.includes('Linear Algebra'),
        { timeoutMs: 8_000, label: 'LibraryView en --ascii ready' },
      );
      tty.assertHealthyScreen(libScreen, 80, 24, 'LibraryView en --ascii 80x24');
      tty.assertAsciiPure(libScreen, 'LibraryView en --ascii 80x24');

      // Open GuidedStudyModal ('g')
      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Guided Study Workbench') && s.includes('Master Diagonalization') && !s.includes('Loading guided study'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session en --ascii' },
      );
      tty.assertHealthyScreen(modalScreen, 80, 24, 'GuidedStudyModal active en --ascii');
      tty.assertAsciiPure(modalScreen, 'GuidedStudyModal active en --ascii');

      // Press 'B' -> select card 1 + Enter
      tty.send('B');
      const pick1Screen = await tty.waitFor(
        (s) => s.includes('Branch Card Picker') && s.includes('What is an eigenvector?'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch picker #1 en --ascii' },
      );
      tty.assertHealthyScreen(pick1Screen, 80, 24, 'GuidedStudyModal branch picker #1 en --ascii');
      tty.assertAsciiPure(pick1Screen, 'GuidedStudyModal branch picker #1 en --ascii');

      tty.send('\r');
      const afterBranch1 = await tty.waitFor(
        (s) =>
          !s.includes('Branch Card Picker') &&
          s.includes('Opened prerequisite') &&
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text === 'Opened prerequisite branch (press [u] to return)',
          ),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch #1 toast en --ascii' },
      );
      tty.assertHealthyScreen(afterBranch1, 80, 24, 'GuidedStudyModal after branch #1 en --ascii');
      tty.assertAsciiPure(afterBranch1, 'GuidedStudyModal after branch #1 en --ascii');

      // Press 'B' again -> select card 2 + Enter -> verify 'Branch x1' badge
      tty.send('B');
      const pick2Screen = await tty.waitFor(
        (s) => s.includes('Branch Card Picker') && s.includes('When is a matrix diagonalizable?'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal branch picker #2 en --ascii' },
      );
      tty.assertHealthyScreen(pick2Screen, 80, 24, 'GuidedStudyModal branch picker #2 en --ascii');
      tty.assertAsciiPure(pick2Screen, 'GuidedStudyModal branch picker #2 en --ascii');

      tty.send('\r');
      const afterBranch2 = await tty.waitFor(
        (s) => !s.includes('Branch Card Picker') && s.includes('Branch x1'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal Branch x1 badge en --ascii' },
      );
      tty.assertHealthyScreen(afterBranch2, 80, 24, 'GuidedStudyModal Branch x1 en --ascii');
      tty.assertAsciiPure(afterBranch2, 'GuidedStudyModal Branch x1 en --ascii');

      // Press 'u' -> verify returned cleanly
      tty.send('u');
      const afterReturn = await tty.waitFor(
        (s) =>
          !s.includes('Branch x1') &&
          s.includes('Returned from branch') &&
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text === 'Returned from branch to previous focus',
          ),
        { timeoutMs: 8_000, label: 'GuidedStudyModal returned toast en --ascii' },
      );
      tty.assertHealthyScreen(afterReturn, 80, 24, 'GuidedStudyModal after return en --ascii');
      tty.assertAsciiPure(afterReturn, 'GuidedStudyModal after return en --ascii');

      const sessionCheck = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionCheck.ok, true);
      assert.equal(sessionCheck.value?.focus?.id, cards[0].id);
      assert.equal(sessionCheck.value?.returnPath?.length ?? 0, 0);

      // Close GuidedStudyModal ('Esc') and open HelpOverlay ('?')
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('Guided Study Workbench'), { timeoutMs: 8_000, label: 'GuidedStudyModal closed en --ascii' });

      tty.send('?');
      const helpOpenScreen = await tty.waitFor(
        (s) => s.includes('Keyboard Shortcuts'),
        { timeoutMs: 8_000, label: 'HelpOverlay opened en --ascii 80x24' },
      );
      tty.assertHealthyScreen(helpOpenScreen, 80, 24, 'HelpOverlay open en --ascii 80x24');
      tty.assertAsciiPure(helpOpenScreen, 'HelpOverlay open en --ascii 80x24');

      // In 80x24 single-column HelpOverlay, page down via Space waiting for each render until Library & Settings labels appear
      let prevHelpScreen = helpOpenScreen;
      let seenLibraryLabel = helpOpenScreen.includes('B/u/Q') || helpOpenScreen.includes('B branch/u back');
      let seenSettingsLabel = helpOpenScreen.includes('Retrieval diag / search / mirror');
      for (let step = 0; step < 20 && (!seenLibraryLabel || !seenSettingsLabel); step += 1) {
        tty.send(' ');
        const cur = await tty.waitFor(
          (s) => s !== prevHelpScreen,
          { timeoutMs: 2_000, label: `HelpOverlay page down #${step + 1}` },
        ).catch(() => tty.readScreen());
        tty.assertHealthyScreen(cur, 80, 24, `HelpOverlay scroll #${step + 1} en --ascii 80x24`);
        tty.assertAsciiPure(cur, `HelpOverlay scroll #${step + 1} en --ascii 80x24`);
        if (cur.includes('B/u/Q') || cur.includes('B branch/u back')) seenLibraryLabel = true;
        if (cur.includes('Retrieval diag / search / mirror')) seenSettingsLabel = true;
        if (cur === prevHelpScreen) break;
        prevHelpScreen = cur;
      }
      assert.equal(seenLibraryLabel, true, 'HelpOverlay must display updated Library [g] label in en --ascii');
      assert.equal(seenSettingsLabel, true, 'HelpOverlay must display updated Settings [t] label in en --ascii');
      assert.equal(aiCalls, 0, 'PTY en --ascii flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY en --ascii flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
