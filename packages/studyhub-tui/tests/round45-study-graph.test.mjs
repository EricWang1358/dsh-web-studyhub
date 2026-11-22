// Round 45 StudyMapModal Tab 2 Prerequisite & Topic Dependency Graph (`graph` action) tests:
// node --test tests/round45-study-graph.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round45-graph-${label}-`));
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

async function seedSampleAndLinkedCards(host, lang = 'zh') {
  const sampleRes = await host.call('sample.load', { language: lang });
  assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message}`);

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Operating Systems Core',
      course: 'Operating Systems',
      cards: [
        {
          kind: 'flashcard',
          prompt: 'Virtual Memory Paging',
          answer: 'Maps virtual pages to physical frames via page tables.',
          topic: 'Memory',
        },
        {
          kind: 'flashcard',
          prompt: 'TLB Shootdown',
          answer: 'Invalidates stale TLB entries across cores after page table updates.',
          topic: 'Caching',
        },
      ],
    }),
    folder: 'Operating Systems',
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
  assert.equal(deckRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(deckRes.value?.results)}`);

  const deckId = deckRes.value?.results?.[0]?.deckId;
  assert.ok(deckId, 'deck.import must return deckId');
  const getRes = await host.call('deck.get', { id: deckId });
  assert.equal(getRes.ok, true, `deck.get failed: ${getRes.error?.message}`);
  const cards = getRes.value?.cards ?? [];
  assert.equal(cards.length, 2, 'imported deck must have 2 cards');
  const prereqCard = cards.find((c) => c.prompt.includes('Virtual Memory Paging'));
  const depCard = cards.find((c) => c.prompt.includes('TLB Shootdown'));
  assert.ok(prereqCard && depCard, 'both seeded cards must exist');

  const linkRes = await host.call('card.link', {
    deckId,
    cardId: depCard.id,
    requires: { deckId, cardId: prereqCard.id },
  });
  assert.equal(linkRes.ok, true, `card.link failed: ${linkRes.error?.message}`);
  assert.equal(linkRes.value?.linked, true, 'card.link must return linked=true');

  await host.refreshSnapshot();
  return { deckId, prereqCardId: prereqCard.id, depCardId: depCard.id };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Round 45: StudyMapModal Tab 2 Prerequisite & Topic Dependency Graph', () => {
  test('1) createTuiHost integration: sample.load + card.link + graph {} returns nodes & prerequisite edge', async () => {
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
      const { deckId, prereqCardId, depCardId } = await seedSampleAndLinkedCards(host, 'en');

      const graphRes = await host.call('graph', {});
      assert.equal(graphRes.ok, true, `graph {} failed: ${graphRes.error?.message}`);
      const g = graphRes.value;
      assert.ok(g && typeof g === 'object', 'graph result must be an object');
      assert.equal(g.mode, 'structure');
      assert.ok(Array.isArray(g.nodes) && g.nodes.length > 0, 'graph.nodes must be non-empty');
      assert.ok(Array.isArray(g.edges) && g.edges.length > 0, 'graph.edges must be non-empty');

      const expectedPreId = `card:${JSON.stringify([deckId, prereqCardId])}`;
      const expectedDepId = `card:${JSON.stringify([deckId, depCardId])}`;

      const deckNode = g.nodes.find((n) => n.id === `deck:${deckId}` && n.kind === 'deck');
      const preNode = g.nodes.find((n) => n.id === expectedPreId && n.kind === 'card');
      const depNode = g.nodes.find((n) => n.id === expectedDepId && n.kind === 'card');
      assert.ok(deckNode, 'Operating Systems Core deck node must exist in graph.nodes');
      assert.ok(preNode, 'prerequisite card node must exist in graph.nodes');
      assert.ok(depNode, 'dependent card node must exist in graph.nodes');

      const prereqEdge = g.edges.find(
        (e) => e.type === 'prereq' && e.from === expectedDepId && e.to === expectedPreId,
      );
      assert.ok(prereqEdge, 'graph.edges must include prereq edge from dependent card to prerequisite card');
    } finally {
      await host.dispose();
    }
  });

  test('2) E2E UI (default zh, 120x36): DashboardView [m] -> Tab 2 [2] renders Prerequisite Graph, filters, refreshes, launches practice, closes on Esc', async () => {
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
    await seedSampleAndLinkedCards(host, 'zh');

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
      await tty.waitFor(
        (s) => s.includes('学习统计与掌握度') && s.includes('知识地图'),
        { timeoutMs: 8_000, label: 'DashboardView rendered' },
      );

      // Open StudyMapModal ('m') - Tab 1 active by default
      tty.send('m');
      const tab1Screen = await tty.waitFor(
        (s) => s.includes('知识掌握地图') && s.includes('1:知识地图') && s.includes('2:前置依赖图'),
        { timeoutMs: 8_000, label: 'StudyMapModal opened on Tab 1 (zh)' },
      );
      tty.assertHealthyScreen(tab1Screen, 120, 36, 'StudyMapModal Tab 1 zh 120x36');

      // Switch to Tab 2 via '2'
      tty.send('2');
      const tab2Screen = await tty.waitFor(
        (s) =>
          s.includes('条前置边') &&
          s.includes('→') &&
          s.includes('Virtual Memory Paging') &&
          s.includes('TLB Shootdown'),
        { timeoutMs: 8_000, label: 'Tab 2 Prerequisite Graph loaded (zh)' },
      );
      tty.assertHealthyScreen(tab2Screen, 120, 36, 'StudyMapModal Tab 2 zh 120x36');

      // Refresh with 'r' and wait for reload cycle to settle before sending '/'
      tty.send('r');
      await tty.waitFor((s) => s.includes('正在加载依赖图谱'), { timeoutMs: 1_500, label: 'Tab 2 spinner on reload' }).catch(() => {});
      await tty.waitFor(
        (s) => !s.includes('正在加载依赖图谱') && s.includes('条前置边') && s.includes('Virtual Memory Paging'),
        { timeoutMs: 8_000, label: 'Tab 2 reloaded via [r]' },
      );

      // Filter with '/'
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter bar opened on Tab 2' });
      tty.send('TLB Shootdown');
      const filteredTab2 = await tty.waitFor(
        (s) => s.includes('TLB Shootdown') && s.includes('→'),
        { timeoutMs: 5_000, label: 'Tab 2 filtered to TLB Shootdown edge' },
      );
      tty.assertHealthyScreen(filteredTab2, 120, 36, 'StudyMapModal Tab 2 filtered zh 120x36');
      tty.send('\r'); // apply filter
      await tty.waitFor((s) => s.includes('Enter 练习') && !s.includes('应用筛选'), {
        timeoutMs: 5_000,
        label: 'Exited filter focus on Tab 2',
      });

      // Switch back to Tab 1 via Tab, then forward to Tab 2 via Tab
      tty.send('\t');
      await tty.waitFor((s) => s.includes('按课程、题组与考点查看掌握度') || s.includes('全库'), {
        timeoutMs: 5_000,
        label: 'Switched back to Tab 1 via Tab',
      });
      tty.send('\t');
      await tty.waitFor((s) => s.includes('条前置边'), {
        timeoutMs: 5_000,
        label: 'Switched to Tab 2 via Tab',
      });

      // Esc closes StudyMapModal cleanly
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('知识掌握地图') && s.includes('学习统计与掌握度'),
        { timeoutMs: 8_000, label: 'StudyMapModal closed on Esc from Tab 2 (zh)' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, 'DashboardView after Esc zh 120x36');

      // Re-open, switch to Tab 2, filter to TLB Shootdown, and press Enter to launch practice
      tty.send('m');
      await tty.waitFor((s) => s.includes('2:前置依赖图'), { timeoutMs: 8_000, label: 'StudyMapModal reopened' });
      tty.send('2');
      await tty.waitFor((s) => s.includes('Virtual Memory Paging'), { timeoutMs: 8_000, label: 'Tab 2 loaded again' });
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter opened' });
      tty.send('TLB Shootdown');
      await tty.waitFor((s) => s.includes('TLB Shootdown'), { timeoutMs: 5_000, label: 'Filtered to TLB edge' });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('Enter 练习') && !s.includes('应用筛选'), {
        timeoutMs: 5_000,
        label: 'Filter applied',
      });
      tty.send('\r');
      const reviewScreen = await tty.waitFor(
        (s) => s.includes('Virtual Memory Paging') || s.includes('TLB Shootdown'),
        { timeoutMs: 8_000, label: 'ReviewView launched from Tab 2 edge' },
      );
      tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from Tab 2 zh 120x36');
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) E2E UI (--ascii en, 80x24): DashboardView [m] -> Tab 2 via Tab renders Prerequisite Graph with 100% ASCII purity & closes cleanly on Esc', async () => {
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
    await seedSampleAndLinkedCards(host, 'en');

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
      const tab1Screen = await tty.waitFor(
        (s) => s.includes('Knowledge Mastery Map') && s.includes('1:Mastery Map') && s.includes('2:Prerequisite Graph'),
        { timeoutMs: 8_000, label: 'StudyMapModal opened at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(tab1Screen, 80, 24, 'StudyMapModal Tab 1 en ascii 80x24');
      tty.assertAsciiPure(tab1Screen, 'StudyMapModal Tab 1 en ascii 80x24 pure');

      // Switch to Tab 2 via Tab key
      tty.send('\t');
      const tab2Screen = await tty.waitFor(
        (s) => s.includes('prereq edges') && s.includes('->') && s.includes('TLB Shootdown'),
        { timeoutMs: 8_000, label: 'Tab 2 Prerequisite Graph rendered at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(tab2Screen, 80, 24, 'StudyMapModal Tab 2 en ascii 80x24');
      tty.assertAsciiPure(tab2Screen, 'StudyMapModal Tab 2 en ascii 80x24 pure');

      // Filter with '/' on Tab 2
      tty.send('/');
      await tty.waitFor((s) => s.includes('Filter:'), { timeoutMs: 5_000, label: 'Filter bar visible on Tab 2 (en)' });
      tty.send('TLB');
      const filteredTab2 = await tty.waitFor(
        (s) => s.includes('TLB Shootdown') && s.includes('->'),
        { timeoutMs: 5_000, label: 'Filtered Tab 2 at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(filteredTab2, 80, 24, 'StudyMapModal Tab 2 filtered en ascii 80x24');
      tty.assertAsciiPure(filteredTab2, 'StudyMapModal Tab 2 filtered en ascii 80x24 pure');

      // Esc clears filter, second Esc closes modal cleanly
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('1/2 Tab') && !s.includes('Apply'), {
        timeoutMs: 5_000,
        label: 'Filter cleared on Esc (en)',
      });
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('Knowledge Mastery Map') && s.includes('Study Analytics'),
        { timeoutMs: 8_000, label: 'StudyMapModal closed on Esc from Tab 2 (en ascii 80x24)' },
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
