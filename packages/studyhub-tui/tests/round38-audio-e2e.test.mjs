// Round 38 AudioView Diagnostics, Preflight, Usage, Retry & Subtitle Import E2E verification:
// node --test tests/round38-audio-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round38-${label}-`));
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

describe('Round 38: AudioView preflight, usage, retry & subtitle import E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: audio.preflight, audio.usage, audio.retry refusal & audio.subtitles.import refusal', async () => {
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
      // 1a. audio.preflight
      const pre = await host.call('audio.preflight', {});
      assert.equal(pre.ok, true, pre.error?.message);
      assert.equal(typeof pre.value?.providers, 'object');
      assert.equal(typeof pre.value?.transcription, 'boolean');
      assert.equal(typeof pre.value?.text, 'boolean');
      assert.equal(typeof pre.value?.liveLocal?.ready, 'boolean');
      assert.equal(typeof pre.value?.liveLoopback?.ready, 'boolean');

      // 1b. audio.usage
      const usage = await host.call('audio.usage', {});
      assert.equal(usage.ok, true, usage.error?.message);
      assert.equal(typeof usage.value?.updatedAt, 'number');
      assert.ok(Array.isArray(usage.value?.providers), 'audio.usage must return providers array');
      assert.ok(Array.isArray(usage.value?.trend), 'audio.usage must return trend array');
      for (const tier of ['free', 'groq', 'paid', 'siliconflow']) {
        assert.ok(
          usage.value.providers.some((p) => p.tier === tier),
          `audio.usage providers missing tier ${tier}`,
        );
      }

      // 1c. audio.retry invalid job refusal
      const retryBad = await host.call('audio.retry', { jobId: 'nonexistent-audio-job-id' });
      assert.equal(retryBad.ok, false, 'audio.retry must refuse unknown/non-retryable jobId');
      assert.ok(retryBad.error?.message, 'audio.retry refusal must include error message');

      // 1d. audio.subtitles.import unsupported extension refusal
      const subBad = await host.call('audio.subtitles.import', {
        filename: 'lecture.mp3',
        text: '1\n00:00:01,000 --> 00:00:02,000\nHello world\n',
      });
      assert.equal(subBad.ok, false, 'audio.subtitles.import must refuse unsupported extension');
      assert.ok(subBad.error?.message, 'audio.subtitles.import refusal must include error message');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: AudioView diagnostics, [p] preflight, [R] retry guard, [u] subtitle modal + Esc, and 120x36 / 80x24 (--ascii & default)', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await saveTuiPreferences({ language: 'en', asciiMode: false }, { env });
    resetTuiStore();

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });
    await host.call('sample.load', { language: 'en' });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'audio',
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

      // 1. AudioView loads with Diagnostics & Quota section at 120x36
      const wideScreen = await tty.waitFor(
        (s) =>
          s.includes('Audio Transcription') &&
          s.includes('Diagnostics & Quota') &&
          s.includes('Preflight:') &&
          s.includes('Today:'),
        { label: 'AudioView Diagnostics & Quota rendered at 120x36' },
      );
      tty.assertHealthyScreen(wideScreen, 120, 36, 'AudioView 120x36 default');

      // 2. Press [p] to run on-demand audio.preflight and verify toast + panel
      useTuiStore.setState({ toasts: [] });
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Preflight:')),
        { label: '[p] preflight summary toast' },
      );

      // 3. Press [R] when no failed audio job is selected -> friendly warning toast
      useTuiStore.setState({ toasts: [] });
      tty.send('R');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('No failed or canceled audio job selected')),
        { label: '[R] friendly toast when no failed audio job selected' },
      );

      // 4. Open subtitle import modal via [u], verify render, then cancel with Esc
      tty.send('u');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Import Subtitle File') && s.includes('.srt / .vtt / .txt'),
        { label: 'Subtitle import modal opened via [u]' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'AudioView subtitle modal 120x36');
      assert.equal(useTuiStore.getState().inputCaptured, true, 'Modal must capture input');

      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('Import Subtitle File') && useTuiStore.getState().inputCaptured === false,
        { label: 'Subtitle import modal cancelled via Esc' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, 'AudioView after Esc close');

      // 5. Resize to 80x24 in default mode and verify clean rendering
      tty.resize(80, 24);
      const narrowDefault = await tty.waitFor(
        (s) =>
          s.includes('Diagnostics & Quota') &&
          s.includes('Preflight:') &&
          s.split('\n').length <= 24,
        { label: 'AudioView 80x24 default mode' },
      );
      tty.assertHealthyScreen(narrowDefault, 80, 24, 'AudioView 80x24 default');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // 6. Dedicated --ascii passes across 120x36 (en) and 80x24 (zh)
      for (const pass of [
        { cols: 120, rows: 36, language: 'en' },
        { cols: 80, rows: 24, language: 'zh' },
      ]) {
        await saveTuiPreferences({ language: pass.language, asciiMode: true }, { env });
        resetTuiStore();
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
              initialPage: 'audio',
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

          const asciiScreen = await asciiTty.waitFor(
            (s) =>
              s.includes(pass.language === 'en' ? 'Diagnostics & Quota' : '诊断与配额') &&
              s.includes(pass.language === 'en' ? 'Preflight:' : '预检:'),
            { label: `ASCII AudioView ${pass.cols}x${pass.rows} ${pass.language}` },
          );
          asciiTty.assertHealthyScreen(asciiScreen, pass.cols, pass.rows, `ASCII AudioView ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(asciiScreen, `ASCII AudioView ${pass.cols}x${pass.rows}`);

          // Open subtitle modal & cancel with Esc in --ascii mode too
          asciiTty.send('u');
          const asciiModal = await asciiTty.waitFor(
            (s) => s.includes(pass.language === 'en' ? 'Import Subtitle File' : '导入字幕文件校对'),
            { label: `ASCII subtitle modal ${pass.cols}x${pass.rows} ${pass.language}` },
          );
          asciiTty.assertHealthyScreen(asciiModal, pass.cols, pass.rows, `ASCII subtitle modal ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(asciiModal, `ASCII subtitle modal ${pass.cols}x${pass.rows}`);

          asciiTty.send('\x1b');
          await asciiTty.waitFor(
            (s) => !s.includes(pass.language === 'en' ? 'Import Subtitle File' : '导入字幕文件校对'),
            { label: `ASCII subtitle modal closed ${pass.cols}x${pass.rows}` },
          );
        } finally {
          inkInstance?.unmount();
          inkInstance = null;
          asciiTty.dispose();
          await host.dispose();
          host = null;
        }
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host?.dispose();
    }
  });
});
