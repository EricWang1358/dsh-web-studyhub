// Round 38 NotesView Publish Link (`note.link` / `[L]`) & Daily Recap Cancel (`note.daily.cancel` / `[C]`) E2E verification:
// node --test tests/round38-notes-e2e.test.mjs
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
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round38-notes-${label}-`));
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

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
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
    firstFramePromise,
    flush,
    readScreen,
    resize,
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

function resetTuiStore() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: true,
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
  });
}

describe('Round 38: NotesView note.link & note.daily.cancel E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: note.create -> note.link validation & persistence -> note.daily.cancel', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let releaseRecap = null;
    const recapGate = new Promise((resolveFn) => {
      releaseRecap = resolveFn;
    });

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, _prompt, execution = {}) => {
        execution.signal?.throwIfAborted?.();
        await recapGate;
        execution.signal?.throwIfAborted?.();
        return '# Daily Recap\n\nSummary generated.';
      },
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message || ''}`);

      const snapRes = await host.call('library.snapshot', {});
      assert.equal(snapRes.ok, true, 'library.snapshot failed');
      const deckSummary = snapRes.value?.decks?.find((d) => !d.archived && (d.cardCount > 0 || (Array.isArray(d.cards) && d.cards.length > 0))) || snapRes.value?.decks?.[0];
      assert.ok(deckSummary?.id, 'sample library must contain a deck');
      const deckRes = await host.call('deck.get', { id: deckSummary.id });
      assert.equal(deckRes.ok, true, 'deck.get failed');
      const deck = deckRes.value;
      const card = deck?.cards?.[0];
      assert.ok(card?.id, 'sample deck must contain at least one card');

      // Create a draft note
      const createRes = await host.call('note.create', {
        title: 'Round 38 Publish Link Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        language: 'en',
      });
      assert.equal(createRes.ok, true, `note.create failed: ${createRes.error?.message || ''}`);
      const created = createRes.value;
      assert.ok(created?.id, 'note.create must return note id');
      assert.equal(created.status, 'draft');

      // Refusal before CSDN home is configured
      const noHomeLinkRes = await host.call('note.link', {
        id: created.id,
        url: 'https://blog.csdn.net/r38tester/article/details/10001',
        expectedRevision: created.revision,
      });
      assert.equal(noHomeLinkRes.ok, false, 'note.link must fail before CSDN home is configured');

      // Configure CSDN home
      const homeRes = await host.call('note.home', { home: 'https://blog.csdn.net/r38tester' });
      assert.equal(homeRes.ok, true, `note.home failed: ${homeRes.error?.message || ''}`);
      assert.equal(homeRes.value?.home, 'https://blog.csdn.net/r38tester');

      // Invalid URL refusals
      for (const badUrl of [
        'not-a-valid-url',
        'http://example.com/article/123',
        'https://blog.csdn.net/someone_else/article/details/12345',
      ]) {
        const badRes = await host.call('note.link', {
          id: created.id,
          url: badUrl,
          expectedRevision: created.revision,
        });
        assert.equal(badRes.ok, false, `note.link must reject invalid URL: ${badUrl}`);
      }

      // Valid note.link
      const targetUrl = 'https://blog.csdn.net/r38tester/article/details/987654';
      const linkRes = await host.call('note.link', {
        id: created.id,
        url: targetUrl,
        expectedRevision: created.revision,
      });
      assert.equal(linkRes.ok, true, `note.link failed: ${linkRes.error?.message || ''}`);
      assert.equal(linkRes.value?.publicUrl, targetUrl);
      assert.equal(linkRes.value?.status, 'published');

      // Verify note.get & note.list return published URL & status
      const getRes = await host.call('note.get', { id: created.id });
      assert.equal(getRes.ok, true, 'note.get failed');
      assert.equal(getRes.value?.publicUrl, targetUrl);
      assert.equal(getRes.value?.status, 'published');

      const listRes = await host.call('note.list', {});
      assert.equal(listRes.ok, true, 'note.list failed');
      assert.equal(listRes.value?.home, 'https://blog.csdn.net/r38tester');
      const listed = listRes.value?.notes?.find((n) => n.id === created.id);
      assert.ok(listed, 'note.list must include linked note');
      assert.equal(listed.publicUrl, targetUrl);
      assert.equal(listed.status, 'published');

      // Unknown id refusal for note.daily.cancel
      const missingCancelRes = await host.call('note.daily.cancel', { id: 'nonexistent-daily-id' });
      assert.equal(missingCancelRes.ok, false, 'note.daily.cancel must fail for unknown id');

      // Import a 10-card deck and record 10 graded reviews to trigger a real running daily recap, then cancel it
      const recapCourse = 'Round38RecapCourse';
      const importRes = await host.call('deck.import', {
        folder: recapCourse,
        text: JSON.stringify({
          title: recapCourse,
          course: recapCourse,
          cards: Array.from({ length: 10 }, (_, idx) => ({
            id: `r38-card-${idx}`,
            kind: 'quiz',
            topic: `Topic ${idx % 3}`,
            prompt: `Round 38 Question ${idx}`,
            answer: 'Right',
            explanation: 'Explanation',
            options: [
              { id: 'a', text: 'Right', correct: true },
              { id: 'b', text: 'Wrong', correct: false },
            ],
          })),
        }),
      });
      assert.equal(importRes.ok, true, `deck.import failed: ${importRes.error?.message || ''}`);
      const importedDeckId = importRes.value?.results?.[0]?.deckId;
      assert.ok(importedDeckId, 'deck.import must return imported deckId');

      const importedDeckRes = await host.call('deck.get', { id: importedDeckId });
      assert.equal(importedDeckRes.ok, true, 'deck.get for imported deck failed');
      const importedCards = importedDeckRes.value?.cards || [];
      assert.equal(importedCards.length, 10, 'imported deck must have 10 cards');

      const batchRes = await host.call('card.review.batch', {
        items: importedCards.map((c) => ({ deckId: importedDeckId, cardId: c.id, grade: 4 })),
      });
      assert.equal(batchRes.ok, true, `card.review.batch failed: ${batchRes.error?.message || ''}`);

      const genRes = await host.call('note.daily.generate', {
        course: recapCourse,
        timeZone: 'Asia/Shanghai',
      });
      assert.equal(genRes.ok, true, `note.daily.generate failed: ${genRes.error?.message || ''}`);
      assert.equal(genRes.value?.status, 'running');
      assert.ok(genRes.value?.id, 'note.daily.generate must return daily note id');

      const cancelRes = await host.call('note.daily.cancel', { id: genRes.value.id });
      assert.equal(cancelRes.ok, true, `note.daily.cancel failed: ${cancelRes.error?.message || ''}`);
      assert.equal(cancelRes.value?.generation?.status, 'cancelled');

      const cancelledGet = await host.call('note.get', { id: genRes.value.id });
      assert.equal(cancelledGet.ok, true);
      assert.equal(cancelledGet.value?.generation?.status, 'cancelled');
    } finally {
      releaseRecap?.();
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E: NotesView [L] Publish Link modal, preview URL badge, [C] idle toast, default zh & --ascii en @ 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const publishedUrl = 'https://blog.csdn.net/r38pty/article/details/556677';
    try {
      const sampleRes = await host.call('sample.load', { language: 'zh' });
      assert.equal(sampleRes.ok, true, 'sample.load must succeed');
      const snapRes = await host.call('library.snapshot', {});
      const deckSummary = snapRes.value?.decks?.find((d) => !d.archived) || snapRes.value?.decks?.[0];
      assert.ok(deckSummary?.id, 'deck required');
      const deckRes = await host.call('deck.get', { id: deckSummary.id });
      assert.equal(deckRes.ok, true, 'deck.get failed');
      const deck = deckRes.value;
      assert.ok(deck?.cards?.[0]?.id, 'card required');
      await host.call('note.home', { home: 'https://blog.csdn.net/r38pty' });
      const created = await host.call('note.create', {
        title: 'PTY Linked Note',
        cards: [{ deckId: deck.id, cardId: deck.cards[0].id }],
        language: 'zh',
      });
      assert.equal(created.ok, true);
      const linked = await host.call('note.link', {
        id: created.value.id,
        url: publishedUrl,
        expectedRevision: created.value.revision,
      });
      assert.equal(linked.ok, true);

      const passes = [
        { name: 'default zh', language: 'zh', asciiMode: false },
        { name: '--ascii en', language: 'en', asciiMode: true },
      ];

      for (const pass of passes) {
        process.env.DSH_HOME = dshHome;
        await saveTuiPreferences({ language: pass.language, asciiMode: pass.asciiMode }, { env });
        host.setLanguage(pass.language);
        resetTuiStore();

        const tty = createVirtualTty(120, 36);
        let inkInstance = null;
        try {
          inkInstance = render(
            React.createElement(StudyHubTuiApp, {
              host,
              initialPage: 'notes',
              initialLanguage: pass.language,
              initialAsciiMode: pass.asciiMode,
              autoLaunchpad: false,
              onExit: () => inkInstance?.unmount(),
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
          await tty.firstFramePromise;

          const initial = await tty.waitFor(
            (s) =>
              s.includes('PTY Linked Note') &&
              s.includes('blog.csdn.net/r38pty') &&
              (pass.language === 'zh' ? s.includes('外链') : s.includes('Link')),
            { label: `NotesView initial (${pass.name})` },
          );
          tty.assertHealthyScreen(initial, 120, 36, `NotesView 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView 120x36 (${pass.name})`);

          // Press C when no daily recap is running -> friendly info toast
          tty.send('C');
          const afterIdleCancel = await tty.waitFor(
            (s) =>
              pass.language === 'zh'
                ? s.includes('当前没有正在生成的每日总结')
                : s.includes('No daily recap is currently running'),
            { label: `[C] idle toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterIdleCancel, 120, 36, `NotesView after [C] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterIdleCancel, `NotesView after [C] (${pass.name})`);

          // Press L -> open Publish Link modal prefilled with publishedUrl
          tty.send('L');
          const modalOpen = await tty.waitFor(
            (s) =>
              (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')) &&
              s.includes('556677'),
            { label: `[L] modal open 120x36 (${pass.name})` },
          );
          tty.assertHealthyScreen(modalOpen, 120, 36, `Publish Link Modal 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(modalOpen, `Publish Link Modal 120x36 (${pass.name})`);

          // Press Esc -> cancels cleanly
          tty.send('\x1b');
          const modalClosed = await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `[L] modal Esc close (${pass.name})` },
          );
          tty.assertHealthyScreen(modalClosed, 120, 36, `NotesView after Esc 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(modalClosed, `NotesView after Esc 120x36 (${pass.name})`);

          // Resize to 80x24 and test [L] -> Esc again
          tty.resize(80, 24);
          await sleep(80);
          await tty.flush();
          const compactScreen = tty.readScreen();
          tty.assertHealthyScreen(compactScreen, 80, 24, `NotesView 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactScreen, `NotesView 80x24 (${pass.name})`);

          tty.send('L');
          const compactModal = await tty.waitFor(
            (s) => (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')),
            { label: `[L] modal open 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compactModal, 80, 24, `Publish Link Modal 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactModal, `Publish Link Modal 80x24 (${pass.name})`);

          tty.send('\x1b');
          await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `[L] modal Esc close 80x24 (${pass.name})` },
          );
        } finally {
          try {
            inkInstance?.unmount();
          } catch {
            // ignore unmount errors
          }
          tty.dispose();
        }
      }
    } finally {
      await host.dispose();
    }
  });
});
