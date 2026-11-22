// Round 37 Course Merge & Active/Inactive Toggle integration + E2E tests:
// node --test tests/round37-course-merge.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
let importLocalSource = null;
let saveTuiPreferences = null;
let displayWidth = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!importLocalSource && typeof mod.importLocalSource === 'function') importLocalSource = mod.importLocalSource;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(importLocalSource, 'dist/ must export importLocalSource');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round37-${label}-`));
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
  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, resolveWrite);
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

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

async function seedTwoCourses(host, baseDir, nameA = 'Algorithms Alpha', nameB = 'Algorithms Beta') {
  const c1Res = await host.call('course.save', {
    name: nameA,
    focusTopics: ['Dynamic Programming', 'Greedy'],
  });
  assert.equal(c1Res.ok, true, `course.save c1 failed: ${c1Res.error?.message}`);

  const c2Res = await host.call('course.save', {
    name: nameB,
    focusTopics: ['Graph Traversal', 'Greedy'],
    plan: { version: 1, notes: 'Beta study plan' },
  });
  assert.equal(c2Res.ok, true, `course.save c2 failed: ${c2Res.error?.message}`);

  const deck1Res = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'DP Foundations',
      course: nameA,
      cards: [
        { kind: 'flashcard', prompt: 'DP requires?', answer: 'Optimal substructure and overlapping subproblems.', topic: 'Dynamic Programming' },
      ],
    }),
    folder: nameA,
  });
  assert.equal(deck1Res.ok, true, `deck.import c1 failed: ${deck1Res.error?.message}`);
  assert.equal(deck1Res.value?.imported, 1, `deck1Res: ${JSON.stringify(deck1Res.value)}`);

  const deck2Res = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'BFS & DFS',
      course: nameB,
      cards: [
        { kind: 'flashcard', prompt: 'BFS uses?', answer: 'A FIFO queue.', topic: 'Graph Traversal' },
      ],
    }),
    folder: nameB,
  });
  assert.equal(deck2Res.ok, true, `deck.import c2 failed: ${deck2Res.error?.message}`);
  assert.equal(deck2Res.value?.imported, 1, `deck2Res: ${JSON.stringify(deck2Res.value)}`);

  const src1Path = join(baseDir, 'alpha-notes.md');
  const src2Path = join(baseDir, 'beta-notes.md');
  await writeFile(src1Path, '# Alpha\n\nDP notes.\n', 'utf8');
  await writeFile(src2Path, '# Beta\n\nGraph traversal notes.\n', 'utf8');
  const imp1 = await importLocalSource(host, { path: src1Path, title: 'Alpha Notes' });
  const imp2 = await importLocalSource(host, { path: src2Path, title: 'Beta Notes' });

  const assignRes = await host.call('source.courses.set', {
    assignments: [
      { id: imp1.sourceIds[0], courses: [nameA] },
      { id: imp2.sourceIds[0], courses: [nameB] },
    ],
  });
  assert.equal(assignRes.ok, true, `source.courses.set failed: ${assignRes.error?.message}`);

  return {
    c1: c1Res.value,
    c2: c2Res.value,
    source1Id: imp1.sourceIds[0],
    source2Id: imp2.sourceIds[0],
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Round 37: Course Merge & Active/Inactive Toggle', () => {
  test('1) createTuiHost integration: course.merge merges decks, sources, aliases, focusTopics and refuses self-merge', async () => {
    const base = await makeTempDir('merge-host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const { c1, c2 } = await seedTwoCourses(host, base);

      // Self-merge must be refused
      const selfMerge = await host.call('course.merge', { from: [c1.id], into: c1.id });
      assert.equal(selfMerge.ok, false, 'course.merge must refuse merging a course into itself');
      assert.ok(selfMerge.error?.message, 'self-merge refusal must include error message');

      // Merge c2 into c1
      const mergeRes = await host.call('course.merge', { from: [c2.id], into: c1.id });
      assert.equal(mergeRes.ok, true, `course.merge failed: ${mergeRes.error?.message}`);
      assert.deepEqual(mergeRes.value?.merged, [c2.id]);
      assert.equal(mergeRes.value?.course?.id, c1.id);
      assert.equal(mergeRes.value?.course?.name, 'Algorithms Alpha');
      assert.ok(mergeRes.value?.course?.aliases?.includes('Algorithms Beta'), 'merged course must keep source name as alias');
      assert.deepEqual(
        mergeRes.value?.course?.focusTopics?.slice().sort(),
        ['Dynamic Programming', 'Graph Traversal', 'Greedy'],
        'merged course must combine unique focusTopics',
      );
      assert.equal(mergeRes.value?.course?.decks, 2, 'merged course must own both decks');
      assert.ok((mergeRes.value?.course?.sources ?? 0) >= 2, 'merged course must own sources from both courses');
      assert.equal(mergeRes.value?.course?.plan?.notes, 'Beta study plan', 'merged course must inherit plan when target had none');

      // Snapshot reflects merged decks, sources, and removed source course
      const { snapshot } = await host.refreshSnapshot();
      assert.equal(snapshot.courses.some((c) => c.id === c2.id), false, 'source course record removed after merge');
      const alphaCoursesDecks = snapshot.decks.filter((d) => d.course === 'Algorithms Alpha');
      assert.equal(alphaCoursesDecks.length, 2, 'both decks belong to target course in snapshot');
      assert.ok(alphaCoursesDecks.some((d) => d.title === 'BFS & DFS'), 'merged deck relabeled to target course');
      const betaSource = snapshot.sources.find((s) => s.title === 'Beta Notes');
      assert.ok(betaSource, 'Beta Notes source present in snapshot');
      assert.ok(
        betaSource.course === 'Algorithms Alpha' || (Array.isArray(betaSource.courses) && betaSource.courses.includes('Algorithms Alpha')),
        'merged source points to target course',
      );
    } finally {
      await host.dispose();
    }
  });

  test('2) createTuiHost integration: course.deactivate and course.activate toggle course active state & due counts cleanly', async () => {
    const base = await makeTempDir('active-host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const { c1 } = await seedTwoCourses(host, base);

      // Initially active
      const initialGet = await host.call('course.get', { id: c1.id });
      assert.equal(initialGet.ok, true);
      assert.equal(initialGet.value?.active, true);

      // Deactivate by id
      const deactRes = await host.call('course.deactivate', { id: c1.id });
      assert.equal(deactRes.ok, true, `course.deactivate failed: ${deactRes.error?.message}`);
      assert.equal(deactRes.value?.id, c1.id);
      assert.equal(deactRes.value?.active, false);
      assert.equal(deactRes.value?.changed, true);
      assert.equal(deactRes.value?.decks, 1);

      const afterDeactGet = await host.call('course.get', { id: c1.id });
      assert.equal(afterDeactGet.ok, true);
      assert.equal(afterDeactGet.value?.active, false);

      // Snapshot reflects inactive course and marks its deck inactive
      const snapDeact = await host.refreshSnapshot();
      const snapCourseDeact = snapDeact.snapshot.courses.find((c) => c.id === c1.id);
      assert.equal(snapCourseDeact?.active, false, 'snapshot course should be active:false');
      const snapDeckDeact = snapDeact.snapshot.decks.find((d) => d.course === 'Algorithms Alpha');
      assert.equal(snapDeckDeact?.inactive, true, 'snapshot deck under deactivated course should be marked inactive');

      // Re-activate by id
      const actRes = await host.call('course.activate', { id: c1.id });
      assert.equal(actRes.ok, true, `course.activate failed: ${actRes.error?.message}`);
      assert.equal(actRes.value?.id, c1.id);
      assert.equal(actRes.value?.active, true);
      assert.equal(actRes.value?.changed, true);
      assert.equal(actRes.value?.decks, 1);

      const snapAct = await host.refreshSnapshot();
      const snapCourseAct = snapAct.snapshot.courses.find((c) => c.id === c1.id);
      assert.equal(snapCourseAct?.active, true, 'snapshot course should be active:true after activate');
    } finally {
      await host.dispose();
    }
  });

  test('3) E2E UI (--ascii): CourseSettingsModal Tab 2 active toggle (a) and course merge (m -> Select -> Confirm)', async () => {
    const base = await makeTempDir('ui-e2e');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: true });
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    await seedTwoCourses(host, base);

    const tty = createVirtualTty(120, 36);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Algorithms Alpha'), { timeoutMs: 10_000, label: 'LibraryView loaded' });

      // Open CourseSettingsModal ('C')
      tty.send('C');
      const opened = await tty.waitFor(
        (s) => s.includes('课程设置与学法') && !s.includes('正在读取课程配置'),
        { timeoutMs: 8_000, label: 'CourseSettingsModal opened' },
      );
      if (opened.includes('选择要配置的课程')) {
        tty.send('\r');
        await tty.waitFor((s) => !s.includes('选择要配置的课程') && !s.includes('正在读取课程配置'), {
          timeoutMs: 8_000,
          label: 'Course selected',
        });
      }

      // Switch to Tab 2 (Info & Rename)
      tty.send('2');
      const tab2 = await tty.waitFor(
        (s) => s.includes('课程名称') && s.includes('合并其他课程到此课程') && s.includes('停用课程'),
        { timeoutMs: 8_000, label: 'CourseSettingsModal Tab 2 with merge & active toggle' },
      );
      tty.assertHealthyScreen(tab2, 120, 36, 'CourseSettingsModal Tab 2');
      tty.assertAsciiPure(tab2, 'CourseSettingsModal Tab 2 ascii');

      // Toggle active -> deactivated ('a')
      tty.send('a');
      const deactivatedScreen = await tty.waitFor(
        (s) => s.includes('未激活') && s.includes('激活课程'),
        { timeoutMs: 8_000, label: 'Course deactivated in modal' },
      );
      tty.assertHealthyScreen(deactivatedScreen, 120, 36, 'CourseSettingsModal deactivated');
      tty.assertAsciiPure(deactivatedScreen, 'CourseSettingsModal deactivated ascii');

      // Toggle active -> activated ('a')
      tty.send('a');
      const activatedScreen = await tty.waitFor(
        (s) => s.includes('已激活') && s.includes('停用课程'),
        { timeoutMs: 8_000, label: 'Course reactivated in modal' },
      );
      tty.assertHealthyScreen(activatedScreen, 120, 36, 'CourseSettingsModal reactivated');

      // Open merge picker ('m')
      tty.send('m');
      const pickerScreen = await tty.waitFor(
        (s) => s.includes('选择要并入') && s.includes('Algorithms Beta'),
        { timeoutMs: 8_000, label: 'Merge course picker opened' },
      );
      tty.assertHealthyScreen(pickerScreen, 120, 36, 'Merge picker');
      tty.assertAsciiPure(pickerScreen, 'Merge picker ascii');

      // Select the other course ('\r') -> ConfirmDialog appears
      tty.send('\r');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认合并课程') && s.includes('Algorithms Beta'),
        { timeoutMs: 8_000, label: 'Confirm course merge dialog' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'Confirm merge dialog');
      tty.assertAsciiPure(confirmScreen, 'Confirm merge dialog ascii');

      // Confirm merge ('y') -> back to Tab 2 showing alias & updated deck count
      tty.send('y');
      const mergedScreen = await tty.waitFor(
        (s) => s.includes('旧称别名') && s.includes('Algorithms Beta') && s.includes('2 题组'),
        { timeoutMs: 8_000, label: 'Course merged & refreshed in Tab 2' },
      );
      tty.assertHealthyScreen(mergedScreen, 120, 36, 'CourseSettingsModal after merge');
      tty.assertAsciiPure(mergedScreen, 'CourseSettingsModal after merge ascii');

      // Close modal ('Esc')
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('课程设置与学法'), { timeoutMs: 8_000, label: 'CourseSettingsModal closed' });
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
