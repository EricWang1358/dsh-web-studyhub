// Round 59 Task 2: GuidedStudyModal Guided Q&A Organize (`study.qa.organize`, 0 LLM tokens)
// node --test --test-concurrency=1 tests/round59-guided-qa.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round59-qa-${label}-`));
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

  const deckRes = await host.call('deck.get', { id: deckMeta.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message}`);
  const cards = deckRes.value?.cards ?? [];
  assert.equal(cards.length, 1, 'Seeded deck must contain 1 card');

  const sessionRes = await host.call('study.session.start', {
    courseId: course,
    scope: [{ kind: 'deck', id: deckMeta.id }],
    goal: { title: goalTitle },
  });
  assert.equal(sessionRes.ok, true, `study.session.start failed: ${sessionRes.error?.message}`);
  assert.ok(sessionRes.value?.id, 'study.session.start must return a session id');
  return { deck: deckRes.value, card: cards[0], session: sessionRes.value };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 59: GuidedStudyModal Guided Q&A Organize (0 LLM tokens)', () => {
  test('1) createTuiHost integration (0 model calls): study.qa.organize persists followup & deduplicates by operationId', async () => {
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
        throw new Error('Network call must not happen during study.qa.organize');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const { deck, card, session } = await seedDeckCardAndSession(host, {
        title: '线性空间问答',
        course: '线性代数',
        goalTitle: '理解基与维数',
        cardPrompt: '什么是线性空间的一组基？',
      });

      const operationId = 'tui-gqa-test-op-1';
      const question = '基与生成元集合的核心区别是什么？';
      const answerMarkdown = '基必须同时满足**线性无关**与**张成整个空间**。';

      const res1 = await host.call('study.qa.organize', {
        sessionId: session.id,
        operationId,
        target: { deckId: deck.id, cardId: card.id },
        question,
        answerMarkdown,
        explicitUserCommand: true,
      });
      assert.equal(res1.ok, true, `study.qa.organize #1 failed: ${res1.error?.message}`);
      assert.equal(res1.value?.ok, true);
      assert.ok(res1.value?.qaId, 'study.qa.organize must return qaId');
      assert.equal(res1.value?.operationId, operationId);
      assert.equal(res1.value?.deduplicated, false);

      const deckAfter1 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckAfter1.ok, true);
      const persistedCard = deckAfter1.value?.cards?.find((c) => c.id === card.id);
      assert.ok(persistedCard, 'Target card must exist after study.qa.organize');
      assert.equal(persistedCard.followups?.length, 1, 'Card must have 1 organized followup');
      assert.equal(persistedCard.followups[0].id, res1.value.qaId);
      assert.equal(persistedCard.followups[0].operationId, operationId);
      assert.equal(persistedCard.followups[0].question, question);
      assert.equal(persistedCard.followups[0].answer, answerMarkdown);

      // Idempotent retry with same operationId & content
      const res2 = await host.call('study.qa.organize', {
        sessionId: session.id,
        operationId,
        target: { deckId: deck.id, cardId: card.id },
        question,
        answerMarkdown,
        explicitUserCommand: true,
      });
      assert.equal(res2.ok, true, `study.qa.organize #2 failed: ${res2.error?.message}`);
      assert.equal(res2.value?.ok, true);
      assert.equal(res2.value?.qaId, res1.value.qaId);
      assert.equal(res2.value?.deduplicated, true, 'Duplicate operationId with identical content must deduplicate');

      const deckAfter2 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckAfter2.ok, true);
      const cardAfter2 = deckAfter2.value?.cards?.find((c) => c.id === card.id);
      assert.equal(cardAfter2?.followups?.length, 1, 'Deduplicated retry must not duplicate followup');
      assert.equal(aiCalls, 0, 'study.qa.organize must make 0 model calls');
      assert.equal(fetchCalls, 0, 'study.qa.organize must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2a) @xterm/headless PTY E2E (120x36 zh): g -> Q -> form -> Tab -> Ctrl+S -> toast & persisted -> Q -> Esc cancel', async () => {
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
        throw new Error('Network call must not happen during GuidedStudyModal Q&A E2E');
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const { deck, card } = await seedDeckCardAndSession(host, {
      title: '特征值问答归档',
      course: '线性代数',
      goalTitle: '攻克特征值概念',
      cardPrompt: '什么是矩阵的特征值与特征向量？',
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
        (s) => s.includes('特征值问答归档') && s.includes('线性代数'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      // Open GuidedStudyModal ('g')
      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('AI 带学工作台') && s.includes('攻克特征值概念') && s.includes('整理问答') && !s.includes('正在读取带学工作台'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session zh' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'GuidedStudyModal active zh 120x36');

      // Press 'Q' -> open qa-form
      tty.send('Q');
      const qaFormScreen = await tty.waitFor(
        (s) => s.includes('整理问答归档') && s.includes('什么是矩阵的特征值与特征向量'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form opened zh' },
      );
      tty.assertHealthyScreen(qaFormScreen, 120, 36, 'GuidedStudyModal qa-form zh 120x36');

      const qText = '为什么特征向量不能为零向量？';
      const aText = '零向量对任意常数均满足 Av = lambda v，无法确定特征值。';

      tty.send(qText);
      await tty.waitFor((s) => s.includes('为什么特征向量不能为零向量'), { timeoutMs: 5_000, label: 'question text rendered zh' });

      tty.send('\t');
      await tty.flush();
      tty.send(aText);
      await tty.waitFor((s) => s.includes('无法确定特征值'), { timeoutMs: 5_000, label: 'answer text rendered zh' });

      // Ctrl+S submit
      tty.send('\x13');
      const afterSubmit = await tty.waitFor(
        (s) =>
          !s.includes('整理问答归档') &&
          s.includes('攻克特征值概念') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已整理问答并归档到卡片')),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form submitted toast zh' },
      );
      tty.assertHealthyScreen(afterSubmit, 120, 36, 'GuidedStudyModal after qa-form submit zh');

      const deckCheck1 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckCheck1.ok, true);
      const cardCheck1 = deckCheck1.value?.cards?.find((c) => c.id === card.id);
      assert.equal(cardCheck1?.followups?.length, 1, 'Card must persist 1 organized QA followup');
      assert.equal(cardCheck1.followups[0].question, qText);
      assert.equal(cardCheck1.followups[0].answer, aText);

      // Re-open qa-form with 'Q' and verify Esc cancels cleanly back to workbench
      tty.send('Q');
      await tty.waitFor((s) => s.includes('整理问答归档'), { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form re-opened zh' });

      tty.send('\x1b');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('整理问答归档') && s.includes('AI 带学工作台') && s.includes('攻克特征值概念'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form Esc cancel zh' },
      );
      tty.assertHealthyScreen(afterCancel, 120, 36, 'GuidedStudyModal after qa-form Esc cancel zh');

      const deckCheck2 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckCheck2.ok, true);
      const cardCheck2 = deckCheck2.value?.cards?.find((c) => c.id === card.id);
      assert.equal(cardCheck2?.followups?.length, 1, 'Esc cancel must not persist extra followup');
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

  test('2b) @xterm/headless PTY E2E (80x24 --ascii en): g -> Q -> Tab -> Ctrl+S -> Esc cancel (pure ASCII)', async () => {
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
        throw new Error('Network call must not happen during --ascii GuidedStudyModal Q&A E2E');
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const { deck, card } = await seedDeckCardAndSession(host, {
      title: 'Eigenvalues Q&A',
      course: 'Linear Algebra',
      goalTitle: 'Master Eigenvectors',
      cardPrompt: 'What is an eigenvector of a matrix?',
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
        (s) => s.includes('Eigenvalues Q&A') && s.includes('Linear Algebra'),
        { timeoutMs: 8_000, label: 'LibraryView en --ascii ready' },
      );
      tty.assertHealthyScreen(libScreen, 80, 24, 'LibraryView en --ascii 80x24');
      tty.assertAsciiPure(libScreen, 'LibraryView en --ascii 80x24');

      // Open GuidedStudyModal ('g')
      tty.send('g');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Guided Study Workbench') && s.includes('Master Eigenvectors') && s.includes('Save Q&A') && !s.includes('Loading guided study'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal active session en --ascii' },
      );
      tty.assertHealthyScreen(modalScreen, 80, 24, 'GuidedStudyModal active en --ascii');
      tty.assertAsciiPure(modalScreen, 'GuidedStudyModal active en --ascii');

      // Press 'Q' -> open qa-form
      tty.send('Q');
      const qaFormScreen = await tty.waitFor(
        (s) => s.includes('Save Organized Q&A') && s.includes('What is an eigenvector'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form en --ascii' },
      );
      tty.assertHealthyScreen(qaFormScreen, 80, 24, 'GuidedStudyModal qa-form en --ascii');
      tty.assertAsciiPure(qaFormScreen, 'GuidedStudyModal qa-form en --ascii');

      const qText = 'Why nonzero eigenvector?';
      const aText = 'Zero vector satisfies Av = lv trivially.';

      tty.send(qText);
      const qTyped = await tty.waitFor((s) => s.includes(qText), { timeoutMs: 5_000, label: 'question text rendered en --ascii' });
      tty.assertAsciiPure(qTyped, 'GuidedStudyModal qa-form question typed en --ascii');

      tty.send('\t');
      await tty.flush();
      tty.send(aText);
      const aTyped = await tty.waitFor((s) => s.includes(aText), { timeoutMs: 5_000, label: 'answer text rendered en --ascii' });
      tty.assertAsciiPure(aTyped, 'GuidedStudyModal qa-form answer typed en --ascii');

      // Ctrl+S submit
      tty.send('\x13');
      const afterSubmit = await tty.waitFor(
        (s) =>
          !s.includes('Save Organized Q&A') &&
          s.includes('Master Eigenvectors') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text === 'Saved organized Q&A to card'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form submitted toast en --ascii' },
      );
      tty.assertHealthyScreen(afterSubmit, 80, 24, 'GuidedStudyModal after qa-form submit en --ascii');
      tty.assertAsciiPure(afterSubmit, 'GuidedStudyModal after qa-form submit en --ascii');

      const deckCheck1 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckCheck1.ok, true);
      const cardCheck1 = deckCheck1.value?.cards?.find((c) => c.id === card.id);
      assert.equal(cardCheck1?.followups?.length, 1);
      assert.equal(cardCheck1.followups[0].question, qText);
      assert.equal(cardCheck1.followups[0].answer, aText);

      // Re-open qa-form with 'Q' and verify Esc cancels cleanly back to workbench
      tty.send('Q');
      const reopened = await tty.waitFor((s) => s.includes('Save Organized Q&A'), { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form re-opened en --ascii' });
      tty.assertAsciiPure(reopened, 'GuidedStudyModal qa-form re-opened en --ascii');

      tty.send('\x1b');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('Save Organized Q&A') && s.includes('Guided Study Workbench') && s.includes('Master Eigenvectors'),
        { timeoutMs: 8_000, label: 'GuidedStudyModal qa-form Esc cancel en --ascii' },
      );
      tty.assertHealthyScreen(afterCancel, 80, 24, 'GuidedStudyModal after qa-form Esc cancel en --ascii');
      tty.assertAsciiPure(afterCancel, 'GuidedStudyModal after qa-form Esc cancel en --ascii');

      const deckCheck2 = await host.call('deck.get', { id: deck.id });
      assert.equal(deckCheck2.ok, true);
      assert.equal(deckCheck2.value?.cards?.find((c) => c.id === card.id)?.followups?.length, 1);
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
