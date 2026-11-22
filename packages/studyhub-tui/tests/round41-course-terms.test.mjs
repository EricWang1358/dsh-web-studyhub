// Round 41 Course Glossary Terms Marking (`course.terms.mark` / `unmark` / `clear`) integration + E2E tests:
// node --test tests/round41-course-terms.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round41-terms-${label}-`));
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

async function seedCourseWithDeck(host, courseName = 'Computer Networks') {
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
          prompt: 'Explain BCP38 and Ingress Filtering at edge routers.',
          answer: 'Prevents source IP spoofing.',
          topic: 'Ingress Filtering',
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
  const cardId = deckGet.value?.cards?.[0]?.id;
  assert.ok(cardId, 'seeded card should have id');
  return { course: cRes.value, deckId: deck.id, cardId };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Round 41: Course Glossary Term Mastery Marking', () => {
  test('1) createTuiHost integration: course.terms.mark -> course.terms.unmark -> course.terms.clear with disk persistence', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const home = join(base, 'home');
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      env,
      home,
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const { deckId, cardId } = await seedCourseWithDeck(host, 'Computer Networks');

      // Initial terms list is empty
      const initTerms = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(initTerms.ok, true);
      assert.deepEqual(initTerms.value?.items, []);

      // Mark terms with case-insensitive deduplication
      const markRes = await host.call('course.terms.mark', {
        course: 'Computer Networks',
        terms: ['BCP38', 'bcp38', 'Ingress Filtering'],
        from: { deckId, cardId },
      });
      assert.equal(markRes.ok, true, `course.terms.mark failed: ${markRes.error?.message}`);
      assert.equal(markRes.value?.added, 2);
      assert.equal(markRes.value?.items?.length, 2);

      // Re-marking an existing term is a no-op
      const dupMark = await host.call('course.terms.mark', {
        course: 'Computer Networks',
        terms: ['BCP38'],
      });
      assert.equal(dupMark.ok, true);
      assert.equal(dupMark.value?.added, 0);

      const gotAfterMark = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(gotAfterMark.ok, true);
      assert.equal(gotAfterMark.value?.items?.length, 2);
      assert.equal(gotAfterMark.value.items[0].state, 'unknown');
      assert.ok(gotAfterMark.value.items[0].fromPrompt?.includes('BCP38'));
    } finally {
      await host.dispose();
    }

    // Reopen host to verify disk persistence across restarts
    const host2 = await createTuiHost({
      env,
      home,
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const persisted = await host2.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(persisted.ok, true);
      assert.deepEqual(
        persisted.value?.items?.map((i) => i.term),
        ['BCP38', 'Ingress Filtering'],
      );

      // Unmark one term case-insensitively
      const unmarkRes = await host2.call('course.terms.unmark', {
        course: 'Computer Networks',
        terms: ['bcp38'],
      });
      assert.equal(unmarkRes.ok, true, `course.terms.unmark failed: ${unmarkRes.error?.message}`);
      assert.equal(unmarkRes.value?.removed, 1);
      assert.equal(unmarkRes.value?.items?.length, 1);

      const afterUnmark = await host2.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterUnmark.ok, true);
      assert.deepEqual(
        afterUnmark.value?.items?.map((i) => i.term),
        ['Ingress Filtering'],
      );

      // Clear remaining terms
      const clearRes = await host2.call('course.terms.clear', { course: 'Computer Networks' });
      assert.equal(clearRes.ok, true, `course.terms.clear failed: ${clearRes.error?.message}`);
      assert.equal(clearRes.value?.cleared, true);
      assert.deepEqual(clearRes.value?.items, []);

      const afterClear = await host2.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterClear.ok, true);
      assert.deepEqual(afterClear.value?.items, []);
    } finally {
      await host2.dispose();
    }
  });

  test('2) E2E UI (default zh): CourseSettingsModal Terms tab [Space] toggle & [C] clear ConfirmDialog cancel/confirm', async () => {
    const base = await makeTempDir('ui-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false });
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    const { deckId, cardId } = await seedCourseWithDeck(host, 'Computer Networks');
    await host.call('course.terms.mark', {
      course: 'Computer Networks',
      terms: ['BCP38', 'Ingress Filtering'],
      from: { deckId, cardId },
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
      await tty.waitFor((s) => s.includes('Computer Networks'), { timeoutMs: 10_000, label: 'LibraryView loaded' });

      // Open CourseSettingsModal ('C') and switch to Terms tab ('3')
      tty.send('C');
      await tty.waitFor((s) => s.includes('课程设置与学法') && !s.includes('正在读取课程配置'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal opened',
      });
      tty.send('3');
      const termsScreen = await tty.waitFor(
        (s) => s.includes('BCP38') && s.includes('Ingress Filtering') && s.includes('☑') && s.includes('共 2'),
        { timeoutMs: 8_000, label: 'Terms tab rendered with marked badges' },
      );
      tty.assertHealthyScreen(termsScreen, 120, 36, 'Terms tab zh');

      // Toggle highlighted term (BCP38) off via Space -> course.terms.unmark
      tty.send(' ');
      const unmarkedScreen = await tty.waitFor(
        (s) => s.includes('☐') && s.includes('已移出') && s.includes('共 1'),
        { timeoutMs: 8_000, label: 'Term unmarked via Space' },
      );
      tty.assertHealthyScreen(unmarkedScreen, 120, 36, 'Terms tab after unmark zh');
      const midTerms = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.deepEqual(
        midTerms.value?.items?.map((i) => i.term),
        ['Ingress Filtering'],
      );

      // Toggle highlighted term (BCP38) back on via Space -> course.terms.mark
      tty.send(' ');
      const remarkedScreen = await tty.waitFor(
        (s) => !s.includes('☐') && s.includes('☑') && s.includes('共 2'),
        { timeoutMs: 8_000, label: 'Term re-marked via Space' },
      );
      tty.assertHealthyScreen(remarkedScreen, 120, 36, 'Terms tab after re-mark zh');
      const restoredTerms = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(restoredTerms.value?.items?.length, 2);

      // Open [C] clear ConfirmDialog and cancel with 'n'
      tty.send('C');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认清空课程术语') && s.includes('Computer Networks'),
        { timeoutMs: 8_000, label: 'Clear terms ConfirmDialog opened (zh)' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'Clear terms ConfirmDialog zh');

      tty.send('n');
      const afterCancelScreen = await tty.waitFor(
        (s) => !s.includes('确认清空课程术语') && s.includes('BCP38') && s.includes('共 2'),
        { timeoutMs: 8_000, label: 'Clear terms cancelled (zh)' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'Terms tab after cancel clear zh');
      const afterCancel = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterCancel.value?.items?.length, 2, 'Cancel clear must preserve terms');

      // Open [C] again and confirm with 'y' -> course.terms.clear
      tty.send('C');
      await tty.waitFor((s) => s.includes('确认清空课程术语'), {
        timeoutMs: 8_000,
        label: 'Clear terms ConfirmDialog reopened (zh)',
      });
      tty.send('y');
      const afterConfirmClear = await tty.waitFor(
        (s) => !s.includes('确认清空课程术语') && s.includes('该课程暂无提取术语') && s.includes('共 0'),
        { timeoutMs: 8_000, label: 'Terms cleared after confirm (zh)' },
      );
      tty.assertHealthyScreen(afterConfirmClear, 120, 36, 'Terms tab after confirmed clear zh');
      const afterClear = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.deepEqual(afterClear.value?.items, []);
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) E2E UI (--ascii en): CourseSettingsModal Terms tab [Space] toggle & [C] clear ConfirmDialog cancel', async () => {
    const base = await makeTempDir('ui-ascii-en');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'en', asciiMode: true });
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    const { deckId, cardId } = await seedCourseWithDeck(host, 'Computer Networks');
    await host.call('course.terms.mark', {
      course: 'Computer Networks',
      terms: ['BCP38', 'Ingress Filtering'],
      from: { deckId, cardId },
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
      await tty.waitFor((s) => s.includes('Computer Networks'), { timeoutMs: 10_000, label: 'LibraryView loaded (en)' });

      tty.send('C');
      await tty.waitFor((s) => s.includes('Course Settings') && !s.includes('Loading course settings'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal opened (en)',
      });
      tty.send('3');
      const termsScreen = await tty.waitFor(
        (s) => s.includes('BCP38') && s.includes('[x]') && s.includes('[Unknown]') && s.includes('Total 2'),
        { timeoutMs: 8_000, label: 'Terms tab rendered (en ascii)' },
      );
      tty.assertHealthyScreen(termsScreen, 120, 36, 'Terms tab en ascii');
      tty.assertAsciiPure(termsScreen, 'Terms tab en ascii pure');

      // Toggle off via Space
      tty.send(' ');
      const unmarkedScreen = await tty.waitFor(
        (s) =>
          s.includes('[ ]') &&
          s.includes('[Unmarked]') &&
          s.includes('Total 1') &&
          !s.includes('Saving'),
        { timeoutMs: 8_000, label: 'Term unmarked via Space (en ascii)' },
      );
      tty.assertHealthyScreen(unmarkedScreen, 120, 36, 'Terms tab after unmark en ascii');
      tty.assertAsciiPure(unmarkedScreen, 'Terms tab after unmark en ascii pure');
      await sleep(150);
      await tty.flush();

      // Toggle back on via Space
      tty.send(' ');
      const remarkedScreen = await tty.waitFor(
        (s) =>
          !s.includes('[Unmarked]') &&
          s.includes('[x] [Unknown] BCP38') &&
          s.includes('Total 2') &&
          !s.includes('Saving'),
        { timeoutMs: 8_000, label: 'Term re-marked via Space (en ascii)' },
      );
      tty.assertHealthyScreen(remarkedScreen, 120, 36, 'Terms tab after re-mark en ascii');
      tty.assertAsciiPure(remarkedScreen, 'Terms tab after re-mark en ascii pure');
      await sleep(150);
      await tty.flush();

      // Open [C] clear ConfirmDialog and cancel via Esc
      tty.send('C');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('Confirm Clear Terms') && s.includes('Computer Networks'),
        { timeoutMs: 8_000, label: 'Clear terms ConfirmDialog opened (en ascii)' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'Clear terms ConfirmDialog en ascii');
      tty.assertAsciiPure(confirmScreen, 'Clear terms ConfirmDialog en ascii pure');

      tty.send('\x1b');
      const cancelledScreen = await tty.waitFor(
        (s) => !s.includes('Confirm Clear Terms') && s.includes('BCP38') && s.includes('Total 2'),
        { timeoutMs: 8_000, label: 'Clear terms cancelled via Esc (en ascii)' },
      );
      tty.assertHealthyScreen(cancelledScreen, 120, 36, 'Terms tab after cancel en ascii');
      tty.assertAsciiPure(cancelledScreen, 'Terms tab after cancel en ascii pure');
      const afterCancel = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterCancel.value?.items?.length, 2);
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
