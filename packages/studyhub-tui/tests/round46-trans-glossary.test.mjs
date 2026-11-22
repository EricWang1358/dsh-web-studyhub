// Round 46 Translation Glossary & Saved Translations Modal E2E & Host Integration:
// `node --test tests/round46-trans-glossary.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round46-trans-glossary-${label}-`));
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

describe('StudyHub TUI Round 46 Translation Glossary & Saved Translations', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
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

  async function mountApp({ initialPage = 'sources', asciiMode = false, language = 'zh' } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(120, 36);
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

  test('1) Host integration: glossary.get -> glossary.set -> translation.list -> translation.save/delete -> clear glossary', async () => {
    const mdPath = join(boxDir, 'r46-host-glossary.md');
    await writeFile(
      mdPath,
      [
        '# Spaced Repetition Notes',
        '',
        'FSRS schedules memory intervals using stability and difficulty.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R46 Host Glossary Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;

    const get0 = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(get0.ok, true);
    assert.deepEqual(get0.value.glossary, []);

    const set1 = await host.call('materials.translation.glossary.set', {
      documentId: docId,
      glossary: [{ term: 'FSRS', to: '间隔重复算法' }],
      target: 'zh',
    });
    assert.equal(set1.ok, true);
    assert.equal(set1.value.target, 'zh');
    assert.deepEqual(set1.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

    const get1 = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(get1.ok, true);
    assert.equal(get1.value.target, 'zh');
    assert.deepEqual(get1.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

    const list1 = await host.call('materials.translation.list', { documentId: docId });
    assert.equal(list1.ok, true);
    assert.equal(list1.value.target, 'zh');
    assert.deepEqual(list1.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);
    assert.deepEqual(list1.value.items, []);

    const docMeta = await host.call('materials.document.get', { documentId: docId });
    assert.equal(docMeta.ok, true);
    const firstSourceId = docMeta.value.sources[0].id;

    const saved = await host.call('materials.translation.save', {
      documentId: docId,
      target: 'zh',
      passages: [
        {
          sourceId: firstSourceId,
          text: 'FSRS schedules memory intervals using stability and difficulty.',
          translation: '间隔重复算法根据稳定性与难度安排记忆间隔。',
        },
      ],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.saved, 1);

    const list2 = await host.call('materials.translation.list', { documentId: docId });
    assert.equal(list2.ok, true);
    assert.equal(list2.value.items.length, 1);
    const savedKey = list2.value.items[0].key;

    const del1 = await host.call('materials.translation.delete', {
      documentId: docId,
      target: 'zh',
      keys: [savedKey],
    });
    assert.equal(del1.ok, true);
    assert.equal(del1.value.deleted, 1);

    const cleared = await host.call('materials.translation.glossary.set', {
      documentId: docId,
      glossary: [],
    });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.value.glossary, []);

    const getAfterClear = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(getAfterClear.ok, true);
    assert.deepEqual(getAfterClear.value.glossary, []);
  });

  test('2) PTY E2E (zh 120x36 & 80x24): DocumentReader [G] -> add glossary -> Tab 2 Saved -> delete confirm -> Esc close', async () => {
    const mdPath = join(boxDir, 'r46-pty-zh.md');
    await writeFile(
      mdPath,
      [
        '# Round 46 Translation Glossary',
        '',
        'FSRS updates memory stability after each recall attempt.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R46 Zh Glossary Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;

    const docMeta = await host.call('materials.document.get', { documentId: docId });
    assert.equal(docMeta.ok, true);
    const srcId = docMeta.value.sources[0].id;

    const saved = await host.call('materials.translation.save', {
      documentId: docId,
      target: 'zh',
      passages: [
        {
          sourceId: srcId,
          text: 'FSRS updates memory stability after each recall attempt.',
          translation: 'FSRS 在每次回忆后更新记忆稳定性。',
        },
      ],
    });
    assert.equal(saved.ok, true);

    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('R46 Zh Glossary Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered with R46 Zh Glossary Doc' },
    );

    tty.send('/');
    await tty.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar' });
    tty.send('R46 Zh Glossary');
    await tty.waitFor((s) => s.includes('R46 Zh Glossary Doc'), { label: 'Filtered to R46 Zh Glossary Doc' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('R46 Zh Glossary Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R46 Zh Glossary Doc selected' },
    );

    tty.send('\r');
    const readerScreen = await tty.waitFor(
      (s) =>
        s.includes('R46 Zh Glossary Doc') &&
        s.includes('FSRS updates memory stability') &&
        s.includes('术语译文'),
      { timeoutMs: 10_000, label: 'DocumentReader opened with [G] 术语译文 footer hint' },
    );
    tty.assertHealthyScreen(readerScreen, 120, 36, 'DocumentReader with [G] hint (zh)');

    // Open TranslationGlossaryModal via 'G'
    tty.send('G');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('翻译术语表与已存译文') &&
        s.includes('1:术语表') &&
        s.includes('2:已存译文') &&
        s.includes('术语表为空'),
      { timeoutMs: 8_000, label: 'TranslationGlossaryModal opened (zh)' },
    );
    tty.assertHealthyScreen(modalScreen, 120, 36, 'TranslationGlossaryModal open 120x36 (zh)');

    // Press 'a' to add glossary term
    tty.send('a');
    await tty.waitFor(
      (s) => s.includes('添加术语 (1/2)') && s.includes('术语原文'),
      { timeoutMs: 5_000, label: 'Add glossary step 1 prompt (zh)' },
    );
    tty.send('FSRS');
    await tty.waitFor((s) => s.includes('术语原文: FSRS'), { timeoutMs: 5_000, label: 'Typed FSRS' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('添加术语 (2/2)') && s.includes('FSRS'),
      { timeoutMs: 5_000, label: 'Add glossary step 2 prompt (zh)' },
    );
    tty.send('间隔重复算法');
    await tty.waitFor((s) => s.includes('间隔重复算法'), { timeoutMs: 5_000, label: 'Typed 间隔重复算法' });
    tty.send('\r');

    const addedScreen = await tty.waitFor(
      (s) => s.includes('FSRS → 间隔重复算法') && s.includes('1:术语表 (1)'),
      { timeoutMs: 8_000, label: 'Glossary entry persisted and rendered (zh)' },
    );
    tty.assertHealthyScreen(addedScreen, 120, 36, 'TranslationGlossaryModal after add (zh)');

    const getCheck = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(getCheck.ok, true);
    assert.deepEqual(getCheck.value.glossary, [{ term: 'FSRS', to: '间隔重复算法' }]);

    // Switch to Tab 2 (Saved) via Tab
    tty.send('\t');
    const tab2Screen = await tty.waitFor(
      (s) => s.includes('2:已存译文 (1)') && s.includes('FSRS 在每次回忆后更新记忆稳定性'),
      { timeoutMs: 8_000, label: 'Switched to Tab 2 Saved translations (zh)' },
    );
    tty.assertHealthyScreen(tab2Screen, 120, 36, 'TranslationGlossaryModal Tab 2 120x36 (zh)');

    // Resize to 80x24 while open
    tty.resize(80, 24);
    const narrowScreen = await tty.waitFor(
      (s) => s.includes('翻译术语表与已存译文') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'TranslationGlossaryModal resized to 80x24 (zh)' },
    );
    tty.assertHealthyScreen(narrowScreen, 80, 24, 'TranslationGlossaryModal 80x24 (zh)');

    // Press 'd' to delete saved translation -> confirm 'y'
    tty.send('d');
    await tty.waitFor((s) => s.includes('删除已存译文'), { timeoutMs: 5_000, label: 'Delete ConfirmDialog (zh)' });
    tty.send('y');
    await tty.waitFor(
      (s) => s.includes('2:已存译文 (0)') && s.includes('当前版本暂无已存译文'),
      { timeoutMs: 8_000, label: 'Saved translation deleted (zh)' },
    );

    // Close modal with Esc cleanly back to DocumentReader
    tty.send('\x1b');
    const backReader = await tty.waitFor(
      (s) => !s.includes('翻译术语表与已存译文') && s.includes('FSRS updates memory stability'),
      { timeoutMs: 5_000, label: 'Closed modal back to DocumentReader (zh)' },
    );
    tty.assertHealthyScreen(backReader, 80, 24, 'DocumentReader after modal close 80x24 (zh)');

    await unmountActiveApp();
  });

  test('3) PTY E2E (--ascii en 120x36 & 80x24): DocumentReader [G] -> add glossary -> toggle lang [l] -> Tab 2 -> Esc close & 100% ASCII purity', async () => {
    const mdPath = join(boxDir, 'r46-pty-en.md');
    await writeFile(
      mdPath,
      [
        '# Round 46 ASCII Glossary',
        '',
        'Retrieval practice strengthens long-term memory recall.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R46 En Glossary Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;

    const asciiTty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en' });
    await asciiTty.waitFor(
      (s) => s.includes('R46 En Glossary Doc') && !s.includes('Loading'),
      { timeoutMs: 10_000, label: 'ASCII SourcesView rendered' },
    );

    asciiTty.send('/');
    await asciiTty.waitFor((s) => s.includes('Filter') || s.includes('Search'), { label: 'ASCII filter bar' });
    asciiTty.send('R46 En Glossary');
    await asciiTty.waitFor((s) => s.includes('R46 En Glossary Doc'), { label: 'ASCII filter typed' });
    asciiTty.send('\r');
    await asciiTty.waitFor(
      (s) => s.includes('R46 En Glossary Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'ASCII R46 En Glossary Doc selected' },
    );

    asciiTty.send('\r');
    const readerEn = await asciiTty.waitFor(
      (s) =>
        s.includes('R46 En Glossary Doc') &&
        s.includes('Retrieval practice strengthens') &&
        s.includes('G  Glossary'),
      { timeoutMs: 10_000, label: 'ASCII DocumentReader opened with G Glossary hint' },
    );
    asciiTty.assertHealthyScreen(readerEn, 120, 36, 'ASCII DocumentReader 120x36');
    asciiTty.assertAsciiPure(readerEn, 'ASCII DocumentReader 120x36');

    // Open TranslationGlossaryModal via 'G'
    asciiTty.send('G');
    const modalEn = await asciiTty.waitFor(
      (s) =>
        s.includes('Translation Glossary & Saved') &&
        s.includes('1:Glossary') &&
        s.includes('2:Saved') &&
        s.includes('No glossary terms yet'),
      { timeoutMs: 8_000, label: 'ASCII TranslationGlossaryModal opened' },
    );
    asciiTty.assertHealthyScreen(modalEn, 120, 36, 'ASCII TranslationGlossaryModal 120x36');
    asciiTty.assertAsciiPure(modalEn, 'ASCII TranslationGlossaryModal 120x36');

    // Add glossary entry via 'a'
    asciiTty.send('a');
    await asciiTty.waitFor(
      (s) => s.includes('Add term (1/2)') && s.includes('Source term:'),
      { timeoutMs: 5_000, label: 'ASCII add term step 1' },
    );
    asciiTty.send('Retrieval practice');
    await asciiTty.waitFor(
      (s) => s.includes('Source term: Retrieval practice'),
      { timeoutMs: 5_000, label: 'ASCII typed Retrieval practice' },
    );
    asciiTty.send('\r');
    await asciiTty.waitFor(
      (s) => s.includes('Add term (2/2)') && s.includes('Target(empty=keep):'),
      { timeoutMs: 5_000, label: 'ASCII add term step 2' },
    );
    asciiTty.send('Active Recall');
    await asciiTty.waitFor(
      (s) => s.includes('Target(empty=keep): Active Recall'),
      { timeoutMs: 5_000, label: 'ASCII typed Active Recall' },
    );
    asciiTty.send('\r');

    const afterAddEn = await asciiTty.waitFor(
      (s) => s.includes('Retrieval practice -> Active Recall') && s.includes('1:Glossary (1)'),
      { timeoutMs: 8_000, label: 'ASCII glossary entry saved' },
    );
    asciiTty.assertHealthyScreen(afterAddEn, 120, 36, 'ASCII TranslationGlossaryModal after add');
    asciiTty.assertAsciiPure(afterAddEn, 'ASCII TranslationGlossaryModal after add');

    // Toggle target language via 'l' (zh -> en)
    asciiTty.send('l');
    const afterLangToggle = await asciiTty.waitFor(
      (s) => s.includes('English (en)') && s.includes('EN'),
      { timeoutMs: 5_000, label: 'ASCII target language toggled zh -> en' },
    );
    asciiTty.assertAsciiPure(afterLangToggle, 'ASCII TranslationGlossaryModal after lang toggle');

    const getCheckEn = await host.call('materials.translation.glossary.get', { documentId: docId });
    assert.equal(getCheckEn.ok, true);
    assert.equal(getCheckEn.value.target, 'en');
    assert.deepEqual(getCheckEn.value.glossary, [{ term: 'Retrieval practice', to: 'Active Recall' }]);

    // Switch to Tab 2 (Saved) via Tab and resize to 80x24
    asciiTty.send('\t');
    await asciiTty.waitFor(
      (s) => s.includes('No saved translations for this revision'),
      { timeoutMs: 5_000, label: 'ASCII Tab 2 Saved rendered' },
    );
    asciiTty.resize(80, 24);
    const narrowEn = await asciiTty.waitFor(
      (s) => s.includes('Translation Glossary & Saved') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'ASCII TranslationGlossaryModal 80x24' },
    );
    asciiTty.assertHealthyScreen(narrowEn, 80, 24, 'ASCII TranslationGlossaryModal 80x24');
    asciiTty.assertAsciiPure(narrowEn, 'ASCII TranslationGlossaryModal 80x24');

    // Close modal with Esc cleanly
    asciiTty.send('\x1b');
    const closedEn = await asciiTty.waitFor(
      (s) => !s.includes('Translation Glossary & Saved') && s.includes('Retrieval practice strengthens'),
      { timeoutMs: 5_000, label: 'ASCII modal closed cleanly back to DocumentReader' },
    );
    asciiTty.assertHealthyScreen(closedEn, 80, 24, 'ASCII DocumentReader after modal close 80x24');
    asciiTty.assertAsciiPure(closedEn, 'ASCII DocumentReader after modal close 80x24');

    await unmountActiveApp();
  });
});
