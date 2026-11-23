// Consolidated Library Courses Domain Suite
// Merges: round37-course-merge, round41-course-terms, round64-terms-attach
// node --test tests/domain-library-courses.test.mjs
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences, hostMod } = await loadDistRuntime();
const { importLocalSource } = hostMod;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(importLocalSource, 'dist/ must export importLocalSource');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-courses-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

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

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
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
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
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

async function seedCourseWithCards(host, courseName = 'Computer Networks') {
  const cRes = await host.call('course.save', {
    name: courseName,
    focusTopics: ['BGP', 'Ingress Filtering'],
  });
  assert.equal(cRes.ok, true, `course.save failed: ${cRes.error?.message}`);

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Edge Routing',
      course: courseName,
      cards: [
        {
          kind: 'flashcard',
          prompt: 'Explain BCP38 primary goal in edge networks.',
          answer: 'Prevents source IP spoofing via ingress filtering.',
          topic: 'Ingress Filtering',
        },
        {
          kind: 'flashcard',
          prompt: 'Explain BCP38 deployment caveats at multihomed AS borders.',
          answer: 'Asymmetric routing requires loose-mode uRPF.',
          topic: 'BGP',
        },
      ],
    }),
    folder: courseName,
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
  const snap = await host.refreshSnapshot();
  const deck = snap.snapshot.decks.find((d) => d.course === courseName);
  assert.ok(deck, 'seeded deck should exist in snapshot');
  const deckGet = await host.call('deck.get', { id: deck.id });
  assert.equal(deckGet.ok, true);
  const cards = deckGet.value?.cards ?? [];
  assert.equal(cards.length, 2, 'expected 2 seeded cards');
  return { course: cRes.value, deckId: deck.id, cardId: cards[0].id, cards };
}

