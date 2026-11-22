// Round 52 Task 3: NotesView Import Note to Sources (`note.material.prepare` + `source.add`),
// HelpOverlay Round 52 Sync & `--ascii` Parity E2E:
// `node --test tests/round52-notes-material.test.mjs`
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round52-notes-mat-${label}-`));
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

describe('Round 52 Task 3: NotesView Import Note to Sources & HelpOverlay Sync', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration (0 model calls): note.material.prepare -> source.add -> snapshot.sources + empty-markdown error', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    const host = await H.createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return 'should-never-run';
      },
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'zh' });
      assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message || ''}`);

      const snapBefore = await host.call('library.snapshot', {});
      assert.equal(snapBefore.ok, true, 'library.snapshot failed');
      const deckSummary = snapBefore.value?.decks?.find((d) => !d.archived) || snapBefore.value?.decks?.[0];
      assert.ok(deckSummary?.id, 'sample library must contain a deck');
      const deckRes = await host.call('deck.get', { id: deckSummary.id });
      assert.equal(deckRes.ok, true, 'deck.get failed');
      const card = deckRes.value?.cards?.[0];
      assert.ok(card?.id, 'sample deck must contain a card');

      // Empty markdown note -> note.save({ markdown: '' }) -> note.material.prepare returns normalized error
      const emptyCreate = await host.call('note.create', {
        title: 'Empty Draft Note',
        cards: [{ deckId: deckSummary.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(emptyCreate.ok, true, `empty note.create failed: ${emptyCreate.error?.message || ''}`);
      const emptyCleared = await host.call('note.save', {
        id: emptyCreate.value.id,
        markdown: '',
        expectedRevision: emptyCreate.value.revision ?? 0,
      });
      assert.equal(emptyCleared.ok, true, `empty note.save failed: ${emptyCleared.error?.message || ''}`);
      const emptyPrep = await host.call('note.material.prepare', {
        id: emptyCleared.value.id,
        expectedRevision: emptyCleared.value.revision ?? 0,
      });
      assert.equal(emptyPrep.ok, false, 'empty markdown note must fail note.material.prepare');
      assert.ok(
        String(emptyPrep.error?.message || '').includes('请先生成或填写正文'),
        `unexpected empty markdown error: ${emptyPrep.error?.message}`,
      );

      // Populated markdown note -> note.material.prepare -> deterministic payload -> source.add
      const noteTitle = 'Round 52 OS Note';
      const noteMarkdown = '# 虚拟内存与页表\n\n页表项包含有效位、脏位与物理页框号。\n';
      const savedRes = await host.call('note.save', {
        id: emptyCleared.value.id,
        title: noteTitle,
        markdown: noteMarkdown,
        expectedRevision: emptyCleared.value.revision ?? 0,
      });
      assert.equal(savedRes.ok, true, `note.save failed: ${savedRes.error?.message || ''}`);

      const prep1 = await host.call('note.material.prepare', {
        id: savedRes.value.id,
        expectedRevision: savedRes.value.revision ?? 0,
      });
      assert.equal(prep1.ok, true, `note.material.prepare failed: ${prep1.error?.message || ''}`);
      assert.match(prep1.value.id, /^note-material-[0-9a-f]{64}$/);
      assert.equal(prep1.value.title, noteTitle);
      assert.equal(prep1.value.text, noteMarkdown.trim());
      assert.equal(prep1.value.format, 'md');
      assert.ok(Array.isArray(prep1.value.courses));

      // Deterministic id on repeat call
      const prep2 = await host.call('note.material.prepare', {
        id: savedRes.value.id,
        expectedRevision: savedRes.value.revision ?? 0,
      });
      assert.equal(prep2.ok, true);
      assert.equal(prep2.value.id, prep1.value.id);

      // Missing before source.add
      const preGet = await host.call('source.get', { id: prep1.value.id, limit: 1 });
      assert.equal(preGet.ok, false);

      // Import via source.add
      const addRes = await host.call('source.add', prep1.value);
      assert.equal(addRes.ok, true, `source.add failed: ${addRes.error?.message || ''}`);
      assert.equal(addRes.value.id, prep1.value.id);
      assert.equal(addRes.value.format, 'md');

      // Verify appears in refreshed snapshot.sources
      const refreshed = await host.refreshSnapshot();
      const matched = refreshed.snapshot?.sources?.find((s) => s.id === prep1.value.id);
      assert.ok(matched, 'imported note source must appear in refreshSnapshot().snapshot.sources');
      assert.equal(matched.title, noteTitle);
      assert.equal(matched.format, 'md');

      assert.equal(modelCalls, 0, 'note material preparation & import must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless E2E at 120x36 & 80x24 (default zh & --ascii en): [M] imports note to Sources, handles duplicate & empty note, HelpOverlay renders Round 52 keys', async () => {
    const passes = [
      {
        name: 'default zh',
        language: 'zh',
        asciiMode: false,
        noteTitle: 'R52 Markdown 笔记',
        noteBody: '# 进程调度\n\n时间片轮转与多级反馈队列。\n',
        emptyTitle: 'R52 空白笔记',
        successToast: '已将笔记「R52 Markdown 笔记」导入资料库',
        dupToast: '已在资料库中',
        emptyToast: '请先生成或填写正文',
        helpTargets: ['手动改AI分 / 确认订正', '骨架互动图 / 笔记入资料库', '阅读问答存为闪卡'],
      },
      {
        name: '--ascii en',
        language: 'en',
        asciiMode: true,
        noteTitle: 'R52 Note',
        noteBody: '# Virtual Memory\n\nTLB hit rate and page fault handling.\n',
        emptyTitle: 'R52 Empty',
        successToast: 'Imported note "R52 Note" to Sources',
        dupToast: 'Note "R52 Note" is already in Sources',
        emptyToast: 'Please generate or enter note content',
        helpTargets: ['Adjust AI grade / Ack fix', 'Skeleton diagrams / Note to source', 'Save reader Q&A as card'],
      },
    ];

    for (const pass of passes) {
      const base = await makeTempDir(pass.language);
      const dshHome = join(base, 'dsh-home');
      const env = { DSH_HOME: dshHome };
      const libraryRoot = join(base, 'library');

      let modelCalls = 0;
      const host = await H.createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: pass.language,
        eventDebounceMs: 30,
        injectedComplete: async () => {
          modelCalls += 1;
          return 'should-never-run';
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

        // Create empty note first (older updatedAt) and clear its default template markdown
        const emptyRes = await host.call('note.create', {
          title: pass.emptyTitle,
          cards: [{ deckId: deckSummary.id, cardId: card.id }],
          prefill: false,
          language: pass.language,
        });
        assert.equal(emptyRes.ok, true);
        const emptyCleared = await host.call('note.save', {
          id: emptyRes.value.id,
          markdown: '',
          expectedRevision: emptyRes.value.revision ?? 0,
        });
        assert.equal(emptyCleared.ok, true);

        await sleep(20);

        // Create & save markdown note second (newest updatedAt -> selected first in list)
        const mdCreate = await host.call('note.create', {
          title: pass.noteTitle,
          cards: [{ deckId: deckSummary.id, cardId: card.id }],
          prefill: false,
          language: pass.language,
        });
        assert.equal(mdCreate.ok, true);
        const mdSaved = await host.call('note.save', {
          id: mdCreate.value.id,
          title: pass.noteTitle,
          markdown: pass.noteBody,
          expectedRevision: mdCreate.value.revision ?? 0,
        });
        assert.equal(mdSaved.ok, true);

        const prep = await host.call('note.material.prepare', {
          id: mdSaved.value.id,
          expectedRevision: mdSaved.value.revision ?? 0,
        });
        assert.equal(prep.ok, true);
        const expectedSourceId = prep.value.id;

        process.env.DSH_HOME = dshHome;
        await H.saveTuiPreferences({ language: pass.language, asciiMode: pass.asciiMode }, { env });
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
              s.includes(pass.noteTitle) &&
              (pass.language === 'zh' ? s.includes('入资料库') : s.includes('To Sources')),
            { label: `NotesView initial (${pass.name})` },
          );
          tty.assertHealthyScreen(initial, 120, 36, `NotesView 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView 120x36 (${pass.name})`);

          // Press M on markdown note -> imports into Sources and shows success toast
          tty.send('M');
          const afterImport = await tty.waitFor(
            (s) => s.includes(pass.successToast),
            { label: `[M] import success toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterImport, 120, 36, `NotesView after [M] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterImport, `NotesView after [M] (${pass.name})`);

          // Verify source is present in store snapshot & host
          const storeSnap = S.useTuiStore.getState().snapshot;
          assert.ok(
            storeSnap?.sources?.some((src) => src.id === expectedSourceId),
            `store snapshot must contain imported source ${expectedSourceId} (${pass.name})`,
          );
          const getAdded = await host.call('source.get', { id: expectedSourceId, limit: 1 });
          assert.equal(getAdded.ok, true, 'imported source must be retrievable via source.get');

          // Press M again on unchanged note -> info toast without duplicating
          tty.send('M');
          const afterDup = await tty.waitFor(
            (s) => s.includes(pass.dupToast),
            { label: `[M] duplicate info toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterDup, 120, 36, `NotesView duplicate [M] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterDup, `NotesView duplicate [M] (${pass.name})`);

          // Move down to empty note and press M -> normalized error toast
          tty.send('j');
          await tty.waitFor(
            (s) => s.includes(pass.emptyTitle),
            { label: `Select empty note (${pass.name})` },
          );
          tty.send('M');
          const afterEmpty = await tty.waitFor(
            (s) => s.includes(pass.emptyToast),
            { label: `[M] empty note error toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterEmpty, 120, 36, `NotesView empty [M] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterEmpty, `NotesView empty [M] (${pass.name})`);

          // Verify 80x24 compact layout
          tty.resize(80, 24);
          await sleep(80);
          await tty.flush();
          const compact = tty.readScreen();
          tty.assertHealthyScreen(compact, 80, 24, `NotesView 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compact, `NotesView 80x24 (${pass.name})`);

          // Restore 120x36 and open HelpOverlay ('?') to verify Round 52 entries
          tty.resize(120, 36);
          await tty.waitFor(
            (s) => s.includes(pass.noteTitle),
            { label: `NotesView restored 120x36 (${pass.name})` },
          );
          tty.send('?');
          await tty.waitFor(
            (s) => s.includes(pass.language === 'zh' ? '快捷键' : 'Keyboard Shortcuts'),
            { label: `HelpOverlay opened (${pass.name})` },
          );

          const seen = new Set();
          for (let step = 0; step < 16 && seen.size < pass.helpTargets.length; step += 1) {
            const scr = tty.readScreen();
            tty.assertHealthyScreen(scr, 120, 36, `HelpOverlay scroll ${step} (${pass.name})`);
            if (pass.asciiMode) tty.assertAsciiPure(scr, `HelpOverlay scroll ${step} (${pass.name})`);
            for (const target of pass.helpTargets) {
              if (scr.includes(target)) seen.add(target);
            }
            if (seen.size < pass.helpTargets.length) {
              tty.send('\x04'); // Ctrl+D half-page scroll down
              await tty.flush();
            }
          }
          for (const target of pass.helpTargets) {
            assert.ok(seen.has(target), `HelpOverlay (${pass.name}) missing Round 52 entry: ${target}`);
          }

          tty.send('\x1b');
          await tty.waitFor(
            (s) => !s.includes(pass.language === 'zh' ? '快捷键' : 'Keyboard Shortcuts'),
            { label: `HelpOverlay closed (${pass.name})` },
          );
          assert.equal(modelCalls, 0, `PTY pass (${pass.name}) must trigger 0 model calls`);
        } finally {
          try {
            inkInstance?.unmount();
          } catch {
            // ignore unmount errors
          }
          tty.dispose();
        }
      } finally {
        await host.dispose();
      }
    }
  });
});
