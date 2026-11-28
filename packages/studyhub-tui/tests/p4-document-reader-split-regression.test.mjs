// P4 (#1354 D12): DocumentReader.tsx line-limit guardrail & split behavioral regression suite.
// Exercises pure reader-model helpers, page loading & source.get fallback, pagination & jump clamping,
// lastReadPages resume & unmount flush, chapter read optimistic toggle & rollback, search jump,
// Ask-AI streaming/fallback/abort/save-note/save-card, bilingual translation cache/estimate/confirm/cancel/race,
// linked-card practice & generate navigation, narrow/wide layout, and ASCII mode cleanliness.
// Run: node --test tests/p4-document-reader-split-regression.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';
import {
  MAX_SOURCE_FILE_LINES,
  evaluateLineLimitRatchet,
  formatLineLimitReport,
  loadLineLimitBaseline,
  scanSourceLineCounts,
} from '../scripts/line-limit-guard.mjs';

const unregisterTsx = register();
const tempDirs = [];

after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

const [
  readerMod,
  { useTuiStore, DEFAULT_PREFERENCES },
  { useKeyDispatcherBridge },
  { loadTuiPreferences, MAX_LAST_READ_PAGES },
] = await Promise.all([
  import('../src/views/sources/DocumentReader.tsx'),
  import('../src/state/store.ts'),
  import('../src/input/hooks.ts'),
  import('../src/host/tui-prefs.ts'),
]);

const { DocumentReader, extractPageAnchorSlice } = readerMod;
// Synchronous key dispatch, for presses that must land in the same tick (e.g. Esc right after s, #1603).
const { getHub, dispatchToHub } = await import('../src/input/dispatcher.ts');

const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

const DOCUMENT_READER_SPLIT_FILES = [
  'views/sources/DocumentReader.tsx',
  'views/sources/reader-model.ts',
  'views/sources/useReaderPageState.ts',
  'views/sources/useReaderAskActions.ts',
  'views/sources/ReaderAuxPanels.tsx',
  'views/sources/ReaderOverlays.tsx',
];

