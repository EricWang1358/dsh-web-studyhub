// PR #1297 P1/P2/P3 regression suite: node --test tests/pr1297-p1-p2.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

const examUtilsMod = await tsImport('../src/views/exam/utils.ts', import.meta.url);
const shellDataMod = await tsImport('../src/shell/data.ts', import.meta.url);
const sourceHelpersMod = await tsImport('../src/views/sources/source-helpers.ts', import.meta.url);

const { buildScopeChoices } = examUtilsMod;
const { dueToday, wrongCount } = shellDataMod;
const { groupSourcesFromSnapshot } = sourceHelpersMod;

let createTuiHost = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-p1p2-${label}-`));
  tempDirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
    assert.ok(!screen.includes('\x1b'), `${contextLabel}: Unparsed escape sequence leaked!\n${screen}`);
    assert.ok(lines.length <= expectedRows, `${contextLabel}: Row count ${lines.length} > ${expectedRows}`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
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
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

describe('PR #1297 P1 & P2 regression suite', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let modelCallCount = 0;

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async (_system, prompt) => {
        if (String(prompt || '').includes('OK?')) return 'OK';
        modelCallCount += 1;
        return JSON.stringify({ title: 'Stub', overview: 'Stub', nodes: [], relations: [] });
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    tty = createVirtualTty(120, 36);
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: true,
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

    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        s.includes('示例 · Memento 与 Bridge') &&
        s.includes('示例案例 · 墨笺笔记'),
      { timeoutMs: 12_000, label: 'LibraryView after loading sample course' },
    );
    await sleep(100);
    await tty.flush();
  });

  after(async () => {
    try {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error during teardown
      }
      await host?.dispose();
      tty?.dispose();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('P3 #24: FSRS review rating persists attempt, today, and progress to disk', async () => {
    const snapBefore = await host.call('snapshot', {});
    assert.equal(snapBefore.ok, true);
    const beforeAttempts = snapBefore.value?.attempts?.length ?? 0;
    const beforeReviewed = Number(snapBefore.value?.today?.reviewed ?? 0);

    tty.send('\r');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面') &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 10_000, label: 'ReviewView card 1 rendered' },
    );

    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('答案与解析') && (s.includes('重来') || s.includes('Again')),
      { timeoutMs: 8_000, label: 'ReviewView card 1 revealed' },
    );

    tty.send('5');
    await tty.waitFor(
      (s) => s.includes('2/9') || s.includes('本轮练习总结') || s.includes('Round Summary'),
      { timeoutMs: 8_000, label: 'ReviewView advanced after FSRS grade 5' },
    );

    const snapAfter = await host.call('snapshot', {});
    assert.equal(snapAfter.ok, true);
    assert.ok(
      (snapAfter.value?.attempts?.length ?? 0) > beforeAttempts,
      `Expected attempts count > ${beforeAttempts}, got ${snapAfter.value?.attempts?.length ?? 0}`,
    );
    const afterReviewed = Number(snapAfter.value?.today?.reviewed ?? snapAfter.value?.today?.done ?? 0);
    assert.ok(
      afterReviewed >= beforeReviewed + 1 || (snapAfter.value?.attempts?.length ?? 0) > beforeAttempts,
      `Expected today progress or attempts to increment (before=${beforeReviewed}, after=${afterReviewed})`,
    );
    assert.ok(
      Object.keys(snapAfter.value?.progress ?? {}).length > 0,
      'Expected snapshot.progress to be populated',
    );

    const workspaceRaw = JSON.parse(await readFile(join(libraryRoot, 'study-workspace.json'), 'utf8'));
    const inlineAttempts = Array.isArray(workspaceRaw.attempts) ? workspaceRaw.attempts.length : 0;
    const attemptShards = workspaceRaw.collections?.attempts ?? workspaceRaw.shards?.attempts ?? [];
    assert.ok(
      inlineAttempts > beforeAttempts || attemptShards.length > 0,
      'Expected persisted attempts in study-workspace.json or its shards',
    );

    // Verify a fresh host opening the same libraryRoot reads the persisted attempt from disk
    const freshHost = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
    });
    try {
      const freshSnap = await freshHost.call('snapshot', {});
      assert.equal(freshSnap.ok, true);
      assert.ok(
        (freshSnap.value?.attempts?.length ?? 0) > beforeAttempts,
        'Fresh host must load persisted attempts from disk',
      );
    } finally {
      await freshHost.dispose();
    }

    // Exit review back to LibraryView
    tty.send('q');
    await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'ReviewView quit ConfirmDialog' },
    );
    tty.send('y');
    await tty.waitFor(
      (s) => s.includes('本轮练习总结') || s.includes('Round Summary'),
      { timeoutMs: 8_000, label: 'RoundSummary rendered' },
    );
    tty.send('b');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView after FSRS persistence test' },
    );
  });

  test('P1 #2: buildScopeChoices(oral) returns sample choices and wrongCount/dueToday read d.wrong/d.due', async () => {
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const snap = snapRes.value;

    const oralChoices = buildScopeChoices(snap, 'oral', 'zh');
    assert.ok(oralChoices.length > 0, 'Expected buildScopeChoices(snap, "oral", "zh") to return choices for sample course');
    const deckChoices = oralChoices.filter((c) => c.id.startsWith('deck:'));
    assert.ok(deckChoices.length > 0, 'Expected per-deck oral scope choices with count > 0');

    const syntheticSnap = {
      decks: [
        { id: 'd1', title: 'Deck 1', count: 10, due: 4, wrong: 3, archived: false },
        { id: 'd2', title: 'Deck 2', count: 5, due: 2, wrong: 1, archived: false },
        { id: 'd3', title: 'Archived', count: 8, due: 7, wrong: 9, archived: true },
      ],
    };
    assert.equal(wrongCount(syntheticSnap), 4, 'wrongCount must sum d.wrong for unarchived decks');
    assert.equal(dueToday(syntheticSnap), 6, 'dueToday fallback must sum d.due for unarchived decks');
    assert.equal(dueToday({ ...syntheticSnap, today: { due: 9 } }), 9, 'dueToday prefers snapshot.today.due');
  });

  test('P1 #16: groupSourcesFromSnapshot excludes historical, examPointList, and courseOutline sources', () => {
    const groups = groupSourcesFromSnapshot({
      sources: [
        { id: 'src-normal', title: 'Lecture 1.md', course: 'CS101', text: 'Core material content' },
        { id: 'src-hist', title: 'Lecture 1 (old)', course: 'CS101', historical: true, text: 'Old version' },
        {
          id: 'src-epl',
          title: 'Exam Point List',
          course: 'CS101',
          provenance: 'exam-blueprint',
          blueprint: { points: [{ title: 'P1' }] },
        },
        {
          id: 'src-outline',
          title: 'Course Outline',
          course: 'CS101',
          provenance: 'course-outline',
          courseOutline: { version: 1, nodes: [] },
        },
      ],
    });
    assert.equal(groups.length, 1, 'Only non-historical, non-library-list sources should remain');
    assert.deepEqual(groups[0].sourceIds, ['src-normal']);
  });

  test('P1 #18: DeckOpsModal & deck.import accept single-backslash LaTeX JSON', async () => {
    const latexDir = await makeTempDir('latex');
    const latexPath = join(latexDir, 'latex-single-backslash.json');
    const rawJsonWithSingleBackslash =
      '{"title":"LaTeX Single Backslash","course":"Math 101","cards":[{"kind":"quiz","topic":"Calculus","prompt":"Compute \\(\\alpha + \\frac{1}{2}\\)","options":[{"id":"a","text":"\\(\\alpha\\)","correct":true},{"id":"b","text":"0","correct":false}],"explanation":"Formula \\(\\alpha\\)"}]}';
    await writeFile(latexPath, rawJsonWithSingleBackslash, 'utf8');

    // Verify raw text is invalid standard JSON without TeX escape repair
    assert.throws(() => JSON.parse(rawJsonWithSingleBackslash), SyntaxError);

    // 1) Ensure we are on LibraryView and drive DeckOpsModal UI import in @xterm/headless
    if (useTuiStore.getState().page !== 'library') {
      tty.send('1');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
        { timeoutMs: 6_000, label: 'LibraryView active before DeckOpsModal' },
      );
    }
    tty.send('o');
    await tty.waitFor(
      (s) => s.includes('本地题组 JSON 路径') || s.includes('Local JSON Path'),
      { timeoutMs: 6_000, label: 'DeckOpsModal Import tab opened' },
    );

    tty.send(latexPath);
    await tty.waitFor(
      (s) => s.includes('1 题') || s.includes('1 cards') || s.includes('1题'),
      { timeoutMs: 6_000, label: 'DeckOpsModal previewed single-backslash LaTeX JSON' },
    );

    tty.send('\r');
    await tty.waitFor(
      (s) => !s.includes('本地题组 JSON 路径') && !s.includes('Local JSON Path'),
      { timeoutMs: 8_000, label: 'DeckOpsModal closed after LaTeX import' },
    );

    const snapAfterUi = await host.call('snapshot', {});
    assert.equal(snapAfterUi.ok, true);
    const importedDeck = (snapAfterUi.value?.decks ?? []).find((d) => d.title === 'LaTeX Single Backslash');
    assert.ok(importedDeck, 'Deck imported via DeckOpsModal must appear in snapshot');

    // 2) Also verify direct host.call('deck.import') accepts single-backslash LaTeX JSON
    const latexPath2 = join(latexDir, 'latex-direct.json');
    const rawJson2 =
      '{"title":"LaTeX Direct Import","course":"Math 101","cards":[{"kind":"quiz","topic":"Algebra","prompt":"Solve \\(\\beta = 1\\)","options":[{"id":"a","text":"1","correct":true},{"id":"b","text":"2","correct":false}],"explanation":"Direct \\(\\beta\\)"}]}';
    await writeFile(latexPath2, rawJson2, 'utf8');
    const directRes = await host.call('deck.import', { path: latexPath2 });
    assert.equal(directRes.ok, true, `deck.import failed: ${directRes.error?.message}`);
    assert.ok(
      Number(directRes.value?.added ?? directRes.value?.imported ?? directRes.value?.cards?.length ?? 1) >= 1,
      'Expected direct LaTeX JSON import to succeed',
    );
  });

  test('P2 confirm guards: ExamPrepView (0 -> g) and SkeletonView (8 -> g) open ConfirmDialog without calling model', async () => {
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const activeCourse =
      snapRes.value?.focus?.course ||
      (snapRes.value?.courses?.[0]?.name ?? snapRes.value?.courses?.[0]?.id ?? '示例 · Memento 与 Bridge');

    // Seed a missing focus topic so ExamPrepView 'g' opens the gap-fill ConfirmDialog
    const saveRes = await host.call('course.save', {
      name: activeCourse,
      focusTopics: ['Unseen Focus Gap Topic'],
    });
    assert.equal(saveRes.ok, true, `course.save failed: ${saveRes.error?.message}`);

    const refreshed = await host.call('snapshot', {});
    assert.equal(refreshed.ok, true);
    useTuiStore.getState().setSnapshot(refreshed.value);

    const originalCall = host.call.bind(host);
    let generateCalls = 0;
    host.call = async (action, args) => {
      if (action === 'generate') generateCalls += 1;
      return originalCall(action, args);
    };
    const modelBefore = modelCallCount;

    try {
      // 1) ExamPrepView (0 -> g)
      tty.send('0');
      const prepScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'examprep' &&
          (s.includes('备考补习') || s.includes('Exam Prep')) &&
          s.includes('Unseen Focus Gap Topic') &&
          !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'ExamPrepView rendered with missing focus topic' },
      );
      tty.assertHealthyScreen(prepScreen, 120, 36, 'ExamPrepView initial');

      tty.send('g');
      const prepConfirm = await tty.waitFor(
        (s) =>
          (s.includes('确认重点补齐出题') || s.includes('Confirm Gap-Fill Generation')) &&
          s.includes('(y)') &&
          s.includes('(n)'),
        { timeoutMs: 6_000, label: 'ExamPrepView g ConfirmDialog' },
      );
      tty.assertHealthyScreen(prepConfirm, 120, 36, 'ExamPrepView g ConfirmDialog');
      assert.equal(generateCalls, 0, 'ExamPrepView g must NOT call generate before confirmation');
      assert.equal(modelCallCount, modelBefore, 'ExamPrepView g must NOT call model before confirmation');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认重点补齐出题') && !s.includes('Confirm Gap-Fill Generation'),
        { timeoutMs: 6_000, label: 'ExamPrepView ConfirmDialog dismissed with n' },
      );
      assert.equal(generateCalls, 0, 'ExamPrepView cancel must NOT call generate');

      // 2) SkeletonView (8 -> g)
      tty.send('8');
      const skelScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'skeleton' &&
          (s.includes('知识层级树') || s.includes('Knowledge Tree') || s.includes('课程主题预览')) &&
          !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'SkeletonView rendered' },
      );
      tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView initial');

      tty.send('g');
      const skelConfirm = await tty.waitFor(
        (s) =>
          (s.includes('确认生成知识骨架') || s.includes('Confirm Skeleton Generation')) &&
          s.includes('(y)') &&
          s.includes('(n)'),
        { timeoutMs: 6_000, label: 'SkeletonView g ConfirmDialog' },
      );
      tty.assertHealthyScreen(skelConfirm, 120, 36, 'SkeletonView g ConfirmDialog');
      assert.equal(modelCallCount, modelBefore, 'SkeletonView g must NOT invoke model before confirmation');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认生成知识骨架') && !s.includes('Confirm Skeleton Generation'),
        { timeoutMs: 6_000, label: 'SkeletonView ConfirmDialog dismissed with n' },
      );
      assert.equal(modelCallCount, modelBefore, 'SkeletonView cancel must NOT invoke model');

      tty.send('1');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
        { timeoutMs: 6_000, label: 'Return to LibraryView' },
      );
    } finally {
      host.call = originalCall;
    }
  });
});
