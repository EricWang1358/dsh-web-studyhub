// Round 26 Features E2E verification: node --test tests/round26-e2e.test.mjs
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

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

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
const H = { createTuiHost };
const R = { displayWidth };

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round26-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;
const UNICODE_ARROW_RE = /[\u2190-\u21ff\u25b8\u276f]/g;
const UNICODE_CHROME_ARROW_RE = /[\u2190\u2191\u2193\u25b8\u276f]/g;

/**
 * Creates a real Ink-compatible virtual TTY backed by `@xterm/headless`.
 */
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

  function assertAsciiPure(screen, contextLabel, { allowRightArrowInHint = false } = {}) {
    const boxMatch = screen.match(UNICODE_BOX_RE);
    assert.equal(
      boxMatch,
      null,
      `${contextLabel}: Unicode box-drawing chars leaked in --ascii mode: ${JSON.stringify(boxMatch ? [...new Set(boxMatch)] : [])}\n${screen}`,
    );
    const blockMatch = screen.match(UNICODE_BLOCK_RE);
    assert.equal(
      blockMatch,
      null,
      `${contextLabel}: Unicode block elements leaked in --ascii mode: ${JSON.stringify(blockMatch ? [...new Set(blockMatch)] : [])}\n${screen}`,
    );
    const brailleMatch = screen.match(UNICODE_BRAILLE_RE);
    assert.equal(
      brailleMatch,
      null,
      `${contextLabel}: Unicode Braille chars leaked in --ascii mode: ${JSON.stringify(brailleMatch ? [...new Set(brailleMatch)] : [])}\n${screen}`,
    );
    const arrowRe = allowRightArrowInHint ? UNICODE_CHROME_ARROW_RE : UNICODE_ARROW_RE;
    const arrowMatch = screen.match(arrowRe);
    assert.equal(
      arrowMatch,
      null,
      `${contextLabel}: Unicode arrow chars leaked in --ascii mode: ${JSON.stringify(arrowMatch ? [...new Set(arrowMatch)] : [])}\n${screen}`,
    );
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

function createRound26StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 26 Features E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let disposed = false;

  async function cleanupAll() {
    if (disposed) return;
    disposed = true;
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors during primary teardown
    }
    await host?.dispose();
    tty?.dispose();
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
      injectedComplete: createRound26StubComplete(),
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
  });

  after(async () => {
    try {
      await cleanupAll();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) SkeletonView [R] CourseRouteModal (8 -> R): 120x36 & 80x24, --ascii purity, Enter -> ReviewView -> Exit to LibraryView', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        s.includes('示例 · Memento 与 Bridge') &&
        s.includes('示例案例 · 墨笺笔记'),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    await tty.flush();

    // Navigate to SkeletonView ('8')
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton') &&
        (s.includes('释义:') || s.includes('Description:') || s.includes('节点检视器') || s.includes('Node Inspector')),
      { timeoutMs: 10_000, label: 'SkeletonView rendered at 120x36' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView at 120x36');

    // Open CourseRouteModal via 'R'
    tty.send('R');
    const routeWide = await tty.waitFor(
      (s) =>
        (s.includes('课程学习路线') || s.includes('Course Route')) &&
        !s.includes('正在加载课程路线') &&
        !s.includes('Loading course route') &&
        (s.includes('总进度') || s.includes('Route')) &&
        (s.includes('章') || s.includes(' ch')) &&
        (s.includes('[▶]') || s.includes('[✔]') || s.includes('[◐]') || s.includes('[○]')),
      { timeoutMs: 8_000, label: 'CourseRouteModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(routeWide, 120, 36, 'CourseRouteModal at 120x36');

    // Verify 80x24 responsive layout
    tty.resize(80, 24);
    const routeNarrow = await tty.waitFor(
      (s) =>
        (s.includes('课程学习路线') || s.includes('Course Route')) &&
        (s.includes('总进度') || s.includes('Route')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'CourseRouteModal at 80x24' },
    );
    tty.assertHealthyScreen(routeNarrow, 80, 24, 'CourseRouteModal at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('课程学习路线') || s.includes('Course Route')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'CourseRouteModal restored to 120x36' },
    );

    // Verify --ascii purity (zero Unicode leaks)
    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const routeAscii = await tty.waitFor(
        (s) =>
          (s.includes('> 课程学习路线') || s.includes('> Course Route')) &&
          s.includes('esc x') &&
          !s.includes('╭'),
        { timeoutMs: 6_000, label: 'CourseRouteModal rendered in --ascii mode' },
      );
      tty.assertHealthyScreen(routeAscii, 120, 36, 'CourseRouteModal --ascii at 120x36');
      tty.assertAsciiPure(routeAscii, 'CourseRouteModal --ascii at 120x36');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor(
        (s) => s.includes('◈ 课程学习路线') || s.includes('◈ Course Route'),
        { timeoutMs: 6_000, label: 'CourseRouteModal restored to Unicode mode' },
      );
    }

    // Press Enter on selected chapter -> navigate to ReviewView cleanly
    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('课程学习路线') &&
        !s.includes('Course Route') &&
        !s.includes('正在准备复习队列') &&
        !s.includes('Preparing review queue') &&
        (s.includes('[h]AI讲解') || s.includes('[h]AI Help') || s.includes('1/')),
      { timeoutMs: 10_000, label: 'ReviewView started from CourseRouteModal' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView from CourseRouteModal');

    // Exit review (q -> y -> b) back to LibraryView
    tty.send('q');
    await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'ReviewView End Round ConfirmDialog' },
    );
    tty.send('y');
    await tty.waitFor(
      (s) => s.includes('本轮练习总结') || s.includes('Round Summary'),
      { timeoutMs: 8_000, label: 'ReviewView RoundSummary after q -> y' },
    );
    tty.send('b');
    const libBack = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        s.includes('示例 · Memento 与 Bridge'),
      { timeoutMs: 8_000, label: 'LibraryView after q -> y -> b' },
    );
    tty.assertHealthyScreen(libBack, 120, 36, 'LibraryView after exiting ReviewView');
  });

  test('2) SkeletonView [G] TopicGroupsModal (8 -> G): Tab 1 120x36/80x24/--ascii, Tab 2 create & Ctrl+S persist, Esc close', async () => {
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton'),
      { timeoutMs: 10_000, label: 'SkeletonView active for TopicGroupsModal' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView before [G]');

    // Open TopicGroupsModal via 'G'
    tty.send('G');
    const groupsWide = await tty.waitFor(
      (s) =>
        (s.includes('主题分组管理') || s.includes('Topic Groups')) &&
        !s.includes('正在加载主题与分组') &&
        !s.includes('Loading topics & groups') &&
        (s.includes('分组列表') || s.includes('Groups')) &&
        (s.includes('已建分组') || s.includes('Groups:')),
      { timeoutMs: 8_000, label: 'TopicGroupsModal Tab 1 at 120x36' },
    );
    tty.assertHealthyScreen(groupsWide, 120, 36, 'TopicGroupsModal Tab 1 at 120x36');

    // 80x24 layout check
    tty.resize(80, 24);
    const groupsNarrow = await tty.waitFor(
      (s) =>
        (s.includes('主题分组管理') || s.includes('Topic Groups')) &&
        (s.includes('分组列表') || s.includes('Groups')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'TopicGroupsModal Tab 1 at 80x24' },
    );
    tty.assertHealthyScreen(groupsNarrow, 80, 24, 'TopicGroupsModal Tab 1 at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('主题分组管理') || s.includes('Topic Groups')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'TopicGroupsModal restored to 120x36' },
    );

    // --ascii purity check on Tab 1
    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const groupsAscii = await tty.waitFor(
        (s) =>
          (s.includes('# 主题分组管理') || s.includes('# Topic Groups')) &&
          s.includes('esc x') &&
          !s.includes('╭'),
        { timeoutMs: 6_000, label: 'TopicGroupsModal Tab 1 in --ascii mode' },
      );
      tty.assertHealthyScreen(groupsAscii, 120, 36, 'TopicGroupsModal Tab 1 --ascii');
      tty.assertAsciiPure(groupsAscii, 'TopicGroupsModal Tab 1 --ascii');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor(
        (s) => s.includes('▦ 主题分组管理') || s.includes('▦ Topic Groups'),
        { timeoutMs: 6_000, label: 'TopicGroupsModal restored to Unicode mode' },
      );
    }

    // Switch to Tab 2 ('2' -> New Group)
    tty.send('2');
    const createTab = await tty.waitFor(
      (s) =>
        (s.includes('分组名称:') || s.includes('Group Title:')) &&
        (s.includes('选择包含主题') || s.includes('Select Topics')),
      { timeoutMs: 6_000, label: 'TopicGroupsModal Tab 2 (New Group)' },
    );
    tty.assertHealthyScreen(createTab, 120, 36, 'TopicGroupsModal Tab 2 at 120x36');

    // Enter group title
    const groupTitle = 'R26Group';
    tty.send(groupTitle);
    await tty.waitFor(
      (s) => s.includes(groupTitle),
      { timeoutMs: 5_000, label: 'Group title typed in Tab 2' },
    );

    // Move focus to topic list (Tab) and select first topic (Space)
    tty.send('\t');
    await sleep(60);
    await tty.flush();
    tty.send(' ');
    await tty.waitFor(
      (s) =>
        (s.includes('已选 1') || s.includes('1 selected')) &&
        (s.includes('[✓]') || s.includes('[x]')),
      { timeoutMs: 5_000, label: 'First topic selected via Space' },
    );

    // Save via Ctrl+S (\x13)
    tty.send('\x13');
    const savedGroupsView = await tty.waitFor(
      (s) =>
        !s.includes('正在保存分组') &&
        !s.includes('Saving topic group') &&
        (s.includes('已建分组') || s.includes('Groups:')) &&
        s.includes(groupTitle),
      { timeoutMs: 8_000, label: 'TopicGroupsModal returned to Tab 1 with saved group' },
    );
    tty.assertHealthyScreen(savedGroupsView, 120, 36, 'TopicGroupsModal after saving R26Group');

    // Verify persistence via host.call('skeleton.topics', ...)
    const activeCourse = useTuiStore.getState().activeCourse;
    const topicsRes = await host.call('skeleton.topics', activeCourse ? { course: activeCourse } : {});
    assert.equal(topicsRes.ok, true, 'skeleton.topics must succeed after saving group');
    const persistedGroups = topicsRes.value?.groups?.groups ?? [];
    const savedEntry = persistedGroups.find((g) => g.title === groupTitle);
    assert.ok(savedEntry, `Expected persisted group "${groupTitle}" in skeleton.topics, got ${JSON.stringify(persistedGroups)}`);
    assert.ok(Array.isArray(savedEntry.topics) && savedEntry.topics.length >= 1, 'Persisted group must contain at least 1 topic');

    // Close modal via Esc
    tty.send('\x1b');
    const afterEsc = await tty.waitFor(
      (s) =>
        !s.includes('主题分组管理') &&
        !s.includes('Topic Groups') &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'TopicGroupsModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterEsc, 120, 36, 'SkeletonView after TopicGroupsModal Esc');
  });

  test('3) SkeletonView [E] NodeEditModal (8 -> E): 120x36, 80x24, --ascii purity, edit term & Ctrl+S persist', async () => {
    if (useTuiStore.getState().page !== 'skeleton') {
      tty.send('8');
    }
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton') &&
        (s.includes('释义:') || s.includes('Description:')),
      { timeoutMs: 8_000, label: 'SkeletonView active for NodeEditModal' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView before [E]');

    // Read current skeleton from host to inspect original node term
    const activeCourse = useTuiStore.getState().activeCourse;
    const listRes = await host.call('skeleton.list', activeCourse ? { course: activeCourse } : {});
    assert.equal(listRes.ok, true, 'skeleton.list must succeed');
    const skeletonId = listRes.value?.skeletons?.[0]?.id;
    assert.ok(skeletonId, 'Expected at least one skeleton in sample course');
    const beforeSkelRes = await host.call('skeleton.get', { id: skeletonId });
    assert.equal(beforeSkelRes.ok, true, 'skeleton.get before edit must succeed');

    // Open NodeEditModal via 'E'
    tty.send('E');
    const editWide = await tty.waitFor(
      (s) =>
        (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) &&
        (s.includes('概念名称') || s.includes('Node Term:')),
      { timeoutMs: 6_000, label: 'NodeEditModal opened at 120x36' },
    );
    tty.assertHealthyScreen(editWide, 120, 36, 'NodeEditModal at 120x36');

    // Identify which node is open via its id in modal subtitle or fallback to first node
    const targetNode =
      beforeSkelRes.value.nodes.find((n) => editWide.includes(n.id)) ?? beforeSkelRes.value.nodes[0];
    assert.ok(targetNode, 'Expected target skeleton node to edit');
    const expectedTerm = `${targetNode.term} R26`;

    // 80x24 layout check
    tty.resize(80, 24);
    const editNarrow = await tty.waitFor(
      (s) =>
        (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'NodeEditModal at 80x24' },
    );
    tty.assertHealthyScreen(editNarrow, 80, 24, 'NodeEditModal at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'NodeEditModal restored to 120x36' },
    );

    // --ascii purity check
    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const editAscii = await tty.waitFor(
        (s) =>
          (s.includes('* 编辑知识节点') || s.includes('* Edit Knowledge Node')) &&
          s.includes('esc x') &&
          !s.includes('╭'),
        { timeoutMs: 6_000, label: 'NodeEditModal in --ascii mode' },
      );
      tty.assertHealthyScreen(editAscii, 120, 36, 'NodeEditModal --ascii at 120x36');
      tty.assertAsciiPure(editAscii, 'NodeEditModal --ascii at 120x36');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor(
        (s) => s.includes('✎ 编辑知识节点') || s.includes('✎ Edit Knowledge Node'),
        { timeoutMs: 6_000, label: 'NodeEditModal restored to Unicode mode' },
      );
    }

    // Append ' R26' to term and save via Ctrl+S (\x13)
    tty.send(' R26');
    await tty.waitFor(
      (s) => s.includes('R26'),
      { timeoutMs: 5_000, label: 'NodeEditModal term suffix R26 typed' },
    );
    tty.send('\x13');

    const afterSave = await tty.waitFor(
      (s) =>
        !s.includes('编辑知识节点') &&
        !s.includes('Edit Knowledge Node') &&
        !s.includes('正在保存节点') &&
        s.includes(expectedTerm) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 8_000, label: 'SkeletonView updated with patched node term' },
    );
    tty.assertHealthyScreen(afterSave, 120, 36, 'SkeletonView after NodeEditModal Ctrl+S');

    // Verify skeleton.patch persisted in host.call('skeleton.get', ...)
    const afterSkelRes = await host.call('skeleton.get', { id: skeletonId });
    assert.equal(afterSkelRes.ok, true, 'skeleton.get after patch must succeed');
    const patchedNode = afterSkelRes.value?.nodes?.find((n) => n.id === targetNode.id);
    assert.ok(patchedNode, `Expected node ${targetNode.id} in skeleton.get response`);
    assert.equal(
      patchedNode.term,
      expectedTerm,
      `Expected persisted node.term to equal "${expectedTerm}", got "${patchedNode.term}"`,
    );
  });
});