describe('Round 37: Course Merge & Active/Inactive Toggle', () => {
  test('1) createTuiHost integration: course.merge merges decks, sources, aliases, focusTopics and refuses self-merge', async () => {
    const base = await temps.make('r37-merge');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
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

      const selfMerge = await host.call('course.merge', { from: [c1.id], into: c1.id });
      assert.equal(selfMerge.ok, false, 'course.merge must refuse merging a course into itself');
      assert.ok(selfMerge.error?.message, 'self-merge refusal must include error message');

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
    const base = await temps.make('r37-active');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
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

      const initialGet = await host.call('course.get', { id: c1.id });
      assert.equal(initialGet.ok, true);
      assert.equal(initialGet.value?.active, true);

      const deactRes = await host.call('course.deactivate', { id: c1.id });
      assert.equal(deactRes.ok, true, `course.deactivate failed: ${deactRes.error?.message}`);
      assert.equal(deactRes.value?.id, c1.id);
      assert.equal(deactRes.value?.active, false);
      assert.equal(deactRes.value?.changed, true);
      assert.equal(deactRes.value?.decks, 1);

      const afterDeactGet = await host.call('course.get', { id: c1.id });
      assert.equal(afterDeactGet.ok, true);
      assert.equal(afterDeactGet.value?.active, false);

      const snapDeact = await host.refreshSnapshot();
      const snapCourseDeact = snapDeact.snapshot.courses.find((c) => c.id === c1.id);
      assert.equal(snapCourseDeact?.active, false, 'snapshot course should be active:false');
      const snapDeckDeact = snapDeact.snapshot.decks.find((d) => d.course === 'Algorithms Alpha');
      assert.equal(snapDeckDeact?.inactive, true, 'snapshot deck under deactivated course should be marked inactive');

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
    const base = await temps.make('r37-ui');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: true }, { env });
    resetDistStore('zh', true);
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    const { c1, c2 } = await seedTwoCourses(host, base);

    const tty = createVirtualTty(120, 36);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Algorithms Alpha'), { timeoutMs: 10_000, label: 'LibraryView loaded' });

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

      tty.send('2');
      const tab2 = await tty.waitFor(
        (s) => s.includes('课程名称') && s.includes('合并其他课程到此课程') && s.includes('停用课程'),
        { timeoutMs: 8_000, label: 'CourseSettingsModal Tab 2 with merge & active toggle' },
      );
      tty.assertHealthyScreen(tab2, 120, 36, 'CourseSettingsModal Tab 2');
      tty.assertAsciiPure(tab2, 'CourseSettingsModal Tab 2 ascii');
      assert.ok(tab2.includes('Algorithms Alpha'));
      assert.ok(tab2.includes('已激活'));

      tty.send('a');
      const deactivatedScreen = await tty.waitFor(
        (s) => s.includes('未激活') && s.includes('激活课程'),
        { timeoutMs: 8_000, label: 'Course deactivated in modal' },
      );
      tty.assertHealthyScreen(deactivatedScreen, 120, 36, 'CourseSettingsModal deactivated');
      tty.assertAsciiPure(deactivatedScreen, 'CourseSettingsModal deactivated ascii');
      assert.ok(deactivatedScreen.includes('未激活'));
      const deactCheck = await host.call('course.get', { id: c1.id });
      assert.equal(deactCheck.ok, true);
      assert.equal(deactCheck.value?.active, false);

      tty.send('a');
      const activatedScreen = await tty.waitFor(
        (s) => s.includes('已激活') && s.includes('停用课程'),
        { timeoutMs: 8_000, label: 'Course reactivated in modal' },
      );
      tty.assertHealthyScreen(activatedScreen, 120, 36, 'CourseSettingsModal reactivated');
      assert.ok(activatedScreen.includes('已激活'));
      const reactCheck = await host.call('course.get', { id: c1.id });
      assert.equal(reactCheck.ok, true);
      assert.equal(reactCheck.value?.active, true);

      tty.send('m');
      const pickerScreen = await tty.waitFor(
        (s) => s.includes('选择要并入') && s.includes('Algorithms Beta'),
        { timeoutMs: 8_000, label: 'Merge course picker opened' },
      );
      tty.assertHealthyScreen(pickerScreen, 120, 36, 'Merge picker');
      tty.assertAsciiPure(pickerScreen, 'Merge picker ascii');
      assert.ok(pickerScreen.includes('Algorithms Beta'));

      tty.send('\r');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认合并课程') && s.includes('Algorithms Beta'),
        { timeoutMs: 8_000, label: 'Confirm course merge dialog' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'Confirm merge dialog');
      tty.assertAsciiPure(confirmScreen, 'Confirm merge dialog ascii');
      assert.ok(confirmScreen.includes('确认合并课程'));

      tty.send('y');
      const mergedScreen = await tty.waitFor(
        (s) => s.includes('旧称别名') && s.includes('Algorithms Beta') && s.includes('2 题组'),
        { timeoutMs: 8_000, label: 'Course merged & refreshed in Tab 2' },
      );
      tty.assertHealthyScreen(mergedScreen, 120, 36, 'CourseSettingsModal after merge');
      tty.assertAsciiPure(mergedScreen, 'CourseSettingsModal after merge ascii');
      assert.ok(mergedScreen.includes('旧称别名'));
      assert.ok(mergedScreen.includes('2 题组'));

      const afterMergeSnap = await host.refreshSnapshot();
      assert.equal(afterMergeSnap.snapshot.courses.some((c) => c.id === c2.id), false);
      const mergedCourseSnap = afterMergeSnap.snapshot.courses.find((c) => c.id === c1.id);
      assert.ok(mergedCourseSnap);
      assert.ok(mergedCourseSnap.aliases?.includes('Algorithms Beta'));

      tty.send('\x1b');
      const closedScreen = await tty.waitFor((s) => !s.includes('课程设置与学法'), { timeoutMs: 8_000, label: 'CourseSettingsModal closed' });
      assert.ok(!closedScreen.includes('课程设置与学法'));
    } finally {
      try {
        app?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

describe('Round 41: Course Glossary Term Mastery Marking', () => {
  test('1) createTuiHost integration: course.terms.mark -> course.terms.unmark -> course.terms.clear with disk persistence', async () => {
    const base = await temps.make('r41-terms-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const home = join(base, 'home');
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      env,
      home,
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const { deckId, cardId } = await seedCourseWithCards(host, 'Computer Networks');

      const initTerms = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(initTerms.ok, true);
      assert.deepEqual(initTerms.value?.items, []);

      const markRes = await host.call('course.terms.mark', {
        course: 'Computer Networks',
        terms: ['BCP38', 'bcp38', 'Ingress Filtering'],
        from: { deckId, cardId },
      });
      assert.equal(markRes.ok, true, `course.terms.mark failed: ${markRes.error?.message}`);
      assert.equal(markRes.value?.added, 2);
      assert.equal(markRes.value?.items?.length, 2);

      const dupMark = await host.call('course.terms.mark', {
        course: 'Computer Networks',
        terms: ['BCP38'],
      });
      assert.equal(dupMark.ok, true);
      assert.equal(dupMark.value?.added, 0);

      const gotAfterMark = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(gotAfterMark.ok, true);
      assert.equal(gotAfterMark.value?.items?.length, 2);
      assert.equal(gotAfterMark.value.items[0].state, 'unknown');
      assert.ok(gotAfterMark.value.items[0].fromPrompt?.includes('BCP38'));
    } finally {
      await host.dispose();
    }

    const host2 = await createTuiHost({
      env,
      home,
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const persisted = await host2.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(persisted.ok, true);
      assert.deepEqual(
        persisted.value?.items?.map((i) => i.term),
        ['BCP38', 'Ingress Filtering'],
      );

      const unmarkRes = await host2.call('course.terms.unmark', {
        course: 'Computer Networks',
        terms: ['bcp38'],
      });
      assert.equal(unmarkRes.ok, true, `course.terms.unmark failed: ${unmarkRes.error?.message}`);
      assert.equal(unmarkRes.value?.removed, 1);
      assert.equal(unmarkRes.value?.items?.length, 1);

      const afterUnmark = await host2.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterUnmark.ok, true);
      assert.deepEqual(
        afterUnmark.value?.items?.map((i) => i.term),
        ['Ingress Filtering'],
      );

      const clearRes = await host2.call('course.terms.clear', { course: 'Computer Networks' });
      assert.equal(clearRes.ok, true, `course.terms.clear failed: ${clearRes.error?.message}`);
      assert.equal(clearRes.value?.cleared, true);
      assert.deepEqual(clearRes.value?.items, []);

      const afterClear = await host2.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterClear.ok, true);
      assert.deepEqual(afterClear.value?.items, []);
    } finally {
      await host2.dispose();
    }
  });

  test('2) E2E UI (zh): CourseSettingsModal Terms tab [Space] toggle & [C] clear ConfirmDialog Esc/n cancel & y confirm', async () => {
    const base = await temps.make('r41-terms-ui');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    const { deckId, cardId } = await seedCourseWithCards(host, 'Computer Networks');
    await host.call('course.terms.mark', {
      course: 'Computer Networks',
      terms: ['BCP38', 'Ingress Filtering'],
      from: { deckId, cardId },
    });

    const tty = createVirtualTty(120, 36);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Computer Networks'), { timeoutMs: 10_000, label: 'LibraryView loaded' });

      tty.send('C');
      await tty.waitFor((s) => s.includes('课程设置与学法') && !s.includes('正在读取课程配置'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal opened',
      });
      tty.send('3');
      const termsScreen = await tty.waitFor(
        (s) => s.includes('BCP38') && s.includes('Ingress Filtering') && s.includes('☑') && s.includes('共 2'),
        { timeoutMs: 8_000, label: 'Terms tab rendered with marked badges' },
      );
      tty.assertHealthyScreen(termsScreen, 120, 36, 'Terms tab zh');
      assert.ok(termsScreen.includes('BCP38'));
      assert.ok(termsScreen.includes('Ingress Filtering'));

      // Toggle highlighted term (BCP38) off via Space -> course.terms.unmark
      tty.send(' ');
      const unmarkedScreen = await tty.waitFor(
        (s) => s.includes('☐') && s.includes('已移出') && s.includes('共 1') && !s.includes('保存中') && !s.includes('处理中'),
        { timeoutMs: 8_000, label: 'Term unmarked via Space' },
      );
      tty.assertHealthyScreen(unmarkedScreen, 120, 36, 'Terms tab after unmark zh');
      assert.ok(unmarkedScreen.includes('☐'));
      assert.ok(unmarkedScreen.includes('共 1'));
      const midTerms = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(midTerms.ok, true);
      assert.deepEqual(
        midTerms.value?.items?.map((i) => i.term),
        ['Ingress Filtering'],
      );

      // Toggle highlighted term (BCP38) back on via Space -> course.terms.mark
      await tty.flush(50);
      tty.send(' ');
      const remarkedScreen = await tty.waitFor(
        (s) =>
          !s.includes('☐') &&
          s.includes('☑') &&
          s.includes('共 2') &&
          !s.includes('保存中') &&
          !s.includes('处理中'),
        { timeoutMs: 8_000, label: 'Term re-marked via Space' },
      );
      tty.assertHealthyScreen(remarkedScreen, 120, 36, 'Terms tab after re-mark zh');
      assert.ok(remarkedScreen.includes('☑'));
      assert.ok(remarkedScreen.includes('共 2'));
      const restoredTerms = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(restoredTerms.ok, true);
      assert.equal(restoredTerms.value?.items?.length, 2);

      // Let React commit busy=false before pressing 'C'
      await tty.flush(50);

      // Open [C] clear ConfirmDialog and cancel via Esc
      tty.send('C');
      const confirmEscScreen = await tty.waitFor(
        (s) => s.includes('确认清空课程术语') && s.includes('Computer Networks'),
        { timeoutMs: 8_000, label: 'Clear terms ConfirmDialog opened for Esc cancel (zh)' },
      );
      tty.assertHealthyScreen(confirmEscScreen, 120, 36, 'Clear terms ConfirmDialog Esc zh');
      assert.ok(confirmEscScreen.includes('确认清空课程术语'));
      tty.send('\x1b');
      const afterEscScreen = await tty.waitFor(
        (s) => !s.includes('确认清空课程术语') && s.includes('BCP38') && s.includes('共 2'),
        { timeoutMs: 8_000, label: 'Clear terms cancelled via Esc (zh)' },
      );
      assert.ok(!afterEscScreen.includes('确认清空课程术语'));
      const afterEscCancel = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterEscCancel.ok, true);
      assert.equal(afterEscCancel.value?.items?.length, 2, 'Esc cancel clear must preserve terms');

      // Open [C] clear ConfirmDialog and cancel with 'n'
      tty.send('C');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认清空课程术语') && s.includes('Computer Networks'),
        { timeoutMs: 8_000, label: 'Clear terms ConfirmDialog opened (zh)' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'Clear terms ConfirmDialog zh');

      tty.send('n');
      const afterCancelScreen = await tty.waitFor(
        (s) => !s.includes('确认清空课程术语') && s.includes('BCP38') && s.includes('共 2'),
        { timeoutMs: 8_000, label: 'Clear terms cancelled with n (zh)' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'Terms tab after cancel clear zh');
      assert.ok(afterCancelScreen.includes('BCP38'));
      const afterCancel = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterCancel.ok, true);
      assert.equal(afterCancel.value?.items?.length, 2, 'Cancel clear must preserve terms');

      // Open [C] again and confirm with 'y' -> course.terms.clear
      tty.send('C');
      await tty.waitFor((s) => s.includes('确认清空课程术语'), {
        timeoutMs: 8_000,
        label: 'Clear terms ConfirmDialog reopened (zh)',
      });
      tty.send('y');
      const afterConfirmClear = await tty.waitFor(
        (s) => !s.includes('确认清空课程术语') && s.includes('该课程暂无提取术语') && s.includes('共 0'),
        { timeoutMs: 8_000, label: 'Terms cleared after confirm (zh)' },
      );
      tty.assertHealthyScreen(afterConfirmClear, 120, 36, 'Terms tab after confirmed clear zh');
      assert.ok(afterConfirmClear.includes('该课程暂无提取术语'));
      assert.ok(afterConfirmClear.includes('共 0'));
      const afterClear = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterClear.ok, true);
      assert.deepEqual(afterClear.value?.items, []);
    } finally {
      try {
        app?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

describe('Round 64 Track 3: CourseSettingsModal Tab 3 [a] course.terms.attach', () => {
  test('1) createTuiHost integration (0 model calls): mark term -> course.terms.attach -> course.terms.get returns item.card', async () => {
    const base = await temps.make('r64-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const home = join(base, 'home');
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home,
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      complete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call during 0-token course.terms.attach test');
      },
    });

    try {
      const { deckId, cards } = await seedCourseWithCards(host, 'Computer Networks');
      const targetCard = cards[0];

      const markRes = await host.call('course.terms.mark', {
        course: 'Computer Networks',
        terms: ['BCP38'],
      });
      assert.equal(markRes.ok, true, `course.terms.mark failed: ${markRes.error?.message}`);
      assert.equal(markRes.value?.added, 1);

      const attachRes = await host.call('course.terms.attach', {
        course: 'Computer Networks',
        links: [
          {
            term: 'BCP38',
            card: { deckId, cardId: targetCard.id },
          },
        ],
      });
      assert.equal(attachRes.ok, true, `course.terms.attach failed: ${attachRes.error?.message}`);
      assert.equal(attachRes.value?.attached, 1);

      const got = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(got.ok, true, `course.terms.get failed: ${got.error?.message}`);
      assert.equal(got.value?.items?.length, 1);
      assert.deepEqual(got.value.items[0].card, { deckId, cardId: targetCard.id });
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): LibraryView -> C -> Tab 3 -> [a] -> Esc cancel (0 mutations) -> [a] -> j + Enter -> linked toast & badge persists -> Esc (0 LLM calls)', async () => {
    const base = await temps.make('r64-ui-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      complete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call during CourseSettings attachCard flow');
      },
    });

    const { deckId, cards } = await seedCourseWithCards(host, 'Computer Networks');
    await host.call('course.terms.mark', {
      course: 'Computer Networks',
      terms: ['BCP38'],
    });

    const tty = createVirtualTty(120, 36);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Computer Networks'), { timeoutMs: 10_000, label: 'LibraryView loaded (zh)' });

      tty.send('C');
      await tty.waitFor((s) => s.includes('课程设置与学法') && !s.includes('正在读取课程配置'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal opened (zh)',
      });

      tty.send('3');
      const termsScreen = await tty.waitFor(
        (s) => s.includes('BCP38') && s.includes('☑') && s.includes('共 1'),
        { timeoutMs: 8_000, label: 'Tab 3 terms rendered (zh)' },
      );
      tty.assertHealthyScreen(termsScreen, 120, 36, 'Tab 3 zh');

      // Press [a] -> Esc cancels cleanly back to Tab 3 with 0 mutations
      tty.send('a');
      const cancelPickerScreen = await tty.waitFor(
        (s) => s.includes('为术语「BCP38」关联检查卡') && s.includes('Explain BCP38 primary goal'),
        { timeoutMs: 8_000, label: 'attachCard picker rendered before Esc cancel (zh)' },
      );
      tty.assertHealthyScreen(cancelPickerScreen, 120, 36, 'attachCard picker before Esc cancel zh');
      assert.ok(cancelPickerScreen.includes('为术语「BCP38」关联检查卡'));

      tty.send('\x1b');
      const cancelledScreen = await tty.waitFor(
        (s) => !s.includes('为术语「BCP38」关联检查卡') && s.includes('BCP38') && s.includes('共 1'),
        { timeoutMs: 8_000, label: 'attachCard cancelled via Esc (zh)' },
      );
      tty.assertHealthyScreen(cancelledScreen, 120, 36, 'Tab 3 after Esc cancel zh');
      assert.ok(!cancelledScreen.includes('为术语「BCP38」关联检查卡'));

      const afterCancel = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(afterCancel.ok, true);
      assert.equal(afterCancel.value?.items?.[0]?.card, undefined, 'Esc cancel must not attach any card');
      assert.equal(modelCalls, 0);

      // Re-open attachCard picker via [a], move down with 'j' to pick the second card and press Enter
      tty.send('a');
      const pickerScreen = await tty.waitFor(
        (s) => s.includes('为术语「BCP38」关联检查卡') && s.includes('Explain BCP38 primary goal'),
        { timeoutMs: 8_000, label: 'attachCard picker rendered with matching cards (zh)' },
      );
      tty.assertHealthyScreen(pickerScreen, 120, 36, 'attachCard picker zh');
      assert.ok(pickerScreen.includes('Explain BCP38 deployment caveats'));

      const seenToasts = [];
      const unsubToasts = useDistTuiStore.subscribe((st) => {
        for (const t of st.toasts) {
          if (!seenToasts.some((x) => x.id === t.id)) seenToasts.push(t);
        }
      });
      useDistTuiStore.setState({ toasts: [] });
      tty.send('j');
      await tty.flush(20);
      tty.send('\r');

      try {
        const attachedScreen = await tty.waitFor(
          (s) =>
            !s.includes('为术语「BCP38」关联检查卡') &&
            s.includes('✓已建卡') &&
            s.includes('✓已关联检查卡') &&
            seenToasts.some((toast) => toast.tone === 'success' && toast.text === '已为术语「BCP38」关联检查卡'),
          { timeoutMs: 8_000, label: 'linked toast and check-card badge visible in Tab 3 (zh)' },
        );
        tty.assertHealthyScreen(attachedScreen, 120, 36, 'Tab 3 after attach zh');
        assert.ok(attachedScreen.includes('✓已建卡'));
        assert.ok(attachedScreen.includes('✓已关联检查卡'));
        assert.ok(seenToasts.some((toast) => toast.tone === 'success' && toast.text === '已为术语「BCP38」关联检查卡'));
      } catch (err) {
        throw new Error(`${err.message}\nseenToasts=${JSON.stringify(seenToasts)}`);
      } finally {
        unsubToasts();
      }

      const persisted = await host.call('course.terms.get', { course: 'Computer Networks' });
      assert.equal(persisted.ok, true);
      assert.equal(persisted.value?.items?.length, 1);
      assert.deepEqual(persisted.value?.items?.[0]?.card, { deckId, cardId: cards[1].id });

      tty.send('\x1b');
      const modalClosedScreen = await tty.waitFor((s) => !s.includes('课程设置与学法'), {
        timeoutMs: 8_000,
        label: 'CourseSettingsModal closed via Esc (zh)',
      });
      assert.ok(!modalClosedScreen.includes('课程设置与学法'));
      assert.equal(modelCalls, 0);
    } finally {
      try {
        app?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});
