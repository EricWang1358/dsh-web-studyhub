// Round 59 Task 1: StudyGenTab Review Book & ExamPrep Settings Parity (`settings.book.set`, `settings.examPrep.set`)
// + Smooth Viewport Scrolling at 80x24 & 120x36:
// `node --test --test-concurrency=1 tests/round59-study-settings.test.mjs`
import assert from 'node:assert/strict';
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

let H = null;
let displayWidth = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') {
      H = {
        createTuiHost: mod.createTuiHost,
        saveTuiPreferences: mod.saveTuiPreferences,
      };
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') {
      displayWidth = mod.displayWidth;
    }
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round59-study-settings-${label}-`));
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

describe('Round 59: StudyGenTab Book & ExamPrep Settings Parity + Viewport Scrolling', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: settings.book.set & settings.examPrep.set persist via settings {} (0 model calls)', async () => {
    const base = await makeTempDir('host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    const host = await H.createTuiHost({
      libraryRoot,
      env: { DSH_HOME: dshHome },
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const bookRes = await host.call('settings.book.set', {
        patch: { coverage: 'full', inlinePractice: false, confusableDrill: false },
      });
      assert.equal(bookRes.ok, true, bookRes.error?.message);
      assert.equal(bookRes.value.coverage, 'full');
      assert.equal(bookRes.value.inlinePractice, false);
      assert.equal(bookRes.value.confusableDrill, false);

      const epRes = await host.call('settings.examPrep.set', {
        patch: { autoRoles: false, showOtherCourses: true },
      });
      assert.equal(epRes.ok, true, epRes.error?.message);
      assert.equal(epRes.value.autoRoles, false);
      assert.equal(epRes.value.showOtherCourses, true);

      const allSettings = await host.call('settings', {});
      assert.equal(allSettings.ok, true, allSettings.error?.message);
      assert.equal(allSettings.value?.book?.coverage, 'full');
      assert.equal(allSettings.value?.book?.inlinePractice, false);
      assert.equal(allSettings.value?.book?.confusableDrill, false);
      assert.equal(allSettings.value?.examPrep?.autoRoles, false);
      assert.equal(allSettings.value?.examPrep?.showOtherCourses, true);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: StudyGenTab Book & ExamPrep rows at 120x36 zh & 80x24 --ascii en with smooth scrolling', async () => {
    const base = await makeTempDir('pty');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    process.env.DSH_HOME = dshHome;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    // Pass A: 120x36 zh
    await H.saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    let host = await H.createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });
    let tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'settings',
          initialLanguage: 'zh',
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
      await tty.waitFor((s) => s.includes('模型配置'), { label: 'SettingsView zh loaded' });

      tty.send('3');
      const sgZh = await tty.waitFor(
        (s) =>
          s.includes('1/22') &&
          s.includes('全书详略') &&
          s.includes('全书内嵌练习') &&
          s.includes('易混对比专练') &&
          s.includes('备考自动识别岗位') &&
          s.includes('备考显示其他课程'),
        { label: 'StudyGenTab zh 120x36 shows all 22 rows' },
      );
      tty.assertHealthyScreen(sgZh, 120, 36, 'StudyGenTab zh 120x36');

      // Navigate to index 17 (book_coverage) and toggle standard -> full with Space
      for (let i = 0; i < 17; i += 1) {
        tty.send('j');
        await sleep(20);
      }
      await tty.waitFor((s) => s.includes('18/22'), { label: 'cursor at 18/22 (book_coverage)' });
      tty.send(' ');
      await tty.waitFor((s) => s.includes('详尽'), { label: 'book_coverage toggled to full (zh)' });

      // Navigate to index 20 (examprep_autoRoles) and toggle true -> false with 'l'
      for (let i = 0; i < 3; i += 1) {
        tty.send('j');
        await sleep(20);
      }
      await tty.waitFor((s) => s.includes('21/22'), { label: 'cursor at 21/22 (examprep_autoRoles)' });
      tty.send('l');
      await tty.waitFor(
        (s) => s.split('\n').some((line) => line.includes('备考自动识别岗位') && line.includes('关闭')),
        { label: 'examprep_autoRoles toggled off via l' },
      );

      const zhPersisted = await host.call('settings', {});
      assert.equal(zhPersisted.ok, true);
      assert.equal(zhPersisted.value?.book?.coverage, 'full');
      assert.equal(zhPersisted.value?.examPrep?.autoRoles, false);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }

    // Pass B: 80x24 --ascii en (isolated fresh library dir)
    const libraryEn = join(base, 'library-en');
    await mkdir(libraryEn, { recursive: true });
    await H.saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    host = await H.createTuiHost({
      libraryRoot: libraryEn,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });
    tty = createVirtualTty(80, 24);
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'settings',
          initialLanguage: 'en',
          initialAsciiMode: true,
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
      await tty.waitFor((s) => s.includes('Models'), { label: 'SettingsView ascii en loaded' });

      tty.send('3');
      const sgTop = await tty.waitFor(
        (s) => s.includes('1/22') && s.includes('Round Size'),
        { label: 'StudyGenTab 80x24 ascii en top viewport' },
      );
      tty.assertHealthyScreen(sgTop, 80, 24, 'StudyGenTab 80x24 top');
      tty.assertAsciiPure(sgTop, 'StudyGenTab 80x24 top');
      assert.equal(sgTop.includes('ExamPrep other courses'), false, 'Bottom rows should be below initial 80x24 viewport');

      // PageDown moves smoothly toward bottom; then navigate to index 17 (book_coverage)
      tty.send('\x1b[6~');
      await sleep(30);
      for (let i = 0; i < 3; i += 1) {
        tty.send('j');
        await sleep(20);
      }
      const sgCov = await tty.waitFor(
        (s) => s.includes('18/22') && s.includes('Book coverage'),
        { label: 'StudyGenTab 80x24 scrolled to 18/22 (Book coverage)' },
      );
      tty.assertHealthyScreen(sgCov, 80, 24, 'StudyGenTab 80x24 at 18/22');
      tty.assertAsciiPure(sgCov, 'StudyGenTab 80x24 at 18/22');

      // Toggle book_coverage standard -> full with Space
      tty.send(' ');
      const sgCovFull = await tty.waitFor(
        (s) => s.includes('Book coverage') && s.includes('< full >'),
        { label: 'book_coverage cycled to full at 80x24' },
      );
      tty.assertHealthyScreen(sgCovFull, 80, 24, 'StudyGenTab 80x24 book_coverage full');
      tty.assertAsciiPure(sgCovFull, 'StudyGenTab 80x24 book_coverage full');

      // Move down to index 20 (ExamPrep auto roles) and toggle with Enter
      for (let i = 0; i < 3; i += 1) {
        tty.send('j');
        await sleep(20);
      }
      const sgEp = await tty.waitFor(
        (s) => s.includes('21/22') && s.includes('ExamPrep auto roles') && s.includes('ExamPrep other'),
        { label: 'StudyGenTab 80x24 scrolled to 21/22 (ExamPrep auto roles)' },
      );
      tty.assertHealthyScreen(sgEp, 80, 24, 'StudyGenTab 80x24 at 21/22');
      tty.assertAsciiPure(sgEp, 'StudyGenTab 80x24 at 21/22');

      tty.send('\r');
      const sgEpOff = await tty.waitFor(
        (s) => s.includes('21/22') && s.includes('< Off >'),
        { label: 'examprep_autoRoles toggled Off at 80x24' },
      );
      tty.assertHealthyScreen(sgEpOff, 80, 24, 'StudyGenTab 80x24 examprep_autoRoles off');
      tty.assertAsciiPure(sgEpOff, 'StudyGenTab 80x24 examprep_autoRoles off');

      // Move down to index 21 (22/22) and toggle ExamPrep other courses with 'l'
      tty.send('j');
      await tty.waitFor((s) => s.includes('22/22'), { label: 'cursor reached 22/22 at 80x24' });
      tty.send('l');
      await tty.waitFor(
        (s) => s.split('\n').some((line) => line.includes('ExamPrep other') && line.includes('< On + >')),
        { label: 'examprep_showOtherCourses toggled On at 80x24' },
      );

      // PageUp smoothly scrolls back toward top
      tty.send('\x1b[5~');
      const sgScrolledUp = await tty.waitFor(
        (s) => !s.includes('22/22') && s.includes('8/22'),
        { label: 'PageUp scrolled cleanly up from 22/22' },
      );
      tty.assertHealthyScreen(sgScrolledUp, 80, 24, 'StudyGenTab 80x24 after PageUp');
      tty.assertAsciiPure(sgScrolledUp, 'StudyGenTab 80x24 after PageUp');

      const enPersisted = await host.call('settings', {});
      assert.equal(enPersisted.ok, true);
      assert.equal(enPersisted.value?.book?.coverage, 'full');
      assert.equal(enPersisted.value?.examPrep?.autoRoles, false);
      assert.equal(enPersisted.value?.examPrep?.showOtherCourses, true);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });
});
