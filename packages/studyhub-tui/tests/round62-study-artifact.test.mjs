// Round 62 Track 1: GuidedStudyModal Save Teaching Artifact (`study.session.artifact.save`, 0 LLM tokens)
// node --test --test-concurrency=1 tests/round62-study-artifact.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round62-artifact-${label}-`));
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

async function seedDeckCardAndSession(host, { title, course, goalTitle, cardPrompt }) {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        { kind: 'flashcard', prompt: cardPrompt, answer: 'Core answer.', topic: 'Basis' },
      ],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deckMeta = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deckMeta, `Seeded deck "${title}" must exist in snapshot`);

  const sessionRes = await host.call('study.session.start', {
    courseId: course,
    scope: [{ kind: 'deck', id: deckMeta.id }],
    goal: { title: goalTitle },
  });
  assert.equal(sessionRes.ok, true, `study.session.start failed: ${sessionRes.error?.message}`);
  assert.ok(sessionRes.value?.id, 'study.session.start must return a session id');
  return { deckMeta, session: sessionRes.value };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 62: GuidedStudyModal Save Teaching Artifact (0 LLM tokens)', () => {
  test('1) createTuiHost integration (0 model calls): study.session.artifact.save persists artifactRefs & deduplicates by operationId', async () => {
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
        throw new Error('Network call must not happen during study.session.artifact.save');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const { session } = await seedDeckCardAndSession(host, {
        title: '微积分重点总结',
        course: '高等数学',
        goalTitle: '掌握泰勒展开与拉格朗日余项',
        cardPrompt: '写出带拉格朗日余项的泰勒公式。',
      });

      const operationId = randomUUID();
      const title = '泰勒公式余项推导';
      const kind = 'formula';
      const topic = '泰勒展开';
      const markdown = '设 $f$ 在包含 $x_0$ 的区间内 $n+1$ 阶可导，则余项为 $R_n(x)$。';

      const res1 = await host.call('study.session.artifact.save', {
        sessionId: session.id,
        title,
        kind,
        topic,
        markdown,
        operationId,
      });
      assert.equal(res1.ok, true, `study.session.artifact.save #1 failed: ${res1.error?.message}`);
      assert.ok(res1.value?.artifactId, 'study.session.artifact.save must return artifactId');
      assert.equal(res1.value?.operationId, operationId);
      assert.equal(res1.value?.deduplicated, false);
      assert.equal(res1.value?.artifact?.id, res1.value.artifactId);
      assert.equal(res1.value?.artifact?.title, title);
      assert.equal(res1.value?.artifact?.kind, kind);
      assert.equal(res1.value?.artifact?.topic, topic);
      assert.equal(res1.value?.artifact?.markdown, markdown);

      const getAfter1 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(getAfter1.ok, true, `study.session.get #1 failed: ${getAfter1.error?.message}`);
      assert.equal(getAfter1.value?.artifactRefs?.length, 1, 'Session must persist 1 artifact in artifactRefs');
      assert.equal(getAfter1.value.artifactRefs[0].id, res1.value.artifactId);
      assert.equal(getAfter1.value.artifactRefs[0].kind, kind);
      assert.equal(getAfter1.value.artifactRefs[0].title, title);
      assert.equal(getAfter1.value.artifactRefs[0].topic, topic);
      assert.equal(getAfter1.value.artifactRefs[0].markdown, markdown);

      // Idempotent retry with same operationId
      const res2 = await host.call('study.session.artifact.save', {
        sessionId: session.id,
        title,
        kind,
        topic,
        markdown,
        operationId,
      });
      assert.equal(res2.ok, true, `study.session.artifact.save #2 failed: ${res2.error?.message}`);
      assert.equal(res2.value?.deduplicated, true, 'Duplicate operationId must return deduplicated: true');
      assert.equal(res2.value?.artifactId, res1.value.artifactId);
      assert.equal(res2.value?.operationId, operationId);

      const getAfter2 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(getAfter2.ok, true);
      assert.equal(getAfter2.value?.artifactRefs?.length, 1, 'Deduplicated retry must not increase artifactRefs count');
      assert.equal(aiCalls, 0, 'study.session.artifact.save must make 0 model calls');
      assert.equal(fetchCalls, 0, 'study.session.artifact.save must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): g -> A -> title -> Tab -> Space (summary) -> Tab -> markdown -> Ctrl+S -> artifact view -> A -> Esc cancel', async () => {
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
        throw new Error('Network call must not happen during GuidedStudyModal artifact E2E');
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const { session } = await seedDeckCardAndSession(host, {
      title: '特征值讲义归档',
      course: '线性代数',
      goalTitle: '吃透相似对角化',
      cardPrompt: '矩阵可对角化的充要条件是什么？',
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
        (s) => s.includes('特征值讲义归档') && s.includes('线性代数'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      // Open GuidedStudyModal ('g')
      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('AI 带学工作台') && s.includes('吃透相似对角化') && s.includes('保存讲解') && !s.includes('正在读取带学工作台'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session zh' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'GuidedStudyModal active zh 120x36');

      // Press 'A' -> open artifact-form
      tty.send('A');
      const formScreen = await tty.waitFor(
        (s) => s.includes('保存教学讲解') && s.includes('类型 (Kind): explanation'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form opened zh' },
      );
      tty.assertHealthyScreen(formScreen, 120, 36, 'GuidedStudyModal artifact-form zh 120x36');

      const artifactTitle = '相似对角化判别速记';
      const artifactMarkdown = '当且仅当矩阵有 $n$ 个线性无关的特征向量时可对角化。';

      tty.send(artifactTitle);
      await tty.waitFor((s) => s.includes(artifactTitle), { timeoutMs: 5_000, label: 'artifact title rendered zh' });

      // Tab to Kind field, Space to cycle explanation -> summary
      tty.send('\t');
      await tty.flush();
      tty.send(' ');
      await tty.waitFor((s) => s.includes('类型 (Kind): summary'), { timeoutMs: 5_000, label: 'artifact kind cycled to summary zh' });

      // Tab to Markdown field and type content
      tty.send('\t');
      await tty.flush();
      tty.send(artifactMarkdown);
      await tty.waitFor((s) => s.includes('线性无关的特征向量'), { timeoutMs: 5_000, label: 'artifact markdown rendered zh' });

      // Ctrl+S submit
      tty.send('\x13');
      const afterSubmit = await tty.waitFor(
        (s) =>
          !s.includes('标题 (Title)') &&
          s.includes('[3] 讲解(1)') &&
          s.includes(artifactTitle) &&
          s.includes('线性无关的特征向量') &&
          s.includes('总结') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已保存教学讲解到会话')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form submitted & artifact view shown zh' },
      );
      tty.assertHealthyScreen(afterSubmit, 120, 36, 'GuidedStudyModal after artifact submit zh');

      const sessionAfter1 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionAfter1.ok, true);
      assert.equal(sessionAfter1.value?.artifactRefs?.length, 1, 'Session must persist 1 teaching artifact');
      assert.equal(sessionAfter1.value.artifactRefs[0].title, artifactTitle);
      assert.equal(sessionAfter1.value.artifactRefs[0].kind, 'summary');
      assert.equal(sessionAfter1.value.artifactRefs[0].markdown, artifactMarkdown);
      assert.equal(sessionAfter1.value.receipts?.length, 1, 'Session must record 1 operationId receipt');
      assert.match(sessionAfter1.value.receipts[0].operationId, /^[0-9a-f-]{36}$/i);

      // Re-open artifact-form with 'A' and verify Esc cancels cleanly without saving
      tty.send('A');
      await tty.waitFor((s) => s.includes('保存教学讲解'), { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form re-opened zh' });

      tty.send('\x1b');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('保存教学讲解') && s.includes('AI 带学工作台') && s.includes(artifactTitle),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form Esc cancel zh' },
      );
      tty.assertHealthyScreen(afterCancel, 120, 36, 'GuidedStudyModal after artifact-form Esc cancel zh');

      const sessionAfter2 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionAfter2.ok, true);
      assert.equal(sessionAfter2.value?.artifactRefs?.length, 1, 'Esc cancel must not persist extra artifact');
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

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): g -> A -> fill & Ctrl+S -> assertHealthyScreen & assertAsciiPure on every frame (0 model calls)', async () => {
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
        throw new Error('Network call must not happen during --ascii GuidedStudyModal artifact E2E');
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const { session } = await seedDeckCardAndSession(host, {
      title: 'Eigenvalues Deck',
      course: 'Linear Algebra',
      goalTitle: 'Master Diagonalization',
      cardPrompt: 'When is a square matrix diagonalizable?',
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
        (s) => s.includes('Eigenvalues Deck') && s.includes('Linear Algebra'),
        { timeoutMs: 8_000, label: 'LibraryView en --ascii ready' },
      );
      tty.assertHealthyScreen(libScreen, 80, 24, 'LibraryView en --ascii 80x24');
      tty.assertAsciiPure(libScreen, 'LibraryView en --ascii 80x24');

      // Open GuidedStudyModal ('g')
      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Guided Study Workbench') && s.includes('Master Diagonalization') && s.includes('Artifact') && !s.includes('Loading guided study'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session en --ascii' },
      );
      tty.assertHealthyScreen(modalScreen, 80, 24, 'GuidedStudyModal active en --ascii');
      tty.assertAsciiPure(modalScreen, 'GuidedStudyModal active en --ascii');

      // Press 'A' -> open artifact-form
      tty.send('A');
      const formScreen = await tty.waitFor(
        (s) => s.includes('Save Teaching Artifact') && s.includes('Kind: explanation'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact-form en --ascii' },
      );
      tty.assertHealthyScreen(formScreen, 80, 24, 'GuidedStudyModal artifact-form en --ascii');
      tty.assertAsciiPure(formScreen, 'GuidedStudyModal artifact-form en --ascii');

      const artifactTitle = 'Diagonalization Criterion';
      const artifactMarkdown = 'Matrix A is diagonalizable iff algebraic = geometric multiplicity.';

      tty.send(artifactTitle);
      const titleTyped = await tty.waitFor((s) => s.includes(artifactTitle), { timeoutMs: 5_000, label: 'artifact title rendered en --ascii' });
      tty.assertHealthyScreen(titleTyped, 80, 24, 'artifact-form title typed en --ascii');
      tty.assertAsciiPure(titleTyped, 'artifact-form title typed en --ascii');

      // Tab to Kind, Space twice (explanation -> summary -> formula)
      tty.send('\t');
      await tty.flush();
      tty.send(' ');
      const kindStep1 = await tty.waitFor((s) => s.includes('Kind: summary'), { timeoutMs: 5_000, label: 'kind summary en --ascii' });
      tty.assertHealthyScreen(kindStep1, 80, 24, 'artifact-form kind summary en --ascii');
      tty.assertAsciiPure(kindStep1, 'artifact-form kind summary en --ascii');

      tty.send(' ');
      const kindStep2 = await tty.waitFor((s) => s.includes('Kind: formula'), { timeoutMs: 5_000, label: 'kind formula en --ascii' });
      tty.assertHealthyScreen(kindStep2, 80, 24, 'artifact-form kind formula en --ascii');
      tty.assertAsciiPure(kindStep2, 'artifact-form kind formula en --ascii');

      // Tab to Markdown and type body
      tty.send('\t');
      await tty.flush();
      tty.send(artifactMarkdown);
      const mdTyped = await tty.waitFor((s) => s.includes('geometric multiplicity'), { timeoutMs: 5_000, label: 'artifact markdown rendered en --ascii' });
      tty.assertHealthyScreen(mdTyped, 80, 24, 'artifact-form markdown typed en --ascii');
      tty.assertAsciiPure(mdTyped, 'artifact-form markdown typed en --ascii');

      // Ctrl+S submit
      tty.send('\x13');
      const afterSubmit = await tty.waitFor(
        (s) =>
          !s.includes('Save Teaching Artifact') &&
          s.includes(artifactTitle) &&
          s.includes('Formula') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text === 'Saved teaching artifact to session'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal artifact submitted en --ascii' },
      );
      tty.assertHealthyScreen(afterSubmit, 80, 24, 'GuidedStudyModal after artifact submit en --ascii');
      tty.assertAsciiPure(afterSubmit, 'GuidedStudyModal after artifact submit en --ascii');

      const sessionAfter1 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionAfter1.ok, true);
      assert.equal(sessionAfter1.value?.artifactRefs?.length, 1);
      assert.equal(sessionAfter1.value.artifactRefs[0].title, artifactTitle);
      assert.equal(sessionAfter1.value.artifactRefs[0].kind, 'formula');
      assert.equal(sessionAfter1.value.artifactRefs[0].markdown, artifactMarkdown);

      // Re-open with 'A' and cancel with Esc
      tty.send('A');
      const reopened = await tty.waitFor((s) => s.includes('Save Teaching Artifact'), { timeoutMs: 8_000, label: 'artifact-form reopened en --ascii' });
      tty.assertHealthyScreen(reopened, 80, 24, 'artifact-form reopened en --ascii');
      tty.assertAsciiPure(reopened, 'artifact-form reopened en --ascii');

      tty.send('\x1b');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('Save Teaching Artifact') && s.includes('Guided Study Workbench') && s.includes(artifactTitle),
        { timeoutMs: 8_000, label: 'artifact-form Esc cancel en --ascii' },
      );
      tty.assertHealthyScreen(afterCancel, 80, 24, 'GuidedStudyModal after artifact-form Esc cancel en --ascii');
      tty.assertAsciiPure(afterCancel, 'GuidedStudyModal after artifact-form Esc cancel en --ascii');

      const sessionAfter2 = await host.call('study.session.get', { sessionId: session.id });
      assert.equal(sessionAfter2.ok, true);
      assert.equal(sessionAfter2.value?.artifactRefs?.length, 1);
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
