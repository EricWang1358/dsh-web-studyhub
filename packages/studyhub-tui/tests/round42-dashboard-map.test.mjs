// Round 42 Dashboard Knowledge Mastery Map (`map` action + lazy `StudyMapModal`) integration + E2E tests:
// node --test tests/round42-dashboard-map.test.mjs
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
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round42-map-${label}-`));
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

async function seedSampleAndExtraDeck(host, lang = 'zh') {
  const sampleRes = await host.call('sample.load', { language: lang });
  assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message}`);

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Operating Systems Core',
      course: 'Operating Systems',
      cards: [
        {
          kind: 'flashcard',
          prompt: 'What is a page fault in virtual memory?',
          answer: 'A trap triggered when accessing a page not currently mapped in physical RAM.',
          topic: 'Virtual Memory',
        },
        {
          kind: 'flashcard',
          prompt: 'Which scheduling algorithm can cause starvation?',
          answer: 'Shortest Job First (SJF) can starve long jobs when short jobs keep arriving.',
          topic: 'CPU Scheduling',
        },
      ],
    }),
    folder: 'Operating Systems',
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
  assert.equal(deckRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(deckRes.value?.results)}`);
  await host.refreshSnapshot();
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Round 42: Dashboard Knowledge Mastery Map', () => {
  test('1) createTuiHost integration: map {} returns expected today, next, mastery, and decks/topics structure', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot: join(base, 'library'),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      await seedSampleAndExtraDeck(host, 'en');

      const mapRes = await host.call('map', {});
      assert.equal(mapRes.ok, true, `map {} failed: ${mapRes.error?.message}`);
      const m = mapRes.value;
      assert.ok(m && typeof m === 'object', 'map result must be an object');
      assert.ok(m.today && typeof m.today === 'object', 'map.today must exist');
      assert.ok(m.mastery && typeof m.mastery === 'object', 'map.mastery must exist');
      assert.ok(m.mastery.library && typeof m.mastery.library.value === 'number', 'map.mastery.library.value must be numeric');
      assert.ok(m.mastery.library.cards > 0, 'map.mastery.library.cards must be > 0');
      assert.ok(Array.isArray(m.decks) && m.decks.length >= 2, 'map.decks must include sample + seeded decks');

      const osDeck = m.decks.find((d) => d.title === 'Operating Systems Core');
      assert.ok(osDeck, 'Operating Systems Core deck should appear in map.decks');
      assert.equal(osDeck.total, 2);
      assert.equal(typeof osDeck.mastery, 'number');
      assert.equal(typeof osDeck.due, 'number');
      assert.ok(osDeck.counts && typeof osDeck.counts.new === 'number');
      assert.ok(Array.isArray(osDeck.topics) && osDeck.topics.length === 2, 'osDeck.topics must have 2 topics');
      assert.deepEqual(
        osDeck.topics.map((tp) => tp.name),
        ['Virtual Memory', 'CPU Scheduling'],
      );
      for (const tp of osDeck.topics) {
        assert.equal(tp.total, 1);
        assert.equal(typeof tp.mastery, 'number');
        assert.equal(typeof tp.due, 'number');
        assert.ok(['todo', 'active', 'done'].includes(tp.status));
      }
      assert.ok(m.next && typeof m.next.topic === 'string', 'map.next should recommend next topic');
    } finally {
      await host.dispose();
    }
  });

  test('2) E2E UI (default zh, 120x36): DashboardView [m] opens StudyMapModal, filters with [/], closes on Esc, and Enter launches practice', async () => {
    const base = await makeTempDir('ui-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false });
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot: join(base, 'library'),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    await seedSampleAndExtraDeck(host, 'zh');

    const tty = createVirtualTty(120, 36);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Memento'), { timeoutMs: 10_000, label: 'Initial view loaded' });

      // Navigate to DashboardView ('6')
      tty.send('6');
      const dashScreen = await tty.waitFor(
        (s) => s.includes('学习统计与掌握度') && s.includes('知识地图'),
        { timeoutMs: 8_000, label: 'DashboardView rendered with [m] Map hint' },
      );
      tty.assertHealthyScreen(dashScreen, 120, 36, 'DashboardView zh 120x36');

      // Open lazy StudyMapModal ('m')
      tty.send('m');
      const mapScreen = await tty.waitFor(
        (s) => s.includes('知识掌握地图') && s.includes('Operating Systems Core') && s.includes('Virtual Memory'),
        { timeoutMs: 8_000, label: 'StudyMapModal opened and loaded (zh)' },
      );
      tty.assertHealthyScreen(mapScreen, 120, 36, 'StudyMapModal zh 120x36');

      // Navigate down & filter with '/'
      tty.send('j');
      await tty.flush();
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter input opened' });
      tty.send('CPU Scheduling');
      await tty.waitFor((s) => s.includes('CPU Scheduling') && !s.includes('Virtual Memory'), {
        timeoutMs: 5_000,
        label: 'Filter narrowed rows to CPU Scheduling',
      });
      // Apply filter via Enter and verify Esc closes StudyMapModal cleanly
      tty.send('\r');
      await tty.flush();
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('知识掌握地图') && s.includes('学习统计与掌握度'),
        { timeoutMs: 8_000, label: 'StudyMapModal closed on Esc (zh)' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, 'DashboardView after Esc zh 120x36');

      // Re-open StudyMapModal, filter to Virtual Memory, and press Enter to start practice in ReviewView
      tty.send('m');
      await tty.waitFor((s) => s.includes('知识掌握地图') && s.includes('Virtual Memory'), {
        timeoutMs: 8_000,
        label: 'StudyMapModal reopened',
      });
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter input reopened' });
      tty.send('Virtual Memory');
      await tty.waitFor((s) => s.includes('Virtual Memory') && !s.includes('CPU Scheduling'), {
        timeoutMs: 5_000,
        label: 'Filtered to Virtual Memory',
      });
      tty.send('\r'); // Exit filter focus
      await tty.waitFor((s) => s.includes('Enter 练习') && !s.includes('应用筛选'), {
        timeoutMs: 5_000,
        label: 'Returned to list focus after filter Enter',
      });
      // Move selection to Virtual Memory topic row (row 0=Course, 1=Deck, 2=Topic) and launch practice
      tty.send('j');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send('\r');
      const reviewScreen = await tty.waitFor(
        (s) => s.includes('page fault') || s.includes('Virtual Memory'),
        { timeoutMs: 8_000, label: 'Practice launched into ReviewView from StudyMapModal' },
      );
      tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from StudyMapModal zh');
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) E2E UI (--ascii en, 80x24): DashboardView [m] -> StudyMapModal navigate, filter, Esc close with 100% ASCII purity', async () => {
    const base = await makeTempDir('ui-ascii-en');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;

    await saveTuiPreferences({ language: 'en', asciiMode: true });
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot: join(base, 'library'),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    await seedSampleAndExtraDeck(host, 'en');

    const tty = createVirtualTty(80, 24);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Sample'), { timeoutMs: 10_000, label: 'Initial view loaded (en)' });

      // Navigate to DashboardView ('6')
      tty.send('6');
      const dashScreen = await tty.waitFor(
        (s) => s.includes('Study Analytics') && s.includes('Map'),
        { timeoutMs: 8_000, label: 'DashboardView rendered at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(dashScreen, 80, 24, 'DashboardView en ascii 80x24');
      tty.assertAsciiPure(dashScreen, 'DashboardView en ascii 80x24 pure');

      // Open StudyMapModal ('m')
      tty.send('m');
      const mapScreen = await tty.waitFor(
        (s) => s.includes('Knowledge Mastery Map') && s.includes('Operating Systems Core'),
        { timeoutMs: 8_000, label: 'StudyMapModal opened at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(mapScreen, 80, 24, 'StudyMapModal en ascii 80x24');
      tty.assertAsciiPure(mapScreen, 'StudyMapModal en ascii 80x24 pure');

      // Navigate down & filter with '/'
      tty.send('j');
      await tty.flush();
      tty.send('/');
      await tty.waitFor((s) => s.includes('Filter:'), { timeoutMs: 5_000, label: 'Filter bar visible (en)' });
      tty.send('Virtual');
      const filteredScreen = await tty.waitFor(
        (s) => s.includes('Virtual Memory') && !s.includes('CPU Scheduling'),
        { timeoutMs: 5_000, label: 'Filtered rows at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(filteredScreen, 80, 24, 'StudyMapModal filtered en ascii 80x24');
      tty.assertAsciiPure(filteredScreen, 'StudyMapModal filtered en ascii 80x24 pure');

      // Esc from filter clears & returns to list focus, second Esc closes modal
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('CPU Scheduling'), {
        timeoutMs: 5_000,
        label: 'Filter cleared on Esc',
      });
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('Knowledge Mastery Map') && s.includes('Study Analytics'),
        { timeoutMs: 8_000, label: 'StudyMapModal closed on Esc (en ascii 80x24)' },
      );
      tty.assertHealthyScreen(closedScreen, 80, 24, 'DashboardView after Esc en ascii 80x24');
      tty.assertAsciiPure(closedScreen, 'DashboardView after Esc en ascii 80x24 pure');
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
