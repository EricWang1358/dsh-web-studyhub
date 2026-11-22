// Round 63 Track 2: BookAiBlocksModal (`course.book.block` keep/delete, 0 LLM tokens)
// createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round63-book-aiblock.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../../lib/course-book.js';
import { buildOutlineIndex } from '../../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { openCourseBook } from '../../../lib/course-book-files.js';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') {
      H = {
        createTuiHost: mod.createTuiHost,
        saveTuiPreferences: mod.saveTuiPreferences,
      };
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const aiBlocksChunk = distFiles.find((f) => f.startsWith('BookAiBlocksModal-') && f.endsWith('.mjs'));
assert.ok(aiBlocksChunk, `dist/ must emit lazy BookAiBlocksModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const aiBlocksChunkCode = fs.readFileSync(join(distDir, aiBlocksChunk), 'utf8');
assert.equal(/\bmarked\b/.test(aiBlocksChunkCode), false, `${aiBlocksChunk} must be marked-free`);
assert.equal(/\bcli-highlight\b/.test(aiBlocksChunkCode), false, `${aiBlocksChunk} must not bundle cli-highlight`);
assert.equal(/src\/components\/MarkdownView\.tsx/.test(aiBlocksChunkCode), false, `${aiBlocksChunk} must not bundle MarkdownView`);

const aiBlocksMod = await import(pathToFileURL(join(distDir, aiBlocksChunk)).href);
assert.equal(typeof aiBlocksMod.parseAiBlocks, 'function', `${aiBlocksChunk} must export parseAiBlocks`);
const { parseAiBlocks } = aiBlocksMod;

const { createTuiHost, saveTuiPreferences } = H;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round63-aiblock-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: false,
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
    preferences: {
      ...DEFAULT_PREFERENCES,
      language,
      asciiMode,
    },
  });
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
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
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

const BOOK_COURSE = 'AiBlockCourse';

async function seedBookLibrary(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      {
        id: 'doc1-p1',
        title: 'Lecture 1 · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Consistent hashing distributes keys across a ring to minimize re-sharding.',
        document: {
          materialId: 'doc-l1',
          page: 1,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 0, title: 'Consistent Hashing', level: 1 },
          extractionVersion: 2,
        },
      },
      {
        id: 'doc1-p2',
        title: 'Lecture 1 · p. 2',
        createdAt: '2026-10-01T01:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Virtual nodes smooth load imbalance across heterogeneous servers.',
        document: {
          materialId: 'doc-l1',
          page: 2,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 1, title: 'Virtual Nodes', level: 1 },
          extractionVersion: 2,
        },
      },
    );
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
    const leaves = [
      { id: 'hashing', title: 'Consistent Hashing', anchors: [`${lecture}#0`] },
      { id: 'vnodes', title: 'Virtual Nodes', anchors: [`${lecture}#1`] },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: 'Outline · AiBlockCourse',
        course: BOOK_COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
        nodes: [{ id: 'ch1', title: 'Distributed Hashing', children: leaves }],
        other: { anchors: [] },
        counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    state.sources.push({
      ...courseNotesMaterial({
        title: 'Review Book · AiBlockCourse',
        course: BOOK_COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: leaves.map((leaf, idx) => ({
          ...leaf,
          body: {
            fingerprint: 'c'.repeat(16),
            points: [`${leaf.title} core mechanism [^1].`],
            explain: `Detailed explanation for ${leaf.title}.`,
            cites: [{ n: 1, sourceId: idx === 0 ? 'doc1-p1' : 'doc1-p2', quote: 'Consistent', start: 0, end: 10 }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: BOOK_COURSE });
  });
  await service.dispose();
}

async function seedAiBlocksInMineFile(host, text) {
  const openRes = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
  assert.equal(openRes.ok, true, openRes.error?.message);
  const firstLeaf = openRes.value.nodes[0].children[0];
  const file = firstLeaf.files.mine;
  const v1 = openRes.value.files[file].version;

  const saveRes = await host.call('course.book.save', {
    course: BOOK_COURSE,
    file,
    text,
    version: v1,
  });
  assert.equal(saveRes.ok, true, saveRes.error?.message);
  return { file, leaf: firstLeaf };
}

describe('Round 63 Track 2: BookAiBlocksModal (course.book.block keep/delete)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('0) parseAiBlocks parses sh:ai blocks matching lib/course-book-ai-text.js syntax', () => {
    const sample = [
      'Learner own note.',
      '',
      '<!-- sh:ai id=ai-1 at=a1b2c3d4 state=new mode=explain ask=%E4%B8%BA%E4%BB%80%E4%B9%88%E9%9C%80%E8%A6%81%E7%8E%AF -->',
      '关于：「一致性哈希环」',
      '',
      '哈希环能把节点增删的影响局部化。',
      '<!-- /sh:ai -->',
      '',
      '<!-- sh:ai id=ai-2 at=h:h1 state=kept mode=here -->',
      'About: “Virtual nodes”',
      '',
      'Virtual nodes balance uneven key distribution.',
      '<!-- /sh:ai -->',
    ].join('\n');

    const parsed = parseAiBlocks(sample);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, 'ai-1');
    assert.equal(parsed[0].at, 'a1b2c3d4');
    assert.equal(parsed[0].state, 'new');
    assert.equal(parsed[0].mode, 'explain');
    assert.equal(parsed[0].ask, '为什么需要环');
    assert.equal(parsed[0].about, '一致性哈希环');
    assert.equal(parsed[0].body, '哈希环能把节点增删的影响局部化。');

    assert.equal(parsed[1].id, 'ai-2');
    assert.equal(parsed[1].state, 'kept');
    assert.equal(parsed[1].mode, 'here');
    assert.equal(parsed[1].about, 'Virtual nodes');
    assert.equal(parsed[1].body, 'Virtual nodes balance uneven key distribution.');
  });

  test('1) createTuiHost integration (0 model calls): save 2 state=new AI blocks -> keep block 1 -> delete block 2', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    try {
      const twoBlocksText = [
        '我的原始笔记保留段。',
        '',
        '<!-- sh:ai id=blk-keep at=11223344 state=new mode=explain ask=%E8%A7%A3%E9%87%8A%E4%B8%80%E8%87%B4%E6%80%A7%E5%93%88%E5%B8%8C -->',
        '关于：「一致性哈希环」',
        '',
        '第一段 AI 讲解正文：降低再平衡成本。',
        '<!-- /sh:ai -->',
        '',
        '<!-- sh:ai id=blk-del at=55667788 state=new mode=here -->',
        '关于：「故障转移示例」',
        '',
        '第二段 AI 补充正文：节点下线时顺时针迁移。',
        '<!-- /sh:ai -->',
      ].join('\n');

      const { file } = await seedAiBlocksInMineFile(host, twoBlocksText);

      // Keep block 1
      const keepRes = await host.call('course.book.block', {
        course: BOOK_COURSE,
        file,
        id: 'blk-keep',
        action: 'keep',
      });
      assert.equal(keepRes.ok, true, keepRes.error?.message);
      assert.equal(keepRes.value.write, 'kept');
      assert.equal(keepRes.value.status, 'ok');
      const afterKeepMine = keepRes.value.nodes[0].children[0].mine;
      const afterKeepBlocks = parseAiBlocks(afterKeepMine);
      assert.equal(afterKeepBlocks.length, 2);
      assert.equal(afterKeepBlocks[0].id, 'blk-keep');
      assert.equal(afterKeepBlocks[0].state, 'kept');
      assert.equal(afterKeepBlocks[1].id, 'blk-del');
      assert.equal(afterKeepBlocks[1].state, 'new');

      // Delete block 2
      const delRes = await host.call('course.book.block', {
        course: BOOK_COURSE,
        file,
        id: 'blk-del',
        action: 'delete',
      });
      assert.equal(delRes.ok, true, delRes.error?.message);
      assert.equal(delRes.value.write, 'deleted');
      assert.equal(delRes.value.status, 'ok');
      const afterDelMine = delRes.value.nodes[0].children[0].mine;
      const afterDelBlocks = parseAiBlocks(afterDelMine);
      assert.equal(afterDelBlocks.length, 1);
      assert.equal(afterDelBlocks[0].id, 'blk-keep');
      assert.equal(afterDelBlocks[0].state, 'kept');
      assert.equal(afterDelMine.includes('blk-del'), false);
      assert.equal(afterDelMine.includes('我的原始笔记保留段。'), true);
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): BookView (7) -> B -> keep block 1 via a -> j -> d -> ConfirmDialog y deletes block 2 (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const twoBlocksText = [
      '<!-- sh:ai id=blk-alpha at=11111111 state=new mode=explain -->',
      '关于：「哈希环局部性」',
      '',
      'R63_KEEP_BODY_ALPHA 局部迁移键区间。',
      '<!-- /sh:ai -->',
      '',
      '<!-- sh:ai id=blk-beta at=22222222 state=new mode=here -->',
      '关于：「虚节点数量选择」',
      '',
      'R63_DEL_BODY_BETA 每个物理机建议 100-200 个虚节点。',
      '<!-- /sh:ai -->',
    ].join('\n');
    const { file } = await seedAiBlocksInMineFile(host, twoBlocksText);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('学习库'), { label: 'App load (zh)' });

      tty.send('7');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Distributed Hashing') &&
          s.includes('Consistent Hashing') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView loaded (zh)' },
      );

      // Press B directly from BookView (auto-picks file with AI blocks)
      tty.send('B');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 补充块审阅') &&
          s.includes(file) &&
          s.includes('blk-alpha') &&
          s.includes('blk-beta') &&
          s.includes('R63_KEEP_BODY_ALPHA'),
        { label: 'BookAiBlocksModal opened with both blocks (zh)' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'BookAiBlocksModal (zh)');

      // Keep block 1 via 'a'
      tty.send('a');
      const keptScreen = await tty.waitFor(
        (s) =>
          s.includes('已保留 AI 补充块 (blk-alpha)') &&
          s.includes('已保留'),
        { label: 'Block 1 kept toast & badge (zh)' },
      );
      tty.assertHealthyScreen(keptScreen, 120, 36, 'After keep blk-alpha (zh)');

      // Select block 2 via 'j'
      tty.send('j');
      await tty.waitFor(
        (s) => s.includes('R63_DEL_BODY_BETA'),
        { label: 'Selected block 2 with j (zh)' },
      );

      // Press 'd' -> ConfirmDialog
      tty.send('d');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认删除该 AI 补充块？') && s.includes('blk-beta'),
        { label: 'ConfirmDialog opened for blk-beta (zh)' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'ConfirmDialog delete AI block (zh)');

      // Confirm with 'y' -> block 2 deleted & toast shown
      tty.send('y');
      const afterDelScreen = await tty.waitFor(
        (s) =>
          !s.includes('确认删除该 AI 补充块？') &&
          s.includes('已删除 AI 补充块 (blk-beta)') &&
          !s.includes('R63_DEL_BODY_BETA') &&
          s.includes('1 块') &&
          s.includes('blk-alpha'),
        { label: 'Block 2 deleted & toast visible (zh)' },
      );
      tty.assertHealthyScreen(afterDelScreen, 120, 36, 'BookAiBlocksModal after delete (zh)');
      assert.equal(modelCalls, 0);
    } finally {
      if (inkInstance) inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): BookAiBlocksModal opens via B, passes assertHealthyScreen + assertAsciiPure, closes cleanly on Esc', async () => {
    const base = await makeTempDir('pty-en');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetDistStore('en', true);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const asciiTestText = [
      '<!-- sh:ai id=blk-ascii at=99887766 state=new mode=explain -->',
      'About: “Ring balance -> check ✓ …”',
      '',
      'ASCII preview body -> ok ✓ …',
      '<!-- /sh:ai -->',
    ].join('\n');
    const { file } = await seedAiBlocksInMineFile(host, asciiTestText);

    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('Library'), { label: 'App load (en)' });

      tty.send('7');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Distributed Hashing') &&
          s.includes('Consistent Hashing') &&
          !s.includes('Opening review book'),
        { label: 'BookView loaded (en)' },
      );

      tty.send('j');
      await tty.waitFor((s) => s.includes('AI Explain') && s.includes('Consistent Hashing'), {
        label: 'Leaf selected & AI Explain hint visible (en)',
      });

      tty.send('B');
      const modalEn = await tty.waitFor(
        (s) =>
          s.includes('AI Blocks Review') &&
          s.includes(file) &&
          s.includes('blk-ascii') &&
          s.includes('ASCII preview body -> ok OK ...'),
        { label: 'BookAiBlocksModal opened (en)' },
      );
      tty.assertHealthyScreen(modalEn, 80, 24, 'BookAiBlocksModal 80x24 --ascii (en)');
      tty.assertAsciiPure(modalEn, 'BookAiBlocksModal 80x24 --ascii (en)');

      // Esc closes cleanly
      tty.send('\x1b');
      const closedEn = await tty.waitFor(
        (s) => !s.includes('AI Blocks Review') && s.includes('Distributed Hashing'),
        { label: 'BookAiBlocksModal closed on Esc (en)' },
      );
      tty.assertHealthyScreen(closedEn, 80, 24, 'BookView after Esc 80x24 --ascii (en)');
      tty.assertAsciiPure(closedEn, 'BookView after Esc 80x24 --ascii (en)');
      assert.equal(modelCalls, 0);
    } finally {
      if (inkInstance) inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