async function makeTempDir(label) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `studyhub-p4-reader-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetTuiStore({ language = 'zh', asciiMode = false, mathUnicode = true, lastReadPages = {}, snapshot = null } = {}) {
  useTuiStore.setState({
    page: 'sources',
    navContext: {},
    history: [],
    snapshot,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
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
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
      mathUnicode,
      lastReadPages: { ...lastReadPages },
    },
  });
}

function KeyBridgeWrapper({ cols, rows, children }) {
  useKeyDispatcherBridge();
  return React.createElement(Box, { width: cols, height: rows }, children);
}

function mountDocumentReader(props, { cols = 112, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  const listeners = new Set();
  const activeTimers = new Set();

  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) {
      latest = plain;
      for (const fn of [...listeners]) fn();
    }
  });

  const buildTree = (currentProps) =>
    React.createElement(
      KeyBridgeWrapper,
      { cols, rows },
      React.createElement(DocumentReader, {
        width: cols,
        height: rows,
        isActive: true,
        onClose: () => {},
        ...currentProps,
      }),
    );

  const instance = render(buildTree(props), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });

  function waitFor(pred, { timeoutMs = 4_000, label = 'condition' } = {}) {
    if (pred(latest)) return Promise.resolve(latest);
    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        listeners.delete(check);
        clearInterval(poll);
        clearTimeout(timer);
        activeTimers.delete(poll);
        activeTimers.delete(timer);
      };
      const check = () => {
        if (settled) return;
        if (pred(latest)) {
          done();
          resolveWait(latest);
        }
      };
      const poll = setInterval(check, 20);
      const timer = setTimeout(() => {
        if (settled) return;
        const snap = latest;
        done();
        rejectWait(
          new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- FRAME ---\n${snap}\n-------------`),
        );
      }, timeoutMs);
      activeTimers.add(poll);
      activeTimers.add(timer);
      listeners.add(check);
      setImmediate(check);
    });
  }

  return {
    send: (data) => stdin.write(data),
    dispatchKey: (input, key = {}) => dispatchToHub(getHub(stdin), input, key),
    rerender: (nextProps) => instance.rerender(buildTree(nextProps)),
    frame: () => latest,
    waitFor,
    unmount: () => instance.unmount(),
    cleanup() {
      for (const handle of activeTimers) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      activeTimers.clear();
      listeners.clear();
      try {
        instance.unmount();
      } catch {
        // Ignore double-unmount during teardown
      }
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function makeMockHost(handlers = {}, extra = {}) {
  const calls = [];
  const host = {
    mode: 'embedded',
    snapshot: async () => null,
    call: async (name, args) => {
      calls.push({ name, args });
      if (typeof handlers[name] === 'function') {
        try {
          const res = await handlers[name](args, calls);
          if (res && typeof res === 'object' && typeof res.ok === 'boolean') {
            return res;
          }
          return { ok: true, value: res };
        } catch (err) {
          return { ok: false, error: { code: 'MOCK_ERR', message: err?.message || String(err) } };
        }
      }
      return { ok: true, value: {} };
    },
    stream: async () => {},
    close: async () => {},
    ...extra,
  };
  return { host, calls };
}

function makeThreePageDocHandlers(overrides = {}) {
  const pages = {
    1: {
      page: 1,
      sourceId: 'src-p1',
      text: '# Chapter 1: Fundamentals\n\nAlpha theorem states that energy is conserved across closed systems.\n\nSecond paragraph on page one.',
      chars: 120,
    },
    2: {
      page: 2,
      sourceId: 'src-p2',
      text: '## Chapter 2: Applications\n\nBeta corollary applies the theorem to harmonic oscillators.',
      chars: 90,
    },
    3: {
      page: 3,
      sourceId: 'src-p3',
      text: '# Chapter 3: Summary\n\nGamma conclusion wraps up the key derivations.',
      chars: 72,
    },
  };

  return {
    'materials.document.get': async () => ({
      documentId: 'doc-phys-1',
      title: 'Classical Mechanics Notes',
      format: 'md',
      currentRevision: 'rev-1',
      sources: [
        { id: 'src-p1', text: pages[1].text, document: { page: 1 } },
        { id: 'src-p2', text: pages[2].text, document: { page: 2 } },
        { id: 'src-p3', text: pages[3].text, document: { page: 3 } },
      ],
    }),
    'source.pages': async (args) => {
      const pg = Number(args?.from ?? 1);
      const entry = pages[pg] ?? pages[1];
      return {
        documentId: 'doc-phys-1',
        title: 'Classical Mechanics Notes',
        pages: '1-3',
        shown: [entry],
      };
    },
    'materials.reading.get': async () => ({ read: [] }),
    'materials.reading.save': async (args) => ({
      saved: true,
      read: (args?.read ?? []).map((c) => c.id),
    }),
    ...overrides,
  };
}

describe('P4 (#1354 D12): DocumentReader.tsx Line-Limit Guardrail & Split Regressions', () => {
  test('1. Line-limit guardrail: DocumentReader.tsx and all split sibling modules are <= MAX_SOURCE_FILE_LINES and DocumentReader.tsx is excluded from baseline', () => {
    const baseline = loadLineLimitBaseline();
    const lineCounts = scanSourceLineCounts();

    assert.equal(
      Object.hasOwn(baseline.files, 'views/sources/DocumentReader.tsx'),
      false,
      'views/sources/DocumentReader.tsx must be removed from file-line-limit-baseline.json after splitting',
    );

    for (const relPath of DOCUMENT_READER_SPLIT_FILES) {
      assert.ok(
        Object.hasOwn(lineCounts, relPath),
        `Expected split module to exist under packages/studyhub-tui/src/: ${relPath}`,
      );
      assert.ok(
        lineCounts[relPath] <= MAX_SOURCE_FILE_LINES,
        `${relPath} must be <= ${MAX_SOURCE_FILE_LINES} lines (found ${lineCounts[relPath]})`,
      );
    }

    const result = evaluateLineLimitRatchet({
      lineCounts,
      baseline,
      maxLines: MAX_SOURCE_FILE_LINES,
    });
    assert.equal(result.ok, true, formatLineLimitReport(result));
  });

  test('2. Pure reader-model helpers: anchor slice, chapter extraction, lastReadPages LRU, translation formatting, layout, and footer hints', async () => {
    const model = await import('../src/views/sources/reader-model.ts');

    // Public export parity on DocumentReader.tsx
    assert.equal(extractPageAnchorSlice, model.extractPageAnchorSlice);

    // extractPageAnchorSlice edge cases
    assert.equal(model.extractPageAnchorSlice(''), null);
    assert.equal(model.extractPageAnchorSlice('   \n\t  '), null);
    const paraText = '  \nFirst paragraph line 1\nline 2  \n\nSecond paragraph should not be included.';
    const slice1 = model.extractPageAnchorSlice(paraText);
    assert.ok(slice1);
    assert.equal(paraText.slice(slice1.start, slice1.end), slice1.quote);
    assert.equal(slice1.quote, 'First paragraph line 1\nline 2');

    // Surrogate pair boundary safety at 240 chars
    const surrogateText = `${'a'.repeat(239)}😀tail`;
    const slice2 = model.extractPageAnchorSlice(surrogateText);
    assert.ok(slice2);
    assert.equal(slice2.end, 239);
    assert.equal(slice2.quote, 'a'.repeat(239));

    // extractChaptersFromDocument: AI outline > Markdown headings (ignoring fenced code) > document.chapter
    const aiChapters = model.extractChaptersFromDocument(
      {
        sources: [
          { id: 's1', document: { page: 1 } },
          { id: 's2', document: { page: 4 } },
        ],
        outline: {
          entries: [
            { title: 'Intro', level: 1, anchor: { sourceId: 's1' } },
            { title: 'Deep Dive', level: 1, anchor: { sourceId: 's2' } },
          ],
        },
      },
      6,
      'en',
    );
    assert.deepEqual(
      aiChapters.map((c) => [c.id, c.startPage, c.endPage]),
      [
        ['ai-0', 1, 3],
        ['ai-1', 4, 6],
      ],
    );

    const mdChapters = model.extractChaptersFromDocument(
      {
        sources: [
          { id: 's1', text: '```md\n# Fake Fenced Heading\n```\n# Real Heading 1', document: { page: 1 } },
          { id: 's2', text: '## Sub Heading', document: { page: 2 } },
        ],
      },
      3,
      'zh',
    );
    assert.equal(mdChapters.length, 2);
    assert.equal(mdChapters[0].title, 'Real Heading 1');
    assert.equal(mdChapters[0].endPage, 3);
    assert.equal(mdChapters[1].title, 'Sub Heading');
    assert.equal(mdChapters[1].startPage, 2);

    const bookChapters = model.extractChaptersFromDocument(
      {
        sources: [
          { id: 's0', document: { page: 1 } },
          { id: 's1', document: { page: 2, chapter: { index: 1, title: 'Kinematics', level: 1 } } },
          { id: 's2', document: { page: 3, chapter: { index: 1, title: 'Kinematics', level: 1 } } },
        ],
      },
      3,
      'en',
    );
    assert.deepEqual(
      bookChapters.map((c) => [c.id, c.title, c.startPage, c.endPage]),
      [
        ['chapter-front', 'Front Matter', 1, 1],
        ['chapter-1', 'Kinematics', 2, 3],
      ],
    );

    // parsePageRange & lastReadPages LRU cap
    assert.deepEqual(model.parsePageRange('2-15', 1), { first: 2, last: 15 });
    assert.deepEqual(model.parsePageRange(undefined, 4), { first: 1, last: 4 });
    const seedPages = {};
    for (let i = 1; i <= MAX_LAST_READ_PAGES + 5; i += 1) {
      seedPages[`doc-${i}`] = i;
    }
    const updated = model.buildUpdatedLastReadPages(seedPages, 'doc-1', 9);
    const keys = Object.keys(updated);
    assert.equal(keys.length, MAX_LAST_READ_PAGES);
    assert.equal(keys[keys.length - 1], 'doc-1');
    assert.equal(updated['doc-1'], 9);

    // Translation helpers
    assert.equal(model.formatEstimateRange({ low: 100, high: 250 }), '100-250');
    assert.equal(model.formatEstimateRange({ low: 120, high: 120 }), '120');
    assert.equal(
      model.resolveEstimateTokensText({ inputTokens: { low: 50, high: 80 }, outputTokens: { low: 30, high: 40 } }),
      '80-120',
    );
    const formattedAscii = model.formatTranslationEntries(
      [{ quote: 'Hello', text: '你好', outdated: true, warnings: ['glossary'] }],
      'zh',
      true,
    );
    assert.ok(formattedAscii.includes('> Hello'));
    assert.ok(formattedAscii.includes('[! glossary]'));
    assert.equal(formattedAscii.includes('⚠'), false);

    // Layout metrics wide vs narrow
    const wideLayout = model.computeReaderLayout({ width: 112, height: 30, subMode: 'ask-view', isTyping: false });
    assert.equal(wideLayout.showSide, true);
    assert.equal(wideLayout.showBottom, false);
    const narrowLayout = model.computeReaderLayout({ width: 76, height: 24, subMode: 'translate-view', isTyping: false });
    assert.equal(narrowLayout.showSide, false);
    assert.equal(narrowLayout.showBottom, true);

    // computeScrollAnchorExcerpt at top vs scrolled
    assert.deepEqual(model.computeScrollAnchorExcerpt('Hello world', 0, 'read', 100), {});
    const longText = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: energy conservation in system ${i + 1}.`).join('\n');
    const scrolled = model.computeScrollAnchorExcerpt(longText, 5, 'ask-view', 112);
    assert.equal(typeof scrolled.anchorOffset, 'number');
    assert.ok(scrolled.anchorOffset > 0);
    assert.ok(typeof scrolled.selectedExcerpt === 'string' && scrolled.selectedExcerpt.length > 0);
    assert.equal(longText.slice(scrolled.anchorOffset, scrolled.anchorOffset + scrolled.selectedExcerpt.length), scrolled.selectedExcerpt);
  });

  test('3. Pagination [/], jump clamping [g], math toggle [m], search jump [/], and source.get fallback', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true, mathUnicode: true });
    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'source.search': async () => ({
          matches: [{ id: 'src-p3', page: 3, snippet: 'Gamma conclusion wraps up' }],
        }),
      }),
    );

    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      initialTitle: 'Classical Mechanics Notes',
      initialFormat: 'md',
      totalPagesHint: 3,
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem') && s.includes('P. 1 / 3'), { label: 'page 1 loaded' });
    assert.equal(m.frame().match(UNICODE_UI_CHROME_RE), null, 'ASCII mode frame must contain zero unicode chrome');

    // Next page ]
    m.send(']');
    await m.waitFor((s) => s.includes('Beta corollary') && s.includes('P. 2 / 3'), { label: 'page 2 loaded via ]' });

    // Prev page [
    m.send('[');
    await m.waitFor((s) => s.includes('Alpha theorem') && s.includes('P. 1 / 3'), { label: 'page 1 loaded via [' });

    // Toggle math m: Unicode -> TeX
    m.send('m');
    await m.waitFor((s) => s.includes('TeX'), { label: 'math mode toggled to TeX' });
    assert.equal(useTuiStore.getState().preferences.mathUnicode, false);

    // Jump page g with out-of-range value clamps to lastPage (3)
    m.send('g');
    await m.waitFor((s) => s.includes('Go to page:'), { label: 'jump input bar opened' });
    m.send('99');
    await m.waitFor((s) => s.includes('99'), { label: 'jump digits typed' });
    m.send('\r');
    await m.waitFor((s) => s.includes('Gamma conclusion') && s.includes('P. 3 / 3'), { label: 'clamped jump to page 3' });

    // Search / jumps to hit page (already 3, test jumping back to 2 then searching)
    m.send('[');
    await m.waitFor((s) => s.includes('P. 2 / 3'), { label: 'back to page 2 before search' });
    m.send('/');
    await m.waitFor((s) => s.includes('Search document:'), { label: 'search bar opened' });
    m.send('Gamma');
    await m.waitFor((s) => s.includes('Search document: Gamma'), { label: 'search query typed' });
    m.send('\r');
    await m.waitFor((s) => s.includes('Gamma conclusion') && s.includes('? Gamma (1)'), {
      label: 'search jumped to page 3 and displayed hit count',
    });
    assert.ok(calls.some((c) => c.name === 'source.search' && c.args?.query === 'Gamma'));

    m.cleanup();

    // Single-source fallback via source.get when source.pages fails
    resetTuiStore({ language: 'en', asciiMode: true });
    const fb = makeMockHost({
      'materials.document.get': async () => {
        throw new Error('not a paged document');
      },
      'source.pages': async () => {
        throw new Error('no pages');
      },
      'source.get': async () => ({
        id: 'src-single',
        title: 'Standalone Note',
        text: 'Fallback body content loaded via source.get.',
        chars: 44,
      }),
    });
    const m2 = mountDocumentReader({
      host: fb.host,
      sourceId: 'src-single',
      initialTitle: 'Standalone Note',
      initialFormat: 'text',
    });
    t.after(() => m2.cleanup());
    await m2.waitFor((s) => s.includes('Fallback body content loaded via source.get.'), {
      label: 'source.get fallback rendered',
    });
  });

  test('4. lastReadPages automatic resume, explicit initialPage override, and immediate flush on Esc close', async (t) => {
    const dshHome = await makeTempDir('resume');
    resetTuiStore({
      language: 'en',
      asciiMode: true,
      lastReadPages: { 'doc-phys-1': 3 },
    });

    let closed = false;
    const { host } = makeMockHost(makeThreePageDocHandlers(), { dshHome });
    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
      onClose: () => {
        closed = true;
      },
    });
    t.after(() => m.cleanup());

    // Automatically resumes at page 3 when initialPage is 1
    await m.waitFor((s) => s.includes('Gamma conclusion') && s.includes('P. 3 / 3'), {
      label: 'resumed at saved page 3',
    });
    assert.ok(
      useTuiStore.getState().toasts.some((toast) => toast.text.includes('Resumed at page 3')),
      'Resume should emit info toast',
    );

    // Navigate to page 2, then press Esc immediately (before 400ms debounce) -> must flush synchronously to prefs
    m.send('[');
    await m.waitFor((s) => s.includes('Beta corollary') && s.includes('P. 2 / 3'), {
      label: 'navigated to page 2 before Esc flush',
    });
    m.send('\x1b');
    await m.waitFor(() => closed, { label: 'reader closed on Esc' });
    assert.equal(useTuiStore.getState().preferences.lastReadPages?.['doc-phys-1'], 2);

    // Wait briefly for fire-and-forget saveTuiPreferences disk write to settle
    const diskDeadline = Date.now() + 2_000;
    let savedOnDisk = null;
    while (Date.now() < diskDeadline) {
      const prefs = await loadTuiPreferences({ env: { DSH_HOME: dshHome } });
      if (prefs.lastReadPages?.['doc-phys-1'] === 2) {
        savedOnDisk = prefs.lastReadPages['doc-phys-1'];
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(savedOnDisk, 2, 'Esc close must flush pending lastReadPages to disk');
    m.cleanup();

    // Explicit initialPage > 1 must override saved lastReadPages
    resetTuiStore({
      language: 'en',
      asciiMode: true,
      lastReadPages: { 'doc-phys-1': 3 },
    });
    const m2 = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 2,
      totalPagesHint: 3,
    });
    t.after(() => m2.cleanup());
    await m2.waitFor((s) => s.includes('Beta corollary') && s.includes('P. 2 / 3'), {
      label: 'explicit initialPage=2 preserved over saved page 3',
    });
  });

  test('5. Chapter read toggle [M]: optimistic success, unread toggle, and rollback on backend failure', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    let failNextSave = false;
    const savedPayloads = [];
    const { host } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.reading.save': async (args) => {
          savedPayloads.push(args);
          if (failNextSave) {
            return { saved: false };
          }
          const readIds = new Set((args?.read ?? []).map((c) => c.id));
          return { saved: true, read: [...readIds] };
        },
      }),
    );

    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('OK 0/3 (Unread)'), { label: 'initial 0/3 unread badge' });

    // Mark current chapter read
    m.send('M');
    await m.waitFor(
      (s) => s.includes('OK 1/3 (Read)') && useTuiStore.getState().toasts.some((toast) => toast.tone === 'success'),
      { label: 'chapter marked read -> 1/3 and backend save settled' },
    );
    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0].read.length, 1);

    // Next save fails -> must roll back from 0/3 back to 1/3 and notify error
    failNextSave = true;
    m.send('M');
    await m.waitFor(
      () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'error'),
      { label: 'error toast on failed reading.save' },
    );
    await m.waitFor((s) => s.includes('OK 1/3 (Read)'), { label: 'rolled back to 1/3 (Read)' });
  });

  test('6. Ask-AI [a]: streaming + Esc abort, fallback selection.ask, save note [s], and save flashcard [f] with revision resolve', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    const streamHold = deferred();
    let streamAborted = false;

    const streamingHost = makeMockHost(makeThreePageDocHandlers(), {
      streamComplete: async (params) => {
        params?.onChunk?.('Partial answer token');
        params?.signal?.addEventListener('abort', () => {
          streamAborted = true;
          streamHold.resolve('aborted');
        });
        await streamHold.promise;
        return 'Partial answer token';
      },
    });

    const m1 = mountDocumentReader({
      host: streamingHost.host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
    });
    t.after(() => m1.cleanup());

    await m1.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 ready for Ask-AI stream' });
    m1.send('a');
    await m1.waitFor((s) => s.includes('Ask AI about this page:'), { label: 'Ask input opened' });
    m1.send('Explain alpha');
    await m1.waitFor((s) => s.includes('Ask AI about this page: Explain alpha'), { label: 'Ask question typed' });
    m1.send('\r');
    await m1.waitFor((s) => s.includes('Partial answer token'), { label: 'streamed partial AI answer shown' });

    // Esc aborts in-flight stream and returns to read mode
    m1.send('\x1b');
    await m1.waitFor((s) => !s.includes('AI Answer') && streamAborted, {
      label: 'Esc aborted AI stream and closed AI panel',
    });
    m1.cleanup();

    // Non-streaming fallback + save-to-card (missing revision triggers materials.selection.resolve)
    resetTuiStore({ language: 'en', asciiMode: true });
    let snapshotRefreshed = false;
    const fallback = makeMockHost(
      makeThreePageDocHandlers({
        'materials.document.get': async () => ({
          documentId: 'doc-phys-1',
          title: 'Classical Mechanics Notes',
          format: 'md',
          sources: [{ id: 'src-p1', text: '# Chapter 1\n\nAlpha theorem body.', document: { page: 1 } }],
        }),
        'materials.selection.ask': async () => ({
          answer: 'Energy conservation holds when the Lagrangian has no explicit time dependence.',
        }),
        'materials.selection.resolve': async (args) => ({
          status: 'resolved',
          selection: { ...args, revision: 'rev-resolved-9' },
        }),
        'generation.selection.saveAnswer': async () => ({
          status: 'complete',
          deckId: 'deck-1',
          cardId: 'card-1',
        }),
        snapshot: async () => {
          snapshotRefreshed = true;
          return { decks: [], sources: [], courses: [], jobs: [] };
        },
      }),
    );

    const m2 = mountDocumentReader({
      host: fallback.host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
    });
    t.after(() => m2.cleanup());

    await m2.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 loaded for fallback ask' });
    m2.send('a');
    await m2.waitFor((s) => s.includes('Ask AI about this page:'), { label: 'Ask input opened (fallback)' });
    m2.send('Why conserved?');
    await m2.waitFor((s) => s.includes('Ask AI about this page: Why conserved?'), { label: 'Fallback question typed' });
    m2.send('\r');
    await m2.waitFor((s) => s.includes('Lagrangian has no explicit time dependence'), {
      label: 'fallback selection.ask answer rendered',
    });

    // Press f to save flashcard -> resolves revision and marks Card saved
    m2.send('f');
    await m2.waitFor((s) => s.includes('Card saved'), { label: 'flashcard saved indicator shown' });
    assert.equal(snapshotRefreshed, true, 'Saving flashcard must refresh store snapshot');
    const saveCall = fallback.calls.find((c) => c.name === 'generation.selection.saveAnswer');
    assert.ok(saveCall, 'generation.selection.saveAnswer must be called');
    assert.equal(saveCall.args?.selection?.revision, 'rev-resolved-9');
  });

  test('7. Bilingual translation [t]: cache-hit, P2 ConfirmDialog quota guard, confirm -> L/R, Esc cancel, and page-change race guard', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    let listShouldReturnCache = true;
    const translateHold = deferred();
    let holdTranslate = false;

    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.translation.list': async (args) => {
          if (listShouldReturnCache && args?.target === 'en') {
            return {
              target: 'en',
              items: [
                {
                  sourceId: 'src-p1',
                  quote: 'Alpha theorem',
                  text: 'Cached English translation of Alpha theorem.',
                },
              ],
            };
          }
          return { target: args?.target ?? 'en', items: [] };
        },
        'materials.translation.translate': async (args) => {
          if (args?.estimate) {
            return {
              status: 'estimate',
              target: args.target,
              counts: { passages: 2, toTranslate: 2, cached: 0, reused: 0 },
              estimate: { calls: 1, totalTokens: { low: 120, high: 180 } },
              modelAvailable: true,
            };
          }
          if (holdTranslate) {
            await translateHold.promise;
          }
          return {
            status: 'done',
            target: args.target,
            counts: { passages: 1, translated: 1, cached: 0, reused: 0 },
            results: [
              {
                sourceId: args.scope?.sourceIds?.[0],
                status: 'done',
                item: {
                  quote: 'Alpha theorem',
                  text: args.target === 'zh' ? '阿尔法定理中文译文。' : 'Fresh English retranslation.',
                },
              },
            ],
          };
        },
        'materials.translation.cancel': async () => ({ cancelled: true }),
      }),
    );

    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 ready for translation' });

    // 1) Cache hit opens bilingual pane with ZERO translate calls
    m.send('t');
    await m.waitFor((s) => s.includes('Cached English translation of Alpha theorem') && s.includes('Cached 1 passages'), {
      label: 'cached translation opened without LLM call',
    });
    assert.equal(
      calls.filter((c) => c.name === 'materials.translation.translate').length,
      0,
      'Cache hit must not call materials.translation.translate',
    );

    // 2) Switch language L -> zh (cache miss -> estimate -> ConfirmDialog, NO paid translate call yet)
    listShouldReturnCache = false;
    m.send('L');
    await m.waitFor((s) => s.includes('Confirm Page Translation') && s.includes('120-180'), {
      label: 'ConfirmDialog quota guard opened for zh translation',
    });
    assert.equal(
      calls.filter((c) => c.name === 'materials.translation.translate' && !c.args?.estimate).length,
      0,
      'Paid translation must wait for ConfirmDialog confirmation',
    );

    // Confirm with Enter -> runs paid translation with target 'zh'
    m.send('\r');
    await m.waitFor((s) => s.includes('阿尔法定理中文译文') && s.includes('Translated 1 passages'), {
      label: 'confirmed zh translation rendered',
    });
    const paidCall = calls.find((c) => c.name === 'materials.translation.translate' && !c.args?.estimate);
    assert.equal(paidCall?.args?.target, 'zh');

    // 3) Retranslate R -> hold in-flight -> Esc aborts and calls materials.translation.cancel
    holdTranslate = true;
    m.send('R');
    await m.waitFor((s) => s.includes('Confirm Page Retranslation'), { label: 'ConfirmDialog for retranslate' });
    m.send('\r');
    await m.waitFor((s) => s.includes('Translating current page...'), { label: 'in-flight retranslation spinner' });
    m.send('\x1b');
    await m.waitFor(
      () => calls.some((c) => c.name === 'materials.translation.cancel' && typeof c.args?.requestId === 'string'),
      { label: 'materials.translation.cancel invoked on Esc' },
    );
    // Late resolution of aborted request must not reopen translate pane
    translateHold.resolve();
    await m.waitFor((s) => !s.includes('Bilingual Translation'), { label: 'aborted translation stays closed' });
  });

  test('8. Linked-card practice [p], generate navigation [Q], and narrow bottom-split layout', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    let linkedCards = [{ deckId: 'd-phys', cardId: 'c-phys-1' }];
    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.pages.cards': async () => ({ cards: linkedCards }),
        'review.start': async () => ({ id: 'run-linked-42', total: 1, index: 0, card: { id: 'c-phys-1' } }),
        'materials.translation.list': async () => ({
          target: 'en',
          items: [{ sourceId: 'src-p1', quote: 'Alpha', text: 'Narrow pane translation text.' }],
        }),
      }),
    );

    const m = mountDocumentReader(
      {
        host,
        documentId: 'doc-phys-1',
        sourceId: 'src-p1',
        initialPage: 1,
        initialCourse: 'Physics 101',
        totalPagesHint: 3,
      },
      { cols: 76, rows: 24 },
    );
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'narrow reader loaded' });

    // Open cached translation on narrow viewport -> stacks bottom panel cleanly
    m.send('t');
    await m.waitFor((s) => s.includes('Narrow pane translation text.'), {
      label: 'narrow bottom translation panel rendered',
    });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('Narrow pane translation text.'), { label: 'closed translation panel' });

    // [Q] navigates to generate with sourceIds & course
    m.send('Q');
    await m.waitFor(() => useTuiStore.getState().page === 'generate', { label: 'navigated to generate' });
    assert.deepEqual(useTuiStore.getState().navContext, { sourceIds: ['src-p1'], course: 'Physics 101' });

    // [p] fetches linked cards and starts review run
    useTuiStore.setState({ page: 'sources', navContext: {} });
    m.send('p');
    await m.waitFor(() => useTuiStore.getState().page === 'review', { label: 'navigated to review from linked cards' });
    assert.equal(useTuiStore.getState().navContext?.runId, 'run-linked-42');
    assert.ok(calls.some((c) => c.name === 'materials.pages.cards'));

    // When no linked cards exist, [p] emits info toast without navigating
    linkedCards = [];
    useTuiStore.setState({ page: 'sources', navContext: {}, toasts: [] });
    m.send('p');
    await m.waitFor(
      () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('No cards linked')),
      { label: 'info toast when no linked cards' },
    );
    assert.equal(useTuiStore.getState().page, 'sources');
  });

  test('9. Translation edge cases: page-change race guard drops stale estimate, zero-toTranslate reused/skipped branches, and unavailable model', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    const staleEstimateHold = deferred();
    let mode = 'stale-race';

    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.translation.list': async () => ({ target: 'en', items: [] }),
        'materials.translation.translate': async (args) => {
          if (mode === 'stale-race' && args?.estimate) {
            await staleEstimateHold.promise;
            return {
              status: 'estimate',
              target: 'en',
              counts: { passages: 1, toTranslate: 1 },
              estimate: { calls: 1, totalTokens: 100 },
              modelAvailable: true,
            };
          }
          if (mode === 'skipped' && args?.estimate) {
            return {
              status: 'estimate',
              target: 'en',
              counts: { passages: 1, toTranslate: 0, skipped: 1 },
            };
          }
          if (mode === 'reused') {
            if (args?.estimate) {
              return {
                status: 'estimate',
                target: 'en',
                counts: { passages: 1, toTranslate: 0, reused: 1 },
              };
            }
            return {
              status: 'done',
              target: 'en',
              counts: { passages: 1, translated: 0, reused: 1 },
              results: [
                {
                  sourceId: 'src-p2',
                  status: 'done',
                  item: { quote: 'Beta', text: 'Reused Beta translation.', reused: true },
                },
              ],
            };
          }
          if (mode === 'unavailable') {
            if (args?.estimate) {
              return {
                status: 'estimate',
                target: 'en',
                counts: { passages: 1, toTranslate: 1 },
                estimate: { calls: 1, totalTokens: 80 },
                modelAvailable: false,
              };
            }
            return {
              status: 'unavailable',
              target: 'en',
              message: 'Translation model offline.',
            };
          }
          return { status: 'done', target: 'en', counts: {}, results: [] };
        },
      }),
    );

    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem') && s.includes('P. 1 / 3'), { label: 'page 1 loaded' });

    // Start estimate on page 1, switch to page 2 while estimate is in-flight, then resolve stale estimate
    m.send('t');
    await m.waitFor(
      () => calls.some((c) => c.name === 'materials.translation.translate' && c.args?.estimate === true),
      { label: 'page 1 estimate request in-flight' },
    );
    m.send(']');
    await m.waitFor((s) => s.includes('Beta corollary') && s.includes('P. 2 / 3'), { label: 'switched to page 2' });
    staleEstimateHold.resolve();
    // Trigger an unrelated synchronous state change (math toggle) so React + Ink commit after the resolved promise
    m.send('m');
    await m.waitFor((s) => s.includes('TeX'), { label: 'post-resolve render flushed' });
    assert.equal(
      m.frame().includes('Confirm Page Translation'),
      false,
      'Stale page 1 estimate must not open ConfirmDialog after switching to page 2',
    );

    // Zero-toTranslate with skipped > 0 shows already-in-target message without ConfirmDialog
    mode = 'skipped';
    m.send('t');
    await m.waitFor((s) => s.includes('already in the target language'), { label: 'skipped translation message' });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('already in the target language'), { label: 'closed skipped translation pane' });

    // Zero-toTranslate with reused > 0 auto-loads reused translation without ConfirmDialog
    mode = 'reused';
    m.send('t');
    await m.waitFor((s) => s.includes('Reused Beta translation.') && s.includes('[reused]'), {
      label: 'auto-loaded reused translation without ConfirmDialog',
    });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('Reused Beta translation.'), { label: 'closed reused translation pane' });

    // Unavailable model warning in ConfirmDialog -> unavailable status message after confirm
    mode = 'unavailable';
    m.send('t');
    await m.waitFor((s) => s.includes('No model configured; execution may fail.'), {
      label: 'ConfirmDialog shows unavailable model warning',
    });
    m.send('\r');
    await m.waitFor((s) => s.includes('Translation model offline.'), {
      label: 'unavailable translation status rendered',
    });
  });

  test('10. Ask-AI save-to-note [s], duplicate flashcard [f], and lazy Outline drawer [O] page jump', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.selection.ask': async () => ({
          answer: 'Alpha theorem follows directly from time-translation symmetry.',
        }),
        'materials.pages.cards': async () => ({ cards: [{ deckId: 'd-phys', cardId: 'c-phys-1' }] }),
        'note.qa.save': async (args) => ({
          item: { id: 'fu-1', question: args?.question, answer: args?.answer },
          note: { id: 'note-new-1', title: args?.title ?? 'Classical Mechanics Notes' },
        }),
        'materials.annotation.add': async () => ({ id: 'ann-1' }),
        'generation.selection.saveAnswer': async () => ({ status: 'duplicate' }),
      }),
    );

    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 ready' });
    m.send('a');
    await m.waitFor((s) => s.includes('Ask AI about this page:'), { label: 'ask bar open' });
    m.send('Symmetry?');
    await m.waitFor((s) => s.includes('Ask AI about this page: Symmetry?'), { label: 'question typed' });
    m.send('\r');
    await m.waitFor((s) => s.includes('time-translation symmetry'), { label: 'ask answer rendered' });

    // Press s -> dynamically loads savePageAskToNote and persists Q&A via note.qa.save / annotation
    m.send('s');
    await m.waitFor(
      () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'success'),
      { label: 'savePageAskToNote finished with success toast' },
    );
    const qaSaveCall = calls.find((c) => c.name === 'note.qa.save');
    assert.ok(qaSaveCall, 'Pressing [s] must invoke note.qa.save for linked page card');
    assert.equal(qaSaveCall.args?.question, 'Symmetry?');

    // Press f -> duplicate status sets Card saved and emits info toast
    m.send('f');
    await m.waitFor(
      (s) => s.includes('Card saved') && useTuiStore.getState().toasts.some((toast) => toast.text.includes('already exists')),
      { label: 'duplicate flashcard handled gracefully' },
    );

    // Return to read mode and open lazy Outline drawer [O]
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('AI Answer'), { label: 'closed AI panel' });
    m.send('O');
    await m.waitFor((s) => s.includes('Document Outline') && s.includes('Chapter 2: Applications'), {
      label: 'lazy ReaderOutlineDrawer opened with chapters',
    });
    // Move down to Chapter 2 and press Enter to jump to page 2
    m.send('j');
    await m.waitFor((s) => />\s+\[.\]\s+Chapter 2: Applications/.test(s), { label: 'outline cursor moved to Chapter 2' });
    m.send('\r');
    await m.waitFor((s) => s.includes('Beta corollary') && s.includes('P. 2 / 3') && !s.includes('Document Outline'), {
      label: 'outline drawer jumped to page 2 and closed',
    });
  });

  test('11. Cross-document switch isolation: concurrent document.get, reading.save, search, and translation from Doc A never leak into Doc B', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    const saveAHold = deferred();
    const searchAHold = deferred();
    const searchAReplied = deferred();
    const translateAHold = deferred();

    const { host, calls } = makeMockHost({
      'materials.document.get': async (args) => {
        if (args?.documentId === 'doc-a') {
          return {
            documentId: 'doc-a',
            title: 'Doc A',
            format: 'md',
            sources: [
              { id: 'src-a1', text: '# Ch A1\n\nBody A1 content', document: { page: 1 } },
              { id: 'src-a2', text: '# Ch A2\n\nBody A2 content', document: { page: 2 } },
            ],
          };
        }
        return {
          documentId: 'doc-b',
          title: 'Doc B',
          format: 'md',
          sources: [
            { id: 'src-b1', text: '# Ch B1\n\nBody B1 content', document: { page: 1 } },
            { id: 'src-b2', text: '# Ch B2\n\nBody B2 content', document: { page: 2 } },
          ],
        };
      },
      'source.pages': async (args) => {
        const pg = Number(args?.from ?? 1);
        if (args?.documentId === 'doc-a') {
          return {
            documentId: 'doc-a',
            title: 'Doc A',
            pages: '1-2',
            shown: [{ page: pg, sourceId: `src-a${pg}`, text: `# Ch A${pg}\n\nBody A${pg} content`, chars: 24 }],
          };
        }
        return {
          documentId: 'doc-b',
          title: 'Doc B',
          pages: '1-2',
          shown: [{ page: pg, sourceId: `src-b${pg}`, text: `# Ch B${pg}\n\nBody B${pg} content`, chars: 24 }],
        };
      },
      'materials.reading.get': async (args) => ({
        read: args?.documentId === 'doc-b' ? ['md-2-1'] : [],
      }),
      'materials.reading.save': async (args) => {
        if (args?.documentId === 'doc-a') {
          await saveAHold.promise;
          return { saved: true, read: ['md-1-1'] };
        }
        return { saved: true, read: ['md-1-1', 'md-2-1'] };
      },
      'source.search': async () => {
        await searchAHold.promise;
        searchAReplied.resolve();
        return { matches: [{ id: 'src-a2', page: 2, snippet: 'hit' }] };
      },
      'materials.translation.list': async () => ({ target: 'en', items: [] }),
      'materials.translation.translate': async (args) => {
        if (args?.estimate) {
          return {
            status: 'estimate',
            target: 'en',
            counts: { passages: 1, toTranslate: 1 },
            estimate: { calls: 1, totalTokens: 60 },
            modelAvailable: true,
          };
        }
        await translateAHold.promise;
        return {
          status: 'done',
          target: 'en',
          counts: { passages: 1, translated: 1 },
          results: [{ sourceId: 'src-a1', status: 'done', item: { quote: 'Body A1', text: 'STALE DOC A TRANSLATION' } }],
        };
      },
      'materials.translation.cancel': async () => ({ cancelled: true }),
    });

    const m = mountDocumentReader({
      host,
      documentId: 'doc-a',
      sourceId: 'src-a1',
      initialPage: 1,
      initialTitle: 'Doc A',
      totalPagesHint: 2,
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Body A1 content') && s.includes('OK 0/2 (Unread)'), {
      label: 'Doc A loaded',
    });

    // Trigger reading.save, search, and confirmed translation simultaneously on Doc A
    m.send('M');
    await m.waitFor((s) => s.includes('OK 1/2 (Read)'), { label: 'Doc A optimistic chapter read' });
    m.send('/');
    await m.waitFor((s) => s.includes('Search document:'), { label: 'Doc A search bar opened' });
    m.send('hit');
    await m.waitFor((s) => s.includes('Search document: hit'), { label: 'Doc A search query typed' });
    m.send('\r');
    await m.waitFor(() => calls.some((c) => c.name === 'source.search'), { label: 'Doc A search in-flight' });
    m.send('t');
    await m.waitFor((s) => s.includes('Confirm Page Translation'), { label: 'Doc A translate confirm' });
    m.send('\r');
    await m.waitFor(
      () => calls.some((c) => c.name === 'materials.translation.translate' && !c.args?.estimate),
      { label: 'Doc A paid translation in-flight' },
    );

    // Switch props from Doc A to Doc B while all 3 Doc A RPCs are still in-flight
    m.rerender({
      host,
      documentId: 'doc-b',
      sourceId: 'src-b1',
      initialPage: 1,
      initialTitle: 'Doc B',
      totalPagesHint: 2,
    });
    await m.waitFor((s) => s.includes('Body B1 content') && s.includes('OK 1/2 (Unread)'), {
      label: 'Doc B loaded cleanly',
    });
    assert.equal(m.frame().includes('? hit'), false, 'Doc A activeSearch must be cleared on document switch');
    assert.ok(
      calls.some((c) => c.name === 'materials.translation.cancel'),
      'Switching documents must cancel Doc A in-flight translation',
    );

    // Doc B must NOT be blocked by Doc A's in-flight reading.save
    m.send('M');
    await m.waitFor((s) => s.includes('OK 2/2 (Read)'), { label: 'Doc B chapter read succeeded immediately' });
    assert.ok(calls.some((c) => c.name === 'materials.reading.save' && c.args?.documentId === 'doc-b'));

    // Now resolve all 3 stale Doc A RPCs and flush render via math toggle
    saveAHold.resolve();
    searchAHold.resolve();
    translateAHold.resolve();
    // Let the stale search reply reach the reader before the flush: without this the flush frame can be taken before a missing guard has jumped Doc B.
    await searchAReplied.promise;
    await new Promise((resolve) => setImmediate(resolve));
    m.send('m');
    await m.waitFor((s) => s.includes('TeX'), { label: 'post-stale-resolution render flushed' });

    const finalFrame = m.frame();
    assert.ok(finalFrame.includes('Body B1 content') && finalFrame.includes('P. 1 / 2'), 'Doc A stale search must not jump Doc B');
    assert.ok(finalFrame.includes('OK 2/2 (Read)'), 'Doc A stale reading.save must not overwrite Doc B progress');
    assert.equal(finalFrame.includes('STALE DOC A TRANSLATION'), false, 'Doc A stale translation must not render on Doc B');
    m.cleanup();

    // Cancelled materials.document.get from Doc A must not call source.pages or poison Doc B's lastReadPages key
    resetTuiStore({ language: 'en', asciiMode: true });
    const docAGetHold = deferred();
    const loadCalls = [];
    const { host: host2 } = makeMockHost({
      'materials.document.get': async (args) => {
        loadCalls.push({ name: 'materials.document.get', sourceId: args?.sourceId });
        if (args?.sourceId === 'src-a1') {
          await docAGetHold.promise;
          return { title: 'Doc A', format: 'md', sources: [{ id: 'src-a1', document: { page: 1 } }] };
        }
        return {
          title: 'Doc B',
          format: 'md',
          sources: [
            { id: 'src-b1', document: { page: 1 } },
            { id: 'src-b2', document: { page: 2 } },
          ],
        };
      },
      'source.pages': async (args) => {
        loadCalls.push({ name: 'source.pages', sourceId: args?.sourceId, from: args?.from });
        const pg = Number(args?.from ?? 1);
        return {
          title: args?.sourceId === 'src-a1' ? 'Doc A' : 'Doc B',
          pages: '1-2',
          shown: [{ page: pg, sourceId: args?.sourceId === 'src-a1' ? 'src-a1' : `src-b${pg}`, text: `Page ${pg} body`, chars: 12 }],
        };
      },
    });
    const m2 = mountDocumentReader({
      host: host2,
      sourceId: 'src-a1',
      initialPage: 1,
      initialTitle: 'Doc A',
      totalPagesHint: 2,
    });
    t.after(() => m2.cleanup());
    await m2.waitFor(() => loadCalls.some((c) => c.name === 'materials.document.get' && c.sourceId === 'src-a1'), {
      label: 'Doc A document.get started',
    });
    m2.rerender({ host: host2, sourceId: 'src-b1', initialPage: 1, initialTitle: 'Doc B', totalPagesHint: 2 });
    await m2.waitFor((s) => s.includes('Page 1 body') && s.includes('Doc B'), { label: 'Doc B loaded' });
    docAGetHold.resolve();
    m2.send(']');
    await m2.waitFor((s) => s.includes('Page 2 body') && s.includes('P. 2 / 2'), { label: 'Doc B moved to page 2' });
    m2.send('\x1b');
    await m2.waitFor(() => useTuiStore.getState().preferences.lastReadPages?.['src-b1'] === 2, {
      label: 'Doc B persisted lastReadPages under src-b1',
    });
    assert.equal(
      loadCalls.some((c) => c.name === 'source.pages' && c.sourceId === 'src-a1'),
      false,
      'Cancelled Doc A document.get must not issue wasted source.pages call',
    );
    assert.equal(
      Object.hasOwn(useTuiStore.getState().preferences.lastReadPages ?? {}, 'src-a1'),
      false,
      'Stale Doc A document.get must not poison Doc B lastReadPages key',
    );
  });

  test('12. Unmount/Esc guard for linked-card practice [p] and multi-slice readWholePage stitching + incomplete notice', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    const cardsHold = deferred();
    let reviewStartCalled = false;
    let closed = false;
    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.pages.cards': async () => {
          await cardsHold.promise;
          return { cards: [{ deckId: 'd1', cardId: 'c1' }] };
        },
        'review.start': async () => {
          reviewStartCalled = true;
          return { id: 'run-ghost', total: 1, index: 0, card: { id: 'c1' } };
        },
      }),
    );

    const m = mountDocumentReader({
      host,
      documentId: 'doc-phys-1',
      sourceId: 'src-p1',
      initialPage: 1,
      totalPagesHint: 3,
      onClose: () => {
        closed = true;
      },
    });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 ready for practice race' });
    m.send('p');
    await m.waitFor(() => calls.some((c) => c.name === 'materials.pages.cards'), {
      label: 'materials.pages.cards in-flight',
    });
    m.send('\x1b');
    await m.waitFor(() => closed, { label: 'reader closed before linked cards resolved' });
    m.cleanup();

    cardsHold.resolve();
    // Flush microtasks + one macrotask to confirm late callback does not navigate
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(reviewStartCalled, false, 'Closed reader must not start review after Esc/unmount');
    assert.equal(useTuiStore.getState().page, 'sources', 'Closed reader must not navigate away to review');

    // Multi-slice source.pages stitching + incomplete slice notice
    resetTuiStore({ language: 'en', asciiMode: true });
    const { host: sliceHost } = makeMockHost({
      'materials.document.get': async () => ({
        documentId: 'doc-long',
        title: 'Long Page Doc',
        format: 'text',
        sources: [{ id: 'src-long-1', document: { page: 1 } }],
      }),
      'source.pages': async (args) => {
        const offset = Number(args?.offset ?? 0);
        if (offset === 0) {
          return {
            documentId: 'doc-long',
            title: 'Long Page Doc',
            pages: '1-1',
            shown: [{ page: 1, sourceId: 'src-long-1', text: 'FIRST_SLICE_MARKER ', chars: 50 }],
            next: { from: 1, offset: 19 },
          };
        }
        if (offset === 19) {
          return {
            documentId: 'doc-long',
            title: 'Long Page Doc',
            pages: '1-1',
            shown: [{ page: 1, sourceId: 'src-long-1', text: 'SECOND_SLICE_MARKER', chars: 50 }],
            next: { from: 1, offset: 38 },
          };
        }
        return { ok: false, error: { code: 'SLICE_ERR', message: 'disk timeout' } };
      },
      'materials.reading.get': async () => ({ read: [] }),
    });

    const m2 = mountDocumentReader({
      host: sliceHost,
      documentId: 'doc-long',
      sourceId: 'src-long-1',
      initialPage: 1,
      initialTitle: 'Long Page Doc',
      initialFormat: 'text',
      totalPagesHint: 1,
    });
    t.after(() => m2.cleanup());

    await m2.waitFor(
      (s) =>
        s.includes('FIRST_SLICE_MARKER') &&
        s.includes('SECOND_SLICE_MARKER') &&
        s.includes('The rest could not be read'),
      { label: 'multi-slice page stitched with incomplete notice' },
    );
  });

  test('13. Esc while a flashcard save is in flight still reports the saved card and refreshes the library, without marking a later question as saved', async (t) => {
    resetTuiStore({ language: 'en', asciiMode: true });
    const saveHold = deferred();
    let snapshotRefreshed = false;
    const { host, calls } = makeMockHost(
      makeThreePageDocHandlers({
        'materials.selection.ask': async () => ({ answer: 'Momentum is conserved when no external force acts.' }),
        'materials.selection.resolve': async (args) => ({ status: 'resolved', selection: { ...args, revision: 'rev-13' } }),
        'generation.selection.saveAnswer': async () => {
          await saveHold.promise;
          return { status: 'complete', deckId: 'deck-13', cardId: 'card-13' };
        },
        snapshot: async () => {
          snapshotRefreshed = true;
          return { decks: [], sources: [], courses: [], jobs: [] };
        },
      }),
    );
    const m = mountDocumentReader({ host, documentId: 'doc-phys-1', sourceId: 'src-p1', initialPage: 1, totalPagesHint: 3 });
    t.after(() => m.cleanup());

    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 loaded' });
    m.send('a');
    await m.waitFor((s) => s.includes('Ask AI about this page:'), { label: 'ask input opened' });
    m.send('Why conserved?');
    await m.waitFor((s) => s.includes('Ask AI about this page: Why conserved?'), { label: 'question typed' });
    m.send('\r');
    await m.waitFor((s) => s.includes('Momentum is conserved'), { label: 'answer shown' });

    const toastsBefore = useTuiStore.getState().toastHistory.length;
    m.send('f');
    await m.waitFor(() => calls.some((c) => c.name === 'generation.selection.saveAnswer'), { label: 'saveAnswer requested' });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('Momentum is conserved'), { label: 'Esc closed the answer while the save is held' });

    // A second question is asked and answered while the first save is still held; the save then lands during the second question.
    m.send('a');
    await m.waitFor((s) => s.includes('Ask AI about this page:'), { label: 'second ask input opened' });
    m.send('Next?');
    await m.waitFor((s) => s.includes('Ask AI about this page: Next?'), { label: 'second question typed' });
    m.send('\r');
    await m.waitFor((s) => s.includes('Momentum is conserved'), { label: 'second answer shown' });

    saveHold.resolve();
    await m.waitFor(
      () => useTuiStore.getState().toastHistory.slice(toastsBefore).some((item) => item.text === 'Saved as passage-linked flashcard'),
      { label: 'the written card is still reported after Esc' },
    );
    await m.waitFor(() => snapshotRefreshed, { label: 'the library snapshot is still refreshed after Esc' });
    // Flush: save the second answer as a note. Its own reply re-renders the panel after the card reply, so a leaked 已保存 mark would show by then.
    const toastsAfterCard = useTuiStore.getState().toastHistory.length;
    m.send('s');
    await m.waitFor(
      (s) => useTuiStore.getState().toastHistory.length > toastsAfterCard && s.includes('s/f/Esc') && !s.includes('Saving'),
      { label: 'note save of the second answer finished and rendered' },
    );
    assert.equal(m.frame().includes('Card saved'), false, 'the earlier save must not mark the new question as saved');
  });
});

