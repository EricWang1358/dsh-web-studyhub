// Round 64 Track 3: CourseSettingsModal Tab 3 [a] course.terms.attach (0 LLM tokens)
// `node --test --test-concurrency=1 tests/round64-terms-attach.test.mjs`
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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round64-attach-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
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
  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, resolveWrite);
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

async function seedCourseWithCards(host, courseName = 'Computer Networks') {
  const cRes = await host.call('course.save', {
    name: courseName,
    focusTopics: ['BGP', 'Ingress Filtering'],
  });
  assert.equal(cRes.ok, true, `course.save failed: ${cRes.error?.message}`);

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Edge Routing',
      course: courseName,
      cards: [
        {
          kind: 'flashcard',
          prompt: 'Explain BCP38 primary goal in edge networks.',
          answer: 'Prevents source IP spoofing via ingress filtering.',
          topic: 'Ingress Filtering',
        },
        {
          kind: 'flashcard',
          prompt: 'Explain BCP38 deployment caveats at multihomed AS borders.',
          answer: 'Asymmetric routing requires loose-mode uRPF.',
          topic: 'BGP',
        },
      ],
    }),
    folder: courseName,
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
  const snap = await host.refreshSnapshot();
  const deck = snap.snapshot.decks.find((d) => d.course === courseName);
  assert.ok(deck, 'seeded deck should exist in snapshot');
  const deckGet = await host.call('deck.get', { id: deck.id });
  assert.equal(deckGet.ok, true);
  const cards = deckGet.value?.cards ?? [];
  assert.equal(cards.length, 2, 'expected 2 seeded cards');
  return { course: cRes.value, deckId: deck.id, cards };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Round 64 Track 3: CourseSettingsModal Tab 3 [a] course.terms.attach', () => {
  test('1) createTuiHost integration (0 model calls): mark term -> course.terms.attach -> course.terms.get returns item.card', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const home = join(base, 'home');
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home,
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      complete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call during 0-token course.terms.attach test');
      },
    });

    try {
      const { deckId, cards } = await seedCourseWithCards(host, 'Computer Networks');
      const targetCard = cards[0];

      const markRes = await host.call('course.terms.mark', {
        course: 'Computer Networks',
        terms: ['BCP38'],
      });
      assert.equal(markRes.ok, true, `course.terms.mark failed: ${markRes.error?.message}`);
      assert.equal(markRes.value?.added, 1);

      const attachRes = await host.call('course.terms.attach', {
        course: 'Computer Networks',
        links: [
          {
            term: 'BCP38',
            card: { deckId, cardId: targetCard.id },
          },
        ],
      });
      assert.equal(attachRes.ok, true, `course.terms.attach failed: ${attachRes.error?.message}`);
      assert.equal(attachRes.value?.attached, 1);

      const got = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(got.ok, true, `course.terms.get failed: ${got.error?.message}`);
      assert.equal(got.value?.items?.length, 1);
      assert.deepEqual(got.value.items[0].card, { deckId, cardId: targetCard.id });
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): LibraryView -> C -> Tab 3 -> [a] -> pick card -> Enter -> linked toast & badge persists -> Esc (0 LLM calls)', async () => {
    const base = await makeTempDir('ui-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false });
    resetDistStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      complete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call during CourseSettings attachCard flow');
      },
    });

    const { deckId, cards } = await seedCourseWithCards(host, 'Computer Networks');
    await host.call('course.terms.mark', {
      course: 'Computer Networks',
      terms: ['BCP38'],
    });

    const tty = createVirtualTty(120, 36);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Computer Networks'), { timeoutMs: 10_000, label: 'LibraryView loaded (zh)' });

      tty.send('C');
      await tty.waitFor((s) => s.includes('课程设置与学法') && !s.includes('正在读取课程配置'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal opened (zh)',
      });

      tty.send('3');
      const termsScreen = await tty.waitFor(
        (s) => s.includes('BCP38') && s.includes('☑') && s.includes('共 1'),
        { timeoutMs: 8_000, label: 'Tab 3 terms rendered (zh)' },
      );
      tty.assertHealthyScreen(termsScreen, 120, 36, 'Tab 3 zh');

      // Press [a] to open inline attachCard picker seeded with 'BCP38'
      tty.send('a');
      const pickerScreen = await tty.waitFor(
        (s) => s.includes('为术语「BCP38」关联检查卡') && s.includes('Explain BCP38 primary goal'),
        { timeoutMs: 8_000, label: 'attachCard picker rendered with matching cards (zh)' },
      );
      tty.assertHealthyScreen(pickerScreen, 120, 36, 'attachCard picker zh');

      // Move down with 'j' to pick the second card and press Enter
      const seenToasts = [];
      const unsubToasts = useTuiStore.subscribe((st) => {
        for (const t of st.toasts) {
          if (!seenToasts.some((x) => x.id === t.id)) seenToasts.push(t);
        }
      });
      useTuiStore.setState({ toasts: [] });
      tty.send('j');
      await sleep(60);
      tty.send('\r');

      try {
        const attachedScreen = await tty.waitFor(
          (s) =>
            !s.includes('为术语「BCP38」关联检查卡') &&
            s.includes('✓已建卡') &&
            s.includes('✓已关联检查卡') &&
            seenToasts.some((toast) => toast.tone === 'success' && toast.text === '已为术语「BCP38」关联检查卡'),
          { timeoutMs: 8_000, label: 'linked toast and check-card badge visible in Tab 3 (zh)' },
        );
        tty.assertHealthyScreen(attachedScreen, 120, 36, 'Tab 3 after attach zh');
      } catch (err) {
        throw new Error(`${err.message}\nseenToasts=${JSON.stringify(seenToasts)}`);
      } finally {
        unsubToasts();
      }

      const persisted = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(persisted.ok, true);
      assert.deepEqual(persisted.value?.items?.[0]?.card, { deckId, cardId: cards[1].id });

      // Esc closes CourseSettingsModal cleanly
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('课程设置与学法'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal closed via Esc (zh)',
      });
      assert.equal(modelCalls, 0);
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): C -> Tab 3 -> a -> assertHealthyScreen & assertAsciiPure -> Esc cancels cleanly', async () => {
    const base = await makeTempDir('ui-ascii-en');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'en', asciiMode: true });
    resetDistStore('en', true);

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      complete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call during CourseSettings attachCard ascii test');
      },
    });

    await seedCourseWithCards(host, 'Computer Networks');
    await host.call('course.terms.mark', {
      course: 'Computer Networks',
      terms: ['BCP38'],
    });

    const tty = createVirtualTty(80, 24);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Computer Networks'), { timeoutMs: 10_000, label: 'LibraryView loaded (en)' });

      tty.send('C');
      await tty.waitFor((s) => s.includes('Course Settings') && !s.includes('Loading course settings'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal opened (en)',
      });

      tty.send('3');
      const termsScreen = await tty.waitFor(
        (s) => s.includes('BCP38') && s.includes('[x]') && s.includes('Total 1'),
        { timeoutMs: 8_000, label: 'Tab 3 terms rendered (80x24 ascii en)' },
      );
      tty.assertHealthyScreen(termsScreen, 80, 24, 'Tab 3 80x24 ascii en');
      tty.assertAsciiPure(termsScreen, 'Tab 3 80x24 ascii en pure');

      tty.send('a');
      const pickerScreen = await tty.waitFor(
        (s) => s.includes('Attach check card for "BCP38"') && s.includes('Explain BCP38'),
        { timeoutMs: 8_000, label: 'attachCard picker rendered (80x24 ascii en)' },
      );
      tty.assertHealthyScreen(pickerScreen, 80, 24, 'attachCard picker 80x24 ascii en');
      tty.assertAsciiPure(pickerScreen, 'attachCard picker 80x24 ascii en pure');

      // Esc cancels cleanly back to Tab 3 with 0 mutations
      tty.send('\x1b');
      const cancelledScreen = await tty.waitFor(
        (s) => !s.includes('Attach check card') && s.includes('BCP38') && s.includes('Total 1'),
        { timeoutMs: 8_000, label: 'attachCard cancelled via Esc (80x24 ascii en)' },
      );
      tty.assertHealthyScreen(cancelledScreen, 80, 24, 'Tab 3 after Esc cancel 80x24 ascii en');
      tty.assertAsciiPure(cancelledScreen, 'Tab 3 after Esc cancel 80x24 ascii en pure');

      const afterCancel = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterCancel.ok, true);
      assert.equal(afterCancel.value?.items?.[0]?.card, undefined, 'Esc cancel must not attach any card');
      assert.equal(modelCalls, 0);

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('Course Settings'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal closed via Esc (80x24 ascii en)',
      });
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
