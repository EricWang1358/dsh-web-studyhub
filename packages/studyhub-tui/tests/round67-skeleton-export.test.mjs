// Round 67 Track 1: SkeletonView `/` live node filter, `[x]` atomic Markdown outline export,
// and SGR 1006 mouse wheel scrolling (`useSgrMouseWheel`).
// `node --test --test-concurrency=1 tests/round67-skeleton-export.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

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
    if (!S && mod.useTuiStore) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
const { useTuiStore } = S;

const { formatSkeletonMarkdown, todayLocalYmd } = await tsImport(
  '../src/views/skeleton/SkeletonView.tsx',
  import.meta.url,
);
assert.equal(typeof formatSkeletonMarkdown, 'function', 'SkeletonView must export formatSkeletonMarkdown');

const PREV_DSH_HOME = process.env.DSH_HOME;
const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r67-${label}-`));
  tempDirs.push(d);
  return d;
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
    await sleep(35);
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
    assert.ok(lines.length <= expectedRows, `${contextLabel}: row count ${lines.length} > ${expectedRows}`);
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

function resetStore({ language = 'zh', asciiMode = false, page = 'library' } = {}) {
  const prev = useTuiStore.getState();
  useTuiStore.setState({
    page,
    history: [],
    navContext: {},
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    toasts: [],
    preferences: {
      ...prev.preferences,
      language,
      asciiMode,
      sidebarCollapsed: false,
      showKeyHints: true,
    },
  });
}

async function seedDeckWithCards(host, { title, course, topic, prompts }) {
  const impRes = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: prompts.map((prompt, idx) => ({
        kind: 'flashcard',
        topic,
        prompt,
        answer: `Answer ${idx + 1}`,
        explanation: `Explanation ${idx + 1}`,
      })),
    }),
    folder: course,
  });
  assert.equal(impRes.ok, true, `deck.import failed: ${impRes.error?.message || ''}`);
  const snap = await host.call('snapshot', {});
  assert.equal(snap.ok, true, `snapshot failed: ${snap.error?.message || ''}`);
  const deckSummary = (snap.value?.decks ?? []).find((d) => d.title === title);
  assert.ok(deckSummary?.id, 'snapshot must include imported deck');
  const deckRes = await host.call('deck.get', { id: deckSummary.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message || ''}`);
  const cardIds = (deckRes.value?.cards ?? []).map((c) => c.id).filter(Boolean);
  assert.ok(cardIds.length === prompts.length, 'deck.get must return all created card ids');
  return { deckId: deckSummary.id, cardIds, topic };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 67 Track 1: SkeletonView live filter, Markdown export, and SGR mouse wheel', () => {
  test('1. Pure formatSkeletonMarkdown generates hierarchical outline in zh and en with mastery %, card counts, and descriptions', () => {
    const detail = {
      id: 'skel-1',
      title: 'Operating Systems Core',
      overview: 'Core mechanisms for process scheduling and virtual memory.',
      classNote: 'Focus on page replacement algorithms for midterm.',
      scope: [{ deckId: 'deck-os', topic: 'OS' }],
      nodes: [
        {
          id: 'n-root',
          term: 'Kernel Architecture',
          meaning: 'Privilege separation and system call boundary',
          attributes: ['Ring 0', 'Syscall'],
          cards: [{ deckId: 'deck-os', cardId: 'c1' }],
        },
        {
          id: 'n-mem',
          term: 'Virtual Memory',
          meaning: 'Address translation and demand paging',
          parent: 'n-root',
          cards: [
            { deckId: 'deck-os', cardId: 'c2' },
            { deckId: 'deck-os', cardId: 'c3' },
          ],
        },
        {
          id: 'n-tlb',
          term: 'TLB Cache',
          meaning: 'Hardware translation lookaside buffer',
          parent: 'n-mem',
          cards: [{ deckId: 'deck-os', cardId: 'c4' }],
        },
      ],
      relations: [{ from: 'n-root', to: 'n-mem', type: 'part-of', note: 'Subsystem' }],
    };

    const masteryMap = new Map([
      [
        'n-root',
        {
          cardCount: 1,
          masteredCount: 1,
          weakCount: 0,
          masteryPct: 80,
          isFocus: true,
          level: 'mastered',
          samplePrompts: [],
          subtreeCards: [],
        },
      ],
      [
        'n-mem',
        {
          cardCount: 2,
          masteredCount: 1,
          weakCount: 0,
          masteryPct: 60,
          isFocus: false,
          level: 'learning',
          samplePrompts: [],
          subtreeCards: [],
        },
      ],
      [
        'n-tlb',
        {
          cardCount: 1,
          masteredCount: 1,
          weakCount: 0,
          masteryPct: 100,
          isFocus: false,
          level: 'mastered',
          samplePrompts: [],
          subtreeCards: [],
        },
      ],
    ]);

    const enMd = formatSkeletonMarkdown({
      detail,
      course: 'CS301',
      masteryMap,
      lang: 'en',
      generatedAt: new Date('2026-11-22T10:30:00.000Z'),
    });
    assert.ok(enMd.includes('# Operating Systems Core'));
    assert.ok(enMd.includes('Course: CS301 | Nodes: 3 | Relations: 1 | Cards: 4 | Avg Mastery: 80% | Generated: 2026-11-22 10:30'));
    assert.ok(enMd.includes('> Core mechanisms for process scheduling and virtual memory.'));
    assert.ok(enMd.includes('### Kernel Architecture [80% | 1 cards | Focus]'));
    assert.ok(enMd.includes('- Summary: Privilege separation and system call boundary'));
    assert.ok(enMd.includes('- **Virtual Memory** [60% | 2 cards]'));
    assert.ok(enMd.includes('  - Address translation and demand paging'));
    assert.ok(enMd.includes('  - **TLB Cache** [100% | 1 cards]'));
    assert.ok(enMd.includes('    - Hardware translation lookaside buffer'));
    assert.ok(enMd.includes('- Kernel Architecture --[part-of]-> Virtual Memory (Subsystem)'));

    const zhMd = formatSkeletonMarkdown({
      detail,
      course: 'CS301',
      masteryMap,
      lang: 'zh',
      generatedAt: new Date('2026-11-22T10:30:00.000Z'),
    });
    assert.ok(zhMd.includes('# Operating Systems Core'));
    assert.ok(zhMd.includes('课程: CS301 | 节点: 3 | 关系: 1 | 题卡: 4 | 平均掌握度: 80% | 导出时间: 2026-11-22 10:30'));
    assert.ok(zhMd.includes('### Kernel Architecture [80% | 1题 | 考纲重点]'));
    assert.ok(zhMd.includes('- 释义: Privilege separation and system call boundary'));
    assert.ok(zhMd.includes('- **Virtual Memory** [60% | 2题]'));
    assert.ok(zhMd.includes('  - **TLB Cache** [100% | 1题]'));
    assert.ok(zhMd.includes('- Kernel Architecture --[属于]-> Virtual Memory (Subsystem)'));
  });

  test('2. @xterm/headless PTY E2E (120x36 zh): / live filter, E on filtered node, x atomic export, Esc clear, and SGR 1006 wheel (0 LLM tokens)', async () => {
    const box = await makeTempDir('e2e-zh');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await H.saveTuiPreferences({ language: 'zh', asciiMode: false });
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    let llmCalls = 0;
    host.streamComplete = async () => {
      llmCalls += 1;
      throw new Error('LLM should never be called during filter/export/wheel');
    };

    const seed = await seedDeckWithCards(host, {
      title: '操作系统核心题组',
      course: 'OS202',
      topic: '内存与调度',
      prompts: ['什么是系统调用？', '什么是页表？', '什么是时间片轮转？'],
    });

    const saved = await host.call('skeleton.save', {
      title: 'OS 知识骨架',
      overview: '操作系统核心知识图谱',
      scope: [{ deckId: seed.deckId, topic: seed.topic }],
      nodes: [
        { id: 'n-kernel', term: 'Kernel Trap', meaning: 'User to kernel mode switch', cards: [seed.cardIds[0]] },
        { id: 'n-paging', term: 'Virtual Memory', meaning: 'Page table translation', parent: 'n-kernel', cards: [seed.cardIds[1]] },
        { id: 'n-sched', term: 'CPU Scheduler', meaning: 'Round robin time slicing', parent: 'n-kernel', cards: [seed.cardIds[2]] },
      ],
      relations: [{ from: 'n-kernel', to: 'n-paging', type: 'part-of', note: 'Memory subsystem' }],
    });
    assert.equal(saved.ok, true, `skeleton.save failed: ${saved.error?.message || ''}`);

    resetStore({ language: 'zh', asciiMode: false, page: 'library' });
    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('正在打开学习库'), { label: 'LibraryView ready (zh)' });

      tty.send('8');
      const initialScreen = await tty.waitFor(
        (s) => {
          const hints = useTuiStore.getState().footerHints;
          return (
            useTuiStore.getState().page === 'skeleton' &&
            s.includes('OS 知识骨架') &&
            s.includes('Kernel Trap') &&
            s.includes('Virtual Memory') &&
            s.includes('CPU Scheduler') &&
            hints.some((h) => h.key === '/' && h.label === '筛选') &&
            hints.some((h) => h.key === 'x' && h.label === '导出MD')
          );
        },
        { label: 'SkeletonView rendered with 3 nodes and footer hints (zh)' },
      );
      const hintKeys = useTuiStore.getState().footerHints.map((h) => h.key);
      assert.ok(hintKeys.indexOf('/') > hintKeys.indexOf('s'), '`/` hint must appear after existing hints');
      assert.ok(hintKeys.indexOf('x') > hintKeys.indexOf('/'), '`x` hint must appear after `/` hint');
      tty.assertHealthyScreen(initialScreen, 120, 36, 'SkeletonView initial 120x36 zh');

      // Press `/` to open live filter bar and type 'Virtual'
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 3/3]'), { label: 'SkeletonView filter bar opened' });
      tty.send('Virtual');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/3]') &&
          s.includes('Virtual Memory') &&
          !s.includes('CPU Scheduler') &&
          s.includes('Page table translation'),
        { label: 'Filter narrowed tree to Virtual Memory and clamped Inspector' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'SkeletonView filter editing');

      // Enter confirms filter keeping filter active
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => s.includes('[已筛选 1/3]') && s.includes('Virtual Memory') && !s.includes('CPU Scheduler'),
        { label: 'Enter confirmed filter bar' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'SkeletonView filter confirmed');

      // Press `E` to verify edit modal targets the clamped filtered node ('Virtual Memory')
      tty.send('E');
      const editModalScreen = await tty.waitFor(
        (s) => s.includes('编辑知识节点') && s.includes('Virtual Memory') && s.includes('Page table translation'),
        { label: 'NodeEditModal opened for filtered node Virtual Memory' },
      );
      tty.assertHealthyScreen(editModalScreen, 120, 36, 'SkeletonView NodeEditModal on filtered node');
      tty.send('\u001b');
      await tty.waitFor((s) => !s.includes('编辑知识节点') && s.includes('[已筛选 1/3]'), {
        label: 'NodeEditModal closed with Esc',
      });

      // Press `x` to export Markdown atomically
      tty.send('x');
      const exportToastScreen = await tty.waitFor(
        (s) => s.includes('已导出 3 个知识节点'),
        { label: 'Skeleton Markdown export success toast (zh)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 120, 36, 'SkeletonView after export');

      const expectedExportPath = join(libraryRoot, 'backups', `studyhub-skeleton-${todayLocalYmd()}.md`);
      const exportedMd = await readFile(expectedExportPath, 'utf8');
      assert.ok(exportedMd.includes('# OS 知识骨架'));
      assert.ok(exportedMd.includes('### Kernel Trap'));
      assert.ok(exportedMd.includes('- **Virtual Memory**'));
      assert.ok(exportedMd.includes('- **CPU Scheduler**'));
      assert.ok(exportedMd.includes('Page table translation'));

      // Press `Esc` in normal mode to clear active filter (keeps Virtual Memory selected in full tree)
      tty.send('\u001b');
      const clearedScreen = await tty.waitFor(
        (s) =>
          !s.includes('[已筛选') &&
          s.includes('Kernel Trap') &&
          s.includes('Virtual Memory') &&
          s.includes('CPU Scheduler') &&
          s.includes('Page table translation'),
        { label: 'Esc cleared active filter cleanly' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'SkeletonView filter cleared');

      // SGR 1006 mouse wheel up moves selection: Virtual Memory -> Kernel Trap
      tty.send('\x1b[<64;10;10M');
      const wheelUpToRoot = await tty.waitFor(
        (s) => s.includes('User to kernel mode switch'),
        { label: 'SGR wheel up moved selection to Kernel Trap' },
      );
      tty.assertHealthyScreen(wheelUpToRoot, 120, 36, 'SkeletonView wheel up to root');

      // SGR 1006 mouse wheel down moves selection: Kernel Trap -> Virtual Memory
      tty.send('\x1b[<65;10;10M');
      const wheelDown1 = await tty.waitFor(
        (s) => s.includes('Page table translation'),
        { label: 'SGR wheel down moved selection to Virtual Memory' },
      );
      tty.assertHealthyScreen(wheelDown1, 120, 36, 'SkeletonView wheel down 1');

      // SGR 1006 mouse wheel down again: Virtual Memory -> CPU Scheduler
      tty.send('\x1b[<65;10;10M');
      const wheelDown2 = await tty.waitFor(
        (s) => s.includes('Round robin time slicing'),
        { label: 'SGR wheel down moved selection to CPU Scheduler' },
      );
      tty.assertHealthyScreen(wheelDown2, 120, 36, 'SkeletonView wheel down 2');

      // SGR 1006 mouse wheel up moves selection back: CPU Scheduler -> Virtual Memory
      tty.send('\x1b[<64;10;10M');
      const wheelUp = await tty.waitFor(
        (s) => s.includes('Page table translation'),
        { label: 'SGR wheel up moved selection back to Virtual Memory' },
      );
      tty.assertHealthyScreen(wheelUp, 120, 36, 'SkeletonView wheel up');
      assert.equal(llmCalls, 0, 'Skeleton filter, export, and wheel must use 0 LLM tokens');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('3. @xterm/headless PTY E2E (80x24 --ascii en): SkeletonView (8) -> / -> x -> assertHealthyScreen + assertAsciiPure', async () => {
    const box = await makeTempDir('e2e-ascii-en');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await H.saveTuiPreferences({ language: 'en', asciiMode: true });
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 25,
    });

    const seed = await seedDeckWithCards(host, {
      title: 'Architecture Deck',
      course: 'ARCH101',
      topic: 'Memory Hierarchy',
      prompts: ['What is L1 cache?', 'What is associative mapping?'],
    });

    const saved = await host.call('skeleton.save', {
      title: 'CPU & Cache Skeleton',
      overview: 'Processor pipeline and cache hierarchy.',
      scope: [{ deckId: seed.deckId, topic: seed.topic }],
      nodes: [
        { id: 'n-cpu', term: 'Pipeline Stages', meaning: 'Fetch decode execute writeback', cards: [seed.cardIds[0]] },
        { id: 'n-cache', term: 'Cache Coherence', meaning: 'MESI protocol invalidation', parent: 'n-cpu', cards: [seed.cardIds[1]] },
      ],
      relations: [{ from: 'n-cpu', to: 'n-cache', type: 'related', note: 'Memory stall' }],
    });
    assert.equal(saved.ok, true);

    resetStore({ language: 'en', asciiMode: true, page: 'library' });
    const tty = createVirtualTty(80, 24);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('Opening library'), { label: 'LibraryView ready (en ascii)' });

      tty.send('8');
      const skelScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'skeleton' &&
          s.includes('CPU & Cache Skeleton') &&
          s.includes('Pipeline Stages') &&
          s.includes('Cache Coherence'),
        { label: 'ASCII SkeletonView 80x24 ready' },
      );
      tty.assertHealthyScreen(skelScreen, 80, 24, 'ASCII SkeletonView 80x24 initial');
      tty.assertAsciiPure(skelScreen, 'ASCII SkeletonView 80x24 initial');

      // Press `/` -> type 'Cache' -> Enter
      tty.send('/');
      await tty.waitFor((s) => s.includes('[Filter 2/2]'), { label: 'ASCII filter bar opened' });
      tty.send('Cache');
      const filteredAscii = await tty.waitFor(
        (s) => s.includes('[Filter 1/2]') && s.includes('Cache Coherence') && !s.includes('Pipeline Stages'),
        { label: 'ASCII filter narrowed to Cache Coherence' },
      );
      tty.assertHealthyScreen(filteredAscii, 80, 24, 'ASCII SkeletonView filter editing');
      tty.assertAsciiPure(filteredAscii, 'ASCII SkeletonView filter editing');

      tty.send('\r');
      const confirmedAscii = await tty.waitFor(
        (s) => s.includes('[Filtered 1/2]') && s.includes('Cache Coherence'),
        { label: 'ASCII filter confirmed' },
      );
      tty.assertHealthyScreen(confirmedAscii, 80, 24, 'ASCII SkeletonView filter confirmed');
      tty.assertAsciiPure(confirmedAscii, 'ASCII SkeletonView filter confirmed');

      // Press `x` -> export Markdown and verify ASCII-pure toast + file on disk
      useTuiStore.setState({ toasts: [] });
      tty.send('x');
      const exportedAscii = await tty.waitFor(
        (s) =>
          s.includes('Exported 2') &&
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Exported 2 skeleton node(s) ->')),
        { label: 'ASCII Skeleton export toast' },
      );
      tty.assertHealthyScreen(exportedAscii, 80, 24, 'ASCII SkeletonView after export');
      tty.assertAsciiPure(exportedAscii, 'ASCII SkeletonView after export');

      const expectedExportPath = join(libraryRoot, 'backups', `studyhub-skeleton-${todayLocalYmd()}.md`);
      const exportedMd = await readFile(expectedExportPath, 'utf8');
      assert.ok(exportedMd.includes('# CPU & Cache Skeleton'));
      assert.ok(exportedMd.includes('### Pipeline Stages'));
      assert.ok(exportedMd.includes('- **Cache Coherence**'));

      // Press `Esc` -> clear filter
      tty.send('\u001b');
      const clearedAscii = await tty.waitFor(
        (s) => !s.includes('[Filtered') && s.includes('Pipeline Stages') && s.includes('Cache Coherence'),
        { label: 'ASCII Esc cleared filter' },
      );
      tty.assertHealthyScreen(clearedAscii, 80, 24, 'ASCII SkeletonView cleared');
      tty.assertAsciiPure(clearedAscii, 'ASCII SkeletonView cleared');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
