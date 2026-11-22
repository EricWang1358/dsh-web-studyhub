// Round 47 SourceCoverageModal Tab 2 Linked Cards & Mastery (`materials.pages.cards` + `materials.links.list` + `[p]` practice) tests:
// node --test tests/round47-source-links.test.mjs
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
import { StudyService } from '../../../lib/service.js';

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
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round47-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetTuiStore() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    snapshot: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: { ...DEFAULT_PREFERENCES },
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

  function resize(nextCols, nextRows) {
    stdout.columns = nextCols;
    stdout.rows = nextRows;
    term.resize(nextCols, nextRows);
    stdout.emit('resize');
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
    send,
    resize,
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

const COURSE_NAME = 'Distributed Systems';
const SOURCE_TITLE = 'Raft Consensus Lecture';
const QUOTE_LEADER = 'Leader election uses randomized election timeouts to avoid split votes.';
const QUOTE_COMMIT = 'A log entry is committed once stored on a majority of servers.';

async function seedCitedSourceAndCards(base, libraryRoot, env, lang = 'zh') {
  const mdPath = join(base, 'raft-lecture.md');
  await writeFile(
    mdPath,
    [
      '# Raft Consensus',
      '',
      '## Leader Election',
      QUOTE_LEADER,
      '',
      '## Log Replication',
      QUOTE_COMMIT,
      '',
    ].join('\n'),
    'utf8',
  );

  const host = await createTuiHost({
    env,
    home: base,
    libraryRoot,
    documentsDir: base,
    providerDiscovery: fakeDiscovery(),
    skipAutoProbe: true,
    language: lang,
  });

  let documentId;
  let revision;
  let sourceId;
  let deckId;
  let weakCardId;
  let newCardId;

  try {
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: SOURCE_TITLE,
      format: 'md',
    });
    assert.equal(imp.ok, true, `materials.document.import failed: ${imp.error?.message || ''}`);
    documentId = imp.value.documentId;
    revision = imp.value.revision;
    sourceId = imp.value.sourceIds[0];
    assert.ok(documentId && revision && sourceId, 'Imported document must return documentId, revision, sourceId');

    const courseRes = await host.call('source.courses.set', {
      assignments: [{ id: sourceId, courses: [COURSE_NAME] }],
    });
    assert.equal(courseRes.ok, true, `source.courses.set failed: ${courseRes.error?.message || ''}`);

    const deckRes = await host.call('deck.import', {
      text: JSON.stringify({
        title: 'Raft Consensus Deck',
        course: COURSE_NAME,
        cards: [
          {
            kind: 'flashcard',
            topic: 'Leader Election',
            prompt: 'How does Raft prevent split votes during leader election?',
            answer: 'By using randomized election timeouts.',
            citations: [{ sourceId, quote: QUOTE_LEADER }],
          },
          {
            kind: 'flashcard',
            topic: 'Log Replication',
            prompt: 'When is a Raft log entry considered committed?',
            answer: 'Once stored on a majority of servers.',
            citations: [{ sourceId, quote: QUOTE_COMMIT }],
          },
        ],
      }),
      folder: COURSE_NAME,
    });
    assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message || ''}`);
    assert.equal(deckRes.value?.failed, 0, `deck.import failed entries: ${JSON.stringify(deckRes.value?.results)}`);

    deckId = deckRes.value?.results?.[0]?.deckId;
    assert.ok(deckId, 'deck.import must return deckId');

    const deckGet = await host.call('deck.get', { id: deckId });
    assert.equal(deckGet.ok, true, `deck.get failed: ${deckGet.error?.message || ''}`);
    const cards = deckGet.value?.cards ?? [];
    assert.equal(cards.length, 2, 'Imported deck must contain 2 cited cards');
    const c1 = cards.find((c) => c.prompt.includes('split votes'));
    const c2 = cards.find((c) => c.prompt.includes('considered committed'));
    assert.ok(c1 && c2, 'Both imported cards must be found');
    weakCardId = c1.id;
    newCardId = c2.id;

    const sel1 = await host.call('materials.selection.resolve', {
      documentId,
      revision,
      sourceId,
      quote: QUOTE_LEADER,
    });
    assert.equal(sel1.ok, true, `materials.selection.resolve(1) failed: ${sel1.error?.message || ''}`);
    assert.equal(sel1.value?.status, 'resolved');

    const sel2 = await host.call('materials.selection.resolve', {
      documentId,
      revision,
      sourceId,
      quote: QUOTE_COMMIT,
    });
    assert.equal(sel2.ok, true, `materials.selection.resolve(2) failed: ${sel2.error?.message || ''}`);
    assert.equal(sel2.value?.status, 'resolved');

    // Attach resolved selections for materials.links.list and backdate a failed attempt on c1 so it is weak & due.
    const oldIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const service = new StudyService(libraryRoot);
    try {
      await service.call('snapshot');
      await service.store.update((state) => {
        const deck = state.decks.find((d) => d.id === deckId);
        assert.ok(deck, 'Seeded deck must exist in library state');
        const card1 = deck.cards.find((c) => c.id === weakCardId);
        const card2 = deck.cards.find((c) => c.id === newCardId);
        assert.ok(card1 && card2, 'Seeded cards must exist in deck');
        card1.citations = [{ sourceId, quote: QUOTE_LEADER, selection: sel1.value.selection }];
        card2.citations = [{ sourceId, quote: QUOTE_COMMIT, selection: sel2.value.selection }];
        card1.review = { ...(card1.review || {}), due_at: oldIso };
        state.attempts.push({
          deckId,
          quiz_id: weakCardId,
          grade: 1,
          at: oldIso,
        });
      });
    } finally {
      service.dispose();
    }
  } finally {
    await host.dispose();
  }

  return { documentId, revision, sourceId, deckId, weakCardId, newCardId };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Round 47: SourceCoverageModal Tab 2 Linked Cards & Mastery', () => {
  test('1) createTuiHost integration: cited source + deck cards -> materials.pages.cards and materials.links.list return linked cards & citations', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const { documentId, sourceId, deckId, weakCardId, newCardId } = await seedCitedSourceAndCards(
      base,
      libraryRoot,
      env,
      'en',
    );

    const host = await createTuiHost({
      env,
      home: base,
      libraryRoot,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const pagesRes = await host.call('materials.pages.cards', { documentId, sourceId });
      assert.equal(pagesRes.ok, true, `materials.pages.cards failed: ${pagesRes.error?.message || ''}`);
      assert.equal(pagesRes.value?.status, 'ok');
      assert.equal(pagesRes.value?.summary?.total, 2, 'summary.total must equal 2');
      assert.equal(pagesRes.value?.summary?.weak, 1, 'summary.weak must equal 1');
      assert.equal(pagesRes.value?.summary?.due, 1, 'summary.due must equal 1');
      assert.equal(pagesRes.value?.summary?.fresh, 1, 'summary.fresh must equal 1');

      const cards = pagesRes.value?.cards ?? [];
      assert.equal(cards.length, 2, 'materials.pages.cards must return 2 linked cards');
      const weakEntry = cards.find((c) => c.deckId === deckId && c.cardId === weakCardId);
      const newEntry = cards.find((c) => c.deckId === deckId && c.cardId === newCardId);
      assert.ok(weakEntry && newEntry, 'Both seeded cards must be returned by materials.pages.cards');
      assert.equal(weakEntry.level, 'weak');
      assert.equal(weakEntry.due, true);
      assert.equal(newEntry.level, 'new');
      assert.ok(weakEntry.links?.some((l) => l.sourceId === sourceId), 'weak card link must reference sourceId');

      const linksRes = await host.call('materials.links.list', { documentId });
      assert.equal(linksRes.ok, true, `materials.links.list failed: ${linksRes.error?.message || ''}`);
      const links = linksRes.value?.links ?? [];
      assert.equal(links.length, 2, 'materials.links.list must return 2 resolved passage links');
      const link1 = links.find((l) => l.cardId === weakCardId);
      const link2 = links.find((l) => l.cardId === newCardId);
      assert.ok(link1 && link2, 'Both card links must appear in materials.links.list');
      assert.equal(link1.status, 'resolved');
      assert.equal(link1.selection?.quote, QUOTE_LEADER);
      assert.equal(link2.selection?.quote, QUOTE_COMMIT);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (default zh, 120x36 & 80x24): V opens SourceCoverageModal -> Tab/2 shows Linked Cards & mastery -> Esc closes -> [p] launches ReviewView', async () => {
    const base = await makeTempDir('ui-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await seedCitedSourceAndCards(base, libraryRoot, env, 'zh');
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore();

    const host = await createTuiHost({
      env,
      home: base,
      libraryRoot,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    const tty = createVirtualTty(120, 36);
    let app = null;
    try {
      app = render(React.createElement(StudyHubTuiApp, { host, initialLanguage: 'zh', initialAsciiMode: false }), {
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

      // Switch to SourcesView ('2') and filter to SOURCE_TITLE (deck.import also creates a JSON source)
      tty.send('2');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes(SOURCE_TITLE),
        { label: 'SourcesView rendered with Raft Consensus Lecture' },
      );
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选资料:'), { label: 'SourcesView filter input opened (zh)' });
      tty.send(SOURCE_TITLE);
      await tty.waitFor((s) => !s.includes('JSON 导入'), { label: 'SourcesView filtered to SOURCE_TITLE (zh)' });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('(/ 修改)'), { label: 'SourcesView filter committed (zh)' });

      // Open SourceCoverageModal ('V') -> Tab 1 active by default
      tty.send('V');
      const tab1Screen = await tty.waitFor(
        (s) =>
          s.includes('资料引用与章节覆盖率') &&
          s.includes('1:章节覆盖') &&
          s.includes('2:关联题卡') &&
          !s.includes('正在统计章节与引用覆盖率'),
        { label: 'SourceCoverageModal opened on Tab 1 (zh, 120x36)' },
      );
      tty.assertHealthyScreen(tab1Screen, 120, 36, 'SourceCoverageModal Tab 1 zh 120x36');

      // Switch to Tab 2 via '2'
      tty.send('2');
      const tab2Wide = await tty.waitFor(
        (s) =>
          s.includes('题卡掌握') &&
          s.includes('8%') &&
          s.includes('[薄弱]') &&
          s.includes('[到期]') &&
          s.includes('[新题]') &&
          s.includes('split votes') &&
          s.includes('When is a Raft log entry'),
        { label: 'Tab 2 Linked Cards rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(tab2Wide, 120, 36, 'SourceCoverageModal Tab 2 zh 120x36');

      // Resize to 80x24 and verify clean rendering + Tab toggle + Esc close
      tty.resize(80, 24);
      const tab2Narrow = await tty.waitFor(
        (s) =>
          s.includes('2:关联题卡') &&
          s.includes('题卡掌握') &&
          s.includes('8%') &&
          s.includes('1-2 / Tab') &&
          s.includes('How does Raft prevent') &&
          s.split('\n').length <= 24,
        { label: 'Tab 2 Linked Cards rendered cleanly at 80x24 (zh)' },
      );
      tty.assertHealthyScreen(tab2Narrow, 80, 24, 'SourceCoverageModal Tab 2 zh 80x24');

      // Switch to Tab 1 via Tab, then back to Tab 2 via Tab
      tty.send('\t');
      await tty.waitFor(
        (s) => (s.includes('章节覆盖') || s.includes('直接引用来源')) && !s.includes('题卡掌握'),
        { label: 'Switched back to Tab 1 via Tab' },
      );
      tty.send('\t');
      await tty.waitFor(
        (s) => s.includes('题卡掌握') && s.includes('How does Raft prevent'),
        { label: 'Switched to Tab 2 via Tab' },
      );

      // Esc closes SourceCoverageModal cleanly at 80x24
      tty.send('\x1b');
      const closedNarrow = await tty.waitFor(
        (s) => !s.includes('资料引用与章节覆盖率') && s.includes(SOURCE_TITLE),
        { label: 'SourceCoverageModal closed on Esc at 80x24 (zh)' },
      );
      tty.assertHealthyScreen(closedNarrow, 80, 24, 'SourcesView after Esc zh 80x24');

      // Re-open at 120x36, switch to Tab 2, and press [p] to launch targeted review in ReviewView
      tty.resize(120, 36);
      await tty.flush();
      tty.send('V');
      await tty.waitFor((s) => s.includes('2:关联题卡'), { label: 'SourceCoverageModal reopened (zh)' });
      tty.send('2');
      await tty.waitFor((s) => s.includes('split votes'), { label: 'Tab 2 loaded again (zh)' });
      tty.send('p');
      const reviewScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'review' &&
          Boolean(useTuiStore.getState().activeRunId) &&
          (s.includes('split votes') || s.includes('considered committed')),
        { label: 'Pressing [p] on Tab 2 launches ReviewView with activeRunId' },
      );
      tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from Tab 2 [p] zh 120x36');
    } finally {
      app?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (--ascii en, 120x36 & 80x24): Tab 2 renders Linked Cards & mastery with 100% ASCII purity and closes cleanly on Esc', async () => {
    const base = await makeTempDir('ui-ascii-en');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await seedCitedSourceAndCards(base, libraryRoot, env, 'en');
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetTuiStore();

    const host = await createTuiHost({
      env,
      home: base,
      libraryRoot,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    const tty = createVirtualTty(120, 36);
    let app = null;
    try {
      app = render(React.createElement(StudyHubTuiApp, { host, initialLanguage: 'en', initialAsciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready (en ascii)',
      });

      tty.send('2');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes(SOURCE_TITLE),
        { label: 'SourcesView rendered (en ascii 120x36)' },
      );
      tty.send('/');
      await tty.waitFor((s) => s.includes('Filter: '), { label: 'SourcesView filter input opened (en)' });
      tty.send(SOURCE_TITLE);
      await tty.waitFor((s) => !s.includes('JSON 导入'), { label: 'SourcesView filtered to SOURCE_TITLE (en)' });
      tty.send('\r');
      const sourcesWide = await tty.waitFor(
        (s) => s.includes('(/ edit)') && s.includes(SOURCE_TITLE),
        { label: 'SourcesView filter committed (en ascii 120x36)' },
      );
      tty.assertHealthyScreen(sourcesWide, 120, 36, 'SourcesView en ascii 120x36');
      tty.assertAsciiPure(sourcesWide, 'SourcesView en ascii 120x36 pure');

      // Open SourceCoverageModal ('V') -> Tab 1 -> switch to Tab 2 via Tab key
      tty.send('V');
      const tab1Wide = await tty.waitFor(
        (s) =>
          s.includes('Source Coverage') &&
          s.includes('1:Coverage') &&
          s.includes('2:Linked Cards') &&
          !s.includes('Loading citation'),
        { label: 'SourceCoverageModal Tab 1 rendered (en ascii 120x36)' },
      );
      tty.assertHealthyScreen(tab1Wide, 120, 36, 'SourceCoverageModal Tab 1 en ascii 120x36');
      tty.assertAsciiPure(tab1Wide, 'SourceCoverageModal Tab 1 en ascii 120x36 pure');

      tty.send('\t');
      const tab2Wide = await tty.waitFor(
        (s) =>
          s.includes('Mastery') &&
          s.includes('[weak]') &&
          s.includes('[due]') &&
          s.includes('[new]') &&
          s.includes('split votes'),
        { label: 'SourceCoverageModal Tab 2 rendered (en ascii 120x36)' },
      );
      tty.assertHealthyScreen(tab2Wide, 120, 36, 'SourceCoverageModal Tab 2 en ascii 120x36');
      tty.assertAsciiPure(tab2Wide, 'SourceCoverageModal Tab 2 en ascii 120x36 pure');

      // Resize to 80x24, verify health & ASCII purity, and close with Esc
      tty.resize(80, 24);
      const tab2Narrow = await tty.waitFor(
        (s) =>
          s.includes('Source Coverage') &&
          s.includes('Mastery') &&
          s.includes('8%') &&
          s.includes('1-2 / Tab') &&
          s.includes('How does Raft prevent') &&
          s.split('\n').length <= 24,
        { label: 'SourceCoverageModal Tab 2 rendered at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(tab2Narrow, 80, 24, 'SourceCoverageModal Tab 2 en ascii 80x24');
      tty.assertAsciiPure(tab2Narrow, 'SourceCoverageModal Tab 2 en ascii 80x24 pure');

      tty.send('\x1b');
      const closedNarrow = await tty.waitFor(
        (s) => !s.includes('Source Coverage') && s.includes(SOURCE_TITLE),
        { label: 'SourceCoverageModal closed via Esc at 80x24 (en ascii)' },
      );
      tty.assertHealthyScreen(closedNarrow, 80, 24, 'SourcesView after Esc en ascii 80x24');
      tty.assertAsciiPure(closedNarrow, 'SourcesView after Esc en ascii 80x24 pure');
    } finally {
      app?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
