// Round 39 SettingsView (ExamPrep reset, Retrieval status & Usage Frequency) host integration & PTY E2E tests:
// node --test tests/round39-settings-usage.test.mjs
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

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round39-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

describe('Round 39: ExamPrep reset, Semantic Retrieval status & Usage Frequency controls', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: settings.examPrep.reset, retrieval.status & usage.frequency.*', async () => {
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
      // 1a. settings.examPrep.set -> settings.examPrep.reset (must keep enabled switch!)
      const epSetOff = await host.call('settings.examPrep.set', {
        patch: {
          autoRoles: false,
          paperWords: ['mock-exam'],
          language: 'en',
          showOtherCourses: true,
          enabled: false,
        },
      });
      assert.equal(epSetOff.ok, true, epSetOff.error?.message);
      assert.equal(epSetOff.value.autoRoles, false);
      assert.deepEqual(epSetOff.value.paperWords, ['mock-exam']);
      assert.equal(epSetOff.value.language, 'en');
      assert.equal(epSetOff.value.showOtherCourses, true);
      assert.equal(epSetOff.value.enabled, false);

      const epResetOff = await host.call('settings.examPrep.reset', {});
      assert.equal(epResetOff.ok, true, epResetOff.error?.message);
      assert.equal(epResetOff.value.autoRoles, true);
      assert.deepEqual(epResetOff.value.paperWords, []);
      assert.equal(epResetOff.value.language, 'auto');
      assert.equal(epResetOff.value.showOtherCourses, false);
      assert.equal(epResetOff.value.enabled, false);

      const snapEp = await host.call('snapshot');
      assert.equal(snapEp.ok, true);
      assert.equal(snapEp.value.settings?.examPrep?.enabled, false);

      // Re-enable and reset again to verify enabled=true path
      await host.call('settings.examPrep.set', { patch: { enabled: true, paperWords: ['past-paper'] } });
      const epResetOn = await host.call('settings.examPrep.reset', {});
      assert.equal(epResetOn.ok, true, epResetOn.error?.message);
      assert.equal(epResetOn.value.enabled, true);
      assert.deepEqual(epResetOn.value.paperWords, []);

      // 1b. retrieval.status
      const retStatus = await host.call('retrieval.status', {});
      assert.equal(retStatus.ok, true, retStatus.error?.message);
      assert.equal(retStatus.value.effective, 'builtin');
      assert.equal(typeof retStatus.value.companion?.running, 'boolean');
      assert.equal(typeof retStatus.value.hostCanSearch, 'boolean');

      // 1c. usage.frequency.status -> set(true) -> record -> clear -> set(false)
      const u0 = await host.call('usage.frequency.status', {});
      assert.equal(u0.ok, true, u0.error?.message);
      assert.equal(u0.value.enabled, false);
      assert.equal(u0.value.paused, false);
      assert.equal(u0.value.hasData, false);
      assert.equal(u0.value.daysWithData, 0);

      const uOn = await host.call('usage.frequency.set', { enabled: true });
      assert.equal(uOn.ok, true, uOn.error?.message);
      assert.equal(uOn.value.enabled, true);
      assert.equal(uOn.value.paused, false);

      const rec = await host.call('usage.frequency.record', {
        records: [{ key: 'settings.usage.toggle', area: 'settings', day: todayLocalYmd(), n: 2 }],
      });
      assert.equal(rec.ok, true, rec.error?.message);
      assert.equal(rec.value.accepted, 1);

      const uWithData = await host.call('usage.frequency.status', {});
      assert.equal(uWithData.ok, true);
      assert.equal(uWithData.value.hasData, true);
      assert.equal(uWithData.value.daysWithData, 1);

      const uCleared = await host.call('usage.frequency.clear', {});
      assert.equal(uCleared.ok, true, uCleared.error?.message);
      assert.equal(uCleared.value.enabled, true);
      assert.equal(uCleared.value.hasData, false);
      assert.equal(uCleared.value.daysWithData, 0);

      const uOff = await host.call('usage.frequency.set', { enabled: false });
      assert.equal(uOff.ok, true, uOff.error?.message);
      assert.equal(uOff.value.enabled, false);

      const uFinal = await host.call('usage.frequency.status', {});
      assert.equal(uFinal.ok, true);
      assert.equal(uFinal.value.enabled, false);
      assert.equal(uFinal.value.hasData, false);
      assert.equal(uFinal.value.daysWithData, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: WorkspaceTab [u]/[U] & StudyGenTab examprep_reset at 120x36 & 80x24 + --ascii', async () => {
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

    // Seed custom ExamPrep defaults (with enabled=false to prove switch is preserved) & 1 day of usage data
    await host.call('settings.examPrep.set', {
      patch: {
        autoRoles: false,
        paperWords: ['mock-paper'],
        language: 'en',
        showOtherCourses: true,
        enabled: false,
      },
    });
    await host.call('usage.frequency.set', { enabled: true });
    await host.call('usage.frequency.record', {
      records: [{ key: 'settings.usage.seed', area: 'settings', day: todayLocalYmd(), n: 1 }],
    });
    await host.call('usage.frequency.set', { enabled: false });

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

      // Switch to WorkspaceTab ('2')
      tty.send('2');
      const wsWide = await tty.waitFor(
        (s) =>
          s.includes('Retrieval:') &&
          s.includes('Usage Frequency:') &&
          s.includes('Disabled (1d)') &&
          s.includes('[u]') &&
          s.includes('[U]'),
        { label: 'WorkspaceTab rendered retrieval & usage at 120x36' },
      );
      tty.assertHealthyScreen(wsWide, 120, 36, 'WorkspaceTab 120x36');

      // Resize to 80x24 and verify clean rendering
      tty.resize(80, 24);
      const wsNarrow = await tty.waitFor(
        (s) =>
          s.includes('Retrieval:') &&
          s.includes('Usage Frequency:') &&
          s.includes('Disabled (1d)') &&
          s.split('\n').length <= 24,
        { label: 'WorkspaceTab at 80x24' },
      );
      tty.assertHealthyScreen(wsNarrow, 80, 24, 'WorkspaceTab 80x24');

      // Restore 120x36 and toggle Usage Frequency on with 'u'
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('Usage Frequency:'), { label: 'WorkspaceTab restored 120x36' });

      tty.send('u');
      const afterUsageOn = await tty.waitFor(
        (s) => s.includes('Enabled ✓ (1d)') && s.includes('Usage frequency recording enabled'),
        { label: 'Usage Frequency toggled on via [u]' },
      );
      tty.assertHealthyScreen(afterUsageOn, 120, 36, 'WorkspaceTab usage on');
      const usageAfterOn = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterOn.value?.enabled, true);
      assert.equal(usageAfterOn.value?.daysWithData, 1);

      // Press uppercase 'U' -> ConfirmDialog to clear recorded usage frequency data
      tty.send('U');
      const clearDialog = await tty.waitFor(
        (s) => s.includes('Clear Usage Frequency Data') && s.includes('Clear Data'),
        { label: 'Clear Usage Frequency ConfirmDialog opened via [U]' },
      );
      tty.assertHealthyScreen(clearDialog, 120, 36, 'Clear Usage ConfirmDialog');

      // Confirm with 'y' -> data cleared, switch remains enabled
      tty.send('y');
      const afterUsageClear = await tty.waitFor(
        (s) => s.includes('Enabled ✓ (0d)') && s.includes('All usage frequency records cleared'),
        { label: 'Usage Frequency data cleared' },
      );
      tty.assertHealthyScreen(afterUsageClear, 120, 36, 'WorkspaceTab usage cleared');
      const usageAfterClear = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterClear.value?.enabled, true);
      assert.equal(usageAfterClear.value?.hasData, false);
      assert.equal(usageAfterClear.value?.daysWithData, 0);

      // Toggle Usage Frequency back off with 'u'
      tty.send('u');
      const afterUsageOff = await tty.waitFor(
        (s) => s.includes('Disabled (0d)') && s.includes('Usage frequency recording disabled'),
        { label: 'Usage Frequency toggled off via [u]' },
      );
      tty.assertHealthyScreen(afterUsageOff, 120, 36, 'WorkspaceTab usage off');
      const usageAfterOff = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterOff.value?.enabled, false);

      // Switch to StudyGenTab ('3')
      tty.send('3');
      const sgWide = await tty.waitFor(
        (s) =>
          s.includes('Reset Practice Defaults') &&
          s.includes('Reset ExamPrep Defaults'),
        { label: 'StudyGenTab rendered with Reset ExamPrep Defaults at 120x36' },
      );
      tty.assertHealthyScreen(sgWide, 120, 36, 'StudyGenTab 120x36');

      // Resize StudyGenTab to 80x24 and verify clean rendering
      tty.resize(80, 24);
      const sgNarrow = await tty.waitFor(
        (s) => s.includes('Reset ExamPrep') && s.split('\n').length <= 24,
        { label: 'StudyGenTab at 80x24' },
      );
      tty.assertHealthyScreen(sgNarrow, 80, 24, 'StudyGenTab 80x24');
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('Reset ExamPrep Defaults'), { label: 'StudyGenTab restored 120x36' });

      // Move cursor 7 rows down to 'examprep_reset' and press Enter -> ConfirmDialog
      for (let i = 0; i < 7; i += 1) {
        tty.send('j');
        await sleep(25);
      }
      tty.send('\r');
      const epDialog = await tty.waitFor(
        (s) => s.includes('Reset ExamPrep Defaults') && s.includes('page on/off switch'),
        { label: 'Reset ExamPrep Defaults ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(epDialog, 120, 36, 'Reset ExamPrep ConfirmDialog');

      // Confirm with 'y' -> toast + defaults reset + enabled=false kept
      tty.send('y');
      const afterEpReset = await tty.waitFor(
        (s) => s.includes('ExamPrep defaults reset (page switch kept)'),
        { label: 'ExamPrep defaults reset confirmed' },
      );
      tty.assertHealthyScreen(afterEpReset, 120, 36, 'StudyGenTab after examprep reset');
      const snapAfterEpReset = await host.call('snapshot');
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.autoRoles, true);
      assert.deepEqual(snapAfterEpReset.value?.settings?.examPrep?.paperWords, []);
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.language, 'auto');
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.showOtherCourses, false);
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.enabled, false);

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Dedicated --ascii purity passes across 120x36 (en) & 80x24 (zh)
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
            (s) => s.includes(pass.language === 'en' ? 'Usage Frequency:' : '使用频率记录:'),
            { label: `ASCII WorkspaceTab (${pass.cols}x${pass.rows} ${pass.language})` },
          );
          asciiTty.assertHealthyScreen(wsAscii, pass.cols, pass.rows, `ASCII WorkspaceTab ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(wsAscii, `ASCII WorkspaceTab ${pass.cols}x${pass.rows}`);

          // Open [U] ConfirmDialog and verify --ascii purity
          asciiTty.send('U');
          const clearDialogAscii = await asciiTty.waitFor(
            (s) => s.includes(pass.language === 'en' ? 'Clear Usage Frequency Data' : '删除全部使用记录'),
            { label: `ASCII Clear Usage ConfirmDialog (${pass.cols}x${pass.rows} ${pass.language})` },
          );
          asciiTty.assertHealthyScreen(
            clearDialogAscii,
            pass.cols,
            pass.rows,
            `ASCII Clear Usage ConfirmDialog ${pass.cols}x${pass.rows}`,
          );
          asciiTty.assertAsciiPure(
            clearDialogAscii,
            `ASCII Clear Usage ConfirmDialog ${pass.cols}x${pass.rows}`,
          );
          asciiTty.send('\x1b');
          await asciiTty.waitFor(
            (s) => !s.includes(pass.language === 'en' ? 'Clear Usage Frequency Data' : '删除全部使用记录'),
            { label: `ASCII Clear Usage ConfirmDialog dismissed (${pass.language})` },
          );

          // StudyGen tab ('3') + examprep_reset ConfirmDialog
          asciiTty.send('3');
          const sgAscii = await asciiTty.waitFor(
            (s) => s.includes(pass.language === 'en' ? 'Reset ExamPrep Defaults' : '恢复备考补习默认设置'),
            { label: `ASCII StudyGenTab (${pass.cols}x${pass.rows} ${pass.language})` },
          );
          asciiTty.assertHealthyScreen(sgAscii, pass.cols, pass.rows, `ASCII StudyGenTab ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(sgAscii, `ASCII StudyGenTab ${pass.cols}x${pass.rows}`);

          for (let i = 0; i < 7; i += 1) {
            asciiTty.send('j');
            await sleep(25);
          }
          asciiTty.send('\r');
          const epDialogAscii = await asciiTty.waitFor(
            (s) =>
              pass.language === 'en'
                ? s.includes('Reset ExamPrep Defaults') && s.includes('page on/off switch')
                : s.includes('恢复备考补习默认设置') && s.includes('取消 (n)') && s.includes('恢复默认 (y)'),
            { label: `ASCII ExamPrep Reset ConfirmDialog (${pass.cols}x${pass.rows} ${pass.language})` },
          );
          asciiTty.assertHealthyScreen(
            epDialogAscii,
            pass.cols,
            pass.rows,
            `ASCII ExamPrep Reset ConfirmDialog ${pass.cols}x${pass.rows}`,
          );
          asciiTty.assertAsciiPure(
            epDialogAscii,
            `ASCII ExamPrep Reset ConfirmDialog ${pass.cols}x${pass.rows}`,
          );
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