// #1603 follow-ups to the DocumentReader split review: what Esc does to a save that is already running.
describe('#1603 DocumentReader: Esc never drops a note or card save that was already started', () => {
  const historySince = (before) => useTuiStore.getState().toastHistory.slice(before);
  const countCalls = (calls, name) => calls.filter((c) => c.name === name).length;

  async function askAndAnswer(m, question, answerNeedle) {
    m.send('a');
    await m.waitFor((s) => s.includes('Ask AI about this page:'), { label: `ask input opened for ${question}` });
    m.send(question);
    await m.waitFor((s) => s.includes(`Ask AI about this page: ${question}`), { label: `${question} typed` });
    m.send('\r');
    await m.waitFor((s) => s.includes(answerNeedle), { label: `${question} answered` });
  }

  function mountAskReader(t, overrides) {
    resetTuiStore({ language: 'en', asciiMode: true });
    const mock = makeMockHost(
      makeThreePageDocHandlers({
        'materials.selection.ask': async () => ({ answer: 'Noether links each symmetry to a conserved quantity.' }),
        'materials.selection.resolve': async (args) => ({ status: 'resolved', selection: { ...args, revision: 'rev-1603' } }),
        ...overrides,
      }),
    );
    const m = mountDocumentReader({ host: mock.host, documentId: 'doc-phys-1', sourceId: 'src-p1', initialPage: 1, totalPagesHint: 3 });
    t.after(() => m.cleanup());
    return { m, ...mock };
  }

  test('14. Esc in the same tick as s still saves the note and shows its result', async (t) => {
    const annotHold = deferred();
    const { m, calls } = mountAskReader(t, {
      'materials.annotation.save': async () => {
        await annotHold.promise;
        return { status: 'saved', id: 'ann-14' };
      },
    });
    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 loaded' });
    await askAndAnswer(m, 'Noether?', 'Noether links');

    const before = useTuiStore.getState().toastHistory.length;
    // Same tick: Esc lands before the lazily loaded note saver has even started.
    m.dispatchKey('s', {});
    m.dispatchKey('', { escape: true });
    await m.waitFor((s) => !s.includes('Noether links'), { label: 'Esc closed the answer' });
    annotHold.resolve();
    await m.waitFor(
      () => historySince(before).some((item) => item.text === 'Saved as page annotation (press B to view)'),
      { label: 'the note save started by s still finishes and reports after Esc' },
    );
    const saveCall = calls.find((c) => c.name === 'materials.annotation.save');
    assert.ok(saveCall, 'the note must still be written after Esc');
    assert.equal(saveCall.args?.nodes?.[0]?.question, 'Noether?');
  });

  test('15. A duplicate-card reply that lands after Esc is still reported, without marking the next question as saved', async (t) => {
    const saveHold = deferred();
    const { m, calls } = mountAskReader(t, {
      'generation.selection.saveAnswer': async () => {
        await saveHold.promise;
        return { status: 'duplicate' };
      },
    });
    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 loaded' });
    await askAndAnswer(m, 'First?', 'Noether links');

    const before = useTuiStore.getState().toastHistory.length;
    m.send('f');
    await m.waitFor(() => calls.some((c) => c.name === 'generation.selection.saveAnswer'), { label: 'saveAnswer held' });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('Noether links'), { label: 'Esc closed the answer while the save is held' });
    await askAndAnswer(m, 'Second?', 'Noether links');

    saveHold.resolve();
    await m.waitFor(
      () => historySince(before).some((item) => item.text === 'This Q&A flashcard already exists'),
      { label: 'the duplicate reply is still reported after Esc' },
    );
    // Flush with a note save of the second answer, so a leaked 已保存 mark would have rendered by then.
    const afterCard = useTuiStore.getState().toastHistory.length;
    m.send('s');
    await m.waitFor(
      (s) => useTuiStore.getState().toastHistory.length > afterCard && s.includes('s/f/Esc') && !s.includes('Saving'),
      { label: 'note save of the second answer finished and rendered' },
    );
    assert.equal(m.frame().includes('Card saved'), false, 'the earlier duplicate must not mark the second question as saved');
  });

  test("16. A save that finishes after Esc does not release the busy flag of the next question's save", async (t) => {
    const holds = [deferred(), deferred()];
    let saveIndex = 0;
    const { m, calls } = mountAskReader(t, {
      'generation.selection.saveAnswer': async () => {
        const hold = holds[saveIndex++];
        if (hold) await hold.promise;
        return { status: 'complete', deckId: 'deck-16', cardId: `card-16-${saveIndex}` };
      },
    });
    t.after(() => holds.forEach((h) => h.resolve()));
    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 loaded' });
    await askAndAnswer(m, 'First?', 'Noether links');

    const before = useTuiStore.getState().toastHistory.length;
    m.send('f');
    await m.waitFor(() => countCalls(calls, 'generation.selection.saveAnswer') === 1, { label: 'save A held' });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('Noether links'), { label: 'Esc closed the first answer' });
    await askAndAnswer(m, 'Second?', 'Noether links');
    m.send('f');
    await m.waitFor(() => countCalls(calls, 'generation.selection.saveAnswer') === 2, { label: 'save B held' });

    holds[0].resolve();
    await m.waitFor(
      () => historySince(before).some((item) => item.text === 'Saved as passage-linked flashcard'),
      { label: 'save A finished' },
    );
    const resolvesBefore = countCalls(calls, 'materials.selection.resolve');
    m.send('f');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(countCalls(calls, 'materials.selection.resolve'), resolvesBefore, 'f must stay blocked while save B is still running');
    assert.equal(countCalls(calls, 'generation.selection.saveAnswer'), 2, 'no second save of the same answer may start');
  });

  test('17. Esc while the passage is still being located still saves the card with the normal toast', async (t) => {
    const resolveHold = deferred();
    let snapshotRefreshed = false;
    const docHandlers = makeThreePageDocHandlers();
    const { m, calls } = mountAskReader(t, {
      // No revision on the page, so f first has to locate the passage (materials.selection.resolve).
      'materials.document.get': async (args) => {
        const { currentRevision: _omit, ...doc } = await docHandlers['materials.document.get'](args);
        return doc;
      },
      'materials.selection.resolve': async (args) => {
        await resolveHold.promise;
        return { status: 'resolved', selection: { ...args, revision: 'rev-17' } };
      },
      'generation.selection.saveAnswer': async () => ({ status: 'complete', deckId: 'deck-17', cardId: 'card-17' }),
      snapshot: async () => {
        snapshotRefreshed = true;
        return { decks: [], sources: [], courses: [], jobs: [] };
      },
    });
    t.after(() => resolveHold.resolve());
    await m.waitFor((s) => s.includes('Alpha theorem'), { label: 'page 1 loaded' });
    await askAndAnswer(m, 'Locate?', 'Noether links');

    const before = useTuiStore.getState().toastHistory.length;
    m.send('f');
    await m.waitFor(() => calls.some((c) => c.name === 'materials.selection.resolve'), { label: 'resolve held' });
    m.send('\x1b');
    await m.waitFor((s) => !s.includes('Noether links'), { label: 'Esc closed the answer while resolve is held' });
    resolveHold.resolve();
    await m.waitFor(
      () => historySince(before).some((item) => item.text === 'Saved as passage-linked flashcard'),
      { label: 'the card started by f is still saved and reported after Esc' },
    );
    const saveCall = calls.find((c) => c.name === 'generation.selection.saveAnswer');
    assert.ok(saveCall, 'f must not be silently dropped by Esc');
    assert.equal(saveCall.args?.question, 'Locate?');
    assert.equal(saveCall.args?.selection?.revision, 'rev-17');
    assert.equal(snapshotRefreshed, true, 'the library is refreshed after the save');
  });
});
