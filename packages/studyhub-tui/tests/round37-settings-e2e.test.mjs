// Round 37 SettingsView (StudyGenTab & WorkspaceTab) host integration & PTY E2E verification:
// node --test tests/round37-settings-e2e.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round37-${label}-`));
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

describe('Round 37: SettingsView book auto-add, practice reset & experimental features', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: settings.book.set, settings.practice.reset (preserving fixPhrases), experimental.get/set', async () => {
    const base = await makeTempDir('host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      libraryRoot,
      env: { DSH_HOME: dshHome },
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      // 1a. settings.book.set
      const bookAuto = await host.call('settings.book.set', { patch: { qaToBook: 'auto' } });
      assert.equal(bookAuto.ok, true, bookAuto.error?.message);
      assert.equal(bookAuto.value.qaToBook, 'auto');

      const snap1 = await host.call('snapshot');
      assert.equal(snap1.ok, true);
      assert.equal(snap1.value.settings?.book?.qaToBook, 'auto');

      const bookManual = await host.call('settings.book.set', { patch: { qaToBook: 'manual', pageLimit: 120 } });
      assert.equal(bookManual.ok, true, bookManual.error?.message);
      assert.equal(bookManual.value.qaToBook, 'manual');
      assert.equal(bookManual.value.pageLimit, 120);

      const bookCleared = await host.call('settings.book.set', { patch: { pageLimit: null } });
      assert.equal(bookCleared.ok, true, bookCleared.error?.message);
      assert.equal(bookCleared.value.qaToBook, 'manual');
      assert.equal('pageLimit' in bookCleared.value, false);

      // 1b. settings.practice.set -> settings.practice.reset (must keep fixPhrases!)
      const phrase = 'Keep my custom fix phrase';
      const pracSet = await host.call('settings.practice.set', {
        patch: {
          roundSize: 35,
          autopilot: true,
          newCardOrder: 'shuffle',
          debrief: false,
          rereadMarks: false,
          fixPhrases: [phrase],
        },
      });
      assert.equal(pracSet.ok, true, pracSet.error?.message);
      assert.equal(pracSet.value.roundSize, 35);
      assert.equal(pracSet.value.autopilot, true);
      assert.deepEqual(pracSet.value.fixPhrases, [phrase]);

      const pracReset = await host.call('settings.practice.reset', {});
      assert.equal(pracReset.ok, true, pracReset.error?.message);
      assert.equal(pracReset.value.roundSize, 20);
      assert.equal(pracReset.value.autopilot, false);
      assert.equal(pracReset.value.newCardOrder, 'reading');
      assert.equal(pracReset.value.debrief, true);
      assert.equal(pracReset.value.rereadMarks, true);
      assert.deepEqual(pracReset.value.fixPhrases, [phrase]);

      const snap2 = await host.call('snapshot');
      assert.equal(snap2.ok, true);
      assert.deepEqual(snap2.value.settings?.practice?.fixPhrases, [phrase]);
      assert.equal(snap2.value.settings?.practice?.roundSize, 20);

      // 1c. experimental.get -> experimental.set(true) -> experimental.get -> experimental.set(false)
      const exp0 = await host.call('experimental.get', {});
      assert.equal(exp0.ok, true, exp0.error?.message);
      assert.equal(exp0.value.enabled, false);

      const expSetOn = await host.call('experimental.set', { enabled: true });
      assert.equal(expSetOn.ok, true, expSetOn.error?.message);
      assert.equal(expSetOn.value.enabled, true);
      assert.equal(existsSync(join(dshHome, 'study', 'experimental.json')), true);

      const exp1 = await host.call('experimental.get', {});
      assert.equal(exp1.ok, true, exp1.error?.message);
      assert.equal(exp1.value.enabled, true);

      const snapOn = await host.call('snapshot');
      assert.equal(snapOn.ok, true);
      assert.equal(snapOn.value.experimental, true);

      const expSetOff = await host.call('experimental.set', { enabled: false });
      assert.equal(expSetOff.ok, true, expSetOff.error?.message);
      assert.equal(expSetOff.value.enabled, false);

      const exp2 = await host.call('experimental.get', {});
      assert.equal(exp2.ok, true, exp2.error?.message);
      assert.equal(exp2.value.enabled, false);

      const snapOff = await host.call('snapshot');
      assert.equal(snapOff.ok, true);
      assert.equal(snapOff.value.experimental, false);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SettingsView StudyGen (3) & Workspace (2) controls, interactions & 120x36 / 80x24 + --ascii purity', async () => {
    const base = await makeTempDir('pty');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    process.env.DSH_HOME = dshHome;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await saveTuiPreferences({ language: 'en', asciiMode: false }, { env });
    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    // Seed custom practice defaults + fixPhrases so reset can be verified end-to-end
    const savedPhrase = 'Explain step by step';
    await host.call('sample.load', { language: 'en' });
    await host.call('settings.practice.set', {
      patch: { roundSize: 35, autopilot: true, fixPhrases: [savedPhrase] },
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'settings',
          initialLanguage: 'en',
          initialAsciiMode: false,
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
      await tty.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
        label: 'SettingsView loaded on Models tab',
      });

      // Switch to Workspace tab ('2')
      tty.send('2');
      const wsWide = await tty.waitFor(
        (s) =>
          s.includes('Library Root & Workspace') &&
          s.includes('Experimental Features:') &&
          s.includes('Disabled') &&
          s.includes('[f]'),
        { label: 'WorkspaceTab rendered at 120x36' },
      );
      tty.assertHealthyScreen(wsWide, 120, 36, 'WorkspaceTab 120x36');

      // Resize to 80x24 and verify clean rendering
      tty.resize(80, 24);
      const wsNarrow = await tty.waitFor(
        (s) =>
          s.includes('Experimental Features:') &&
          s.includes('Disabled') &&
          s.split('\n').length <= 24,
        { label: 'WorkspaceTab at 80x24' },
      );
      tty.assertHealthyScreen(wsNarrow, 80, 24, 'WorkspaceTab 80x24');

      // Restore 120x36 and toggle Experimental Features via 'f'
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('Experimental Features:'), { label: 'WorkspaceTab restored 120x36' });

      tty.send('f');
      const afterExpOn = await tty.waitFor(
        (s) => s.includes('Enabled') && s.includes('Experimental features enabled'),
        { label: 'Experimental Features toggled on' },
      );
      tty.assertHealthyScreen(afterExpOn, 120, 36, 'WorkspaceTab experimental on');
      const expAfterOn = await host.call('experimental.get', {});
      assert.equal(expAfterOn.value?.enabled, true);

      // Toggle Experimental Features back off via 'f'
      tty.send('f');
      const afterExpOff = await tty.waitFor(
        (s) => s.includes('Disabled') && s.includes('Experimental features disabled'),
        { label: 'Experimental Features toggled off' },
      );
      tty.assertHealthyScreen(afterExpOff, 120, 36, 'WorkspaceTab experimental off');
      const expAfterOff = await host.call('experimental.get', {});
      assert.equal(expAfterOff.value?.enabled, false);

      // Switch to StudyGen tab ('3')
      tty.send('3');
      const sgWide = await tty.waitFor(
        (s) =>
          s.includes('Review, Generation & Daily Recap Settings') &&
          s.includes('Auto-add Q&A to Book') &&
          s.includes('Reset Practice Defaults'),
        { label: 'StudyGenTab rendered at 120x36' },
      );
      tty.assertHealthyScreen(sgWide, 120, 36, 'StudyGenTab 120x36');

      // Resize StudyGenTab to 80x24 and verify clean rendering
      tty.resize(80, 24);
      const sgNarrow = await tty.waitFor(
        (s) => s.includes('Auto-add Q&A') && s.includes('Reset Practice') && s.split('\n').length <= 24,
        { label: 'StudyGenTab at 80x24' },
      );
      tty.assertHealthyScreen(sgNarrow, 80, 24, 'StudyGenTab 80x24');
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('Auto-add Q&A to Book'), { label: 'StudyGenTab restored 120x36' });

      // Move cursor to row index 5 ('book_qaToBook') with 5x 'j', then toggle with '\r'
      for (let i = 0; i < 5; i += 1) {
        tty.send('j');
        await sleep(25);
      }
      tty.send('\r');
      await tty.waitFor((s) => s.includes('Auto ✓'), { label: 'book.qaToBook toggled to Auto' });
      const snapBook = await host.call('snapshot');
      assert.equal(snapBook.value?.settings?.book?.qaToBook, 'auto');

      // Move cursor down 1 row to 'practice_reset', press Enter -> ConfirmDialog
      tty.send('j');
      await sleep(25);
      tty.send('\r');
      const resetDialog = await tty.waitFor(
        (s) => s.includes('Reset Practice Defaults') && s.includes('fixPhrases'),
        { label: 'Reset Practice Defaults ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(resetDialog, 120, 36, 'Reset Practice ConfirmDialog');

      // Confirm with 'y' -> toast + roundSize back to 20 + fixPhrases preserved
      tty.send('y');
      const afterReset = await tty.waitFor(
        (s) => s.includes('Practice defaults reset') && s.includes('20 cards'),
        { label: 'Practice defaults reset confirmed' },
      );
      tty.assertHealthyScreen(afterReset, 120, 36, 'StudyGenTab after practice reset');
      const snapAfterReset = await host.call('snapshot');
      assert.equal(snapAfterReset.value?.settings?.practice?.roundSize, 20);
      assert.equal(snapAfterReset.value?.settings?.practice?.autopilot, false);
      assert.deepEqual(snapAfterReset.value?.settings?.practice?.fixPhrases, [savedPhrase]);

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Dedicated --ascii purity passes across 120x36 & 80x24 (en & zh)
      for (const pass of [
        { cols: 120, rows: 36, language: 'en' },
        { cols: 80, rows: 24, language: 'zh' },
      ]) {
        await saveTuiPreferences({ language: pass.language, asciiMode: true }, { env });
        host = await createTuiHost({
          libraryRoot,
          env,
          home: base,
          documentsDir: base,
          skipAutoProbe: true,
          language: pass.language,
        });
        const asciiTty = createVirtualTty(pass.cols, pass.rows);
        try {
          inkInstance = render(
            React.createElement(StudyHubTuiApp, {
              host,
              initialPage: 'settings',
              initialLanguage: pass.language,
              initialAsciiMode: true,
              autoLaunchpad: false,
              onExit: () => inkInstance?.unmount(),
            }),
            {
              stdin: asciiTty.stdin,
              stdout: asciiTty.stdout,
              stderr: asciiTty.stderr,
              interactive: true,
              exitOnCtrlC: false,
              patchConsole: false,
            },
          );
          await asciiTty.firstFramePromise;
          await asciiTty.waitFor(
            (s) => s.includes(pass.language === 'en' ? 'Models' : '模型配置'),
            { label: `ASCII SettingsView (${pass.language})` },
          );

          // Workspace tab ('2')
          asciiTty.send('2');
          const wsAscii = await asciiTty.waitFor(
            (s) => s.includes(pass.language === 'en' ? 'Experimental Features:' : '实验性功能:'),
            { label: `ASCII WorkspaceTab (${pass.cols}x${pass.rows} ${pass.language})` },
          );
          asciiTty.assertHealthyScreen(wsAscii, pass.cols, pass.rows, `ASCII WorkspaceTab ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(wsAscii, `ASCII WorkspaceTab ${pass.cols}x${pass.rows}`);

          // StudyGen tab ('3')
          asciiTty.send('3');
          const sgAscii = await asciiTty.waitFor(
            (s) => s.includes(pass.language === 'en' ? 'Auto-add Q&A' : '追问自动加入全书'),
            { label: `ASCII StudyGenTab (${pass.cols}x${pass.rows} ${pass.language})` },
          );
          asciiTty.assertHealthyScreen(sgAscii, pass.cols, pass.rows, `ASCII StudyGenTab ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(sgAscii, `ASCII StudyGenTab ${pass.cols}x${pass.rows}`);
        } finally {
          inkInstance?.unmount();
          inkInstance = null;
          asciiTty.dispose();
          await host.dispose();
        }
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host?.dispose();
    }
  });
});
