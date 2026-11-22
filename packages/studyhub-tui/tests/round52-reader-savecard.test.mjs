// Round 52 DocumentReader Save Grounded Q&A Answer as Flashcard (0-token generation.selection.saveAnswer):
// `node --test tests/round52-reader-savecard.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const { extractPageAnchorSlice } = await tsImport('../src/views/sources/DocumentReader.tsx', import.meta.url);

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round52-savecard-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;
const FORBIDDEN_ASCII_CHROME_RE = /[›…✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾☰✎]/g;

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

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Screen rows exceeded (${lines.length} > ${expectedRows})`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
    }
  }

  function assertAsciiPure(screen, contextLabel) {
    for (const [label, re] of [
      ['box-drawing', UNICODE_BOX_RE],
      ['block-element', UNICODE_BLOCK_RE],
      ['braille', UNICODE_BRAILLE_RE],
      ['unicode-chrome', FORBIDDEN_ASCII_CHROME_RE],
    ]) {
      const match = screen.match(re);
      assert.equal(
        match,
        null,
        `${contextLabel}: ${label} leaked in --ascii mode: ${JSON.stringify(match ? [...new Set(match)] : [])}\n${screen}`,
      );
    }
  }

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
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

describe('StudyHub TUI Round 52 DocumentReader Save Q&A Answer as Flashcard', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let modelCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'sources', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
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
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    return tty;
  }

  async function openSourceInReader(tty, titleNeedle, expectedBodyNeedle) {
    await tty.waitFor(
      (s) => s.includes(titleNeedle) && !s.includes('正在加载页面') && !s.includes('Loading page'),
      { timeoutMs: 10_000, label: `SourcesView showing ${titleNeedle}` },
    );

    tty.send('/');
    await tty.flush();
    tty.send(titleNeedle);
    await tty.waitFor(
      (s) =>
        s.includes(`Filter: ${titleNeedle}`) ||
        s.includes(`筛选资料: ${titleNeedle}`) ||
        s.includes(`搜索: ${titleNeedle}`),
      {
        timeoutMs: 5_000,
        label: `Filtered to ${titleNeedle}`,
      },
    );
    tty.send('\r');
    await tty.flush();
    tty.send('\r');

    await tty.waitFor(
      (s) =>
        s.includes(titleNeedle) &&
        s.includes(expectedBodyNeedle) &&
        (s.includes('第 ') || s.includes('P. ')) &&
        (s.includes('问AI') || s.includes('Ask')),
      { timeoutMs: 10_000, label: `DocumentReader opened for ${titleNeedle}` },
    );
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        const text = String(prompt || '');
        if (text.includes('Gradient descent')) {
          return 'Grounded answer: Gradient descent updates weights opposite to the loss gradient.';
        }
        return '依据本页原文：注意力机制通过查询与键的点积动态分配权重。';
      },
    });
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) Host integration & extractPageAnchorSlice: 0-token saveAnswer creates deck & card, and duplicates cleanly', async () => {
    modelCalls = 0;

    // Pure helper invariants
    assert.equal(extractPageAnchorSlice(''), null);
    assert.equal(extractPageAnchorSlice('   \n\t  \n '), null);

    const sampleLeading = '   \n\nFirst passage line one.\nLine two.   \n\nSecond paragraph ignored.';
    const sliced = extractPageAnchorSlice(sampleLeading);
    assert.ok(sliced, 'expected non-null anchor slice');
    assert.equal(sampleLeading.slice(sliced.start, sliced.end), sliced.quote);
    assert.equal(sliced.quote, 'First passage line one.\nLine two.');

    const longText = `  ${'A'.repeat(300)}  `;
    const longSlice = extractPageAnchorSlice(longText);
    assert.ok(longSlice, 'expected non-null slice for long text');
    assert.equal(longText.slice(longSlice.start, longSlice.end), longSlice.quote);
    assert.ok(longSlice.quote.length <= 240, 'slice must be capped at 240 chars');

    const mdText = '# Backpropagation\n\nBackpropagation applies the chain rule across layers to compute exact gradients.\n';
    const added = await host.call('source.add', {
      title: 'R52 Host SaveCard Doc',
      format: 'md',
      text: mdText,
    });
    assert.equal(added.ok, true, `source.add failed: ${added.error?.message || ''}`);
    const sourceId = added.value.id;
    assert.ok(sourceId, 'source.add must return id');

    const anchor = extractPageAnchorSlice(mdText);
    assert.ok(anchor, 'anchor slice must resolve for markdown material');
    assert.equal(mdText.slice(anchor.start, anchor.end), anchor.quote);

    const docRes = await host.call('materials.document.get', { sourceId });
    assert.equal(docRes.ok, true, `materials.document.get failed: ${docRes.error?.message || ''}`);
    const documentId = docRes.value.documentId || docRes.value.id;
    assert.ok(documentId, 'materials.document.get must return documentId');

    const resolved = await host.call('materials.selection.resolve', {
      documentId,
      sourceId,
      start: anchor.start,
      end: anchor.end,
      quote: anchor.quote,
    });
    assert.equal(resolved.ok, true, `selection.resolve failed: ${resolved.error?.message || ''}`);
    assert.equal(resolved.value.status, 'resolved');
    const selection = Object.fromEntries(
      Object.entries(resolved.value.selection).filter(([, v]) => v !== undefined),
    );
    assert.ok(selection?.documentId, 'resolved selection must include documentId');
    assert.ok(selection?.revision, 'resolved selection must include revision');

    const question = 'How does backpropagation compute gradients?';
    const answer = 'It applies the chain rule recursively across each neural network layer.';

    const save1 = await host.call('generation.selection.saveAnswer', {
      selection,
      question,
      answer,
      operationId: 'r52-host-save-1',
      uiLanguage: 'en',
    });
    assert.equal(save1.ok, true, `saveAnswer #1 failed: ${save1.error?.message || ''}`);
    assert.equal(save1.value.status, 'complete');
    assert.ok(save1.value.deckId, 'saveAnswer must return deckId');
    assert.ok(save1.value.cardId, 'saveAnswer must return cardId');
    assert.equal(modelCalls, 0, 'saveAnswer must invoke 0 model calls');

    const refreshed = await host.refreshSnapshot();
    assert.ok(refreshed.snapshot, `refreshSnapshot failed: ${refreshed.error || ''}`);
    const createdDeck = refreshed.snapshot.decks.find((d) => d.id === save1.value.deckId);
    assert.ok(createdDeck, 'created deck must appear in refreshSnapshot().snapshot.decks');
    assert.equal(createdDeck.count, 1);

    const deckDetail = await host.call('deck.get', { id: save1.value.deckId });
    assert.equal(deckDetail.ok, true);
    const createdCard = (deckDetail.value.cards || []).find((c) => c.id === save1.value.cardId);
    assert.ok(createdCard, 'created card must exist in deck.get');
    assert.equal(createdCard.answer, answer);
    assert.ok(String(createdCard.prompt || '').includes(question), 'card prompt must include question');
    assert.ok(String(createdCard.prompt || '').includes(anchor.quote), 'card prompt must include quoted passage');

    const linksRes = await host.call('materials.links.list', { cardId: save1.value.cardId });
    assert.equal(linksRes.ok, true);
    const linkEntry = (linksRes.value.links || []).find((l) => l.cardId === save1.value.cardId);
    assert.ok(linkEntry, 'materials.links.list must return linked card');
    assert.equal(linkEntry.sourceQa, true);

    const save2 = await host.call('generation.selection.saveAnswer', {
      selection,
      question,
      answer,
      operationId: 'r52-host-save-2',
      uiLanguage: 'en',
    });
    assert.equal(save2.ok, true, `saveAnswer #2 failed: ${save2.error?.message || ''}`);
    assert.equal(save2.value.status, 'duplicate');
    assert.equal(save2.value.deckId, save1.value.deckId);
    assert.equal(modelCalls, 0, 'duplicate saveAnswer must invoke 0 model calls');
  });

  test('2a) @xterm/headless E2E (zh 120x36 & 80x24): ask question -> [f] hint renders -> press f saves flashcard & shows duplicate on repeat', async () => {
    modelCalls = 0;
    const title = 'R52 Zh SaveCard Doc';
    const body = '注意力机制通过查询、键和值的缩放点积动态分配上下文权重。';

    const added = await host.call('source.add', {
      title,
      format: 'md',
      text: `${body}\n`,
    });
    assert.equal(added.ok, true);

    const beforeSnap = await host.refreshSnapshot();
    const beforeDeck = beforeSnap.snapshot.decks.find(
      (d) => d.purpose === 'source-qa' || d.title === '原文问答' || d.title === 'Source Q&A',
    );
    const beforeCount = beforeDeck?.count ?? 0;

    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await openSourceInReader(tty, title, '注意力机制通过查询');

    tty.send('a');
    await tty.waitFor((s) => s.includes('向 AI 提问本页:'), {
      timeoutMs: 5_000,
      label: 'ask-input prompt (zh)',
    });

    tty.send('什么是注意力机制？');
    await tty.waitFor((s) => s.includes('什么是注意力机制？'), {
      timeoutMs: 5_000,
      label: 'ask-input typed question (zh)',
    });
    tty.send('\r');
    const answerScreen120 = await tty.waitFor(
      (s) =>
        s.includes('AI 讲解') &&
        s.includes('依据本页原文') &&
        s.includes('[f] 存为闪卡'),
      { timeoutMs: 8_000, label: 'ask-view answer & [f] hint (zh 120x36)' },
    );
    tty.assertHealthyScreen(answerScreen120, 120, 36, 'ask-view 120x36 (zh)');
    assert.equal(modelCalls, 1, 'ask AI should invoke model once');

    tty.resize(80, 24);
    const answerScreen80 = await tty.waitFor(
      (s) => s.includes('AI 讲解') && s.includes('[f] 存为闪卡'),
      { timeoutMs: 5_000, label: 'ask-view at 80x24 (zh)' },
    );
    tty.assertHealthyScreen(answerScreen80, 80, 24, 'ask-view 80x24 (zh)');

    tty.resize(120, 36);
    tty.send('f');
    const savedScreen = await tty.waitFor(
      (s) => s.includes('已保存为原文关联闪卡') && s.includes('[f] 已存闪卡'),
      { timeoutMs: 8_000, label: 'success toast & saved state after pressing f (zh)' },
    );
    tty.assertHealthyScreen(savedScreen, 120, 36, 'after save card (zh)');
    assert.equal(modelCalls, 1, 'pressing f must invoke 0 additional model calls');

    const snap = await host.refreshSnapshot();
    const qaDeck = snap.snapshot.decks.find(
      (d) => d.purpose === 'source-qa' || d.title === '原文问答' || d.title === 'Source Q&A',
    );
    assert.ok(qaDeck, 'Q&A deck must be persisted in snapshot.decks');
    assert.equal(qaDeck.count, beforeCount + 1);

    const detail = await host.call('deck.get', { id: qaDeck.id });
    assert.equal(detail.ok, true);
    const persistedCard = (detail.value.cards || []).find((c) =>
      String(c.answer || '').includes('注意力机制通过查询与键的点积'),
    );
    assert.ok(persistedCard, 'persisted Q&A card must contain grounded zh answer');

    // Pressing 'f' again surfaces duplicate info toast with 0 model calls
    tty.send('f');
    const dupScreen = await tty.waitFor(
      (s) => s.includes('该问答卡片已存在于题组中'),
      { timeoutMs: 5_000, label: 'duplicate info toast on repeat f (zh)' },
    );
    tty.assertHealthyScreen(dupScreen, 120, 36, 'duplicate save card (zh)');
    assert.equal(modelCalls, 1, 'repeat f must invoke 0 model calls');
  });

  test('2b) @xterm/headless E2E (--ascii en 120x36 & 80x24): ask -> [f] Save card -> persists card & leaks zero non-ASCII chrome', async () => {
    modelCalls = 0;
    const title = 'R52 En Ascii SaveCard Doc';
    const body = 'Gradient descent iteratively updates model parameters along the negative gradient.';

    const added = await host.call('source.add', {
      title,
      format: 'md',
      text: `${body}\n`,
    });
    assert.equal(added.ok, true);

    const beforeSnap = await host.refreshSnapshot();
    const beforeDeck = beforeSnap.snapshot.decks.find((d) => d.title === 'Source Q&A');
    const beforeCount = beforeDeck?.count ?? 0;

    const tty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en', cols: 120, rows: 36 });
    await openSourceInReader(tty, title, 'Gradient descent iteratively');

    tty.send('a');
    await tty.waitFor((s) => s.includes('Ask AI about this page:'), {
      timeoutMs: 5_000,
      label: 'ask-input prompt (--ascii en)',
    });

    tty.send('How does gradient descent work?');
    await tty.waitFor((s) => s.includes('How does gradient descent work?'), {
      timeoutMs: 5_000,
      label: 'ask-input typed question (--ascii en)',
    });
    tty.send('\r');
    const answerScreen120 = await tty.waitFor(
      (s) =>
        s.includes('AI Answer') &&
        s.includes('Grounded answer: Gradient descent') &&
        s.includes('[f] Save card'),
      { timeoutMs: 8_000, label: 'ask-view answer & [f] Save card (--ascii en 120x36)' },
    );
    tty.assertHealthyScreen(answerScreen120, 120, 36, 'ask-view 120x36 (--ascii en)');
    tty.assertAsciiPure(answerScreen120, 'ask-view 120x36 (--ascii en)');
    assert.equal(modelCalls, 1);

    tty.resize(80, 24);
    const answerScreen80 = await tty.waitFor(
      (s) => s.includes('AI Answer') && s.includes('[f] Save card'),
      { timeoutMs: 5_000, label: 'ask-view 80x24 (--ascii en)' },
    );
    tty.assertHealthyScreen(answerScreen80, 80, 24, 'ask-view 80x24 (--ascii en)');
    tty.assertAsciiPure(answerScreen80, 'ask-view 80x24 (--ascii en)');

    tty.send('f');
    const savedScreen80 = await tty.waitFor(
      (s) => s.includes('Saved as passage-linked') && s.includes('[f] Card saved'),
      { timeoutMs: 8_000, label: 'saved flashcard toast & hint (--ascii en 80x24)' },
    );
    tty.assertHealthyScreen(savedScreen80, 80, 24, 'after save card 80x24 (--ascii en)');
    tty.assertAsciiPure(savedScreen80, 'after save card 80x24 (--ascii en)');
    assert.equal(modelCalls, 1, 'saving card must invoke 0 additional model calls');

    const snap = await host.refreshSnapshot();
    const qaDeck = snap.snapshot.decks.find((d) => d.title === 'Source Q&A');
    assert.ok(qaDeck, 'en Q&A deck must be persisted in snapshot.decks');
    assert.equal(qaDeck.count, beforeCount + 1);

    const detail = await host.call('deck.get', { id: qaDeck.id });
    assert.equal(detail.ok, true);
    const persistedCard = (detail.value.cards || []).find((c) =>
      String(c.answer || '').includes('Gradient descent updates weights'),
    );
    assert.ok(persistedCard, 'persisted Source Q&A card must contain grounded answer');
  });
});
