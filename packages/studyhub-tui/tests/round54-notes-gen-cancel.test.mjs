// Round 54 Task 2: NotesView AI Draft Note Generation (`note.generate`, P2 ConfirmDialog quota-guarded)
// & Cancel Running Draft (`note.cancel`):
// `node --test tests/round54-notes-gen-cancel.test.mjs`
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

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && typeof mod.useTuiStore?.getState === 'function') S = mod;
  }
}
if (!S) {
  for (const f of distFiles) {
    if (f.startsWith('store-')) {
      const mod = await import(pathToFileURL(join(distDir, f)).href);
      if (typeof mod.useTuiStore?.getState === 'function') {
        S = mod;
        break;
      }
    }
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round54-notes-gen-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

const SAMPLE_GENERATED_MARKDOWN = [
  '# Operating System Virtual Memory Summary',
  '',
  'Virtual memory decouples process address spaces from physical RAM frames using multi-level page tables and TLB caching.',
  '',
  '## Worked Example',
  '',
  'Given a 4 KB page size ($2^{12}$ bytes) and a 32-bit virtual address, the low 12 bits form the page offset while the upper 20 bits select the page frame mapping.',
].join('\n');

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
    assert.ok(!screen.includes('\uFFFD'), `${label}: U+FFFD replacement char leaked`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
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

function resetTuiStore() {
  S.useTuiStore.setState({
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

function waitForGateOrAbort(gatePromise, signal) {
  return new Promise((resolveFn, rejectFn) => {
    if (signal?.aborted) {
      rejectFn(signal.reason || new Error('Aborted'));
      return;
    }
    const onAbort = () => rejectFn(signal.reason || new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    gatePromise.then(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveFn();
    });
  });
}

describe('Round 54 Task 2: NotesView AI Draft Note Generation & Cancel', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: idle note.cancel (0 calls), note.generate running/cancel/complete, published note refusal (0 calls)', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    let releaseGate = null;
    let gatePromise = new Promise((resolveFn) => {
      releaseGate = resolveFn;
    });

    const host = await H.createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, _prompt, execution = {}) => {
        modelCalls += 1;
        await waitForGateOrAbort(gatePromise, execution.signal);
        execution.signal?.throwIfAborted?.();
        return SAMPLE_GENERATED_MARKDOWN;
      },
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'zh' });
      assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message || ''}`);

      const snapRes = await host.call('library.snapshot', {});
      assert.equal(snapRes.ok, true, 'library.snapshot failed');
      const deckSummary = snapRes.value?.decks?.find((d) => !d.archived) || snapRes.value?.decks?.[0];
      assert.ok(deckSummary?.id, 'sample library must contain a deck');
      const deckRes = await host.call('deck.get', { id: deckSummary.id });
      assert.equal(deckRes.ok, true, 'deck.get failed');
      const card = deckRes.value?.cards?.[0];
      assert.ok(card?.id, 'sample deck must contain a card');

      const draftCreate = await host.call('note.create', {
        title: 'Round 54 Draft Note',
        cards: [{ deckId: deckSummary.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(draftCreate.ok, true, `note.create failed: ${draftCreate.error?.message || ''}`);
      const draftNote = draftCreate.value;
      assert.equal(draftNote.status, 'draft');

      // note.cancel is idempotent on an idle note and makes 0 model calls
      const idleCancel = await host.call('note.cancel', { id: draftNote.id });
      assert.equal(idleCancel.ok, true, `idle note.cancel failed: ${idleCancel.error?.message || ''}`);
      assert.equal(idleCancel.value?.id, draftNote.id);
      assert.equal(modelCalls, 0, 'idle note.cancel must trigger 0 model calls');

      // Launch note.generate while gate holds -> returns running, then note.cancel stops it cleanly
      const genStart = await host.call('note.generate', {
        id: draftNote.id,
        expectedRevision: draftNote.revision ?? 0,
      });
      assert.equal(genStart.ok, true, `note.generate failed: ${genStart.error?.message || ''}`);
      assert.equal(genStart.value?.id, draftNote.id);
      assert.ok(genStart.value?.jobId, 'note.generate must return jobId');
      assert.equal(genStart.value?.status, 'running');
      assert.equal(modelCalls, 1, 'note.generate must invoke injectedComplete once');

      const cancelRunning = await host.call('note.cancel', { id: draftNote.id });
      assert.equal(cancelRunning.ok, true, `running note.cancel failed: ${cancelRunning.error?.message || ''}`);
      assert.equal(cancelRunning.value?.generation?.status, 'cancelled');

      // Release gate and run note.generate to completion on a second draft note
      releaseGate?.();
      gatePromise = Promise.resolve();
      const draft2Create = await host.call('note.create', {
        title: 'Round 54 Completed Draft',
        cards: [{ deckId: deckSummary.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(draft2Create.ok, true);
      const genDoneStart = await host.call('note.generate', {
        id: draft2Create.value.id,
        expectedRevision: draft2Create.value.revision ?? 0,
      });
      assert.equal(genDoneStart.ok, true);
      assert.equal(genDoneStart.value?.status, 'running');

      let completedNote = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const getRes = await host.call('note.get', { id: draft2Create.value.id });
        if (getRes.ok && getRes.value?.generation?.status === 'done') {
          completedNote = getRes.value;
          break;
        }
        await sleep(25);
      }
      assert.ok(completedNote, 'note.generate must transition to done once model completes');
      assert.ok(completedNote.markdown.includes('Virtual memory decouples process address spaces'));
      assert.equal(modelCalls, 2);

      // Publish the note and verify note.generate refuses with 0 additional model calls
      await host.call('note.home', { home: 'https://blog.csdn.net/r54tester' });
      const linked = await host.call('note.link', {
        id: completedNote.id,
        url: 'https://blog.csdn.net/r54tester/article/details/540001',
        expectedRevision: completedNote.revision ?? 0,
      });
      assert.equal(linked.ok, true, `note.link failed: ${linked.error?.message || ''}`);
      assert.equal(linked.value?.status, 'published');

      const callsBeforePublished = modelCalls;
      const pubGen = await host.call('note.generate', {
        id: linked.value.id,
        expectedRevision: linked.value.revision ?? 0,
      });
      assert.equal(pubGen.ok, false, 'published note must reject note.generate');
      assert.ok(
        String(pubGen.error?.message || '').includes('已发布文章不能重新起草'),
        `unexpected published refusal message: ${pubGen.error?.message}`,
      );
      assert.equal(modelCalls, callsBeforePublished, 'published note refusal must trigger 0 model calls');
    } finally {
      releaseGate?.();
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh & 80x24 --ascii en): [g] ConfirmDialog -> [n] 0 calls -> [g]+[y] launches -> [C]+[y] cancels', async () => {
    const passes = [
      {
        name: '120x36 zh',
        cols: 120,
        rows: 36,
        language: 'zh',
        asciiMode: false,
        noteTitle: 'R54 虚拟内存草稿',
        confirmTitle: 'AI 起草笔记正文',
        startedToast: '已启动 AI 笔记起草任务',
        cancelTitle: '停止 AI 起草笔记',
        cancelledToast: '已停止笔记 AI 起草',
      },
      {
        name: '80x24 --ascii en',
        cols: 80,
        rows: 24,
        language: 'en',
        asciiMode: true,
        noteTitle: 'R54 Memory Draft',
        confirmTitle: 'AI Draft Note',
        startedToast: 'Started AI note draft',
        cancelTitle: 'Stop AI Note Draft',
        cancelledToast: 'Stopped note AI drafting',
      },
    ];

    for (const pass of passes) {
      const base = await makeTempDir(pass.language);
      const dshHome = join(base, 'dsh-home');
      const env = { DSH_HOME: dshHome };
      const libraryRoot = join(base, 'library');

      let modelCalls = 0;
      let releaseGate = null;
      const gatePromise = new Promise((resolveFn) => {
        releaseGate = resolveFn;
      });

      const host = await H.createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: pass.language,
        eventDebounceMs: 30,
        injectedComplete: async (_system, _prompt, execution = {}) => {
          modelCalls += 1;
          await waitForGateOrAbort(gatePromise, execution.signal);
          execution.signal?.throwIfAborted?.();
          return SAMPLE_GENERATED_MARKDOWN;
        },
      });

      try {
        const sampleRes = await host.call('sample.load', { language: pass.language });
        assert.equal(sampleRes.ok, true, 'sample.load must succeed');
        const snapRes = await host.call('library.snapshot', {});
        const deckSummary = snapRes.value?.decks?.find((d) => !d.archived) || snapRes.value?.decks?.[0];
        assert.ok(deckSummary?.id, 'deck required');
        const deckRes = await host.call('deck.get', { id: deckSummary.id });
        const card = deckRes.value?.cards?.[0];
        assert.ok(card?.id, 'card required');

        const created = await host.call('note.create', {
          title: pass.noteTitle,
          cards: [{ deckId: deckSummary.id, cardId: card.id }],
          prefill: false,
          language: pass.language,
        });
        assert.equal(created.ok, true, `note.create failed: ${created.error?.message || ''}`);

        process.env.DSH_HOME = dshHome;
        await H.saveTuiPreferences({ language: pass.language, asciiMode: pass.asciiMode }, { env });
        host.setLanguage(pass.language);
        resetTuiStore();

        const tty = createVirtualTty(pass.cols, pass.rows);
        let inkInstance = null;
        try {
          inkInstance = render(
            React.createElement(StudyHubTuiApp, {
              host,
              initialPage: 'notes',
              initialNavContext: { noteId: created.value.id },
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
              s.includes(pass.noteTitle) &&
              (pass.language === 'zh' ? s.includes('AI起草') : s.includes('AI Draft')),
            { label: `NotesView initial (${pass.name})` },
          );
          tty.assertHealthyScreen(initial, pass.cols, pass.rows, `NotesView initial (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView initial (${pass.name})`);

          // 1) Press 'g' -> opens P2 ConfirmDialog with 0 model calls
          tty.send('g');
          const confirmOpen = await tty.waitFor(
            (s) =>
              s.includes(pass.confirmTitle) &&
              s.includes(pass.noteTitle) &&
              (pass.language === 'zh'
                ? s.includes('关联 1') && s.includes('张题卡')
                : /\b1\b/.test(s) && s.includes('linked card')),
            { label: `[g] ConfirmDialog open (${pass.name})` },
          );
          assert.equal(modelCalls, 0, `[g] opening ConfirmDialog must trigger 0 model calls (${pass.name})`);
          tty.assertHealthyScreen(confirmOpen, pass.cols, pass.rows, `ConfirmDialog (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(confirmOpen, `ConfirmDialog (${pass.name})`);

          // 2) Press 'n' -> cancels cleanly with 0 model calls
          tty.send('n');
          const afterCancel = await tty.waitFor(
            (s) => !s.includes(pass.confirmTitle),
            { label: `[n] cancel ConfirmDialog (${pass.name})` },
          );
          assert.equal(modelCalls, 0, `[n] cancelling ConfirmDialog must trigger 0 model calls (${pass.name})`);
          tty.assertHealthyScreen(afterCancel, pass.cols, pass.rows, `NotesView after [n] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterCancel, `NotesView after [n] (${pass.name})`);

          // 3) Press 'g' then 'y' -> launches note.generate with toast feedback
          tty.send('g');
          await tty.waitFor(
            (s) => s.includes(pass.confirmTitle),
            { label: `[g] reopen ConfirmDialog (${pass.name})` },
          );
          tty.send('y');
          const startedScreen = await tty.waitFor(
            (s) => s.includes(pass.startedToast) && modelCalls === 1,
            { label: `[y] note.generate started (${pass.name})` },
          );
          tty.assertHealthyScreen(startedScreen, pass.cols, pass.rows, `NotesView after [g]+[y] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(startedScreen, `NotesView after [g]+[y] (${pass.name})`);

          // 4) Wait for running state then press 'C' -> confirm cancel -> note.cancel stops draft
          const runningScreen = await tty.waitFor(
            (s) =>
              pass.cols >= 86
                ? pass.language === 'zh'
                  ? s.includes('AI 正在生成内容') && s.includes('停生成')
                  : s.includes('Generating') && s.includes('Stop Gen')
                : s.includes(`${pass.asciiMode ? '~' : '⟳'} ${pass.noteTitle}`),
            { label: `running draft state (${pass.name})` },
          );
          tty.assertHealthyScreen(runningScreen, pass.cols, pass.rows, `NotesView running (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(runningScreen, `NotesView running (${pass.name})`);

          tty.send('C');
          const cancelDialog = await tty.waitFor(
            (s) => s.includes(pass.cancelTitle),
            { label: `[C] ConfirmDialog open (${pass.name})` },
          );
          tty.assertHealthyScreen(cancelDialog, pass.cols, pass.rows, `Cancel ConfirmDialog (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(cancelDialog, `Cancel ConfirmDialog (${pass.name})`);

          tty.send('y');
          const cancelledScreen = await tty.waitFor(
            (s) => s.includes(pass.cancelledToast),
            { label: `[C]+[y] note.cancel toast (${pass.name})` },
          );
          tty.assertHealthyScreen(cancelledScreen, pass.cols, pass.rows, `NotesView after [C]+[y] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(cancelledScreen, `NotesView after [C]+[y] (${pass.name})`);
        } finally {
          try {
            inkInstance?.unmount();
          } catch {
            // ignore unmount errors
          }
          tty.dispose();
        }
      } finally {
        releaseGate?.();
        await host.dispose();
      }
    }
  });
});
